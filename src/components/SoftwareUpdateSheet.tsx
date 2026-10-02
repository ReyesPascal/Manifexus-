import React, { useEffect, useRef, useState } from 'react';
import { BackButton, Button, Group, LinkButton, Row, SectionFooter, SectionHeader, Sheet, Switch, ios } from './ui/ios';

// Mirrors server/updateService.ts
export interface BuildInfo {
  /** "1.1" when this build has a version number */
  version?: string;
  revision?: string;
  created?: string;
  label: string;
}
export interface UpdateProgress {
  stage: 'download' | 'prepare' | 'restart' | 'done' | 'error';
  percent?: number;
  message: string;
  bytesDone?: number;
  bytesTotal?: number;
  toImageId?: string;
  fromImageId?: string;
}
export interface SoftwareUpdateState {
  supported: boolean;
  unsupportedReason?: string;
  installMode?: 'compose' | 'standalone';
  current: BuildInfo & { imageId?: string };
  status: 'up_to_date' | 'available' | 'unknown';
  latest?: BuildInfo & { digest: string; sizeBytes?: number; downloadBytes?: number; notes: { sha: string; title: string; date?: string }[]; totalCommits?: number; releases?: Release[] };
  lastCheckedAt?: string;
  checkError?: string;
  checking: boolean;
  installing?: UpdateProgress;
  lastOutcome?: { status: 'success' | 'rolled_back' | 'failed'; from?: string; to?: string; message: string; finishedAt: string };
  settings: { autoCheck: boolean; autoInstall: boolean };
  /** This version's own release notes */
  currentRelease?: Release;
  /** The developer has chosen the version every Manifexus runs; ordinary updates wait (mirrors server) */
  pinned?: { version: string; message?: string };
}

/** A version's notes, written for people (mirrors server/releaseNotes.ts) */
export interface Release {
  version: string;
  date: string;
  headline: string;
  new?: string[];
  improved?: string[];
  fixed?: string[];
}

const NOTE_KINDS: { key: 'new' | 'improved' | 'fixed'; label: string; color: string; d: string }[] = [
  { key: 'new', label: 'New', color: '#BF5AF2', d: 'M12 3c.4 3.6 1.8 5.9 4.1 7 1.2.6 2.7.9 4.4 1.1v1.5c-1.7.2-3.2.5-4.4 1.1-2.3 1.1-3.7 3.4-4.1 7h-1c-.4-3.6-1.8-5.9-4.1-7-1.2-.6-2.7-.9-4.4-1.1v-1.5c1.7-.2 3.2-.5 4.4-1.1 2.3-1.1 3.7-3.4 4.1-7h1Z' },
  { key: 'improved', label: 'Improved', color: '#0A84FF', d: 'M12 19V5M5.5 11.5 12 5l6.5 6.5' },
  { key: 'fixed', label: 'Fixed', color: '#30D158', d: 'm5 12.5 4.5 4.5L19 7.5' },
];

/** First sentence bold, the rest quiet: "Ask Manifexus. Tap Ask…" */
const NoteText: React.FC<{ text: string }> = ({ text }) => {
  const m = /^(.+?[.!?])\s+(.+)$/.exec(text);
  if (!m || m[1].length > 60) return <span>{text}</span>;
  return (
    <span>
      <span className="font-semibold text-white">{m[1]}</span> <span style={{ color: 'rgba(235,235,245,0.7)' }}>{m[2]}</span>
    </span>
  );
};

/** What's New for one version, App Store style: a headline, then New / Improved / Fixed */
export const ReleaseCard: React.FC<{ r: Release; title?: string }> = ({ r, title }) => (
  <section>
    <SectionHeader>{title || `What’s New in ${r.version}`}</SectionHeader>
    <Group>
      <div className="px-4 pt-3.5 pb-4 space-y-4">
        <p className="text-[15px] leading-[21px] font-medium text-white">{r.headline}</p>
        {NOTE_KINDS.filter((k) => r[k.key]?.length).map((k) => (
          <div key={k.key}>
            <div className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide" style={{ color: k.color }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill={k.key === 'new' ? k.color : 'none'} stroke={k.key === 'new' ? 'none' : k.color} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={k.d} />
              </svg>
              {k.label}
            </div>
            <ul className="mt-1.5 space-y-1.5">
              {r[k.key]!.map((t, i) => (
                <li key={i} className="flex gap-2.5 text-[15px] leading-[20px]">
                  <span className="mt-[8px] w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: k.color }} />
                  <NoteText text={t} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Group>
  </section>
);

/** The Manifexus app icon: a rounded tile with the hub-and-nodes mark. */
export const ManifexusAppIcon: React.FC<{ size?: number }> = ({ size = 64 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="mfx-tile" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#2F8CFF" />
        <stop offset="1" stopColor="#5B4BF5" />
      </linearGradient>
      <linearGradient id="mfx-shine" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
        <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="14.5" fill="url(#mfx-tile)" />
    <rect width="64" height="64" rx="14.5" fill="url(#mfx-shine)" />
    <g stroke="#fff" strokeWidth="2.6" strokeLinecap="round" opacity="0.9">
      <path d="M32 26.5V19M26.9 35 20.5 38.7M37.1 35l6.4 3.7" />
    </g>
    <circle cx="32" cy="32" r="6.5" fill="#fff" />
    <circle cx="32" cy="15" r="4" fill="#fff" />
    <circle cx="17" cy="41" r="4" fill="#fff" />
    <circle cx="47" cy="41" r="4" fill="#fff" />
  </svg>
);

/** Small toolbar glyph: arrow into a tray, used for the update button. */
export const UpdateGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v8M8.5 12.5 12 16l3.5-3.5" />
  </svg>
);

/**
 * How much the update downloads: exactly what's new (usually just Manifexus's own code, a few MB, since the
 * parts already on the server are reused), or the most it can be when that can't be worked out.
 */
function downloadText(l: { sizeBytes?: number; downloadBytes?: number }): string {
  if (typeof l.downloadBytes === 'number') return l.downloadBytes > 0 ? `${formatBytes(l.downloadBytes)} download` : 'Nothing new to download';
  return l.sizeBytes ? `Up to ${formatBytes(l.sizeBytes)} download` : '';
}

function formatBytes(b?: number): string {
  if (!b) return '';
  const mb = b / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function timeAgo(iso?: string): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return formatDate(iso);
}

type Phase = 'idle' | 'download' | 'prepare' | 'restart' | 'starting' | 'done' | 'rolled_back' | 'error';

interface SoftwareUpdateSheetProps {
  open: boolean;
  onClose: () => void;
  state: SoftwareUpdateState | null;
  onStateChange: (s: SoftwareUpdateState) => void;
  /** Opened from another screen (e.g. Diagnostics): shows "‹ label" to go back to it */
  backLabel?: string;
  onBack?: () => void;
}

const Spinner: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin motion-reduce:animate-none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="none" stroke="rgba(235,235,245,0.18)" strokeWidth="3" />
    <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke={ios.blue} strokeWidth="3" strokeLinecap="round" />
  </svg>
);

const StepIcon: React.FC<{ state: 'pending' | 'active' | 'done' | 'failed' }> = ({ state }) => {
  if (state === 'active') return <Spinner size={20} />;
  if (state === 'done')
    return (
      <span className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: ios.green }} aria-hidden="true">
        <svg width="11" height="9" viewBox="0 0 12 10"><path d="M1.5 5.2 4.4 8 10.5 1.8" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
    );
  if (state === 'failed')
    return (
      <span className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[12px] font-bold" style={{ background: ios.red }} aria-hidden="true">
        !
      </span>
    );
  return <span className="w-5 h-5 rounded-full" style={{ boxShadow: `inset 0 0 0 1.5px ${ios.control}` }} aria-hidden="true" />;
};

/**
 * Software Update (Apple-style): current build, automatic checks, what's new, and a fully tracked
 * install that follows Manifexus through its restart and reloads the page on the new version.
 */
export const SoftwareUpdateSheet: React.FC<SoftwareUpdateSheetProps> = ({ open, onClose, state, onStateChange, backLabel, onBack }) => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const target = useRef<{ from?: string; to?: string; startedAt?: number }>({});
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // While it only waits for a move or restore to finish, the screen can be closed (the update carries on)
  const busy = phase === 'download' || (phase === 'prepare' && !/^Downloaded\. Waiting/.test(progress?.message || '')) || phase === 'restart' || phase === 'starting';

  useEffect(() => () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  // Re-attach if an update is already running on the server (e.g. page was reloaded mid-download)
  useEffect(() => {
    if (open && state?.installing && ['download', 'prepare', 'restart'].includes(state.installing.stage) && phase === 'idle') {
      target.current = { from: state.installing.fromImageId, to: state.installing.toImageId };
      setProgress(state.installing);
      setPhase(state.installing.stage as Phase);
      if (state.installing.stage === 'restart') followRestart();
      else pollInstall();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state?.installing?.stage]);

  const checkNow = async () => {
    setChecking(true);
    try {
      const r = await fetch('/api/system/update/check', { method: 'POST' });
      if (r.ok) onStateChange(await r.json());
    } finally {
      setChecking(false);
    }
  };

  const saveSettings = async (patch: Partial<SoftwareUpdateState['settings']>) => {
    if (!state) return;
    onStateChange({ ...state, settings: { ...state.settings, ...patch } });
    await fetch('/api/system/update/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {});
  };

  /** While Manifexus restarts, poll until the new version answers (or a rollback is reported). */
  const followRestart = () => {
    const started = Date.now();
    setPhase('restart');
    const tick = async () => {
      try {
        const r = await fetch('/api/system/update', { cache: 'no-store' });
        if (r.ok) {
          const s: SoftwareUpdateState = await r.json();
          if (target.current.to && s.current.imageId === target.current.to) {
            setPhase('starting');
            onStateChange(s);
            setTimeout(() => setPhase('done'), 900);
            setTimeout(() => window.location.reload(), 2600);
            return;
          }
          const outcomeAt = s.lastOutcome ? new Date(s.lastOutcome.finishedAt).getTime() : 0;
          const isThisUpdate = outcomeAt >= (target.current.startedAt || started) - 60 * 1000;
          if (s.lastOutcome?.status === 'rolled_back' && isThisUpdate && s.current.imageId === target.current.from) {
            onStateChange(s);
            setError(s.lastOutcome.message);
            setPhase('rolled_back');
            return;
          }
          // Old version still answering: the helper hasn't stopped it yet
        } else {
          setPhase('starting');
        }
      } catch {
        // Server is down while the container is recreated
        setPhase((p) => (p === 'restart' && Date.now() - started > 4000 ? 'starting' : p));
      }
      if (Date.now() - started > 5 * 60 * 1000) {
        setError('Manifexus is taking longer than expected to come back. Reload this page in a minute.');
        setPhase('error');
        return;
      }
      pollTimer.current = setTimeout(tick, 1500);
    };
    pollTimer.current = setTimeout(tick, 1500);
  };

  /** Fallback when re-attaching mid-download: poll the server's progress snapshot. */
  const pollInstall = () => {
    // Stops (with a way out) if the server has no install to report, or its progress stops moving
    const started = Date.now();
    let lastChange = Date.now();
    let lastKey = '';
    const giveUp = (why: string) => {
      setError(why);
      setPhase('error');
    };
    const tick = async () => {
      try {
        const r = await fetch('/api/system/update', { cache: 'no-store' });
        const s: SoftwareUpdateState = await r.json();
        const p = s.installing;
        if (!p && Date.now() - started > 20000) {
          return giveUp('Manifexus isn’t installing an update anymore. Check for updates to see where things stand.');
        }
        if (p) {
          const key = `${p.stage}:${p.percent ?? ''}:${p.bytesDone ?? ''}:${p.message ?? ''}`;
          if (key !== lastKey) {
            lastKey = key;
            lastChange = Date.now();
          } else if (Date.now() - lastChange > 2 * 60 * 1000 && p.stage !== 'prepare') {
            return giveUp('The update stopped making progress. Reload this page to see where it is, or try again.');
          }
          if (p.stage === 'done') {
            setPhase('idle');
            checkNow();
            return;
          }
          setProgress(p);
          if (p.stage === 'restart') {
            target.current = { from: p.fromImageId, to: p.toImageId };
            followRestart();
            return;
          }
          if (p.stage === 'error') {
            setError(p.message);
            setPhase('error');
            return;
          }
          setPhase(p.stage as Phase);
        }
      } catch {
        // keep trying
      }
      pollTimer.current = setTimeout(tick, 1000);
    };
    tick();
  };

  const install = async () => {
    target.current = { startedAt: Date.now() };
    setError(null);
    setPhase('download');
    setProgress({ stage: 'download', percent: 0, message: 'Downloading update…' });
    try {
      const res = await fetch('/api/system/update/install', { method: 'POST' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { error?: string }).error || 'The update couldn’t start. Try again in a moment.');
        setPhase('error');
        return;
      }
      if (!res.body) throw new Error('No progress stream');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let last: UpdateProgress | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.replace(/^data:\s*/, '');
          try {
            const p: UpdateProgress = JSON.parse(line);
            last = p;
            setProgress(p);
            if (p.fromImageId) target.current.from = p.fromImageId;
            if (p.toImageId) target.current.to = p.toImageId;
            if (p.stage === 'download' || p.stage === 'prepare') setPhase(p.stage);
          } catch {
            // partial
          }
        }
      }
      if (last?.stage === 'error') {
        setError(last.message);
        setPhase('error');
      } else if (last?.stage === 'done') {
        setPhase('idle');
        checkNow();
      } else if (last?.stage === 'restart') {
        followRestart();
      } else {
        // Stream dropped before the restart step: follow the server's own progress
        pollInstall();
      }
    } catch {
      // The stream can drop as Manifexus restarts
      if (target.current.to) followRestart();
      else pollInstall();
    }
  };

  const s = state;
  // While the developer has chosen a version, ordinary updates wait: nothing is offered
  const available = s?.status === 'available' && s.latest && !s.pinned;
  const pinnedHere = !!s?.pinned && s.current.version === s.pinned.version;
  const recentOutcome =
    s?.lastOutcome && Date.now() - new Date(s.lastOutcome.finishedAt).getTime() < 3 * 24 * 3600 * 1000 ? s.lastOutcome : undefined;

  // ---------------------------------------------------------------------------
  // Installing view
  // ---------------------------------------------------------------------------
  const steps: { key: Phase; title: string; detail?: string }[] = [
    {
      key: 'download',
      title: 'Download update',
      detail:
        // While downloading: only what really needs downloading (parts already on the server are skipped),
        // with a total that never changes; before that, the most it can be
        phase === 'download'
          ? progress?.bytesTotal
            ? `${formatBytes(progress.bytesDone)} of ${formatBytes(progress.bytesTotal)}`
            : 'Checking what’s needed…'
          : phase === 'idle' && s?.latest
            ? downloadText(s.latest) || undefined
            : undefined,
    },
    { key: 'prepare', title: 'Prepare installation' },
    { key: 'restart', title: 'Restart Manifexus', detail: 'Your apps keep running' },
    { key: 'starting', title: 'Start new version', detail: available ? s!.latest!.label : undefined },
  ];
  const order: Phase[] = ['download', 'prepare', 'restart', 'starting', 'done'];
  const idx = order.indexOf(phase);
  const failedAt = phase === 'error' || phase === 'rolled_back' ? Math.max(0, order.indexOf((progress?.stage as Phase) || 'download')) : -1;
  const stepState = (i: number): 'pending' | 'active' | 'done' | 'failed' => {
    if (failedAt >= 0) return i < failedAt ? 'done' : i === failedAt ? 'failed' : 'pending';
    if (phase === 'done') return 'done';
    return i < idx ? 'done' : i === idx ? 'active' : 'pending';
  };
  const pct = phase === 'download' ? progress?.percent : undefined;

  const installingView = (
    <div className="space-y-7">
      <div className="flex flex-col items-center text-center pt-2">
        <ManifexusAppIcon size={72} />
        <h3 className="mt-4 text-[20px] font-semibold text-white">
          {phase === 'done'
            ? 'Update Complete'
            : phase === 'rolled_back'
              ? 'Update Didn’t Finish'
              : phase === 'error'
                ? 'Update Failed'
                : 'Updating Manifexus'}
        </h3>
        <p className="mt-1 text-[13px]" style={{ color: phase === 'rolled_back' || phase === 'error' ? ios.orange : ios.secondary }}>
          {phase === 'done'
            ? `Now running ${s?.current.label || 'the new version'}. Reloading…`
            : error || (phase === 'restart' || phase === 'starting' ? 'This page reconnects automatically.' : 'You can keep using your apps while this runs.')}
        </p>
      </div>

      {(phase === 'download' || phase === 'prepare') && (
        <div>
          <div className="h-[6px] rounded-full overflow-hidden" style={{ background: 'rgba(118,118,128,0.24)' }}>
            <div
              className={`h-full rounded-full transition-[width] duration-300 ${pct === undefined ? 'w-1/3 animate-pulse' : ''}`}
              style={{ background: ios.blue, width: pct === undefined ? undefined : `${phase === 'prepare' ? 100 : pct}%` }}
            />
          </div>
          <div className="mt-1.5 flex justify-between text-[12px] tabular-nums" style={{ color: ios.secondary }}>
            <span>{phase === 'prepare' ? 'Downloaded' : pct !== undefined ? `${pct}%` : 'Starting download…'}</span>
            <span>{steps[0].detail}</span>
          </div>
        </div>
      )}

      <Group className="ios-inset-icon">
        {steps.map((st, i) => (
          <Row
            key={st.key}
            leading={<span className="w-[29px] flex justify-center"><StepIcon state={stepState(i)} /></span>}
            title={st.title}
            titleColor={stepState(i) === 'pending' ? ios.secondary : ios.label}
            trailing={st.detail ? <span className="text-[13px]">{st.detail}</span> : undefined}
          />
        ))}
      </Group>

      {(phase === 'error' || phase === 'rolled_back') && (
        <div className="flex justify-center gap-3">
          <Button tone="gray" onClick={() => { setPhase('idle'); setError(null); }}>Close</Button>
          {phase === 'error' && <Button onClick={install}>Try Again</Button>}
        </div>
      )}
    </div>
  );

  // ---------------------------------------------------------------------------
  // Normal view
  // ---------------------------------------------------------------------------
  const normalView = s && (
    <div className="space-y-7">
      <div className="flex flex-col items-center text-center pt-2">
        <ManifexusAppIcon size={72} />
        <h3 className="mt-4 text-[20px] font-semibold text-white">
          {!s.supported
            ? 'Updates Unavailable Here'
            : s.pinned
              ? pinnedHere
                ? 'Updates Paused'
                : `Installing ${s.pinned.version} Soon`
            : checking || s.checking
              ? 'Checking for Updates…'
              : available
                ? 'Update Available'
                : s.status === 'unknown'
                  ? s.checkError
                    ? 'Can’t Check for Updates'
                    : 'Not Checked Yet'
                  : 'Manifexus Is Up to Date'}
        </h3>
        <p className="mt-1 text-[13px]" style={{ color: ios.secondary }}>
          {available ? 'Installed: ' : ''}
          {s.current.label}
          {s.current.created ? ` · ${formatDate(s.current.created)}` : ''}
        </p>
        {s.supported && (
          <p className="mt-2 text-[13px] flex items-center gap-2" style={{ color: ios.secondary }}>
            {checking || s.checking ? <Spinner size={13} /> : null}
            <span>Last checked {timeAgo(s.lastCheckedAt)}</span>
            {!(checking || s.checking) && <LinkButton onClick={checkNow}>Check Now</LinkButton>}
          </p>
        )}
      </div>

      {!s.supported && (
        <section>
          <Group>
            <Row title="Why" subtitle={s.unsupportedReason} />
          </Group>
        </section>
      )}

      {s.pinned && s.supported && (
        <section>
          <Group>
            <Row
              title={pinnedHere ? `Staying on ${s.pinned.version} for now` : `Manifexus ${s.pinned.version} installs on its own`}
              subtitle={s.pinned.message || 'Manifexus’s developer chose this version for every server, usually while a problem is being fixed.'}
            />
          </Group>
          <SectionFooter>
            {pinnedHere
              ? 'Updates resume on their own once the developer is ready. Your apps aren’t affected.'
              : 'It starts within a few minutes, after anything running (a move or a restore) finishes. Manifexus restarts for a few seconds; your apps keep running.'}
          </SectionFooter>
        </section>
      )}

      {s.checkError && s.supported && !available && !s.pinned && (
        <p className="px-4 text-[13px] text-center" style={{ color: ios.orange }}>{s.checkError}</p>
      )}

      {recentOutcome && !available && (
        <section>
          <Group className="ios-inset-icon">
            <Row
              leading={<span className="w-[29px] flex justify-center"><StepIcon state={recentOutcome.status === 'success' ? 'done' : 'failed'} /></span>}
              title={recentOutcome.status === 'success' ? `Updated to ${recentOutcome.to}` : 'Last update was rolled back'}
              subtitle={recentOutcome.status === 'success' ? `From ${recentOutcome.from} · ${timeAgo(recentOutcome.finishedAt)}` : recentOutcome.message}
            />
          </Group>
        </section>
      )}

      {available && s.latest!.releases && s.latest!.releases.length > 0 && (
        <>
          {s.latest!.releases.map((r, i) => (
            <ReleaseCard key={r.version} r={r} title={i === 0 ? `What’s New in ${r.version} · ${formatDate(`${r.date}T12:00:00`)}` : `Also New Since Yours: ${r.version}`} />
          ))}
          <SectionFooter>
            {[
              downloadText(s.latest!) ? `${downloadText(s.latest!)}.` : '',
              'Manifexus restarts for a few seconds; your apps keep running. If the new version doesn’t start, the current one is restored automatically.',
            ]
              .filter(Boolean)
              .join(' ')}
          </SectionFooter>
        </>
      )}

      {available && !(s.latest!.releases && s.latest!.releases.length > 0) && (
        <section>
          <SectionHeader>
            {s.latest!.label}
            {s.latest!.created ? ` · ${formatDate(s.latest!.created)}` : ''}
          </SectionHeader>
          <Group>
            {s.latest!.notes.length > 0 ? (
              s.latest!.notes.map((n) => <Row key={n.sha} title={<span className="whitespace-normal">{n.title}</span>} />)
            ) : (
              <Row title="Improvements and fixes" />
            )}
          </Group>
          <SectionFooter>
            {[
              s.latest!.totalCommits && s.latest!.totalCommits > s.latest!.notes.length ? `${s.latest!.totalCommits} changes in total.` : '',
              downloadText(s.latest!) ? `${downloadText(s.latest!)}.` : '',
              'Manifexus restarts for a few seconds; your apps keep running. If the new version doesn’t start, the current one is restored automatically.',
            ]
              .filter(Boolean)
              .join(' ')}
          </SectionFooter>
        </section>
      )}

      {!available && s.currentRelease && <ReleaseCard r={s.currentRelease} title={`What’s New in ${s.currentRelease.version}`} />}

      {s.supported && (
        <section>
          <SectionHeader>Automatic Updates</SectionHeader>
          <Group>
            <Row
              title="Check for updates"
              trailing={<Switch checked={s.settings.autoCheck} onChange={(v) => saveSettings({ autoCheck: v })} label="Check for updates automatically" />}
            />
            <Row
              title="Install updates"
              trailing={<Switch checked={s.settings.autoInstall} onChange={(v) => saveSettings({ autoInstall: v })} label="Install updates automatically" />}
            />
          </Group>
          <SectionFooter>
            {s.settings.autoInstall
              ? 'Updates install overnight at 4:00 AM server time.'
              : s.settings.autoCheck
                ? 'Manifexus checks every 6 hours and shows a badge when an update is ready.'
                : 'Manifexus only checks when you tap Check Now.'}
          </SectionFooter>
        </section>
      )}
    </div>
  );

  const showInstalling = phase !== 'idle';

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Software Update"
      leftAction={backLabel && onBack && !busy ? <BackButton label={backLabel} onClick={onBack} /> : undefined}
      rightAction={
        busy ? <span className="text-[15px]" style={{ color: ios.secondary }}>Updating</span> : undefined
      }
      footer={
        !showInstalling && available && s?.supported ? (
          <div className="flex justify-end">
            <Button onClick={install} className="w-full sm:w-auto sm:min-w-[160px]">Update Now</Button>
          </div>
        ) : undefined
      }
    >
      {!s ? (
        <div className="flex justify-center py-16"><Spinner size={24} /></div>
      ) : showInstalling ? (
        installingView
      ) : (
        normalView
      )}
    </Sheet>
  );
};
