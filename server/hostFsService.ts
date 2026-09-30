import fs from 'fs';
import os from 'os';
import path from 'path';
import { queryDockerEngine, getBestAvailableImage } from './dockerService';
import { record } from './activityLog';

const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';

interface SelfMount {
  source: string;
  destination: string;
}

/**
 * How host paths map into this process's filesystem.
 *   undefined -> not known yet (treat nothing as local; use helper containers)
 *   null      -> not running in a container: host paths ARE local paths
 *   array     -> running in a container: only paths under these bind mounts are local
 */
let selfMounts: SelfMount[] | null | undefined;

/**
 * Loads this container's bind mounts from Docker, so host paths are only read or written directly
 * when they really are mounted from the host. Without this, a missing mount made Manifexus create
 * "stack folders" inside its own container filesystem, invisible on the host and gone after an update.
 */
export async function refreshSelfMounts(): Promise<void> {
  if (!fs.existsSync('/.dockerenv') && !fs.existsSync('/run/.containerenv')) {
    selfMounts = null;
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = await queryDockerEngine<any>(`/containers/${os.hostname()}/json`, 'GET');
    selfMounts = ((info?.Mounts || []) as { Type?: string; Source?: string; Destination?: string }[])
      .filter((m) => m.Type === 'bind' && m.Source && m.Destination)
      .map((m) => ({ source: path.posix.normalize(m.Source!), destination: path.posix.normalize(m.Destination!) }))
      // Longest source first so the most specific mount wins
      .sort((a, b) => b.source.length - a.source.length);
  } catch {
    // Keep the previous answer; if we never got one, stay on the safe side (helpers only)
  }
}

/**
 * Returns where a host path can be reached directly from this process, or null if it can't
 * (callers then go through a helper container, which always sees the real host).
 */
export function resolveContainerPath(hostPath: string): string | null {
  const p = path.posix.normalize(hostPath);
  if (selfMounts === null) return p;
  if (!selfMounts) return null;
  for (const m of selfMounts) {
    if (m.source === '/') return path.posix.join(m.destination, p);
    if (p === m.source || p.startsWith(m.source + '/')) {
      return path.posix.join(m.destination, p.slice(m.source.length));
    }
  }
  return null;
}

/**
 * Reads a text file from the host filesystem.
 * If Manifexus does not have the host mounted directly, it uses the Docker socket helper container
 * to read the exact host file with zero container filesystem barriers.
 */
async function readHostFileImpl(hostFilePath: string): Promise<string | null> {
  // 1. Direct filesystem check
  const localCandidate = resolveContainerPath(hostFilePath);
  if (localCandidate && fs.existsSync(localCandidate)) {
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
    // Mount the folder *above* the file's folder: binding a folder that doesn't exist makes Docker
    // create it on the host, which would leave empty folders behind (and make a deleted stack look present)
    const parentDir = path.posix.dirname(hostFilePath);
    const grandParent = path.posix.dirname(parentDir);
    const rel = path.posix.join(path.posix.basename(parentDir), path.posix.basename(hostFilePath)).replace(/'/g, `'\\''`);
    const helperImage = await getBestAvailableImage();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: ['sh', '-c', `if [ -f '/target_root/${rel}' ]; then cat '/target_root/${rel}'; else exit 44; fi`],
      HostConfig: {
        Binds: [`${grandParent}:/target_root:ro`],
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
async function writeHostFileImpl(hostFilePath: string, content: string): Promise<boolean> {
  const localCandidate = resolveContainerPath(hostFilePath);
  const localParent = localCandidate ? path.dirname(localCandidate) : null;

  // 1. Attempt direct FS write, only when the path is really mounted from the host
  try {
    if (localCandidate && localParent && (fs.existsSync(localParent) || fs.existsSync(localCandidate))) {
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
 * Provisions a directory on the host filesystem, bypassing container isolation.
 */
async function createHostDirectoryImpl(hostDirPath: string): Promise<boolean> {
  const localCandidate = resolveContainerPath(hostDirPath);
  try {
    if (localCandidate) {
      if (fs.existsSync(localCandidate)) {
        return true;
      }
      fs.mkdirSync(localCandidate, { recursive: true });
      if (fs.existsSync(localCandidate)) {
        return true;
      }
    }
  } catch {
    // Proceed to Docker Engine helper
  }

  try {
    const parentDir = path.dirname(hostDirPath);
    const dirName = path.basename(hostDirPath);
    const helperImage = await getBestAvailableImage();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: ['sh', '-c', `mkdir -p "/target_parent/${dirName}" && sync`],
      HostConfig: {
        Binds: [`${parentDir}:/target_parent:rw`],
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
    console.warn(`[HostFsService] Error creating host directory ${hostDirPath}:`, err);
  }

  return false;
}

/**
 * Checks if a file exists on the host.
 */
async function checkHostFileExistsImpl(hostFilePath: string): Promise<boolean> {
  const localCandidate = resolveContainerPath(hostFilePath);
  if (localCandidate && fs.existsSync(localCandidate)) {
    return true;
  }

  try {
    // Mount the folder above, so checking never creates the file's folder on the host
    const parentDir = path.posix.dirname(hostFilePath);
    const grandParent = path.posix.dirname(parentDir);
    const rel = path.posix.join(path.posix.basename(parentDir), path.posix.basename(hostFilePath)).replace(/'/g, `'\\''`);
    const helperImage = await getBestAvailableImage();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: ['sh', '-c', `[ -f '/target_root/${rel}' ]`],
      HostConfig: {
        Binds: [`${grandParent}:/target_root:ro`],
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
 * Deletes a directory and its contents from the host filesystem.
 */
async function deleteHostDirectoryImpl(hostDirPath: string): Promise<boolean> {
  const normalized = path.posix.normalize(hostDirPath.trim());
  if (['/', '/home', '/root', '/etc', '/var', '/usr'].includes(normalized)) {
    throw new Error(`Refusing to delete critical root directory: ${normalized}`);
  }

  const localCandidate = resolveContainerPath(hostDirPath);
  try {
    if (localCandidate && fs.existsSync(localCandidate)) {
      fs.rmSync(localCandidate, { recursive: true, force: true });
      if (!fs.existsSync(localCandidate)) {
        return true;
      }
    }
  } catch {
    // Proceed to Docker Engine helper
  }

  try {
    const parentDir = path.dirname(normalized);
    const dirName = path.basename(normalized);
    const helperImage = await getBestAvailableImage();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: ['sh', '-c', `rm -rf "/target_parent/${dirName}" && sync`],
      HostConfig: {
        Binds: [`${parentDir}:/target_parent:rw`],
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
    console.warn(`[HostFsService] Error deleting host directory ${hostDirPath}:`, err);
  }

  return false;
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

// ----------------------------------------------------------------------------
// Recorded entry points: every host file operation shows up in the activity log
// ----------------------------------------------------------------------------

const how = (p: string) => (resolveContainerPath(p) ? 'direct' : 'helper container');

export async function readHostFile(hostFilePath: string): Promise<string | null> {
  const t = Date.now();
  const text = await readHostFileImpl(hostFilePath);
  record('trace', 'file', `Read ${hostFilePath} → ${text === null ? 'not found' : `${text.length} bytes`}`, {
    path: hostFilePath,
    via: how(hostFilePath),
    found: text !== null,
    bytes: text?.length,
    content: text && text.length <= 64 * 1024 ? text : undefined,
  }, { durationMs: Date.now() - t });
  return text;
}

export async function writeHostFile(hostFilePath: string, content: string): Promise<boolean> {
  const t = Date.now();
  const ok = await writeHostFileImpl(hostFilePath, content);
  forgetHostComposeFolders();
  record(ok ? 'info' : 'warn', 'file', `${ok ? 'Wrote' : 'Could not write'} ${hostFilePath} (${content.length} bytes)`, {
    path: hostFilePath,
    via: how(hostFilePath),
    ok,
    bytes: content.length,
    content,
  }, { durationMs: Date.now() - t });
  return ok;
}

export async function createHostDirectory(hostDirPath: string): Promise<boolean> {
  const t = Date.now();
  const ok = await createHostDirectoryImpl(hostDirPath);
  forgetHostComposeFolders();
  record(ok ? 'debug' : 'warn', 'file', `${ok ? 'Folder ready' : 'Could not create folder'}: ${hostDirPath}`, { path: hostDirPath, via: how(hostDirPath), ok }, { durationMs: Date.now() - t });
  return ok;
}

export async function checkHostFileExists(hostFilePath: string): Promise<boolean> {
  const ok = await checkHostFileExistsImpl(hostFilePath);
  record('trace', 'file', `${hostFilePath} ${ok ? 'exists' : 'does not exist'}`, { path: hostFilePath, exists: ok });
  return ok;
}

export async function deleteHostDirectory(hostDirPath: string): Promise<boolean> {
  const t = Date.now();
  const ok = await deleteHostDirectoryImpl(hostDirPath);
  forgetHostComposeFolders();
  record(ok ? 'info' : 'warn', 'file', `${ok ? 'Deleted folder' : 'Could not delete folder'} ${hostDirPath}`, { path: hostDirPath, via: how(hostDirPath), ok }, { durationMs: Date.now() - t });
  return ok;
}

// ----------------------------------------------------------------------------
// Finding stack folders on the host that Manifexus can't see directly
// ----------------------------------------------------------------------------

export interface HostComposeFile {
  /** The stack's folder name (e.g. "usenet-stack") */
  dir: string;
  /** docker-compose.yml, compose.yaml, … */
  file: string;
  content: string;
}

const COMPOSE_NAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const MARK = '@@MFX-COMPOSE@@';

/**
 * Lists the compose files one level down in a host folder (each stack's folder), through a short-lived
 * read-only helper container. Used when the folder isn't mounted into Manifexus, which is the usual
 * install: without it, a stack whose apps are all gone (moved away, or taken down) would vanish from
 * the dashboard even though its folder is still there.
 */
export async function scanHostComposeFolders(baseDir: string): Promise<HostComposeFile[] | null> {
  const base = path.posix.normalize(baseDir).replace(/\/+$/, '');
  if (!base || base === '/' || !base.startsWith('/')) return null;
  // Mount the folder above, so a folder that doesn't exist is never created on the host
  const parent = path.posix.dirname(base);
  const name = path.posix.basename(base).replace(/'/g, `'\\''`);
  const names = COMPOSE_NAMES.join(' ');
  const script =
    `cd '/p/${name}' 2>/dev/null || exit 44; ` +
    `for d in */; do d="\${d%/}"; case "$d" in .*|node_modules|'*') continue;; esac; ` +
    `for f in ${names}; do if [ -f "$d/$f" ]; then printf '\\n${MARK}%s/%s\\n' "$d" "$f"; head -c 262144 "$d/$f"; break; fi; done; done`;
  try {
    const helperImage = await getBestAvailableImage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: ['sh', '-c', script],
      Tty: true,
      Labels: { 'manifexus.helper': 'scan' },
      HostConfig: { Binds: [`${parent}:/p:ro`], NetworkMode: 'none' },
    });
    if (!runner?.Id) return null;
    try {
      await queryDockerEngine(`/containers/${runner.Id}/start`, 'POST');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const waitRes = await queryDockerEngine<any>(`/containers/${runner.Id}/wait`, 'POST');
      if (!waitRes || waitRes.StatusCode !== 0) return waitRes?.StatusCode === 44 ? [] : null;
      const raw = cleanDockerLogs(await queryDockerEngine<string>(`/containers/${runner.Id}/logs?stdout=1`, 'GET')).replace(/\r\n/g, '\n');
      const out: HostComposeFile[] = [];
      for (const part of raw.split(`\n${MARK}`).slice(1)) {
        const nl = part.indexOf('\n');
        const rel = part.slice(0, nl < 0 ? undefined : nl).trim();
        const slash = rel.lastIndexOf('/');
        if (slash <= 0) continue;
        out.push({ dir: rel.slice(0, slash), file: rel.slice(slash + 1), content: nl < 0 ? '' : part.slice(nl + 1) });
      }
      return out;
    } finally {
      await queryDockerEngine(`/containers/${runner.Id}?force=true`, 'DELETE').catch(() => undefined);
    }
  } catch (err) {
    console.warn(`[HostFsService] Couldn't look for stacks in ${base}:`, err);
    return null;
  }
}

/**
 * Stack folders found through the helper, per folder. Kept for a short while so the dashboard (which asks
 * every few seconds) doesn't start a helper each time: an answer older than FRESH_MS is refreshed in the
 * background, and the very first look waits a moment for it.
 */
const FRESH_MS = 30_000;
const scanCache = new Map<string, { at: number; files: HostComposeFile[]; running?: Promise<void> }>();

function forgetHostComposeFolders(): void {
  for (const v of scanCache.values()) v.at = 0;
}

export async function hostComposeFolders(baseDir: string): Promise<HostComposeFile[]> {
  let entry = scanCache.get(baseDir);
  if (!entry) {
    entry = { at: 0, files: [] };
    scanCache.set(baseDir, entry);
  }
  const e = entry;
  if (Date.now() - e.at > FRESH_MS && !e.running) {
    e.running = scanHostComposeFolders(baseDir)
      .then((files) => {
        if (files) e.files = files;
        e.at = Date.now();
      })
      .finally(() => {
        e.running = undefined;
      });
  }
  // The first time, wait (briefly) so stacks don't appear a few seconds late
  if (e.running && e.at === 0) {
    await Promise.race([e.running, new Promise((r) => setTimeout(r, 5000))]);
  }
  return e.files;
}

