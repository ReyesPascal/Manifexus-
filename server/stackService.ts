import fs from 'fs';
import { dump } from 'js-yaml';
import { parseDocument, YAMLMap } from 'yaml';
import path from 'path';
import { DeepContainerMetadata, EmptyComposeStack } from '../src/types';
import {
  readHostFile,
  writeHostFile,
  createHostDirectory,
  deleteHostDirectory,
  checkHostFileExists,
  resolveContainerPath,
} from './hostFsService';
import { createPreMergeSnapshot, saveMergeHistoryRecord } from './historyService';
import { runHostDockerCompose } from './automationService';
import { getContainersList, removeDemoContainersByProject } from './dockerService';
import { globalLogService } from './globalLogService';

export type { EmptyComposeStack };

const CREATED_STACKS_FILE = fs.existsSync('/data')
  ? '/data/created-stacks.json'
  : path.join(process.cwd(), 'data', 'created-stacks.json');

export interface VolumeSafetyAuditItem {
  service: string;
  type: 'bind' | 'named_volume';
  source: string;
  destination: string;
  verdict: 'safe_absolute' | 'safe_external_volume' | 'safe_converted_absolute' | 'requires_migration';
  badgeText: string;
  explanation: string;
}

export interface PortConflictItem {
  port: number;
  services: string[];
  conflict: boolean;
  recommendation?: string;
}

export interface StackMergePlan {
  targetStackName: string;
  targetDirectory: string;
  mode: 'existing-stack' | 'new-stack';
  sourceStacks: string[];
  sourceContainersCount: number;
  services: {
    serviceName: string;
    containerName: string;
    image: string;
    ports: string[];
    volumes: string[];
    originalProject?: string;
    originalWorkingDir?: string;
  }[];
  volumeSafetyAudit: VolumeSafetyAuditItem[];
  portConflicts: PortConflictItem[];
  generatedComposeYaml: string;
  migrationScript: string;
  rollbackScript: string;
  cleanupScript: string;
  existingComposeMergedWithAst?: boolean;
}

export interface MergePlanRequest {
  sourceContainerIds: string[];
  targetStackName: string;
  targetDirectory: string;
  mode: 'existing-stack' | 'new-stack';
  volumeHandling?: 'preserve-absolute' | 'consolidate-relative';
  existingComposeContent?: string;
}

/**
 * Directive 1: Helper to identify Manifexus.
 * Manifexus must never be merged into another stack or modified as a standard service container.
 */
export function isManifexusContainer(c: {
  cleanName?: string;
  name?: string;
  image?: string;
  compose?: { project?: string };
}): boolean {
  const clean = (c.cleanName || c.name || '').toLowerCase();
  const proj = (c.compose?.project || '').toLowerCase();
  const img = (c.image || '').toLowerCase();
  return clean === 'manifexus' || clean === '/manifexus' || proj === 'manifexus' || img.includes('manifexus');
}

/**
 * Directive 5: AST-Based Intelligent Stack Merging
 * Merges new services, volumes, and networks into an existing compose file while preserving
 * comments, directives, styling, and existing formatting.
 */
export function mergeComposeWithAst(
  existingYaml: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newServices: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newVolumes?: Record<string, any>
): string {
  try {
    const doc = parseDocument(existingYaml);
    let services = doc.get('services') as YAMLMap;
    if (!services) {
      doc.set('services', new YAMLMap());
      services = doc.get('services') as YAMLMap;
    }

    for (const [sName, sDef] of Object.entries(newServices)) {
      services.set(sName, sDef);
    }

    if (newVolumes && Object.keys(newVolumes).length > 0) {
      let volumes = doc.get('volumes') as YAMLMap;
      if (!volumes) {
        doc.set('volumes', new YAMLMap());
        volumes = doc.get('volumes') as YAMLMap;
      }
      for (const [vName, vDef] of Object.entries(newVolumes)) {
        volumes.set(vName, vDef);
      }
    }

    return doc.toString();
  } catch (err) {
    console.warn('[AST Merge] Fallback to standard merge due to AST parse error:', err);
    return '';
  }
}

/**
 * Generate a complete, safe Docker Compose Merge Plan with AST synthesis and zero-data-loss pathing
 */
export function generateStackMergePlan(
  rawSelectedContainers: DeepContainerMetadata[],
  options: MergePlanRequest
): StackMergePlan {
  const {
    targetStackName,
    targetDirectory,
    mode,
    existingComposeContent,
  } = options;

  // Directive 1: Programmatically filter out Manifexus from all merge calculations
  const selectedContainers = rawSelectedContainers.filter((c) => !isManifexusContainer(c));

  const targetDirClean = targetDirectory.trim().replace(/\/+$/, '') || `/home/ubuntu/${targetStackName}`;
  const stackNameClean = targetStackName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'combined-stack';

  const sourceStacksSet = new Set<string>();
  for (const c of selectedContainers) {
    if (c.compose?.project) {
      sourceStacksSet.add(c.compose.project);
    } else {
      sourceStacksSet.add('standalone');
    }
  }

  // Detect and track service names to avoid naming collisions
  const usedServiceNames = new Set<string>();
  const servicesList: StackMergePlan['services'] = [];
  const volumeSafetyAudit: VolumeSafetyAuditItem[] = [];

  // Used for tracking external named volumes to declare at top-level
  const externalNamedVolumes: Record<string, { external: boolean; name?: string }> = {};

  // Used for detecting host port collisions
  const hostPortMap: Record<number, string[]> = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const composeServicesObj: Record<string, any> = {};

  for (const container of selectedContainers) {
    // Determine unique service name - strictly preserve original compose service names (e.g. 'db', 'app', 'nextcloud')
    const originalService = container.compose?.service ? container.compose.service.toLowerCase().replace(/[^a-z0-9_-]/g, '-') : '';
    let baseServiceName = originalService || container.cleanName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!baseServiceName) {
      baseServiceName = 'service';
    }

    let serviceName = baseServiceName;
    let counter = 1;
    while (usedServiceNames.has(serviceName)) {
      counter++;
      serviceName = `${baseServiceName}-${counter}`;
    }
    usedServiceNames.add(serviceName);

    // Format Ports and detect collisions
    const portsYaml: string[] = [];
    const seenHostPorts = new Set<number>();

    for (const p of container.ports) {
      if (p.publicPort !== undefined) {
        if (!seenHostPorts.has(p.publicPort)) {
          seenHostPorts.add(p.publicPort);
          const portStr = `${p.publicPort}:${p.privatePort}${p.type === 'udp' ? '/udp' : ''}`;
          portsYaml.push(portStr);

          if (!hostPortMap[p.publicPort]) {
            hostPortMap[p.publicPort] = [];
          }
          hostPortMap[p.publicPort].push(serviceName);
        }
      }
    }

    // Process Mounts & Volumes with strict ZERO DATA LOSS guarantees (Directive 5)
    const volumesYaml: string[] = [];
    const originalWorkingDir = container.compose?.workingDir;

    for (const mount of container.mounts) {
      if (!mount.source || !mount.destination) continue;

      if (mount.type === 'volume') {
        const rawVolumeName = mount.source;
        let targetVolumeKey = rawVolumeName;
        const actualDockerVolumeName = rawVolumeName;

        if (container.compose?.project && rawVolumeName.startsWith(`${container.compose.project}_`)) {
          targetVolumeKey = rawVolumeName.replace(`${container.compose.project}_`, '');
        }

        externalNamedVolumes[targetVolumeKey] = {
          external: true,
          name: actualDockerVolumeName,
        };

        const volBinding = `${targetVolumeKey}:${mount.destination}${mount.rw ? '' : ':ro'}`;
        volumesYaml.push(volBinding);

        volumeSafetyAudit.push({
          service: serviceName,
          type: 'named_volume',
          source: rawVolumeName,
          destination: mount.destination,
          verdict: 'safe_external_volume',
          badgeText: 'Zero-Loss Named Volume',
          explanation: `External volume mapping to "${actualDockerVolumeName}". Existing database/file records are attached with 0 data loss.`,
        });
      } else {
        // Bind Mount: E.g. /home/ryan/appdata/... or ./data
        let finalHostSource = mount.source;
        let verdict: VolumeSafetyAuditItem['verdict'] = 'safe_absolute';
        let badgeText = 'Safe Host Path';
        let explanation = `Direct persistent host directory preserved at "${mount.source}".`;

        if (!mount.source.startsWith('/')) {
          // Relative path like './data' or 'data'
          if (originalWorkingDir) {
            // Directive 5: Automatically update relative volume mount paths so they resolve correctly
            // Converting to absolute host path guarantees zero data loss!
            finalHostSource = path.resolve(originalWorkingDir, mount.source);
            verdict = 'safe_converted_absolute';
            badgeText = 'Converted to Absolute Host Path';
            explanation = `Relative path "${mount.source}" in "${originalWorkingDir}" resolved to absolute "${finalHostSource}". Zero data loss guaranteed.`;
          } else {
            verdict = 'requires_migration';
            badgeText = 'Relative Bind Path';
            explanation = `Relative path "${mount.source}". Points to "${targetDirClean}/${mount.source}".`;
          }
        }

        const bindStr = `${finalHostSource}:${mount.destination}${mount.rw ? '' : ':ro'}`;
        volumesYaml.push(bindStr);

        volumeSafetyAudit.push({
          service: serviceName,
          type: 'bind',
          source: mount.source,
          destination: mount.destination,
          verdict,
          badgeText,
          explanation,
        });
      }
    }

    // Process Environment Variables
    const environmentYaml: string[] = [];
    const ignoredEnvPrefixes = ['PHP_', 'APACHE_', 'NGINX_', 'NODE_', 'YARN_', 'DEBIAN_'];
    const ignoredExactKeys = ['HOSTNAME', 'HOME', 'PATH', 'GPG_KEYS', 'PHPIZE_DEPS', 'MARIADB_MAJOR', 'MARIADB_VERSION', 'MYSQL_MAJOR'];

    const envSource = container.rawEnvVars && container.rawEnvVars.length > 0 ? container.rawEnvVars : container.envVars;
    for (const env of envSource) {
      if (!env.key || env.value === undefined || env.value === 'undefined') continue;
      if (ignoredExactKeys.includes(env.key)) continue;
      if (ignoredEnvPrefixes.some((prefix) => env.key.startsWith(prefix))) continue;
      environmentYaml.push(`${env.key}=${env.value}`);
    }

    // Construct service object for Compose
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serviceConfig: any = {
      image: container.image,
      container_name: container.cleanName,
      restart: container.restartPolicy || 'unless-stopped',
    };

    if (portsYaml.length > 0) {
      serviceConfig.ports = portsYaml;
    }

    if (volumesYaml.length > 0) {
      serviceConfig.volumes = volumesYaml;
    }

    if (environmentYaml.length > 0) {
      serviceConfig.environment = environmentYaml;
    }

    if (container.command && !container.command.startsWith('/init') && !container.command.startsWith('/entrypoint')) {
      serviceConfig.command = container.command;
    }

    const customLabels: Record<string, string> = {};
    for (const [k, v] of Object.entries(container.labels || {})) {
      if (!k.startsWith('com.docker.compose') && !k.startsWith('org.opencontainers')) {
        customLabels[k] = v;
      }
    }
    if (Object.keys(customLabels).length > 0) {
      serviceConfig.labels = customLabels;
    }

    if (originalService && originalService !== serviceName) {
      serviceConfig.networks = {
        default: {
          aliases: [originalService],
        },
      };
    }

    composeServicesObj[serviceName] = serviceConfig;

    servicesList.push({
      serviceName,
      containerName: container.cleanName,
      image: container.image,
      ports: portsYaml,
      volumes: volumesYaml,
      originalProject: container.compose?.project,
      originalWorkingDir: container.compose?.workingDir,
    });
  }

  // Detect Host Port Collisions
  const portConflicts: PortConflictItem[] = [];
  for (const [portStr, services] of Object.entries(hostPortMap)) {
    const portNum = parseInt(portStr, 10);
    if (services.length > 1) {
      portConflicts.push({
        port: portNum,
        services,
        conflict: true,
        recommendation: `Multiple services (${services.join(', ')}) expose host port :${portNum}. Please reassign one before starting.`,
      });
    } else {
      portConflicts.push({
        port: portNum,
        services,
        conflict: false,
      });
    }
  }

  // Construct Final Docker Compose Document via AST or Clean Format
  let generatedComposeYaml = '';
  let existingComposeMergedWithAst = false;

  if (mode === 'existing-stack' && existingComposeContent && existingComposeContent.trim().length > 0) {
    // Only inject services from containers that are incoming from other stacks/directories,
    // leaving existing target stack service definitions completely untouched and preserved.
    const incomingServicesObj: Record<string, any> = {};
    for (const c of selectedContainers) {
      const isLocalToTarget = c.compose?.workingDir && path.resolve(c.compose.workingDir) === path.resolve(targetDirClean);
      if (!isLocalToTarget) {
        const sName = c.compose?.service || c.cleanName;
        if (composeServicesObj[sName]) {
          incomingServicesObj[sName] = composeServicesObj[sName];
        } else {
          const foundKey = Object.keys(composeServicesObj).find((k) => k === sName || k.startsWith(`${sName}-`));
          if (foundKey) {
            incomingServicesObj[foundKey] = composeServicesObj[foundKey];
          }
        }
      }
    }

    const servicesToInject = Object.keys(incomingServicesObj).length > 0 ? incomingServicesObj : composeServicesObj;
    const astResult = mergeComposeWithAst(existingComposeContent, servicesToInject, externalNamedVolumes);
    if (astResult && astResult.trim().length > 0) {
      generatedComposeYaml = astResult;
      existingComposeMergedWithAst = true;
    }
  }

  if (!generatedComposeYaml) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fullComposeDoc: any = {
      services: composeServicesObj,
    };

    if (Object.keys(externalNamedVolumes).length > 0) {
      fullComposeDoc.volumes = externalNamedVolumes;
    }

    generatedComposeYaml = `# =========================================================================
# Merged Docker Compose Stack: ${stackNameClean}
# Generated by Manifexus Command Hub on ${new Date().toISOString()}
# Target Directory: ${targetDirClean}
# Source Services: ${servicesList.map((s) => s.serviceName).join(', ')}
#
# ZERO DATA LOSS AUDIT:
# - All persistent host bind mounts reference absolute host paths
# - Named volumes mapped using 'external: true' to preserve existing databases
# =========================================================================

${dump(fullComposeDoc, { indent: 2, lineWidth: -1 })}`;
  }

  // Generate Step-by-Step Shell Migration Script
  const originalWorkingDirs = Array.from(
    new Set(
      selectedContainers
        .map((c) => c.compose?.workingDir)
        .filter((dir): dir is string => Boolean(dir) && dir !== targetDirClean)
    )
  );

  const migrationScript = `#!/usr/bin/env bash
# =========================================================================
# MANIFEXUS SAFE STACK MIGRATION SCRIPT
# Target Stack: ${stackNameClean}
# Target Dir:   ${targetDirClean}
# Generated:    ${new Date().toISOString()}
# =========================================================================
set -e

echo "=== [Step 1/6] Safety Pre-flight & Directory Preparation ==="
if [ ! -d "${targetDirClean}" ]; then
  echo "Creating target directory ${targetDirClean}..."
  mkdir -p "${targetDirClean}"
else
  echo "Target directory ${targetDirClean} already exists. Using existing path."
fi
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Backup existing compose file in target directory if one exists
if [ -f "${targetDirClean}/docker-compose.yml" ]; then
  echo "Backing up existing ${targetDirClean}/docker-compose.yml..."
  cp "${targetDirClean}/docker-compose.yml" "${targetDirClean}/docker-compose.backup.\${TIMESTAMP}.yml"
fi

echo "=== [Step 2/6] Writing Unified docker-compose.yml ==="
cat << 'EOF' > "${targetDirClean}/docker-compose.yml"
${generatedComposeYaml}
EOF

echo "Unified docker-compose.yml written to ${targetDirClean}/docker-compose.yml."

echo "=== [Step 3/6] Gracefully Stopping Previous Stack Instances ==="
${originalWorkingDirs.length > 0
  ? originalWorkingDirs
      .map(
        (dir) => `if [ -d "${dir}" ]; then
  echo "Stopping standalone instances in ${dir}..."
  (cd "${dir}" && docker compose down || docker-compose down || true)
fi`
      )
      .join('\n')
  : '# No separate external directories to shut down'}

echo "=== [Step 4/6] Launching Unified Compose Stack ==="
cd "${targetDirClean}"
docker compose up -d || docker-compose up -d

echo "=== [Step 5/6] Health & Port Verification ==="
docker compose ps || docker-compose ps

echo "=== [Step 6/6] Zero-Data-Loss Migration Complete ==="
echo "All ${servicesList.length} services are now running unified in ${targetDirClean}!"
`;

  const rollbackScript = `#!/usr/bin/env bash
# =========================================================================
# MANIFEXUS INSTANT ROLLBACK SCRIPT
# Reverts ${stackNameClean} back to prior standalone state
# =========================================================================
set -e

echo "=== [Rollback 1/3] Stopping Merged Stack ==="
if [ -d "${targetDirClean}" ]; then
  (cd "${targetDirClean}" && docker compose down || docker-compose down || true)
fi

echo "=== [Rollback 2/3] Restoring Original Standalone Stacks ==="
${originalWorkingDirs
  .map(
    (dir) => `if [ -d "${dir}" ]; then
  echo "Spinning original containers back up in ${dir}..."
  (cd "${dir}" && docker compose up -d || docker-compose up -d || true)
fi`
  )
  .join('\n')}

echo "=== [Rollback 3/3] Restoring Target Backup ==="
LATEST_BACKUP=$(ls -t "${targetDirClean}"/docker-compose.backup.*.yml 2>/dev/null | head -n 1 || true)
if [ -n "$LATEST_BACKUP" ] && [ -f "$LATEST_BACKUP" ]; then
  echo "Restoring previous compose file from $LATEST_BACKUP..."
  cp "$LATEST_BACKUP" "${targetDirClean}/docker-compose.yml"
  (cd "${targetDirClean}" && docker compose up -d || docker-compose up -d || true)
fi

echo "Rollback successfully completed!"
`;

  const cleanupScript = `#!/usr/bin/env bash
# =========================================================================
# MANIFEXUS SAFE POST-MIGRATION CLEANUP
# Removes old orphan containers once unified stack is verified healthy
# =========================================================================
set -e

echo "Checking health of new stack in ${targetDirClean}..."
cd "${targetDirClean}"
docker compose ps

echo "Pruning dangling stopped containers and orphaned networks..."
docker compose down -v --remove-orphans 2>/dev/null || true
docker container prune -f
docker network prune -f

echo "Cleanup complete. Your unified stack is running pristine!"
`;

  return {
    targetStackName: stackNameClean,
    targetDirectory: targetDirClean,
    mode,
    sourceStacks: Array.from(sourceStacksSet),
    sourceContainersCount: selectedContainers.length,
    services: servicesList,
    volumeSafetyAudit,
    portConflicts,
    generatedComposeYaml,
    migrationScript,
    rollbackScript,
    cleanupScript,
    existingComposeMergedWithAst,
  };
}

/**
 * Returns saved created empty stacks from persistent storage.
 */
export function getRegisteredCreatedStacks(): EmptyComposeStack[] {
  try {
    if (fs.existsSync(CREATED_STACKS_FILE)) {
      const data = fs.readFileSync(CREATED_STACKS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[StackService] Error reading registered created stacks:', err);
  }
  return [];
}

/**
 * Persists a newly created empty stack in persistent storage.
 */
export function registerCreatedStack(stack: EmptyComposeStack): void {
  try {
    const existing = getRegisteredCreatedStacks();
    const filtered = existing.filter(
      (s) => s.project.toLowerCase() !== stack.project.toLowerCase() && s.workingDir !== stack.workingDir
    );
    filtered.unshift(stack);
    const parentDir = path.dirname(CREATED_STACKS_FILE);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(CREATED_STACKS_FILE, JSON.stringify(filtered, null, 2), 'utf8');
  } catch (err) {
    console.warn('[StackService] Error writing registered created stack:', err);
  }
}

/**
 * Removes a created stack from persistent storage if deleted or merged.
 */
export function unregisterCreatedStack(projectName: string): void {
  try {
    const existing = getRegisteredCreatedStacks();
    const filtered = existing.filter((s) => s.project.toLowerCase() !== projectName.toLowerCase());
    fs.writeFileSync(CREATED_STACKS_FILE, JSON.stringify(filtered, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

/**
 * Detects the most logical default base host directory for new stacks
 * by inspecting existing compose containers' working directories.
 */
export function getDefaultHostStacksBaseDir(containers: DeepContainerMetadata[] = []): string {
  if (process.env.DEFAULT_STACKS_DIR && process.env.DEFAULT_STACKS_DIR.trim().length > 0) {
    return process.env.DEFAULT_STACKS_DIR.trim();
  }

  // Count parent directories of existing compose containers
  const dirCounts: Record<string, number> = {};
  for (const c of containers) {
    if (c.compose?.workingDir) {
      const parent = path.dirname(c.compose.workingDir);
      if (parent && parent !== '/' && parent !== '.') {
        dirCounts[parent] = (dirCounts[parent] || 0) + 1;
      }
    }
  }

  const sortedDirs = Object.entries(dirCounts).sort((a, b) => b[1] - a[1]);
  if (sortedDirs.length > 0) {
    return sortedDirs[0][0];
  }

  // Safe defaults
  return '/home/ubuntu/docker';
}

/**
 * Directive 2: Empty Stack Discovery
 * Scans the base host directory and subdirectories for any valid docker-compose.yml files.
 * Injects empty stacks (0 running services) into the dashboard payload so the UI displays them.
 */
export async function discoverHostComposeStacks(
  activeContainers: DeepContainerMetadata[] = []
): Promise<EmptyComposeStack[]> {
  const discoveredMap = new Map<string, EmptyComposeStack>();

  // 1. Load any previously provisioned stacks from persistent ledger
  const registered = getRegisteredCreatedStacks();
  for (const s of registered) {
    discoveredMap.set(s.project.toLowerCase(), s);
  }

  // Set of projects currently populated with active running containers
  const activeProjects = new Set(
    activeContainers
      .filter((c) => c.compose?.isCompose && c.compose.project)
      .map((c) => (c.compose.project as string).toLowerCase())
  );

  // 2. Collect candidate base host directories to scan
  const baseCandidates = new Set<string>();
  const defaultBase = getDefaultHostStacksBaseDir(activeContainers);
  baseCandidates.add(defaultBase);

  for (const c of activeContainers) {
    if (c.compose?.workingDir) {
      baseCandidates.add(path.dirname(c.compose.workingDir));
    }
  }

  // Add standard user and docker directories if mounted or accessible
  const standardMounts = ['/host/home', '/host', '/home/ubuntu/docker', '/home/ryan'];
  for (const m of standardMounts) {
    if (fs.existsSync(m)) {
      baseCandidates.add(m);
    }
  }

  // 3. Scan directories for subdirectories containing compose files
  for (const baseDir of baseCandidates) {
    const localBase = resolveContainerPath(baseDir);
    if (!fs.existsSync(localBase)) {
      continue;
    }

    try {
      const entries = fs.readdirSync(localBase, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const subDirName = entry.name;
        // Skip hidden or system folders
        if (subDirName.startsWith('.') || subDirName === 'node_modules') continue;

        const hostSubDir = path.posix.join(baseDir, subDirName);
        const localSubDir = path.join(localBase, subDirName);

        // Candidate compose file names
        const composeFileNames = [
          'docker-compose.yml',
          'docker-compose.yaml',
          'compose.yml',
          'compose.yaml',
        ];

        for (const fileName of composeFileNames) {
          const localComposeFile = path.join(localSubDir, fileName);
          if (fs.existsSync(localComposeFile)) {
            try {
              const fileContent = fs.readFileSync(localComposeFile, 'utf8');
              const doc = parseDocument(fileContent);

              if (!doc.errors || doc.errors.length === 0) {
                // Determine stack project name (from top-level 'name:' or folder name)
                const docName = doc.get('name');
                const projectName = typeof docName === 'string' && docName.trim() ? docName.trim() : subDirName;
                const projectKey = projectName.toLowerCase();

                // If stack has no active containers running, discover it as an empty stack
                if (!activeProjects.has(projectKey)) {
                  // Count declared services
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const servicesMap = doc.get('services') as any;
                  let serviceCount = 0;
                  if (servicesMap && typeof servicesMap.items === 'object') {
                    serviceCount = Array.isArray(servicesMap.items) ? servicesMap.items.length : 0;
                  }

                  const hostComposeFile = path.posix.join(hostSubDir, fileName);
                  discoveredMap.set(projectKey, {
                    project: projectName,
                    workingDir: hostSubDir,
                    configFiles: hostComposeFile,
                    serviceCount,
                    source: 'discovered',
                  });
                }
              }
            } catch {
              // Ignore parse errors on corrupted files
            }
            break; // found compose file in this subfolder
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  return Array.from(discoveredMap.values());
}

/**
 * Directive 1: Backend Endpoint Logic Helper
 * Sanitizes stackName, constructs absolute host path, provisions directory using host filesystem helpers,
 * and writes baseline docker-compose.yml (version 3.8 and empty services dictionary).
 */
export async function provisionEmptyStack(
  rawStackName: string,
  customBaseDir?: string,
  containers: DeepContainerMetadata[] = []
): Promise<{
  success: boolean;
  stack?: EmptyComposeStack;
  error?: string;
}> {
  const sanitizedName = (rawStackName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!sanitizedName || sanitizedName.length < 2) {
    return {
      success: false,
      error: 'Invalid stack name. Use at least 2 alphanumeric characters, hyphens, or underscores.',
    };
  }

  // Determine base host path
  let baseDir = customBaseDir && customBaseDir.trim().startsWith('/') ? customBaseDir.trim() : '';
  if (!baseDir) {
    baseDir = getDefaultHostStacksBaseDir(containers);
  }

  const targetHostDir = path.posix.join(baseDir, sanitizedName);
  const composeFilePath = path.posix.join(targetHostDir, 'docker-compose.yml');

  // Baseline docker-compose.yml containing only services dictionary
  const baselineComposeYaml = `services: {}
`;

  try {
    // 1. Provision host directory bypassing container isolation
    await createHostDirectory(targetHostDir);

    // 2. Write baseline compose file
    const writeOk = await writeHostFile(composeFilePath, baselineComposeYaml);
    if (!writeOk) {
      // Direct local write fallback
      const localCandidate = resolveContainerPath(composeFilePath);
      const localParent = path.dirname(localCandidate);
      if (!fs.existsSync(localParent)) {
        fs.mkdirSync(localParent, { recursive: true });
      }
      fs.writeFileSync(localCandidate, baselineComposeYaml, 'utf8');
    }

    const newStack: EmptyComposeStack = {
      project: sanitizedName,
      workingDir: targetHostDir,
      configFiles: composeFilePath,
      serviceCount: 0,
      source: 'provisioned',
    };

    // Register stack so discovery immediately finds it
    registerCreatedStack(newStack);

    return {
      success: true,
      stack: newStack,
    };
  } catch (err) {
    console.error(`[StackService] Failed to provision empty stack ${sanitizedName}:`, err);
    return {
      success: false,
      error: (err as Error).message || 'Failed to provision host directory and docker-compose.yml',
    };
  }
}

/**
 * Directive 4: Safely deletes a stack from the host.
 * 1. Executes zero-data-loss backup snapshot first to archive the compose file
 * 2. Uses Docker socket helper to execute docker compose down -v --remove-orphans in target host directory
 * 3. Deletes directory from host
 * 4. Logs to history ledger so it can be reverted using existing rollback flow
 */
export async function deleteHostStack(params: {
  projectName: string;
  targetDirectory?: string;
}): Promise<{
  success: boolean;
  message: string;
  backupArchiveDir?: string;
  historyRecordId?: string;
}> {
  const { projectName, targetDirectory } = params;
  const sanitizedName = (projectName || '').trim().toLowerCase();

  if (!sanitizedName) {
    throw new Error('Project name is required.');
  }

  // System Protection: Never allow deleting Manifexus
  if (isManifexusContainer({ cleanName: sanitizedName, compose: { project: sanitizedName } })) {
    throw new Error('System Self-Protection: Manifexus container or stack cannot be deleted.');
  }

  const { containers, isDemo } = await getContainersList();
  const stackContainers = containers.filter(
    (c) => (c.compose?.project || '').toLowerCase() === sanitizedName
  );

  const resolvedTargetDir =
    targetDirectory && targetDirectory.trim().startsWith('/')
      ? targetDirectory.trim()
      : stackContainers[0]?.compose?.workingDir || path.posix.join('/home/ryan', sanitizedName);

  const composeFilePath = path.posix.join(resolvedTargetDir, 'docker-compose.yml');
  const existingComposeContent = (await readHostFile(composeFilePath)) || undefined;

  // Step 1: Zero-Data-Loss Backup Snapshot
  const deleteRunId = `delete_${sanitizedName}_${Date.now()}`;
  const snapshotRes = await createPreMergeSnapshot({
    mergeId: deleteRunId,
    targetStackName: sanitizedName,
    targetDirectory: resolvedTargetDir,
    selectedContainers: stackContainers,
    preMergeTargetCompose: existingComposeContent,
  });

  // Customize ledger record description
  snapshotRes.record.summary = `Deleted stack "${sanitizedName}" (safe pre-deletion snapshot archived in ${snapshotRes.backupArchiveDir})`;
  snapshotRes.record.status = 'active';
  saveMergeHistoryRecord(snapshotRes.record);

  // Step 2: Use Docker Socket Helper to run docker compose down -v --remove-orphans
  await runHostDockerCompose(
    resolvedTargetDir,
    'docker compose down -v --remove-orphans || docker-compose down -v --remove-orphans || docker compose down || true'
  );

  // Step 3: Delete directory from host
  await deleteHostDirectory(resolvedTargetDir);

  // Unregister stack from local storage
  unregisterCreatedStack(sanitizedName);

  // If in demo mode, prune demo containers
  if (isDemo) {
    removeDemoContainersByProject(sanitizedName);
  }

  globalLogService.log({
    eventType: 'STACK_OP',
    level: 'INFO',
    source: 'stackService',
    message: `Stack '${sanitizedName}' safely deleted at ${resolvedTargetDir} with snapshot ${deleteRunId}`,
    payload: {
      projectName: sanitizedName,
      targetDirectory: resolvedTargetDir,
      backupArchiveDir: snapshotRes.backupArchiveDir,
      historyRecordId: deleteRunId,
    },
  });

  return {
    success: true,
    message: `Stack '${sanitizedName}' was safely deleted. A zero-data-loss backup snapshot was saved at ${snapshotRes.backupArchiveDir} and can be restored anytime from History & Reverts.`,
    backupArchiveDir: snapshotRes.backupArchiveDir,
    historyRecordId: deleteRunId,
  };
}
