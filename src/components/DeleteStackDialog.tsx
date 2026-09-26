import React, { useEffect, useState } from 'react';
import { Alert, AppTile, Button, Group, IconTile, LinkButton, Row, SectionFooter, SectionHeader, Switch, ios } from './ui/ios';

export interface DeleteStackTarget {
  projectName: string;
  targetDirectory?: string;
  servicesCount: number;
  /** Apps in the stack, listed so the user sees exactly what goes away */
  apps?: { id: string; name: string; iconUrl?: string }[];
}

interface Footprint {
  directoryBytes: number;
  volumes: { name: string; bytes: number }[];
  externalMounts: string[];
  totalBytes: number;
}

interface DeleteStackDialogProps {
  target: DeleteStackTarget | null;
  onCancel: () => void;
  onDeleted: (message: string) => void;
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

const MAX_LISTED = 5;

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

/**
 * Delete-stack confirmation (Apple-style). Backup is on by default; turning it off asks for
 * confirmation, turns the backup row red, and changes the delete button to "Delete Permanently".
 */
export const DeleteStackDialog: React.FC<DeleteStackDialogProps> = ({ target, onCancel, onDeleted }) => {
  const [footprint, setFootprint] = useState<Footprint | null>(null);
  const [measured, setMeasured] = useState(false);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [backup, setBackup] = useState(true);
  const [confirmOff, setConfirmOff] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setBackup(true);
    setConfirmOff(false);
    setError(null);
    setFootprint(null);
    setMeasured(false);
    let cancelled = false;
    fetch('/api/stacks/data-footprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stacks: [{ project: target.projectName, workingDir: target.targetDirectory }] }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setFootprint(d.footprints?.[0] || null);
        setFreeBytes(typeof d.freeBytes === 'number' ? d.freeBytes : null);
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

  const apps = target.apps || [];
  const listed = apps.slice(0, MAX_LISTED);
  const hidden = apps.length - listed.length;
  const notEnoughSpace = backup && footprint && freeBytes !== null && footprint.totalBytes > freeBytes;
  const volumeCount = footprint?.volumes.length || 0;
  const volumeBytes = footprint?.volumes.reduce((s, v) => s + v.bytes, 0) || 0;

  const runDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch('/api/stacks/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName: target.projectName,
          targetDirectory: target.targetDirectory,
          skipDataBackup: !backup,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'The stack could not be deleted.');
      onDeleted(data.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const message =
    target.servicesCount > 0
      ? `${target.servicesCount === 1 ? 'Its app is' : `Its ${target.servicesCount} apps are`} stopped and removed, along with the stack folder and its volumes.`
      : 'The stack folder and its volumes are removed.';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-6 bg-black/55"
      style={{ fontFamily: ios.font }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !deleting && !confirmOff) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-stack-title"
        aria-describedby="delete-stack-desc"
        className="w-full sm:max-w-[420px] max-h-[92vh] flex flex-col rounded-t-[14px] sm:rounded-[14px] overflow-hidden motion-safe:animate-[ios-sheet-in_220ms_ease-out]"
        style={{ background: ios.sheet, boxShadow: '0 30px 80px rgba(0,0,0,0.55)', WebkitFontSmoothing: 'antialiased' }}
      >
        <div className="overflow-y-auto px-4 sm:px-5 pt-7 pb-5">
          {/* Title */}
          <div className="flex flex-col items-center text-center px-2">
            <IconTile color={ios.red} size={52}>
              <TrashGlyph />
            </IconTile>
            <h2 id="delete-stack-title" className="mt-4 text-[20px] font-semibold text-white">
              Delete {target.projectName}?
            </h2>
            <p id="delete-stack-desc" className="mt-1.5 text-[13px] leading-[18px]" style={{ color: ios.secondary }}>
              {message}
            </p>
            {target.targetDirectory && (
              <p className="mt-1 text-[12px] font-mono [overflow-wrap:anywhere]" style={{ color: ios.tertiary }}>
                {target.targetDirectory}
              </p>
            )}
          </div>

          {/* Apps */}
          {apps.length > 0 && (
            <section className="mt-6">
              <SectionHeader>Apps</SectionHeader>
              <Group className="ios-inset-icon">
                {listed.map((a) => (
                  <Row key={a.id} leading={<AppTile name={a.name} iconUrl={a.iconUrl} />} title={a.name} />
                ))}
                {hidden > 0 && <Row title={<span style={{ color: ios.secondary }}>and {hidden} more</span>} />}
              </Group>
            </section>
          )}

          {/* Backup */}
          <section className="mt-6">
            <Group className="ios-inset-icon">
              <Row
                leading={
                  <IconTile color={backup ? ios.green : ios.red}>
                    <ShieldGlyph off={!backup} />
                  </IconTile>
                }
                title={backup ? 'Back Up Data First' : 'Backup Off'}
                titleColor={backup ? ios.label : ios.red}
                trailing={
                  <Switch
                    checked={backup}
                    onChange={(on) => (on ? setBackup(true) : setConfirmOff(true))}
                    label="Back up data first"
                  />
                }
              />
            </Group>
            {backup ? (
              <SectionFooter>
                {!measured
                  ? 'Measuring the folder and volumes…'
                  : footprint
                    ? `Saves the folder (${formatBytes(footprint.directoryBytes)})${
                        volumeCount ? ` and ${volumeCount === 1 ? '1 volume' : `${volumeCount} volumes`} (${formatBytes(volumeBytes)})` : ''
                      }. Restore it anytime from History.`
                    : 'Saves the folder and volumes first. Restore it anytime from History.'}
                {notEnoughSpace && (
                  <span className="block mt-1" style={{ color: ios.orange }}>
                    There may not be enough space. If the backup fails, nothing is deleted.
                  </span>
                )}
              </SectionFooter>
            ) : (
              <SectionFooter tone="danger">
                The folder and volumes will be permanently deleted. Only the compose file is kept.{' '}
                <LinkButton onClick={() => setBackup(true)}>Turn On Backup</LinkButton>
              </SectionFooter>
            )}
            {footprint && footprint.externalMounts.length > 0 && (
              <SectionFooter>
                Not touched: <span className="font-mono text-[12px] [overflow-wrap:anywhere]">{footprint.externalMounts.join(', ')}</span>
              </SectionFooter>
            )}
          </section>

          {error && (
            <p role="alert" className="mt-4 px-4 text-[13px]" style={{ color: ios.red }}>
              {error}
            </p>
          )}
        </div>

        {/* Buttons: action on top, Cancel below (Apple's stacked layout for longer labels) */}
        <div className="flex flex-col gap-2.5 px-4 sm:px-5 pb-5 pt-1">
          <Button tone="red" variant={backup ? 'tinted' : 'filled'} onClick={runDelete} disabled={deleting} className="w-full">
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
        message="The stack folder and its volumes will be gone for good. This can’t be undone."
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
