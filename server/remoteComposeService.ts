import yaml from 'yaml';
import { extractPortsFromCompose, ExtractedPort } from './portCollisionService';

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
