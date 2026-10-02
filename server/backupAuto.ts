/**
 * Automatic backups: every stack is backed up into the backup store when it first appears, and again every night,
 * in the background at the lowest priority. Nothing is ever locked or waits for them.
 *
 * What's kept: everything an app needs to come back after a crash or a fresh install:
 *   - the stack's folder (compose file, .env, everything in it),
 *   - each app's own folders and volumes (same rule as moves, so a move later only saves what changed),
 *   - folders outside the stack that only this stack's apps use (like a config folder in /opt), unless they're
 *     mostly media (a movie library) or very large,
 *   - a dump of each Postgres and MySQL/MariaDB database (a copy of a running database's files isn't always
 *     consistent; the dump always is).
 * Video, music and disk image files are left out everywhere (MEDIA_PATTERNS); .torrent files, posters, playlists
 * and settings are kept. Backups made before a change (move, delete, restore) still keep every file.
 *
 * Each item is its own snapshot at the same path a move uses, so the first move of an app only saves what
 * changed since the last automatic backup.
 */
import fs from 'fs';
import path from 'path';
import { getContainersList, getContainersListShared } from './dockerService';
import { discoverHostComposeStacks, isManifexusContainer } from './stackService';
import { appOwnData, runHelperDetailed, getProjectVolumes, formatBytes } from './dataBackupService';
import { backupToStore, storeUsable, storeUnusableReason, storeBytes, MEDIA_PATTERNS, type StoreItem } from './backupStore';
import { resolveBackupDir } from './historyService';
import { readJsonSafe, writeJsonAtomic } from './safeJson';
import { getConfig, saveConfig } from './storageService';
import { record } from './activityLog';
import type { DeepContainerMetadata } from '../src/types';

export interface StackBackupStatus {
  project: string;
  dir?: string;
  /** Last time a backup of this stack finished (even with a problem), and the last fully successful one */
  lastAt?: string;
  lastOkAt?: string;
  /** Size of everything kept for this stack, and how much the last backup added */
  bytes?: number;
  newBytes?: number;
  items?: { label: string; kind: 'folder' | 'volume' | 'database'; bytes: number }[];
  /** Left out on purpose, with why */
  skipped?: { path: string; reason: string; bytes?: number }[];
  /** What went wrong last time, in plain words */
  problem?: string;
}

export interface AutoBackupState {
  enabled: boolean;
  time: string;
  usable: boolean;
  unusableReason?: string;
  running?: { project: string; startedAt: string };
  queued: string[];
  stacks: StackBackupStatus[];
  storeBytes: number;
  freeBytes: number | null;
  nextAt?: string;
}

const DEFAULT_TIME = '03:00';
const statusFile = () => path.join(resolveBackupDir(), 'automatic-backups.json');
const readStatus = () => readJsonSafe<Record<string, StackBackupStatus>>(statusFile(), {});
function saveStatus(s: Record<string, StackBackupStatus>): void {
  fs.mkdirSync(path.dirname(statusFile()), { recursive: true });
  writeJsonAtomic(statusFile(), s);
}

export function autoBackupSettings(): { enabled: boolean; time: string } {
  const c = getConfig();
  const time = /^\d{2}:\d{2}$/.test(c.autoBackup?.time || '') ? c.autoBackup!.time! : DEFAULT_TIME;
  return { enabled: c.autoBackup?.enabled !== false, time };
}

let running: { project: string; startedAt: string } | undefined;
const queue: string[] = [];
let lastNightly = '';

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The next time the nightly backup runs */
function nextNightly(time: string): Date {
  const [h, m] = time.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

export async function autoBackupState(): Promise<AutoBackupState> {
  const { enabled, time } = autoBackupSettings();
  const usable = await storeUsable().catch(() => false);
  const status = readStatus();
  // Shown every few seconds: the shared look at Docker the dashboard also uses
  const { containers } = await getContainersListShared().catch(() => ({ containers: [] as DeepContainerMetadata[] }));
  const stacks = await currentStacks(containers);
  let free: number | null = null;
  try {
    const st = fs.statfsSync(resolveBackupDir());
    free = Number(st.bavail) * Number(st.bsize);
  } catch {
    free = null;
  }
  return {
    enabled,
    time,
    usable,
    unusableReason: usable ? undefined : storeUnusableReason(),
    running,
    queued: [...queue],
    stacks: stacks.map((s) => status[s.project] || { project: s.project, dir: s.dir }),
    storeBytes: storeBytes(),
    freeBytes: free,
    nextAt: enabled ? nextNightly(time).toISOString() : undefined,
  };
}

/** Back up these stacks soon (all stacks when none are named). Stacks already waiting aren't added twice. */
export function queueAutoBackup(projects?: string[]): void {
  void (async () => {
    const { containers } = await getContainersList();
    const all = (await currentStacks(containers)).map((s) => s.project);
    for (const p of projects?.length ? projects.filter((x) => all.includes(x)) : all) {
      if (!queue.includes(p) && running?.project !== p) queue.push(p);
    }
    void drain();
  })().catch((e) => record('warn', 'backup', 'Couldn’t start automatic backups', { error: String(e) }));
}

/** Starts the schedule: new stacks soon after they appear, every stack each night */
export function startAutoBackups(): void {
  // Soon after starting: stacks never backed up
  setTimeout(() => void checkForNewStacks(), 2 * 60 * 1000).unref?.();
  setInterval(() => void checkForNewStacks(), 10 * 60 * 1000).unref?.();
  setInterval(() => {
    const { enabled, time } = autoBackupSettings();
    if (!enabled) return;
    const now = new Date();
    const key = now.toDateString();
    const [h, m] = time.split(':').map(Number);
    if (lastNightly !== key && (now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m))) {
      lastNightly = key;
      // Started after tonight's time on the day it was installed: don't back everything up at once right away
      if (now.getTime() - processStart < 5 * 60 * 1000) return;
      record('info', 'backup', 'Nightly backup started');
      queueAutoBackup();
    }
  }, 60 * 1000).unref?.();
}
const processStart = Date.now();

async function checkForNewStacks(): Promise<void> {
  if (!autoBackupSettings().enabled) return;
  if (!(await storeUsable().catch(() => false))) return;
  const status = readStatus();
  const { containers } = await getContainersList();
  const fresh = (await currentStacks(containers)).filter((s) => !status[s.project]?.lastAt).map((s) => s.project);
  if (fresh.length) queueAutoBackup(fresh);
}

/** Every stack on the dashboard (including ones with no apps running), except Manifexus itself */
async function currentStacks(containers: DeepContainerMetadata[]): Promise<{ project: string; dir?: string; apps: DeepContainerMetadata[] }[]> {
  const map = new Map<string, { project: string; dir?: string; apps: DeepContainerMetadata[] }>();
  for (const c of containers) {
    const p = c.compose?.project;
    if (!p || isManifexusContainer(c)) continue;
    const s = map.get(p) || { project: p, dir: c.compose?.workingDir, apps: [] };
    s.apps.push(c);
    map.set(p, s);
  }
  for (const e of await discoverHostComposeStacks(containers).catch(() => [])) {
    if (!map.has(e.project) && !/manifexus/i.test(e.project)) map.set(e.project, { project: e.project, dir: e.workingDir, apps: [] });
  }
  return Array.from(map.values()).sort((a, b) => a.project.localeCompare(b.project));
}

async function drain(): Promise<void> {
  if (running) return;
  while (queue.length) {
    const project = queue.shift()!;
    running = { project, startedAt: new Date().toISOString() };
    try {
      await backUpStack(project);
    } catch (e) {
      const status = readStatus();
      status[project] = { ...(status[project] || { project }), lastAt: new Date().toISOString(), problem: (e as Error).message };
      saveStatus(status);
      record('warn', 'backup', `Automatic backup of ${project} didn’t finish`, { error: (e as Error).message });
    } finally {
      running = undefined;
    }
  }
}

/** Measures folders outside the stack: their size and how much of it is media */
async function measureOutside(dirs: string[]): Promise<{ bytes: number; media: number }[]> {
  if (!dirs.length) return [];
  const names = MEDIA_PATTERNS.map((p) => `-iname ${shellQuote(p)}`).join(' -o ');
  const script = dirs
    .map((_, i) => `t=$(du -sb /m${i} 2>/dev/null | cut -f1); m=$(find /m${i} -type f \\( ${names} \\) -printf '%s\\n' 2>/dev/null | awk '{s+=$1} END {print s+0}'); echo "dir${i}=\${t:-0} \${m:-0}"`)
    .join('\n');
  const r = await runHelperDetailed(script, dirs.map((d, i) => `${d}:/m${i}:ro`), 30 * 60 * 1000, [], { purpose: `Measure ${dirs.join(', ')}`, probe: true });
  return dirs.map((_, i) => {
    const m = r.output.match(new RegExp(`dir${i}=(\\d+) (\\d+)`));
    return { bytes: Number(m?.[1] || 0), media: Number(m?.[2] || 0) };
  });
}

const BIG_OUTSIDE = 50 * 1024 ** 3; // a folder outside the stack bigger than this is a library, not settings

/** Database containers and how to dump them (run in the helper, which reaches Docker) */
function dumpFor(c: DeepContainerMetadata): string | undefined {
  if (c.state !== 'running') return undefined;
  const image = (c.image || '').toLowerCase();
  const name = shellQuote((c.name || '').replace(/^\//, ''));
  if (/(^|\/)(postgres|postgis|timescaledb|pgvector)|immich.*postgres/.test(image)) {
    return `docker exec ${name} sh -c 'pg_dumpall -U "\${POSTGRES_USER:-postgres}"'`;
  }
  if (/(^|\/)(mariadb|mysql|percona)/.test(image) || /linuxserver\/mariadb/.test(image)) {
    return `docker exec ${name} sh -c 'if command -v mariadb-dump >/dev/null; then exec mariadb-dump --all-databases --single-transaction -uroot -p"\${MARIADB_ROOT_PASSWORD:-\$MYSQL_ROOT_PASSWORD}"; else exec mysqldump --all-databases --single-transaction -uroot -p"\${MYSQL_ROOT_PASSWORD:-\$MARIADB_ROOT_PASSWORD}"; fi'`;
  }
  return undefined;
}

async function backUpStack(project: string): Promise<void> {
  if (!(await storeUsable())) throw new Error(`The backup store can’t be used (${storeUnusableReason() || 'unknown reason'})`);
  const t0 = Date.now();
  const { containers } = await getContainersList();
  const stacks = await currentStacks(containers);
  const stack = stacks.find((s) => s.project === project);
  if (!stack) return; // gone meanwhile
  const stackDirs = stacks.map((s) => s.dir).filter(Boolean) as string[];
  const elsewhere = containers.filter((c) => c.compose?.project !== project);
  const { own, shared } = await appOwnData({
    apps: stack.apps.map((c) => ({ name: c.cleanName || c.name, workingDir: c.compose?.workingDir, mounts: c.mounts || [] })),
    stackDirs,
    sharedDirs: elsewhere.flatMap((c) => (c.mounts || []).filter((m) => m.type === 'bind' && m.source).map((m) => m.source)),
    sharedVolumes: elsewhere.flatMap((c) => (c.mounts || []).filter((m) => m.type === 'volume' && m.name).map((m) => m.name!)),
  });

  const items: StoreItem[] = [];
  const skipped: StackBackupStatus['skipped'] = [];
  const dir = stack.dir ? path.posix.normalize(stack.dir).replace(/\/+$/, '') : undefined;

  // The stack's folder (compose file, .env, …), without the app folders inside it, which are their own items
  const ownDirs = own.filter((o) => o.kind === 'directory').map((o) => o.source);
  if (dir) {
    const inside = ownDirs.filter((d) => d.startsWith(dir + '/')).map((d) => d.slice(dir.length + 1));
    items.push({ kind: 'directory', source: dir, label: `${project} folder`, exclude: inside });
  }
  for (const o of own) {
    if (o.kind === 'volume') {
      const v = (await getProjectVolumes(project)).find((x) => x.name === o.source);
      items.push({ kind: 'volume', source: o.source, label: o.source, volumeLabels: v?.labels, volumeDriver: v?.driver });
    } else if (!dir || !(o.source === dir)) {
      items.push({ kind: 'directory', source: o.source, label: o.source });
    }
  }

  // Folders outside every stack that only this stack's apps use: kept unless they're a media library
  const otherBinds = new Set(elsewhere.flatMap((c) => (c.mounts || []).filter((m) => m.type === 'bind').map((m) => path.posix.normalize(m.source))));
  const candidates = shared
    .filter((p) => p.startsWith('/') && !p.startsWith('/var/run') && !p.startsWith('/run/') && !/^\/(proc|sys|dev|etc)(\/|$)/.test(p))
    .filter((p) => !otherBinds.has(path.posix.normalize(p)))
    .filter((p) => !dir || !p.startsWith(dir + '/'));
  const sizes = await measureOutside(candidates).catch(() => candidates.map(() => ({ bytes: 0, media: 0 })));
  candidates.forEach((p, i) => {
    const { bytes, media } = sizes[i];
    if (bytes > 0 && media / bytes > 0.5) skipped.push({ path: p, reason: 'Media library (videos or music)', bytes });
    else if (bytes > BIG_OUTSIDE) skipped.push({ path: p, reason: `Too big to back up automatically (${formatBytes(bytes)})`, bytes });
    else items.push({ kind: 'directory', source: p, label: p });
  });
  // Shared with apps in other stacks: those stacks' backups would hold them twice
  for (const p of shared.filter((x) => otherBinds.has(path.posix.normalize(x)))) {
    skipped.push({ path: p, reason: 'Shared with apps in other stacks' });
  }

  // Databases: a dump that always restores cleanly, beside the files
  for (const c of stack.apps) {
    const script = dumpFor(c);
    if (script) items.push({ kind: 'database', source: (c.name || '').replace(/^\//, ''), label: `${c.cleanName || c.name} database`, dumpScript: script });
  }

  const failures: string[] = [];
  const entries = await backupToStore(items, {
    tags: ['auto', `stack:${project}`],
    purpose: `Automatic backup of ${project}`,
    skipMedia: true,
    gentle: true,
    failures,
  });

  const status = readStatus();
  const now = new Date().toISOString();
  const byRoot = new Map(entries.map((e) => [e.source, e]));
  status[project] = {
    project,
    dir,
    lastAt: now,
    lastOkAt: failures.length ? status[project]?.lastOkAt : now,
    bytes: entries.reduce((s, e) => s + (e.dataBytes || 0), 0),
    newBytes: entries.reduce((s, e) => s + e.bytes, 0),
    items: items
      .filter((it) => byRoot.has(it.source))
      .map((it) => ({ label: it.label || it.source, kind: it.kind === 'directory' ? 'folder' : it.kind, bytes: byRoot.get(it.source)?.dataBytes || 0 })),
    skipped,
    problem: failures.length ? `Couldn’t back up ${failures.join('; ')}` : undefined,
  };
  saveStatus(status);
  record(failures.length ? 'warn' : 'info', 'backup', `Automatic backup of ${project}: ${formatBytes(status[project].bytes || 0)}, ${formatBytes(status[project].newBytes || 0)} new${failures.length ? ` (${failures.length} problem${failures.length === 1 ? '' : 's'})` : ''}`, {
    items: status[project].items,
    skipped,
    failures,
  }, { durationMs: Date.now() - t0 });
}

/** Saves the automatic backup settings (on or off, and the nightly time) */
export function saveAutoBackupSettings(next: { enabled?: boolean; time?: string }): { enabled: boolean; time: string } {
  const cur = autoBackupSettings();
  const time = next.time && /^([01]\d|2[0-3]):[0-5]\d$/.test(next.time) ? next.time : cur.time;
  const enabled = typeof next.enabled === 'boolean' ? next.enabled : cur.enabled;
  saveConfig({ autoBackup: { enabled, time } });
  record('info', 'backup', `Automatic backups ${enabled ? `on, every night at ${time}` : 'off'}`);
  if (enabled) void checkForNewStacks();
  return { enabled, time };
}
