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
import { resolveContainerPath } from './hostFsService';
import { backupToStore, entryAvailable, restoreEnv, restoreScript, storeUsable } from './backupStore';

export interface DataArchiveEntry {
  kind: 'directory' | 'volume';
  /** Host directory path, or Docker volume name */
  source: string;
  /** Archive file path inside the Manifexus container (under the backups dir): .tar.zst or .tar.gz. Empty for a
   *  backup kept in the backup store (see backupStore.ts) */
  archiveFile: string;
  /** Space the backup takes: the archive's size, or what the backup store added for it */
  bytes: number;
  /** Kept in the backup store (restic): the snapshot, and the folder inside it that holds this data */
  snapshot?: string;
  snapshotPath?: string;
  /** Size of the data itself, before compression */
  dataBytes?: number;
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
// Helpers are checked often at first (most finish in well under a second), then less often
const POLL_FIRST_MS = 100;
const POLL_MAX_MS = 1000;
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
export async function runHelperDetailed(
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
    let pollMs = POLL_FIRST_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      pollMs = Math.min(POLL_MAX_MS, Math.round(pollMs * 1.5));
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
      } catch (err) {
        // The helper is gone (removed by someone else, or `docker container prune`): waiting won't bring it
        // back, so stop now instead of holding everything up until the deadline
        if (/status 404/.test((err as Error)?.message || '')) {
          throw new Error(`${meta.purpose} stopped: its helper container was removed before it finished`);
        }
        // otherwise a passing hiccup: keep polling until the deadline
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

/** What the helper image can do: zstd (fast, all cores), GNU tar, restic (the backup store). Checked once per image. */
export interface HelperCaps {
  image: string;
  zstd: boolean;
  gnuTar: boolean;
  restic: boolean;
}
const capsCache = new Map<string, Promise<HelperCaps>>();
export async function helperCaps(): Promise<HelperCaps> {
  const image = await getBestAvailableImage();
  if (!capsCache.has(image)) {
    const probe = (async () => {
      const r = await runHelperDetailed(
        'printf "zstd=%s\\n" "$(command -v zstd >/dev/null && echo 1)"; printf "gnu=%s\\n" "$(tar --version 2>/dev/null | grep -q GNU && echo 1)"; printf "restic=%s\\n" "$(restic version 2>/dev/null | grep -qE "restic 0\\.(1[7-9]|[2-9][0-9])" && echo 1)"',
        [],
        60 * 1000,
        [],
        { purpose: 'Check the backup tools', probe: true }
      );
      const has = (k: string) => new RegExp(`${k}=1`).test(r.output);
      return { image, zstd: has('zstd'), gnuTar: has('gnu'), restic: has('restic') };
    })();
    capsCache.set(image, probe);
    // A failed check is tried again next time instead of being remembered
    probe.catch(() => capsCache.delete(image));
  }
  return capsCache.get(image)!;
}

/**
 * Archive /src<i> into `file`. zstd uses every core (about ten times faster than gzip, and smaller);
 * gzip when the helper image has no zstd. GNU tar (the Manifexus image) keeps going past files that change
 * while it reads (normal for apps that keep running, e.g. logs): exit 1 is a warning, not a failed backup.
 * BusyBox tar (Alpine-based helper images) doesn't know those options, so it gets the plain form.
 */
function tarScript(file: string, src: string, caps: HelperCaps): string {
  const f = shellQuote(file);
  const create = caps.gnuTar ? `tar --warning=no-file-changed --warning=no-file-removed -C ${src} -cpf - .` : `tar -C ${src} -cf - .`;
  if (file.endsWith('.zst')) {
    return `rc=$( { { ${create}; echo $? >&3; } | zstd -q -3 -T0 > ${f}; } 3>&1 ); [ "\${rc:-2}" -le 1 ] && [ -s ${f} ]`;
  }
  return `${caps.gnuTar ? `tar --warning=no-file-changed --warning=no-file-removed -C ${src} -czpf ${f} .` : `tar -C ${src} -czf ${f} .`}; rc=$?; [ $rc -le 1 ] && [ -s ${f} ]`;
}

/** Unpack an archive (.tar.zst or .tar.gz) into /dst, keeping owners and permissions (BusyBox does that by default as root) */
function untarScript(file: string): string {
  const f = shellQuote(file);
  if (file.endsWith('.zst')) {
    return `command -v zstd >/dev/null || { echo "This backup needs zstd to unpack, and this helper doesn't have it" >&2; exit 3; }; zstd -q -dc ${f} | if tar --version 2>/dev/null | grep -q GNU; then tar -C /dst -xpf -; else tar -C /dst -xf -; fi`;
  }
  return `if tar --version 2>/dev/null | grep -q GNU; then tar -C /dst -xzpf ${f}; else tar -C /dst -xzf ${f}; fi`;
}

/** Script that puts one backed-up item into /dst, from the backup store or from its archive */
function unpackScript(e: DataArchiveEntry): string {
  return e.snapshot ? restoreScript(e) : untarScript(e.archiveFile);
}
function unpackEnv(e: DataArchiveEntry): string[] {
  return e.snapshot ? restoreEnv() : [];
}

/** The archive file name ending for new backups */
function archiveExt(caps: HelperCaps): string {
  return caps.zstd ? '.tar.zst' : '.tar.gz';
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
  if (code === 0) return true;
  // Something inside wouldn't go (a lock or a mount): try once more directly on the server
  try {
    const r = await runHostCommand(`rm -rf ${shellQuote(normalized)} && [ ! -e ${shellQuote(normalized)} ]`);
    return r.code === 0;
  } catch {
    return false;
  }
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
  opts: { overwrite?: boolean; fileName?: string } = {}
): Promise<void> {
  const normalized = path.posix.normalize(hostDir.trim()).replace(/\/+$/, '');
  // The stack's own compose file name (compose.yaml, docker-compose.yml…): never a second file beside it
  const file = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'].includes(opts.fileName || '') ? opts.fileName! : 'docker-compose.yml';
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
    `printf '%s' "$COMPOSE_DATA" > /parent/${name}/${file} || exit 21`,
    // Match the owner of the parent folder (e.g. your user rather than root)
    `chown "$(stat -c %u:%g /parent)" /parent/${name} /parent/${name}/${file} 2>/dev/null`,
    `[ -s /parent/${name}/${file} ] || exit 22`,
  ]
    .filter(Boolean)
    .join('\n');
  const code = await runHelper(script, [`${parent}:/parent`], 2 * 60 * 1000, [`COMPOSE_DATA=${composeText}`], {
    purpose: `Write ${normalized}/${file}`,
  });
  record(code === 0 ? 'info' : 'warn', 'file', code === 0 ? `Wrote ${normalized}/${file} (${composeText.length} bytes)` : `Could not write ${normalized}/${file} (exit ${code})`, {
    path: `${normalized}/${file}`,
    exitCode: code,
    overwrite: Boolean(opts.overwrite),
    content: composeText,
  });
  if (code === 17) {
    throw new StackFolderExistsError(`${normalized} already has a compose file. Pick another name or folder.`);
  }
  if (code !== 0) {
    throw new Error(`Could not create ${normalized}/${file} on the server (exit ${code}).`);
  }
}

/** Sizes in bytes of host directories or named volumes (0 if missing), all in one helper. */
async function measureMany(sources: string[]): Promise<number[]> {
  if (!sources.length) return [];
  try {
    const r = await runHelperDetailed(
      sources.map((_, i) => `printf "size${i}=%s\\n" "$( [ -d /m${i} ] && du -sb /m${i} 2>/dev/null | cut -f1 )"`).join('; '),
      sources.map((src, i) => `${src}:/m${i}:ro`),
      30 * 60 * 1000,
      [],
      { purpose: `Measure size of ${sources.join(', ')}`, probe: true }
    );
    return sources.map((_, i) => parseInt(r.output.match(new RegExp(`size${i}=(\\d+)`))?.[1] || '0', 10) || 0);
  } catch {
    return sources.map(() => 0);
  }
}

/** Does a host directory exist? (checked through a helper, since Manifexus can't see host paths) */
export async function hostDirectoryExists(hostDir: string): Promise<boolean> {
  return (await hostDirectoriesExist([hostDir]))[0];
}

/**
 * Which of these host directories exist. Folders Manifexus can see directly are checked right away; the rest in
 * one helper that looks at the server's whole filesystem, read-only.
 */
export async function hostDirectoriesExist(hostDirs: string[]): Promise<boolean[]> {
  const result: (boolean | undefined)[] = hostDirs.map((d) => {
    const local = resolveContainerPath(path.posix.normalize(d));
    if (!local) return undefined;
    try {
      return fs.statSync(local).isDirectory();
    } catch {
      return false;
    }
  });
  const ask = hostDirs.map((d, i) => ({ d: path.posix.normalize(d), i })).filter((x) => result[x.i] === undefined);
  if (ask.length) {
    try {
      const r = await runHelperDetailed(
        ask.map((x, k) => `[ -d ${shellQuote('/host' + x.d)} ] && echo "dir${k}=1"`).join('; ') + '; true',
        ['/:/host:ro'],
        60 * 1000,
        [],
        { purpose: `Check ${ask.length === 1 ? `folder ${ask[0].d} exists` : `${ask.length} folders exist`}`, probe: true }
      );
      ask.forEach((x, k) => (result[x.i] = new RegExp(`dir${k}=1\\b`).test(r.output)));
    } catch {
      ask.forEach((x) => (result[x.i] = false));
    }
  }
  return result.map(Boolean);
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
  const projectVolumes = await getProjectVolumes(project);
  const sizes = await measureMany([...(workingDir && dirExists ? [workingDir] : []), ...projectVolumes.map((v) => v.name)]);
  const directoryBytes = workingDir && dirExists ? sizes.shift() || 0 : 0;
  const volumes = projectVolumes.map((v, i) => ({ name: v.name, bytes: sizes[i] || 0 }));

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

interface BackupItem {
  kind: 'directory' | 'volume';
  source: string;
  /** File name (without ending) for an archive, when the backup store isn't used */
  fileBase: string;
  volumeLabels?: Record<string, string>;
  volumeDriver?: string;
}

/**
 * Backs up folders and volumes: into the backup store when it can be used (only what changed is stored), else
 * as one .tar.zst (or .tar.gz) archive each in `archiveDir`. Either way all of them in one helper. Throws on
 * any failure: callers must NOT go ahead with a destructive step unless this resolves.
 */
async function backupItems(items: BackupItem[], archiveDir: string, opts: { purpose: string; log?: (m: string) => void; pre?: boolean }): Promise<DataArchiveEntry[]> {
  if (!items.length) return [];
  const log = opts.log || (() => {});
  if (await storeUsable()) {
    return backupToStore(items, { tags: [opts.pre ? 'pre' : `backup:${path.basename(archiveDir)}`], purpose: opts.purpose, log: opts.pre ? undefined : log });
  }
  if (opts.pre) return []; // a first pass only helps the backup store
  const caps = await helperCaps();
  const dataDir = path.join(archiveDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const files = items.map((it) => path.join(dataDir, it.fileBase + archiveExt(caps)));
  log(`Backing up ${items.map((it) => it.source).join(', ')}...`);
  const r = await runHelperDetailed(
    items.map((_, i) => `${tarScript(files[i], `/src${i}`, caps)} || { echo "MFXFAIL ${i}"; exit 2; }`).join('\n'),
    items.map((it, i) => `${it.source}:/src${i}:ro`),
    DEFAULT_HELPER_TIMEOUT_MS,
    [],
    { purpose: opts.purpose }
  );
  return items.map((it, i) => {
    if (r.code !== 0 || !fs.existsSync(files[i])) {
      const failed = Number(r.output.match(/MFXFAIL (\d+)/)?.[1] ?? i);
      throw new Error(`Backing up ${items[failed].kind === 'volume' ? 'volume' : 'folder'} ${items[failed].source} failed (exit ${r.code}).`);
    }
    const bytes = fs.statSync(files[i]).size;
    log(`${it.source} backed up (${formatBytes(bytes)} compressed).`);
    return { kind: it.kind, source: it.source, archiveFile: files[i], bytes, volumeLabels: it.volumeLabels, volumeDriver: it.volumeDriver };
  });
}

/**
 * Backs up a stack's directory and project volumes. Throws on any failure: callers must NOT proceed with a
 * destructive step unless this resolves. Stop the stack's containers first for a consistent copy of databases.
 */
export async function archiveStackData(params: {
  project: string;
  workingDir?: string;
  archiveDir: string;
  log?: (msg: string) => void;
}): Promise<DataArchiveEntry[]> {
  const { project, workingDir, archiveDir } = params;
  const safeProject = project.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const items: BackupItem[] = [];
  if (workingDir && (await hostDirectoryExists(workingDir))) {
    items.push({ kind: 'directory', source: workingDir, fileBase: `${safeProject}__dir` });
  }
  for (const v of await getProjectVolumes(project)) {
    items.push({ kind: 'volume', source: v.name, fileBase: `${safeProject}__vol__${v.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`, volumeLabels: v.labels, volumeDriver: v.driver });
  }
  return backupItems(items, archiveDir, { purpose: `Back up ${project}${workingDir ? ` (${workingDir})` : ''}`, log: params.log });
}

/**
 * Backs up just one app's own data, for a quick move: its Docker volumes, and the folders it uses inside
 * its stack folder (like ./config). Shared folders outside the stack (a media library, downloads) are left
 * out: a move never touches them, and they can be huge. Restore puts these back like any stack backup.
 */
export interface AppDataParams {
  apps: { name: string; workingDir?: string; mounts: { type: string; name?: string; source: string }[] }[];
  /** Every stack folder on the server: an app's own folders live inside one (its own, or another stack's) */
  stackDirs?: string[];
  /** Folders other apps mount: shared, so not this app's own */
  sharedDirs?: string[];
  /** Volumes other apps mount: shared, so not this app's own */
  sharedVolumes?: string[];
}

/**
 * What belongs to these apps alone: their Docker volumes, and the folders they use inside a stack
 * folder (like ./config). Shared things (a media library, downloads, a volume another app also uses)
 * are listed separately and never counted as the app's own.
 */
export async function appOwnData(params: AppDataParams): Promise<{
  own: { kind: 'volume' | 'directory'; source: string; app: string }[];
  shared: string[];
}> {
  const own: { kind: 'volume' | 'directory'; source: string; app: string }[] = [];
  const shared = new Set<string>();
  const done = new Set<string>();
  const stackDirs = (params.stackDirs || []).filter(Boolean).map((d) => path.posix.normalize(d).replace(/\/+$/, ''));
  for (const app of params.apps) {
    const base = app.workingDir ? path.posix.normalize(app.workingDir).replace(/\/+$/, '') : '';
    for (const m of app.mounts) {
      if (m.type === 'volume' && m.name) {
        if (done.has('v:' + m.name)) continue;
        if ((params.sharedVolumes || []).includes(m.name)) {
          shared.add(m.name);
          continue;
        }
        done.add('v:' + m.name);
        own.push({ kind: 'volume', source: m.name, app: app.name });
      } else if (m.type === 'bind' && m.source) {
        const src = path.posix.normalize(m.source).replace(/\/+$/, '');
        if (src === '/var/run/docker.sock' || src.startsWith('/var/run/') || src.startsWith('/etc/') || src.startsWith('/dev/') || src.startsWith('/proc/') || src.startsWith('/sys/')) continue;
        // The app's own folders: inside a stack folder (its own, or another stack's), not a whole stack folder,
        // and not used by any other app (shared data like downloads or a media library is left alone)
        const dirs = Array.from(new Set([base, ...stackDirs].filter(Boolean)));
        if (!dirs.some((d) => src.startsWith(d + '/'))) {
          shared.add(src);
          continue;
        }
        if (done.has('d:' + src)) continue;
        if ((params.sharedDirs || []).some((x) => x === src || x.startsWith(src + '/') || src.startsWith(x + '/'))) {
          shared.add(src);
          continue;
        }
        if ([...done].some((d) => d.startsWith('d:') && src.startsWith(d.slice(2) + '/'))) continue;
        done.add('d:' + src);
        own.push({ kind: 'directory', source: src, app: app.name });
      }
    }
  }
  // Folders that don't exist on the server have nothing to back up: checked all at once
  const dirs = own.filter((o) => o.kind === 'directory');
  const exists = await hostDirectoriesExist(dirs.map((o) => o.source));
  const missing = new Set(dirs.filter((_, i) => !exists[i]).map((o) => o.source));
  return { own: own.filter((o) => o.kind === 'volume' || !missing.has(o.source)), shared: Array.from(shared) };
}

/** How big each of an app's own volumes and folders is */
export async function measureAppData(items: { kind: 'volume' | 'directory'; source: string }[]): Promise<{ kind: 'volume' | 'directory'; source: string; bytes: number }[]> {
  const sizes = await measureMany(items.map((it) => it.source));
  return items.map((it, i) => ({ ...it, bytes: sizes[i] }));
}

export async function archiveAppData(
  params: AppDataParams & {
    archiveDir: string;
    log?: (msg: string) => void;
    /** Already worked out (by a first pass): skip working it out again */
    own?: { kind: 'volume' | 'directory'; source: string; app: string }[];
    /** A first pass while the apps still run (backup store only): makes the real backup after stopping fast */
    pre?: boolean;
  }
): Promise<DataArchiveEntry[]> {
  const safe = (x: string) => x.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
  const own = params.own || (await appOwnData(params)).own;
  const items: BackupItem[] = [];
  for (const it of own) {
    if (it.kind === 'volume') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vol = await queryDockerEngine<any>(`/volumes/${encodeURIComponent(it.source)}`, 'GET').catch(() => null);
      items.push({ kind: 'volume', source: it.source, fileBase: `${safe(it.app)}__vol__${safe(it.source)}`, volumeLabels: vol?.Labels || {}, volumeDriver: vol?.Driver || 'local' });
    } else {
      items.push({ kind: 'directory', source: it.source, fileBase: `${safe(it.app)}__dir__${safe(it.source)}` });
    }
  }
  const apps = Array.from(new Set(own.map((o) => o.app))).join(', ');
  return backupItems(items, params.archiveDir, { purpose: `Back up ${apps}’s data${params.pre ? ' ahead, while it runs' : ''}`, log: params.log, pre: params.pre });
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
    if (!entryAvailable(e)) {
      log(`[Warning] Backup missing: ${e.archiveFile || `snapshot ${e.snapshot}`}. Skipping ${e.source}.`);
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
      const code = await runHelper(`mkdir -p /dst && ${unpackScript(e)}`, [
        `${e.source}:/dst`,
      ], DEFAULT_HELPER_TIMEOUT_MS, unpackEnv(e), { purpose: `Restore folder ${e.source}` });
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
      const code = await runHelper(unpackScript(e), [`${e.source}:/dst`], DEFAULT_HELPER_TIMEOUT_MS, unpackEnv(e), {
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
  if (!entryAvailable(entry)) throw new Error(`The backup of ${entry.source} is missing.`);
  const code = await runHelper(`mkdir -p /dst && ${unpackScript(entry)}`, [`${destHostDir}:/dst`], DEFAULT_HELPER_TIMEOUT_MS, unpackEnv(entry), {
    purpose: `Restore ${entry.kind === 'volume' ? 'volume' : 'folder'} ${entry.source} into ${destHostDir}`,
  });
  if (code !== 0) throw new Error(`Copying ${entry.source} into ${destHostDir} failed (exit ${code}).`);
}

/** True when the host folder doesn't exist or is empty (safe to restore into). */
export async function hostDirectoryIsFree(hostDir: string, attempt = 1): Promise<boolean> {
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
    // The check itself couldn't run (Docker busy or just restarted): look once more before saying no
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500));
      return hostDirectoryIsFree(hostDir, attempt + 1);
    }
    return false;
  }
}
