/**
 * Activity Log — Manifexus's observability engine.
 *
 * Two kinds of records:
 *   - Activity: one thing that happened as a unit (a move, a delete, an update, a settings change,
 *     an automatic check). Has a type, title, status, timing, who started it, its input, and its
 *     outcome/error. Think "trace".
 *   - Event: a single fact, optionally belonging to an activity (a step, a Docker API call, a helper
 *     container's script and full output, a file written with its content, a container crashing).
 *
 * Context propagation: activities run inside AsyncLocalStorage, so everything that happens underneath
 * (Docker calls, helper containers, file writes, pipeline steps) is attached to the right activity
 * automatically, without threading ids through every function.
 *
 * Recording policy: inside an activity *everything* is kept (that is what makes an activity
 * debuggable). Outside activities, the "detail" setting decides how much background noise is kept.
 *
 * Storage: newline-delimited JSON in <data>/logs — events-YYYY-MM-DD[-N].jsonl plus an activity
 * index — with retention by age and total size. Secrets are masked at write time by default.
 */
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { writeJsonAtomic } from './safeJson';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export const LEVELS: Level[] = ['trace', 'debug', 'info', 'warn', 'error'];
const RANK: Record<Level, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

export type Category =
  | 'activity'
  | 'step'
  | 'api'
  | 'docker'
  | 'helper'
  | 'compose'
  | 'file'
  | 'container'
  | 'update'
  | 'backup'
  | 'stack'
  | 'system'
  | 'ui';

export interface LogEvent {
  id: string;
  /** ISO timestamp with milliseconds */
  ts: string;
  /** Monotonic sequence within this process (orders events with equal timestamps) */
  seq: number;
  level: Level;
  cat: Category;
  msg: string;
  /** Activity this belongs to */
  act?: string;
  durationMs?: number;
  data?: unknown;
}

export type ActivityStatus = 'running' | 'succeeded' | 'failed' | 'rolled_back' | 'interrupted';

export interface Activity {
  id: string;
  type: string;
  title: string;
  status: ActivityStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  actor?: { kind: 'user' | 'system'; ip?: string; userAgent?: string };
  input?: unknown;
  error?: { message: string; detail?: string; stack?: string };
  counts: { events: number; warnings: number; errors: number };
  build?: string;
  meta?: Record<string, unknown>;
}

export interface LogSettings {
  /** Background detail outside activities: standard = info+, detailed = debug+, everything = all */
  detail: 'standard' | 'detailed' | 'everything';
  retentionDays: number;
  maxStorageMB: number;
  redactSecrets: boolean;
  containerEvents: boolean;
}

const DEFAULT_SETTINGS: LogSettings = {
  detail: 'standard',
  retentionDays: 30,
  maxStorageMB: 500,
  redactSecrets: true,
  containerEvents: true,
};

// ----------------------------------------------------------------------------
// Storage
// ----------------------------------------------------------------------------

const DATA_DIR = process.env.DATA_DIR && fs.existsSync(process.env.DATA_DIR)
  ? process.env.DATA_DIR
  : fs.existsSync('/data')
    ? '/data'
    : path.join(process.cwd(), 'data');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
const SETTINGS_FILE = path.join(LOG_DIR, 'settings.json');
const ACTIVITIES_FILE = path.join(LOG_DIR, 'activities.jsonl');
const PART_MAX_BYTES = 50 * 1024 * 1024;
const MAX_STRING = 256 * 1024;
const RING_SIZE = 5000;

function ensureDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // read-only data dir: logging still works in memory
  }
}

let settings: LogSettings = (() => {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
})();

export function getLogSettings(): LogSettings {
  return { ...settings };
}

export function updateLogSettings(patch: Partial<LogSettings>): LogSettings {
  const next = { ...settings };
  if (patch.detail && ['standard', 'detailed', 'everything'].includes(patch.detail)) next.detail = patch.detail;
  if (typeof patch.retentionDays === 'number' && patch.retentionDays >= 1 && patch.retentionDays <= 3650) next.retentionDays = Math.round(patch.retentionDays);
  if (typeof patch.maxStorageMB === 'number' && patch.maxStorageMB >= 10 && patch.maxStorageMB <= 100000) next.maxStorageMB = Math.round(patch.maxStorageMB);
  if (typeof patch.redactSecrets === 'boolean') next.redactSecrets = patch.redactSecrets;
  if (typeof patch.containerEvents === 'boolean') next.containerEvents = patch.containerEvents;
  settings = next;
  ensureDir();
  try {
    writeJsonAtomic(SETTINGS_FILE, settings);
  } catch {
    // ignore
  }
  record('info', 'system', 'Log settings changed', { settings: next });
  return getLogSettings();
}

const dayOf = (iso: string) => iso.slice(0, 10);

const partPath = (day: string, n: number) => path.join(LOG_DIR, n === 1 ? `events-${day}.jsonl` : `events-${day}-${n}.jsonl`);

/** The part being appended to: events-YYYY-MM-DD.jsonl, then -2, -3… as each reaches PART_MAX_BYTES. */
let writeTarget: { day: string; part: number } | undefined;

function currentFile(day: string): string {
  if (!writeTarget || writeTarget.day !== day) {
    // Continue the highest existing part for the day (lower parts may have been removed by the storage limit)
    const parts = listEventFiles().filter((f) => f.day === day).map((f) => f.part);
    writeTarget = { day, part: parts.length ? Math.max(...parts) : 1 };
    endWithNewline(partPath(day, writeTarget.part));
  }
  let file = partPath(day, writeTarget.part);
  try {
    if (fs.statSync(file).size >= PART_MAX_BYTES) {
      writeTarget.part++;
      file = partPath(day, writeTarget.part);
    }
  } catch {
    // doesn't exist yet: appendFileSync creates it
  }
  return file;
}

/** If the last process was killed mid-write, finish its partial line so it can't swallow the next event. */
function endWithNewline(file: string) {
  try {
    const size = fs.statSync(file).size;
    if (!size) return;
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    fs.closeSync(fd);
    if (b[0] !== 0x0a) fs.appendFileSync(file, '\n');
  } catch {
    // missing or unreadable: nothing to fix
  }
}

/** The file currently being written (never removed by retention). */
function liveFile(): string | undefined {
  return writeTarget ? partPath(writeTarget.day, writeTarget.part) : undefined;
}

let buffer: string[] = [];
let bufferDay = '';

export function flush(): void {
  if (!buffer.length) return;
  ensureDir();
  try {
    fs.appendFileSync(currentFile(bufferDay), buffer.join(''));
  } catch {
    // disk full or read-only: drop rather than crash the app
  }
  buffer = [];
}

setInterval(flush, 400).unref();

/** Event log files, newest first */
export function listEventFiles(): { file: string; day: string; part: number; size: number; mtime: number }[] {
  try {
    return fs
      .readdirSync(LOG_DIR)
      .map((f) => {
        const m = f.match(/^events-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.jsonl$/);
        if (!m) return null;
        const st = fs.statSync(path.join(LOG_DIR, f));
        return { file: path.join(LOG_DIR, f), day: m[1], part: m[2] ? parseInt(m[2], 10) : 1, size: st.size, mtime: st.mtimeMs };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .sort((a, b) => (a.day === b.day ? b.part - a.part : a.day < b.day ? 1 : -1));
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------------------
// Redaction & sizing
// ----------------------------------------------------------------------------

const SECRET_NAME = /(pass(word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth(orization)?|session|cookie|jwt|bearer|client[_-]?secret)/i;
const REDACTED = '••••••';

const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*(?:PASS(?:WORD|WD)?|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)[A-Za-z0-9_.-]*`;
// KEY: "value", "KEY": "value", KEY='value' (YAML, JSON, env files, CLI flags)
const QUOTED_SECRET = new RegExp(String.raw`(^|[\s"'\-{,[])(${SECRET_KEY})(["']?[ \t]*[=:][ \t]*)(["'])((?:\\.|(?!\4)[^\\\n])*)\4`, 'gim');
// KEY=value / KEY: value without quotes
const BARE_SECRET = new RegExp(String.raw`(^|[\s"'\-{,[])(${SECRET_KEY})(["']?[ \t]*[=:][ \t]*)(?![\s"'$]|(?:Basic|Bearer|Token|Digest)[ \t])([^\s"',}\]]+)`, 'gim');

function redactString(s: string): string {
  // Authorization headers and bearer tokens (keep the scheme word, hide the credential)
  let out = s.replace(/(Authorization["']?[ \t]*[:=][ \t]*["']?(?:Basic|Bearer|Token|Digest)[ \t]+)[^\s"',]+/gi, `$1${REDACTED}`);
  out = out.replace(/\b(Bearer[ \t]+)[A-Za-z0-9._~+/-]{16,}=*/g, `$1${REDACTED}`);
  out = out.replace(QUOTED_SECRET, (m, pre, key, sep, q, val: string) =>
    !val || /^\$\{/.test(val) || val.includes(REDACTED) ? m : `${pre}${key}${sep}${q}${REDACTED}${q}`
  );
  out = out.replace(BARE_SECRET, (m, pre, key, sep, val: string) => (val.startsWith(REDACTED) ? m : `${pre}${key}${sep}${REDACTED}`));
  // Credentials in any URL or connection string: scheme://user:password@host (user may be empty)
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]*:)[^@\s/]+@/gi, `$1${REDACTED}@`);
  return out;
}

function sanitize(value: unknown, depth = 0, keyHint?: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let s = value;
    if (settings.redactSecrets) {
      if (keyHint && SECRET_NAME.test(keyHint) && !/^\$\{/.test(s)) return REDACTED;
      s = redactString(s);
    }
    if (s.length > MAX_STRING) s = `${s.slice(0, MAX_STRING)}\n… [truncated ${s.length - MAX_STRING} characters]`;
    return s;
  }
  if (typeof value !== 'object') return value;
  if (depth > 12) return '[nested too deep]';
  if (value instanceof Error) return { name: value.name, message: sanitize(value.message, depth + 1), stack: value.stack };
  if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
  if (Array.isArray(value)) {
    const arr = value.length > 2000 ? value.slice(0, 2000) : value;
    const mapped = arr.map((v) => sanitize(v, depth + 1, keyHint));
    if (value.length > 2000) mapped.push(`… [${value.length - 2000} more items]`);
    return mapped;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitize(v, depth + 1, k);
  return out;
}

export function redactText(s: string): string {
  return settings.redactSecrets ? redactString(s) : s;
}

// ----------------------------------------------------------------------------
// Activities
// ----------------------------------------------------------------------------

interface Ctx {
  activityId?: string;
}
const als = new AsyncLocalStorage<Ctx>();
const activities = new Map<string, Activity>();
let seq = 0;
let buildLabel: string | undefined;

export function setBuildLabel(label: string | undefined) {
  buildLabel = label;
}

function persistActivity(a: Activity) {
  ensureDir();
  try {
    fs.appendFileSync(ACTIVITIES_FILE, JSON.stringify(a) + '\n');
  } catch {
    // ignore
  }
}

function loadActivities() {
  try {
    const lines = fs.readFileSync(ACTIVITIES_FILE, 'utf8').split('\n');
    for (const l of lines) {
      if (!l) continue;
      try {
        const a: Activity = JSON.parse(l);
        activities.set(a.id, a);
      } catch {
        // partial line
      }
    }
  } catch {
    // no file yet
  }
}
loadActivities();

/** Rewrites the activity index with one line per activity (drops superseded snapshots). */
function compactActivities() {
  try {
    const tmp = `${ACTIVITIES_FILE}.tmp`;
    fs.writeFileSync(tmp, Array.from(activities.values()).map((a) => JSON.stringify(a)).join('\n') + '\n');
    fs.renameSync(tmp, ACTIVITIES_FILE);
  } catch {
    // ignore
  }
}

/**
 * Activities left "running" by a previous process were cut off by a restart or crash.
 * `keep` lists ids that another component will resolve (e.g. an update that restarts Manifexus).
 */
export function closeStaleActivities(keep: string[] = []) {
  for (const a of activities.values()) {
    if (a.status === 'running' && !keep.includes(a.id)) {
      a.status = 'interrupted';
      a.endedAt = a.endedAt || new Date().toISOString();
      a.error = a.error || { message: 'Manifexus restarted or stopped before this finished.' };
      persistActivity(a);
    }
  }
}

export function currentActivityId(): string | undefined {
  return als.getStore()?.activityId;
}

export function getActivity(id: string): Activity | undefined {
  return activities.get(id);
}

export function startActivity(opts: {
  type: string;
  title: string;
  actor?: Activity['actor'];
  input?: unknown;
  meta?: Record<string, unknown>;
}): Activity {
  const a: Activity = {
    id: `act_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    type: opts.type,
    title: opts.title,
    status: 'running',
    startedAt: new Date().toISOString(),
    actor: opts.actor,
    input: opts.input === undefined ? undefined : sanitize(opts.input),
    counts: { events: 0, warnings: 0, errors: 0 },
    build: buildLabel,
    meta: opts.meta,
  };
  activities.set(a.id, a);
  persistActivity(a);
  broadcast({ kind: 'activity', activity: a });
  return a;
}

export function updateActivity(id: string | undefined, patch: Partial<Pick<Activity, 'title' | 'type' | 'meta'>>) {
  const a = id ? activities.get(id) : undefined;
  if (!a) return;
  if (patch.title) a.title = patch.title;
  if (patch.type) a.type = patch.type;
  if (patch.meta) a.meta = { ...(a.meta || {}), ...patch.meta };
  persistActivity(a);
  broadcast({ kind: 'activity', activity: a });
}

/** Rename the activity we're currently inside (e.g. once a route knows the app's name). */
export function setActivityTitle(title: string) {
  updateActivity(currentActivityId(), { title });
}

export function finishActivity(
  id: string | undefined,
  status: Exclude<ActivityStatus, 'running'>,
  error?: { message: string; detail?: string; stack?: string }
) {
  const a = id ? activities.get(id) : undefined;
  if (!a || a.status !== 'running') return;
  a.status = status;
  a.endedAt = new Date().toISOString();
  a.durationMs = new Date(a.endedAt).getTime() - new Date(a.startedAt).getTime();
  if (error) a.error = sanitize(error) as Activity['error'];
  persistActivity(a);
  record(
    status === 'succeeded' ? 'info' : status === 'rolled_back' ? 'warn' : 'error',
    'activity',
    `${a.title}: ${status === 'succeeded' ? 'done' : status === 'rolled_back' ? 'rolled back' : status}`,
    error ? { error } : undefined,
    { activityId: a.id, durationMs: a.durationMs }
  );
  broadcast({ kind: 'activity', activity: a });
}

/** Runs `fn` as an activity; everything it does is attached to it. Errors mark it failed and rethrow. */
export async function withActivity<T>(
  opts: Parameters<typeof startActivity>[0],
  fn: (activity: Activity) => Promise<T>
): Promise<T> {
  const a = startActivity(opts);
  return als.run({ activityId: a.id }, async () => {
    try {
      const out = await fn(a);
      if (activities.get(a.id)?.status === 'running') finishActivity(a.id, 'succeeded');
      return out;
    } catch (err) {
      finishActivity(a.id, 'failed', { message: (err as Error).message, stack: (err as Error).stack });
      throw err;
    }
  });
}

/** Run `fn` inside an existing activity's context (e.g. for a request handler). */
export function runInActivity<T>(activityId: string, fn: () => T): T {
  return als.run({ activityId }, fn);
}

// ----------------------------------------------------------------------------
// Recording
// ----------------------------------------------------------------------------

type Listener = (msg: { kind: 'event'; event: LogEvent } | { kind: 'activity'; activity: Activity }) => void;
const listeners = new Set<Listener>();
const ring: LogEvent[] = [];

function broadcast(msg: Parameters<Listener>[0]) {
  for (const l of listeners) {
    try {
      l(msg);
    } catch {
      // ignore
    }
  }
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function shouldKeep(level: Level, inActivity: boolean): boolean {
  if (inActivity) return true;
  const min: Level = settings.detail === 'everything' ? 'trace' : settings.detail === 'detailed' ? 'debug' : 'info';
  return RANK[level] >= RANK[min];
}

/**
 * Records one event. `opts.activityId` overrides the ambient activity (e.g. when closing an
 * activity from another process after a restart).
 */
export function record(
  level: Level,
  cat: Category,
  msg: string,
  data?: unknown,
  opts: { activityId?: string | null; durationMs?: number; ts?: string } = {}
): LogEvent | undefined {
  const act = opts.activityId === null ? undefined : opts.activityId ?? currentActivityId();
  if (!shouldKeep(level, Boolean(act))) return undefined;
  const ts = opts.ts || new Date().toISOString();
  const ev: LogEvent = {
    id: crypto.randomBytes(6).toString('hex'),
    ts,
    seq: ++seq,
    level,
    cat,
    msg: settings.redactSecrets ? redactString(msg) : msg,
    act,
    durationMs: opts.durationMs,
    data: data === undefined ? undefined : sanitize(data),
  };
  const day = dayOf(ts);
  if (bufferDay && day !== bufferDay) flush();
  bufferDay = day;
  buffer.push(JSON.stringify(ev) + '\n');
  if (buffer.length >= 200) flush();
  ring.push(ev);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  if (act) {
    const a = activities.get(act);
    if (a) {
      a.counts.events++;
      if (level === 'warn') a.counts.warnings++;
      if (level === 'error') a.counts.errors++;
    }
  }
  if (level === 'error' || level === 'warn') {
    const line = `[${ts}] ${level.toUpperCase()} ${cat}: ${ev.msg}`;
    if (level === 'error') console.error(line);
    else console.log(line);
  }
  broadcast({ kind: 'event', event: ev });
  return ev;
}

export const log = {
  trace: (cat: Category, msg: string, data?: unknown) => record('trace', cat, msg, data),
  debug: (cat: Category, msg: string, data?: unknown) => record('debug', cat, msg, data),
  info: (cat: Category, msg: string, data?: unknown) => record('info', cat, msg, data),
  warn: (cat: Category, msg: string, data?: unknown) => record('warn', cat, msg, data),
  error: (cat: Category, msg: string, data?: unknown) => record('error', cat, msg, data),
};

// ----------------------------------------------------------------------------
// Pipeline streams (move / undo / update) -> steps + activity outcome
// ----------------------------------------------------------------------------

/**
 * Wraps an SSE `send` so every pipeline event is also recorded, and the activity's final status
 * follows the pipeline's outcome.
 */
export function pipelineRecorder(activityId: string | undefined) {
  let lastStage: string | undefined;
  let outcome: 'succeeded' | 'failed' | 'rolled_back' | 'restarting' | undefined;
  let failure: string | undefined;
  const stepStarts = new Map<number, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onEvent = (e: any) => {
    if (!e || typeof e !== 'object') return;
    const opts = { activityId };
    if (e.type === 'step_update') {
      if (e.status === 'pending') return;
      if (e.status === 'running') {
        stepStarts.set(e.stepIndex, Date.now());
        record('info', 'step', `Step ${e.stepIndex}: ${e.stepName}`, { step: e.stepIndex, stepId: e.stepId, status: 'started' }, opts);
      } else {
        record(e.status === 'failed' ? 'error' : 'info', 'step', `Step ${e.stepIndex}: ${e.stepName} — ${e.status}`, { step: e.stepIndex, stepId: e.stepId, status: e.status }, { ...opts, durationMs: e.durationMs });
      }
    } else if (e.type === 'log' && e.log) {
      const lvl: Level = /^(Problem|Undo failed|Could not|\[Warning\]|Warning)/i.test(e.log) ? 'warn' : 'info';
      record(lvl, 'step', String(e.log), e.stepIndex ? { step: e.stepIndex } : undefined, opts);
    } else if (e.type === 'completed') {
      outcome = 'succeeded';
    } else if (e.type === 'auto_reverted') {
      outcome = 'rolled_back';
      failure = e.log;
    } else if (e.type === 'failed') {
      outcome = 'failed';
      failure = e.log;
    } else if (e.stage) {
      // Software Update progress: keep stage changes, not every percent
      if (e.stage !== lastStage) {
        record(e.stage === 'error' ? 'error' : 'info', 'update', e.message || e.stage, { stage: e.stage, toImageId: e.toImageId, fromImageId: e.fromImageId }, opts);
        lastStage = e.stage;
      }
      if (e.stage === 'error') {
        outcome = 'failed';
        failure = e.message;
      } else if (e.stage === 'restart') outcome = 'restarting';
      else if (e.stage === 'done') outcome = 'succeeded';
    }
  };
  /** `force` sets the final status regardless of what the pipeline reported (e.g. a request that only watched). */
  const finish = (force?: Exclude<ActivityStatus, 'running'>) => {
    if (!activityId) return;
    if (force) return finishActivity(activityId, force);
    if (outcome === 'restarting') return; // closed after the restart by the new instance
    if (outcome === undefined) {
      // The stream ended without saying how it went
      return finishActivity(activityId, 'failed', { message: 'Stopped without reporting a result.' });
    }
    if (outcome === 'failed') finishActivity(activityId, 'failed', { message: failure || 'Failed' });
    else if (outcome === 'rolled_back') finishActivity(activityId, 'rolled_back', { message: failure || 'Rolled back' });
    else finishActivity(activityId, 'succeeded');
  };
  return { onEvent, finish, get outcome() { return outcome; } };
}

// ----------------------------------------------------------------------------
// Queries
// ----------------------------------------------------------------------------

export interface EventQuery {
  levels?: Level[];
  categories?: Category[];
  search?: string;
  activityId?: string;
  since?: string;
  until?: string;
  /** Return events strictly older than this "ts|seq" cursor */
  before?: string;
  limit?: number;
}

function matches(ev: LogEvent, q: EventQuery, searchLower?: string): boolean {
  if (q.levels && q.levels.length && !q.levels.includes(ev.level)) return false;
  if (q.categories && q.categories.length && !q.categories.includes(ev.cat)) return false;
  if (q.activityId && ev.act !== q.activityId) return false;
  if (q.since && ev.ts < q.since) return false;
  if (q.until && ev.ts > q.until) return false;
  if (searchLower) {
    const hay = `${ev.msg} ${ev.cat} ${ev.act || ''} ${ev.data === undefined ? '' : JSON.stringify(ev.data)}`.toLowerCase();
    if (!hay.includes(searchLower)) return false;
  }
  return true;
}

const cursorOf = (e: LogEvent) => `${e.ts}|${String(e.seq).padStart(12, '0')}`;

/**
 * Newest first. Scans day files newest→oldest (skipping days outside since/until) and stops once
 * `limit` matches are found. Files are read asynchronously so a big search doesn't freeze the server.
 */
export async function queryEvents(q: EventQuery): Promise<{ events: LogEvent[]; nextCursor?: string; scannedFiles: number }> {
  flush();
  const limit = Math.min(Math.max(q.limit || 300, 1), 200000);
  const searchLower = q.search?.trim().toLowerCase() || undefined;
  const out: LogEvent[] = [];
  let scannedFiles = 0;
  const sinceDay = q.since ? dayOf(q.since) : undefined;
  const untilDay = q.until ? dayOf(q.until) : undefined;
  const beforeDay = q.before ? q.before.slice(0, 10) : undefined;
  const needle = q.activityId ? `"act":"${q.activityId}"` : undefined;
  for (const f of listEventFiles()) {
    if (sinceDay && f.day < sinceDay) break;
    if ((untilDay && f.day > untilDay) || (beforeDay && f.day > beforeDay)) continue;
    scannedFiles++;
    let text: string;
    try {
      text = await fs.promises.readFile(f.file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    const fileMatches: LogEvent[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l || (needle && !l.includes(needle))) continue;
      let ev: LogEvent;
      try {
        ev = JSON.parse(l);
      } catch {
        continue; // a line cut short by a crash
      }
      if (q.before && cursorOf(ev) >= q.before) continue;
      if (matches(ev, q, searchLower)) fileMatches.push(ev);
    }
    // within a file, order by time desc (lines are appended in time order per process)
    fileMatches.sort((a, b) => (cursorOf(a) < cursorOf(b) ? 1 : -1));
    for (const ev of fileMatches) {
      out.push(ev);
      if (out.length >= limit) return { events: out, nextCursor: cursorOf(ev), scannedFiles };
    }
    // let other requests (and running moves) through between files
    await new Promise((r) => setImmediate(r));
  }
  return { events: out, scannedFiles };
}

/** All events of one activity, oldest first (only the days it ran are read). */
export async function activityEvents(id: string): Promise<LogEvent[]> {
  const a = activities.get(id);
  if (!a) return [];
  const since = new Date(new Date(a.startedAt).getTime() - 1000).toISOString();
  // Late events (e.g. an update closed by the next instance) can come a few minutes after endedAt
  const until = a.status === 'running' ? undefined : new Date(new Date(a.endedAt || a.startedAt).getTime() + 10 * 60 * 1000).toISOString();
  const res = await queryEvents({ activityId: id, since, until, limit: 200000 });
  return res.events.reverse();
}

export function listActivities(q: { search?: string; types?: string[]; statuses?: ActivityStatus[]; before?: string; limit?: number }): {
  activities: Activity[];
  nextCursor?: string;
  total: number;
} {
  const s = q.search?.trim().toLowerCase();
  let list = Array.from(activities.values());
  if (q.types?.length) list = list.filter((a) => q.types!.includes(a.type));
  if (q.statuses?.length) list = list.filter((a) => q.statuses!.includes(a.status));
  if (s) list = list.filter((a) => `${a.title} ${a.type} ${a.id} ${a.error?.message || ''} ${JSON.stringify(a.input || '')}`.toLowerCase().includes(s));
  // Cursor is "startedAt|id" so activities that started in the same millisecond aren't skipped
  const key = (a: Activity) => `${a.startedAt}|${a.id}`;
  list.sort((a, b) => (key(a) < key(b) ? 1 : -1));
  const total = list.length;
  if (q.before) list = list.filter((a) => key(a) < q.before!);
  const limit = Math.min(q.limit || 60, 500);
  const page = list.slice(0, limit);
  return { activities: page, nextCursor: list.length > limit ? key(page[page.length - 1]) : undefined, total };
}

export function recentEvents(n = 200): LogEvent[] {
  return ring.slice(-n).reverse();
}

// ----------------------------------------------------------------------------
// Retention & stats
// ----------------------------------------------------------------------------

export function logStats() {
  const files = listEventFiles();
  const bytes = files.reduce((s, f) => s + f.size, 0) + (fs.existsSync(ACTIVITIES_FILE) ? fs.statSync(ACTIVITIES_FILE).size : 0);
  const days = new Set(files.map((f) => f.day));
  // Failures worth a badge: anything you started, and automatic work that changes things (not
  // routine background checks, which report their own status where they're shown)
  const failures = Array.from(activities.values()).filter(
    (a) => (a.status === 'failed' || a.status === 'rolled_back' || a.status === 'interrupted') && !a.meta?.background
  );
  const lastFailureAt = failures.map((a) => a.endedAt || a.startedAt).sort().pop();
  return {
    bytes,
    days: days.size,
    oldestDay: files.length ? files[files.length - 1].day : undefined,
    activities: activities.size,
    running: Array.from(activities.values()).filter((a) => a.status === 'running').length,
    lastFailureAt,
    directory: LOG_DIR,
  };
}

export function enforceRetention() {
  flush();
  const cutoffDay = dayOf(new Date(Date.now() - settings.retentionDays * 86400000).toISOString());
  const live = liveFile();
  let files = listEventFiles();
  for (const f of files) {
    if (f.day < cutoffDay && f.file !== live) {
      try {
        fs.unlinkSync(f.file);
      } catch {
        // ignore
      }
    }
  }
  files = listEventFiles();
  let total = files.reduce((s, f) => s + f.size, 0);
  const cap = settings.maxStorageMB * 1024 * 1024;
  // Oldest first; never delete the file currently being written
  for (const f of [...files].reverse()) {
    if (total <= cap) break;
    if (f.file === live || f === files[0]) continue;
    try {
      fs.unlinkSync(f.file);
      total -= f.size;
    } catch {
      // ignore
    }
  }
  const cutoffIso = new Date(Date.now() - settings.retentionDays * 86400000).toISOString();
  let dropped = 0;
  for (const [id, a] of activities) {
    if (a.startedAt < cutoffIso && a.status !== 'running') {
      activities.delete(id);
      dropped++;
    }
  }
  compactActivities();
  if (dropped) record('debug', 'system', `Removed ${dropped} activities older than ${settings.retentionDays} days`);
}

export function clearAllLogs() {
  buffer = [];
  writeTarget = undefined;
  for (const f of listEventFiles()) {
    try {
      fs.unlinkSync(f.file);
    } catch {
      // ignore
    }
  }
  for (const [id, a] of activities) if (a.status !== 'running') activities.delete(id);
  ring.length = 0;
  compactActivities();
  record('info', 'system', 'All logs were cleared');
}

// Flush on shutdown so the last events (often the most important) aren't lost
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    record('info', 'system', `Manifexus is stopping (${sig})`);
    flush();
    process.exit(0);
  });
}
process.on('beforeExit', flush);
process.on('uncaughtException', (err) => {
  // Record it, then exit so Docker's restart policy brings Manifexus back in a clean state
  record('error', 'system', `Uncaught exception: ${err.message}`, { stack: err.stack });
  flush();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  record('error', 'system', `Unhandled promise rejection: ${err.message}`, { stack: err.stack });
});
