import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackButton,
  Button,
  Checkmark,
  FieldRow,
  Group,
  IconTile,
  LinkButton,
  Row,
  SearchField,
  SectionFooter,
  SectionHeader,
  Segmented,
  Sheet,
  ios,
} from './ui/ios';
import { DeepContainerMetadata, UserGroup, AppOverride, ContainerMount } from '../types';
import { ManifexusAppIcon } from './SoftwareUpdateSheet';
import { copyText } from './ActivitySheet';

/**
 * One screen for any app, and Diagnostics for Manifexus itself: health checks in plain words, live
 * resource use, the details that matter, and drill-down pages for storage, environment, network,
 * logs and customizing how the app shows on the dashboard.
 */

// ----------------------------------------------------------------------------
// Types (mirror server/diagnosticsService.ts)
// ----------------------------------------------------------------------------

type Level = 'ok' | 'warn' | 'error' | 'info';
type Link = 'activity' | 'updates' | 'restore' | 'settings' | 'logs' | 'storage';

interface Check {
  id: string;
  level: Level;
  title: string;
  detail: string;
  link?: Link;
}

interface Resources {
  memoryBytes?: number;
  memoryLimitBytes?: number;
  cpuPercent?: number;
  pids?: number;
  netRxBytes?: number;
  netTxBytes?: number;
}

interface AppDiag {
  name: string;
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  restartCount: number;
  checks: Check[];
  resources?: Resources;
  recent: { ts: string; level: string; message: string }[];
  checkedAt: string;
}

interface SystemDiag {
  summary: { level: Level; text: string };
  checks: Check[];
  resources?: Resources;
  selfId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  environment: any;
  checkedAt: string;
}

type View = 'overview' | 'storage' | 'env' | 'network' | 'logs' | 'customize';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function fmtBytes(b?: number): string {
  if (b === undefined) return '—';
  if (b < 1000 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1000 * 1024 ** 2) return `${(b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function uptime(iso?: string): string {
  if (!iso || iso.startsWith('0001')) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} hours`;
  return `${Math.round(s / 86400)} days`;
}

/** "gamma-cache-1 stopped with …" → "Stopped with …" (the sheet already names the app) */
function eventText(message: string, app: string): string {
  const m = message.startsWith(app + ' ') ? message.slice(app.length + 1) : message;
  return m.charAt(0).toUpperCase() + m.slice(1);
}

const RESTART: Record<string, string> = {
  no: 'Never',
  '': 'Never',
  always: 'Always',
  'unless-stopped': 'Unless stopped',
  'on-failure': 'If it fails',
};

function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

const Glyph: React.FC<{ d: string; size?: number; stroke?: number; color?: string }> = ({ d, size = 16, stroke = 2.2, color = '#fff' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const G = {
  check: 'm5 12.5 4.5 4.5L19 7.5',
  bang: 'M12 7v6M12 17v.01',
  info: 'M12 11v6M12 7.5v.01',
  disk: 'M4 13.5 6.2 6A2 2 0 0 1 8.1 4.5h7.8A2 2 0 0 1 17.8 6l2.2 7.5M4 13.5V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18v-4.5M4 13.5h16M16.5 16.5h.01',
  env: 'M4 6h16M4 12h10M4 18h13',
  net: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3.5 9h17M3.5 15h17M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9s1-6.3 3.5-9Z',
  logs: 'M8 3.5h6l4.5 4.5v11A1.5 1.5 0 0 1 17 20.5H8A1.5 1.5 0 0 1 6.5 19V5A1.5 1.5 0 0 1 8 3.5ZM14 3.5V8h4.5M9.5 12.5h5M9.5 15.5h5',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4',
};

/** Problems first, so the list reads in order of what needs you */
const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, ok: 3 };

const LEVEL_COLOR: Record<Level, string> = { ok: ios.green, warn: ios.orange, error: ios.red, info: '#8E8E93' };

const CheckIcon: React.FC<{ level: Level }> = ({ level }) => (
  <span className="w-[26px] h-[26px] rounded-full flex items-center justify-center flex-shrink-0" style={{ background: LEVEL_COLOR[level] }}>
    <Glyph d={level === 'ok' ? G.check : level === 'info' ? G.info : G.bang} size={14} stroke={3} />
  </span>
);

const NavTile: React.FC<{ d: string; color: string }> = ({ d, color }) => (
  <IconTile color={color}>
    <Glyph d={d} size={17} stroke={2} />
  </IconTile>
);

/** A small stat: big value, quiet label (Apple Health style) */
const Stat: React.FC<{ label: string; value: string; sub?: string; tone?: string }> = ({ label, value, sub, tone }) => (
  <div className="rounded-[12px] px-3.5 py-3 min-w-0" style={{ background: ios.group }}>
    <div className="text-[12px] font-medium" style={{ color: ios.secondary }}>
      {label}
    </div>
    <div className="mt-1 text-[20px] leading-[24px] font-semibold tabular-nums truncate" style={{ color: tone || ios.label }}>
      {value}
    </div>
    {sub && (
      <div className="mt-0.5 text-[11.5px] truncate" style={{ color: ios.tertiary }}>
        {sub}
      </div>
    )}
  </div>
);

/** Row whose value copies when tapped */
const CopyRow: React.FC<{ title: string; value: string; display?: React.ReactNode; mono?: boolean; path?: boolean }> = ({ title, value, display, mono, path }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Row
      onClick={async () => {
        if (await copyText(value)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }
      }}
      title={title}
      trailing={
        <span
          className={`block truncate max-w-[52vw] sm:max-w-[440px] ${mono ? 'font-mono text-[13px]' : ''}`}
          // Long paths lose their start, not their end: "…/stack/docker-compose.yml"
          style={{ color: copied ? ios.green : undefined, direction: path && !copied ? 'rtl' : undefined }}
        >
          {copied ? 'Copied' : path ? <bdi>{display ?? value}</bdi> : display ?? value}
        </span>
      }
    />
  );
};

/** One mount, one row: where the app sees it, and where it lives on the server */
const StorageRow: React.FC<{ mount: ContainerMount }> = ({ mount: m }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Row
      onClick={async () => {
        if (await copyText(m.source)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }
      }}
      title={<span className="font-mono text-[14px] truncate block">{m.destination}</span>}
      subtitle={
        <span className="font-mono text-[12.5px] truncate block" style={{ color: copied ? ios.green : undefined }}>
          {copied ? 'Copied' : m.type === 'volume' && m.name ? `Volume “${m.name}”` : m.source}
        </span>
      }
      trailing={!m.rw ? <span className="text-[13px]">Read Only</span> : undefined}
    />
  );
};

// ----------------------------------------------------------------------------
// Sheet
// ----------------------------------------------------------------------------

export const AppDetailsSheet: React.FC<{
  container: DeepContainerMetadata | null;
  /** Manifexus itself: shows system Diagnostics */
  system?: boolean;
  groups: UserGroup[];
  hostAddress: string;
  onClose: () => void;
  onSaveOverride: (containerId: string, override: AppOverride) => Promise<void>;
  onAction?: (containerId: string, action: 'start' | 'stop' | 'restart') => Promise<void> | void;
  /** These open on top of this sheet, which waits underneath with a way back to it */
  onOpenUpdates?: () => void;
  onOpenRestore?: () => void;
  onOpenSettings?: () => void;
  onOpenActivity?: (filter?: string) => void;
  /** Another screen is open on top of this one */
  covered?: boolean;
}> = ({ container, system, groups, hostAddress, onClose, onSaveOverride, onAction, onOpenUpdates, onOpenRestore, onOpenSettings, onOpenActivity, covered }) => {
  const open = Boolean(container);
  const [stack, setStack] = useState<View[]>(['overview']);
  const view = stack[stack.length - 1];
  const [diag, setDiag] = useState<AppDiag | null>(null);
  const [sys, setSys] = useState<SystemDiag | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [busyAction, setBusyAction] = useState<string>();
  const [report, setReport] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  const bodyRef = useRef<HTMLDivElement>(null);
  const toFixRef = useRef<HTMLElement>(null);

  // Logs
  const [logs, setLogs] = useState<string | null>(null);
  const [logTail, setLogTail] = useState<'200' | '1000' | 'all'>('200');
  const [logQuery, setLogQuery] = useState('');
  const [logCopied, setLogCopied] = useState(false);

  // Customize
  const [custom, setCustom] = useState({ name: '', group: '', port: '', url: '', icon: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);

  const push = (v: View) => {
    setStack((s) => [...s, v]);
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: 0 }));
  };
  const pop = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  const load = useCallback(async () => {
    if (!container) return;
    setLoading(true);
    setError(undefined);
    try {
      if (system) {
        const r = await fetch('/api/diagnostics', { cache: 'no-store' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setSys(j);
      } else {
        const r = await fetch(`/api/containers/${encodeURIComponent(container.id)}/diagnostics`, { cache: 'no-store' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setDiag(j);
      }
    } catch (e) {
      setError((e as Error).message || 'Couldn’t run the checks.');
    } finally {
      setLoading(false);
    }
  }, [container, system]);

  useEffect(() => {
    if (!container) return;
    setStack(['overview']);
    setDiag(null);
    setSys(null);
    setLogs(null);
    setLogQuery('');
    setIconFailed(false);
    setCustom({
      name: container.customName || '',
      group: container.customGroup || '',
      port: container.primaryPort ? String(container.primaryPort) : '',
      url: container.customUrl || '',
      icon: container.iconUrl || '',
      notes: container.notes || '',
    });
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container?.id, system]);

  // Coming back from a screen opened on top (Restore, Settings…): run the checks again, since
  // whatever was fixed there should show here
  const wasCovered = useRef(false);
  useEffect(() => {
    if (wasCovered.current && !covered) load();
    wasCovered.current = Boolean(covered);
  }, [covered, load]);

  const loadLogs = useCallback(async () => {
    if (!container) return;
    setLogs(null);
    const r = await fetch(`/api/containers/${encodeURIComponent(container.id)}/logs?tail=${logTail}`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({ text: '', error: 'Couldn’t read the logs.' }));
    setLogs(j.error && !j.text ? `⚠ ${j.error}` : j.text || '');
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }));
  }, [container, logTail]);

  useEffect(() => {
    if (view === 'logs') loadLogs();
  }, [view, loadLogs]);

  if (!container) return null;

  const name = system ? 'Manifexus' : container.customName || container.cleanName;
  const running = diag ? diag.running : container.state === 'running';
  const checks = system ? sys?.checks : diag?.checks;
  const resources = system ? sys?.resources : diag?.resources;
  const launchUrl = container.customUrl || (container.primaryPort ? `http://${hostAddress}:${container.primaryPort}` : undefined);

  const followLink = (link?: Link, checkId?: string) => {
    if (!link) return;
    if (link === 'logs') return push('logs');
    if (link === 'storage') return push('storage');
    if (link === 'activity') return onOpenActivity?.(checkId === 'problems' ? 'problems' : undefined);
    if (link === 'updates') return onOpenUpdates?.();
    if (link === 'restore') return onOpenRestore?.();
    return onOpenSettings?.();
  };

  const act = async (a: 'start' | 'stop' | 'restart') => {
    if (!onAction) return;
    setBusyAction(a);
    try {
      await onAction(container.id, a);
    } finally {
      setBusyAction(undefined);
      load();
    }
  };

  const copyReport = async () => {
    setReport('busy');
    try {
      const r = await fetch('/api/diagnostics/report');
      setReport((await copyText(await r.text())) ? 'done' : 'failed');
    } catch {
      setReport('failed');
    }
    setTimeout(() => setReport('idle'), 2500);
  };

  // Current issues (warnings, errors) sit at the top under "To Fix" until the checks stop finding them
  const isIssue = (c: Check) => c.level === 'warn' || c.level === 'error';
  const issues = (checks || []).filter(isIssue).sort((a, b) => RANK[a.level] - RANK[b.level]);
  const checkRow = (c: Check) => (
    <Row
      key={c.id}
      onClick={c.link ? () => followLink(c.link, c.id) : undefined}
      leading={<CheckIcon level={c.level} />}
      title={c.title}
      subtitle={<span className="line-clamp-3">{c.detail}</span>}
      chevron={Boolean(c.link)}
    />
  );

  // ---------------------------------------------------------------- status line under the name
  const statusPill = (() => {
    if (system && sys) {
      const c = LEVEL_COLOR[sys.summary.level];
      return { text: sys.summary.text, color: c, bg: `${c}26` };
    }
    const state = diag?.checks.find((c) => c.id === 'state');
    const unhealthy = diag?.checks.find((c) => c.id === 'health' && c.level === 'error');
    if (unhealthy) return { text: 'Running · Unhealthy', color: ios.orange, bg: 'rgba(255,159,10,0.15)' };
    if (state?.title === 'Keeps restarting') return { text: 'Keeps Restarting', color: ios.red, bg: 'rgba(255,69,58,0.15)' };
    if (running) return { text: `Running${diag?.startedAt ? ` · ${uptime(diag.startedAt)}` : ''}`, color: ios.green, bg: 'rgba(48,209,88,0.15)' };
    return {
      text: `Stopped${diag?.exitCode !== undefined ? ` · exit ${diag.exitCode}` : ''}`,
      color: diag && diag.exitCode !== 0 && diag.exitCode !== 143 ? ios.red : ios.secondary,
      bg: 'rgba(118,118,128,0.22)',
    };
  })();

  const icon = system ? (
    <span className="block w-[64px] h-[64px] [&>svg]:w-full [&>svg]:h-full" style={{ filter: 'drop-shadow(0 8px 18px rgba(47,140,255,0.35))' }}>
      <ManifexusAppIcon size={64} />
    </span>
  ) : container.iconUrl && !iconFailed ? (
    <span className="w-[64px] h-[64px] rounded-[15px] flex items-center justify-center overflow-hidden" style={{ background: '#fff' }}>
      <img src={container.iconUrl} alt="" onError={() => setIconFailed(true)} className="w-[46px] h-[46px] object-contain" />
    </span>
  ) : (
    <IconTile color="#5E5CE6" size={64}>
      <span className="text-[26px] font-semibold text-white">{name.slice(0, 1).toUpperCase()}</span>
    </IconTile>
  );

  // ---------------------------------------------------------------- views
  let body: React.ReactNode = null;
  let footer: React.ReactNode = null;
  let title = system ? 'Diagnostics' : 'App Details';

  if (view === 'overview') {
    const r = resources;
    body = (
      <div className="space-y-7">
        <div className="flex flex-col items-center text-center pt-1">
          {icon}
          <h3 className="mt-4 text-[22px] leading-[27px] font-semibold text-white px-4 truncate max-w-full">{name}</h3>
          <p className="mt-1 text-[13px] font-mono truncate max-w-[520px] px-4" style={{ color: ios.secondary }}>
            {system && sys?.environment?.manifexus?.build ? `${sys.environment.manifexus.build} · ${container.image}` : container.image}
          </p>
          {(() => {
            const pill = (
              <>
                <span className="w-[7px] h-[7px] rounded-full" style={{ background: 'currentColor' }} />
                {loading && !diag && !sys ? 'Checking…' : statusPill.text}
              </>
            );
            const cls = 'mt-3 inline-flex items-center gap-1.5 h-[26px] px-3 rounded-full text-[13px] font-medium';
            return issues.length > 0 ? (
              <button
                type="button"
                onClick={() => toFixRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className={`${cls} hover:opacity-85 focus-visible:outline-2 focus-visible:outline-[#0A84FF]`}
                style={{ color: statusPill.color, background: statusPill.bg }}
                title="Show what to fix"
              >
                {pill}
                <svg width="7" height="11" viewBox="0 0 8 13" aria-hidden="true" className="rotate-90 ml-0.5">
                  <path d="M1.5 1.5 6.5 6.5 1.5 11.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : (
              <span className={cls} style={{ color: statusPill.color, background: statusPill.bg }}>
                {pill}
              </span>
            );
          })()}
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {system ? (
              <>
                <Button onClick={copyReport} variant="tinted" className="!h-[36px] !px-4 !text-[14px]">
                  {report === 'busy' ? 'Preparing…' : report === 'done' ? 'Copied' : report === 'failed' ? 'Couldn’t Copy' : 'Copy Report'}
                </Button>
                <Button onClick={() => download('/api/diagnostics/report?download=1')} tone="gray" className="!h-[36px] !px-4 !text-[14px]">
                  Download
                </Button>
              </>
            ) : (
              <>
                {launchUrl && running && (
                  <Button onClick={() => window.open(launchUrl, '_blank', 'noopener')} variant="tinted" className="!h-[36px] !px-4 !text-[14px]">
                    Open
                  </Button>
                )}
                {onAction && running && (
                  <Button onClick={() => act('restart')} tone="gray" disabled={Boolean(busyAction)} className="!h-[36px] !px-4 !text-[14px]">
                    {busyAction === 'restart' ? 'Restarting…' : 'Restart'}
                  </Button>
                )}
                {onAction && (
                  <Button onClick={() => act(running ? 'stop' : 'start')} tone="gray" disabled={Boolean(busyAction)} className="!h-[36px] !px-4 !text-[14px]">
                    {busyAction === 'stop' ? 'Stopping…' : busyAction === 'start' ? 'Starting…' : running ? 'Stop' : 'Start'}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>

        {issues.length > 0 && (
          <section ref={toFixRef} className="scroll-mt-4">
            <SectionHeader>To Fix</SectionHeader>
            <Group>{issues.map(checkRow)}</Group>
            <SectionFooter>These stay here until they’re fixed. Check Again after fixing one.</SectionFooter>
          </section>
        )}

        {r && (r.memoryBytes !== undefined || r.cpuPercent !== undefined) && (
          <section>
            <SectionHeader>Right Now</SectionHeader>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <Stat
                label="Memory"
                value={fmtBytes(r.memoryBytes)}
                sub={r.memoryLimitBytes ? `of ${fmtBytes(r.memoryLimitBytes)} limit` : 'no limit set'}
                tone={r.memoryLimitBytes && r.memoryBytes && r.memoryBytes / r.memoryLimitBytes > 0.9 ? ios.orange : undefined}
              />
              <Stat label="CPU" value={r.cpuPercent !== undefined ? `${r.cpuPercent}%` : '—'} sub="100% is one full core" />
              <Stat label="Processes" value={r.pids !== undefined ? String(r.pids) : '—'} sub="inside the container" />
              <Stat label="Network" value={`${fmtBytes(r.netRxBytes || 0)} in`} sub={`${fmtBytes(r.netTxBytes || 0)} out`} />
            </div>
          </section>
        )}

        <section>
          <SectionHeader>{system ? 'System Health' : 'Health'}</SectionHeader>
          <Group>
            {error ? (
              <Row leading={<CheckIcon level="warn" />} title="Couldn’t run the checks" subtitle={error} />
            ) : !checks ? (
              <Row title={<span style={{ color: ios.secondary }}>Checking…</span>} />
            ) : (
              [...checks]
                .filter((c) => !isIssue(c))
                // The history counter is background, so it goes last
                .sort((a, b) => Number(a.id === 'problems') - Number(b.id === 'problems') || RANK[a.level] - RANK[b.level])
                .map(checkRow)
            )}
          </Group>
        </section>

        {!system && diag && diag.recent.length > 0 && (
          <section>
            <SectionHeader>Recent Events</SectionHeader>
            <Group>
              {diag.recent.map((e, i) => (
                <Row
                  key={i}
                  leading={<span className="w-[7px] h-[7px] rounded-full" style={{ background: e.level === 'warn' || e.level === 'error' ? ios.orange : ios.blue }} />}
                  title={<span className="text-[14px] whitespace-normal">{eventText(e.message, container.cleanName)}</span>}
                  trailing={<span className="text-[13px] tabular-nums whitespace-nowrap">{fmtWhen(e.ts)}</span>}
                />
              ))}
            </Group>
            <SectionFooter>From the last 7 days, recorded by Activity.</SectionFooter>
          </section>
        )}

        <section>
          <SectionHeader>Details</SectionHeader>
          <Group>
            {container.compose.isCompose ? (
              <>
                <Row title="Stack" trailing={<span>{container.compose.project}</span>} />
                {container.compose.configFiles && <CopyRow title="Compose File" value={container.compose.configFiles} mono path />}
              </>
            ) : (
              <Row title="Stack" trailing={<span>Standalone app (docker run)</span>} />
            )}
            <CopyRow title="Image" value={container.image} mono />
            <CopyRow title="Container ID" value={container.id} display={container.id.slice(0, 12)} mono />
            <Row title="Created" trailing={<span>{new Date(container.created * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>} />
            <Row title="Restarts Automatically" trailing={<span>{RESTART[container.restartPolicy || ''] || container.restartPolicy}</span>} />
            {container.command && <CopyRow title="Command" value={container.command} mono />}
            {system && sys?.environment?.docker?.version && (
              <Row title="Docker" trailing={<span>{sys.environment.docker.version} · {sys.environment.docker.os}</span>} />
            )}
          </Group>
          <SectionFooter>Tap a value to copy it.</SectionFooter>
        </section>

        <section>
          <Group className="ios-inset-icon">
            <Row onClick={() => push('storage')} leading={<NavTile d={G.disk} color="#8E8E93" />} title="Storage" trailing={<span className="tabular-nums">{container.mounts.length}</span>} chevron />
            <Row onClick={() => push('env')} leading={<NavTile d={G.env} color="#64D2FF" />} title="Environment" trailing={<span className="tabular-nums">{container.envVars.length}</span>} chevron />
            <Row
              onClick={() => push('network')}
              leading={<NavTile d={G.net} color="#0A84FF" />}
              title="Network & Ports"
              trailing={<span className="tabular-nums">{container.ports.filter((p) => p.publicPort).length || ''}</span>}
              chevron
            />
            {system ? (
              <Row onClick={() => followLink('activity')} leading={<NavTile d={G.logs} color="#30D158" />} title="Activity" subtitle="Everything Manifexus has done" chevron />
            ) : (
              <Row onClick={() => push('logs')} leading={<NavTile d={G.logs} color="#30D158" />} title="App Output" subtitle="What the app itself has printed" chevron />
            )}
            {!system && <Row onClick={() => push('customize')} leading={<NavTile d={G.pencil} color="#FF9F0A" />} title="Customize" subtitle="Name, group, launch link, icon and notes" chevron />}
          </Group>
        </section>
      </div>
    );
    const checkedAt = system ? sys?.checkedAt : diag?.checkedAt;
    footer = (
      <div className="flex items-center justify-between text-[13px]" style={{ color: ios.secondary }}>
        <span className="tabular-nums">{loading ? 'Checking…' : checkedAt ? `Checked ${fmtTime(checkedAt)}` : ''}</span>
        <LinkButton onClick={load}>Check Again</LinkButton>
      </div>
    );
  } else if (view === 'storage') {
    title = 'Storage';
    body = container.mounts.length ? (
      <section>
        <Group>
          {container.mounts.map((m, i) => (
            <StorageRow key={i} mount={m} />
          ))}
        </Group>
        <SectionFooter>Each row is where the app sees its data, with the folder or volume on your server underneath. Tap a row to copy the server path.</SectionFooter>
      </section>
    ) : (
      <p className="text-[15px] text-center py-16" style={{ color: ios.secondary }}>This app doesn’t keep any data outside the container.</p>
    );
  } else if (view === 'env') {
    title = 'Environment';
    body = container.envVars.length ? (
      <EnvList vars={container.envVars} />
    ) : (
      <p className="text-[15px] text-center py-16" style={{ color: ios.secondary }}>No settings are passed to this app.</p>
    );
  } else if (view === 'network') {
    title = 'Network & Ports';
    const primary = Number(custom.port) || container.primaryPort;
    body = (
      <div className="space-y-7">
        <section>
          <SectionHeader>Ports</SectionHeader>
          <Group>
            {container.ports.length === 0 && <Row title={<span style={{ color: ios.secondary }}>No ports</span>} />}
            {container.ports.map((p, i) => {
              const isMain = Boolean(p.publicPort && p.publicPort === primary);
              return (
                <Row
                  key={i}
                  title={
                    <span className="tabular-nums">
                      {p.publicPort ? `${p.ip && p.ip !== '0.0.0.0' ? `${p.ip}:` : ''}${p.publicPort}` : 'Not published'} → {p.privatePort}/{p.type}
                    </span>
                  }
                  subtitle={[p.label, isMain ? 'Opens from the app card' : ''].filter(Boolean).join(' · ') || undefined}
                  trailing={
                    p.publicPort ? (
                      <span className="flex items-center gap-3">
                        {isMain ? (
                          <Checkmark />
                        ) : (
                          <LinkButton
                            onClick={() => {
                              setCustom((c) => ({ ...c, port: String(p.publicPort) }));
                              onSaveOverride(container.id, {
                                customName: custom.name.trim() || undefined,
                                customGroup: custom.group || undefined,
                                customPort: p.publicPort,
                                customUrl: custom.url.trim() || undefined,
                                customIcon: custom.icon.trim() || undefined,
                                notes: custom.notes.trim() || undefined,
                              });
                            }}
                          >
                            Use for Card
                          </LinkButton>
                        )}
                        <LinkButton onClick={() => window.open(`http://${hostAddress}:${p.publicPort}`, '_blank', 'noopener')}>Open</LinkButton>
                      </span>
                    ) : undefined
                  }
                />
              );
            })}
          </Group>
          <SectionFooter>The checked port is the one the app card opens.</SectionFooter>
        </section>
        <section>
          <SectionHeader>Networks</SectionHeader>
          <Group>
            {(container.networks.length ? container.networks : ['bridge']).map((n) => (
              <Row key={n} title={n} />
            ))}
            {container.ipAddress && <CopyRow title="Address Inside Docker" value={container.ipAddress} mono />}
          </Group>
        </section>
      </div>
    );
  } else if (view === 'logs') {
    title = 'App Output';
    const lines = (logs || '').split('\n');
    const q = logQuery.trim().toLowerCase();
    const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
    body = (
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1">
            <SearchField value={logQuery} onChange={setLogQuery} label="Search output" placeholder="Search output" />
          </div>
          <div className="sm:w-[280px]">
            <Segmented
              label="How much"
              value={logTail}
              onChange={setLogTail}
              options={[
                { value: '200', label: 'Last 200' },
                { value: '1000', label: '1,000' },
                { value: 'all', label: 'All' },
              ]}
            />
          </div>
        </div>
        {logs === null ? (
          <p className="text-[15px] text-center py-16" style={{ color: ios.secondary }}>Reading…</p>
        ) : !logs.trim() ? (
          <p className="text-[15px] text-center py-16" style={{ color: ios.secondary }}>The app hasn’t printed anything yet.</p>
        ) : (
          <div className="rounded-[12px] px-3.5 py-3 font-mono text-[12px] leading-[18px] overflow-x-auto" style={{ background: 'rgba(0,0,0,0.35)' }}>
            {shown.map((l, i) => (
              <div
                key={i}
                className="whitespace-pre-wrap break-words"
                style={{ color: /\b(error|fatal|panic|exception|fail(ed|ure)?)\b/i.test(l) ? '#FF8A80' : /\bwarn(ing)?\b/i.test(l) ? '#FFB340' : 'rgba(235,235,245,0.8)' }}
              >
                {l || ' '}
              </div>
            ))}
            {q && shown.length === 0 && <div style={{ color: ios.tertiary }}>No lines match.</div>}
          </div>
        )}
      </div>
    );
    footer = (
      <div className="flex items-center justify-between gap-3">
        <LinkButton onClick={loadLogs}>Refresh</LinkButton>
        <div className="flex items-center gap-4">
          <LinkButton
            onClick={async () => {
              if (logs && (await copyText(logs))) {
                setLogCopied(true);
                setTimeout(() => setLogCopied(false), 1500);
              }
            }}
          >
            {logCopied ? 'Copied' : 'Copy'}
          </LinkButton>
          <LinkButton onClick={() => download(`/api/containers/${encodeURIComponent(container.id)}/logs?tail=${logTail}&download=1&name=${encodeURIComponent(container.cleanName)}`)}>
            Download
          </LinkButton>
        </div>
      </div>
    );
  } else if (view === 'customize') {
    title = 'Customize';
    const ports = container.ports.filter((p) => p.publicPort);
    body = (
      <div className="space-y-7">
        <section>
          <SectionHeader>On the Dashboard</SectionHeader>
          <Group>
            <FieldRow id="cust-name" label="Name" value={custom.name} onChange={(v) => setCustom((c) => ({ ...c, name: v }))} placeholder={container.cleanName} />
            <FieldRow id="cust-icon" label="Icon" value={custom.icon} onChange={(v) => setCustom((c) => ({ ...c, icon: v }))} placeholder="Image link (optional)" mono />
          </Group>
        </section>
        <section>
          <SectionHeader>Open Link</SectionHeader>
          {ports.length > 0 && (
            <div className="mb-2">
              <Segmented
                label="Port the card opens"
                value={custom.port}
                onChange={(v) => setCustom((c) => ({ ...c, port: v }))}
                options={ports.map((p) => ({ value: String(p.publicPort), label: `${p.publicPort}${p.label ? ` · ${p.label}` : ''}` }))}
              />
            </div>
          )}
          <Group>
            <FieldRow id="cust-url" label="Custom Link" value={custom.url} onChange={(v) => setCustom((c) => ({ ...c, url: v }))} placeholder="https://app.example.com (optional)" mono />
          </Group>
          <SectionFooter>The app card opens the custom link if you set one, otherwise http://{hostAddress}:{custom.port || 'port'}.</SectionFooter>
        </section>
        <section>
          <SectionHeader>Group</SectionHeader>
          <Group>
            {[{ id: '', name: 'None' }, ...groups].map((g) => (
              <Row
                key={g.id || 'none'}
                role="radio"
                ariaChecked={custom.group === g.id}
                onClick={() => setCustom((c) => ({ ...c, group: g.id }))}
                title={g.name}
                trailing={<span className="w-[15px] flex justify-center">{custom.group === g.id && <Checkmark />}</span>}
              />
            ))}
          </Group>
        </section>
        <section>
          <SectionHeader>Notes</SectionHeader>
          <Group>
            <textarea
              value={custom.notes}
              onChange={(e) => setCustom((c) => ({ ...c, notes: e.target.value }))}
              rows={4}
              placeholder="Anything you want to remember about this app"
              className="w-full bg-transparent px-4 py-3 text-[15px] leading-[21px] resize-none focus:outline-none placeholder:text-[rgba(235,235,245,0.3)]"
              style={{ color: ios.label }}
            />
          </Group>
          <SectionFooter>Saved in Manifexus only; the app itself isn’t changed.</SectionFooter>
        </section>
      </div>
    );
    footer = (
      <div className="flex justify-end">
        <Button
          disabled={saving}
          className="w-full sm:w-auto sm:min-w-[160px]"
          onClick={async () => {
            setSaving(true);
            try {
              await onSaveOverride(container.id, {
                customName: custom.name.trim() || undefined,
                customGroup: custom.group || undefined,
                customPort: custom.port ? parseInt(custom.port, 10) : undefined,
                customUrl: custom.url.trim() || undefined,
                customIcon: custom.icon.trim() || undefined,
                notes: custom.notes.trim() || undefined,
              });
              pop();
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    );
  }

  const backLabel = stack.length > 1 ? (system ? 'Diagnostics' : 'Details') : '';

  return (
    <Sheet
      open={open}
      hidden={covered}
      onClose={onClose}
      title={title}
      leftAction={stack.length > 1 ? <BackButton label={backLabel} onClick={pop} /> : undefined}
      footer={footer}
      bodyRef={bodyRef}
    >
      <div key={view} className={stack.length > 1 ? 'motion-safe:animate-[ios-push-in_200ms_ease-out]' : ''}>
        {body}
      </div>
    </Sheet>
  );
};

/** Environment settings, searchable; hidden values stay hidden */
const EnvList: React.FC<{ vars: { key: string; value: string; isSensitive: boolean }[] }> = ({ vars }) => {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return [...vars].sort((a, b) => a.key.localeCompare(b.key)).filter((v) => !s || `${v.key} ${v.isSensitive ? '' : v.value}`.toLowerCase().includes(s));
  }, [vars, q]);
  return (
    <div className="space-y-4">
      {vars.length > 8 && <SearchField value={q} onChange={setQ} label="Search settings" placeholder={`Search ${vars.length} settings`} />}
      <Group>
        {list.map((v) =>
          v.isSensitive ? (
            <Row key={v.key} title={<span className="font-mono text-[13px]">{v.key}</span>} trailing={<span style={{ color: ios.tertiary }}>Hidden</span>} />
          ) : (
            <CopyRow key={v.key} title={v.key} value={v.value} mono />
          )
        )}
        {list.length === 0 && <Row title={<span style={{ color: ios.secondary }}>No settings match.</span>} />}
      </Group>
      <SectionFooter>Passwords, tokens and keys are hidden. Tap a value to copy it.</SectionFooter>
    </div>
  );
};
