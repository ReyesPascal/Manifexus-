import path from 'path';
import yaml from 'yaml';
import { createHostDirectory, checkHostFileExists } from './hostFsService';
import { queryDockerEngine, getBestAvailableImage } from './dockerService';

export interface GitRepoInfo {
  isGitRepo: boolean;
  owner?: string;
  repo?: string;
  branch?: string;
  cloneUrl?: string;
  tarballUrl?: string;
}

/**
 * Parses a GitHub repository or raw compose URL to extract owner, repo, branch, and clone targets.
 */
export function resolveGitRepoInfo(sourceUrl: string): GitRepoInfo {
  const trimmed = sourceUrl.trim();

  // Pattern 1: raw.githubusercontent.com/owner/repo/(refs/heads/)?branch/...
  const rawMatch = trimmed.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(?:refs\/heads\/)?([^/]+)(?:\/.*)?$/);
  if (rawMatch) {
    const [, owner, repo, branch] = rawMatch;
    return {
      isGitRepo: true,
      owner,
      repo,
      branch,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      tarballUrl: `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.tar.gz`,
    };
  }

  // Pattern 2: github.com/owner/repo/(blob|raw|tree)/(refs/heads/)?branch/...
  const blobMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw|tree)\/(?:refs\/heads\/)?([^/]+)(?:\/.*)?$/);
  if (blobMatch) {
    const [, owner, repo, branch] = blobMatch;
    return {
      isGitRepo: true,
      owner,
      repo,
      branch,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      tarballUrl: `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.tar.gz`,
    };
  }

  // Pattern 3: github.com/owner/repo or github.com/owner/repo.git
  const repoMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/);
  if (repoMatch) {
    const [, owner, repo] = repoMatch;
    return {
      isGitRepo: true,
      owner,
      repo,
      branch: 'main',
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      tarballUrl: `https://github.com/${owner}/${repo}/archive/HEAD.tar.gz`,
    };
  }

  // Fallback: Check if string contains github.com/owner/repo anywhere
  const generalGhMatch = trimmed.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/);
  if (generalGhMatch) {
    const [, owner, repoRaw] = generalGhMatch;
    const repo = repoRaw.replace(/\.git$/, '');
    return {
      isGitRepo: true,
      owner,
      repo,
      branch: 'main',
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      tarballUrl: `https://github.com/${owner}/${repo}/archive/HEAD.tar.gz`,
    };
  }

  return {
    isGitRepo: false,
  };
}

/**
 * Downloads and extracts the git repository into the target stack build-contexts directory.
 * Strictly uses the elevated helper container to ensure files are written to the physical host filesystem,
 * preventing container isolation barriers from hiding the build context from the Docker Daemon.
 */
export async function cloneOrDownloadRepoContext(
  repoInfo: GitRepoInfo,
  targetDirectory: string,
  serviceName: string,
  log?: (msg: string) => void
): Promise<{ success: boolean; hostContextRelPath: string; hostContextAbsPath: string; error?: string }> {
  const cleanServiceName = serviceName.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const relPath = `./remote-build-${cleanServiceName}`;
  const absPath = path.join(targetDirectory, `remote-build-${cleanServiceName}`);

  if (!repoInfo.owner || !repoInfo.repo) {
    return {
      success: false,
      hostContextRelPath: relPath,
      hostContextAbsPath: absPath,
      error: 'Unable to extract repository owner and name from source URL.',
    };
  }

  if (log) log(`Provisioning physical host build context directory: ${absPath}`);
  
  // createHostDirectory has been updated to enforce physical host execution
  await createHostDirectory(absPath);

  const candidateTarballUrls = [
    repoInfo.tarballUrl,
    `https://github.com/${repoInfo.owner}/${repoInfo.repo}/archive/HEAD.tar.gz`,
    `https://github.com/${repoInfo.owner}/${repoInfo.repo}/archive/refs/heads/master.tar.gz`,
    `https://github.com/${repoInfo.owner}/${repoInfo.repo}/archive/refs/heads/main.tar.gz`,
  ].filter(Boolean) as string[];

  // Explicitly execute elevated Docker container with git / curl / wget to write directly to host
  if (log) log('Executing elevated helper container to clone repository source files to physical host...');
  try {
    const helperImage = await getBestAvailableImage();
    const cloneUrl = repoInfo.cloneUrl || `https://github.com/${repoInfo.owner}/${repoInfo.repo}.git`;
    const tarUrl = candidateTarballUrls[0]; // Try primary tarball URL if git clone fails

    const script = `
DEST="${absPath}"
mkdir -p "$DEST"
cd "$DEST"

# Attempt 1: Git clone
if command -v git >/dev/null 2>&1; then
  TMP_GIT="/tmp/clone_${cleanServiceName}_$$"
  rm -rf "$TMP_GIT"
  git clone --depth 1 "${cloneUrl}" "$TMP_GIT" 2>&1 && cp -r "$TMP_GIT/." "$DEST/" && rm -rf "$TMP_GIT" || true
fi

# Attempt 2: Fallback to curl/wget archive extraction if Dockerfile still missing
if [ ! -f "$DEST/Dockerfile" ] && [ ! -f "$DEST/dockerfile" ]; then
  if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    curl -fsSL "${tarUrl}" | tar -xz -C "$DEST" --strip-components=1 2>&1 || true
  elif command -v wget >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    wget -qO- "${tarUrl}" | tar -xz -C "$DEST" --strip-components=1 2>&1 || true
  fi
fi

chmod -R 755 "$DEST"
[ -f "$DEST/Dockerfile" ] || [ -f "$DEST/dockerfile" ] || [ $(ls -A "$DEST" | wc -l) -gt 0 ]
`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: ['sh', '-c', script],
      HostConfig: {
        Binds: [`${targetDirectory}:${targetDirectory}:rw`],
      },
    });

    if (runner && runner.Id) {
      await queryDockerEngine(`/containers/${runner.Id}/start`, 'POST');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const waitRes = await queryDockerEngine<any>(`/containers/${runner.Id}/wait`, 'POST', undefined, 90000);
      await queryDockerEngine(`/containers/${runner.Id}?force=true`, 'DELETE');

      if (waitRes && waitRes.StatusCode === 0) {
        if (log) log('Host-level clone/extraction succeeded via helper container.');
        return {
          success: true,
          hostContextRelPath: relPath,
          hostContextAbsPath: absPath,
        };
      }
    }
  } catch (err) {
    if (log) log(`Helper container clone error: ${(err as Error).message}`);
  }

  // Check if Dockerfile exists on the physical host despite a non-zero exit code
  const dockerfileExists =
    (await checkHostFileExists(path.join(absPath, 'Dockerfile'))) ||
    (await checkHostFileExists(path.join(absPath, 'dockerfile')));

  if (dockerfileExists) {
    return {
      success: true,
      hostContextRelPath: relPath,
      hostContextAbsPath: absPath,
    };
  }

  return {
    success: false,
    hostContextRelPath: relPath,
    hostContextAbsPath: absPath,
    error: `Failed to download or clone repository build context from "${repoInfo.cloneUrl || repoInfo.tarballUrl}" to host filesystem.`,
  };
}

/**
 * Directive 2: Inspects Compose YAML, implements pre-built image priority,
 * downloads required build contexts, and programmatically mutates AST build paths.
 */
export async function resolveComposeBuildContexts(params: {
  composeYaml: string;
  sourceUrl: string;
  targetDirectory: string;
  defaultAppName?: string;
  log?: (msg: string) => void;
}): Promise<{
  mutatedYaml: string;
  hasBuildContexts: boolean;
  clonedContextPaths: string[];
}> {
  const { composeYaml, sourceUrl, targetDirectory, defaultAppName = 'app', log } = params;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = yaml.parse(composeYaml) as any;
  if (!doc || !doc.services || typeof doc.services !== 'object') {
    return { mutatedYaml: composeYaml, hasBuildContexts: false, clonedContextPaths: [] };
  }

  const services = doc.services;
  const serviceNames = Object.keys(services);
  let hasMutated = false;
  let hasBuildContexts = false;
  const clonedContextPaths: string[] = [];

  const repoInfo = resolveGitRepoInfo(sourceUrl);

  for (const svcName of serviceNames) {
    const svc = services[svcName];
    if (!svc) continue;

    const hasBuild = Boolean(svc.build);
    const hasImage = typeof svc.image === 'string' && svc.image.trim().length > 0;

    if (!hasBuild) continue;

    hasBuildContexts = true;

    // DIRECTIVE 2 Image Fallback:
    // If an explicit image tag is provided alongside a build context, prioritize pulling the pre-built image
    if (hasImage) {
      if (log) {
        log(
          `Service "${svcName}": Found explicit image "${svc.image}" alongside build context. Prioritizing pre-built registry image to bypass local build.`
        );
      }
      delete svc.build;
      hasMutated = true;
      continue;
    }

    // DIRECTIVE 2: Service requires local build and has no explicit image
    if (log) {
      log(`Service "${svcName}": Local build context required (${JSON.stringify(svc.build)}). Resolving repository source files...`);
    }

    // Dedicated subdirectory within target stack: ./remote-build-<service_name>
    const cleanSvcName = svcName.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    const cloneResult = await cloneOrDownloadRepoContext(repoInfo, targetDirectory, cleanSvcName, log);

    if (!cloneResult.success) {
      throw new Error(
        `Build context resolution failed for service "${svcName}": ${cloneResult.error || 'Could not fetch repository source files.'}`
      );
    }

    clonedContextPaths.push(cloneResult.hostContextAbsPath);

    // Programmatically mutate AST build context to point to the dedicated subdirectory ./remote-build-<service_name>
    const relContextPath = `./remote-build-${cleanSvcName}`;
    if (typeof svc.build === 'string') {
      svc.build = relContextPath;
    } else if (typeof svc.build === 'object' && svc.build !== null) {
      svc.build.context = relContextPath;
      if (!svc.build.dockerfile) {
        svc.build.dockerfile = 'Dockerfile';
      }
    }

    if (log) {
      log(`Service "${svcName}": AST mutated. Build context now points to ${JSON.stringify(svc.build)}.`);
    }
    hasMutated = true;
  }

  const finalYaml = hasMutated ? yaml.stringify(doc) : composeYaml;
  return {
    mutatedYaml: finalYaml,
    hasBuildContexts,
    clonedContextPaths,
  };
}