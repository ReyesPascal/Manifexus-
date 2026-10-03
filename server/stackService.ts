import { currentActivityId, record } from './activityLog';
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
  hostComposeFolders,
  scanHostComposeFolders,
  findComposeFile,
  hostWriteCount,
} from './hostFsService';
import { createPreMergeSnapshot, saveMergeHistoryRecord } from './historyService';
import { getContainersList, removeDemoContainersByProject } from './dockerService';
import { globalLogService } from './globalLogService';
import { getConfig } from './storageService';
import { writeJsonAtomic } from './safeJson';
import {
  archiveStackData,
  runComposeInDir,
  getProjectVolumes,
  removeVolume,
  removeHostDirectory,
  runComposeCapture,
  formatBytes,
} from './dataBackupService';

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
  blockers?: string[];
  warnings?: string[];
}

export interface MergePlanRequest {
  sourceContainerIds: string[];
  targetStackName: string;
  targetDirectory: string;
  mode: 'existing-stack' | 'new-stack';
  volumeHandling?: 'preserve-absolute' | 'consolidate-relative';
  existingComposeContent?: string;
  /** Original compose text of each source stack, keyed by working directory */
  sourceComposes?: Record<string, string>;
  /** Every container on the host, to catch ports already taken by apps that aren't moving */
  allContainers?: DeepContainerMetadata[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

/**
 * Copies a service's definition from its original compose file so nothing is lost (network_mode,
 * depends_on, env_file, cap_add, devices, healthcheck…), rewriting only what changes when the
 * service lives in another folder / project:
 *   - relative bind paths, env_file and build context become absolute (relative to the old folder)
 *   - named volumes and networks of the old project become `external` references to the exact
 *     same Docker objects, so data and connectivity are kept
 * Returns blockers (moves that can't work) and warnings (things that change).
 */
export function adoptServiceDefinition(params: {
  composeText: string;
  service: string;
  project: string;
  workingDir: string;
  movingServices: Set<string>;
}): {
  def?: AnyObj;
  volumes: Record<string, AnyObj>;
  networks: Record<string, AnyObj>;
  blockers: string[];
  warnings: string[];
} {
  const { composeText, service, project, workingDir, movingServices } = params;
  const out = { volumes: {} as Record<string, AnyObj>, networks: {} as Record<string, AnyObj>, blockers: [] as string[], warnings: [] as string[] };
  let doc: AnyObj;
  try {
    doc = parseDocument(composeText).toJSON() || {};
  } catch {
    return out;
  }
  const original = doc.services?.[service];
  if (!original) return out;
  const def: AnyObj = JSON.parse(JSON.stringify(original));
  // compose's resolved view spells out unset fields as null
  for (const k of Object.keys(def)) if (def[k] === null) delete def[k];
  const abs = (p: string) => (p.startsWith('~') || p.startsWith('/') ? p : path.posix.normalize(path.posix.join(workingDir, p)));
  const isPath = (p: string) => p.startsWith('.') || p.startsWith('/') || p.startsWith('~');
  const topVolumes: AnyObj = doc.volumes || {};
  const topNetworks: AnyObj = doc.networks || {};

  const externalVolume = (name: string) => {
    const decl = topVolumes[name] || {};
    const real = decl?.external ? decl.name || name : decl?.name || `${project}_${name}`;
    out.volumes[name] = { external: true, name: real };
  };

  // volumes (short "src:dst[:mode]" and long syntax)
  if (Array.isArray(def.volumes)) {
    def.volumes = def.volumes.map((v: string | AnyObj) => {
      if (typeof v === 'string') {
        const parts = v.split(':');
        if (parts.length >= 2) {
          if (isPath(parts[0])) parts[0] = abs(parts[0]);
          else externalVolume(parts[0]);
        }
        return parts.join(':');
      }
      if (v && typeof v === 'object' && typeof v.source === 'string') {
        if (v.type === 'bind' || isPath(v.source)) return { ...v, source: abs(v.source) };
        if (v.type === 'volume' || !v.type) externalVolume(v.source);
      }
      return v;
    });
  }

  if (typeof def.env_file === 'string') def.env_file = abs(def.env_file);
  else if (Array.isArray(def.env_file))
    def.env_file = def.env_file.map((e: string | AnyObj) => (typeof e === 'string' ? abs(e) : { ...e, path: abs(e.path) }));

  if (typeof def.build === 'string') def.build = abs(def.build);
  else if (def.build?.context) def.build = { ...def.build, context: abs(def.build.context) };

  // Keep the service on the networks it used, as the same Docker networks
  const netNames: string[] = Array.isArray(def.networks) ? def.networks : def.networks ? Object.keys(def.networks) : [];
  for (const n of netNames) {
    if (n === 'default') continue;
    const decl = topNetworks[n] || {};
    out.networks[n] = { external: true, name: decl?.external ? decl.name || n : decl?.name || `${project}_${n}` };
  }

  // Sharing another container's network only works if that one moves too
  const nm: string | undefined = def.network_mode;
  if (nm?.startsWith('service:')) {
    const dep = nm.slice('service:'.length);
    if (!movingServices.has(dep)) {
      out.blockers.push(`${service} uses ${dep}’s network (network_mode: service:${dep}). Move ${dep} along with it.`);
    }
  }

  // …and the reverse: an app staying behind that routes through this one (e.g. through a VPN container)
  for (const [other, odef] of Object.entries(doc.services || {})) {
    if (other === service || movingServices.has(other)) continue;
    if ((odef as AnyObj)?.network_mode === `service:${service}`) {
      out.blockers.push(`${other} uses ${service}’s network (network_mode: service:${service}). Move ${other} along with it.`);
    }
  }

  // depends_on on services that stay behind can't be satisfied from another project
  if (def.depends_on) {
    const deps: string[] = Array.isArray(def.depends_on) ? def.depends_on : Object.keys(def.depends_on);
    const staying = deps.filter((d) => !movingServices.has(d));
    if (staying.length) {
      if (Array.isArray(def.depends_on)) def.depends_on = def.depends_on.filter((d: string) => movingServices.has(d));
      else for (const d of staying) delete def.depends_on[d];
      if (!Object.keys(def.depends_on).length) delete def.depends_on;
      out.warnings.push(`${service} depended on ${staying.join(', ')}, which stay${staying.length === 1 ? 's' : ''} in ${project}. It will start without waiting for ${staying.length === 1 ? 'it' : 'them'}.`);
    }
  }
  if (def.links) {
    out.warnings.push(`${service} used links, which were removed. Apps reach each other by name on shared networks.`);
    delete def.links;
  }
  // Apps that stay in the old stack reach this one by its service name on the old project's
  // default network; keep it attached there (with that name) so they don't lose it. Only when
  // something actually stays behind, otherwise the old network may be removed with the old stack.
  const staying = Object.keys(doc.services || {}).filter((n) => !movingServices.has(n));
  const usesDefault = !netNames.length || netNames.includes('default');
  if (!nm && usesDefault && staying.length > 0) {
    const key = `${project}_default`;
    const nets: AnyObj = Array.isArray(def.networks)
      ? Object.fromEntries(def.networks.map((n: string) => [n, null]))
      : { ...(def.networks || {}) };
    if (!('default' in nets)) nets.default = null;
    nets[key] = { aliases: [service] };
    def.networks = nets;
    out.networks[key] = { external: true, name: key };
  }

  return { def, ...out };
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
  newVolumes?: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newNetworks?: Record<string, any>
): string {
  try {
    const doc = parseDocument(existingYaml);
    let services = doc.get('services') as YAMLMap;
    if (!services) {
      doc.set('services', new YAMLMap());
      services = doc.get('services') as YAMLMap;
    }
    // A freshly provisioned stack has `services: {}` (flow style); switch to block style so
    // merged services are written as normal multi-line YAML instead of one inline `{...}` blob.
    if (services && (services as YAMLMap).flow) {
      (services as YAMLMap).flow = false;
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
      if (volumes && (volumes as YAMLMap).flow) {
        (volumes as YAMLMap).flow = false;
      }
      for (const [vName, vDef] of Object.entries(newVolumes)) {
        volumes.set(vName, vDef);
      }
    }

    if (newNetworks && Object.keys(newNetworks).length > 0) {
      let networks = doc.get('networks') as YAMLMap;
      if (!networks) {
        doc.set('networks', new YAMLMap());
        networks = doc.get('networks') as YAMLMap;
      }
      if (networks && (networks as YAMLMap).flow) (networks as YAMLMap).flow = false;
      for (const [nName, nDef] of Object.entries(newNetworks)) {
        if (!networks.has(nName)) networks.set(nName, nDef);
      }
    }

    return doc.toString();
  } catch (err) {
    console.warn('[AST Merge] Fallback to standard merge due to AST parse error:', err);
    return '';
  }
}

/**
 * The compose definition of each stack that apps are leaving, keyed by working directory.
 * Prefers compose's own resolved view (`docker compose config`: variables from .env filled in,
 * paths absolute, real volume/network names); falls back to the raw file.
 */
export async function collectSourceComposes(selectedContainers: DeepContainerMetadata[]): Promise<Record<string, string>> {
  const sourceComposes: Record<string, string> = {};
  for (const c of selectedContainers) {
    const dir = c.compose?.workingDir;
    if (!dir || sourceComposes[dir] !== undefined) continue;
    const files = (c.compose?.configFiles || '').split(',').map((f) => f.trim()).filter((f) => f.startsWith('/'));
    // Best: compose's own resolved view (variables from .env filled in, paths absolute, real
    // volume/network names). Falls back to the raw file if that fails.
    const fileArgs = files.map((f) => `-f '${f.replace(/'/g, `'\\''`)}'`).join(' ');
    const resolved = await runComposeCapture(dir, `${fileArgs} config --format json`, {
      extraDirs: files.map((f) => path.posix.dirname(f)),
      timeoutMs: 60 * 1000,
    });
    if (resolved.ok && resolved.output.trim().startsWith('{')) {
      sourceComposes[dir] = resolved.output;
      continue;
    }
    const candidates = files.length ? [files[0]] : ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'].map((f) => path.posix.join(dir, f));
    for (const cand of candidates) {
      const text = await readHostFile(cand).catch(() => null);
      if (text && text.trim()) {
        sourceComposes[dir] = text;
        break;
      }
    }
  }
  return sourceComposes;
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

  const targetDirClean =
    targetDirectory.trim().replace(/\/+$/, '') ||
    path.posix.join(getDefaultHostStacksBaseDir(rawSelectedContainers), targetStackName);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const externalNetworks: Record<string, any> = {};
  const blockers: string[] = [];
  const warnings: string[] = [];
  const movingByDir = new Map<string, Set<string>>();
  for (const c of selectedContainers) {
    if (c.compose?.workingDir && c.compose.service) {
      if (!movingByDir.has(c.compose.workingDir)) movingByDir.set(c.compose.workingDir, new Set());
      movingByDir.get(c.compose.workingDir)!.add(c.compose.service);
    }
  }

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
        // Docker reports the volume's disk path as `source`; the name is what compose needs
        const rawVolumeName = mount.name || mount.source;
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

    // Prefer the service's real definition from its compose file over the reconstruction above
    const srcText = container.compose?.workingDir ? options.sourceComposes?.[container.compose.workingDir] : undefined;
    let finalConfig = serviceConfig;
    if (srcText && container.compose?.service && container.compose.project && container.compose.workingDir) {
      const adopted = adoptServiceDefinition({
        composeText: srcText,
        service: container.compose.service,
        project: container.compose.project,
        workingDir: container.compose.workingDir,
        movingServices: movingByDir.get(container.compose.workingDir) || new Set(),
      });
      if (adopted.def) {
        finalConfig = adopted.def;
        Object.assign(externalNamedVolumes, adopted.volumes);
        Object.assign(externalNetworks, adopted.networks);
        blockers.push(...adopted.blockers);
        warnings.push(...adopted.warnings);
      }
    }

    composeServicesObj[serviceName] = finalConfig;

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

  // Ports the moved apps publish that a different, running app already holds: compose would fail
  const selectedIds = new Set(selectedContainers.map((c) => c.id));
  for (const c of selectedContainers) {
    for (const p of c.ports) {
      if (!p.publicPort) continue;
      const holder = (options.allContainers || []).find(
        (o) =>
          !selectedIds.has(o.id) &&
          o.state === 'running' &&
          o.ports.some((op) => op.publicPort === p.publicPort && op.type === p.type)
      );
      if (holder) {
        const nameOf = (x: DeepContainerMetadata) => x.customName || x.compose?.service || x.cleanName;
        const msg = `Port ${p.publicPort} is already used by ${nameOf(holder)}, so ${nameOf(c)} couldn’t start. Change one of their ports first.`;
        if (!blockers.includes(msg)) blockers.push(msg);
      }
    }
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
    const astResult = mergeComposeWithAst(existingComposeContent, servicesToInject, externalNamedVolumes, externalNetworks);
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
    if (Object.keys(externalNetworks).length > 0) {
      fullComposeDoc.networks = externalNetworks;
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
    blockers,
    warnings,
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
  forgetDiscoveredStacks();
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
    writeJsonAtomic(CREATED_STACKS_FILE, filtered);
  } catch (err) {
    console.warn('[StackService] Error writing registered created stack:', err);
  }
}

/**
 * Removes a created stack from persistent storage if deleted or merged.
 */
export function unregisterCreatedStack(projectName: string): void {
  forgetDiscoveredStacks();
  try {
    const existing = getRegisteredCreatedStacks();
    const filtered = existing.filter((s) => s.project.toLowerCase() !== projectName.toLowerCase());
    writeJsonAtomic(CREATED_STACKS_FILE, filtered);
  } catch {
    // ignore
  }
}

/**
 * Forgets created stacks whose folder was deleted (outside Manifexus, or by hand), so they stop showing up as
 * empty stacks. A folder only counts as gone when Manifexus could really look: folders mounted into Manifexus are
 * checked directly, the rest with a read-only look at the folder above; when that look fails, nothing is
 * forgotten. Returns the stacks that were forgotten.
 */
export async function pruneCreatedStacks(
  scan: (base: string) => Promise<{ dir: string }[] | null> = scanHostComposeFolders
): Promise<string[]> {
  const all = getRegisteredCreatedStacks();
  if (!all.length) return [];
  const norm = (p: string) => path.posix.normalize(p).replace(/\/+$/, '');
  const byParent = new Map<string, EmptyComposeStack[]>();
  for (const s of all) {
    if (!s.workingDir || !s.workingDir.startsWith('/')) continue;
    const parent = path.posix.dirname(norm(s.workingDir));
    byParent.set(parent, [...(byParent.get(parent) || []), s]);
  }
  const gone = new Set<EmptyComposeStack>();
  for (const [parent, stacks] of byParent) {
    const local = resolveContainerPath(parent);
    if (local && fs.existsSync(local)) {
      for (const s of stacks) if (!fs.existsSync(path.join(local, path.posix.basename(norm(s.workingDir))))) gone.add(s);
      continue;
    }
    const found = await scan(parent).catch(() => null);
    if (!found) continue; // couldn't look: keep them
    const there = new Set(found.map((f) => f.dir));
    for (const s of stacks) if (!there.has(path.posix.basename(norm(s.workingDir)))) gone.add(s);
  }
  if (!gone.size) return [];
  // Read again just before saving, so a stack created meanwhile isn't lost
  const keep = getRegisteredCreatedStacks().filter((s) => ![...gone].some((g) => g.project.toLowerCase() === s.project.toLowerCase() && g.workingDir === s.workingDir));
  try {
    writeJsonAtomic(CREATED_STACKS_FILE, keep);
  } catch (err) {
    console.warn('[StackService] Couldn’t update the created stacks list:', err);
    return [];
  }
  forgetDiscoveredStacks();
  const names = [...gone].map((s) => s.project);
  record('info', 'stack', `Forgot ${names.length === 1 ? 'a stack' : `${names.length} stacks`} whose folder was deleted: ${names.join(', ')}`, {
    stacks: [...gone].map((s) => ({ project: s.project, folder: s.workingDir })),
  });
  return names;
}

/**
 * Detects the most logical default base host directory for new stacks
 * by inspecting existing compose containers' working directories.
 */
export function getDefaultHostStacksBaseDir(containers: DeepContainerMetadata[] = []): string {
  // 1. The location saved in Settings
  const saved = (getConfig().stacksDir || '').trim();
  if (saved.startsWith('/')) {
    return saved.replace(/\/+$/, '') || '/';
  }

  // 2. Environment override for deployments
  if (process.env.DEFAULT_STACKS_DIR && process.env.DEFAULT_STACKS_DIR.trim().startsWith('/')) {
    return process.env.DEFAULT_STACKS_DIR.trim().replace(/\/+$/, '');
  }

  // 3. The folder most existing stacks live in (Manifexus's own folder doesn't count)
  const dirCounts: Record<string, number> = {};
  for (const c of containers) {
    if (isManifexusContainer(c)) continue;
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

  // 4. Previously created stacks remembered by Manifexus
  const registeredParents = getRegisteredCreatedStacks()
    .map((s) => path.posix.dirname(s.workingDir || ''))
    .filter((d) => d && d !== '/' && d !== '.');
  if (registeredParents.length > 0) {
    return registeredParents[0];
  }

  // 5. Nothing to learn from yet: a neutral location (set your own in Settings)
  return '/opt/stacks';
}

/**
 * Directive 2: Empty Stack Discovery
 * Scans the base host directory and subdirectories for any valid docker-compose.yml files.
 * Injects empty stacks (0 running services) into the dashboard payload so the UI displays them.
 */
// The dashboard's refresh asks twice in a row (stack counts, then the stacks themselves): the same
// containers within a couple of seconds give the same answer, without reading and parsing every file again
let discoverMemo: { key: string; at: number; value: Promise<EmptyComposeStack[]> } | null = null;
export async function discoverHostComposeStacks(activeContainers: DeepContainerMetadata[] = []): Promise<EmptyComposeStack[]> {
  const key = activeContainers.map((c) => `${c.id}:${c.state}:${c.compose?.workingDir || ''}`).join('|') + '#' + (getConfig().stacksDir || '') + '#' + hostWriteCount();
  if (discoverMemo && discoverMemo.key === key && Date.now() - discoverMemo.at < 2500) return structuredClone(await discoverMemo.value);
  const value = discoverHostComposeStacksNow(activeContainers);
  const memo = { key, at: Date.now(), value };
  discoverMemo = memo;
  value.catch(() => {
    if (discoverMemo === memo) discoverMemo = null;
  });
  return structuredClone(await value);
}

/** Forget the answer above (after creating, deleting or moving a stack) */
export function forgetDiscoveredStacks(): void {
  discoverMemo = null;
}

async function discoverHostComposeStacksNow(
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

  // What one stack folder's compose file says: its name (top-level `name:` or the folder's) and how many apps
  const consider = (hostSubDir: string, subDirName: string, fileName: string, fileContent: string) => {
    try {
      const doc = parseDocument(fileContent);
      if (doc.errors && doc.errors.length > 0) return;
      const docName = doc.get('name');
      const projectName = typeof docName === 'string' && docName.trim() ? docName.trim() : subDirName;
      const projectKey = projectName.toLowerCase();
      // Stacks with apps show up through their apps; this is for the ones with none right now
      if (activeProjects.has(projectKey)) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const servicesMap = doc.get('services') as any;
      const serviceCount = servicesMap && Array.isArray(servicesMap.items) ? servicesMap.items.length : 0;
      discoveredMap.set(projectKey, {
        project: projectName,
        workingDir: hostSubDir,
        configFiles: path.posix.join(hostSubDir, fileName),
        serviceCount,
        source: 'discovered',
      });
    } catch {
      // Ignore a compose file that can't be read
    }
  };

  // 3. Look in each folder for stack folders with a compose file. Folders mounted into Manifexus are read
  // directly; the rest (the usual install) through a small read-only helper, remembered for a short while
  // so the dashboard stays quick.
  for (const baseDir of baseCandidates) {
    const localBase = resolveContainerPath(baseDir);
    if (!localBase || !fs.existsSync(localBase)) {
      for (const f of await hostComposeFolders(baseDir)) consider(path.posix.join(baseDir, f.dir), f.dir, f.file, f.content);
      continue;
    }

    try {
      const entries = fs.readdirSync(localBase, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subDirName = entry.name;
        if (subDirName.startsWith('.') || subDirName === 'node_modules') continue;
        const hostSubDir = path.posix.join(baseDir, subDirName);
        const localSubDir = path.join(localBase, subDirName);
        for (const fileName of ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']) {
          const localComposeFile = path.join(localSubDir, fileName);
          if (fs.existsSync(localComposeFile)) {
            try {
              consider(hostSubDir, subDirName, fileName, fs.readFileSync(localComposeFile, 'utf8'));
            } catch {
              // Ignore a file that can't be read
            }
            break;
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
      throw new Error(`Could not write ${composeFilePath} on the server.`);
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
 * Safe stack delete.
 *
 * Order matters — nothing is destroyed until a full backup exists:
 *   1. Record the compose file and .env in the history ledger.
 *   2. Stop the stack (`compose down`, keeping volumes) so databases are flushed and consistent.
 *   3. Archive the stack folder and its Compose-owned named volumes. If this fails, the stack is
 *      started again and the delete is aborted.
 *   4. Remove the stack's volumes and folder.
 *
 * `skipDataBackup` exists for stacks too large to archive; the UI requires an explicit opt-in.
 */
export async function deleteHostStack(params: {
  projectName: string;
  targetDirectory?: string;
  skipDataBackup?: boolean;
}): Promise<{
  success: boolean;
  message: string;
  /** The folder couldn't be removed from the server */
  folderLeft?: boolean;
  backupArchiveDir?: string;
  historyRecordId?: string;
  dataBackupBytes?: number;
}> {
  const { projectName, targetDirectory, skipDataBackup } = params;
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

  // Only ever this stack's own folder: where its apps run from, or where Manifexus found or made it.
  // A folder sent with the request that isn't one of those is refused, never deleted.
  const normDir = (d: string) => path.posix.normalize(d.trim()).replace(/\/+$/, '');
  const known = new Set<string>(
    [
      ...stackContainers.map((c) => c.compose?.workingDir || ''),
      ...(await discoverHostComposeStacks(containers)).filter((s) => s.project.toLowerCase() === sanitizedName).map((s) => s.workingDir),
    ]
      .filter(Boolean)
      .map(normDir)
  );
  if (!isDemo && targetDirectory && targetDirectory.trim() && !known.has(normDir(targetDirectory))) {
    throw new Error(`Nothing was deleted: ${targetDirectory} isn’t where ${projectName} lives.`);
  }
  const resolvedTargetDir =
    targetDirectory && targetDirectory.trim().startsWith('/')
      ? normDir(targetDirectory)
      : [...known][0] || path.posix.join(getDefaultHostStacksBaseDir(containers), sanitizedName);

  // The compose file the stack really uses (compose.yaml, docker-compose.yml…)
  const foundCompose = await findComposeFile(resolvedTargetDir);
  const composeFilePath = foundCompose?.path || path.posix.join(resolvedTargetDir, 'docker-compose.yml');
  const existingComposeContent = foundCompose?.content || undefined;

  // Step 1: ledger record with compose + .env
  const deleteRunId = `delete_${sanitizedName}_${Date.now()}`;
  const snapshotRes = await createPreMergeSnapshot({
    mergeId: deleteRunId,
    targetStackName: sanitizedName,
    targetDirectory: resolvedTargetDir,
    selectedContainers: stackContainers,
    preMergeTargetCompose: existingComposeContent,
  });
  const record = snapshotRes.record;
  record.summary = `Deleted stack "${sanitizedName}"`;
  record.status = 'active';
  record.type = 'STACK_DELETE';
  record.activityId = currentActivityId();
  record.deletedStack = {
    project: sanitizedName,
    workingDir: resolvedTargetDir,
    configFiles: composeFilePath,
    serviceCount: stackContainers.length,
  };

  // Step 2: stop the stack but keep its volumes, so the backup sees consistent data
  if (!isDemo && stackContainers.length > 0) {
    await runComposeInDir(resolvedTargetDir, 'down --remove-orphans');
  }

  // Step 3: full data backup (or an explicit, recorded opt-out)
  let dataBackupBytes = 0;
  if (!isDemo && !skipDataBackup) {
    try {
      const archives = await archiveStackData({
        project: sanitizedName,
        workingDir: resolvedTargetDir,
        archiveDir: snapshotRes.backupArchiveDir,
      });
      record.dataArchives = archives;
      dataBackupBytes = archives.reduce((sum, a) => sum + a.bytes, 0);
      record.archiveSizeBytes = (record.archiveSizeBytes || 0) + dataBackupBytes;
    } catch (backupErr) {
      // Put things back the way they were and refuse to delete without a backup
      if (stackContainers.length > 0) {
        await runComposeInDir(resolvedTargetDir, 'up -d');
      }
      try {
        fs.rmSync(snapshotRes.backupArchiveDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      throw new Error(
        `Delete cancelled: the data backup failed (${(backupErr as Error).message}). Nothing was deleted and the stack was restarted.`
      );
    }
  } else if (skipDataBackup) {
    record.dataBackupSkipped = true;
    record.summary = `Deleted stack "${sanitizedName}" (data backup skipped by user)`;
  }
  saveMergeHistoryRecord(record);

  // Step 4: remove volumes + folder. `down -v` covers volumes declared in the compose file;
  // any remaining Compose-owned volumes for the project are removed explicitly.
  if (!isDemo) {
    await runComposeInDir(resolvedTargetDir, 'down -v --remove-orphans');
    for (const v of await getProjectVolumes(sanitizedName)) {
      await removeVolume(v.name);
    }
  }
  let folderLeft = false;
  if (isDemo) {
    await deleteHostDirectory(resolvedTargetDir);
  } else if (!(await removeHostDirectory(resolvedTargetDir).catch(() => false))) {
    folderLeft = true;
    globalLogService.log({
      eventType: 'STACK_OP',
      level: 'WARN',
      source: 'stackService',
      message: `Stack '${sanitizedName}' folder ${resolvedTargetDir} could not be fully removed; its data is backed up in ${snapshotRes.backupArchiveDir}`,
    });
  }

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
    message: `Stack '${sanitizedName}' deleted at ${resolvedTargetDir} (history ${deleteRunId}, data backup ${
      skipDataBackup ? 'skipped' : formatBytes(dataBackupBytes)
    })`,
    payload: {
      projectName: sanitizedName,
      targetDirectory: resolvedTargetDir,
      backupArchiveDir: snapshotRes.backupArchiveDir,
      historyRecordId: deleteRunId,
      dataBackupBytes,
    },
  });

  return {
    success: true,
    folderLeft,
    message: folderLeft
      ? `Stack '${sanitizedName}' was deleted and backed up, but its folder ${resolvedTargetDir} couldn’t be removed from the server. You can delete it from Server Cleanup, or by hand.`
      : skipDataBackup
      ? `Stack '${sanitizedName}' was deleted. Its compose file was saved, but its data was not backed up.`
      : `Stack '${sanitizedName}' was deleted. Its compose file and ${formatBytes(dataBackupBytes)} of data were backed up. Bring it back anytime from Restore.`,
    backupArchiveDir: snapshotRes.backupArchiveDir,
    historyRecordId: deleteRunId,
    dataBackupBytes,
  };
}
