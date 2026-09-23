import path from 'path';
import fs from 'fs';
import yaml from 'yaml';
import * as tar from 'tar';
import { resolveContainerPath, createHostDirectory, checkHostFileExists } from './hostFsService';
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

  // Pattern 1: raw.githubusercontent.com/owner/repo/branch/...
  const rawMatch = trimmed.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)(?:\/.*)?$/);
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

  // Pattern 2: github.com/owner/repo/blob/branch/...
  const blobMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)(?:\/.*)?$/);
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

  return {
    isGitRepo: false,
  };
}

/**
 * Downloads and extracts the git repository into the target stack build-contexts directory.
 * Uses native Node tar extraction if local filesystem is writable, and falls back to elevated helper container.
 */
export async function cloneOrDownloadRepoContext(
  repoInfo: GitRepoInfo,
  targetDirectory: string,
  appName: string,
  log?: (msg: string) => void
): Promise<{ success: boolean; hostContextRelPath: string; hostContextAbsPath: string; error?: string }> {
  const relPath = `./build-contexts/${appName}`;
  const absPath = path.join(targetDirectory, 'build-contexts', appName);

  if (!repoInfo.owner || !repoInfo.repo) {
    return {
      success: false,
      hostContextRelPath: relPath,
      hostContextAbsPath: absPath,
      error: 'Unable to extract repository owner and name from source URL.',
    };
  }

  if (log) log(`Provisioning build context directory on host: ${absPath}`);
  await createHostDirectory(absPath);

  // Method 1: Node.js direct fetch of repository tarball
  const localTargetSubdir = resolveContainerPath(absPath);
  let nodeExtractSuccess = false;

  const candidateTarballUrls = [
    repoInfo.tarballUrl,
    `https://github.com/${repoInfo.owner}/${repoInfo.repo}/archive/HEAD.tar.gz`,
    `https://github.com/${repoInfo.owner}/${repoInfo.repo}/archive/refs/heads/master.tar.gz`,
    `https://github.com/${repoInfo.owner}/${repoInfo.repo}/archive/refs/heads/main.tar.gz`,
  ].filter(Boolean) as string[];

  for (const tarUrl of candidateTarballUrls) {
    try {
      if (log) log(`Attempting repository archive download from ${tarUrl}...`);
      const response = await fetch(tarUrl, {
        headers: { 'User-Agent': 'Manifexus-Engine/1.0' },
        redirect: 'follow',
      });

      if (response.ok && response.body) {
        fs.mkdirSync(localTargetSubdir, { recursive: true });
        const tempTarPath = path.join(localTargetSubdir, '_archive_temp.tar.gz');
        const arrayBuf = await response.arrayBuffer();
        fs.writeFileSync(tempTarPath, Buffer.from(arrayBuf));

        try {
          await tar.x({
            file: tempTarPath,
            cwd: localTargetSubdir,
            strip: 1,
          });
          if (fs.existsSync(tempTarPath)) {
            fs.unlinkSync(tempTarPath);
          }
          // Verify files were extracted
          const extractedFiles = fs.readdirSync(localTargetSubdir);
          if (extractedFiles.length > 0) {
            nodeExtractSuccess = true;
            if (log) log(`Repository extracted successfully (${extractedFiles.length} files/dirs unpacked).`);
            break;
          }
        } catch (tarErr) {
          if (fs.existsSync(tempTarPath)) fs.unlinkSync(tempTarPath);
          if (log) log(`Local tar extraction note: ${(tarErr as Error).message}`);
        }
      }
    } catch {
      // try next candidate
    }
  }

  if (nodeExtractSuccess) {
    return {
      success: true,
      hostContextRelPath: relPath,
      hostContextAbsPath: absPath,
    };
  }

  // Method 2: Elevated Docker container execution with git / curl / wget
  if (log) log('Executing elevated helper container to clone repository source files...');
  try {
    const helperImage = await getBestAvailableImage();
    const cloneUrl = repoInfo.cloneUrl || `https://github.com/${repoInfo.owner}/${repoInfo.repo}.git`;
    const tarUrl = candidateTarballUrls[0];

    const script = `
DEST="${absPath}"
mkdir -p "$DEST"
cd "$DEST"

if command -v git >/dev/null 2>&1; then
  git clone --depth 1 "${cloneUrl}" "$DEST" 2>&1 || true
fi

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
        if (log) log('Elevated clone/extraction succeeded in helper container.');
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

  // Check if Dockerfile exists despite warning
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
    error: `Failed to download or clone repository build context from "${repoInfo.cloneUrl || repoInfo.tarballUrl}".`,
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

    const appSubdirName = repoInfo.repo ? repoInfo.repo.toLowerCase().replace(/[^a-z0-9-_]/g, '-') : defaultAppName;
    const cloneResult = await cloneOrDownloadRepoContext(repoInfo, targetDirectory, appSubdirName, log);

    if (!cloneResult.success) {
      throw new Error(
        `Build context resolution failed for service "${svcName}": ${cloneResult.error || 'Could not fetch repository source files.'}`
      );
    }

    clonedContextPaths.push(cloneResult.hostContextAbsPath);

    // Mutate AST build context to point to the cloned subfolder
    if (typeof svc.build === 'string') {
      const origBuild = svc.build.trim();
      if (origBuild === '.' || origBuild === './' || origBuild === '') {
        svc.build = cloneResult.hostContextRelPath;
      } else if (origBuild.startsWith('./')) {
        svc.build = `${cloneResult.hostContextRelPath}/${origBuild.slice(2)}`;
      } else if (!origBuild.startsWith('/')) {
        svc.build = `${cloneResult.hostContextRelPath}/${origBuild}`;
      }
    } else if (typeof svc.build === 'object' && svc.build !== null) {
      const origContext = (svc.build.context || '.').trim();
      if (origContext === '.' || origContext === './' || origContext === '') {
        svc.build.context = cloneResult.hostContextRelPath;
      } else if (origContext.startsWith('./')) {
        svc.build.context = `${cloneResult.hostContextRelPath}/${origContext.slice(2)}`;
      } else if (!origContext.startsWith('/')) {
        svc.build.context = `${cloneResult.hostContextRelPath}/${origContext}`;
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
