/**
 * Restore: every change Manifexus makes (moving apps, deleting a stack) keeps a backup, and can be
 * restored later. This module turns the history ledger into restore points and handles:
 *
 *  - Chains: restoring a change also restores any newer changes to the same stacks first (newest
 *    first), so nothing is restored on top of a later change.
 *  - Checks: before restoring, compares each stack with how the last change left it and reports
 *    anything edited since.
 *  - Backups: storage used, keep-for setting (pinned backups never expire), deleting a backup
 *    (the entry moves to the archive), browsing and downloading a backup.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { Response } from 'express';
import {
  getMergeHistory,
  getHistoryRecordById,
  saveMergeHistoryRecord,
  removeHistoryRecords,
  resolveBackupDir,
  type MergeHistoryRecord,
} from './historyService';
import { readHostFile } from './hostFsService';
import { hostDirectoryIsFree, extractArchiveTo } from './dataBackupService';
import { executeStreamingRevert } from './automationService';
import { record } from './activityLog';

// ----------------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------------

export interface RestoreSettings {
  /** Days to keep backups; 0 = forever */
  keepDays: number;
}

const settingsFile = () => path.join(resolveBackupDir(), 'restore-settings.json');

export function getRestoreSettings(): RestoreSettings {
  try {
    return { keepDays: 30, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { keepDays: 30 };
  }
}

export function updateRestoreSettings(patch: Partial<RestoreSettings>): RestoreSettings {
  const next = getRestoreSettings();
  if (typeof patch.keepDays === 'number' && patch.keepDays >= 0 && patch.keepDays <= 3650) next.keepDays = Math.round(patch.keepDays);
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  record('info', 'backup', `Restore backups are now kept ${next.keepDays ? `for ${next.keepDays} days` : 'forever'}`, next);
  return next;
}

// ----------------------------------------------------------------------------
// Restore points
// ----------------------------------------------------------------------------

export type RestoreKind = 'move' | 'delete' | 'install';
export type RestoreState = 'available' | 'restored' | 'failed' | 'archived';

export interface RestorePoint {
  id: string;
  kind: RestoreKind;
  /** "Moved kavita to music-stack", "Deleted spiderman" */
  title: string;
  /** "from utilities-stack" */
  detail?: string;
  at: string;
  state: RestoreState;
  restoredAt?: string;
  /** Stack names this change touched */
  stacks: string[];
  apps: string[];
  pinned: boolean;
  backup: {
    bytes: number;
    /** Stack folders and volumes are in the backup */
    hasData: boolean;
    dataSkipped: boolean;
    /** When the keep-for setting will remove it */
    expiresAt?: string;
    deletedAt?: string;
    folders: string[];
    volumes: string[];
  };
  /** Newer changes that would be restored along with this one */
  newer: number;
  activityId?: string;
  restoreActivityId?: string;
}

const norm = (p?: string) => (p ? path.posix.normalize(p).replace(/\/+$/, '') : '');

function kindOf(r: MergeHistoryRecord): RestoreKind {
  if (r.type === 'STACK_DELETE' || r.id.startsWith('delete_')) return 'delete';
  if (r.type === 'COMPOSE_INSTALL') return 'install';
  return 'move';
}

/** Stack folders a change touched */
function touchedDirs(r: MergeHistoryRecord): Set<string> {
  const s = new Set<string>();
  if (r.targetDirectory) s.add(norm(r.targetDirectory));
  for (const sc of r.sourceConfigs || []) if (sc.workingDir) s.add(norm(sc.workingDir));
  for (const m of r.movedServices || []) if (m.workingDir) s.add(norm(m.workingDir));
  return s;
}

function stackNames(r: MergeHistoryRecord): string[] {
  const names = [r.targetStackName, ...(r.movedServices || []).map((m) => m.project), ...(r.sourceConfigs || []).map((s) => s.project)];
  return Array.from(new Set(names.filter((n) => n && n !== 'standalone')));
}

function appNames(r: MergeHistoryRecord): string[] {
  const moved = (r.movedServices || []).flatMap((m) => m.services);
  if (moved.length) return Array.from(new Set(moved));
  return Array.from(new Set((r.affectedServices || []).map((a) => a.replace(new RegExp(`^${r.targetStackName}[-_]`), '').replace(/[-_]\d+$/, ''))));
}

const joinNames = (a: string[]) => (a.length <= 1 ? a.join('') : a.length === 2 ? `${a[0]} and ${a[1]}` : a.length === 3 ? `${a[0]}, ${a[1]} and ${a[2]}` : `${a.length} apps`);

function titleOf(r: MergeHistoryRecord): { title: string; detail?: string } {
  const kind = kindOf(r);
  if (kind === 'delete') {
    const n = r.deletedStack?.serviceCount ?? 0;
    return { title: `Deleted ${r.targetStackName}`, detail: n ? `${n} app${n === 1 ? '' : 's'}` : 'empty stack' };
  }
  if (kind === 'install') return { title: `Installed apps into ${r.targetStackName}` };
  const from = (r.movedServices || []).map((m) => m.project).filter((p) => p && p !== r.targetStackName);
  const apps = appNames(r);
  return {
    title: `Moved ${joinNames(apps) || 'apps'} to ${r.targetStackName}`,
    detail: from.length ? `from ${joinNames(Array.from(new Set(from)))}` : undefined,
  };
}

function backupExists(r: MergeHistoryRecord): boolean {
  return !r.backupDeletedAt && Boolean(r.backupArchiveDir) && fs.existsSync(r.backupArchiveDir);
}

function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
    }
  } catch {
    // missing
  }
  return total;
}

function stateOf(r: MergeHistoryRecord): RestoreState {
  if (r.failed) return 'failed';
  if (r.status === 'reverted') return 'restored';
  if (!backupExists(r)) return 'archived';
  return 'available';
}

/** Changes that must be restored together with `target`, newest first (target last). */
function chainFor(target: MergeHistoryRecord, all: MergeHistoryRecord[]): MergeHistoryRecord[] {
  const touched = touchedDirs(target);
  const newer = all
    .filter((r) => r.id !== target.id && r.timestamp > target.timestamp && r.status !== 'reverted' && !r.failed)
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1)); // oldest first
  const chain: MergeHistoryRecord[] = [];
  for (const r of newer) {
    const dirs = touchedDirs(r);
    if ([...dirs].some((d) => touched.has(d))) {
      chain.push(r);
      dirs.forEach((d) => touched.add(d));
    }
  }
  return [...chain.reverse(), target];
}

function toPoint(r: MergeHistoryRecord, all: MergeHistoryRecord[], keepDays: number): RestorePoint {
  const { title, detail } = titleOf(r);
  const state = stateOf(r);
  const exists = backupExists(r);
  const archives = r.dataArchives || [];
  return {
    id: r.id,
    kind: kindOf(r),
    title,
    detail,
    at: r.timestamp,
    state,
    restoredAt: r.revertedAt,
    stacks: stackNames(r),
    apps: appNames(r),
    pinned: Boolean(r.pinned),
    backup: {
      bytes: exists ? dirBytes(r.backupArchiveDir) : 0,
      hasData: archives.length > 0,
      dataSkipped: Boolean(r.dataBackupSkipped),
      expiresAt: exists && !r.pinned && keepDays ? new Date(new Date(r.timestamp).getTime() + keepDays * 86400000).toISOString() : undefined,
      deletedAt: r.backupDeletedAt,
      folders: archives.filter((a) => a.kind === 'directory').map((a) => a.source),
      volumes: archives.filter((a) => a.kind === 'volume').map((a) => a.source),
    },
    newer: state === 'available' ? chainFor(r, all).length - 1 : 0,
    activityId: r.activityId,
    restoreActivityId: r.revertActivityId,
  };
}

export function listRestorePoints(): { points: RestorePoint[]; storage: { bytes: number; keepDays: number; count: number } } {
  const all = getMergeHistory();
  const { keepDays } = getRestoreSettings();
  const points = all.map((r) => toPoint(r, all, keepDays));
  const bytes = points.reduce((s, p) => s + p.backup.bytes, 0);
  return { points, storage: { bytes, keepDays, count: points.filter((p) => p.backup.bytes > 0).length } };
}

export function getRestorePoint(id: string): RestorePoint | undefined {
  const all = getMergeHistory();
  const r = all.find((x) => x.id === id);
  return r ? toPoint(r, all, getRestoreSettings().keepDays) : undefined;
}

// ----------------------------------------------------------------------------
// Review: what a restore will do, and whether anything changed since
// ----------------------------------------------------------------------------

export interface RestoreCheck {
  level: 'ok' | 'warn' | 'block';
  message: string;
}

export interface RestorePlan {
  point: RestorePoint;
  /** Newest first; the chosen change is last */
  changes: { point: RestorePoint; actions: string[] }[];
  checks: RestoreCheck[];
  canRestore: boolean;
  /** Only for a single deleted stack: put files back without starting it */
  canRestoreFilesOnly: boolean;
}

const same = (a?: string | null, b?: string | null) => (a || '').replace(/\s+$/g, '').trim() === (b || '').replace(/\s+$/g, '').trim();

function actionsFor(r: MergeHistoryRecord): string[] {
  const kind = kindOf(r);
  if (kind === 'delete') {
    const out = [`Recreate ${r.targetDirectory}`];
    if ((r.dataArchives || []).length) out.push(`Restore its files${(r.dataArchives || []).some((a) => a.kind === 'volume') ? ' and volumes' : ''} from the backup`);
    else if (r.dataBackupSkipped) out.push('Restore the compose file only (the data backup was skipped)');
    else out.push('Restore the compose file');
    if ((r.deletedStack?.serviceCount ?? 0) > 0) out.push(`Start ${r.targetStackName}`);
    return out;
  }
  const apps = appNames(r);
  const from = Array.from(new Set((r.movedServices || []).map((m) => m.project).filter((p) => p !== r.targetStackName)));
  const out = [`Stop ${joinNames(apps)} in ${r.targetStackName}`];
  out.push(`Put back the compose files of ${joinNames([r.targetStackName, ...from])}`);
  if (from.length) out.push(`Start ${joinNames(apps)} in ${joinNames(from)} again`);
  if (!r.preMergeComposeContent && !r.targetComposeBackupPath) out.push(`Leave ${r.targetStackName} empty (the move created it)`);
  return out;
}

export async function planRestore(id: string): Promise<RestorePlan | null> {
  const all = getMergeHistory();
  const target = all.find((r) => r.id === id);
  if (!target) return null;
  const keepDays = getRestoreSettings().keepDays;
  const point = toPoint(target, all, keepDays);
  const checks: RestoreCheck[] = [];

  if (point.state === 'restored') checks.push({ level: 'block', message: 'This change was already restored.' });
  if (point.state === 'failed') checks.push({ level: 'block', message: 'This change didn’t finish and was put back automatically, so there’s nothing to restore.' });
  if (point.state === 'archived') checks.push({ level: 'block', message: 'The backup for this change was removed, so it can’t be restored.' });

  const chain = point.state === 'available' ? chainFor(target, all) : [target];
  for (const r of chain) {
    if (r.id !== target.id && !backupExists(r)) {
      checks.push({ level: 'block', message: `“${titleOf(r).title}” has to be restored first, but its backup was removed.` });
    }
    if (backupExists(r)) {
      for (const a of r.dataArchives || []) {
        if (!fs.existsSync(a.archiveFile)) checks.push({ level: 'warn', message: `Part of the backup is missing (${a.source}). The rest will still be restored.` });
      }
    }
  }

  // Has anything changed since? Compare each stack with how the newest change in the chain left it.
  if (point.state === 'available' && !checks.some((c) => c.level === 'block')) {
    const expected = new Map<string, { content: string | null; by: MergeHistoryRecord }>(); // compose path -> expected content (null = folder deleted)
    const unknown = new Set<string>();
    for (const r of [...chain].reverse()) {
      // oldest → newest, so the newest change wins
      if (kindOf(r) === 'delete') {
        expected.set(path.posix.join(norm(r.targetDirectory), 'docker-compose.yml'), { content: null, by: r });
      } else if (r.resultFiles?.length) {
        for (const f of r.resultFiles) expected.set(norm(f.path), { content: f.content, by: r });
      } else {
        unknown.add(r.targetStackName);
      }
    }
    for (const [file, exp] of expected) {
      const stack = path.posix.basename(path.posix.dirname(file));
      if (exp.content === null) {
        if (!(await hostDirectoryIsFree(path.posix.dirname(file)))) {
          checks.push({
            level: 'warn',
            message: `There are already files in ${path.posix.dirname(file)}. Restoring leaves them as they are instead of copying the backed-up files over them, and puts the backed-up compose file back.`,
          });
        }
        continue;
      }
      const current = await readHostFile(file).catch(() => null);
      if (current === null) {
        checks.push({ level: 'warn', message: `${stack}’s compose file is missing now. Restoring puts the backed-up version back.` });
      } else if (!same(current, exp.content)) {
        checks.push({
          level: 'warn',
          message: `${stack}’s compose file was edited after “${titleOf(exp.by).title}”. Restoring replaces those edits with the version from before.`,
        });
      }
    }
    for (const s of unknown) {
      checks.push({ level: 'warn', message: `This change to ${s} was made before Manifexus recorded results, so it can’t check whether ${s} changed since.` });
    }
    if (!checks.length) checks.push({ level: 'ok', message: 'Nothing has changed since. It’s safe to restore.' });
  }

  return {
    point,
    changes: chain.map((r) => ({ point: toPoint(r, all, keepDays), actions: actionsFor(r) })),
    checks,
    canRestore: point.state === 'available' && !checks.some((c) => c.level === 'block'),
    canRestoreFilesOnly: point.state === 'available' && chain.length === 1 && kindOf(target) === 'delete',
  };
}

// ----------------------------------------------------------------------------
// Running a restore (one change, or several in order)
// ----------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Emit = (e: any) => void;

/**
 * Restores `id` and any newer changes it depends on, newest first, as one run.
 * One change: its own steps. Several: one step per change, with the current action as detail.
 * Stops at the first failure; changes already restored stay restored.
 */
export async function executeRestore(id: string, emit: Emit, opts: { filesOnly?: boolean } = {}): Promise<void> {
  const plan = await planRestore(id);
  if (!plan) {
    emit({ type: 'failed', log: 'This change is no longer in Restore.' });
    return;
  }
  if (!plan.canRestore) {
    emit({ type: 'failed', log: plan.checks.find((c) => c.level === 'block')?.message || 'This change can’t be restored.' });
    return;
  }
  const changes = plan.changes;

  if (changes.length === 1) {
    await executeStreamingRevert(changes[0].point.id, emit, { startApps: !(opts.filesOnly && plan.canRestoreFilesOnly) });
    return;
  }

  changes.forEach((c, i) => emit({ type: 'step_update', stepIndex: i + 1, stepId: c.point.id, stepName: c.point.title, status: 'pending' }));
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const started = Date.now();
    emit({ type: 'step_update', stepIndex: i + 1, stepId: c.point.id, stepName: c.point.title, status: 'running' });
    let failure: string | undefined;
    await executeStreamingRevert(c.point.id, (e) => {
      if (e.type === 'log' && e.log) emit({ type: 'log', stepIndex: i + 1, log: e.log });
      else if (e.type === 'failed') failure = e.log || 'Restore failed';
    });
    if (failure) {
      emit({ type: 'step_update', stepIndex: i + 1, stepId: c.point.id, stepName: c.point.title, status: 'failed', durationMs: Date.now() - started });
      const done = i;
      emit({
        type: 'failed',
        log: `${failure}${done ? ` The ${done} newer change${done === 1 ? ' was' : 's were'} restored; the rest were left as they are.` : ''}`,
      });
      return;
    }
    emit({ type: 'step_update', stepIndex: i + 1, stepId: c.point.id, stepName: c.point.title, status: 'success', durationMs: Date.now() - started });
  }
  emit({ type: 'completed', payload: { restored: changes.length } });
}

// ----------------------------------------------------------------------------
// Backups: pin, delete, keep-for, archive
// ----------------------------------------------------------------------------

export function setPinned(id: string, pinned: boolean): RestorePoint | undefined {
  const r = getHistoryRecordById(id);
  if (!r) return undefined;
  r.pinned = pinned;
  saveMergeHistoryRecord(r);
  record('info', 'backup', `${pinned ? 'Pinned' : 'Unpinned'} the backup of “${titleOf(r).title}”`, { id });
  return getRestorePoint(id);
}

/** Removes the saved copy only. Live stacks and their data are never touched. */
export function deleteBackup(id: string, reason: 'manual' | 'expired' = 'manual'): boolean {
  const r = getHistoryRecordById(id);
  if (!r) return false;
  const root = resolveBackupDir();
  if (r.backupArchiveDir && norm(r.backupArchiveDir).startsWith(norm(root) + '/')) {
    try {
      fs.rmSync(r.backupArchiveDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  r.backupDeletedAt = new Date().toISOString();
  saveMergeHistoryRecord(r);
  record('info', 'backup', `${reason === 'expired' ? 'Removed an expired backup' : 'Deleted the backup'} of “${titleOf(r).title}”`, { id, dir: r.backupArchiveDir });
  return true;
}

/** Removes archived entries (whose backups are already gone) from the list. */
export function clearArchive(ids?: string[]): number {
  const archived = getMergeHistory().filter((r) => stateOf(r) === 'archived' && (!ids || ids.includes(r.id)));
  removeHistoryRecords(archived.map((r) => r.id));
  if (archived.length) record('info', 'backup', `Removed ${archived.length} archived change${archived.length === 1 ? '' : 's'} from Restore`);
  return archived.length;
}

/** Applies the keep-for setting: backups older than it are removed unless pinned. */
export function enforceBackupRetention(): void {
  const { keepDays } = getRestoreSettings();
  if (!keepDays) return;
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString();
  for (const r of getMergeHistory()) {
    if (!r.pinned && r.timestamp < cutoff && backupExists(r)) deleteBackup(r.id, 'expired');
  }
}

// ----------------------------------------------------------------------------
// Browse, download, copy elsewhere
// ----------------------------------------------------------------------------

export interface BackupFile {
  /** Which part of the backup: "Compose files", a folder path or a volume name */
  group: string;
  path: string;
  bytes: number;
  /** index into dataArchives, or -1 for files saved directly in the snapshot */
  archive: number;
}

function runTar(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      if (out.length < 8 * 1024 * 1024) out += d;
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `tar exited ${code}`))));
  });
}

const COMPOSE_LABELS: Record<string, string> = {
  'target-docker-compose.pre-merge.yml': 'docker-compose.yml',
  'target-.env.pre-merge': '.env',
};

export async function listBackupFiles(id: string): Promise<{ files: BackupFile[]; truncated: boolean } | null> {
  const r = getHistoryRecordById(id);
  if (!r || !backupExists(r)) return null;
  const files: BackupFile[] = [];
  let truncated = false;
  for (const f of fs.readdirSync(r.backupArchiveDir)) {
    const p = path.join(r.backupArchiveDir, f);
    if (!fs.statSync(p).isFile()) continue;
    const label = COMPOSE_LABELS[f] ? `${r.targetStackName}/${COMPOSE_LABELS[f]}` : f.replace('.docker-compose.pre-merge.yml', '/docker-compose.yml');
    if (files.some((x) => x.archive === -1 && x.path === label)) continue; // same file saved twice
    files.push({ group: 'Compose files', path: label, bytes: fs.statSync(p).size, archive: -1 });
  }
  const archives = r.dataArchives || [];
  for (let i = 0; i < archives.length; i++) {
    const a = archives[i];
    if (!fs.existsSync(a.archiveFile)) continue;
    try {
      const listing = await runTar(['-tzvf', a.archiveFile]);
      for (const line of listing.split('\n')) {
        // -rw-r--r-- user/group 1234 2026-09-26 18:00 ./config/app.ini
        const m = line.match(/^(\S)\S*\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.*)$/);
        if (!m || m[1] === 'd') continue;
        const rel = m[3].replace(/^\.\//, '').replace(/ -> .*$/, '');
        if (!rel) continue;
        files.push({ group: a.kind === 'volume' ? `Volume ${a.source}` : a.source, path: rel, bytes: Number(m[2]), archive: i });
        if (files.length >= 5000) {
          truncated = true;
          break;
        }
      }
    } catch {
      // unreadable archive: skip
    }
    if (truncated) break;
  }
  return { files, truncated };
}

/** Streams one file out of a backup. */
export function streamBackupFile(id: string, archive: number, filePath: string, res: Response): boolean {
  const r = getHistoryRecordById(id);
  if (!r || !backupExists(r)) return false;
  const name = path.posix.basename(filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  if (archive < 0) {
    const label = Object.entries(COMPOSE_LABELS).find(([, v]) => filePath === `${r.targetStackName}/${v}`)?.[0];
    const f = label || (filePath.endsWith('/docker-compose.yml') ? `${filePath.split('/')[0]}.docker-compose.pre-merge.yml` : '');
    const full = path.join(r.backupArchiveDir, f);
    if (!f || !fs.existsSync(full) || !full.startsWith(r.backupArchiveDir)) return false;
    fs.createReadStream(full).pipe(res);
    return true;
  }
  const a = (r.dataArchives || [])[archive];
  if (!a || !fs.existsSync(a.archiveFile)) return false;
  const p = spawn('tar', ['-xzOf', a.archiveFile, '--', `./${filePath}`]);
  p.stdout.pipe(res);
  p.on('error', () => res.end());
  return true;
}

/** Streams the whole backup as one .tar.gz. */
export function streamBackupArchive(id: string, res: Response): boolean {
  const r = getHistoryRecordById(id);
  if (!r || !backupExists(r)) return false;
  const day = r.timestamp.slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="manifexus-backup-${r.targetStackName}-${day}.tar.gz"`);
  res.setHeader('Content-Type', 'application/gzip');
  const p = spawn('tar', ['-czf', '-', '-C', path.dirname(r.backupArchiveDir), path.basename(r.backupArchiveDir)]);
  p.stdout.pipe(res);
  p.on('error', () => res.end());
  record('info', 'backup', `Downloaded the backup of “${titleOf(r).title}”`, { id });
  return true;
}

/** Copies the backed-up folders and volumes into another folder, leaving everything else alone. */
export async function restoreToFolder(id: string, destination: string, log: (m: string) => void): Promise<string[]> {
  const r = getHistoryRecordById(id);
  if (!r || !backupExists(r)) throw new Error('The backup for this change is no longer available.');
  const dest = norm(destination.trim());
  if (!dest.startsWith('/') || dest.split('/').filter(Boolean).length < 2) throw new Error('Choose a full folder path, like /home/you/restored.');
  const archives = (r.dataArchives || []).filter((a) => fs.existsSync(a.archiveFile));
  if (!archives.length) throw new Error('This backup has no folders or volumes to copy (only compose files).');
  const targets = archives.map((a) =>
    archives.length === 1 ? dest : path.posix.join(dest, a.kind === 'volume' ? `volume-${a.source}` : path.posix.basename(a.source))
  );
  for (const t of targets) {
    if (!(await hostDirectoryIsFree(t))) throw new Error(`${t} already has files in it. Choose an empty or new folder.`);
  }
  for (let i = 0; i < archives.length; i++) {
    log(`Copying ${archives[i].source} into ${targets[i]}…`);
    await extractArchiveTo(archives[i], targets[i]);
  }
  // Compose files that were saved alongside, for reference
  log('Done.');
  record('info', 'backup', `Restored the backup of “${titleOf(r).title}” into ${dest}`, { id, targets });
  return targets;
}

// ----------------------------------------------------------------------------
// One-time fresh start when Restore replaces the old History screen
// ----------------------------------------------------------------------------

/**
 * Clears entries left by the old History screen, once. Backups of moves are copies of stacks that
 * still exist, so they go. Backups of deleted stacks are the only copy of those stacks, so they
 * stay (they can be deleted by hand from Restore, with a warning).
 */
export function freshStartOnce(): void {
  const root = resolveBackupDir();
  const flag = path.join(root, '.restore-fresh-start');
  if (fs.existsSync(flag)) return;
  const all = getMergeHistory();
  // A deleted stack that was already brought back exists again, so its backup is no longer the only copy
  const keep = all.filter((r) => kindOf(r) === 'delete' && r.status !== 'reverted' && !r.failed && backupExists(r));
  const drop = all.filter((r) => !keep.includes(r));
  for (const r of drop) {
    if (r.backupArchiveDir && norm(r.backupArchiveDir).startsWith(norm(root) + '/')) {
      try {
        fs.rmSync(r.backupArchiveDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
  removeHistoryRecords(drop.map((r) => r.id));
  // Leftover move snapshots no entry points to (copies of stacks that still exist)
  const referenced = new Set(keep.map((r) => norm(r.backupArchiveDir)));
  try {
    for (const f of fs.readdirSync(root)) {
      const p = norm(path.join(root, f));
      if (/^snapshot_(merge|install)_/.test(f) && !referenced.has(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
  try {
    fs.writeFileSync(flag, new Date().toISOString());
  } catch {
    // ignore
  }
  record('info', 'backup', `Restore fresh start: cleared ${drop.length} old entr${drop.length === 1 ? 'y' : 'ies'}; kept ${keep.length} backup${keep.length === 1 ? '' : 's'} of deleted stacks`, {
    kept: keep.map((r) => r.id),
    removed: drop.map((r) => r.id),
  });
}
