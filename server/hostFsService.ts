import fs from 'fs';
import path from 'path';
import { queryDockerEngine, getBestAvailableImage } from './dockerService';

const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const HOST_ROOT = process.env.HOST_ROOT || '/host';

/**
 * Resolves a host path inside the container if HOST_ROOT is mounted
 */
export function resolveContainerPath(hostPath: string): string {
  if (fs.existsSync(HOST_ROOT)) {
    if (HOST_ROOT.endsWith('/home') && hostPath.startsWith('/home/')) {
      return path.join(HOST_ROOT, hostPath.replace('/home/', ''));
    }
    const cleanHostPath = hostPath.startsWith('/') ? hostPath.slice(1) : hostPath;
    const candidate = path.join(HOST_ROOT, cleanHostPath);
    if (fs.existsSync(candidate) || fs.existsSync(path.dirname(candidate))) {
      return candidate;
    }
  }
  return hostPath;
}

/**
 * Reads a text file from the host filesystem.
 * If Manifexus does not have the host mounted directly, it uses the Docker socket helper container
 * to read the exact host file with zero container filesystem barriers.
 */
export async function readHostFile(hostFilePath: string): Promise<string | null> {
  // 1. Direct filesystem check
  const localCandidate = resolveContainerPath(hostFilePath);
  if (fs.existsSync(localCandidate)) {
    try {
      const stats = fs.statSync(localCandidate);
      if (stats.isFile()) {
        return fs.readFileSync(localCandidate, 'utf8');
      }
    } catch {
      // fallback
    }
  }

  // 2. Docker Engine helper execution (mounts target host folder read-only)
  try {
    const parentDir = path.dirname(hostFilePath);
    const fileName = path.basename(hostFilePath);
    const helperImage = await getBestAvailableImage();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: ['sh', '-c', `if [ -f "/target_dir/${fileName}" ]; then cat "/target_dir/${fileName}"; else exit 44; fi`],
      HostConfig: {
        Binds: [`${parentDir}:/target_dir:ro`],
      },
    });

    if (runner && runner.Id) {
      await queryDockerEngine(`/containers/${runner.Id}/start`, 'POST');
      // Wait for execution
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const waitRes = await queryDockerEngine<any>(`/containers/${runner.Id}/wait`, 'POST');
      
      let fileContent: string | null = null;
      if (waitRes && waitRes.StatusCode === 0) {
        // Fetch container stdout logs
        const logs = await queryDockerEngine<string>(`/containers/${runner.Id}/logs?stdout=1`, 'GET');
        // Docker multiplexed stream prepends 8-byte header to frames; strip non-printable header if needed
        fileContent = cleanDockerLogs(logs);
      }

      await queryDockerEngine(`/containers/${runner.Id}?force=true`, 'DELETE');
      return fileContent;
    }
  } catch (err) {
    console.warn(`[HostFsService] Error reading host file ${hostFilePath} via Docker helper:`, err);
  }

  return null;
}

/**
 * Writes a text file directly to the host filesystem.
 */
export async function writeHostFile(hostFilePath: string, content: string): Promise<boolean> {
  const localCandidate = resolveContainerPath(hostFilePath);
  const localParent = path.dirname(localCandidate);

  // 1. Attempt direct FS write if directory is writable
  try {
    if (fs.existsSync(localParent) || fs.existsSync(localCandidate)) {
      if (!fs.existsSync(localParent)) {
        fs.mkdirSync(localParent, { recursive: true });
      }
      fs.writeFileSync(localCandidate, content, 'utf8');
      if (fs.existsSync(localCandidate) && fs.statSync(localCandidate).size > 0) {
        return true;
      }
    }
  } catch {
    // proceed to Docker helper write
  }

  // 2. Docker Engine helper execution
  try {
    const parentDir = path.dirname(hostFilePath);
    const fileName = path.basename(hostFilePath);
    const helperImage = await getBestAvailableImage();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: [
        'sh',
        '-c',
        `mkdir -p /target_dir && printf '%s' "$FILE_DATA" > "/target_dir/${fileName}" && sync && [ -s "/target_dir/${fileName}" ]`,
      ],
      Env: [`FILE_DATA=${content}`],
      HostConfig: {
        Binds: [`${parentDir}:/target_dir:rw`],
      },
    });

    if (runner && runner.Id) {
      await queryDockerEngine(`/containers/${runner.Id}/start`, 'POST');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const waitRes = await queryDockerEngine<any>(`/containers/${runner.Id}/wait`, 'POST');
      await queryDockerEngine(`/containers/${runner.Id}?force=true`, 'DELETE');
      return waitRes && waitRes.StatusCode === 0;
    }
  } catch (err) {
    console.error(`[HostFsService] Error writing host file ${hostFilePath}:`, err);
  }

  return false;
}

/**
 * Checks if a file exists on the host.
 */
export async function checkHostFileExists(hostFilePath: string): Promise<boolean> {
  const localCandidate = resolveContainerPath(hostFilePath);
  if (fs.existsSync(localCandidate)) {
    return true;
  }

  try {
    const parentDir = path.dirname(hostFilePath);
    const fileName = path.basename(hostFilePath);
    const helperImage = await getBestAvailableImage();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: ['sh', '-c', `[ -f "/target_dir/${fileName}" ]`],
      HostConfig: {
        Binds: [`${parentDir}:/target_dir:ro`],
      },
    });

    if (runner && runner.Id) {
      await queryDockerEngine(`/containers/${runner.Id}/start`, 'POST');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const waitRes = await queryDockerEngine<any>(`/containers/${runner.Id}/wait`, 'POST');
      await queryDockerEngine(`/containers/${runner.Id}?force=true`, 'DELETE');
      return waitRes && waitRes.StatusCode === 0;
    }
  } catch {
    // ignore
  }

  return false;
}

/**
 * Creates a directory on the host with elevated privileges.
 */
export async function createHostDirectory(hostDirPath: string): Promise<boolean> {
  const localCandidate = resolveContainerPath(hostDirPath);
  try {
    if (fs.existsSync(localCandidate)) {
      return true;
    }
    fs.mkdirSync(localCandidate, { recursive: true });
    return true;
  } catch {
    // Proceed to root helper container
  }

  try {
    const parentDir = path.dirname(hostDirPath);
    const helperImage = await getBestAvailableImage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: ['sh', '-c', `mkdir -p "${hostDirPath}" && chmod 755 "${hostDirPath}"`],
      HostConfig: {
        Binds: [`${parentDir}:${parentDir}:rw`],
      },
    });

    if (runner && runner.Id) {
      await queryDockerEngine(`/containers/${runner.Id}/start`, 'POST');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const waitRes = await queryDockerEngine<any>(`/containers/${runner.Id}/wait`, 'POST');
      await queryDockerEngine(`/containers/${runner.Id}?force=true`, 'DELETE');
      return waitRes && waitRes.StatusCode === 0;
    }
  } catch (err) {
    console.error(`[HostFsService] Error creating host directory ${hostDirPath}:`, err);
  }

  return false;
}

/**
 * Recursively removes a directory on the host (used for clean rollback of provisioned new stacks)
 */
export async function removeHostDirectory(hostDirPath: string): Promise<boolean> {
  // Safety guard: NEVER allow deleting critical root or top-level system folders
  const forbidden = ['/', '/home', '/etc', '/var', '/usr', '/bin', '/root', '/app', '/home/ryan', '/home/ubuntu'];
  const normalized = path.resolve(hostDirPath);
  if (forbidden.includes(normalized) || normalized.split(path.sep).filter(Boolean).length < 2) {
    console.warn(`[HostFsService] Refusing to delete protected system path: ${normalized}`);
    return false;
  }

  const localCandidate = resolveContainerPath(hostDirPath);
  try {
    if (fs.existsSync(localCandidate)) {
      fs.rmSync(localCandidate, { recursive: true, force: true });
      return true;
    }
  } catch {
    // proceed to helper container
  }

  try {
    const parentDir = path.dirname(hostDirPath);
    const helperImage = await getBestAvailableImage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: ['sh', '-c', `rm -rf "${hostDirPath}"`],
      HostConfig: {
        Binds: [`${parentDir}:${parentDir}:rw`],
      },
    });

    if (runner && runner.Id) {
      await queryDockerEngine(`/containers/${runner.Id}/start`, 'POST');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const waitRes = await queryDockerEngine<any>(`/containers/${runner.Id}/wait`, 'POST');
      await queryDockerEngine(`/containers/${runner.Id}?force=true`, 'DELETE');
      return waitRes && waitRes.StatusCode === 0;
    }
  } catch (err) {
    console.error(`[HostFsService] Error removing host directory ${hostDirPath}:`, err);
  }

  return false;
}

/**
 * Directive 1: Root-Level Elevated Docker Compose Execution
 * Runs docker compose command with root privileges and non-blocking TTY execution
 */
export async function runHostDockerCompose(
  targetDir: string,
  composeArgs: string
): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
  try {
    const helperImage = await getBestAvailableImage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: [
        'sh',
        '-c',
        `cd "${targetDir}" && (docker compose ${composeArgs} 2>&1 || docker-compose ${composeArgs} 2>&1 || true)`,
      ],
      HostConfig: {
        Binds: [
          `${DOCKER_SOCKET_PATH}:/var/run/docker.sock`,
          `${targetDir}:${targetDir}:rw`,
        ],
      },
    });

    if (runner && runner.Id) {
      await queryDockerEngine(`/containers/${runner.Id}/start`, 'POST');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const waitRes = await queryDockerEngine<any>(`/containers/${runner.Id}/wait`, 'POST');
      const rawLogs = await queryDockerEngine<string>(`/containers/${runner.Id}/logs?stdout=1&stderr=1`, 'GET');
      const cleanLogs = cleanDockerLogs(rawLogs);
      await queryDockerEngine(`/containers/${runner.Id}?force=true`, 'DELETE');

      const exitCode = waitRes ? waitRes.StatusCode : 0;
      return {
        success: exitCode === 0,
        stdout: cleanLogs,
        stderr: exitCode !== 0 ? cleanLogs : '',
        exitCode,
      };
    }
  } catch (err) {
    console.error(`[HostFsService] Error running docker compose in ${targetDir}:`, err);
  }

  return {
    success: false,
    stdout: '',
    stderr: 'Failed to dispatch command to Docker daemon',
    exitCode: 1,
  };
}

/**
 * Resolves default home directory base path for new stacks (e.g. /home/ryan or /home/$USER)
 */
export function resolveDefaultHostHome(existingWorkingDirs?: string[]): string {
  if (existingWorkingDirs && existingWorkingDirs.length > 0) {
    for (const d of existingWorkingDirs) {
      const match = d.match(/^(\/home\/[^/]+)/);
      if (match) return match[1];
    }
  }

  if (process.env.HOST_HOME) return process.env.HOST_HOME;
  if (process.env.USER && process.env.USER !== 'root') return `/home/${process.env.USER}`;
  return '/home/ryan';
}

/**
 * Removes lingering conflicting containers by name or ID directly via Docker socket

 */
export async function forceRemoveContainer(containerNameOrId: string): Promise<boolean> {
  try {
    const clean = containerNameOrId.replace(/^\//, '');
    await queryDockerEngine(`/containers/${encodeURIComponent(clean)}?force=true&v=false`, 'DELETE');
    return true;
  } catch {
    return false;
  }
}

/**
 * Cleans multiplexed Docker stream header bytes from stdout string
 */
function cleanDockerLogs(raw: string | unknown): string {
  if (typeof raw !== 'string') return '';
  // If the log starts with Docker multiplex header (header is 8 bytes per frame)
  // Check if character codes at index 0..7 contain control bytes
  if (raw.length > 8 && raw.charCodeAt(0) <= 2 && raw.charCodeAt(1) === 0 && raw.charCodeAt(2) === 0) {
    // Strip headers
    let cleaned = '';
    let pos = 0;
    while (pos < raw.length) {
      if (pos + 8 > raw.length) break;
      const size = (raw.charCodeAt(pos + 4) << 24) |
                   (raw.charCodeAt(pos + 5) << 16) |
                   (raw.charCodeAt(pos + 6) << 8) |
                   raw.charCodeAt(pos + 7);
      pos += 8;
      cleaned += raw.substring(pos, pos + size);
      pos += size;
    }
    return cleaned || raw.substring(8);
  }
  return raw;
}
