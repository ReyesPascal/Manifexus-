import React, { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { AutomationPrivileges } from '../types';
import { BackButton, Group, IconTile, LinkButton, Row, SectionFooter, SectionHeader, Sheet, Switch, ios } from './ui/ios';

/**
 * Server Changes: one switch. Off (the default), Manifexus shows your apps and can start, stop or
 * restart them, nothing more. Turning it on gets the server ready for real (Docker access, Docker
 * Compose, the stacks folder, running commands), step by step, and only switches on when all of it works.
 */

export interface Step {
  id: string;
  title: string;
  status: 'running' | 'done' | 'failed' | 'warn';
  detail?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  privileges: AutomationPrivileges | null;
  onRefreshPrivileges: () => Promise<void>;
  /** Shown as ‹ Back when this opens on top of another screen */
  backLabel?: string;
  zIndex?: number;
}

export const StepMark: React.FC<{ status: Step['status'] }> = ({ status }) =>
  status === 'running' ? (
    <span className="w-[22px] h-[22px] flex items-center justify-center" aria-label="Working">
      <span className="w-[16px] h-[16px] rounded-full border-2 border-white/15 border-t-white/80 animate-spin" />
    </span>
  ) : (
    <span
      className="w-[22px] h-[22px] rounded-full flex items-center justify-center"
      style={{ background: status === 'done' ? ios.green : status === 'warn' ? ios.orange : ios.red }}
      aria-label={status === 'done' ? 'Done' : status === 'warn' ? 'Not available' : 'Didn’t work'}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {status === 'done' ? <path d="m5 12.5 4.5 4.5L19 7.5" /> : status === 'warn' ? <path d="M12 6v7M12 18h.01" /> : <path d="M6 6l12 12M18 6 6 18" />}
      </svg>
    </span>
  );

/** Turns Server Changes on, reporting each step of getting the server ready; true when it's on */
export async function turnOnServerChanges(onStep: (s: Step) => void): Promise<boolean> {
  const r = await fetch('/api/system/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allow: true }) });
  if (!r.body) throw new Error('Manifexus didn’t answer.');
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ok = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.step) onStep(m.step as Step);
      if (m.done) ok = Boolean(m.ok);
    }
  }
  return ok;
}

export const HostAutomationModal: React.FC<Props> = ({ isOpen, onClose, privileges, onRefreshPrivileges, backLabel, zIndex = 80 }) => {
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (isOpen) {
      setSteps([]);
      setProblem(undefined);
      void onRefreshPrivileges();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const on = Boolean(privileges?.allowChanges);
  const docker = privileges ? privileges.isDockerConnected : true;

  const turnOn = async () => {
    setBusy(true);
    setSteps([]);
    setProblem(undefined);
    try {
      const r = await fetch('/api/system/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allow: true }) });
      if (!r.body) throw new Error('Manifexus didn’t answer.');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.step) {
            const s = m.step as Step;
            setSteps((prev) => (prev.some((p) => p.id === s.id) ? prev.map((p) => (p.id === s.id ? s : p)) : [...prev, s]));
          }
          if (m.done && !m.ok) setProblem('Server Changes stays off until this works.');
        }
      }
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      await onRefreshPrivileges();
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setSteps([]);
    setProblem(undefined);
    try {
      await fetch('/api/system/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allow: false }) });
    } finally {
      await onRefreshPrivileges();
      setBusy(false);
    }
  };

  const failed = steps.some((s) => s.status === 'failed');

  return (
    <Sheet
      open={isOpen}
      title="Server Changes"
      onClose={onClose}
      zIndex={zIndex}
      leftAction={backLabel ? <BackButton label={backLabel} onClick={onClose} /> : undefined}
      rightAction={backLabel ? <span /> : undefined}
    >
      <div className="space-y-7">
        <section>
          <Group className="ios-inset-icon">
            <Row
              leading={
                <IconTile color={on ? ios.green : 'rgba(120,120,128,0.55)'}>
                  <ShieldCheck className="w-[17px] h-[17px]" />
                </IconTile>
              }
              title="Server Changes"
              subtitle={busy ? (on ? 'Turning off…' : 'Getting your server ready…') : on ? 'On' : 'Off'}
              trailing={
                <span className={busy || !docker ? 'opacity-40 pointer-events-none' : ''} aria-disabled={busy || !docker}>
                  <Switch checked={on || (busy && !on && !failed)} onChange={(v) => void (v ? turnOn() : turnOff())} label="Server Changes" />
                </span>
              }
            />
          </Group>
          <SectionFooter>
            {!docker
              ? 'Manifexus can’t reach Docker, so it can’t change anything.'
              : 'Lets Manifexus move apps, create and delete stacks, restore backups, clean up folders and fix problems. Everything is backed up first and can be undone from Restore. When it’s off, Manifexus only shows your apps and starts, stops or restarts them.'}
          </SectionFooter>
        </section>

        {steps.length > 0 && (
          <section>
            <SectionHeader action={failed && !busy ? <LinkButton onClick={() => void turnOn()}>Try Again</LinkButton> : undefined}>
              Getting Your Server Ready
            </SectionHeader>
            <Group className="ios-inset-icon">
              {steps.map((s) => (
                <Row
                  key={s.id}
                  leading={<StepMark status={s.status} />}
                  title={s.title}
                  subtitle={s.detail ? <span style={{ color: s.status === 'failed' ? ios.red : s.status === 'warn' ? ios.orange : undefined }}>{s.detail}</span> : undefined}
                />
              ))}
            </Group>
            {problem ? (
              <SectionFooter tone="danger">{problem}</SectionFooter>
            ) : !busy && on ? (
              <SectionFooter>All set. Server Changes is on.</SectionFooter>
            ) : null}
          </section>
        )}
      </div>
    </Sheet>
  );
};
