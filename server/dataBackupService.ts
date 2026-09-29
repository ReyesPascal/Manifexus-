/**
 * Data Backup Service
 *
 * Archives the *data* a stack owns — not just its compose file — so destructive operations
 * (stack delete, moving apps between stacks) can be undone for real.
 *
 * What counts as a stack's data:
 *   1. Its working directory on the host (compose file, .env, and any ./config, ./data, ... folders
 *      bind-mounted from inside it).
 *   2. Named volumes Docker Compose created for the project (label com.docker.compose.project=<name>).
 *      These are exactly the volumes `docker compose down -v` removes.
 *
 * Bind mounts that point OUTSIDE the stack directory (e.g. /mnt/media) are never deleted by
 * Manifexus, so they are reported but not archived.
 *
 * How it works: Manifexus cannot see host paths directly, so every read/write of host data runs in a
 * short-lived helper container (the Manifexus image, which ships tar/du). The helper borrows
 * Manifexus's own volumes (VolumesFrom) so it can write archives straight into /app/backups.
 * Helpers are polled rather than awaited through /wait, because the Docker API client has a 10s
 * socket timeout and archiving real data takes longer than that.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { queryDockerEngine, getBestAvailableImage, fetchContainerLogs } from './dockerService';
import { record } from './activityLog';
import { resolveBackupDir } from './historyService';

export interface DataArchiveEntry {
  kind: 'directory' | 'volume';
  /** Host directory path, or Docker volume name */
  source: string;
  /** Archive file path inside the Manifexus container (under the backups dir) */
  archiveFile: string;
  bytes: number;
  /** For volumes: labels/driver so the volume can be recreated identically on restore */
  volumeLabels?: Record<string, string>;
  volumeDriver?: string;
}

export interface StackDataFootprint {
  project: string;
  workingDir?: string;
  directoryBytes: number;
  volumes: { name: string; bytes: number }[];
  /** Bind mounts outside the stack directory: left untouched, listed for transparency */
  externalMounts: string[];
  totalBytes: number;
}

const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const POLL_INTERVAL_MS = 1000;
const DEFAULT_HELPER_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6h: large media folders can be slow

let cachedSelfId: string | null | undefined;

/**
 * Finds the Manifexus container itself so helpers can mount its /app/backups volume.
 * Returns null when Manifexus is not running inside Docker (local development).
 */
export async function getSelfContainerId(): Promise<string | null> {
  if (cachedSelfId !== undefined) return cachedSelfId;
  const backupDir = resolveBackupDir();

  // Docker sets the hostname to the short container id by default
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = await queryDockerEngine<any>(`/containers/${os.hostname()}/json`, 'GET');
    if (info && info.Id) {
      cachedSelfId = info.Id as string;
      return cachedSelfId;
    }
  } catch {
    // fall through
  }

  // Fallback: a running container that mounts our backups dir and looks like Manifexus
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = await queryDockerEngine<any[]>('/containers/json', 'GET');
    const match = (list || []).find(
      (c) =>
        (c.Mounts || []).some((m: { Destination?: string }) => m.Destination === backupDir) &&
        ((c.Names || []).some((n: string) => n.toLowerCase().includes('manifexus')) ||
          String(c.Image || '').toLowerCase().includes('manifexus'))
    );
    cachedSelfId = match ? (match.Id as string) : null;
  } catch {
    cachedSelfId = null;
  }
  return cachedSelfId;
}

/**
 * Runs a shell command in a helper container with the backups dir available at the same path
 * it has inside Manifexus. Returns the exit code. Throws if the helper cannot be started.
 */
async function runHelper(
  script: string,
  binds: string[],
  timeoutMs: number = DEFAULT_HELPER_TIMEOUT_MS,
  env: string[] = [],
  meta: { purpose: string; probe?: boolean } = { purpose: 'Helper container' }
): Promise<number> {
  return (await runHelperDetailed(script, binds, timeoutMs, env, meta)).code;
}

/** Like runHelper, but also returns everything the helper printed (stdout + stderr). */
async function runHelperDetailed(
  script: string,
  binds: string[],
  timeoutMs: number = DEFAULT_HELPER_TIMEOUT_MS,
  env: string[] = [],
  /** What this helper does, in plain words; `probe` helpers are low-detail and non-zero exits are expected */
  meta: { purpose: string; probe?: boolean; hostConfig?: Record<string, unknown> } = { purpose: 'Helper container' }
): Promise<{ code: number; output: string }> {
  const startedAt = Date.now();
  let captured = '';
  const image = await getBestAvailableImage();
  const backupDir = resolveBackupDir();
  const selfId = await getSelfContainerId();

  // json-file logging so the output can always be read back, whatever the daemon's default log driver is
  const hostConfig: Record<string, unknown> = { Binds: [...binds], LogConfig: { Type: 'json-file', Config: {} }, ...(meta.hostConfig || {}) };
  if (selfId) {
    hostConfig.VolumesFrom = [selfId];
  } else {
    // Not containerised: the backups dir and Docker socket are real host paths, bind them directly
    (hostConfig.Binds as string[]).push(`${backupDir}:${backupDir}`);
    (hostConfig.Binds as string[]).push(`${DOCKER_SOCKET_PATH}:/var/run/docker.sock`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const created = await queryDockerEngine<any>('/containers/create', 'POST', {
    Image: image,
    Entrypoint: [],
    User: '0:0', // must read/write files owned by any app user
    Cmd: ['sh', '-c', script],
    Env: env,
    HostConfig: hostConfig,
  });
  if (!created || !created.Id) {
    throw new Error('Could not create backup helper container');
  }

  const id = created.Id as string;
  let outputError: string | undefined;
  let exitCode: number | undefined;
  let timedOut = false;
  try {
    await queryDockerEngine(`/containers/${id}/start`, 'POST');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = await queryDockerEngine<any>(`/containers/${id}/json`, 'GET');
        if (state?.State && !state.State.Running) {
          const code: number = typeof state.State.ExitCode === 'number' ? state.State.ExitCode : 1;
          exitCode = code;
          const out = await fetchContainerLogs(id, 'all').catch(() => ({ stdout: '', stderr: '', combined: '', error: 'Couldn’t read the output' }));
          captured = out.combined;
          outputError = out.error;
          return { code, output: captured };
        }
      } catch {
        // transient API hiccup: keep polling until the deadline
      }
    }
    timedOut = true;
    throw new Error(`${meta.purpose} timed out`);
  } finally {
    // Keep a full record: what ran, where, and everything it printed
    const output: { combined: string; stderr?: string; error?: string } =
      captured || outputError
        ? { combined: captured, error: outputError }
        : await fetchContainerLogs(id, 'all').catch(() => ({ stdout: '', stderr: '', combined: '', error: 'Couldn’t read the output' }));
    const failed = timedOut || (exitCode !== undefined && exitCode !== 0);
    record(
      failed && !meta.probe ? 'warn' : meta.probe ? 'debug' : 'info',
      /compose/.test(meta.purpose) ? 'compose' : /back up|restore/i.test(meta.purpose) ? 'backup' : 'helper',
      `${meta.purpose} → ${timedOut ? 'timed out' : `exit ${exitCode}`}`,
      {
        purpose: meta.purpose,
        exitCode,
        timedOut,
        image,
        script,
        binds: hostConfig.Binds,
        env: env.map((e) => (e.length > 400 ? `${e.slice(0, 400)}… [${e.length - 400} more characters]` : e)),
        output: output.combined,
        stderr: output.stderr || undefined,
        outputError: output.error,
      },
      { durationMs: Date.now() - startedAt }
    );
    try {
      await queryDockerEngine(`/containers/${id}?force=true`, 'DELETE');
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Fetch an address the way the server itself sees it (host network), for when Manifexus's own
 * container can't reach an app (a firewall like UFW, or a separate Docker network). A short-lived
 * helper on the host's network downloads it into Manifexus's data folder; returns the bytes.
 */
export async function fetchOnHost(url: string, maxBytes = 1024 * 1024): Promise<Buffer | undefined> {
  const dir = path.join(fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data'), 'apps', '.fetch');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const q = shellQuote(url);
  const o = shellQuote(out);
  const script =
    `(node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(6000),redirect:"follow"}).then(async r=>{if(!r.ok&&r.status!==401)process.exit(2);require("fs").writeFileSync(process.argv[2],Buffer.from(await r.arrayBuffer()))}).catch(()=>process.exit(3))' ${q} ${o} 2>/dev/null)` +
    ` || wget -q -T 6 -O ${o} ${q} 2>/dev/null || curl -fsSL -m 6 -o ${o} ${q} 2>/dev/null; test -s ${o}`;
  try {
    const r = await runHelperDetailed(script, [], 30 * 1000, [], { purpose: `Read ${url} from the server`, probe: true, hostConfig: { NetworkMode: 'host' } });
    if (r.code !== 0 || !fs.existsSync(out)) return undefined;
    const buf = fs.readFileSync(out);
    return buf.length && buf.length <= maxBytes ? buf : undefined;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(out, { force: true });
  }
}

function tmpFile(label: string): string {
  const dir = path.join(resolveBackupDir(), '.tmp');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * tar script for archiving /src into `file`. GNU tar exits 1 when a file changed while being read
 * (normal for apps that keep running, e.g. logs); that is a warning, not a failed backup. Exit 2+
 * is a real error.
 */
function tarScript(file: string): string {
  const f = shellQuote(file);
  return `tar --warning=no-file-changed --warning=no-file-removed -C /src -czpf ${f} . ; rc=$?; [ $rc -le 1 ] && [ -s ${f} ]`;
}

/**
 * Deletes a host directory and waits for it to finish (large folders take longer than the Docker
 * API client's 10s timeout). Refuses obviously dangerous paths.
 */
export async function removeHostDirectory(hostDir: string): Promise<boolean> {
  const normalized = path.posix.normalize(hostDir.trim()).replace(/\/+$/, '');
  const forbidden = ['', '/', '/home', '/root', '/etc', '/var', '/usr', '/opt', '/mnt', '/srv', '/bin', '/boot', '/lib'];
  if (forbidden.includes(normalized) || normalized.split('/').filter(Boolean).length < 2) {
    throw new Error(`Refusing to delete ${normalized || '/'}`);
  }
  const parent = path.posix.dirname(normalized);
  const name = path.posix.basename(normalized);
  const code = await runHelper(`rm -rf /parent/${shellQuote(name)} && [ ! -e /parent/${shellQuote(name)} ]`, [
    `${parent}:/parent`,
  ], DEFAULT_HELPER_TIMEOUT_MS, [], { purpose: `Delete folder ${normalized}` });
  return code === 0;
}

export class StackFolderExistsError extends Error {}

/**
 * Creates a stack folder on the host and writes its compose file, owned by whoever owns the parent
 * folder (so the user can edit it without sudo). Verifies the file really landed on disk.
 * Refuses to overwrite an existing compose file unless `overwrite` is set.
 */
export async function provisionStackFolder(
  hostDir: string,
  composeText: string,
  opts: { overwrite?: boolean } = {}
): Promise<void> {
  const normalized = path.posix.normalize(hostDir.trim()).replace(/\/+$/, '');
  if (!normalized.startsWith('/') || normalized.split('/').filter(Boolean).length < 2) {
    throw new Error(`"${hostDir}" is not a valid folder for a stack.`);
  }
  const parent = path.posix.dirname(normalized);
  const name = shellQuote(path.posix.basename(normalized));
  const script = [
    `mkdir -p /parent/${name} || exit 20`,
    opts.overwrite
      ? ''
      : `for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do [ -e /parent/${name}/$f ] && exit 17; done`,
    `printf '%s' "$COMPOSE_DATA" > /parent/${name}/docker-compose.yml || exit 21`,
    // Match the owner of the parent folder (e.g. your user rather than root)
    `chown "$(stat -c %u:%g /parent)" /parent/${name} /parent/${name}/docker-compose.yml 2>/dev/null`,
    `[ -s /parent/${name}/docker-compose.yml ] || exit 22`,
  ]
    .filter(Boolean)
    .join('\n');
  const code = await runHelper(script, [`${parent}:/parent`], 2 * 60 * 1000, [`COMPOSE_DATA=${composeText}`], {
    purpose: `Write ${normalized}/docker-compose.yml`,
  });
  record(code === 0 ? 'info' : 'warn', 'file', code === 0 ? `Wrote ${normalized}/docker-compose.yml (${composeText.length} bytes)` : `Could not write ${normalized}/docker-compose.yml (exit ${code})`, {
    path: `${normalized}/docker-compose.yml`,
    exitCode: code,
    overwrite: Boolean(opts.overwrite),
    content: composeText,
  });
  if (code === 17) {
    throw new StackFolderExistsError(`${normalized} already has a compose file. Pick another name or folder.`);
  }
  if (code !== 0) {
    throw new Error(`Could not create ${normalized}/docker-compose.yml on the server (exit ${code}).`);
  }
}

/** Size in bytes of a host directory or a named volume (0 if missing). */
async function measure(bindSource: string): Promise<number> {
  const out = tmpFile('du');
  try {
    const code = await runHelper(
      `if [ -d /src ]; then du -sb /src | cut -f1 > ${shellQuote(out)}; else echo 0 > ${shellQuote(out)}; fi`,
      [`${bindSource}:/src:ro`],
      30 * 60 * 1000,
      [],
      { purpose: `Measure size of ${bindSource}`, probe: true }
    );
    if (code !== 0 || !fs.existsSync(out)) return 0;
    return parseInt(fs.readFileSync(out, 'utf8').trim(), 10) || 0;
  } finally {
    try {
      fs.unlinkSync(out);
    } catch {
      // ignore
    }
  }
}

/** Does a host directory exist? (checked through a helper, since Manifexus can't see host paths) */
export async function hostDirectoryExists(hostDir: string): Promise<boolean> {
  const parent = path.posix.dirname(hostDir);
  const name = path.posix.basename(hostDir);
  try {
    const code = await runHelper(`[ -d /parent/${shellQuote(name)} ]`, [`${parent}:/parent:ro`], 60 * 1000, [], {
      purpose: `Check folder ${hostDir} exists`,
      probe: true,
    });
    return code === 0;
  } catch {
    return false;
  }
}

/** Named volumes Compose created for a project — the ones `down -v` would remove. */
export async function getProjectVolumes(
  project: string
): Promise<{ name: string; labels: Record<string, string>; driver: string }[]> {
  try {
    const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await queryDockerEngine<any>(`/volumes?filters=${filters}`, 'GET');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (res?.Volumes || []).map((v: any) => ({
      name: v.Name as string,
      labels: (v.Labels || {}) as Record<string, string>,
      driver: (v.Driver || 'local') as string,
    }));
  } catch {
    return [];
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.posix.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel));
}

/**
 * Measures what a stack owns on disk. `bindMounts` are the host paths the stack's containers mount
 * (used only to report which ones live outside the stack directory).
 */
export async function getStackDataFootprint(params: {
  project: string;
  workingDir?: string;
  bindMounts?: string[];
  directoryExists?: boolean;
}): Promise<StackDataFootprint> {
  const { project, workingDir } = params;
  const dirExists = workingDir ? params.directoryExists ?? (await hostDirectoryExists(workingDir)) : false;
  const directoryBytes = workingDir && dirExists ? await measure(workingDir) : 0;

  const volumes: { name: string; bytes: number }[] = [];
  for (const v of await getProjectVolumes(project)) {
    volumes.push({ name: v.name, bytes: await measure(v.name) });
  }

  const externalMounts = Array.from(
    new Set((params.bindMounts || []).filter((m) => m && (!workingDir || !isInside(m, workingDir))))
  ).filter((m) => m !== '/var/run/docker.sock');

  return {
    project,
    workingDir,
    directoryBytes,
    volumes,
    externalMounts,
    totalBytes: directoryBytes + volumes.reduce((s, v) => s + v.bytes, 0),
  };
}

/** Free space available for backups, in bytes (null if unknown). */
export function getBackupFreeBytes(): number | null {
  try {
    const st = fs.statfsSync(resolveBackupDir());
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/**
 * Archives a stack's directory and project volumes into `archiveDir` (which must be inside the
 * backups dir). Throws on any failure: callers must NOT proceed with a destructive step unless this
 * resolves. Stop the stack's containers first for a consistent copy of databases.
 */
export async function archiveStackData(params: {
  project: string;
  workingDir?: string;
  archiveDir: string;
  log?: (msg: string) => void;
}): Promise<DataArchiveEntry[]> {
  const { project, workingDir, archiveDir } = params;
  const log = params.log || (() => {});
  const dataDir = path.join(archiveDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const entries: DataArchiveEntry[] = [];
  const safeProject = project.replace(/[^a-zA-Z0-9_.-]/g, '_');

  if (workingDir && (await hostDirectoryExists(workingDir))) {
    const file = path.join(dataDir, `${safeProject}__dir.tar.gz`);
    log(`Archiving stack folder ${workingDir}...`);
    const code = await runHelper(tarScript(file), [`${workingDir}:/src:ro`], DEFAULT_HELPER_TIMEOUT_MS, [], {
      purpose: `Back up folder ${workingDir}`,
    });
    if (code !== 0 || !fs.existsSync(file)) {
      throw new Error(`Backing up folder ${workingDir} failed (exit ${code}).`);
    }
    const bytes = fs.statSync(file).size;
    entries.push({ kind: 'directory', source: workingDir, archiveFile: file, bytes });
    log(`Folder archived (${formatBytes(bytes)} compressed).`);
  }

  for (const v of await getProjectVolumes(project)) {
    const file = path.join(dataDir, `${safeProject}__vol__${v.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}.tar.gz`);
    log(`Archiving volume ${v.name}...`);
    const code = await runHelper(tarScript(file), [`${v.name}:/src:ro`], DEFAULT_HELPER_TIMEOUT_MS, [], {
      purpose: `Back up volume ${v.name}`,
    });
    if (code !== 0 || !fs.existsSync(file)) {
      throw new Error(`Backing up volume ${v.name} failed (exit ${code}).`);
    }
    const bytes = fs.statSync(file).size;
    entries.push({
      kind: 'volume',
      source: v.name,
      archiveFile: file,
      bytes,
      volumeLabels: v.labels,
      volumeDriver: v.driver,
    });
    log(`Volume ${v.name} archived (${formatBytes(bytes)} compressed).`);
  }

  return entries;
}

/**
 * Restores archived data. Directories are restored only if they are missing or `overwrite` is set;
 * volumes are recreated (with their original Compose labels, so Compose adopts them) when missing.
 * Existing live data is never silently overwritten.
 */
export async function restoreStackData(
  entries: DataArchiveEntry[],
  opts: { overwrite?: boolean; log?: (msg: string) => void } = {}
): Promise<void> {
  const log = opts.log || (() => {});
  for (const e of entries) {
    if (!fs.existsSync(e.archiveFile)) {
      log(`[Warning] Archive missing: ${e.archiveFile}. Skipping ${e.source}.`);
      continue;
    }

    if (e.kind === 'directory') {
      // An empty folder counts as missing: there's nothing in it to protect
      const exists = !(await hostDirectoryIsFree(e.source));
      if (exists && !opts.overwrite) {
        log(`Folder ${e.source} still exists; leaving live data in place.`);
        continue;
      }
      log(`Restoring folder ${e.source} from backup...`);
      const code = await runHelper(`mkdir -p /dst && tar -C /dst -xzpf ${shellQuote(e.archiveFile)}`, [
        `${e.source}:/dst`,
      ], DEFAULT_HELPER_TIMEOUT_MS, [], { purpose: `Restore folder ${e.source}` });
      if (code !== 0) throw new Error(`Restoring folder ${e.source} failed (exit ${code}).`);
      log(`Folder ${e.source} restored.`);
    } else {
      let exists = false;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v = await queryDockerEngine<any>(`/volumes/${encodeURIComponent(e.source)}`, 'GET');
        exists = Boolean(v && v.Name);
      } catch {
        exists = false;
      }
      if (exists && !opts.overwrite) {
        log(`Volume ${e.source} still exists; leaving live data in place.`);
        continue;
      }
      if (!exists) {
        await queryDockerEngine('/volumes/create', 'POST', {
          Name: e.source,
          Driver: e.volumeDriver || 'local',
          Labels: e.volumeLabels || {},
        });
      }
      log(`Restoring volume ${e.source} from backup...`);
      const code = await runHelper(`tar -C /dst -xzpf ${shellQuote(e.archiveFile)}`, [`${e.source}:/dst`], DEFAULT_HELPER_TIMEOUT_MS, [], {
        purpose: `Restore volume ${e.source}`,
      });
      if (code !== 0) throw new Error(`Restoring volume ${e.source} failed (exit ${code}).`);
      log(`Volume ${e.source} restored.`);
    }
  }
}

/**
 * Runs `docker compose <args>` in a host stack directory and waits for it to finish (polled, so
 * slow shutdowns are not cut off). Returns true on exit code 0. The helper reaches the Docker
 * daemon through the socket it inherits from Manifexus.
 */
/**
 * Run a shell command directly on the server (not in a container): a privileged helper enters the
 * host's namespaces. Only used for commands the person approved one by one.
 */
export async function runHostCommand(command: string, timeoutMs = 2 * 60 * 1000): Promise<{ code: number; output: string }> {
  return runHelperDetailed(`nsenter -t 1 -m -u -i -n -p -- sh -c ${shellQuote(command)}`, [], timeoutMs, [], {
    purpose: `Run on the server: ${command}`,
    hostConfig: { Privileged: true, PidMode: 'host' },
  });
}

/** Run a script in a helper with the given folders mounted, returning its output */
export async function runHelperScript(script: string, binds: string[], purpose: string, timeoutMs = 60 * 1000): Promise<{ code: number; output: string }> {
  return runHelperDetailed(script, binds, timeoutMs, [], { purpose });
}

export async function runComposeInDir(hostDir: string, args: string, timeoutMs = 10 * 60 * 1000): Promise<boolean> {
  const script =
    `cd ${shellQuote(hostDir)} || exit 3; ` +
    `if docker compose version >/dev/null 2>&1; then docker compose ${args}; ` +
    `elif command -v docker-compose >/dev/null 2>&1; then docker-compose ${args}; else exit 127; fi`;
  try {
    const code = await runHelper(script, [`${hostDir}:${hostDir}`], timeoutMs, [], { purpose: `docker compose ${args} in ${hostDir}` });
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Like runComposeInDir, but also returns what compose printed (the last part, for error messages).
 * `extraDirs` are other host folders the compose file refers to (e.g. env files of a moved app).
 */
export async function runComposeCapture(
  hostDir: string,
  args: string,
  opts: { extraDirs?: string[]; timeoutMs?: number } = {}
): Promise<{ ok: boolean; output: string }> {
  const script =
    `cd ${shellQuote(hostDir)} || exit 3; ` +
    `if docker compose version >/dev/null 2>&1; then docker compose ${args}; ` +
    `elif command -v docker-compose >/dev/null 2>&1; then docker-compose ${args}; else echo "Docker Compose is not available"; exit 127; fi`;
  const binds = Array.from(new Set([hostDir, ...(opts.extraDirs || [])])).map((d) => `${d}:${d}`);
  try {
    const r = await runHelperDetailed(script, binds, opts.timeoutMs ?? 10 * 60 * 1000, [], {
      purpose: `docker compose ${args} in ${hostDir}`,
      probe: /\bconfig\b/.test(args),
    });
    return { ok: r.code === 0, output: r.output };
  } catch (err) {
    return { ok: false, output: (err as Error).message };
  }
}

/** The last meaningful lines of compose output, for showing in an error. */
export function composeErrorTail(output: string, lines = 6): string {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(Container|Network|Volume) .* (Creating|Created|Starting|Started|Running|Recreate|Recreated|Stopping|Stopped|Removing|Removed|Waiting|Healthy)$/.test(l))
    .slice(-lines)
    .join('\n');
}

/** Removes one named volume. Returns false if it is in use or missing. */
export async function removeVolume(name: string): Promise<boolean> {
  try {
    await queryDockerEngine(`/volumes/${encodeURIComponent(name)}`, 'DELETE');
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * Copies one backed-up folder or volume into a different host folder, without touching the
 * original location. Used by Restore → "Restore to Another Folder".
 */
export async function extractArchiveTo(entry: DataArchiveEntry, destHostDir: string): Promise<void> {
  if (!fs.existsSync(entry.archiveFile)) throw new Error(`The backup file for ${entry.source} is missing.`);
  const code = await runHelper(`mkdir -p /dst && tar -C /dst -xzpf ${shellQuote(entry.archiveFile)}`, [`${destHostDir}:/dst`], DEFAULT_HELPER_TIMEOUT_MS, [], {
    purpose: `Restore ${entry.kind === 'volume' ? 'volume' : 'folder'} ${entry.source} into ${destHostDir}`,
  });
  if (code !== 0) throw new Error(`Copying ${entry.source} into ${destHostDir} failed (exit ${code}).`);
}

/** True when the host folder doesn't exist or is empty (safe to restore into). */
export async function hostDirectoryIsFree(hostDir: string): Promise<boolean> {
  const parent = path.posix.dirname(hostDir);
  const name = path.posix.basename(hostDir);
  try {
    const code = await runHelper(
      `[ ! -e /parent/${shellQuote(name)} ] || [ -z "$(ls -A /parent/${shellQuote(name)} 2>/dev/null)" ]`,
      [`${parent}:/parent:ro`],
      60 * 1000,
      [],
      { purpose: `Check ${hostDir} is free`, probe: true }
    );
    return code === 0;
  } catch {
    return false;
  }
}
