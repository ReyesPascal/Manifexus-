import path from 'path';
import yaml from 'yaml';
import { extractPortsFromCompose, resolvePortCollisions, ExtractedPort, RemappedPort } from './portCollisionService';
import { readHostFile } from './hostFsService';
import {
  mergeComposeWithAst,
  enforceDeterministicContainerNames,
  validateComposeAstObject,
  strictlyDumpComposeAst,
} from './stackService';

export interface RemoteComposeMetadata {
  url: string;
  resolvedSourceUrl: string;
  rawYaml: string;
  serviceNames: string[];
  serviceDetails: {
    name: string;
    image?: string;
    containerName?: string;
    ports: ExtractedPort[];
    volumeCount: number;
    networkCount: number;
  }[];
  isGitHubRepo: boolean;
  repoOwner?: string;
  repoName?: string;
}

/**
 * Normalizes input URL and resolves candidate direct raw URLs for GitHub repositories
 */
export function resolveCandidateRawUrls(inputUrl: string): {
  candidateUrls: string[];
  isGitHubRepo: boolean;
  repoOwner?: string;
  repoName?: string;
} {
  const trimmed = inputUrl.trim();

  // Case 1: GitHub blob URL, e.g. https://github.com/owner/repo/blob/main/docker-compose.yml
  const blobMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (blobMatch) {
    const [, owner, repo, branch, filePath] = blobMatch;
    return {
      candidateUrls: [`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`],
      isGitHubRepo: true,
      repoOwner: owner,
      repoName: repo,
    };
  }

  // Case 2: Direct raw URL e.g. https://raw.githubusercontent.com/... or raw gist
  if (trimmed.includes('raw.githubusercontent.com') || trimmed.includes('gist.githubusercontent.com')) {
    return {
      candidateUrls: [trimmed],
      isGitHubRepo: trimmed.includes('raw.githubusercontent.com'),
    };
  }

  // Case 3: GitHub repository URL, e.g. https://github.com/ReyesPascal/Manifexus- or https://github.com/user/repo
  const repoMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/);
  if (repoMatch) {
    const [, owner, repo] = repoMatch;
    const branches = ['main', 'master'];
    const filenames = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];

    const candidates: string[] = [];
    for (const b of branches) {
      for (const f of filenames) {
        candidates.push(`https://raw.githubusercontent.com/${owner}/${repo}/${b}/${f}`);
      }
    }

    return {
      candidateUrls: candidates,
      isGitHubRepo: true,
      repoOwner: owner,
      repoName: repo,
    };
  }

  // Case 4: Any standard web URL
  return {
    candidateUrls: [trimmed],
    isGitHubRepo: false,
  };
}

/**
 * Directive 2: Remote Compose Fetching & Inspection Engine
 * Fetches compose file from remote URL, auto-resolving GitHub repos and validating YAML syntax
 */
export async function fetchRemoteCompose(inputUrl: string): Promise<RemoteComposeMetadata> {
  const { candidateUrls, isGitHubRepo, repoOwner, repoName } = resolveCandidateRawUrls(inputUrl);

  let lastError: string | null = null;
  let successfulUrl = '';
  let fetchedText = '';

  for (const candidate of candidateUrls) {
    try {
      const resp = await fetch(candidate, {
        headers: {
          'User-Agent': 'Manifexus-Compose-Engine/1.0',
          Accept: 'text/plain, text/yaml, application/x-yaml, */*',
        },
      });

      if (resp.ok) {
        const text = await resp.text();
        // Check if content looks like HTML (e.g. 404 page or error page)
        if (text.trim().startsWith('<!DOCTYPE html>') || text.trim().startsWith('<html')) {
          continue;
        }

        // Validate YAML
        try {
          const parsed = yaml.parse(text);
          if (parsed && typeof parsed === 'object' && (parsed.services || parsed.version)) {
            fetchedText = text;
            successfulUrl = candidate;
            break;
          }
        } catch {
          // not valid yaml
          continue;
        }
      }
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  if (!fetchedText) {
    if (isGitHubRepo) {
      throw new Error(
        `Could not locate a valid docker-compose.yml or compose.yaml in GitHub repository "${inputUrl}". ` +
        `Checked candidate paths on main and master branches. Please check the repository URL or provide the direct raw file URL.`
      );
    }
    throw new Error(
      `Failed to fetch valid Docker Compose YAML from "${inputUrl}". ${lastError || 'HTTP request failed or content was not valid YAML.'}`
    );
  }

  // Parse details
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = yaml.parse(fetchedText) as any;
  const services = doc.services || {};
  const serviceNames = Object.keys(services);

  if (serviceNames.length === 0) {
    throw new Error('Fetched YAML has no services defined under the "services:" root key.');
  }

  const extractedPorts = extractPortsFromCompose(fetchedText);

  const serviceDetails = serviceNames.map((name) => {
    const s = services[name] || {};
    const ports = extractedPorts.filter((p) => p.service === name);
    const volumeCount = Array.isArray(s.volumes) ? s.volumes.length : 0;
    const networkCount = Array.isArray(s.networks) ? s.networks.length : s.networks ? 1 : 0;

    return {
      name,
      image: typeof s.image === 'string' ? s.image : undefined,
      containerName: typeof s.container_name === 'string' ? s.container_name : undefined,
      ports,
      volumeCount,
      networkCount,
    };
  });

  return {
    url: inputUrl,
    resolvedSourceUrl: successfulUrl,
    rawYaml: fetchedText,
    serviceNames,
    serviceDetails,
    isGitHubRepo,
    repoOwner,
    repoName,
  };
}

/**
 * Directive 3: Resolves and namespaces any relative host directory bind mounts in services
 * (e.g. ./downloads -> ./<service_name>/downloads) to prevent colliding with existing stack directories.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function namespaceRelativeVolumeMounts(services: Record<string, any>): void {
  for (const [svcName, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;
    if (!Array.isArray(svc.volumes)) continue;

    const cleanSvcName = svcName.toLowerCase().replace(/[^a-z0-9-_]/g, '-');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc.volumes = svc.volumes.map((vol: any) => {
      if (typeof vol === 'string') {
        const parts = vol.split(':');
        const hostSrc = parts[0]?.trim();
        if (hostSrc && hostSrc.startsWith('./')) {
          const cleanRel = hostSrc.slice(2);
          // If not already namespaced under service name or remote-build
          if (!cleanRel.startsWith(`${cleanSvcName}/`) && !cleanRel.startsWith('remote-build-')) {
            parts[0] = `./${cleanSvcName}/${cleanRel}`;
            return parts.join(':');
          }
        }
        return vol;
      } else if (typeof vol === 'object' && vol !== null) {
        if (vol.source && typeof vol.source === 'string' && vol.source.startsWith('./')) {
          const cleanRel = vol.source.slice(2);
          if (!cleanRel.startsWith(`${cleanSvcName}/`) && !cleanRel.startsWith('remote-build-')) {
            return {
              ...vol,
              source: `./${cleanSvcName}/${cleanRel}`,
            };
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
  targetStackName: string;
  targetDirectory: string;
  installMode: 'existing-stack' | 'new-stack';
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
 * Directive 1 & 2: Remote Compose AST Synthesis & Merging Engine
 * First reads and parses existing docker-compose.yml in the target host directory,
 * deep-merges services, volumes, and networks into the existing AST without overwriting root objects,
 * scans for build: directives to point to ./remote-build-<service_name>,
 * namespaces relative volume mounts, and injects deterministic container names.
 */
export async function synthesizeRemoteComposeAST(
  params: SynthesizeRemoteComposeParams
): Promise<SynthesizeRemoteComposeResult> {
  const { rawYaml, targetStackName, targetDirectory, installMode, occupiedPorts } = params;

  // 1. Resolve Port Collisions on incoming compose specification
  const portRes = resolvePortCollisions(rawYaml, occupiedPorts || new Set());
  const workingYaml = portRes.resolvedYaml;

  // 2. Parse incoming document
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const incomingDoc = (yaml.parse(workingYaml) || {}) as any;
  const incomingServices = (incomingDoc.services || {}) as Record<string, any>;
  const incomingVolumes = (incomingDoc.volumes || {}) as Record<string, any>;
  const incomingNetworks = (incomingDoc.networks || {}) as Record<string, any>;
  const incomingServiceNames = Object.keys(incomingServices);

  if (incomingServiceNames.length === 0) {
    throw new Error('Fetched YAML has no services defined under the "services:" root key.');
  }

  // 3. Scan for build: directives and mutate AST to dedicated ./remote-build-<service_name> subdirectories
  const buildContextsFound: string[] = [];
  for (const svcName of incomingServiceNames) {
    const svc = incomingServices[svcName];
    if (!svc || typeof svc !== 'object') continue;

    const hasBuild = Boolean(svc.build);
    const hasImage = typeof svc.image === 'string' && svc.image.trim().length > 0;

    if (hasBuild) {
      if (hasImage) {
        // Pre-built image priority: drop local build context
        delete svc.build;
      } else {
        const cleanSvcName = svcName.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
        buildContextsFound.push(svcName);
        const relContextPath = `./remote-build-${cleanSvcName}`;

        if (typeof svc.build === 'string') {
          svc.build = relContextPath;
        } else if (typeof svc.build === 'object' && svc.build !== null) {
          svc.build.context = relContextPath;
          if (!svc.build.dockerfile) {
            svc.build.dockerfile = 'Dockerfile';
          }
        }
      }
    }

    // Enforce deterministic container_name
    if (!svc.container_name) {
      svc.container_name = svcName;
    }
  }

  // 4. Namespace relative host directory bind mounts in incoming services to prevent clashing with existing stack directories
  if (installMode === 'existing-stack') {
    namespaceRelativeVolumeMounts(incomingServices);
  }

  // 5. Check target directory for existing docker-compose.yml
  let existingContent: string | undefined;
  if (installMode === 'existing-stack' && targetDirectory) {
    const candidatePaths = [
      path.join(targetDirectory, 'docker-compose.yml'),
      path.join(targetDirectory, 'docker-compose.yaml'),
      path.join(targetDirectory, 'compose.yaml'),
    ];

    for (const cp of candidatePaths) {
      try {
        const content = await readHostFile(cp);
        if (content && content.trim().length > 0) {
          existingContent = content;
          break;
        }
      } catch {
        // ignore and check next
      }
    }
  }

  // 6. AST Deep Merge vs New Stack Synthesis
  if (existingContent) {
    // Parse existing compose document to count services
    let existingServiceCount = 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existingDoc = yaml.parse(existingContent) as any;
      existingServiceCount = Object.keys(existingDoc?.services || {}).length;
    } catch {
      // fallback count 0
    }

    // Deep merge incoming services, volumes, and networks into existing AST
    const merged = mergeComposeWithAst(
      existingContent,
      incomingServices,
      incomingVolumes,
      incomingNetworks
    );

    const finalizedYaml = enforceDeterministicContainerNames(merged);

    return {
      synthesizedYaml: finalizedYaml,
      resolvedYaml: finalizedYaml,
      hasCollisions: portRes.hasCollisions,
      remappedPorts: portRes.remappedPorts,
      isMerged: true,
      existingServiceCount,
      incomingServiceCount: incomingServiceNames.length,
      buildContextsFound,
      existingComposeFound: true,
    };
  }

  // New Stack mode or existing compose not found
  incomingDoc.services = incomingServices;
  if (Object.keys(incomingVolumes).length > 0) incomingDoc.volumes = incomingVolumes;
  if (Object.keys(incomingNetworks).length > 0) incomingDoc.networks = incomingNetworks;

  validateComposeAstObject(incomingDoc);
  const cleanYaml = strictlyDumpComposeAst(incomingDoc);
  const finalizedYaml = enforceDeterministicContainerNames(cleanYaml);

  return {
    synthesizedYaml: finalizedYaml,
    resolvedYaml: finalizedYaml,
    hasCollisions: portRes.hasCollisions,
    remappedPorts: portRes.remappedPorts,
    isMerged: false,
    existingServiceCount: 0,
    incomingServiceCount: incomingServiceNames.length,
    buildContextsFound,
    existingComposeFound: false,
  };
}
