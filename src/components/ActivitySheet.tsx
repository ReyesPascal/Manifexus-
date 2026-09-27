import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  BackButton,
  Button,
  Checkmark,
  Chip,
  Group,
  IconTile,
  LinkButton,
  Row,
  SearchField,
  SectionFooter,
  SectionHeader,
  Segmented,
  Sheet,
  Switch,
  ios,
} from './ui/ios';

// ----------------------------------------------------------------------------
// Types (mirror server/activityLog.ts)
// ----------------------------------------------------------------------------

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';
type Status = 'running' | 'succeeded' | 'failed' | 'rolled_back' | 'interrupted';

export interface LogEvent {
  id: string;
  ts: string;
  seq: number;
  level: Level;
  cat: string;
  msg: string;
  act?: string;
  durationMs?: number;
  data?: unknown;
}

export interface Activity {
  id: string;
  type: string;
  title: string;
  status: Status;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  actor?: { kind: 'user' | 'system'; ip?: string; userAgent?: string };
  input?: unknown;
  error?: { message: string; detail?: string; stack?: string };
  counts: { events: number; warnings: number; errors: number };
  build?: string;
  meta?: { background?: boolean; [k: string]: unknown };
}

type LiveMessage = { kind: 'event'; event: LogEvent } | { kind: 'activity'; activity: Activity };
/** Subscribes to live messages; returns an unsubscribe function. Every message reaches every subscriber. */
type Subscribe = (fn: (msg: LiveMessage) => void) => () => void;

interface Bundle {
  activity: Activity;
  events: LogEvent[];
  containerEventsAround: LogEvent[];
  environment: Record<string, unknown>;
}

interface LogSettings {
  detail: 'standard' | 'detailed' | 'everything';
  retentionDays: number;
  maxStorageMB: number;
  redactSecrets: boolean;
  containerEvents: boolean;
}

interface Stats {
  bytes: number;
  days: number;
  oldestDay?: string;
  activities: number;
  running: number;
  lastFailureAt?: string;
  directory: string;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const LEVEL_COLOR: Record<Level, string> = {
  trace: 'rgba(235,235,245,0.25)',
  debug: 'rgba(235,235,245,0.45)',
  info: '#0A84FF',
  warn: '#FF9F0A',
  error: '#FF453A',
};

const CATEGORY_LABEL: Record<string, string> = {
  activity: 'Activity',
  step: 'Step',
  api: 'Request',
  docker: 'Docker',
  helper: 'Host command',
  compose: 'Compose',
  file: 'File',
  container: 'Container',
  update: 'Update',
  backup: 'Backup',
  stack: 'Stack',
  system: 'System',
  ui: 'Dashboard',
};

const TYPE_FILTERS: { key: string; label: string; types?: string[]; statuses?: Status[] }[] = [
  { key: 'all', label: 'All' },
  { key: 'problems', label: 'Problems', statuses: ['failed', 'rolled_back', 'interrupted'] },
  { key: 'move', label: 'Moves', types: ['move', 'plan'] },
  { key: 'delete', label: 'Deletes', types: ['delete'] },
  { key: 'undo', label: 'Restores', types: ['undo'] },
  { key: 'update', label: 'Updates', types: ['update'] },
  { key: 'stack', label: 'Stacks', types: ['stack'] },
  { key: 'app', label: 'Apps', types: ['app'] },
  { key: 'settings', label: 'Settings', types: ['settings'] },
];

function fmtDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60000);
  return `${m} min ${Math.round((ms % 60000) / 1000)} s`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtClock(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function fmtBytes(b: number): string {
  if (b < 1000 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function browserOf(ua?: string): string {
  if (!ua) return '';
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const o = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return o ? `${b} on ${o}` : b;
}

/** Copies text; falls back to a hidden textarea when the Clipboard API isn't available (plain http). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ----------------------------------------------------------------------------
// Small pieces
// ----------------------------------------------------------------------------

const Glyph: React.FC<{ d: string; size?: number; stroke?: number }> = ({ d, size = 16, stroke = 2.4 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const StatusTile: React.FC<{ status: Status; size?: number; subdued?: boolean }> = ({ status, size = 29, subdued }) => {
  const s = size * 0.55;
  if (status === 'running')
    return (
      <IconTile color="#0A84FF" size={size}>
        <svg width={s} height={s} viewBox="0 0 24 24" className="animate-spin motion-reduce:animate-none" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-6.2-8.56" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </IconTile>
    );
  if (status === 'succeeded')
    return (
      <IconTile color={subdued ? '#48484A' : '#30D158'} size={size}>
        <Glyph d="m5 12.5 4.5 4.5L19 7.5" size={s} stroke={3} />
      </IconTile>
    );
  if (status === 'rolled_back')
    return (
      <IconTile color="#FF9F0A" size={size}>
        <Glyph d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" size={s} stroke={2.6} />
      </IconTile>
    );
  if (status === 'interrupted')
    return (
      <IconTile color="#636366" size={size}>
        <Glyph d="M9 6v12M15 6v12" size={s} stroke={3} />
      </IconTile>
    );
  return (
    <IconTile color="#FF453A" size={size}>
      <Glyph d="M12 6v8M12 18.5v.01" size={s} stroke={3.2} />
    </IconTile>
  );
};

const STATUS_TEXT: Record<Status, string> = {
  running: 'In progress',
  succeeded: 'Completed',
  failed: 'Failed',
  rolled_back: 'Rolled back',
  interrupted: 'Interrupted',
};

const LevelDot: React.FC<{ level: Level }> = ({ level }) => (
  <span className="inline-block w-[7px] h-[7px] rounded-full flex-shrink-0" style={{ background: LEVEL_COLOR[level] }} title={level} aria-label={level} />
);

const Pre: React.FC<{ children: string; tone?: 'default' | 'error'; max?: number }> = ({ children, tone = 'default', max = 420 }) => (
  <pre
    className="text-[12px] leading-[17px] font-mono whitespace-pre-wrap break-words overflow-auto rounded-[10px] px-3 py-2.5"
    style={{ background: 'rgba(0,0,0,0.35)', color: tone === 'error' ? '#FF9F94' : 'rgba(235,235,245,0.8)', maxHeight: max }}
  >
    {children}
  </pre>
);

/** Shows an event's data: command output, file contents and scripts as text; everything else as JSON. */
const EventData: React.FC<{ ev: LogEvent }> = ({ ev }) => {
  const [copied, setCopied] = useState(false);
  const d = ev.data as Record<string, unknown> | undefined;
  if (d === undefined) return <p className="text-[13px] px-1" style={{ color: ios.tertiary }}>No additional data.</p>;
  const blocks: { label: string; text: string; tone?: 'error' }[] = [];
  if (typeof d?.output === 'string' && d.output.trim()) blocks.push({ label: 'Output', text: d.output, tone: ev.level === 'warn' || ev.level === 'error' ? 'error' : undefined });
  if (typeof d?.content === 'string') blocks.push({ label: `Content${typeof d.path === 'string' ? ` of ${d.path}` : ''}`, text: d.content });
  if (typeof d?.script === 'string') blocks.push({ label: 'Script', text: d.script });
  if (typeof d?.compose === 'string') blocks.push({ label: 'Compose', text: d.compose });
  if (typeof d?.composeToWrite === 'string') blocks.push({ label: 'Compose to write', text: d.composeToWrite });
  if (typeof d?.stack === 'string') blocks.push({ label: 'Stack trace', text: d.stack, tone: 'error' });
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d || {})) {
    if (['output', 'content', 'script', 'compose', 'composeToWrite', 'stack'].includes(k) && typeof v === 'string') continue;
    if (v !== undefined) rest[k] = v;
  }
  const json = JSON.stringify(Object.keys(rest).length ? rest : undefined, null, 2);
  return (
    <div className="space-y-2.5">
      {blocks.map((b) => (
        <div key={b.label}>
          <div className="text-[12px] mb-1 px-1" style={{ color: ios.secondary }}>{b.label}</div>
          <Pre tone={b.tone}>{b.text}</Pre>
        </div>
      ))}
      {json && (
        <div>
          {blocks.length > 0 && <div className="text-[12px] mb-1 px-1" style={{ color: ios.secondary }}>Details</div>}
          <Pre>{json}</Pre>
        </div>
      )}
      <div className="flex gap-4 px-1">
        <LinkButton
          onClick={async () => {
            if (await copyText(JSON.stringify(ev, null, 2))) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy Event JSON'}
        </LinkButton>
      </div>
    </div>
  );
};

/** One timeline/event row that expands to show its data. */
const EventRow: React.FC<{
  ev: LogEvent;
  time: string;
  /** Width of the time column: relative times are shorter than clock times */
  timeWidth?: number;
  showCategory?: boolean;
  onOpenActivity?: (id: string) => void;
}> = ({ ev, time, timeWidth = 64, showCategory = true, onOpenActivity }) => {
  const [open, setOpen] = useState(false);
  const faded = ev.level === 'trace' || ev.level === 'debug';
  const meta = [showCategory ? CATEGORY_LABEL[ev.cat] || ev.cat : '', ev.durationMs !== undefined ? fmtDuration(ev.durationMs) : '']
    .filter(Boolean)
    .join(' · ');
  const indent = 16 + timeWidth + 12 + 7 + 12;
  return (
    <div className="ios-row relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full text-left flex items-start gap-3 px-4 py-[8px] hover:bg-white/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0A84FF]"
      >
        <span className="font-mono text-[11.5px] leading-[19px] tabular-nums flex-shrink-0" style={{ color: ios.tertiary, width: timeWidth }}>
          {time}
        </span>
        <span className="h-[19px] flex items-center flex-shrink-0"><LevelDot level={ev.level} /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] leading-[19px] break-words" style={{ color: faded ? ios.secondary : ev.level === 'error' ? '#FF8A80' : ios.label }}>
            {ev.msg}
          </span>
          {meta && (
            <span className="sm:hidden block mt-0.5 text-[11.5px] tabular-nums" style={{ color: ios.tertiary }}>
              {meta}
            </span>
          )}
        </span>
        {meta && (
          <span className="max-sm:hidden flex-shrink-0 text-[12px] leading-[19px] tabular-nums whitespace-nowrap" style={{ color: ios.tertiary }}>
            {meta}
          </span>
        )}
        {ev.act && onOpenActivity && (
          <span
            role="link"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onOpenActivity(ev.act!);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                onOpenActivity(ev.act!);
              }
            }}
            className="text-[12px] leading-[19px] flex-shrink-0 hover:underline"
            style={{ color: ios.blue }}
          >
            Activity
          </span>
        )}
      </button>
      {open && (
        <div className="px-4 pb-3 sm:pl-[var(--ev-indent)]" style={{ ['--ev-indent' as string]: `${indent}px` } as React.CSSProperties}>
          <EventData ev={ev} />
        </div>
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Activity list
// ----------------------------------------------------------------------------

const ActivityList: React.FC<{
  items: Activity[];
  loading: boolean;
  onOpen: (id: string) => void;
  hasMore: boolean;
  onMore: () => void;
  empty: string;
}> = ({ items, loading, onOpen, hasMore, onMore, empty }) => {
  const groups = useMemo(() => {
    const m = new Map<string, Activity[]>();
    for (const a of items) {
      const k = dayLabel(a.startedAt);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(a);
    }
    return Array.from(m.entries());
  }, [items]);

  if (!items.length) {
    return (
      <p className="text-[15px] text-center py-16" style={{ color: ios.secondary }}>
        {loading ? 'Loading…' : empty}
      </p>
    );
  }
  return (
    <div className="space-y-7">
      {groups.map(([day, list]) => (
        <section key={day}>
          <SectionHeader>{day}</SectionHeader>
          <Group className="ios-inset-icon">
            {list.map((a) => {
              const problem = a.status === 'failed' || a.status === 'rolled_back' || a.status === 'interrupted';
              const subtitle = problem && a.error?.message
                ? a.error.message
                : a.status === 'running'
                  ? 'In progress…'
                  : [fmtDuration(a.durationMs), `${a.counts.events} events`, a.counts.warnings ? `${a.counts.warnings} warning${a.counts.warnings === 1 ? '' : 's'}` : '']
                      .filter(Boolean)
                      .join(' · ');
              return (
                <Row
                  key={a.id}
                  onClick={() => onOpen(a.id)}
                  leading={<StatusTile status={a.status} subdued={a.type === 'plan' || Boolean(a.meta?.background)} />}
                  title={a.title}
                  titleColor={(a.type === 'plan' || a.meta?.background) && !problem ? ios.secondary : undefined}
                  subtitle={<span className="line-clamp-1" style={{ color: problem ? (a.status === 'rolled_back' ? '#FFB340' : '#FF8A80') : undefined }}>{subtitle}</span>}
                  trailing={<span className="text-[13px] tabular-nums">{fmtTime(a.startedAt)}</span>}
                  chevron
                />
              );
            })}
          </Group>
        </section>
      ))}
      {hasMore && (
        <div className="flex justify-center">
          <Button tone="gray" onClick={onMore}>Show Older</Button>
        </div>
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Activity detail
// ----------------------------------------------------------------------------

interface StepInfo {
  index: number;
  name: string;
  status: 'running' | 'success' | 'failed';
  durationMs?: number;
}

function stepsFrom(events: LogEvent[], activityStatus: Status): StepInfo[] {
  const steps = new Map<number, StepInfo>();
  for (const e of events) {
    if (e.cat !== 'step') continue;
    const m = e.msg.match(/^Step (\d+): (.*?)(?: — (success|failed|skipped))?$/);
    if (!m) continue;
    const i = Number(m[1]);
    const st = m[3] === 'success' || m[3] === 'skipped' ? 'success' : m[3] === 'failed' ? 'failed' : 'running';
    steps.set(i, { index: i, name: m[2], status: st, durationMs: e.durationMs ?? steps.get(i)?.durationMs });
  }
  const list = Array.from(steps.values()).sort((a, b) => a.index - b.index);
  // A step still "running" when the activity already ended didn't finish
  if (activityStatus !== 'running') for (const s of list) if (s.status === 'running') s.status = 'failed';
  return list;
}

/** The most useful evidence for a failure: the first command/response output from a warning or error. */
function evidenceOf(events: LogEvent[]): { title: string; text: string } | undefined {
  for (const e of events) {
    if (e.level !== 'warn' && e.level !== 'error') continue;
    const d = e.data as Record<string, unknown> | undefined;
    if (typeof d?.output === 'string' && d.output.trim()) return { title: e.msg, text: d.output };
    const resp = d?.response as Record<string, unknown> | string | undefined;
    if (resp && typeof resp === 'object' && typeof resp.message === 'string') return { title: e.msg, text: resp.message };
    if (typeof resp === 'string' && resp.trim()) return { title: e.msg, text: resp };
    if (typeof d?.stack === 'string') return { title: e.msg, text: d.stack };
  }
  return undefined;
}

const ActivityDetail: React.FC<{ id: string; subscribe: Subscribe }> = ({ id, subscribe }) => {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'key' | 'all'>('key');
  const [shown, setShown] = useState(250);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/logs/activities/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not load this activity.');
      setBundle(j);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    setBundle(null);
    setMode('key');
    setShown(250);
    load();
  }, [load]);

  // Live: append new events and status changes while it runs; reload in full once it ends
  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.kind === 'event' && msg.event.act === id) {
          const ev = msg.event;
          setBundle((b) => (b && !b.events.some((e) => e.id === ev.id) ? { ...b, events: [...b.events, ev] } : b));
        } else if (msg.kind === 'activity' && msg.activity.id === id) {
          const a = msg.activity;
          setBundle((b) => (b ? { ...b, activity: a } : b));
          if (a.status !== 'running') setTimeout(load, 600);
        }
      }),
    [subscribe, id, load]
  );

  if (error) return <p className="text-[15px] text-center py-16" style={{ color: ios.orange }}>{error}</p>;
  if (!bundle) return <p className="text-[15px] text-center py-16" style={{ color: ios.secondary }}>Loading…</p>;

  const a = bundle.activity;
  const t0 = new Date(a.startedAt).getTime();
  // Time since the activity started: +4.512s, or +2:05.3 past 100 seconds
  const rel = (ts: string) => {
    const s = (new Date(ts).getTime() - t0) / 1000;
    const a = Math.abs(s);
    const sign = s < 0 ? '−' : '+';
    if (a < 100) return `${sign}${a.toFixed(3)}s`;
    const m = Math.floor(a / 60);
    return `${sign}${m}:${(a - m * 60).toFixed(1).padStart(4, '0')}`;
  };
  const steps = stepsFrom(bundle.events, a.status);
  const evidence = a.status !== 'succeeded' && a.status !== 'running' ? evidenceOf(bundle.events) : undefined;
  const timeline = mode === 'key' ? bundle.events.filter((e) => e.level !== 'trace' && e.level !== 'debug') : bundle.events;
  const hiddenCount = bundle.events.length - bundle.events.filter((e) => e.level !== 'trace' && e.level !== 'debug').length;
  const env = bundle.environment as { manifexus?: { build?: string; installMode?: string }; docker?: { version?: string; os?: string } };

  const copyForClaude = async () => {
    setCopyState('copying');
    try {
      const r = await fetch(`/api/logs/activities/${encodeURIComponent(id)}/export?format=markdown`);
      const text = await r.text();
      const ok = await copyText(text);
      setCopyState(ok ? 'copied' : 'failed');
    } catch {
      setCopyState('failed');
    }
    setTimeout(() => setCopyState('idle'), 2500);
  };

  return (
    <div className="space-y-7">
      <div className="flex flex-col items-center text-center pt-1">
        <StatusTile status={a.status} size={56} />
        <h3 className="mt-3.5 text-[20px] leading-[25px] font-semibold text-white px-4">{a.title}</h3>
        <p className="mt-1 text-[13px]" style={{ color: ios.secondary }}>
          {STATUS_TEXT[a.status]}
          {a.durationMs !== undefined ? ` after ${fmtDuration(a.durationMs)}` : ''} · {dayLabel(a.startedAt)} at {fmtTime(a.startedAt)}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button onClick={copyForClaude} variant="tinted" className="!h-[36px] !text-[14px] !px-4">
            {copyState === 'copying' ? 'Preparing…' : copyState === 'copied' ? 'Copied Report' : copyState === 'failed' ? 'Couldn’t Copy' : 'Copy for Claude'}
          </Button>
          <Button onClick={() => download(`/api/logs/activities/${encodeURIComponent(id)}/export?format=markdown&download=1`)} tone="gray" className="!h-[36px] !text-[14px] !px-4">
            Report (.md)
          </Button>
          <Button onClick={() => download(`/api/logs/activities/${encodeURIComponent(id)}/export?format=json`)} tone="gray" className="!h-[36px] !text-[14px] !px-4">
            Everything (.json)
          </Button>
        </div>
        <p className="mt-2 text-[12px] max-w-[440px]" style={{ color: ios.tertiary }}>
          The report includes every step, command, output, file written and the environment. Passwords and tokens are hidden.
        </p>
      </div>

      {(a.error || evidence) && (
        <section>
          <SectionHeader>What went wrong</SectionHeader>
          <Group>
            <div className="px-4 py-3 space-y-2.5">
              {a.error && <p className="text-[15px] leading-[20px] text-white break-words">{a.error.message}</p>}
              {evidence && (
                <div>
                  <p className="text-[12px] mb-1" style={{ color: ios.secondary }}>{evidence.title}</p>
                  <Pre tone="error" max={260}>{evidence.text}</Pre>
                </div>
              )}
              {a.error?.detail && !evidence && <Pre tone="error" max={260}>{a.error.detail}</Pre>}
            </div>
          </Group>
        </section>
      )}

      {steps.length > 0 && (
        <section>
          <SectionHeader>Steps</SectionHeader>
          <Group className="ios-inset-icon">
            {steps.map((s) => (
              <Row
                key={s.index}
                leading={
                  <span className="w-[29px] flex justify-center">
                    {s.status === 'running' ? (
                      <StatusTile status="running" size={22} />
                    ) : s.status === 'success' ? (
                      <span className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-white" style={{ background: ios.green }}><Glyph d="m6 12.5 4 4 8-9" size={13} stroke={3} /></span>
                    ) : (
                      <span className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-white" style={{ background: ios.red }}><Glyph d="M12 7v6M12 17v.01" size={13} stroke={3.2} /></span>
                    )}
                  </span>
                }
                title={s.name}
                titleColor={s.status === 'failed' ? '#FF8A80' : undefined}
                trailing={<span className="text-[13px] tabular-nums">{fmtDuration(s.durationMs)}</span>}
              />
            ))}
          </Group>
        </section>
      )}

      <section>
        <div className="mb-2">
          <Segmented
            label="Timeline detail"
            value={mode}
            onChange={(v) => {
              setMode(v);
              setShown(250);
            }}
            options={[
              { value: 'key', label: 'Key Events' },
              { value: 'all', label: `Everything (${bundle.events.length})` },
            ]}
            size="sm"
          />
        </div>
        <Group>
          {timeline.slice(0, shown).map((e) => (
            <EventRow key={e.id} ev={e} time={rel(e.ts)} />
          ))}
          {timeline.length === 0 && <Row title={<span style={{ color: ios.secondary }}>No events.</span>} />}
        </Group>
        <SectionFooter>
          {timeline.length > shown ? (
            <LinkButton onClick={() => setShown((n) => n + 500)}>Show {Math.min(500, timeline.length - shown)} more</LinkButton>
          ) : mode === 'key' && hiddenCount > 0 ? (
            <>
              {hiddenCount} low-level events (Docker calls, file reads) are hidden.{' '}
              <LinkButton onClick={() => setMode('all')}>Show Everything</LinkButton>
            </>
          ) : (
            'Tap an event to see its details.'
          )}
        </SectionFooter>
      </section>

      {bundle.containerEventsAround.length > 0 && (
        <section>
          <SectionHeader>Around this time</SectionHeader>
          <Group>
            {bundle.containerEventsAround.map((e) => (
              <EventRow key={e.id} ev={e} time={rel(e.ts)} />
            ))}
          </Group>
          <SectionFooter>What your containers were doing from just before this started until a minute after it ended.</SectionFooter>
        </section>
      )}

      <section>
        <SectionHeader>About</SectionHeader>
        <Group>
          <Row title="Started by" trailing={<span className="text-[14px]">{a.actor?.kind === 'system' ? 'Manifexus (automatic)' : [a.actor?.ip, browserOf(a.actor?.userAgent)].filter(Boolean).join(' · ') || 'You'}</span>} />
          <Row title="Started" trailing={<span className="text-[14px] tabular-nums">{new Date(a.startedAt).toLocaleString()}</span>} />
          {a.endedAt && <Row title="Finished" trailing={<span className="text-[14px] tabular-nums">{new Date(a.endedAt).toLocaleString()}</span>} />}
          <Row
            title="Events"
            trailing={
              <span className="text-[14px]">
                {a.counts.events} · {a.counts.warnings} warning{a.counts.warnings === 1 ? '' : 's'} · {a.counts.errors} error{a.counts.errors === 1 ? '' : 's'}
              </span>
            }
          />
          <Row title="Manifexus" trailing={<span className="text-[14px]">{a.build || env.manifexus?.build} · {env.manifexus?.installMode}</span>} />
          <Row title="Docker" trailing={<span className="text-[14px]">{env.docker?.version} · {env.docker?.os}</span>} />
          <Row title="Activity ID" trailing={<span className="text-[13px] font-mono">{a.id}</span>} />
        </Group>
        {a.input !== undefined && (
          <div className="mt-3">
            <SectionHeader>Request</SectionHeader>
            <Pre>{JSON.stringify(a.input, null, 2)}</Pre>
          </div>
        )}
      </section>
    </div>
  );
};

// ----------------------------------------------------------------------------
// All events
// ----------------------------------------------------------------------------

type LevelFilter = 'all' | 'info' | 'warn' | 'error';
type RangeFilter = '1h' | '24h' | '7d' | 'all';

const EventsView: React.FC<{
  subscribe: Subscribe;
  onOpenActivity: (id: string) => void;
  /** Reports how many events are shown (for the sheet's footer) */
  onCount?: (n: number, more: boolean) => void;
}> = ({ subscribe, onOpenActivity, onCount }) => {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [lowLevel, setLowLevel] = useState(false);
  const [cats, setCats] = useState<string[]>([]);
  const [range, setRange] = useState<RangeFilter>('24h');
  const [live, setLive] = useState(true);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [moreAvailable, setMoreAvailable] = useState(false);
  useEffect(() => onCount?.(events.length, moreAvailable), [events.length, moreAvailable, onCount]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const levels = useMemo(() => {
    const base: Level[] = level === 'error' ? ['error'] : level === 'warn' ? ['warn', 'error'] : ['info', 'warn', 'error'];
    return lowLevel && level === 'all' ? (['trace', 'debug', ...base] as Level[]) : level === 'all' || level === 'info' ? base : base;
  }, [level, lowLevel]);

  const since = useMemo(() => {
    const ms = range === '1h' ? 3600e3 : range === '24h' ? 86400e3 : range === '7d' ? 7 * 86400e3 : 0;
    return ms ? new Date(Date.now() - ms).toISOString() : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, debounced, levels.join(), cats.join()]);

  const params = useCallback(
    (extra: Record<string, string | undefined> = {}) => {
      const p = new URLSearchParams();
      p.set('levels', levels.join(','));
      if (cats.length) p.set('categories', cats.join(','));
      if (debounced) p.set('search', debounced);
      if (since) p.set('since', since);
      for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
      return p.toString();
    },
    [levels, cats, debounced, since]
  );

  const load = useCallback(
    async (more = false) => {
      setLoading(true);
      try {
        const r = await fetch(`/api/logs/events?${params({ limit: '300', before: more ? cursor : undefined })}`, { cache: 'no-store' });
        const j = await r.json();
        setEvents((prev) => (more ? [...prev, ...(j.events || [])] : j.events || []));
        setCursor(j.nextCursor);
        setMoreAvailable(Boolean(j.nextCursor));
      } finally {
        setLoading(false);
      }
    },
    [params, cursor]
  );

  useEffect(() => {
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Live tail: filters are read through a ref so the subscription stays put while they change
  const liveFilter = useRef({ live, levels, cats, debounced });
  liveFilter.current = { live, levels, cats, debounced };
  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.kind !== 'event') return;
        const { live: on, levels: lv, cats: cs, debounced: q } = liveFilter.current;
        const e = msg.event;
        if (!on || !lv.includes(e.level)) return;
        if (cs.length && !cs.includes(e.cat)) return;
        if (q && !`${e.msg} ${e.cat} ${JSON.stringify(e.data ?? '')}`.toLowerCase().includes(q.toLowerCase())) return;
        setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [e, ...prev].slice(0, 2000)));
      }),
    [subscribe]
  );

  const byDay = useMemo(() => {
    const m = new Map<string, LogEvent[]>();
    for (const e of events) {
      const k = dayLabel(e.ts);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }
    return Array.from(m.entries());
  }, [events]);

  const toggleCat = (c: string) => setCats((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <SearchField value={search} onChange={setSearch} label="Search events" placeholder="Search messages, commands, output, paths…" />
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="sm:flex-1">
            <Segmented
              label="Severity"
              value={level}
              onChange={setLevel}
              size="sm"
              options={[
                { value: 'all', label: 'All' },
                { value: 'warn', label: 'Warnings' },
                { value: 'error', label: 'Errors' },
              ]}
            />
          </div>
          <div className="sm:w-[260px]">
            <Segmented
              label="Time range"
              value={range}
              onChange={setRange}
              size="sm"
              options={[
                { value: '1h', label: '1 Hour' },
                { value: '24h', label: '24 Hours' },
                { value: '7d', label: '7 Days' },
                { value: 'all', label: 'All' },
              ]}
            />
          </div>
        </div>
        <div className="flex sm:flex-wrap gap-1.5 overflow-x-auto sm:overflow-visible pb-1 -mx-1 px-1" role="group" aria-label="Categories">
          {Object.entries(CATEGORY_LABEL).map(([k, label]) => (
            <Chip key={k} on={cats.includes(k)} onClick={() => toggleCat(k)}>
              {label}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2.5 text-[13px] cursor-pointer" style={{ color: ios.label }}>
            <Switch checked={lowLevel} onChange={setLowLevel} label="Include low-level events" />
            <span>Low-level events</span>
          </label>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setLive((l) => !l)}
              aria-pressed={live}
              className="flex items-center gap-1.5 text-[13px] font-medium"
              style={{ color: live ? ios.green : ios.secondary }}
            >
              <span className={`w-2 h-2 rounded-full ${live ? 'animate-pulse motion-reduce:animate-none' : ''}`} style={{ background: live ? ios.green : ios.tertiary }} />
              {live ? 'Live' : 'Paused'}
            </button>
            <LinkButton onClick={() => download(`/api/logs/events/export?${params({ format: 'jsonl' })}`)}>Export JSON</LinkButton>
            <LinkButton onClick={() => download(`/api/logs/events/export?${params({ format: 'csv' })}`)}>Export CSV</LinkButton>
          </div>
        </div>
      </div>

      {events.length === 0 ? (
        <p className="text-[15px] text-center py-14" style={{ color: ios.secondary }}>
          {loading ? 'Loading…' : 'No events match these filters.'}
        </p>
      ) : (
        byDay.map(([day, list]) => (
          <section key={day}>
            <SectionHeader>{day}</SectionHeader>
            <Group>
              {list.map((e) => (
                <EventRow key={e.id} ev={e} time={fmtClock(e.ts)} timeWidth={92} onOpenActivity={onOpenActivity} />
              ))}
            </Group>
          </section>
        ))
      )}
      {cursor && events.length > 0 && (
        <div className="flex justify-center">
          <Button tone="gray" onClick={() => load(true)} disabled={loading}>
            {loading ? 'Loading…' : 'Show Older'}
          </Button>
        </div>
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------------

const LogSettingsView: React.FC = () => {
  const [s, setS] = useState<LogSettings | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = async () => {
    const [a, b] = await Promise.all([fetch('/api/logs/settings').then((r) => r.json()), fetch('/api/logs/stats').then((r) => r.json())]);
    setS(a);
    setStats(b);
  };
  useEffect(() => {
    load();
  }, []);

  const save = async (patch: Partial<LogSettings>) => {
    setS((cur) => (cur ? { ...cur, ...patch } : cur));
    const r = await fetch('/api/logs/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (r.ok) setS(await r.json());
  };

  if (!s) return <p className="text-[15px] text-center py-16" style={{ color: ios.secondary }}>Loading…</p>;

  const pick = <T,>(title: string, options: { value: T; label: string; sub?: string }[], current: T, onPick: (v: T) => void, footer?: string) => (
    <section>
      <SectionHeader>{title}</SectionHeader>
      <Group>
        {options.map((o) => (
          <Row
            key={String(o.value)}
            onClick={() => onPick(o.value)}
            role="radio"
            ariaChecked={current === o.value}
            title={o.label}
            subtitle={o.sub}
            trailing={<span className="w-[15px] flex justify-center">{current === o.value && <Checkmark />}</span>}
          />
        ))}
      </Group>
      {footer && <SectionFooter>{footer}</SectionFooter>}
    </section>
  );

  return (
    <div className="space-y-7">
      {pick(
        'Background Detail',
        [
          { value: 'standard' as const, label: 'Standard', sub: 'Key events, warnings and errors' },
          { value: 'detailed' as const, label: 'Detailed', sub: 'Adds background operations' },
          { value: 'everything' as const, label: 'Everything', sub: 'Every Docker call and request, even routine refreshes. Uses much more space.' },
        ],
        s.detail,
        (v) => save({ detail: v }),
        'Actions you start (moves, deletes, updates, settings) are always recorded in full, whatever you choose here.'
      )}
      {pick(
        'Keep Logs For',
        [
          { value: 7, label: '7 days' },
          { value: 30, label: '30 days' },
          { value: 90, label: '90 days' },
          { value: 365, label: '1 year' },
        ],
        s.retentionDays,
        (v) => save({ retentionDays: v })
      )}
      {pick(
        'Storage Limit',
        [
          { value: 100, label: '100 MB' },
          { value: 500, label: '500 MB' },
          { value: 1024, label: '1 GB' },
          { value: 5120, label: '5 GB' },
        ],
        s.maxStorageMB,
        (v) => save({ maxStorageMB: v }),
        'When logs reach the limit, the oldest days are removed first.'
      )}

      <section>
        <SectionHeader>Privacy</SectionHeader>
        <Group>
          <Row title="Hide passwords and tokens" trailing={<Switch checked={s.redactSecrets} onChange={(v) => save({ redactSecrets: v })} label="Hide passwords and tokens" />} />
        </Group>
        <SectionFooter>
          Values of settings like PASSWORD, TOKEN or API_KEY are replaced with •••••• before anything is saved, so reports are safe to share. Turning this off only affects new entries.
        </SectionFooter>
      </section>

      <section>
        <SectionHeader>Container Events</SectionHeader>
        <Group>
          <Row title="Record container events" trailing={<Switch checked={s.containerEvents} onChange={(v) => save({ containerEvents: v })} label="Record container events" />} />
        </Group>
        <SectionFooter>Crashes, out-of-memory kills, health changes and restarts of your apps, straight from Docker.</SectionFooter>
      </section>

      {stats && (
        <section>
          <SectionHeader>Storage</SectionHeader>
          <Group>
            <Row title="Space used" trailing={<span>{fmtBytes(stats.bytes)}</span>} />
            <Row title="Activities" trailing={<span>{stats.activities}</span>} />
            <Row title="Oldest entry" trailing={<span>{stats.oldestDay ? new Date(`${stats.oldestDay}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</span>} />
            <Row title="Location" trailing={<span className="font-mono text-[13px]">{stats.directory}</span>} />
          </Group>
        </section>
      )}

      <section>
        <Group>
          <Row onClick={() => setConfirmClear(true)} title={<span style={{ color: ios.red }}>Clear All Logs</span>} />
        </Group>
      </section>

      <Alert
        open={confirmClear}
        title="Clear all logs?"
        message="Every activity and event is deleted. Activities still in progress are kept."
        confirmLabel="Clear"
        destructive
        onCancel={() => setConfirmClear(false)}
        onConfirm={async () => {
          setConfirmClear(false);
          await fetch('/api/logs/clear', { method: 'POST' });
          load();
        }}
      />
    </div>
  );
};

// ----------------------------------------------------------------------------
// Sheet
// ----------------------------------------------------------------------------

export const ActivitySheet: React.FC<{
  open: boolean;
  onClose: () => void;
  /** Open straight to this activity */
  initialActivityId?: string;
}> = ({ open, onClose, initialActivityId }) => {
  const [tab, setTab] = useState<'activity' | 'events'>('activity');
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'detail'; id: string } | { kind: 'settings' }>({ kind: 'list' });
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<Activity[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [eventsMounted, setEventsMounted] = useState(false);
  const [eventCount, setEventCount] = useState<{ n: number; more: boolean }>({ n: 0, more: false });
  const onEventCount = useCallback((n: number, more: boolean) => setEventCount({ n, more }), []);
  const listeners = useRef(new Set<(msg: LiveMessage) => void>());
  const subscribe = useCallback<Subscribe>((fn) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);
  const bodyRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);

  useEffect(() => {
    if (open) {
      setView(initialActivityId ? { kind: 'detail', id: initialActivityId } : { kind: 'list' });
      setTab('activity');
      setEventsMounted(false);
    }
  }, [open, initialActivityId]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const f = TYPE_FILTERS.find((x) => x.key === filter)!;
  const query = useCallback(
    (before?: string) => {
      const p = new URLSearchParams();
      if (f.types) p.set('types', f.types.join(','));
      if (f.statuses) p.set('statuses', f.statuses.join(','));
      if (debounced) p.set('search', debounced);
      if (before) p.set('before', before);
      p.set('limit', '80');
      return p.toString();
    },
    [f, debounced]
  );

  const loadList = useCallback(
    async (more = false) => {
      setLoading(true);
      try {
        const r = await fetch(`/api/logs/activities?${query(more ? cursor : undefined)}`, { cache: 'no-store' });
        const j = await r.json();
        setItems((prev) => (more ? [...prev, ...(j.activities || [])] : j.activities || []));
        setCursor(j.nextCursor);
      } finally {
        setLoading(false);
      }
    },
    [query, cursor]
  );

  useEffect(() => {
    if (open) loadList(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  // One live connection while open, shared by every view: new events and activity status changes
  const listFilter = useRef({ f, debounced });
  listFilter.current = { f, debounced };
  useEffect(() => {
    if (!open) return;
    let es: EventSource | undefined;
    try {
      es = new EventSource('/api/logs/stream');
      es.onmessage = (m) => {
        let msg: LiveMessage;
        try {
          msg = JSON.parse(m.data);
        } catch {
          return;
        }
        for (const fn of listeners.current) fn(msg);
        if (msg.kind === 'activity') {
          const a = msg.activity;
          const { f: cur, debounced: q } = listFilter.current;
          setItems((prev) => {
            const i = prev.findIndex((x) => x.id === a.id);
            if (i >= 0) {
              const copy = prev.slice();
              copy[i] = a;
              return copy;
            }
            const matches =
              (!cur.types || cur.types.includes(a.type)) &&
              (!cur.statuses || cur.statuses.includes(a.status)) &&
              (!q || a.title.toLowerCase().includes(q.toLowerCase()));
            return matches ? [a, ...prev] : prev;
          });
        }
      };
    } catch {
      // EventSource unavailable
    }
    return () => es?.close();
  }, [open]);

  useEffect(() => {
    if (tab === 'events') setEventsMounted(true);
  }, [tab]);

  const openDetail = (id: string) => {
    listScroll.current = bodyRef.current?.scrollTop || 0;
    setView({ kind: 'detail', id });
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: 0 }));
  };
  const back = () => {
    setView({ kind: 'list' });
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: listScroll.current }));
  };

  const isList = view.kind === 'list';
  const title = view.kind === 'settings' ? 'Log Settings' : view.kind === 'detail' ? 'Activity' : 'Activity';

  const toolbar = isList ? (
    <>
      <Segmented
        label="View"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'activity', label: 'Activity' },
          { value: 'events', label: 'All Events' },
        ]}
      />
      {tab === 'activity' && (
        <>
          <SearchField value={search} onChange={setSearch} label="Search activity" placeholder="Search activity" />
          <div className="flex gap-1.5 overflow-x-auto pb-0.5 -mx-1 px-1" role="group" aria-label="Filter">
            {TYPE_FILTERS.map((t) => (
              <Chip key={t.key} on={filter === t.key} onClick={() => setFilter(t.key)} tone={t.key === 'problems' ? ios.red : undefined}>
                {t.label}
              </Chip>
            ))}
          </div>
        </>
      )}
    </>
  ) : undefined;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      zIndex={60}
      bodyRef={bodyRef}
      leftAction={
        view.kind !== 'list' ? (
          <BackButton label={tab === 'events' && view.kind === 'detail' ? 'Events' : 'Activity'} onClick={back} />
        ) : (
          <button
            type="button"
            onClick={() => setView({ kind: 'settings' })}
            aria-label="Log settings"
            className="p-1 -ml-1 rounded hover:opacity-80 focus-visible:outline-2 focus-visible:outline-[#0A84FF]"
            style={{ color: ios.blue }}
          >
            <Glyph d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" size={20} stroke={1.8} />
          </button>
        )
      }
      toolbar={toolbar}
      footer={
        view.kind === 'list' ? (
          <div className="flex items-center justify-between text-[13px]" style={{ color: ios.secondary }}>
            <span className="tabular-nums">
              {tab === 'events'
                ? `${eventCount.n.toLocaleString()}${eventCount.more ? '+' : ''} event${eventCount.n === 1 ? '' : 's'}`
                : `${items.length}${cursor ? '+' : ''} activit${items.length === 1 ? 'y' : 'ies'}`}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-[7px] h-[7px] rounded-full motion-safe:animate-pulse" style={{ background: ios.green }} />
              Recording
            </span>
          </div>
        ) : undefined
      }
    >
      {view.kind === 'settings' && <LogSettingsView />}
      {view.kind === 'detail' && <ActivityDetail id={view.id} subscribe={subscribe} />}
      {/* Stays mounted behind an opened activity, so Back returns to the same filters and results */}
      {eventsMounted && (
        <div hidden={view.kind !== 'list' || tab !== 'events'}>
          <EventsView subscribe={subscribe} onOpenActivity={openDetail} onCount={onEventCount} />
        </div>
      )}
      {view.kind === 'list' && tab === 'activity' && (
        <ActivityList
          items={items}
          loading={loading}
          onOpen={openDetail}
          hasMore={Boolean(cursor)}
          onMore={() => loadList(true)}
          empty={debounced || filter !== 'all' ? 'Nothing matches.' : 'Nothing has happened yet. Moves, deletes, updates and settings changes will appear here.'}
        />
      )}
    </Sheet>
  );
};
