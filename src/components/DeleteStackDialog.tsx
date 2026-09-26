import React, { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, ShieldCheck, Trash2, X } from 'lucide-react';

export interface DeleteStackTarget {
  projectName: string;
  targetDirectory?: string;
  servicesCount: number;
}

interface Footprint {
  project: string;
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
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * Delete-stack confirmation. Shows exactly what will be removed and backed up (measured on the
 * host), and makes skipping the data backup an explicit, clearly-labelled choice.
 */
export const DeleteStackDialog: React.FC<DeleteStackDialogProps> = ({ target, onCancel, onDeleted }) => {
  const [footprint, setFootprint] = useState<Footprint | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [skipBackup, setSkipBackup] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setSkipBackup(false);
    setError(null);
    setFootprint(null);
    setMeasuring(true);
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
      .catch(() => !cancelled && setFootprint(null))
      .finally(() => !cancelled && setMeasuring(false));
    return () => {
      cancelled = true;
    };
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, deleting, onCancel]);

  if (!target) return null;

  const notEnoughSpace = !skipBackup && footprint && freeBytes !== null && footprint.totalBytes > freeBytes;
  const folder = target.targetDirectory;

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
          skipDataBackup: skipBackup,
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-6 bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !deleting) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-stack-title"
        aria-describedby="delete-stack-desc"
        className="w-full sm:max-w-lg bg-[#0d1220] border border-slate-800 sm:rounded-2xl rounded-t-2xl shadow-2xl shadow-black/60 text-slate-200"
      >
        <div className="px-6 pt-5 pb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="delete-stack-title" className="text-lg font-semibold text-white">
              Delete {target.projectName}?
            </h2>
            <p id="delete-stack-desc" className="text-sm text-slate-400 mt-1.5 leading-relaxed">
              {target.servicesCount > 0
                ? `This stops ${target.servicesCount === 1 ? 'its app' : `its ${target.servicesCount} apps`} and removes its folder and volumes.`
                : 'This removes its folder and volumes.'}
            </p>
            {folder && (
              <p className="mt-2 text-[13px] font-mono text-slate-300 break-words [overflow-wrap:anywhere]">{folder}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            aria-label="Close"
            className="-mr-2 -mt-1 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 space-y-3">
          {!skipBackup ? (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.05] px-4 py-3.5">
              <div className="flex items-center gap-2 text-[15px] text-slate-100">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Everything is backed up first
              </div>
              <div className="text-sm text-slate-400 mt-1.5 leading-relaxed">
                {measuring ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Measuring the folder and volumes…
                  </span>
                ) : footprint ? (
                  <>
                    Folder {formatBytes(footprint.directoryBytes)}
                    {footprint.volumes.length > 0 &&
                      `, ${footprint.volumes.length} ${footprint.volumes.length === 1 ? 'volume' : 'volumes'} ${formatBytes(
                        footprint.volumes.reduce((s, v) => s + v.bytes, 0)
                      )}`}
                    {freeBytes !== null && ` (${formatBytes(freeBytes)} free)`}. The stack is stopped before the backup so databases are
                    saved cleanly. Restore it anytime from History.
                  </>
                ) : (
                  'The folder and volumes are archived before anything is removed. Restore it anytime from History.'
                )}
              </div>
              {notEnoughSpace && (
                <p className="text-sm text-amber-300 mt-2">
                  There may not be enough free space for this backup. If the backup fails, nothing is deleted.
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/[0.06] px-4 py-3.5 text-sm text-rose-100 leading-relaxed">
              <div className="flex items-center gap-2 font-medium text-rose-300">
                <AlertTriangle className="w-4 h-4" />
                The folder and volumes will be gone for good
              </div>
              <p className="mt-1.5 text-rose-100/80">Only the compose file is kept, so Undo can bring back the stack but not its data.</p>
            </div>
          )}

          {footprint && footprint.externalMounts.length > 0 && (
            <p className="text-xs text-slate-500 leading-relaxed">
              Left untouched (outside the stack folder):{' '}
              <span className="font-mono text-slate-400">{footprint.externalMounts.join(', ')}</span>
            </p>
          )}

          <label className="flex items-center gap-2.5 text-sm text-slate-400 cursor-pointer select-none w-fit">
            <input
              type="checkbox"
              checked={skipBackup}
              onChange={(e) => setSkipBackup(e.target.checked)}
              className="w-4 h-4 accent-rose-500"
            />
            Delete without backing up data
          </label>

          {error && (
            <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-200">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-4 mt-4 border-t border-slate-800/80 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="px-4 py-2.5 rounded-xl text-[15px] text-slate-300 hover:text-white hover:bg-slate-800/70"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={runDelete}
            disabled={deleting}
            className="px-5 py-2.5 rounded-xl text-[15px] font-semibold bg-rose-500 text-white hover:bg-rose-400 disabled:opacity-60 flex items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            {deleting
              ? skipBackup
                ? 'Deleting…'
                : 'Backing up and deleting…'
              : skipBackup
                ? 'Delete without backup'
                : 'Back up and delete'}
          </button>
        </div>
      </div>
    </div>
  );
};
