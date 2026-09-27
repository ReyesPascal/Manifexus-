/**
 * Restore: every change Manifexus makes (moving apps, deleting a stack, restoring) keeps a backup,
 * and can be restored later.
 *
 *  - One pass per stack: restoring a change also covers newer changes to the same stacks. Instead of
 *    undoing them one by one, it works out how each stack looked before the oldest of them and puts
 *    each stack back once.
 *  - Restores are changes too: every restore saves how the stacks looked just before it, so a
 *    restore can itself be restored.
 *  - Checks: before restoring, compares each stack with how the last change left it.
 *  - Standalone apps (docker run) that were moved into a stack are recreated as they were.
 *  - Backups: storage, keep-for setting, pins, deleting one or many, browsing and downloading.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { Response } from 'express';
import yaml from 'yaml';
import {
  getMergeHistory,
  getHistoryRecordById,
  saveMergeHistoryRecord,
  removeHistoryRecords,
  resolveBackupDir,
  type MergeHistoryRecord,
} from './historyService';
import { readHostFile, writeHostFile, createHostDirectory, forceRemoveContainer } from './hostFsService';
import {
  hostDirectoryIsFree,
  extractArchiveTo,
  restoreStackData,
  archiveStackData,
  runComposeCapture,
  composeErrorTail,
  removeHostDirectory,
  getProjectVolumes,
  removeVolume,
  type DataArchiveEntry,
} from './dataBackupService';
import { queryDockerEngine } from './dockerService';
import { record, currentActivityId } from './activityLog';

// ----------------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------------


/** Services in a compose file whose container_name is taken by a container of a different stack */
async function heldElsewhere(compose: string, project: string): Promise<{ service: string; name: string; owner: string }[]> {
  let services: Record<string, { container_name?: string }> = {};
  try {
    services = yaml.parse(compose)?.services || {};
  } catch {
    return [];
  }
  const out: { service: string; name: string; owner: string }[] = [];
  for (const [service, def] of Object.entries(services)) {
    const name = def?.container_name;
    if (!name) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = await queryDockerEngine<any>(`/containers/${encodeURIComponent(name)}/json`);
      const labels = c?.Config?.Labels || {};
      const owner = labels['com.docker.compose.project'] || '';
      // Compose only adopts a container it made for this very service; anything else is in the way
      const adopted = owner === project && labels['com.docker.compose.service'] === service && labels['com.docker.compose.oneoff'] === 'False';
      if (!adopted) out.push({ service, name, owner });
    } catch {
      // no container by that name: nothing in the way
    }
  }
  return out;
}

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

export type RestoreKind = 'move' | 'delete' | 'install' | 'restore';
export type RestoreState = 'available' | 'restored' | 'failed' | 'archived';

export interface RestorePoint {
  id: string;
  kind: RestoreKind;
  /** "Moved kavita to music-stack", "Deleted spiderman", "Restored luke-stack" */
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
  /** A deleted stack that was never brought back: its backup is the only copy */
  onlyCopy: boolean;
  /** A deleted stack that had no apps */
  emptyStack: boolean;
  activityId?: string;
  restoreActivityId?: string;
}

const norm = (p?: string) => (p ? path.posix.normalize(p).replace(/\/+$/, '') : '');

function kindOf(r: MergeHistoryRecord): RestoreKind {
  if (r.type === 'RESTORE') return 'restore';
  if (r.type === 'STACK_DELETE' || r.id.startsWith('delete_')) return 'delete';
  if (r.type === 'COMPOSE_INSTALL') return 'install';
  return 'move';
}

/** Stack folders a change touched */
function touchedDirs(r: MergeHistoryRecord): Set<string> {
  const s = new Set<string>();
  if (r.type === 'RESTORE') {
    for (const d of r.dirSnapshots || []) s.add(norm(d.dir));
    return s;
  }
  if (r.targetDirectory) s.add(norm(r.targetDirectory));
  for (const sc of r.sourceConfigs || []) if (sc.workingDir) s.add(norm(sc.workingDir));
  for (const m of r.movedServices || []) if (m.workingDir) s.add(norm(m.workingDir));
  return s;
}

function stackNames(r: MergeHistoryRecord): string[] {
  if (r.type === 'RESTORE') return Array.from(new Set((r.dirSnapshots || []).map((d) => d.project)));
  const names = [r.targetStackName, ...(r.movedServices || []).map((m) => m.project), ...(r.sourceConfigs || []).map((s) => s.project)];
  return Array.from(new Set(names.filter((n) => n && n !== 'standalone')));
}

function appNames(r: MergeHistoryRecord): string[] {
  const moved = (r.movedServices || []).flatMap((m) => m.services);
  const standalone = (r.standaloneApps || []).map((a) => a.name);
  if (moved.length || standalone.length) return Array.from(new Set([...moved, ...standalone]));
  return Array.from(new Set((r.affectedServices || []).map((a) => a.replace(new RegExp(`^${r.targetStackName}[-_]`), '').replace(/[-_]\d+$/, ''))));
}

const joinNames = (a: string[]) => (a.length <= 1 ? a.join('') : a.length === 2 ? `${a[0]} and ${a[1]}` : a.length === 3 ? `${a[0]}, ${a[1]} and ${a[2]}` : `${a.length} apps`);

function titleOf(r: MergeHistoryRecord): { title: string; detail?: string } {
  const kind = kindOf(r);
  if (kind === 'restore') {
    const stacks = joinNames(stackNames(r)) || 'stacks';
    if (r.summary?.startsWith('undid')) return { title: `Undid a restore of ${stacks}`, detail: r.summary };
    return { title: `Restored ${stacks}`, detail: r.summary || undefined };
  }
  if (kind === 'delete') {
    const n = r.deletedStack?.serviceCount ?? 0;
    return { title: `Deleted ${r.targetStackName}`, detail: n ? `${n} app${n === 1 ? '' : 's'}` : 'empty stack' };
  }
  if (kind === 'install') return { title: `Installed apps into ${r.targetStackName}` };
  const from = (r.movedServices || []).map((m) => m.project).filter((p) => p && p !== r.targetStackName);
  if ((r.standaloneApps || []).length) from.push('standalone');
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
  const kind = kindOf(r);
  return {
    id: r.id,
    kind,
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
    onlyCopy: kind === 'delete' && state === 'available',
    emptyStack: kind === 'delete' && (r.deletedStack?.serviceCount ?? 0) === 0,
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
// Where each stack goes: one target per stack folder
// ----------------------------------------------------------------------------

interface StackTarget {
  dir: string;
  project: string;
  /** Should the stack exist after the restore? */
  exists: boolean;
  compose?: string | null;
  env?: string | null;
  /** Folder and volume backups to bring back if the folder is missing or empty now */
  data: DataArchiveEntry[];
  /** The stack loses apps (restore it first so container names and ports are free) */
  losesApps: boolean;
  /** When this state is from, for the review ("from Sep 26, 9:04 AM") */
  from: string;
}

function readSaved(content?: string, file?: string): string | undefined {
  if (content && content.trim()) return content;
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  return undefined;
}

function projectVolumesIn(archives: DataArchiveEntry[], project: string, dir: string): DataArchiveEntry[] {
  return archives.filter(
    (a) => (a.kind === 'directory' && norm(a.source) === dir) || (a.kind === 'volume' && a.volumeLabels?.['com.docker.compose.project'] === project)
  );
}

/** How `dir` looked just before change `r` */
function beforeOf(r: MergeHistoryRecord, dir: string): StackTarget {
  const at = r.timestamp;
  const archives = r.dataArchives || [];
  if (r.type === 'RESTORE') {
    const snap = (r.dirSnapshots || []).find((d) => norm(d.dir) === dir)!;
    return { dir, project: snap.project, exists: snap.existed, compose: snap.compose, env: snap.env, data: projectVolumesIn(archives, snap.project, dir), losesApps: false, from: at };
  }
  if (kindOf(r) === 'delete') {
    return {
      dir,
      project: r.deletedStack?.project || r.targetStackName,
      exists: true,
      compose: readSaved(r.preMergeComposeContent, r.targetComposeBackupPath) || 'services: {}\n',
      env: readSaved(r.preMergeEnvContent, r.targetEnvBackupPath) || null,
      data: projectVolumesIn(archives, r.deletedStack?.project || r.targetStackName, dir),
      losesApps: false,
      from: at,
    };
  }
  if (norm(r.targetDirectory) === dir) {
    const pre = readSaved(r.preMergeComposeContent, r.targetComposeBackupPath);
    return { dir, project: r.targetStackName, exists: Boolean(pre), compose: pre || null, env: undefined, data: projectVolumesIn(archives, r.targetStackName, dir), losesApps: true, from: at };
  }
  const sc = (r.sourceConfigs || []).find((x) => norm(x.workingDir) === dir);
  const mv = (r.movedServices || []).find((x) => norm(x.workingDir) === dir);
  const project = sc?.project || mv?.project || path.posix.basename(dir);
  return { dir, project, exists: true, compose: sc?.composeContent || null, env: undefined, data: projectVolumesIn(archives, project, dir), losesApps: false, from: at };
}

/** One target per stack: how it looked before the oldest change in the chain that touched it. */
function targetsFor(chain: MergeHistoryRecord[]): StackTarget[] {
  const oldestFirst = [...chain].reverse();
  const targets = new Map<string, StackTarget>();
  for (const r of oldestFirst) {
    for (const d of touchedDirs(r)) {
      if (!targets.has(d)) targets.set(d, beforeOf(r, d));
      else if (norm(r.targetDirectory) === d && r.type !== 'RESTORE') targets.get(d)!.losesApps = true;
    }
  }
  // Data: if the oldest change didn't save the folder, use the closest newer backup of it
  for (const t of targets.values()) {
    if (!t.exists || t.data.length) continue;
    for (const r of oldestFirst) {
      const found = projectVolumesIn(r.dataArchives || [], t.project, t.dir).filter((a) => fs.existsSync(a.archiveFile));
      if (found.length) {
        t.data = found;
        break;
      }
    }
  }
  // Stacks losing apps first, stacks going away next, then the rest
  return Array.from(targets.values()).sort((a, b) => Number(b.losesApps) - Number(a.losesApps) || Number(a.exists) - Number(b.exists));
}

/** Standalone (docker run) apps the chain moved into stacks, oldest change first */
function standaloneFor(chain: MergeHistoryRecord[]) {
  const seen = new Set<string>();
  const out: { name: string; spec: Record<string, unknown> }[] = [];
  for (const r of [...chain].reverse()) {
    for (const a of r.standaloneApps || []) {
      if (!seen.has(a.name)) {
        seen.add(a.name);
        out.push(a);
      }
    }
  }
  return out;
}

const servicesOf = (text?: string | null): string[] => {
  try {
    return Object.keys(yaml.parse(text || '')?.services || {});
  } catch {
    return [];
  }
};

// ----------------------------------------------------------------------------
// Review: what a restore will do, and whether anything changed since
// ----------------------------------------------------------------------------

export interface RestoreCheck {
  level: 'ok' | 'warn' | 'block';
  message: string;
}

export interface RestorePlan {
  point: RestorePoint;
  /** Every change this restore covers, newest first (the chosen one last) */
  changes: RestorePoint[];
  /** What happens to each stack, once */
  /** `from`: the moment each stack goes back to; `notes`: apps stopped/started and so on */
  stacks: { project: string; dir: string; action: string; from?: string; notes: string[] }[];
  checks: RestoreCheck[];
  canRestore: boolean;
  /** Only for a single deleted stack: put files back without starting it */
  canRestoreFilesOnly: boolean;
}

const same = (a?: string | null, b?: string | null) => (a || '').replace(/\s+$/g, '').trim() === (b || '').replace(/\s+$/g, '').trim();

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
      checks.push({ level: 'block', message: `“${titleOf(r).title}” is covered by this restore, but its backup was removed.` });
    }
  }

  const targets = point.state === 'available' ? targetsFor(chain) : [];
  const stacks: RestorePlan['stacks'] = [];
  const blocked = checks.some((c) => c.level === 'block');

  if (!blocked && point.state === 'available') {
    // Expected current state = how the newest change touching each stack left it
    const expected = new Map<string, { content: string | null; by: MergeHistoryRecord } | 'unknown'>();
    for (const r of [...chain].reverse()) {
      if (kindOf(r) === 'delete') expected.set(path.posix.join(norm(r.targetDirectory), 'docker-compose.yml'), { content: null, by: r });
      else if (r.resultFiles?.length) for (const f of r.resultFiles) expected.set(norm(f.path), { content: f.content, by: r });
      else for (const d of touchedDirs(r)) expected.set(path.posix.join(d, 'docker-compose.yml'), 'unknown');
    }

    for (const t of targets) {
      const file = path.posix.join(t.dir, 'docker-compose.yml');
      const free = await hostDirectoryIsFree(t.dir);
      const current = free ? null : await readHostFile(file).catch(() => null);
      const exp = expected.get(file);
      if (exp === 'unknown') {
        checks.push({ level: 'warn', message: `A change to ${t.project} was made before Manifexus recorded results, so it can’t check whether ${t.project} changed since.` });
      } else if (exp) {
        if (exp.content === null && !free) {
          checks.push({
            level: 'warn',
            message: `There are files in ${t.dir} now. ${t.exists ? 'They’re left as they are, and the backed-up compose file is put back.' : 'They’re saved in this restore’s backup before the folder is removed.'}`,
          });
        } else if (exp.content !== null && current !== null && !same(current, exp.content)) {
          checks.push({ level: 'warn', message: `${t.project}’s compose file was edited after “${titleOf(exp.by).title}”. Restoring replaces those edits.` });
        } else if (exp.content !== null && current === null) {
          checks.push({ level: 'warn', message: `${t.project}’s compose file is missing now. Restoring puts the backed-up version back.` });
        }
      }

      // What happens to this stack, in one line
      const now = servicesOf(current);
      const then = servicesOf(t.compose);
      const stops = now.filter((n) => !then.includes(n));
      const starts = then.filter((n) => !now.includes(n));
      let action: string;
      if (!t.exists) action = free ? `${t.project} is already gone` : `Remove ${t.project}`;
      else if (free) action = `Bring back ${t.project}${t.data.length ? ' with its files' : ''}`;
      else action = `Put ${t.project} back as it was`;
      const bits = [
        stops.length ? `stops ${joinNames(stops)}` : '',
        starts.length ? `starts ${joinNames(starts)}` : '',
        !t.exists && !free ? 'its files are saved first, so you can undo this' : '',
      ].filter(Boolean);
      stacks.push({ project: t.project, dir: t.dir, action, from: t.from, notes: bits });
    }

    for (const a of standaloneFor(chain)) {
      stacks.push({ project: a.name, dir: '', action: `Recreate ${a.name} as a standalone app`, notes: ['with the same settings, volumes and ports it had'] });
    }
    for (const r of chain) {
      // Moves from before standalone apps were saved can't recreate them
      const lost =
        kindOf(r) === 'move' && r.standaloneApps === undefined
          ? (r.sourceConfigs || []).filter((sc) => sc.project === 'standalone').flatMap((sc) => sc.containers.map((c) => c.name))
          : [];
      if (lost.length) {
        checks.push({
          level: 'warn',
          message: `${joinNames(lost)} ${lost.length === 1 ? 'was a standalone app' : 'were standalone apps'} when “${titleOf(r).title}” happened, which was before Manifexus saved standalone apps. ${lost.length === 1 ? 'It' : 'They'} can’t be recreated; ${lost.length === 1 ? 'its' : 'their'} data is kept.`,
        });
      }
    }
    if (!checks.length) checks.push({ level: 'ok', message: 'Nothing has changed since. It’s safe to restore.' });
  }

  return {
    point,
    changes: chain.map((r) => toPoint(r, all, keepDays)),
    stacks,
    checks,
    canRestore: point.state === 'available' && !checks.some((c) => c.level === 'block'),
    canRestoreFilesOnly: point.state === 'available' && chain.length === 1 && kindOf(target) === 'delete',
  };
}

// ----------------------------------------------------------------------------
// Running a restore: each stack once, and a backup of how things were just before
// ----------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Emit = (e: any) => void;

async function containerExists(name: string): Promise<boolean> {
  try {
    await queryDockerEngine(`/containers/${encodeURIComponent(name)}/json`);
    return true;
  } catch {
    return false;
  }
}

export async function executeRestore(id: string, emit: Emit, opts: { filesOnly?: boolean } = {}): Promise<void> {
  const plan = await planRestore(id);
  if (!plan) return emit({ type: 'failed', log: 'This change is no longer in Restore.' });
  if (!plan.canRestore) return emit({ type: 'failed', log: plan.checks.find((c) => c.level === 'block')?.message || 'This change can’t be restored.' });

  const all = getMergeHistory();
  const chain = plan.changes.map((c) => all.find((r) => r.id === c.id)!).filter(Boolean);
  const targets = targetsFor(chain);
  const standalone = standaloneFor(chain);
  const startApps = !(opts.filesOnly && plan.canRestoreFilesOnly);

  // This restore's own backup: how every stack looked just before it
  const restoreId = `restore_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const snapDir = path.join(resolveBackupDir(), `snapshot_${restoreId}`);
  fs.mkdirSync(snapDir, { recursive: true });
  const snapshots: NonNullable<MergeHistoryRecord['dirSnapshots']> = [];
  const archives: DataArchiveEntry[] = [];
  const resultFiles: { path: string; content: string | null }[] = [];
  const recreated: string[] = [];

  const steps = [
    ...targets.map((t) => ({ name: !t.exists ? `Removing ${t.project}` : `Restoring ${t.project}` })),
    ...(standalone.length ? [{ name: `Recreating ${joinNames(standalone.map((a) => a.name))}` }] : []),
  ];
  steps.forEach((s, i) => emit({ type: 'step_update', stepIndex: i + 1, stepName: s.name, status: 'pending' }));
  let i = 0;
  const run = async (fn: (log: (m: string) => void) => Promise<void>) => {
    const n = ++i;
    const started = Date.now();
    emit({ type: 'step_update', stepIndex: n, stepName: steps[n - 1].name, status: 'running' });
    const log = (m: string) => emit({ type: 'log', stepIndex: n, log: m });
    try {
      await fn(log);
    } catch (err) {
      emit({ type: 'step_update', stepIndex: n, stepName: steps[n - 1].name, status: 'failed', durationMs: Date.now() - started });
      throw err;
    }
    emit({ type: 'step_update', stepIndex: n, stepName: steps[n - 1].name, status: 'success', durationMs: Date.now() - started });
  };

  // Undoing a restore: take away the standalone apps it recreated (their data stays)
  for (const r of chain) {
    for (const name of r.recreatedApps || []) {
      if (await containerExists(name)) await forceRemoveContainer(name);
    }
  }

  let failure: string | undefined;
  try {
    for (const t of targets) {
      await run(async (log) => {
        const file = path.posix.join(t.dir, 'docker-compose.yml');
        const envFile = path.posix.join(t.dir, '.env');
        const free = await hostDirectoryIsFree(t.dir);
        const current = free ? null : await readHostFile(file).catch(() => null);
        const currentEnv = free ? null : await readHostFile(envFile).catch(() => null);
        snapshots.push({ dir: t.dir, project: t.project, existed: !free, compose: current, env: currentEnv });
        const safe = t.project.replace(/[^a-zA-Z0-9_.-]/g, '_');
        if (current !== null) fs.writeFileSync(path.join(snapDir, `${safe}.docker-compose.pre-merge.yml`), current);

        if (!t.exists) {
          if (free) {
            log(`${t.project} is already gone.`);
          } else {
            log(`Saving ${t.project}’s files first…`);
            archives.push(...(await archiveStackData({ project: t.project, workingDir: t.dir, archiveDir: snapDir, log })));
            const down = await runComposeCapture(t.dir, 'down -v --remove-orphans');
            if (!down.ok) log(composeErrorTail(down.output) || 'Couldn’t stop it cleanly; continuing.');
            for (const v of await getProjectVolumes(t.project)) await removeVolume(v.name);
            if (!(await removeHostDirectory(t.dir))) throw new Error(`Couldn’t remove ${t.dir}.`);
            const { unregisterCreatedStack } = await import('./stackService');
            unregisterCreatedStack(t.project);
            log(`Removed ${t.project}. Its files are in this restore’s backup.`);
          }
          resultFiles.push({ path: file, content: null });
          return;
        }

        if (free) {
          await createHostDirectory(t.dir);
          if (t.data.length) await restoreStackData(t.data, { log });
          else log('No saved files for this folder; putting the compose file back.');
        }
        const compose = t.compose && t.compose.trim() ? t.compose : 'services: {}\n';
        if (!(await writeHostFile(file, compose))) throw new Error(`Couldn’t write ${file}.`);
        if (t.env) await writeHostFile(envFile, t.env);
        log(`Put back ${t.project}’s compose file.`);
        resultFiles.push({ path: file, content: compose });

        const services = servicesOf(compose);
        if (free) {
          const { registerCreatedStack } = await import('./stackService');
          registerCreatedStack({ project: t.project, workingDir: t.dir, configFiles: file, serviceCount: services.length, source: 'provisioned' });
        }
        if (!startApps) {
          log('Left stopped. Start it from the dashboard when you’re ready.');
          return;
        }
        // An app this file lists whose name is still held by another stack is a leftover duplicate
        // (stacks giving apps back are put back first). Leave just that entry out instead of failing.
        const skipped = await heldElsewhere(compose, t.project);
        for (const h of skipped)
          log(
            h.owner && h.owner !== t.project
              ? `Left ${h.name} out: it’s running in ${h.owner}, and is also listed in this stack’s file.`
              : `Left ${h.name} out: a container with that name already exists that this stack’s file didn’t create.`
          );
        const keep = services.filter((n) => !skipped.some((h) => h.service === n));
        const namesOk = keep.every((n) => /^[A-Za-z0-9._-]+$/.test(n));
        if (services.length && !keep.length) {
          log(`${t.project}’s apps are all running in other stacks; nothing to start here.`);
          return;
        }
        // Compose makes the stack match the file: apps no longer in it are removed, missing ones started
        const up = await runComposeCapture(
          t.dir,
          !services.length ? 'down --remove-orphans' : skipped.length && namesOk ? `up -d --remove-orphans ${keep.join(' ')}` : 'up -d --remove-orphans'
        );
        if (!up.ok) {
          const why = composeErrorTail(up.output);
          throw new Error(`Docker couldn’t start ${t.project}${why ? `: ${why.split('\n').pop()}` : '.'}`);
        }
        log(services.length ? `${t.project} is running.` : `${t.project} has no apps.`);
      });
    }

    if (standalone.length) {
      await run(async (log) => {
        for (const a of standalone) {
          if (await containerExists(a.name)) {
            log(`${a.name} already exists; left as it is.`);
            continue;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const created = await queryDockerEngine<any>(`/containers/create?name=${encodeURIComponent(a.name)}`, 'POST', a.spec, undefined, { keepLabels: true });
          await queryDockerEngine(`/containers/${created.Id}/start`, 'POST');
          recreated.push(a.name);
          log(`${a.name} is running again as a standalone app.`);
        }
      });
    }
  } catch (err) {
    failure = (err as Error).message || 'Restore failed';
  }

  // Save this restore as a change of its own (even a partial one, so it can be put back)
  if (snapshots.length) {
    const titles = plan.changes.map((c) => c.title);
    const rec: MergeHistoryRecord = {
      id: restoreId,
      timestamp: new Date().toISOString(),
      targetStackName: snapshots[0].project,
      targetDirectory: snapshots[0].dir,
      backupArchiveDir: snapDir,
      sourceStacks: [],
      affectedServices: [],
      sourceConfigs: [],
      status: 'active',
      archiveSizeBytes: 0,
      summary:
        plan.point.kind === 'restore' && titles.length === 1
          ? `undid “${titles[0]}”`
          : titles.length === 1
            ? `to before “${titles[0]}”`
            : `to before ${titles.length} changes`,
      type: 'RESTORE',
      dirSnapshots: snapshots,
      dataArchives: archives,
      resultFiles,
      revertedIds: failure ? [] : chain.map((r) => r.id),
      recreatedApps: recreated,
      activityId: currentActivityId(),
      failed: failure && !resultFiles.length ? true : undefined,
    };
    saveMergeHistoryRecord(rec);
  } else {
    fs.rmSync(snapDir, { recursive: true, force: true });
  }

  if (failure) {
    emit({ type: 'failed', log: `${failure} Stacks already restored stay restored; this restore is saved in Restore so it can be put back.` });
    return;
  }

  // Mark what was restored. Undoing a restore brings the changes it had restored back into effect.
  const now = new Date().toISOString();
  const activityId = currentActivityId();
  for (const r of chain) {
    const fresh = getHistoryRecordById(r.id);
    if (!fresh) continue;
    fresh.status = 'reverted';
    fresh.revertedAt = now;
    fresh.revertActivityId = activityId;
    saveMergeHistoryRecord(fresh);
    if (fresh.type === 'RESTORE') {
      for (const rid of fresh.revertedIds || []) {
        const orig = getHistoryRecordById(rid);
        if (orig && !chain.some((c) => c.id === rid)) {
          orig.status = 'active';
          orig.revertedAt = undefined;
          orig.revertActivityId = undefined;
          saveMergeHistoryRecord(orig);
        }
      }
    }
  }
  emit({ type: 'completed', payload: { restored: chain.length } });
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

function removeBackupFiles(r: MergeHistoryRecord) {
  const root = resolveBackupDir();
  if (r.backupArchiveDir && norm(r.backupArchiveDir).startsWith(norm(root) + '/')) {
    try {
      fs.rmSync(r.backupArchiveDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/** Expired backups: the saved copy goes, the change stays in the Archive as history. */
function expireBackup(r: MergeHistoryRecord) {
  removeBackupFiles(r);
  r.backupDeletedAt = new Date().toISOString();
  saveMergeHistoryRecord(r);
  record('info', 'backup', `Removed an expired backup of “${titleOf(r).title}”`, { id: r.id });
}

/** Deletes changes and their backups (one or many). Live stacks and their data are never touched. */
export function deleteChanges(ids: string[]): number {
  const list = getMergeHistory().filter((r) => ids.includes(r.id));
  for (const r of list) removeBackupFiles(r);
  removeHistoryRecords(list.map((r) => r.id));
  if (list.length) {
    record('info', 'backup', `Deleted ${list.length} change${list.length === 1 ? '' : 's'} from Restore`, {
      removed: list.map((r) => ({ id: r.id, title: titleOf(r).title })),
    });
  }
  return list.length;
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
    if (!r.pinned && r.timestamp < cutoff && backupExists(r)) expireBackup(r);
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
