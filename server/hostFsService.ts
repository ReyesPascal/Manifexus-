import fs from 'fs';
import path from 'path';
import net from 'net';
import yaml from 'yaml';
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
 * Writes a text file directly to the host filesystem with strict fsync and write-ahead validation.
 */
export async function writeHostFile(hostFilePath: string, content: string): Promise<boolean> {
  const localCandidate = resolveContainerPath(hostFilePath);
  const localParent = path.dirname(localCandidate);

  // 1. Attempt direct FS write if directory is writable, with fsyncSync
  try {
    if (fs.existsSync(localParent) || fs.existsSync(localCandidate)) {
      if (!fs.existsSync(localParent)) {
        fs.mkdirSync(localParent, { recursive: true });
      }
      const fd = fs.openSync(localCandidate, 'w');
      fs.writeSync(fd, content, 0, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      if (fs.existsSync(localCandidate) && fs.statSync(localCandidate).size > 0) {
        return true;
      }
    }
  } catch {
    // proceed to Docker helper write
  }

  // 2. Docker Engine helper execution with base64 encoding to prevent shell escaping corruption
  try {
    const parentDir = path.dirname(hostFilePath);
    const fileName = path.basename(hostFilePath);
    const helperImage = await getBestAvailableImage();
    const base64Content = Buffer.from(content, 'utf8').toString('base64');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: [
        'sh',
        '-c',
        `mkdir -p /target_dir && echo "$FILE_B64" | base64 -d > "/target_dir/${fileName}" && sync && [ -s "/target_dir/${fileName}" ]`,
      ],
      Env: [`FILE_B64=${base64Content}`],
      HostConfig: {
        Binds: [`${parentDir}:/target_dir:rw`],
      },
    });

    if (runner && runner.Id) {
      await queryDockerEngine(`/containers/${runner.Id}/start`, 'POST');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const waitRes = await queryDockerEngine<any>(`/containers/${runner.Id}/wait`, 'POST', undefined, 120000);
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

export interface HostDockerComposeResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  commandExecuted: string;
  cwd: string;
}

/**
 * Directive 1 & 2: Root-Level Elevated Docker Compose Execution
 * Runs docker compose command with explicit -f compose file path, cwd explicitly set to targetDir,
 * root privileges, and awaits complete resolution without silent suppression.
 */
export async function runHostDockerCompose(
  targetDir: string,
  composeArgs: string,
  composeFilePath?: string
): Promise<HostDockerComposeResult> {
  const explicitComposeFile = composeFilePath || path.join(targetDir, 'docker-compose.yml');
  const executedCommand = `docker compose -f "${explicitComposeFile}" ${composeArgs}`;

  try {
    const helperImage = await getBestAvailableImage();
    const script = `
set -e
cd "${targetDir}"
export COMPOSE_FILE="${explicitComposeFile}"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose -f "${explicitComposeFile}" ${composeArgs}
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose -f "${explicitComposeFile}" ${composeArgs}
else
  docker compose -f "${explicitComposeFile}" ${composeArgs}
fi
`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: ['sh', '-c', script],
      WorkingDir: targetDir,
      HostConfig: {
        Binds: [
          `${DOCKER_SOCKET_PATH}:/var/run/docker.sock`,
          `${targetDir}:${targetDir}:rw`,
        ],
      },
    });

    if (runner && runner.Id) {
      await queryDockerEngine(`/containers/${runner.Id}/start`, 'POST');
      // Directive 2 & 3: Strict await with extended 180s timeout threshold
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const waitRes = await queryDockerEngine<any>(`/containers/${runner.Id}/wait`, 'POST', undefined, 180000);
      const rawLogs = await queryDockerEngine<string>(`/containers/${runner.Id}/logs?stdout=1&stderr=1`, 'GET');
      const cleanLogs = cleanDockerLogs(rawLogs);
      await queryDockerEngine(`/containers/${runner.Id}?force=true`, 'DELETE');

      const exitCode = waitRes ? waitRes.StatusCode : 0;
      return {
        success: exitCode === 0,
        stdout: cleanLogs,
        stderr: exitCode !== 0 ? cleanLogs : '',
        exitCode,
        commandExecuted: executedCommand,
        cwd: targetDir,
      };
    }
  } catch (err) {
    console.error(`[HostFsService] Error running docker compose in ${targetDir}:`, err);
    return {
      success: false,
      stdout: '',
      stderr: (err as Error).message || 'Execution failed',
      exitCode: 1,
      commandExecuted: executedCommand,
      cwd: targetDir,
    };
  }

  return {
    success: false,
    stdout: '',
    stderr: 'Failed to dispatch command to Docker daemon',
    exitCode: 1,
    commandExecuted: executedCommand,
    cwd: targetDir,
  };
}

/**
 * Resolves default home directory base path for new stacks (generic fallback)
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
  return '/opt/stacks';
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
export function cleanDockerLogs(raw: string | unknown): string {
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

/**
 * Actively tests whether a host network port is genuinely free and unallocated.
 */
export function isHostPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (port <= 0 || port > 65535) {
      resolve(false);
      return;
    }
    const server = net.createServer();
    server.unref();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, '0.0.0.0');
  });
}

/**
 * Creates a host directory and sets aggressive permissions (e.g. 777) so container non-root daemons cannot be denied access.
 */
export async function createHostDirectoryWithPermissions(
  hostDirPath: string,
  mode: string = '777'
): Promise<boolean> {
  const localCandidate = resolveContainerPath(hostDirPath);
  try {
    if (!fs.existsSync(localCandidate)) {
      fs.mkdirSync(localCandidate, { recursive: true });
    }
    fs.chmodSync(localCandidate, 0o777);
  } catch {
    // proceed to root helper container
  }

  try {
    const parentDir = path.dirname(hostDirPath);
    const helperImage = await getBestAvailableImage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: ['sh', '-c', `mkdir -p "${hostDirPath}" && chmod -R ${mode} "${hostDirPath}"`],
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
    console.error(`[HostFsService] Error creating host volume directory ${hostDirPath}:`, err);
  }

  return true;
}

/**
 * Module 1: Pre-Flight Environment Initialization
 * Parses the Compose YAML, locates all host-bound volume directories, forcefully creates them via mkdir -p,
 * and applies aggressive read/write permissions (chmod -R 777) so container daemons (e.g. utorrent UID 1000)
 * cannot reject mounts or crash due to permission denial.
 */
export async function ensureHostVolumeDirectories(
  targetDirectory: string,
  composeYaml: string,
  log?: (msg: string) => void
): Promise<string[]> {
  const ensuredDirs: string[] = [];
  try {
    const doc = yaml.parse(composeYaml);
    if (!doc || !doc.services || typeof doc.services !== 'object') {
      return [];
    }

    const hostPaths = new Set<string>();

    for (const [, svcConfig] of Object.entries(doc.services)) {
      if (!svcConfig || typeof svcConfig !== 'object') continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const volumes = (svcConfig as any).volumes;
      if (!Array.isArray(volumes)) continue;

      for (const vol of volumes) {
        let hostSource: string | undefined;

        if (typeof vol === 'string') {
          // Short format: "source:target:opts" or "source:target"
          const parts = vol.split(':');
          if (parts.length >= 2) {
            hostSource = parts[0].trim();
          }
        } else if (typeof vol === 'object' && vol !== null) {
          // Long format: { type: 'bind', source: './data', target: '/data' }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const vObj = vol as any;
          if (vObj.type === 'bind' || vObj.source) {
            hostSource = vObj.source;
          }
        }

        if (!hostSource) continue;

        // Skip named volumes without slashes or dots (e.g. "db_data")
        if (
          !hostSource.startsWith('/') &&
          !hostSource.startsWith('.') &&
          !hostSource.startsWith('~') &&
          !hostSource.includes('/')
        ) {
          continue;
        }

        // Expand variables like ${PWD}
        hostSource = hostSource.replace(/\$\{PWD\}/g, targetDirectory);
        hostSource = hostSource.replace(/\$PWD\b/g, targetDirectory);

        // Skip device mounts or well-known system files
        const systemFiles = [
          '/var/run/docker.sock',
          '/etc/localtime',
          '/etc/timezone',
          '/dev/net/tun',
        ];
        if (systemFiles.includes(hostSource)) continue;

        // Skip file extensions
        const fileExts = ['.conf', '.cnf', '.ini', '.yaml', '.yml', '.json', '.xml', '.toml', '.txt', '.sock', '.db', '.sqlite'];
        if (fileExts.some((ext) => hostSource!.toLowerCase().endsWith(ext))) {
          continue;
        }

        // Resolve absolute host path
        let absHostPath = hostSource;
        if (absHostPath.startsWith('~')) {
          absHostPath = path.join('/home/ubuntu', absHostPath.slice(1));
        } else if (!path.isAbsolute(absHostPath)) {
          absHostPath = path.resolve(targetDirectory, absHostPath);
        }

        hostPaths.add(absHostPath);
      }
    }

    for (const hostDir of hostPaths) {
      if (log) log(`Pre-Flight: Initializing host volume directory with 777 permissions: ${hostDir}`);
      await createHostDirectoryWithPermissions(hostDir, '777');
      ensuredDirs.push(hostDir);
    }
  } catch (err) {
    if (log) log(`Pre-Flight volume directory scan note: ${(err as Error).message}`);
  }

  return ensuredDirs;
}

/**
 * Module 1: Dynamic .env injection
 * Parses required environment variables from remote Compose file and injects safe defaults into target .env
 */
export async function detectAndInjectEnvVariables(
  targetDirectory: string,
  composeYaml: string,
  buildContextDir?: string,
  log?: (msg: string) => void
): Promise<Record<string, string>> {
  const injected: Record<string, string> = {};
  const envFilePath = path.join(targetDirectory, '.env');
  const existingEnvContent = (await readHostFile(envFilePath)) || '';
  const existingKeys = new Set<string>();

  for (const line of existingEnvContent.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) existingKeys.add(match[1]);
  }

  // Check if .env.example exists in buildContextDir or targetDirectory
  let exampleContent = '';
  if (buildContextDir) {
    const examplePath = path.join(buildContextDir, '.env.example');
    exampleContent = (await readHostFile(examplePath)) || '';
  }
  if (!exampleContent) {
    const targetExamplePath = path.join(targetDirectory, '.env.example');
    exampleContent = (await readHostFile(targetExamplePath)) || '';
  }

  if (exampleContent) {
    for (const line of exampleContent.split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) {
        const key = match[1];
        let val = match[2].trim().replace(/^['"]|['"]$/g, '');
        if (!existingKeys.has(key)) {
          if (key === 'PUID' || key === 'UID') val = val || '1000';
          if (key === 'PGID' || key === 'GID') val = val || '1000';
          if (key === 'TZ') val = val || 'Etc/UTC';
          injected[key] = val;
        }
      }
    }
  }

  // Parse any required variables from Compose YAML: ${VARIABLE} or ${VARIABLE:-default}
  const varRegex = /\$\{([A-Za-z0-9_]+)(?::?[-?]([^}]*))?\}/g;
  let m: RegExpExecArray | null;
  while ((m = varRegex.exec(composeYaml)) !== null) {
    const key = m[1];
    const defaultVal = m[2] !== undefined ? m[2] : '';
    if (!existingKeys.has(key) && !injected[key]) {
      let resolvedVal = defaultVal;
      if (!resolvedVal) {
        if (key === 'PUID' || key === 'UID') resolvedVal = '1000';
        else if (key === 'PGID' || key === 'GID') resolvedVal = '1000';
        else if (key === 'TZ') resolvedVal = 'Etc/UTC';
        else if (key.toLowerCase().includes('port')) resolvedVal = '8080';
        else resolvedVal = 'default';
      }
      injected[key] = resolvedVal;
    }
  }

  if (Object.keys(injected).length > 0) {
    let newContent = existingEnvContent
      ? `${existingEnvContent.trim()}\n\n# Automatically injected by Manifexus\n`
      : '# Automatically injected by Manifexus\n';
    for (const [k, v] of Object.entries(injected)) {
      newContent += `${k}=${v}\n`;
    }
    await writeHostFile(envFilePath, newContent);
    if (log) {
      log(`Environment Injection: Configured ${Object.keys(injected).length} variable(s) in ${envFilePath} (${Object.keys(injected).join(', ')})`);
    }
  }

  return injected;
}
