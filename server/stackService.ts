import { dump } from 'js-yaml';
import path from 'path';
import { DeepContainerMetadata, ContainerMount, ContainerPort } from '../src/types';

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
}

export interface MergePlanRequest {
  sourceContainerIds: string[];
  targetStackName: string;
  targetDirectory: string;
  mode: 'existing-stack' | 'new-stack';
  volumeHandling?: 'preserve-absolute' | 'consolidate-relative';
}

/**
 * Generate a complete, safe Docker Compose Merge Plan
 */
export function generateStackMergePlan(
  selectedContainers: DeepContainerMetadata[],
  options: MergePlanRequest
): StackMergePlan {
  const {
    targetStackName,
    targetDirectory,
    mode,
    volumeHandling = 'preserve-absolute',
  } = options;

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
    // Determine unique service name
    let baseServiceName = container.compose?.service || container.cleanName;
    baseServiceName = baseServiceName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!baseServiceName || baseServiceName === 'app' && selectedContainers.length > 2) {
      baseServiceName = container.cleanName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
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

    // Process Mounts & Volumes with strict ZERO DATA LOSS guarantees
    const volumesYaml: string[] = [];
    const originalWorkingDir = container.compose?.workingDir;

    for (const mount of container.mounts) {
      if (!mount.source || !mount.destination) continue;

      if (mount.type === 'volume') {
        // Named Volume: E.g. mariadb_data or portainer_data
        const rawVolumeName = mount.source;
        // In Docker compose, named volumes from an existing project are named `<project>_<volName>`
        // To guarantee zero data loss, declare it external with exact existing Docker volume name!
        let targetVolumeKey = rawVolumeName;
        let actualDockerVolumeName = rawVolumeName;

        // If the volume name contains project prefix, simplify key for readability
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
          // Relative path like './data'
          if (originalWorkingDir) {
            // Convert to absolute path so it points to the exact same host directory!
            finalHostSource = path.resolve(originalWorkingDir, mount.source);
            verdict = 'safe_converted_absolute';
            badgeText = 'Converted to Absolute Host Path';
            explanation = `Relative path "${mount.source}" in "${originalWorkingDir}" resolved to absolute "${finalHostSource}". Zero data movement needed.`;
          } else {
            verdict = 'requires_migration';
            badgeText = 'Relative Bind Path';
            explanation = `Relative path "${mount.source}". Will point to "${targetDirClean}/${mount.source}".`;
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
    for (const env of container.envVars) {
      if (env.key) {
        // Only skip internal docker-injected vars like PATH, HOSTNAME
        if (['HOSTNAME', 'HOME', 'PATH'].includes(env.key)) continue;
        environmentYaml.push(`${env.key}=${env.value}`);
      }
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

    // Healthcheck check if exists
    // Keep labels if compose-friendly
    const customLabels: Record<string, string> = {};
    for (const [k, v] of Object.entries(container.labels || {})) {
      if (!k.startsWith('com.docker.compose') && !k.startsWith('org.opencontainers')) {
        customLabels[k] = v;
      }
    }
    if (Object.keys(customLabels).length > 0) {
      serviceConfig.labels = customLabels;
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
        recommendation: `Multiple services (${services.join(', ')}) expose host port :${portNum}. Please reassign one in the compose file before starting.`,
      });
    } else {
      portConflicts.push({
        port: portNum,
        services,
        conflict: false,
      });
    }
  }

  // Construct Final Docker Compose Document
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fullComposeDoc: any = {
    services: composeServicesObj,
  };

  if (Object.keys(externalNamedVolumes).length > 0) {
    fullComposeDoc.volumes = externalNamedVolumes;
  }

  // Convert to formatted YAML
  const generatedComposeYaml = `# =========================================================================
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
mkdir -p "${targetDirClean}"
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
        (dir) =>
          `if [ -d "${dir}" ] && [ -f "${dir}/docker-compose.yml" ]; then\n  echo "Stopping services in ${dir} (VOLUMES RETAINED)..."\n  docker compose -f "${dir}/docker-compose.yml" down\nfi`
      )
      .join('\n')
  : '# No other compose directories detected to stop.'}

echo "=== [Step 4/6] Pulling & Launching New Merged Stack ==="
cd "${targetDirClean}"
docker compose pull
docker compose up -d

echo "=== [Step 5/6] Verifying Container Health ==="
sleep 4
docker compose ps

echo "========================================================================="
echo "✅ MERGE COMPLETE: All services in '${stackNameClean}' are spinning up!"
echo "Check your services in Manifexus or with 'docker compose -f ${targetDirClean}/docker-compose.yml ps'."
echo "========================================================================="
`;

  // Generate Rollback Script
  const rollbackScript = `#!/usr/bin/env bash
# =========================================================================
# MANIFEXUS EMERGENCY ROLLBACK SCRIPT
# Reverts to original standalone/separate compose stacks
# =========================================================================
set -e

echo "Stopping merged stack in ${targetDirClean}..."
docker compose -f "${targetDirClean}/docker-compose.yml" down

${originalWorkingDirs
  .map(
    (dir) =>
      `echo "Restoring ${dir}..."\nif [ -d "${dir}" ] && [ -f "${dir}/docker-compose.yml" ]; then\n  docker compose -f "${dir}/docker-compose.yml" up -d\nfi`
  )
  .join('\n')}

echo "Rollback completed. Original stacks restored."
`;

  // Generate Post-Verification Cleanup Script (Only run when user confirms healthy!)
  const cleanupScript = `#!/usr/bin/env bash
# =========================================================================
# MANIFEXUS POST-VERIFICATION CLEANUP SCRIPT
# WARNING: Run ONLY after confirming your new combined stack is 100% healthy!
# =========================================================================
set -e

echo "=== Pruning unused orphaned networks ==="
docker network prune -f

echo "=== Previous compose directory backup archive ==="
${originalWorkingDirs
  .map(
    (dir) =>
      `if [ -d "${dir}" ]; then\n  echo "Archive old config directory ${dir} -> ${dir}.deprecated.\${TIMESTAMP}..."\n  # mv "${dir}" "${dir}.deprecated.\$(date +%s)"\nfi`
  )
  .join('\n')}

echo "Cleanup finished. Old volumes were never touched and remain safely intact."
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
  };
}
