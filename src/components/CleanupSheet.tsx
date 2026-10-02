import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Group, LinkButton, Row, SectionFooter, SectionHeader, Sheet, ios } from './ui/ios';

/**
 * Server Cleanup: folders in your stacks locations that nothing uses anymore. Pick the ones to delete.
 * Empty folders simply go; stacks with no apps are backed up first and can be restored.
 */

interface Item {
  path: string;
  kind: 'empty' | 'stack';
  files: number;
  bytes: number;
  note: string;
}

interface Result {
  path: string;
  ok: boolean;
  message: string;
}

const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${Math.round(b / 1024)} KB` : b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(1)} GB`);

const Check: React.FC<{ on: boolean }> = ({ on }) => (
  <span
    className="w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0 transition-colors"
    style={on ? { background: ios.blue } : { boxShadow: 'inset 0 0 0 1.5px rgba(235,235,245,0.45)' }}
    aria-hidden
  >
    {on && (
      <svg width="12" height="10" viewBox="0 0 14 11">
        <path d="M1.5 5.8 5.2 9.5 12.5 1.5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )}
  </span>
);

export const CleanupSheet: React.FC<{ open: boolean; onClose: () => void; onChanged?: () => void }> = ({ open, onClose, onChanged }) => {
  const [items, setItems] = useState<Item[] | null>(null);
  const [looked, setLooked] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [chosen, setChosen] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);

  const scan = useCallback(async () => {
    setItems(null);
    setError(undefined);
    setResults(null);
    try {
      const r = await fetch('/api/cleanup/scan', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Couldn’t look through the folders.');
      setItems(j.items);
      setLooked(j.looked || []);
      // Empty folders are picked for you: there's nothing in them to lose
      setChosen(j.items.filter((i: Item) => i.kind === 'empty').map((i: Item) => i.path));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (open) void scan();
  }, [open, scan]);

  const toggle = (p: string) => setChosen((c) => (c.includes(p) ? c.filter((x) => x !== p) : [...c, p]));
  const run = async () => {
    setConfirm(false);
    setBusy(true);
    try {
      const r = await fetch('/api/cleanup/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: chosen }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Couldn’t clean up.');
      setResults(j.results);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const empty = (items || []).filter((i) => i.kind === 'empty');
  const stacks = (items || []).filter((i) => i.kind === 'stack');
  const chosenStacks = stacks.filter((s) => chosen.includes(s.path)).length;

  const list = (title: string, rows: Item[], footer: string) =>
    rows.length > 0 && (
      <section>
        <SectionHeader
          action={
            rows.length > 1 ? (
              <LinkButton
                onClick={() => {
                  const all = rows.every((r) => chosen.includes(r.path));
                  setChosen((c) => (all ? c.filter((p) => !rows.some((r) => r.path === p)) : Array.from(new Set([...c, ...rows.map((r) => r.path)]))));
                }}
              >
                {rows.every((r) => chosen.includes(r.path)) ? 'Deselect All' : 'Select All'}
              </LinkButton>
            ) : undefined
          }
        >
          {title}
        </SectionHeader>
        <Group className="ios-inset-select">
          {rows.map((r) => (
            <Row
              key={r.path}
              onClick={busy ? undefined : () => toggle(r.path)}
              role="checkbox"
              ariaChecked={chosen.includes(r.path)}
              leading={<Check on={chosen.includes(r.path)} />}
              title={<span className="font-mono text-[15px]">{r.path}</span>}
              subtitle={r.kind === 'empty' ? 'Empty' : `${r.note} · ${fmtBytes(r.bytes)}`}
            />
          ))}
        </Group>
        <SectionFooter>{footer}</SectionFooter>
      </section>
    );

  let body: React.ReactNode;
  let footer: React.ReactNode = null;
  if (results) {
    body = (
      <div className="space-y-6">
        <div className="text-center pt-2">
          <h3 className="text-[22px] font-semibold text-white">{results.every((r) => r.ok) ? 'Cleaned Up' : 'Mostly Cleaned Up'}</h3>
          <p className="mt-1 text-[15px]" style={{ color: ios.secondary }}>
            {results.filter((r) => r.ok).length} of {results.length} folder{results.length === 1 ? '' : 's'} deleted.
          </p>
        </div>
        <Group>
          {results.map((r) => (
            <Row
              key={r.path}
              title={<span className="font-mono text-[15px]">{r.path}</span>}
              subtitle={<span style={{ color: r.ok ? ios.secondary : ios.orange }}>{r.message}</span>}
              trailing={<span style={{ color: r.ok ? ios.green : ios.orange }}>{r.ok ? '✓' : '!'}</span>}
            />
          ))}
        </Group>
      </div>
    );
    footer = (
      <div className="flex justify-end gap-2">
        <Button tone="gray" onClick={() => void scan()} className="sm:min-w-[130px]">
          Scan Again
        </Button>
        <Button onClick={onClose} className="flex-1 sm:flex-none sm:min-w-[130px]">
          Done
        </Button>
      </div>
    );
  } else if (error) {
    body = (
      <p className="text-[15px] text-center py-16" style={{ color: ios.orange }}>
        {error}
      </p>
    );
  } else if (!items) {
    body = (
      <div className="py-20 flex flex-col items-center gap-3" style={{ color: ios.secondary }}>
        <span className="w-6 h-6 rounded-full border-2 border-white/15 border-t-white/70 animate-spin" />
        <p className="text-[15px]">Looking through your stacks folders…</p>
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div className="text-center py-16">
        <h3 className="text-[20px] font-semibold text-white">All Tidy</h3>
        <p className="mt-1 text-[15px]" style={{ color: ios.secondary }}>
          No unused folders in {looked.join(', ') || 'your stacks folders'}.
        </p>
      </div>
    );
  } else {
    body = (
      <div className="space-y-7">
        <p className="text-[15px] leading-[20px] px-1" style={{ color: ios.secondary }}>
          Folders in {looked.join(', ')} that no app uses. Folders an app runs from or keeps data in are never listed.
        </p>
        {list('Empty Folders', empty, 'Nothing inside, so there’s nothing to back up.')}
        {list('Stacks With No Apps', stacks, 'Each is backed up before it’s deleted, so you can bring it back from Restore.')}
      </div>
    );
    footer = (
      <div className="flex justify-end">
        <Button tone="red" onClick={() => setConfirm(true)} disabled={!chosen.length || busy} className="flex-1 sm:flex-none sm:min-w-[170px]">
          {busy ? 'Deleting…' : chosen.length ? `Delete ${chosen.length} Folder${chosen.length === 1 ? '' : 's'}` : 'Delete'}
        </Button>
      </div>
    );
  }

  return (
    <Sheet open={open} title="Server Cleanup" onClose={onClose} footer={footer}>
      {body}
      <Alert
        open={confirm}
        title={`Delete ${chosen.length} folder${chosen.length === 1 ? '' : 's'}?`}
        message={
          chosenStacks
            ? `${chosenStacks === 1 ? 'The stack is' : `The ${chosenStacks} stacks are`} backed up first and can be brought back from Restore. Empty folders are simply removed.`
            : 'They’re empty, so nothing is lost.'
        }
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirm(false)}
        onConfirm={() => void run()}
      />
    </Sheet>
  );
};
