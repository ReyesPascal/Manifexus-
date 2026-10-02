/**
 * Moves older backups (.tar.gz / .tar.zst archives made before the backup store) into the backup store, in the
 * background, one Restore entry at a time. The store keeps only one copy of data that's the same across
 * backups, so this usually frees a lot of space, and it puts every backup in the one place a cloud copy can
 * take later.
 *
 * Nothing is lost if anything goes wrong. For each archive:
 *   1. it's unpacked into a temporary folder and backed up into the store, keeping its original date;
 *   2. the stored copy is restored into a second temporary folder and compared with the first: every file's
 *      contents, plus every file's and folder's owner and permissions;
 *   3. only when every archive of the entry matches does the entry switch to the store. The old archive file is
 *      deleted ten minutes later (a restore that already started from it can still finish).
 * If a step fails, or there isn't room for the temporary copies, the entry keeps its archives exactly as they
 * are and is tried again later. Activity records every entry.
 */
import fs from 'fs';
import path from 'path';
import { getMergeHistory, getHistoryRecordById, saveMergeHistoryRecord, resolveBackupDir, type MergeHistoryRecord } from './historyService';
import { runHelperDetailed, getBackupFreeBytes, formatBytes, type DataArchiveEntry } from './dataBackupService';
import { storeUsable, restoreEnv, STORE_HOST, refreshKnownSnapshots } from './backupStore';
import { readJsonSafe, writeJsonAtomic } from './safeJson';
import { record } from './activityLog';

export interface UpgradeStatus {
  /** Converting right now */
  running: boolean;
  /** Entries that had older backups when this round started, and how many of them are done */
  total: number;
  done: number;
  failed: number;
  /** Space freed so far this round */
  savedBytes: number;
  /** The entry being converted now (its summary) */
  current?: string;
  finishedAt?: string;
}

const status: UpgradeStatus = { running: false, total: 0, done: 0, failed: 0, savedBytes: 0 };
const triedAt = new Map<string, number>();
const RETRY_MS = 60 * 60 * 1000;
let timer: NodeJS.Timeout | undefined;

export function upgradeStatus(): UpgradeStatus {
  return { ...status };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Archives of an entry that still need converting */
function oldArchives(r: MergeHistoryRecord): DataArchiveEntry[] {
  if (r.backupDeletedAt) return [];
  return (r.dataArchives || []).filter((a) => !a.snapshot && a.archiveFile && fs.existsSync(a.archiveFile));
}

/** Start converting soon, and look again every few hours (for archives made while the store couldn't be used) */
let sweeper: NodeJS.Timeout | undefined;
export function scheduleBackupUpgrade(delayMs = 90 * 1000): void {
  // Archives already moved into the store are deleted once they're ten minutes old (checked every 15 minutes,
  // so a restart in between doesn't leave them behind)
  if (!sweeper) {
    sweeper = setInterval(() => deleteReplacedArchives(), 15 * 60 * 1000);
    sweeper.unref?.();
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void runUpgrade().finally(() => scheduleBackupUpgrade(6 * 60 * 60 * 1000));
  }, delayMs);
  timer.unref?.();
}

async function runUpgrade(): Promise<void> {
  if (status.running) return;
  deleteReplacedArchives();
  if (!(await storeUsable())) return;
  const todo = getMergeHistory()
    .filter((r) => oldArchives(r).length > 0)
    .filter((r) => Date.now() - (triedAt.get(r.id) || 0) > RETRY_MS)
    .reverse(); // oldest first
  if (!todo.length) return;
  Object.assign(status, { running: true, total: todo.length, done: 0, failed: 0, savedBytes: 0, current: undefined, finishedAt: undefined });
  record('info', 'backup', `Updating ${todo.length} older backup${todo.length === 1 ? '' : 's'} to the backup store`, { ids: todo.map((r) => r.id) });
  try {
    for (const r of todo) {
      status.current = r.summary;
      triedAt.set(r.id, Date.now());
      try {
        status.savedBytes += await convertRecord(r);
      } catch (e) {
        status.failed++;
        record('warn', 'backup', `Couldn’t update the backup of “${r.summary}”; it stays as it was and is tried again later`, { id: r.id, error: (e as Error).message });
      }
      status.done++;
    }
  } finally {
    Object.assign(status, { running: false, current: undefined, finishedAt: new Date().toISOString() });
    await refreshKnownSnapshots();
    record('info', 'backup', `Older backups updated: ${status.done - status.failed} of ${status.total}${status.savedBytes > 0 ? `, ${formatBytes(status.savedBytes)} freed` : ''}`, { ...status });
  }
}

/** Converts one Restore entry's archives; returns the space freed. Throws (leaving the entry untouched) on any problem. */
async function convertRecord(r: MergeHistoryRecord): Promise<number> {
  const archives = oldArchives(r);
  const compressed = archives.reduce((s, a) => s + fs.statSync(a.archiveFile).size, 0);
  // Two unpacked copies (the archive's, and the stored copy to compare it with): allow for data that
  // compresses well, and leave room to spare
  const free = getBackupFreeBytes();
  const need = compressed * 8 + 1024 * 1024 * 1024;
  if (free !== null && free < need) throw new Error(`Not enough free space to check it (needs about ${formatBytes(need)}, ${formatBytes(free)} free)`);

  const work = path.join(resolveBackupDir(), '.convert', r.id.replace(/[^a-zA-Z0-9_.-]/g, '_'));
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const time = r.timestamp.replace('T', ' ').replace(/\.\d+Z?$|Z$/, '');
  const tag = `backup:${path.basename(r.backupArchiveDir || r.id)}`;
  const script = [
    'set -u',
    `trap 'rm -rf ${shellQuote(work)}/a* ${shellQuote(work)}/b*' EXIT`,
    // A listing of every file and folder: path, type, permissions, owner, group (contents compared by diff)
    "list() { (cd \"$1\" && find . -mindepth 1 -printf '%p %y %m %U %G\\n' | sort); }",
    ...archives.map((a, i) => {
      const A = shellQuote(path.join(work, `a${i}`));
      const B = shellQuote(path.join(work, `b${i}`));
      const unpack = a.archiveFile.endsWith('.zst') ? `zstd -q -dc ${shellQuote(a.archiveFile)} | tar -C ${A} --numeric-owner -xpf -` : `tar -C ${A} --numeric-owner -xzpf ${shellQuote(a.archiveFile)}`;
      return [
        `mkdir -p ${A} ${B}`,
        `${unpack} || { echo "MFXERR ${i} unpack"; exit 2; }`,
        `restic backup --retry-lock 30m --json --host ${STORE_HOST} --tag manifexus --tag converted --tag ${shellQuote(tag)} --time ${shellQuote(time)} ${A} > /tmp/out${i} 2>/tmp/err${i} || { echo "MFXERR ${i} backup"; tail -n 3 /tmp/err${i}; exit 2; }`,
        `snap=$(grep '"message_type":"summary"' /tmp/out${i} | tail -n 1 | sed 's/.*"snapshot_id":"\\([0-9a-f]*\\)".*/\\1/')`,
        `[ -n "$snap" ] || { echo "MFXERR ${i} snapshot"; exit 2; }`,
        `restic restore --retry-lock 30m "$snap:${path.join(work, `a${i}`)}" --target ${B} >/dev/null 2>/tmp/rerr${i} || { echo "MFXERR ${i} restore"; tail -n 3 /tmp/rerr${i}; exit 2; }`,
        `diff -r --no-dereference ${A} ${B} >/tmp/diff${i} 2>&1 || { echo "MFXERR ${i} contents differ"; head -n 5 /tmp/diff${i}; exit 2; }`,
        `[ "$(list ${A})" = "$(list ${B})" ] || { echo "MFXERR ${i} owners or permissions differ"; exit 2; }`,
        `printf 'MFXITEM ${i} '; grep '"message_type":"summary"' /tmp/out${i} | tail -n 1`,
        `rm -rf ${A} ${B}`,
      ].join('\n');
    }),
  ].join('\n');

  const t0 = Date.now();
  let output = '';
  try {
    const res = await runHelperDetailed(script, [], 6 * 60 * 60 * 1000, restoreEnv(), { purpose: `Update the backup of “${r.summary}” to the backup store` });
    output = res.output;
    if (res.code !== 0) {
      const why = output.match(/MFXERR \d+ ([^\n]*)/)?.[1];
      throw new Error(why ? `Check failed: ${why}` : `The helper stopped (exit ${res.code})`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  // Every archive is safely in the store: switch the entry over (if it's still there, unchanged)
  const converted = archives.map((a, i) => {
    const m = output.match(new RegExp(`MFXITEM ${i} (\\{.*\\})`));
    const summary = m ? JSON.parse(m[1]) : undefined;
    if (!summary?.snapshot_id) throw new Error('The backup store didn’t report the new backup');
    return { from: a, snapshot: String(summary.snapshot_id), path: path.join(work, `a${i}`), added: Number(summary.data_added_packed ?? summary.data_added ?? 0), dataBytes: Number(summary.total_bytes_processed ?? 0) };
  });
  const now = getHistoryRecordById(r.id);
  if (!now || now.backupDeletedAt) return 0; // deleted meanwhile: the new copies are cleaned up with other unused ones
  const replaced: string[] = [];
  now.dataArchives = (now.dataArchives || []).map((a) => {
    const c = converted.find((x) => x.from.archiveFile === a.archiveFile);
    if (!c) return a;
    replaced.push(a.archiveFile);
    return { ...a, archiveFile: '', snapshot: c.snapshot, snapshotPath: c.path, bytes: c.added, dataBytes: c.dataBytes };
  });
  saveMergeHistoryRecord(now);
  queueArchiveDeletion(replaced);
  const added = converted.reduce((s, c) => s + c.added, 0);
  const saved = Math.max(0, compressed - added);
  record('info', 'backup', `Updated the backup of “${r.summary}” to the backup store${saved ? ` (${formatBytes(saved)} freed)` : ''}`, {
    id: r.id,
    archives: converted.map((c) => ({ archive: c.from.archiveFile, snapshot: c.snapshot.slice(0, 8), dataBytes: c.dataBytes, newBytes: c.added })),
    checked: 'Restored from the store and compared with the archive: contents, owners and permissions all match',
  }, { durationMs: Date.now() - t0 });
  return saved;
}

// ----------------------------------------------------------------------------
// Old archive files are deleted a little later, once nothing points to them
// ----------------------------------------------------------------------------

function pendingFile(): string {
  return path.join(resolveBackupDir(), '.convert', 'replaced.json');
}

function queueArchiveDeletion(files: string[]): void {
  if (!files.length) return;
  const list = readJsonSafe<{ file: string; at: number }[]>(pendingFile(), []);
  for (const f of files) list.push({ file: f, at: Date.now() });
  fs.mkdirSync(path.dirname(pendingFile()), { recursive: true });
  writeJsonAtomic(pendingFile(), list);
  setTimeout(deleteReplacedArchives, 11 * 60 * 1000).unref?.();
}

/** Deletes archive files that were converted more than ten minutes ago and that no Restore entry uses */
export function deleteReplacedArchives(): void {
  const file = pendingFile();
  if (!fs.existsSync(file)) return;
  const list = readJsonSafe<{ file: string; at: number }[]>(file, []);
  const used = new Set(getMergeHistory().flatMap((r) => (r.dataArchives || []).map((a) => a.archiveFile).filter(Boolean)));
  const root = path.resolve(resolveBackupDir()) + path.sep;
  const keep = list.filter((p) => {
    if (used.has(p.file)) return false; // an entry still uses it: never deleted
    if (Date.now() - p.at < 10 * 60 * 1000) return true; // not yet
    if (path.resolve(p.file).startsWith(root)) fs.rmSync(p.file, { force: true });
    return false;
  });
  writeJsonAtomic(file, keep);
}
