import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
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
  Switch,
  ios,
} from './ui/ios';
import { ProgressView, useRun } from './ProgressTracker';

// ----------------------------------------------------------------------------
// Types (mirror server/restoreService.ts)
// ----------------------------------------------------------------------------

type Kind = 'move' | 'delete' | 'install';
type State = 'available' | 'restored' | 'failed' | 'archived';

interface RestorePoint {
  id: string;
  kind: Kind;
  title: string;
  detail?: string;
  at: string;
  state: State;
  restoredAt?: string;
  stacks: string[];
  apps: string[];
  pinned: boolean;
  backup: {
    bytes: number;
    hasData: boolean;
    dataSkipped: boolean;
    expiresAt?: string;
    deletedAt?: string;
    folders: string[];
    volumes: string[];
  };
  newer: number;
  activityId?: string;
  restoreActivityId?: string;
}

interface Plan {
  point: RestorePoint;
  changes: { point: RestorePoint; actions: string[] }[];
  checks: { level: 'ok' | 'warn' | 'block'; message: string }[];
  canRestore: boolean;
  canRestoreFilesOnly: boolean;
}

interface BackupFile {
  group: string;
  path: string;
  bytes: number;
  archive: number;
}

type View =
  | { kind: 'list' }
  | { kind: 'archive' }
  | { kind: 'storage' }
  | { kind: 'detail'; id: string }
  | { kind: 'review'; id: string; filesOnly?: boolean }
  | { kind: 'progress'; id: string; count: number; filesOnly?: boolean }
  | { kind: 'browse'; id: string }
  | { kind: 'copy'; id: string };

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function fmtBytes(b: number): string {
  if (!b) return '0 KB';
  if (b < 1000 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1000 * 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
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

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const when = (iso: string) => {
  const d = dayLabel(iso);
  return `${d === 'Today' || d === 'Yesterday' ? d : fmtDate(iso)} at ${fmtTime(iso)}`;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

const openActivity = (id?: string) => id && window.dispatchEvent(new CustomEvent('manifexus:open-activity', { detail: { id } }));

// ----------------------------------------------------------------------------
// Glyphs
// ----------------------------------------------------------------------------

const Glyph: React.FC<{ d: string; size?: number; stroke?: number; color?: string }> = ({ d, size = 16, stroke = 2.2, color = '#fff' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const G = {
  move: 'M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5-3.5M7 16l3.5 3.5',
  trash: 'M4 7h16M10 11v6M14 11v6M5.5 7l1 12.5A1.5 1.5 0 0 0 8 21h8a1.5 1.5 0 0 0 1.5-1.5L18.5 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7',
  plus: 'M12 5v14M5 12h14',
  restore: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4v4.5H8M12 8v4.5l3 1.8',
  disk: 'M4 13.5 6.2 6A2 2 0 0 1 8.1 4.5h7.8A2 2 0 0 1 17.8 6l2.2 7.5M4 13.5V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18v-4.5M4 13.5h16M16.5 16.5h.01',
  pin: 'M9 4h6l-1 5 3 3v1.5H7V12l3-3-1-5ZM12 13.5V20',
  folder: 'M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z',
  folderOut: 'M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10ZM12 11v5m0 0-2-2m2 2 2-2',
  files: 'M8 3.5h6l4.5 4.5v11A1.5 1.5 0 0 1 17 20.5H8A1.5 1.5 0 0 1 6.5 19V5A1.5 1.5 0 0 1 8 3.5ZM14 3.5V8h4.5M9.5 12.5h5M9.5 15.5h5',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 19.5h14',
  doc: 'M8 3.5h6l4.5 4.5v11A1.5 1.5 0 0 1 17 20.5H8A1.5 1.5 0 0 1 6.5 19V5A1.5 1.5 0 0 1 8 3.5Z',
  pulse: 'M3 12h4l2.5-6 5 12 2.5-6H21',
  archive: 'M4 5.5h16v3.5H4zM5.5 9v9A1.5 1.5 0 0 0 7 19.5h10a1.5 1.5 0 0 0 1.5-1.5V9M10 12.5h4',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  bang: 'M12 7v6M12 17v.01',
};

const KIND: Record<Kind, { color: string; d: string }> = {
  move: { color: '#5E5CE6', d: G.move },
  delete: { color: '#FF453A', d: G.trash },
  install: { color: '#30D158', d: G.plus },
};

const KindTile: React.FC<{ p: RestorePoint; size?: number }> = ({ p, size = 32 }) => (
  <IconTile color={p.state === 'available' ? KIND[p.kind].color : '#48484A'} size={size}>
    <Glyph d={KIND[p.kind].d} size={size * 0.56} stroke={2.1} />
  </IconTile>
);

const ActionTile: React.FC<{ d: string; color: string }> = ({ d, color }) => (
  <IconTile color={color}>
    <Glyph d={d} size={17} stroke={2} />
  </IconTile>
);

/** A status capsule: "Ready to Restore", "Restored Sep 26", "Didn’t Finish", "Backup Removed" */
const StatusPill: React.FC<{ p: RestorePoint }> = ({ p }) => {
  const [text, color, bg] =
    p.state === 'available'
      ? ['Ready to Restore', '#6CB6FF', 'rgba(10,132,255,0.16)']
      : p.state === 'restored'
        ? [`Restored ${p.restoredAt ? when(p.restoredAt) : ''}`.trim(), ios.secondary, 'rgba(118,118,128,0.2)']
        : p.state === 'failed'
          ? ['Didn’t Finish · Nothing Changed', '#FFB340', 'rgba(255,159,10,0.14)']
          : ['Backup Removed', ios.secondary, 'rgba(118,118,128,0.2)'];
  return (
    <span className="inline-flex items-center h-[24px] px-2.5 rounded-full text-[12.5px] font-medium" style={{ color, background: bg }}>
      {text}
    </span>
  );
};

// ----------------------------------------------------------------------------
// List row: the whole row opens the details; Restore sits on the right
// ----------------------------------------------------------------------------

const PointRow: React.FC<{ p: RestorePoint; onOpen: () => void; onRestore: () => void }> = ({ p, onOpen, onRestore }) => {
  const dim = p.state !== 'available';
  const sub =
    p.state === 'restored'
      ? `Restored ${p.restoredAt ? when(p.restoredAt) : ''}`
      : p.state === 'failed'
        ? 'Didn’t finish · nothing changed'
        : p.state === 'archived'
          ? `Backup removed${p.backup.deletedAt ? ` ${fmtDate(p.backup.deletedAt)}` : ''}`
          : [p.detail, fmtTime(p.at)].filter(Boolean).join(' · ');
  return (
    <div className="ios-row relative">
      <button
        type="button"
        onClick={onOpen}
        className={`w-full flex items-center gap-3 pl-4 ${p.state === 'available' ? 'pr-[118px]' : 'pr-9'} min-h-[60px] text-left transition-colors hover:bg-white/[0.04] active:bg-white/[0.08] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0A84FF]`}
      >
        <KindTile p={p} />
        <span className="min-w-0 flex-1 py-[10px]">
          <span className="flex items-center gap-1.5 text-[15px] leading-[20px]" style={{ color: dim ? ios.secondary : ios.label }}>
            <span className="truncate">{p.title}</span>
            {p.pinned && (
              <span className="flex-shrink-0" title="Pinned: kept forever" aria-label="Pinned">
                <Glyph d={G.pin} size={13} stroke={2.2} color={ios.orange} />
              </span>
            )}
          </span>
          <span className="block text-[13px] leading-[18px] mt-0.5 truncate" style={{ color: dim ? ios.tertiary : ios.secondary }}>
            {sub}
            {p.state === 'available' && p.newer > 0 && <span style={{ color: ios.tertiary }}> · includes {plural(p.newer, 'newer change')}</span>}
          </span>
        </span>
      </button>
      {p.state === 'available' && (
        <button
          type="button"
          onClick={onRestore}
          aria-label={`Restore to before: ${p.title}`}
          className="absolute right-9 top-1/2 -translate-y-1/2 h-[30px] px-3.5 rounded-full text-[14px] font-semibold transition-colors hover:brightness-125 focus-visible:outline-2 focus-visible:outline-[#0A84FF]"
          style={{ color: '#6CB6FF', background: 'rgba(10,132,255,0.16)' }}
        >
          Restore
        </button>
      )}
      <svg width="8" height="13" viewBox="0 0 8 13" aria-hidden="true" className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none">
        <path d="M1.5 1.5 6.5 6.5 1.5 11.5" fill="none" stroke={ios.tertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
};

function byDay(points: RestorePoint[]): [string, RestorePoint[]][] {
  const m = new Map<string, RestorePoint[]>();
  for (const p of points) {
    const k = dayLabel(p.at);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(p);
  }
  return Array.from(m.entries());
}

// ----------------------------------------------------------------------------
// Detail
// ----------------------------------------------------------------------------

const Detail: React.FC<{
  p: RestorePoint;
  onRestore: (filesOnly?: boolean) => void;
  canFilesOnly: boolean;
  onBrowse: () => void;
  onCopy: () => void;
  onChanged: (p: RestorePoint) => void;
}> = ({ p, onRestore, canFilesOnly, onBrowse, onCopy, onChanged }) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const hasBackup = p.state !== 'archived' && !p.backup.deletedAt;
  const from = p.kind === 'move' ? p.stacks.filter((s) => s !== p.stacks[0]) : [];

  const pin = async (on: boolean) => {
    onChanged({ ...p, pinned: on });
    const r = await fetch(`/api/restore/${encodeURIComponent(p.id)}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: on }) });
    if (r.ok) onChanged(await r.json());
  };
  const removeBackup = async () => {
    setBusy(true);
    const r = await fetch(`/api/restore/${encodeURIComponent(p.id)}/delete-backup`, { method: 'POST' });
    setBusy(false);
    if (r.ok) onChanged(await r.json());
  };

  const contents = [
    'compose files',
    p.backup.folders.length ? plural(p.backup.folders.length, 'folder') : '',
    p.backup.volumes.length ? plural(p.backup.volumes.length, 'volume') : '',
  ].filter(Boolean);

  return (
    <div className="space-y-7">
      <div className="flex flex-col items-center text-center pt-1">
        <KindTile p={p} size={60} />
        <h3 className="mt-4 text-[21px] leading-[26px] font-semibold text-white px-4">{p.title}</h3>
        <p className="mt-1 text-[13px]" style={{ color: ios.secondary }}>
          {when(p.at)}
        </p>
        <div className="mt-3">
          <StatusPill p={p} />
        </div>
        {p.state === 'available' && (
          <div className="mt-5 flex flex-col items-center gap-1.5">
            <Button onClick={() => onRestore(false)} className="!h-[40px] !px-6 !text-[15px]">
              {p.newer ? `Restore ${p.newer + 1} Changes…` : 'Restore…'}
            </Button>
            {p.newer > 0 && (
              <p className="text-[12px] max-w-[380px]" style={{ color: ios.tertiary }}>
                {plural(p.newer, 'newer change')} to the same stack{p.stacks.length > 1 ? 's' : ''} will be restored first, so nothing conflicts.
              </p>
            )}
          </div>
        )}
      </div>

      <section>
        <SectionHeader>What Changed</SectionHeader>
        <Group>
          {p.kind === 'move' && (
            <>
              <Row title="Apps" trailing={<span>{p.apps.join(', ')}</span>} />
              {from.length > 0 && <Row title="From" trailing={<span>{from.join(', ')}</span>} />}
              <Row title="To" trailing={<span>{p.stacks[0]}</span>} />
            </>
          )}
          {p.kind === 'delete' && (
            <>
              <Row title="Stack" trailing={<span>{p.stacks[0]}</span>} />
              {p.detail && <Row title="Apps" trailing={<span>{p.detail}</span>} />}
              {p.backup.folders[0] && <Row title="Folder" trailing={<span className="font-mono text-[13px] truncate">{p.backup.folders[0]}</span>} />}
            </>
          )}
          {p.kind === 'install' && <Row title="Stack" trailing={<span>{p.stacks[0]}</span>} />}
        </Group>
      </section>

      {hasBackup && (
        <section>
          <SectionHeader>Backup</SectionHeader>
          <Group>
            <Row title="Size" trailing={<span className="tabular-nums">{fmtBytes(p.backup.bytes)}</span>} />
            <Row
              title="Contains"
              trailing={<span>{p.backup.dataSkipped ? 'compose files only' : contents.join(', ').replace(/^./, (c) => c.toUpperCase())}</span>}
            />
            <Row title="Kept Until" trailing={<span>{p.pinned ? 'Forever' : p.backup.expiresAt ? fmtDate(p.backup.expiresAt) : 'Forever'}</span>} />
            <Row title="Pin Backup" trailing={<Switch checked={p.pinned} onChange={pin} label="Pin backup" />} />
          </Group>
          <SectionFooter>
            {p.backup.dataSkipped
              ? 'The data backup was turned off for this change, so only compose files were saved. '
              : ''}
            Pinned backups are kept forever instead of being removed on schedule.
          </SectionFooter>
        </section>
      )}

      {hasBackup && (
        <section>
          <SectionHeader>Recover</SectionHeader>
          <Group className="ios-inset-icon">
            {canFilesOnly && (
              <Row
                onClick={() => onRestore(true)}
                leading={<ActionTile d={G.folder} color="#0A84FF" />}
                title="Restore Files Only"
                subtitle="Puts the folder back without starting anything"
                chevron
              />
            )}
            {p.backup.hasData && (
              <Row
                onClick={onCopy}
                leading={<ActionTile d={G.folderOut} color="#5E5CE6" />}
                title="Restore to Another Folder…"
                subtitle="A copy somewhere new; nothing current is touched"
                chevron
              />
            )}
            <Row onClick={onBrowse} leading={<ActionTile d={G.files} color="#64D2FF" />} title="Browse Backup" subtitle="See what’s inside and download single files" chevron />
            <Row
              onClick={() => download(`/api/restore/${encodeURIComponent(p.id)}/download`)}
              leading={<ActionTile d={G.download} color="#30D158" />}
              title="Download Backup"
              subtitle={`Everything as one .tar.gz (${fmtBytes(p.backup.bytes)})`}
            />
          </Group>
        </section>
      )}

      {(p.activityId || p.restoreActivityId) && (
        <section>
          <Group className="ios-inset-icon">
            {p.activityId && (
              <Row
                onClick={() => openActivity(p.activityId)}
                leading={<ActionTile d={G.pulse} color="#FF9F0A" />}
                title="View Full Record"
                subtitle="Every step, command and file, in Activity"
                chevron
              />
            )}
            {p.restoreActivityId && (
              <Row
                onClick={() => openActivity(p.restoreActivityId)}
                leading={<ActionTile d={G.restore} color="#8E8E93" />}
                title="View Restore Record"
                subtitle="What happened when it was restored"
                chevron
              />
            )}
          </Group>
        </section>
      )}

      {hasBackup && (
        <section>
          <Group>
            <Row onClick={() => setConfirmDelete(true)} disabled={busy} title={<span style={{ color: ios.red }}>{busy ? 'Deleting…' : 'Delete Backup'}</span>} />
          </Group>
          <SectionFooter>
            {p.kind === 'delete'
              ? `This backup is the only copy of ${p.stacks[0]}. Deleting it means ${p.stacks[0]} can’t be brought back.`
              : 'Removes only this saved copy. Your stacks and their data aren’t touched.'}
          </SectionFooter>
        </section>
      )}

      <Alert
        open={confirmDelete}
        title={p.kind === 'delete' ? `Delete the only copy of ${p.stacks[0]}?` : 'Delete this backup?'}
        message={
          p.kind === 'delete'
            ? `${p.stacks[0]}’s files and settings will be gone for good. This can’t be undone.`
            : 'Your stacks and their data stay as they are. You just won’t be able to restore to before this change.'
        }
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          removeBackup();
        }}
      />
    </div>
  );
};

// ----------------------------------------------------------------------------
// Review (what a restore will do, and anything that changed since)
// ----------------------------------------------------------------------------

const CheckRow: React.FC<{ level: 'ok' | 'warn' | 'block'; message: string }> = ({ level, message }) => {
  const color = level === 'ok' ? ios.green : level === 'warn' ? ios.orange : ios.red;
  return (
    <div className="ios-row relative flex items-start gap-3 px-4 py-[11px]">
      <span className="w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0 mt-[1px]" style={{ background: color }}>
        <Glyph d={level === 'ok' ? G.check : G.bang} size={13} stroke={3} />
      </span>
      <span className="text-[15px] leading-[20px] break-words" style={{ color: ios.label }}>
        {message}
      </span>
    </div>
  );
};

const Review: React.FC<{ plan: Plan | null; error?: string; filesOnly?: boolean }> = ({ plan, error, filesOnly }) => {
  if (error) return <p className="text-[15px] text-center py-16" style={{ color: ios.orange }}>{error}</p>;
  if (!plan) return <p className="text-[15px] text-center py-16" style={{ color: ios.secondary }}>Checking what changed since…</p>;
  const many = plan.changes.length > 1;
  return (
    <div className="space-y-7">
      <div className="flex flex-col items-center text-center pt-1">
        <IconTile color={ios.blue} size={60}>
          <Glyph d={G.restore} size={32} stroke={2} />
        </IconTile>
        <h3 className="mt-4 text-[21px] leading-[26px] font-semibold text-white px-4">
          {filesOnly ? `Restore ${plan.point.stacks[0]}’s Files` : 'Restore to Before'}
        </h3>
        <p className="mt-1 text-[14px] max-w-[460px] px-4" style={{ color: ios.secondary }}>
          {plan.point.title} · {when(plan.point.at)}
        </p>
      </div>

      <section>
        <SectionHeader>Check</SectionHeader>
        <Group>
          {plan.checks.map((c, i) => (
            <CheckRow key={i} {...c} />
          ))}
        </Group>
      </section>

      {plan.canRestore && (
        <section>
          <SectionHeader>{many ? `Restores ${plan.changes.length} changes, newest first` : 'What Will Happen'}</SectionHeader>
          {many ? (
            <Group>
              {plan.changes.map((c, i) => (
                <div key={c.point.id} className="ios-row relative flex items-start gap-3 px-4 py-[11px]">
                  <span
                    className="w-[24px] h-[24px] rounded-full flex items-center justify-center flex-shrink-0 text-[12px] font-semibold tabular-nums"
                    style={{ background: 'rgba(10,132,255,0.18)', color: '#6CB6FF' }}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[15px] leading-[20px] text-white">{c.point.title}</span>
                    <span className="block text-[13px] leading-[18px] mt-0.5" style={{ color: ios.secondary }}>
                      {when(c.point.at)} · {c.actions.join(' · ')}
                    </span>
                  </span>
                </div>
              ))}
            </Group>
          ) : (
            <Group>
              {(filesOnly ? plan.changes[0].actions.filter((a) => !a.startsWith('Start ')) : plan.changes[0].actions).map((a) => (
                <Row key={a} title={<span className="whitespace-normal">{a}</span>} />
              ))}
              {filesOnly && <Row title={<span style={{ color: ios.secondary }}>Leave it stopped, ready to start from the dashboard</span>} />}
            </Group>
          )}
          <SectionFooter>
            {plan.point.kind === 'move' && !filesOnly
              ? 'Your apps’ data stays where it is. Moves never delete data.'
              : 'If a step fails, Manifexus stops and tells you exactly what happened.'}
          </SectionFooter>
        </section>
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Browse a backup
// ----------------------------------------------------------------------------

const Browse: React.FC<{ id: string }> = ({ id }) => {
  const [files, setFiles] = useState<BackupFile[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string>();
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(200);

  useEffect(() => {
    fetch(`/api/restore/${encodeURIComponent(id)}/files`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setFiles(j.files);
        setTruncated(j.truncated);
      })
      .catch((e) => setError(e.message));
  }, [id]);

  const groups = useMemo(() => {
    const m = new Map<string, BackupFile[]>();
    const s = q.trim().toLowerCase();
    let n = 0;
    for (const f of files || []) {
      if (s && !`${f.group}/${f.path}`.toLowerCase().includes(s)) continue;
      if (n++ >= shown) break;
      if (!m.has(f.group)) m.set(f.group, []);
      m.get(f.group)!.push(f);
    }
    return Array.from(m.entries());
  }, [files, q, shown]);

  if (error) return <p className="text-[15px] text-center py-16" style={{ color: ios.orange }}>{error}</p>;
  if (!files) return <p className="text-[15px] text-center py-16" style={{ color: ios.secondary }}>Opening the backup…</p>;

  return (
    <div className="space-y-6">
      <SearchField value={q} onChange={setQ} label="Search files" placeholder={`Search ${plural(files.length, 'file')}`} />
      {groups.map(([g, list]) => (
        <section key={g}>
          <SectionHeader>{g}</SectionHeader>
          <Group>
            {list.map((f) => (
              <Row
                key={`${f.archive}:${f.path}`}
                onClick={() =>
                  download(`/api/restore/${encodeURIComponent(id)}/file?archive=${f.archive}&path=${encodeURIComponent(f.path)}`)
                }
                title={<span className="font-mono text-[13px]">{f.path}</span>}
                trailing={<span className="text-[13px] tabular-nums">{fmtBytes(f.bytes)}</span>}
              />
            ))}
          </Group>
        </section>
      ))}
      {groups.length === 0 && <p className="text-[15px] text-center py-10" style={{ color: ios.secondary }}>No files match.</p>}
      <SectionFooter>
        Tap a file to download it.{' '}
        {files.length > shown && !q && <LinkButton onClick={() => setShown((n) => n + 500)}>Show more</LinkButton>}
        {truncated && ' Only the first 5,000 files are listed; download the backup to see everything.'}
      </SectionFooter>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Restore to another folder
// ----------------------------------------------------------------------------

const CopyElsewhere: React.FC<{ p: RestorePoint; onDone: (targets: string[]) => void; submitRef: React.MutableRefObject<(() => void) | null>; onBusy: (b: boolean) => void }> = ({
  p,
  onDone,
  submitRef,
  onBusy,
}) => {
  const base = p.backup.folders[0] || `/home/${p.stacks[0]}`;
  const [dest, setDest] = useState(`${base.replace(/\/+$/, '')}-restored`);
  const [error, setError] = useState<string>();
  const valid = dest.trim().startsWith('/') && dest.trim().split('/').filter(Boolean).length >= 2;

  submitRef.current = async () => {
    if (!valid) return;
    setError(undefined);
    onBusy(true);
    try {
      const r = await fetch(`/api/restore/${encodeURIComponent(p.id)}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination: dest.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      onDone(j.targets);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      onBusy(false);
    }
  };

  const parts = p.backup.folders.length + p.backup.volumes.length;
  return (
    <div className="space-y-6">
      <p className="text-[15px] leading-[21px] px-1" style={{ color: ios.secondary }}>
        Copies what the backup saved into a new folder on your server. Your current stacks, their folders and anything running stay exactly as they are.
      </p>
      <section>
        <Group>
          <FieldRow id="restore-dest" label="Folder" value={dest} onChange={setDest} mono invalid={!valid} autoFocus />
        </Group>
        <SectionFooter tone={error ? 'danger' : 'default'}>
          {error ||
            (parts > 1
              ? `The backup has ${parts} parts; each goes into its own folder inside this one.`
              : 'Use a new or empty folder.')}
        </SectionFooter>
      </section>
      <section>
        <SectionHeader>What’s Copied</SectionHeader>
        <Group>
          {p.backup.folders.map((f) => (
            <Row key={f} title={<span className="font-mono text-[13px]">{f}</span>} trailing={<span>Folder</span>} />
          ))}
          {p.backup.volumes.map((v) => (
            <Row key={v} title={<span className="font-mono text-[13px]">{v}</span>} trailing={<span>Volume</span>} />
          ))}
        </Group>
      </section>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Sheet
// ----------------------------------------------------------------------------

const KEEP_OPTIONS = [
  { value: 7, label: '7 Days' },
  { value: 30, label: '30 Days' },
  { value: 90, label: '90 Days' },
  { value: 365, label: '1 Year' },
  { value: 0, label: 'Forever' },
];

export const RestoreSheet: React.FC<{ open: boolean; onClose: () => void; onChanged?: () => void }> = ({ open, onClose, onChanged }) => {
  const [points, setPoints] = useState<RestorePoint[] | null>(null);
  const [storage, setStorage] = useState<{ bytes: number; keepDays: number; count: number }>({ bytes: 0, keepDays: 30, count: 0 });
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<'all' | 'pinned'>('all');
  const [showAll, setShowAll] = useState(false);
  const [stack, setStack] = useState<View[]>([{ kind: 'list' }]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planError, setPlanError] = useState<string>();
  const [confirmWarn, setConfirmWarn] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copied, setCopied] = useState<string[] | null>(null);
  const copySubmit = useRef<(() => void) | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const run = useRun();

  const view = stack[stack.length - 1];
  const push = (v: View) => {
    setStack((s) => [...s, v]);
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: 0 }));
  };
  const pop = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/restore', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setPoints(j.points);
      setStorage(j.storage);
      setError(undefined);
    } catch (e) {
      setError((e as Error).message || 'Couldn’t load Restore.');
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setStack([{ kind: 'list' }]);
    setFilter('all');
    setShowAll(false);
    run.reset();
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Review: fetch the plan each time it opens
  useEffect(() => {
    if (view.kind !== 'review') return;
    setPlan(null);
    setPlanError(undefined);
    fetch(`/api/restore/${encodeURIComponent(view.id)}/plan`, { cache: 'no-store' })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setPlan(j);
      })
      .catch((e) => setPlanError(e.message));
  }, [view]);

  const byId = useMemo(() => new Map((points || []).map((p) => [p.id, p])), [points]);
  const updatePoint = (p: RestorePoint) => setPoints((list) => (list ? list.map((x) => (x.id === p.id ? p : x)) : list));

  const live = (points || []).filter((p) => p.state !== 'archived');
  const archived = (points || []).filter((p) => p.state === 'archived');
  const visible = filter === 'pinned' ? live.filter((p) => p.pinned) : live;
  const limited = showAll ? visible : visible.slice(0, 30);

  const startRestore = (id: string, filesOnly?: boolean) => {
    push({ kind: 'progress', id, count: plan?.point.id === id ? plan.changes.length : 1, filesOnly });
    void run.start(`/api/restore/${encodeURIComponent(id)}/run`, { filesOnly: Boolean(filesOnly) });
  };

  // ---------------------------------------------------------------- title & navigation
  const titles: Record<View['kind'], string> = {
    list: 'Restore',
    archive: 'Archive',
    storage: 'Backups',
    detail: 'Details',
    review: 'Review',
    progress: run.state.status === 'done' ? 'Done' : 'Restoring',
    browse: 'Browse Backup',
    copy: 'Restore to Folder',
  };
  const backLabel = (() => {
    const prev = stack[stack.length - 2];
    if (!prev) return '';
    return prev.kind === 'list' ? 'Restore' : prev.kind === 'archive' ? 'Archive' : prev.kind === 'detail' ? 'Details' : 'Back';
  })();

  const leftAction =
    view.kind === 'progress' ? undefined : stack.length > 1 ? <BackButton label={backLabel} onClick={pop} /> : undefined;

  // ---------------------------------------------------------------- footer
  let footer: React.ReactNode;
  if (view.kind === 'review' && plan?.canRestore) {
    const warn = plan.checks.some((c) => c.level === 'warn');
    const label = view.filesOnly ? 'Restore Files' : plan.changes.length > 1 ? `Restore ${plan.changes.length} Changes` : 'Restore';
    footer = (
      <div className="flex justify-end gap-2">
        <Button tone="gray" onClick={pop} className="sm:min-w-[110px]">
          Cancel
        </Button>
        <Button onClick={() => (warn ? setConfirmWarn(true) : startRestore(view.id, view.filesOnly))} className="flex-1 sm:flex-none sm:min-w-[170px]">
          {label}
        </Button>
      </div>
    );
  } else if (view.kind === 'copy' && !copied) {
    footer = (
      <div className="flex justify-end">
        <Button onClick={() => copySubmit.current?.()} disabled={copyBusy} className="w-full sm:w-auto sm:min-w-[170px]">
          {copyBusy ? 'Copying…' : 'Restore Here'}
        </Button>
      </div>
    );
  } else if (view.kind === 'archive' && archived.length > 0) {
    footer = (
      <div className="flex justify-center">
        <LinkButton tone="red" onClick={() => setConfirmClear(true)}>
          Delete All Archived Changes
        </LinkButton>
      </div>
    );
  }

  // ---------------------------------------------------------------- body
  let body: React.ReactNode;
  if (view.kind === 'list') {
    body = error ? (
      <p className="text-[15px] text-center py-16" style={{ color: ios.orange }}>{error}</p>
    ) : !points ? (
      <p className="text-[15px] text-center py-16" style={{ color: ios.secondary }}>Loading…</p>
    ) : (
      <div className="space-y-7">
        <Group className="ios-inset-icon">
          <Row
            onClick={() => push({ kind: 'storage' })}
            leading={<ActionTile d={G.disk} color="#8E8E93" />}
            title={`Backups use ${fmtBytes(storage.bytes)}`}
            subtitle={storage.keepDays ? `Kept for ${plural(storage.keepDays, 'day')} · pinned ones are kept forever` : 'Kept forever'}
            chevron
          />
        </Group>

        {visible.length === 0 ? (
          <div className="text-center py-10 px-6">
            <p className="text-[17px] font-semibold text-white">{filter === 'pinned' ? 'No Pinned Backups' : 'Nothing to Restore Yet'}</p>
            <p className="mt-1.5 text-[14px] leading-[20px] max-w-[400px] mx-auto" style={{ color: ios.secondary }}>
              {filter === 'pinned'
                ? 'Pin a backup from its details to keep it forever. It stays in the list and shows up here.'
                : 'When you move apps or delete a stack, Manifexus saves a backup first. It shows up here, so you can restore to before it.'}
            </p>
          </div>
        ) : (
          byDay(limited).map(([day, list]) => (
            <section key={day}>
              <SectionHeader>{day}</SectionHeader>
              <Group>
                {list.map((p) => (
                  <PointRow key={p.id} p={p} onOpen={() => push({ kind: 'detail', id: p.id })} onRestore={() => push({ kind: 'review', id: p.id })} />
                ))}
              </Group>
            </section>
          ))
        )}
        {!showAll && visible.length > limited.length && (
          <div className="flex justify-center">
            <Button tone="gray" onClick={() => setShowAll(true)}>
              Show Earlier
            </Button>
          </div>
        )}

        {filter === 'all' && archived.length > 0 && (
          <Group className="ios-inset-icon">
            <Row
              onClick={() => push({ kind: 'archive' })}
              leading={<ActionTile d={G.archive} color="#636366" />}
              title="Archive"
              subtitle={`${plural(archived.length, 'older change')} whose backups were removed`}
              trailing={<span className="tabular-nums">{archived.length}</span>}
              chevron
            />
          </Group>
        )}
      </div>
    );
  } else if (view.kind === 'archive') {
    body =
      archived.length === 0 ? (
        <p className="text-[15px] text-center py-16" style={{ color: ios.secondary }}>The archive is empty.</p>
      ) : (
        <div className="space-y-7">
          <p className="text-[14px] leading-[20px] px-1" style={{ color: ios.secondary }}>
            A record of older changes. Their backups were removed, so they can’t be restored.
          </p>
          {byDay(archived).map(([day, list]) => (
            <section key={day}>
              <SectionHeader>{day}</SectionHeader>
              <Group>
                {list.map((p) => (
                  <PointRow key={p.id} p={p} onOpen={() => push({ kind: 'detail', id: p.id })} onRestore={() => {}} />
                ))}
              </Group>
            </section>
          ))}
        </div>
      );
  } else if (view.kind === 'storage') {
    body = (
      <div className="space-y-7">
        <section>
          <Group>
            <Row title="Space Used" trailing={<span className="tabular-nums">{fmtBytes(storage.bytes)}</span>} />
            <Row title="Backups" trailing={<span className="tabular-nums">{storage.count}</span>} />
            <Row title="Pinned" trailing={<span className="tabular-nums">{live.filter((p) => p.pinned).length}</span>} />
          </Group>
        </section>
        <section>
          <SectionHeader>Keep Backups For</SectionHeader>
          <Group>
            {KEEP_OPTIONS.map((o) => (
              <Row
                key={o.value}
                role="radio"
                ariaChecked={storage.keepDays === o.value}
                onClick={async () => {
                  setStorage((s) => ({ ...s, keepDays: o.value }));
                  await fetch('/api/restore/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keepDays: o.value }) });
                  load();
                }}
                title={o.label}
                trailing={<span className="w-[15px] flex justify-center">{storage.keepDays === o.value && <Checkmark />}</span>}
              />
            ))}
          </Group>
          <SectionFooter>
            Older backups are removed automatically and their changes move to the Archive. Pinned backups are always kept. A deleted stack’s backup is its
            only copy, so pin it if you might want it back later.
          </SectionFooter>
        </section>
      </div>
    );
  } else if (view.kind === 'detail') {
    const p = byId.get(view.id);
    body = p ? (
      <Detail
        p={p}
        canFilesOnly={p.kind === 'delete' && p.state === 'available' && p.newer === 0}
        onRestore={(filesOnly) => push({ kind: 'review', id: p.id, filesOnly })}
        onBrowse={() => push({ kind: 'browse', id: p.id })}
        onCopy={() => {
          setCopied(null);
          push({ kind: 'copy', id: p.id });
        }}
        onChanged={(np) => {
          updatePoint(np);
          if (np.backup.deletedAt) load();
        }}
      />
    ) : (
      <p className="text-[15px] text-center py-16" style={{ color: ios.secondary }}>This change is no longer here.</p>
    );
  } else if (view.kind === 'review') {
    body = <Review plan={plan} error={planError} filesOnly={view.filesOnly} />;
  } else if (view.kind === 'progress') {
    body = (
      <ProgressView
        run={run.state}
        runningTitle={view.filesOnly ? 'Restoring Files' : view.count > 1 ? `Restoring ${view.count} Changes` : 'Restoring'}
        doneMessage={
          view.filesOnly
            ? 'The files are back. Start the stack from the dashboard when you’re ready.'
            : 'Everything is back the way it was before this change.'
        }
        onDone={() => {
          onChanged?.();
          onClose();
        }}
        onClose={() => {
          onChanged?.();
          load();
          setStack([{ kind: 'list' }]);
        }}
      />
    );
  } else if (view.kind === 'browse') {
    body = <Browse id={view.id} />;
  } else if (view.kind === 'copy') {
    const p = byId.get(view.id);
    body = copied ? (
      <div className="space-y-7">
        <div className="flex flex-col items-center text-center pt-3">
          <IconTile color={ios.green} size={60}>
            <Glyph d={G.check} size={32} stroke={3} />
          </IconTile>
          <h3 className="mt-4 text-[22px] font-semibold text-white">Restored</h3>
          <p className="mt-1.5 text-[14px]" style={{ color: ios.secondary }}>
            The backup was copied to:
          </p>
        </div>
        <Group>
          {copied.map((t) => (
            <Row key={t} title={<span className="font-mono text-[13px]">{t}</span>} />
          ))}
        </Group>
      </div>
    ) : p ? (
      <CopyElsewhere p={p} submitRef={copySubmit} onBusy={setCopyBusy} onDone={(t) => setCopied(t)} />
    ) : null;
  }

  const toolbar =
    view.kind === 'list' && points && live.length > 0 ? (
      <Segmented
        label="Show"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'pinned', label: `Pinned${live.some((p) => p.pinned) ? ` (${live.filter((p) => p.pinned).length})` : ''}` },
        ]}
      />
    ) : undefined;

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (view.kind === 'progress' && run.state.status !== 'running') onChanged?.();
        onClose();
      }}
      title={titles[view.kind]}
      leftAction={leftAction}
      toolbar={toolbar}
      footer={footer}
      bodyRef={bodyRef}
    >
      <div key={stack.length} className={stack.length > 1 ? 'motion-safe:animate-[ios-push-in_200ms_ease-out]' : ''}>
        {body}
      </div>

      <Alert
        open={confirmWarn}
        title="Replace changes made since?"
        message="Something was edited after this change (see the check above). Restoring replaces it with the version from before."
        confirmLabel="Restore"
        destructive
        onCancel={() => setConfirmWarn(false)}
        onConfirm={() => {
          setConfirmWarn(false);
          if (view.kind === 'review') startRestore(view.id, view.filesOnly);
        }}
      />
      <Alert
        open={confirmClear}
        title="Delete all archived changes?"
        message="Only the list of older changes is removed. Their backups are already gone, and your stacks aren’t touched."
        confirmLabel="Delete All"
        destructive
        onCancel={() => setConfirmClear(false)}
        onConfirm={async () => {
          setConfirmClear(false);
          await fetch('/api/restore/archive/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          await load();
          pop();
        }}
      />
    </Sheet>
  );
};
