import React, { useEffect, useState } from 'react';
import { Alert, AppTile, Button, Group, IconTile, LinkButton, Row, SectionFooter, SectionHeader, Switch, ios } from './ui/ios';

export interface DeleteAppTarget {
  /** The app and its own database or cache */
  ids: string[];
  name: string;
  /** The app's own icon, as the dashboard shows it */
  icon?: React.ReactNode;
  /** The stack it's in (none for a standalone app) */
  stack?: string;
  /** Its database or cache, by name, deleted with it */
  helpers?: string[];
}

interface Plan {
  /** The main app's name on the server; data of its database or cache is labelled as theirs */
  label: string;
  own: { kind: 'volume' | 'directory'; source: string; bytes: number; app?: string }[];
  shared: string[];
  totalBytes: number;
  freeBytes: number | null;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

const TrashGlyph: React.FC = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </svg>
);

const ShieldGlyph: React.FC<{ off?: boolean }> = ({ off }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
    {off ? <path d="m4 4 16 16" /> : <path d="m9 12 2 2 4-4" />}
  </svg>
);

/** "config" for /home/ryan/stacks/music/config: the part people recognise */
const shortPath = (p: string) => p.split('/').filter(Boolean).slice(-2).join('/');

/**
 * Delete one app, the same way as deleting a stack: what goes away, a backup that's on unless you
 * turn it off (and confirm), and one clear button. The rest of its stack keeps running.
 */
export const DeleteAppDialog: React.FC<{
  target: DeleteAppTarget | null;
  onCancel: () => void;
  onDeleted: (message: string) => void;
}> = ({ target, onCancel, onDeleted }) => {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [measured, setMeasured] = useState(false);
  const [backup, setBackup] = useState(true);
  const [confirmOff, setConfirmOff] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setBackup(true);
    setConfirmOff(false);
    setError(null);
    setPlan(null);
    setMeasured(false);
    let cancelled = false;
    fetch('/api/apps/delete-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: target.ids }) })
      .then(async (r) => {
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) setError(d.error || null);
        else setPlan(d);
      })
      .catch(() => {})
      .finally(() => !cancelled && setMeasured(true));
    return () => {
      cancelled = true;
    };
  }, [target]);

  useEffect(() => {
    if (!target || confirmOff) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, deleting, confirmOff, onCancel]);

  if (!target) return null;

  const helpers = target.helpers || [];
  const own = plan?.own || [];
  const notEnoughSpace = backup && plan && plan.freeBytes !== null && plan.totalBytes > plan.freeBytes;

  const runDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch('/api/apps/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: target.ids, label: target.name, skipDataBackup: !backup }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `${target.name} couldn’t be deleted.`);
      onDeleted(data.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const withHelpers = helpers.length ? ` with its ${helpers.length === 1 ? helpers[0] : `${helpers.length} helpers`}` : '';
  const message = target.stack
    ? `${target.name}${withHelpers} is stopped and taken out of ${target.stack}. The other apps in ${target.stack} keep running.`
    : `${target.name}${withHelpers} is stopped and removed from this server.`;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center sm:p-6 bg-black/55"
      style={{ fontFamily: ios.font }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !deleting && !confirmOff) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-app-title"
        aria-describedby="delete-app-desc"
        className="w-full sm:max-w-[420px] max-h-[92vh] flex flex-col rounded-t-[14px] sm:rounded-[14px] overflow-hidden motion-safe:animate-[ios-sheet-in_220ms_ease-out]"
        style={{ background: ios.sheet, boxShadow: '0 30px 80px rgba(0,0,0,0.55)', WebkitFontSmoothing: 'antialiased' }}
      >
        <div className="overflow-y-auto px-4 sm:px-5 pt-7 pb-5">
          <div className="flex flex-col items-center text-center px-2">
            <div className="relative">
              {target.icon || <AppTile name={target.name} size={56} />}
              <span className="absolute -right-2 -bottom-2">
                <IconTile color={ios.red} size={26}>
                  <span className="scale-[0.62]">
                    <TrashGlyph />
                  </span>
                </IconTile>
              </span>
            </div>
            <h2 id="delete-app-title" className="mt-4 text-[20px] font-semibold text-white">
              Delete {target.name}?
            </h2>
            <p id="delete-app-desc" className="mt-1.5 text-[13px] leading-[18px]" style={{ color: ios.secondary }}>
              {message}
            </p>
          </div>

          {/* Its own data: what goes away (and is backed up first) */}
          <section className="mt-6">
            <SectionHeader>Its Data</SectionHeader>
            <Group>
              {!measured && <Row title={<span style={{ color: ios.secondary }}>Measuring…</span>} />}
              {measured && own.length === 0 && <Row title={<span style={{ color: ios.secondary }}>No data of its own, just its settings</span>} />}
              {own.map((d) => (
                <Row
                  key={d.source}
                  title={<span className={d.kind === 'directory' ? 'font-mono text-[13px]' : ''}>{d.kind === 'directory' ? shortPath(d.source) : d.source}</span>}
                  subtitle={
                    d.kind === 'volume'
                      ? `Volume${plan && d.app && d.app !== plan.label && helpers.length ? ` · its ${helpers.length === 1 ? helpers[0] : 'helper'}` : ''}`
                      : d.source
                  }
                  trailing={<span className="tabular-nums">{formatBytes(d.bytes)}</span>}
                />
              ))}
            </Group>
            {plan && plan.shared.length > 0 && (
              <SectionFooter>
                Shared with other apps, so not touched: <span className="font-mono text-[12px] [overflow-wrap:anywhere]">{plan.shared.join(', ')}</span>
              </SectionFooter>
            )}
          </section>

          {/* Backup */}
          <section className="mt-6">
            <Group className="ios-inset-icon">
              <Row
                leading={
                  <IconTile color={backup ? ios.green : ios.red}>
                    <ShieldGlyph off={!backup} />
                  </IconTile>
                }
                title={backup ? 'Back Up First' : 'Backup Off'}
                titleColor={backup ? ios.label : ios.red}
                trailing={<Switch checked={backup} onChange={(on) => (on ? setBackup(true) : setConfirmOff(true))} label="Back up first" />}
              />
            </Group>
            {backup ? (
              <SectionFooter>
                {`Saves its settings${own.length ? ` and data${plan ? ` (${formatBytes(plan.totalBytes)})` : ''}` : ''}. Bring it back anytime from Restore, just as it was.`}
                {notEnoughSpace && (
                  <span className="block mt-1" style={{ color: ios.orange }}>
                    There may not be enough space. If the backup fails, nothing is deleted.
                  </span>
                )}
              </SectionFooter>
            ) : (
              <SectionFooter tone="danger">
                {own.length ? 'Its data will be permanently deleted. Only its settings are kept.' : 'Only its settings are kept.'}{' '}
                <LinkButton onClick={() => setBackup(true)}>Turn On Backup</LinkButton>
              </SectionFooter>
            )}
          </section>

          {error && (
            <p role="alert" className="mt-4 px-4 text-[13px]" style={{ color: ios.red }}>
              {error}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2.5 px-4 sm:px-5 pb-5 pt-1">
          <Button tone="red" variant={backup ? 'tinted' : 'filled'} onClick={runDelete} disabled={deleting || !measured} className="w-full">
            {deleting ? (backup ? 'Backing Up and Deleting…' : 'Deleting…') : backup ? 'Back Up and Delete' : 'Delete Permanently'}
          </Button>
          <Button tone="gray" onClick={onCancel} disabled={deleting} className="w-full">
            Cancel
          </Button>
        </div>
      </div>

      <Alert
        open={confirmOff}
        title="Delete without a backup?"
        message={`${target.name}’s data will be gone for good. This can’t be undone.`}
        confirmLabel="Turn Off"
        destructive
        onCancel={() => setConfirmOff(false)}
        onConfirm={() => {
          setBackup(false);
          setConfirmOff(false);
        }}
      />
    </div>
  );
};
