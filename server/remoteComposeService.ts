import path from 'path';
import yaml from 'yaml';
import { readHostFile } from './hostFsService';
import {
  resolvePortCollisions,
  RemappedPort,
  extractPortsFromCompose,
  PortCollisionResultObject,
} from './portCollisionService';
import {
  mergeComposeWithAst,
  enforceDeterministicContainerNames,
} from './stackService';
import { resolveGitRepoInfo } from './buildContextService';
import { RemoteComposeMetadata } from '../src/types';

/**
 * Helper to fetch text from a URL with standard timeout and user agent headers.
 */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Manifexus-Engine/1.0',
      Accept: 'text/plain, application/x-yaml, text/yaml, application/octet-stream, */*',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

/**
 * Fetches and analyzes a docker-compose.yml from a remote URL.
 * Supports direct raw URLs, GitHub repository links, and pastes.
 * Returns structured RemoteComposeMetadata.
 */
export async function fetchRemoteCompose(url: string): Promise<RemoteComposeMetadata> {
  const trimmedUrl = url.trim();
  const gitInfo = resolveGitRepoInfo(trimmedUrl);

  let rawYaml = '';
  let resolvedSourceUrl = trimmedUrl;

  // If user provided a raw GitHub URL or other direct text URL
  if (
    trimmedUrl.includes('raw.githubusercontent.com') ||
    trimmedUrl.endsWith('.yml') ||
    trimmedUrl.endsWith('.yaml') ||
    trimmedUrl.includes('pastebin.com/raw')
  ) {
    rawYaml = await fetchText(trimmedUrl);
    resolvedSourceUrl = trimmedUrl;
  } else if (gitInfo.isGitRepo && gitInfo.owner && gitInfo.repo) {
    // If user provided a GitHub repository root or tree, try common compose filenames across branch candidates
    const branches = [gitInfo.branch || 'main', 'master'];
    const filenames = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];

    let found = false;
    let lastError: Error | null = null;

    for (const branch of branches) {
      for (const fn of filenames) {
        const candidateUrl = `https://raw.githubusercontent.com/${gitInfo.owner}/${gitInfo.repo}/${branch}/${fn}`;
        try {
          rawYaml = await fetchText(candidateUrl);
          resolvedSourceUrl = candidateUrl;
          found = true;
          break;
        } catch (err) {
          lastError = err as Error;
        }
      }
      if (found) break;
    }

    if (!found) {
      throw new Error(
        `Could not locate a docker-compose.yml in GitHub repository ${gitInfo.owner}/${gitInfo.repo} (${lastError?.message || 'not found'})`
      );
    }
  } else {
    // Attempt direct fetch
    rawYaml = await fetchText(trimmedUrl);
    resolvedSourceUrl = trimmedUrl;
  }

  if (!rawYaml || rawYaml.trim().length === 0) {
    throw new Error('Remote URL returned an empty compose configuration.');
  }

  // Parse YAML to extract metadata
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doc: any;
  try {
    doc = yaml.parse(rawYaml);
  } catch (err) {
    throw new Error(`Fetched content is not valid YAML: ${(err as Error).message}`);
  }

  if (!doc || !doc.services || typeof doc.services !== 'object') {
    throw new Error('Valid YAML was returned, but no "services" root key was found.');
  }

  const serviceNames = Object.keys(doc.services);
  const serviceDetails: RemoteComposeMetadata['serviceDetails'] = [];

  for (const sName of serviceNames) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sDef = doc.services[sName] as any;
    if (!sDef || typeof sDef !== 'object') continue;

    const sPorts = extractPortsFromCompose(
      yaml.stringify({ services: { [sName]: sDef } })
    );

    const ports = sPorts.map((p) => ({
      service: sName,
      hostPort: p.hostPort,
      containerPort: p.containerPort,
      protocol: p.protocol,
      hostIp: p.hostIp,
    }));

    const volumeCount = Array.isArray(sDef.volumes) ? sDef.volumes.length : 0;
    const networkCount = Array.isArray(sDef.networks)
      ? sDef.networks.length
      : sDef.networks && typeof sDef.networks === 'object'
        ? Object.keys(sDef.networks).length
        : 0;

    serviceDetails.push({
      name: sName,
      image: typeof sDef.image === 'string' ? sDef.image : undefined,
      containerName: typeof sDef.container_name === 'string' ? sDef.container_name : undefined,
      ports,
      volumeCount,
      networkCount,
    });
  }

  return {
    url: trimmedUrl,
    resolvedSourceUrl,
    rawYaml,
    serviceNames,
    serviceDetails,
    isGitHubRepo: gitInfo.isGitRepo,
    repoOwner: gitInfo.owner,
    repoName: gitInfo.repo,
  };
}

/**
 * Directive 1: Process and Merge Remote Compose YAML
 * Fetches the incoming remote compose file, reads the existing one (if any) to freeze its ports,
 * and passes both to the collision engine so only the incoming file is mutated to avoid collisions.
 */
export async function processRemoteCompose(
  sourceUrl: string,
  targetDirectory: string,
  log?: (msg: string) => void
): Promise<string> {
  if (log) log(`Fetching incoming remote compose file from: ${sourceUrl}`);

  const metadata = await fetchRemoteCompose(sourceUrl);
  const incomingYaml = metadata.rawYaml;

  // Attempt to read the existing docker-compose.yml on the physical host
  const existingComposePath = path.join(targetDirectory, 'docker-compose.yml');
  let existingYaml: string | undefined = undefined;

  try {
    const existingContent = await readHostFile(existingComposePath);
    if (existingContent && existingContent.trim().length > 0) {
      if (log) log(`Existing stack detected at ${targetDirectory}. Existing ports are locked and will not be mutated.`);
      existingYaml = existingContent;
    }
  } catch {
    if (log) log(`No readable existing stack found at ${targetDirectory}. Proceeding as new provision.`);
  }

  if (log) log('Analyzing incoming compose file for host port collisions...');

  // The collision engine will use existingYaml to build the untouchable port blocklist
  const resolvedResult = resolvePortCollisions(incomingYaml, existingYaml, log);
  return resolvedResult.resolvedYaml;
}

/**
 * Namespaces relative host volume mounts (e.g., ./data -> ./serviceName/data)
 * to avoid collisions when merging multiple services or stacks into a shared directory.
 */
export function namespaceRelativeVolumeMounts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  services: Record<string, any>,
  prefix?: string
): void {
  if (!services || typeof services !== 'object') return;

  for (const [serviceName, serviceDef] of Object.entries(services)) {
    if (!serviceDef || !Array.isArray(serviceDef.volumes)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    serviceDef.volumes = serviceDef.volumes.map((vol: any) => {
      if (typeof vol === 'string') {
        const parts = vol.split(':');
        const hostSource = parts[0];
        if (
          hostSource &&
          (hostSource.startsWith('./') || hostSource.startsWith('../') || hostSource === '.')
        ) {
          const servicePrefix = prefix || serviceName;
          const cleanHost = hostSource.replace(/^(\.\/|\.\.\/|\.)/, '');
          if (!cleanHost.startsWith(servicePrefix)) {
            parts[0] = `./${servicePrefix}/${cleanHost}`.replace(/\/+/g, '/');
            return parts.join(':');
          }
        }
        return vol;
      } else if (typeof vol === 'object' && vol !== null) {
        if (vol.type === 'bind' && typeof vol.source === 'string') {
          const hostSource = vol.source;
          if (
            hostSource &&
            (hostSource.startsWith('./') || hostSource.startsWith('../') || hostSource === '.')
          ) {
            const servicePrefix = prefix || serviceName;
            const cleanHost = hostSource.replace(/^(\.\/|\.\.\/|\.)/, '');
            if (!cleanHost.startsWith(servicePrefix)) {
              vol.source = `./${servicePrefix}/${cleanHost}`.replace(/\/+/g, '/');
            }
          }
        }
        return vol;
      }
      return vol;
    });
  }
}

export interface SynthesizeRemoteComposeParams {
  rawYaml: string;
  sourceUrl?: string;
  targetDirectory: string;
  targetStackName: string;
  installMode: string;
  occupiedPorts?: Set<number>;
}

export interface SynthesizeRemoteComposeResult {
  synthesizedYaml: string;
  resolvedYaml: string;
  hasCollisions: boolean;
  remappedPorts: RemappedPort[];
  isMerged: boolean;
  existingServiceCount: number;
  incomingServiceCount: number;
  buildContextsFound: string[];
  existingComposeFound: boolean;
}

/**
 * Synthesizes remote compose AST, analyzes port collisions, namespaces relative mounts,
 * and performs non-destructive deep AST merge if targeted at an existing stack.
 */
export async function synthesizeRemoteComposeAST(
  params: SynthesizeRemoteComposeParams
): Promise<SynthesizeRemoteComposeResult> {
  const {
    rawYaml,
    targetDirectory,
    targetStackName,
    installMode,
    occupiedPorts = new Set<number>(),
  } = params;

  if (!rawYaml || rawYaml.trim().length === 0) {
    throw new Error('Compose YAML content is empty.');
  }

  // Parse incoming document
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doc: any;
  try {
    doc = yaml.parse(rawYaml);
  } catch (err) {
    throw new Error(`Failed to parse Compose YAML: ${(err as Error).message}`);
  }

  if (!doc || !doc.services || typeof doc.services !== 'object') {
    throw new Error('Invalid Compose specification: missing "services" object.');
  }

  const incomingServiceNames = Object.keys(doc.services);
  const buildContextsFound: string[] = [];

  for (const [sName, sDef] of Object.entries(doc.services)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = sDef as any;
    if (svc && svc.build) {
      const ctx = typeof svc.build === 'string' ? svc.build : (svc.build.context || '.');
      buildContextsFound.push(`${sName} (${ctx})`);
    }
  }

  // Resolve port collisions
  const portRes = resolvePortCollisions(rawYaml, occupiedPorts);
  let workingYaml = portRes.resolvedYaml;

  let isMerged = false;
  let existingServiceCount = 0;
  let existingComposeFound = false;
  let finalSynthesizedYaml = workingYaml;

  if (installMode === 'existing-stack' && targetDirectory) {
    const existingCandidates = [
      path.join(targetDirectory, 'docker-compose.yml'),
      path.join(targetDirectory, 'docker-compose.yaml'),
      path.join(targetDirectory, 'compose.yaml'),
    ];

    let existingContent: string | undefined;
    for (const cand of existingCandidates) {
      try {
        const c = await readHostFile(cand);
        if (c && c.trim().length > 0) {
          existingContent = c;
          existingComposeFound = true;
          break;
        }
      } catch {
        // ignore and try next
      }
    }

    if (existingContent && existingComposeFound) {
      try {
        const existingDoc = yaml.parse(existingContent);
        if (existingDoc && existingDoc.services) {
          existingServiceCount = Object.keys(existingDoc.services).length;
        }
      } catch {
        existingServiceCount = 0;
      }

      // Parse working YAML to inject services
      const parsedWorking = yaml.parse(workingYaml) || {};
      const incomingServices = parsedWorking.services || {};
      const incomingVolumes = parsedWorking.volumes || {};
      const incomingNetworks = parsedWorking.networks || {};

      namespaceRelativeVolumeMounts(incomingServices, targetStackName);

      const merged = mergeComposeWithAst(
        existingContent,
        incomingServices,
        incomingVolumes,
        incomingNetworks
      );

      finalSynthesizedYaml = enforceDeterministicContainerNames(merged);
      isMerged = true;
    } else {
      // No existing file found, treat as new stack
      const parsedWorking = yaml.parse(workingYaml) || {};
      if (parsedWorking.services) {
        namespaceRelativeVolumeMounts(parsedWorking.services);
      }
      finalSynthesizedYaml = enforceDeterministicContainerNames(workingYaml);
    }
  } else {
    // New stack mode
    const parsedWorking = yaml.parse(workingYaml) || {};
    if (parsedWorking.services) {
      namespaceRelativeVolumeMounts(parsedWorking.services);
    }
    finalSynthesizedYaml = enforceDeterministicContainerNames(workingYaml);
  }

  return {
    synthesizedYaml: finalSynthesizedYaml,
    resolvedYaml: finalSynthesizedYaml,
    hasCollisions: portRes.hasCollisions,
    remappedPorts: portRes.remappedPorts,
    isMerged,
    existingServiceCount,
    incomingServiceCount: incomingServiceNames.length,
    buildContextsFound,
    existingComposeFound,
  };
}
