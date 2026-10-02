import React, { useEffect, useState } from 'react';
import { BackButton, Button, Group, IconTile, LinkButton, Row, SectionFooter, SectionHeader, Sheet, Switch, ios } from './ui/ios';
import { enter } from '../motion';
import { backupSummary, fmtBytes, toneColor, whenAgo, type BackupsState, type StackBackup } from './backupSummary';

/**
 * Backups: every stack is backed up automatically (when it first appears, then every night) into the backup
 * store, so the server can be brought back after a crash, and moves only save what changed. This screen shows
 * how protected each stack is, what's kept and what's left out, and the schedule. Going back to before a change
 * is Restore's job; the two link to each other.
 */


/** A shield with a check: protected */
const ShieldGlyph: React.FC<{ size?: number; check?: boolean }> = ({ size = 18, check = true }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3 5 6v5.5c0 4.3 2.9 7.9 7 9.5 4.1-1.6 7-5.2 7-9.5V6l-7-3Z" />
    {check && <path d="m9 12 2.2 2.2L15.5 10" />}
  </svg>
);

const KindIcon: React.FC<{ kind: 'folder' | 'volume' | 'database' }> = ({ kind }) => (
  <IconTile color={kind === 'database' ? ios.purple : kind === 'volume' ? '#5E5CE6' : ios.blue}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {kind === 'database' ? (
        <>
          <ellipse cx="12" cy="6" rx="7" ry="2.6" />
          <path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" />
        </>
      ) : kind === 'volume' ? (
        <>
          <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
          <path d="M7.5 15h.01M11 15h5" />
        </>
      ) : (
        <path d="M3.5 7.5a2 2 0 0 1 2-2H10l2 2h6.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
      )}
    </svg>
  </IconTile>
);

/** Status line under a stack's name */
function stackLine(s: BackupsState, st: StackBackup): { text: React.ReactNode; color?: string } {
  if (s.running?.project === st.project) return { text: <span className="mfx-shimmer">Backing up…</span> };
  if (s.queued.includes(st.project)) return { text: 'Waiting to back up' };
  if (st.problem) return { text: st.problem, color: ios.orange };
  if (st.lastOkAt) return { text: `Backed up ${whenAgo(st.lastOkAt)} · ${fmtBytes(st.bytes)}` };
  return { text: 'Not backed up yet' };
}

export const BackupsSheet: React.FC<{
  open: boolean;
  onClose: () => void;
  state: BackupsState | null;
  /** Ask for fresh status (after changing something) */
  onRefresh: () => void;
  stackLabel: (project: string) => string;
  stackIcon: (project: string, size: number) => React.ReactNode;
  onOpenRestore: () => void;
}> = ({ open, onClose, state, onRefresh, stackLabel, stackIcon, onOpenRestore }) => {
  const [detail, setDetail] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) setDetail(null);
    else onRefresh();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = async (url: string, body: unknown) => {
    setError(undefined);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'That didn’t go through. Try again.');
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const backUpNow = (projects?: string[]) => void post('/api/backups/run', { projects });
  const saveSettings = async (next: { enabled?: boolean; time?: string }) => {
    setSaving(true);
    await post('/api/backups/settings', next);
    setSaving(false);
  };

  const s = state;
  const summary = backupSummary(s);
  const busy = Boolean(s?.running) || Boolean(s?.queued.length);
  const st = detail ? s?.stacks.find((x) => x.project === detail) : undefined;

  let body: React.ReactNode;
  if (!s) {
    body = (
      <div className="py-20 flex flex-col items-center gap-3" style={{ color: ios.secondary }}>
        <span className="w-6 h-6 rounded-full border-2 border-white/15 border-t-white/70 animate-spin motion-reduce:animate-none" />
        <p className="text-[15px]">Checking your backups…</p>
      </div>
    );
  } else if (st) {
    const line = stackLine(s, st);
    body = (
      <div key={st.project} ref={enter('push')} className="space-y-7">
        <div className="flex flex-col items-center text-center pt-1">
          {stackIcon(st.project, 56)}
          <h3 className="mt-3 text-[22px] leading-[28px] font-semibold" style={{ color: ios.label }}>
            {stackLabel(st.project)}
          </h3>
          <p className="mt-1 text-[15px] leading-[20px]" style={{ color: line.color || ios.secondary }}>
            {line.text}
          </p>
        </div>
        {(st.items?.length || 0) > 0 && (
          <section>
            <SectionHeader>What’s Kept</SectionHeader>
            <Group className="ios-inset-icon">
              {st.items!.map((it) => (
                <Row
                  key={it.label}
                  leading={<KindIcon kind={it.kind} />}
                  title={it.kind === 'folder' && it.label.startsWith('/') ? <span style={{ fontFamily: ios.mono }}>{it.label}</span> : it.label}
                  subtitle={it.kind === 'database' ? 'A full copy that always restores cleanly' : it.kind === 'volume' ? 'Docker volume' : it.label.endsWith(' folder') ? 'Compose file, .env and everything else in it' : 'Settings and data'}
                  trailing={<span className="tabular-nums">{fmtBytes(it.bytes)}</span>}
                />
              ))}
            </Group>
            <SectionFooter>Everything the stack needs to come back after a crash. Video and music files are left out; settings, databases and .torrent files are kept.</SectionFooter>
          </section>
        )}
        {(st.skipped?.length || 0) > 0 && (
          <section>
            <SectionHeader>Left Out</SectionHeader>
            <Group>
              {st.skipped!.map((k) => (
                <Row
                  key={k.path}
                  title={<span style={{ fontFamily: ios.mono }}>{k.path}</span>}
                  subtitle={k.reason}
                  trailing={k.bytes ? <span className="tabular-nums">{fmtBytes(k.bytes)}</span> : undefined}
                />
              ))}
            </Group>
            <SectionFooter>These stay where they are and are never touched. Keep your own copy of media you can’t download again.</SectionFooter>
          </section>
        )}
        {!st.items?.length && !st.problem && (
          <p className="text-[15px] text-center px-6" style={{ color: ios.secondary }}>
            This stack hasn’t been backed up yet. It will be shortly, or tap Back Up Now.
          </p>
        )}
      </div>
    );
  } else {
    body = (
      <div className="space-y-7">
        {/* Summary */}
        <div className="flex flex-col items-center text-center pt-1">
          <span
            className="w-[64px] h-[64px] rounded-[18px] flex items-center justify-center text-white"
            style={{ background: `linear-gradient(160deg, ${toneColor[summary.tone]}, ${toneColor[summary.tone]}B3)`, boxShadow: `0 10px 26px -10px ${toneColor[summary.tone]}` }}
            aria-hidden
          >
            {summary.tone === 'busy' ? (
              <span className="w-7 h-7 rounded-full border-[3px] border-white/35 border-t-white animate-spin motion-reduce:animate-none" />
            ) : (
              <ShieldGlyph size={34} check={summary.tone === 'ok'} />
            )}
          </span>
          <h3 className="mt-4 text-[22px] leading-[28px] font-semibold" style={{ color: ios.label }}>
            {summary.title}
          </h3>
          <p className="mt-1 text-[15px] leading-[20px] max-w-[30rem]" style={{ color: ios.secondary }}>
            {summary.detail}
          </p>
          <p className="mt-2 text-[13px] leading-[18px] tabular-nums" style={{ color: ios.secondary }}>
            {fmtBytes(s.storeBytes)} used{s.freeBytes !== null ? ` · ${fmtBytes(s.freeBytes)} free` : ''}
          </p>
        </div>

        {/* Stacks */}
        <section>
          <SectionHeader>Stacks</SectionHeader>
          <Group className="ios-inset-icon">
            {s.stacks.map((x) => {
              const line = stackLine(s, x);
              return (
                <Row
                  key={x.project}
                  onClick={() => setDetail(x.project)}
                  chevron
                  leading={<span className="w-[29px] h-[29px] flex items-center justify-center overflow-hidden rounded-[7px]">{stackIcon(x.project, 29)}</span>}
                  title={stackLabel(x.project)}
                  subtitle={<span style={{ color: line.color }}>{line.text}</span>}
                />
              );
            })}
            {!s.stacks.length && <Row title="No stacks yet" subtitle="Stacks are backed up as soon as they appear." />}
          </Group>
        </section>

        {/* Schedule */}
        <section>
          <SectionHeader>Schedule</SectionHeader>
          <Group>
            <Row
              title="Automatic Backups"
              subtitle={s.enabled ? 'New stacks right away, every stack nightly' : 'Off'}
              trailing={<Switch checked={s.enabled} onChange={(v) => void saveSettings({ enabled: v })} label="Automatic Backups" disabled={saving} />}
            />
            {s.enabled && (
              <Row
                title="Every Night At"
                trailing={
                  <input
                    type="time"
                    value={s.time}
                    onChange={(e) => e.target.value && void saveSettings({ time: e.target.value })}
                    aria-label="Nightly backup time"
                    className="h-[32px] px-2.5 rounded-[8px] text-[15px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF] [color-scheme:dark]"
                    style={{ background: ios.fill, color: ios.label }}
                  />
                }
              />
            )}
          </Group>
          <SectionFooter>Backups run quietly in the background and never stop or slow down your apps. Each one only saves what changed.</SectionFooter>
        </section>

        {/* Storage */}
        <section>
          <SectionHeader>Storage</SectionHeader>
          <Group>
            <Row title="Kept On" trailing="This server" />
            <Row title="Space Used" trailing={<span className="tabular-nums">{fmtBytes(s.storeBytes)}</span>} />
            {s.freeBytes !== null && <Row title="Free Space" trailing={<span className="tabular-nums">{fmtBytes(s.freeBytes)}</span>} />}
          </Group>
          <SectionFooter>
            Encrypted, and shared between backups so the same file is never kept twice. To go back to before a move or delete, use{' '}
            <LinkButton onClick={onOpenRestore} className="!text-[13px]">
              Restore
            </LinkButton>
            .
          </SectionFooter>
        </section>
        {error && (
          <p className="text-[13px] text-center" style={{ color: ios.redText }} role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  const footer = s?.usable ? (
    <div className="flex justify-end">
      <Button
        onClick={() => backUpNow(st ? [st.project] : undefined)}
        disabled={st ? s.running?.project === st.project || s.queued.includes(st.project) : busy}
        className="flex-1 sm:flex-none sm:min-w-[170px]"
      >
        {(st ? s.running?.project === st.project : busy) ? 'Backing Up…' : st ? `Back Up ${stackLabel(st.project)}` : 'Back Up Now'}
      </Button>
    </div>
  ) : null;

  return (
    <Sheet
      open={open}
      title={st ? 'Stack Backup' : 'Backups'}
      onClose={onClose}
      leftAction={st ? <BackButton label="Backups" onClick={() => setDetail(null)} /> : undefined}
      footer={footer}
    >
      {body}
    </Sheet>
  );
};
