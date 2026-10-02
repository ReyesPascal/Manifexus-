/**
 * The backup store: where Manifexus keeps the data backed up before every change (moves, deletes, restores).
 *
 * It's a standard restic repository (https://restic.net) in the backups folder:
 *   - Deduplicated: a backup only stores what changed since the last one, so backing up the same app again and
 *     again costs almost no space, and a backup of unchanged data takes seconds.
 *   - Compressed (zstd) and encrypted, with the key in a file beside the store (never inside it). A copy of the
 *     store alone (for example in the cloud) can't be read without the key.
 *   - Readable without Manifexus: plain restic can list and restore everything in it.
 *
 * Each backed-up folder or volume is its own snapshot at a fixed path (/backup/volumes/<name>,
 * /backup/folders/<host path>), so restic finds the previous backup of the same thing and only looks at files
 * that changed. Snapshots are tagged with the Restore entry they belong to (rec:<id>); snapshots no entry
 * points to any more are removed by `collectGarbage`, and their space is reclaimed.
 *
 * Backups and restores of server data run in a helper container (the Manifexus image, which has restic) with
 * the data mounted read-only; reading the store (listing files, downloads) runs right here.
 * When restic isn't available (Manifexus not running in Docker, or an old image), backups fall back to
 * .tar.zst archives (dataBackupService.ts), which restore exactly the same way.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { resolveBackupDir, getMergeHistory } from './historyService';
import { runHelperDetailed, helperCaps, formatBytes, type DataArchiveEntry } from './dataBackupService';
import { record } from './activityLog';

export const STORE_HOST = 'manifexus';
const MIN_RESTIC = /restic 0\.(1[7-9]|[2-9][0-9])/;

export function storeDir(): string {
  return path.join(resolveBackupDir(), 'store');
}
/** The store's key. Kept outside the store folder, so copying the store elsewhere never copies its key. */
export function storeKeyFile(): string {
  return path.join(resolveBackupDir(), '.store-key');
}
function cacheDir(): string {
  return path.join(resolveBackupDir(), '.store-cache');
}

/** Environment for restic: where the store and its key are (paths only, no secrets) */
function resticEnv(): Record<string, string> {
  return { RESTIC_REPOSITORY: storeDir(), RESTIC_PASSWORD_FILE: storeKeyFile(), RESTIC_CACHE_DIR: cacheDir(), RESTIC_PROGRESS_FPS: '0.2' };
}
function envList(): string[] {
  return Object.entries(resticEnv()).map(([k, v]) => `${k}=${v}`);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

let localOk: boolean | undefined;
/** Can restic run right here (to read the store)? */
function localRestic(): boolean {
  if (localOk === undefined) {
    try {
      const r = spawnSync('restic', ['version'], { encoding: 'utf8', timeout: 10000 });
      localOk = r.status === 0 && MIN_RESTIC.test(r.stdout || '');
    } catch {
      localOk = false;
    }
  }
  return localOk;
}

/** Runs restic here, against the store */
export function runLocal(args: string[], opts: { timeoutMs?: number } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('restic', args, { env: { ...process.env, ...resticEnv() } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? 30 * 60 * 1000);
    p.stdout.on('data', (d) => {
      if (out.length < 32 * 1024 * 1024) out += d;
    });
    p.stderr.on('data', (d) => {
      if (err.length < 1024 * 1024) err += d;
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out, err: String(e) });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out, err });
    });
  });
}

let ready: Promise<boolean> | undefined;
let unusableReason: string | undefined;

/**
 * Makes sure the store exists (creating it and its key the first time). False when it can't be used, with the
 * reason in `storeStatus()`; backups then use .tar.zst archives instead.
 */
function ensureStore(): Promise<boolean> {
  if (!ready) {
    ready = (async () => {
      if (process.env.MANIFEXUS_BACKUP_STORE === 'off') return fail('turned off');
      if (!localRestic()) return fail('restic isn’t installed here');
      const caps = await helperCaps().catch(() => null);
      if (!caps?.restic) return fail('the helper image has no restic');
      const dir = storeDir();
      const key = storeKeyFile();
      const exists = fs.existsSync(path.join(dir, 'config'));
      if (exists && !fs.existsSync(key)) return fail('the store’s key file is missing');
      if (!exists) {
        if (!fs.existsSync(key)) {
          fs.writeFileSync(key, crypto.randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
        }
        const r = await runLocal(['init'], { timeoutMs: 2 * 60 * 1000 });
        if (r.code !== 0) return fail(`couldn’t create it: ${r.err.trim().split('\n').pop()}`);
        record('info', 'backup', 'Created the backup store', { store: dir });
      }
      unusableReason = undefined;
      return true;
    })().catch((e) => fail(String(e)));
    // Not usable now: look again next time (an update may have added restic)
    ready.then((ok) => {
      if (!ok) setTimeout(() => (ready = undefined), 10 * 60 * 1000);
    });
  }
  return ready;
}
function fail(reason: string): boolean {
  if (unusableReason !== reason) record('debug', 'backup', `Backups use archives, not the backup store: ${reason}`, { reason });
  unusableReason = reason;
  return false;
}

/** True when new backups go into the store */
export async function storeUsable(): Promise<boolean> {
  return ensureStore();
}
/** Why backups use archives instead of the store (undefined while the store is in use or not checked yet) */
export function storeUnusableReason(): string | undefined {
  return unusableReason;
}

// ----------------------------------------------------------------------------
// Backing up
// ----------------------------------------------------------------------------

export interface StoreItem {
  kind: 'directory' | 'volume';
  /** Host folder path, or Docker volume name */
  source: string;
  volumeLabels?: Record<string, string>;
  volumeDriver?: string;
}

/** Where an item lives inside the store: the same place every time, so the next backup only looks at changes */
export function snapshotRoot(item: { kind: 'directory' | 'volume'; source: string }): string {
  return item.kind === 'volume'
    ? `/backup/volumes/${item.source.replace(/[^a-zA-Z0-9_.-]/g, '_')}`
    : `/backup/folders${path.posix.normalize(item.source).replace(/\/+$/, '')}`;
}

/**
 * Backs up folders and volumes into the store, all in one helper. Throws if any item fails: callers must not go
 * ahead with a change unless this resolves. `tags`: rec:<id> for the Restore entry it belongs to, or pre for
 * a first pass made while the app is still running (it makes the real backup after stopping take seconds).
 */
export async function backupToStore(items: StoreItem[], opts: { tags: string[]; time?: string; purpose: string; log?: (m: string) => void }): Promise<DataArchiveEntry[]> {
  if (!items.length) return [];
  if (!(await ensureStore())) throw new Error(`The backup store can’t be used (${unusableReason}).`);
  const tags = ['manifexus', ...opts.tags].map((t) => `--tag ${shellQuote(t)}`).join(' ');
  const time = opts.time ? ` --time ${shellQuote(opts.time.replace('T', ' ').replace(/\.\d+Z?$|Z$/, ''))}` : '';
  const roots = items.map(snapshotRoot);
  // One snapshot holding every item (one restic start instead of one per item). restic finds the previous backup
  // of the same items by the same list of paths, so the next backup of this app only looks at what changed.
  const script =
    `restic backup --retry-lock 30m --no-scan --json --host ${STORE_HOST} ${tags}${time} ${roots.map(shellQuote).join(' ')} > /tmp/out 2>/tmp/err; rc=$?; ` +
    `printf 'MFXSUMMARY %s ' "$rc"; grep '"message_type":"summary"' /tmp/out | tail -n 1; ` +
    `[ $rc -eq 0 ] || { echo "MFXERR"; tail -n 5 /tmp/err; exit 2; }`;
  const r = await runHelperDetailed(
    script,
    items.map((it, i) => `${it.source}:${roots[i]}:ro`),
    6 * 60 * 60 * 1000,
    envList(),
    { purpose: opts.purpose }
  );
  const m = r.output.match(/MFXSUMMARY (\d+) (\{.*\})/);
  let summary: Record<string, unknown> | undefined;
  try {
    summary = m ? JSON.parse(m[2]) : undefined;
  } catch {
    summary = undefined;
  }
  if (!m || m[1] !== '0' || !summary?.snapshot_id) {
    const why = r.output.split('MFXERR')[1]?.trim().split('\n').filter(Boolean).pop();
    // restic exit 3: some files couldn't be read, so the backup isn't complete
    throw new Error(`Backing up ${items.map((it) => it.source).join(', ')} failed${m?.[1] === '3' ? ' (some files couldn’t be read)' : ''}${why ? `: ${why}` : '.'}`);
  }
  const snap = String(summary.snapshot_id);
  known?.add(snap);
  const added = Number(summary.data_added_packed ?? summary.data_added ?? 0);
  const total = Number(summary.total_bytes_processed ?? 0);
  const entries: DataArchiveEntry[] = items.map((it, i) => ({
    kind: it.kind,
    source: it.source,
    archiveFile: '',
    // What the store added is counted once, on the first item (the items share one snapshot)
    bytes: i === 0 ? added : 0,
    dataBytes: i === 0 ? total : 0,
    snapshot: snap,
    snapshotPath: roots[i],
    volumeLabels: it.volumeLabels,
    volumeDriver: it.volumeDriver,
  }));
  opts.log?.(`${items.map((it) => it.source).join(', ')}: ${formatBytes(total)} backed up, ${formatBytes(added)} of it new.`);
  return entries;
}

// ----------------------------------------------------------------------------
// Restoring and reading
// ----------------------------------------------------------------------------

/** Script (for a helper with the destination mounted at /dst) that puts a stored item back */
export function restoreScript(entry: DataArchiveEntry): string {
  return `restic restore --retry-lock 30m ${shellQuote(`${entry.snapshot}:${entry.snapshotPath}`)} --target /dst`;
}
export function restoreEnv(): string[] {
  return envList();
}

let known: Set<string> | undefined;
let knownAt = 0;
/** Snapshots in the store (short ids and full ids), refreshed now and then */
export async function refreshKnownSnapshots(): Promise<Set<string> | undefined> {
  if (!localRestic() || !fs.existsSync(path.join(storeDir(), 'config'))) return undefined;
  const r = await runLocal(['snapshots', '--json', '--no-lock'], { timeoutMs: 2 * 60 * 1000 });
  if (r.code !== 0) return known;
  try {
    const list = JSON.parse(r.out) as { id: string; short_id: string }[];
    known = new Set(list.flatMap((s) => [s.id, s.short_id]));
    knownAt = Date.now();
  } catch {
    // keep the last list
  }
  return known;
}

/** Is this backed-up item still there to restore? (archives: the file exists; the store: its snapshot does) */
export function entryAvailable(e: DataArchiveEntry): boolean {
  if (e.snapshot) {
    if (Date.now() - knownAt > 5 * 60 * 1000) void refreshKnownSnapshots();
    return known ? known.has(e.snapshot) : fs.existsSync(path.join(storeDir(), 'config'));
  }
  return Boolean(e.archiveFile) && fs.existsSync(e.archiveFile);
}

/** Every file in a stored item: path relative to the item, size */
export async function listStoredFiles(e: DataArchiveEntry, limit: number): Promise<{ path: string; bytes: number }[]> {
  const r = await runLocal(['ls', '--json', '--no-lock', '--recursive', e.snapshot!, e.snapshotPath!], { timeoutMs: 5 * 60 * 1000 });
  const files: { path: string; bytes: number }[] = [];
  const root = e.snapshotPath!.replace(/\/+$/, '') + '/';
  for (const line of r.out.split('\n')) {
    if (files.length >= limit) break;
    try {
      const n = JSON.parse(line) as { struct_type?: string; type?: string; path?: string; size?: number };
      if (n.struct_type !== 'node' || n.type !== 'file' || !n.path?.startsWith(root)) continue;
      files.push({ path: n.path.slice(root.length), bytes: n.size || 0 });
    } catch {
      // not a file line
    }
  }
  return files;
}

/** Streams one file out of a stored item */
export function dumpStoredFile(e: DataArchiveEntry, rel: string): ReturnType<typeof spawn> {
  return spawn('restic', ['dump', '--no-lock', e.snapshot!, path.posix.join(e.snapshotPath!, rel)], { env: { ...process.env, ...resticEnv() } });
}

/** Writes a stored item as a .tar file (for downloading a whole backup) */
export async function dumpStoredTar(e: DataArchiveEntry, outFile: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(outFile);
    const p = spawn('restic', ['dump', '--no-lock', '--archive', 'tar', e.snapshot!, e.snapshotPath!], { env: { ...process.env, ...resticEnv() } });
    p.stdout.pipe(out);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => out.end(() => (code === 0 ? resolve() : reject(new Error(err.trim() || `restic exited ${code}`)))));
  });
}

// ----------------------------------------------------------------------------
// Cleaning up
// ----------------------------------------------------------------------------

let gcTimer: NodeJS.Timeout | undefined;
let gcRunning = false;

/** Clean up soon (after things settle): call when Restore entries are removed */
export function scheduleGarbageCollection(delayMs = 2 * 60 * 1000): void {
  if (gcTimer) clearTimeout(gcTimer);
  gcTimer = setTimeout(() => void collectGarbage(), delayMs);
  gcTimer.unref?.();
}

/**
 * Removes snapshots that no Restore entry points to (entries deleted by hand or by the keep-for setting, first
 * passes of moves, backups of changes that failed) and reclaims their space. Anything younger than an hour
 * (a change still running saves its Restore entry well before that) is left alone; first passes after 10 minutes.
 */
export async function collectGarbage(): Promise<void> {
  if (gcRunning || !localRestic() || !fs.existsSync(path.join(storeDir(), 'config'))) return;
  gcRunning = true;
  try {
    const r = await runLocal(['snapshots', '--json', '--no-lock'], { timeoutMs: 2 * 60 * 1000 });
    if (r.code !== 0) return;
    const list = JSON.parse(r.out) as { id: string; short_id: string; time: string; tags?: string[] }[];
    const referenced = new Set<string>();
    for (const h of getMergeHistory()) {
      if (h.backupDeletedAt) continue;
      for (const a of h.dataArchives || []) if (a.snapshot) referenced.add(a.snapshot);
    }
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const drop = list.filter((s) => {
      if (!(s.tags || []).includes('manifexus')) return false; // not ours
      if (referenced.has(s.id) || referenced.has(s.short_id)) return false;
      const pre = (s.tags || []).includes('pre');
      return pre ? new Date(s.time).getTime() < Date.now() - 10 * 60 * 1000 : new Date(s.time).getTime() < hourAgo;
    });
    if (!drop.length) return;
    const t0 = Date.now();
    const f = await runLocal(['forget', '--retry-lock', '30m', ...drop.map((s) => s.id)], { timeoutMs: 30 * 60 * 1000 });
    if (f.code !== 0) {
      record('warn', 'backup', 'Couldn’t remove unused backups from the backup store', { error: f.err.trim() });
      return;
    }
    const p = await runLocal(['prune', '--retry-lock', '30m', '--max-unused', '5%'], { timeoutMs: 6 * 60 * 60 * 1000 });
    record(p.code === 0 ? 'info' : 'warn', 'backup', p.code === 0 ? `Removed ${drop.length} unused backup${drop.length === 1 ? '' : 's'} and reclaimed their space` : 'Removed unused backups; reclaiming their space didn’t finish', {
      snapshots: drop.map((s) => s.short_id),
      output: (p.out + p.err).trim().split('\n').slice(-6).join('\n'),
    }, { durationMs: Date.now() - t0 });
    await refreshKnownSnapshots();
  } catch (e) {
    record('warn', 'backup', 'Cleaning up the backup store failed', { error: String(e) });
  } finally {
    gcRunning = false;
  }
}

/** Space the store takes on disk */
export function storeBytes(): number {
  let total = 0;
  const walk = (d: string) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(storeDir());
  return total;
}
