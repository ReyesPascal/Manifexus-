import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Group, IconTile, LinkButton, Row, SectionFooter, ios } from './ui/ios';
import { copyText } from './ActivitySheet';

/**
 * The simple step tracker shown while Manifexus changes something (moving apps, restoring).
 * It lives inside the screen that started it, shows one line per step with the current action
 * underneath, and ends with "Done" (then the screen closes by itself) or a plain explanation with
 * a link to the full record in Activity.
 */

export interface TrackerStep {
  index: number;
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  detail?: string;
  durationMs?: number;
}

export type RunStatus = 'idle' | 'running' | 'done' | 'failed' | 'rolled_back';

export interface RunState {
  status: RunStatus;
  steps: TrackerStep[];
  /** Failure reason, or the server's closing message */
  message?: string;
  activityId?: string;
}

/** Streams a run (Server-Sent Events over POST) into a simple state. */
export function useRun() {
  const [state, setState] = useState<RunState>({ status: 'idle', steps: [] });
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const start = useCallback(async (url: string, body: unknown = {}) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setState({ status: 'running', steps: [] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apply = (e: any) =>
      setState((s) => {
        const steps = s.steps.slice();
        const upsert = (i: number, patch: Partial<TrackerStep>) => {
          const at = steps.findIndex((x) => x.index === i);
          if (at >= 0) steps[at] = { ...steps[at], ...patch };
          else steps.push({ index: i, name: patch.name || `Step ${i}`, status: 'pending', ...patch });
          steps.sort((a, b) => a.index - b.index);
        };
        const endRunning = (to: TrackerStep['status']) => steps.forEach((x, i) => x.status === 'running' && (steps[i] = { ...x, status: to }));
        if (e.type === 'step_update' && e.stepIndex) {
          upsert(e.stepIndex, {
            name: e.stepName,
            status: e.status,
            durationMs: e.durationMs,
            // a finished step keeps its last detail only if it failed
            ...(e.status === 'success' ? { detail: undefined } : {}),
          });
          return { ...s, steps };
        }
        if (e.type === 'log' && e.log) {
          const i = e.stepIndex || steps.find((x) => x.status === 'running')?.index;
          if (i) upsert(i, { detail: String(e.log) });
          return { ...s, steps };
        }
        if (e.type === 'completed' || e.type === 'done') {
          steps.forEach((x, i) => x.status === 'pending' && (steps[i] = { ...x, status: 'skipped' }));
          endRunning('success');
          return { ...s, steps, status: 'done' };
        }
        if (e.type === 'auto_reverted') {
          endRunning('failed');
          return { ...s, steps, status: 'rolled_back', message: e.log };
        }
        if (e.type === 'failed' || e.type === 'error') {
          endRunning('failed');
          return { ...s, steps, status: 'failed', message: e.log || e.error };
        }
        return s;
      });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const activityId = res.headers.get('X-Activity-Id') || undefined;
      setState((s) => ({ ...s, activityId }));
      if (!res.ok || !res.body) {
        let reason = `The server answered ${res.status}.`;
        try {
          reason = (await res.json()).error || reason;
        } catch {
          // not JSON
        }
        apply({ type: 'failed', log: reason });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let ended = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            const e = JSON.parse(line.slice(6));
            if (['completed', 'done', 'failed', 'error', 'auto_reverted'].includes(e.type)) ended = true;
            apply(e);
          } catch {
            // ignore a malformed line
          }
        }
      }
      if (!ended) apply({ type: 'failed', log: 'The connection closed before Manifexus said how it went. Check Activity for the result.' });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') apply({ type: 'failed', log: `Lost the connection to Manifexus: ${(err as Error).message}` });
    }
  }, []);

  const reset = useCallback(() => {
    abort.current?.abort();
    setState({ status: 'idle', steps: [] });
  }, []);

  return { state, start, reset };
}

// ----------------------------------------------------------------------------
// View
// ----------------------------------------------------------------------------

const Spinner: React.FC<{ size: number; color?: string }> = ({ size, color = '#fff' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin motion-reduce:animate-none" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-6.2-8.56" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" />
  </svg>
);

const Mark: React.FC<{ d: string; size: number; stroke?: number }> = ({ d, size, stroke = 3 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const CHECK = 'm5 12.5 4.5 4.5L19 7.5';
const BANG = 'M12 6v8M12 18.5v.01';
const BACK = 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11';

const StepIcon: React.FC<{ step: TrackerStep }> = ({ step }) => {
  const box = 'w-[24px] h-[24px] rounded-full flex items-center justify-center flex-shrink-0';
  if (step.status === 'running')
    return (
      <span className={box} style={{ background: 'rgba(10,132,255,0.18)' }}>
        <Spinner size={14} color={ios.blue} />
      </span>
    );
  if (step.status === 'success')
    return (
      <span className={box} style={{ background: ios.green }}>
        <Mark d={CHECK} size={13} />
      </span>
    );
  if (step.status === 'failed')
    return (
      <span className={box} style={{ background: ios.red }}>
        <Mark d={BANG} size={13} stroke={3.4} />
      </span>
    );
  return (
    <span
      className={`${box} text-[12px] font-semibold tabular-nums`}
      style={{ boxShadow: `inset 0 0 0 1.5px ${step.status === 'skipped' ? 'rgba(235,235,245,0.18)' : 'rgba(235,235,245,0.3)'}`, color: ios.tertiary }}
    >
      {step.index}
    </span>
  );
};

const fmt = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? '<1 s' : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);

export const ProgressView: React.FC<{
  run: RunState;
  /** While running: "Moving kavita to music-stack" */
  runningTitle: string;
  /** After success: "kavita is now in music-stack." */
  doneMessage: string;
  /** Called a moment after success (to close the screen); refreshes the dashboard first */
  onDone?: () => void;
  onClose?: () => void;
}> = ({ run, runningTitle, doneMessage, onDone, onClose }) => {
  const [copy, setCopy] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');

  // Success: refresh the dashboard, show "Done" briefly, then close by itself
  useEffect(() => {
    if (run.status === 'done' || run.status === 'failed' || run.status === 'rolled_back') {
      window.dispatchEvent(new CustomEvent('manifexus:refresh_fleet'));
    }
    if (run.status !== 'done' || !onDone) return;
    const t = setTimeout(onDone, 2200);
    return () => clearTimeout(t);
  }, [run.status, onDone]);

  const running = run.status === 'running' || run.status === 'idle';
  const current = run.steps.find((s) => s.status === 'running');
  const tile =
    run.status === 'done' ? (
      <IconTile color={ios.green} size={60}>
        <Mark d={CHECK} size={32} />
      </IconTile>
    ) : run.status === 'failed' ? (
      <IconTile color={ios.red} size={60}>
        <Mark d={BANG} size={32} stroke={3.2} />
      </IconTile>
    ) : run.status === 'rolled_back' ? (
      <IconTile color={ios.orange} size={60}>
        <Mark d={BACK} size={30} stroke={2.6} />
      </IconTile>
    ) : (
      <IconTile color={ios.blue} size={60}>
        <Spinner size={30} />
      </IconTile>
    );

  const title =
    run.status === 'done' ? 'Done' : run.status === 'failed' ? 'Couldn’t Finish' : run.status === 'rolled_back' ? 'Nothing Was Changed' : runningTitle;
  const subtitle =
    run.status === 'done'
      ? doneMessage
      : run.status === 'rolled_back'
        ? `It didn’t work, so everything was put back the way it was. ${run.message ? `Reason: ${run.message}` : ''}`
        : run.status === 'failed'
          ? run.message || 'Something went wrong.'
          : current?.name
            ? `${current.name}…`
            : 'Starting…';

  const openActivity = () => run.activityId && window.dispatchEvent(new CustomEvent('manifexus:open-activity', { detail: { id: run.activityId } }));
  const copyReport = async () => {
    if (!run.activityId) return;
    setCopy('busy');
    try {
      const r = await fetch(`/api/logs/activities/${encodeURIComponent(run.activityId)}/export?format=markdown`);
      setCopy((await copyText(await r.text())) ? 'done' : 'failed');
    } catch {
      setCopy('failed');
    }
    setTimeout(() => setCopy('idle'), 2500);
  };

  return (
    <div className="space-y-7" aria-live="polite">
      <div className="flex flex-col items-center text-center pt-3">
        {tile}
        <h3 className="mt-4 text-[22px] leading-[27px] font-semibold text-white px-4">{title}</h3>
        <p
          className="mt-1.5 text-[14px] leading-[19px] max-w-[460px] px-4 break-words line-clamp-3"
          style={{ color: run.status === 'failed' ? '#FF8A80' : ios.secondary }}
        >
          {subtitle}
        </p>
        {run.status === 'done' && onDone && (
          <p className="mt-3 text-[12px]" style={{ color: ios.tertiary }}>
            Closing…
          </p>
        )}
        {(run.status === 'failed' || run.status === 'rolled_back') && (
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {run.activityId && (
              <Button onClick={openActivity} className="!h-[38px] !text-[15px] !px-5">
                See What Happened
              </Button>
            )}
            {run.activityId && (
              <Button onClick={copyReport} tone="gray" className="!h-[38px] !text-[15px] !px-5">
                {copy === 'busy' ? 'Preparing…' : copy === 'done' ? 'Copied' : copy === 'failed' ? 'Couldn’t Copy' : 'Copy for Claude'}
              </Button>
            )}
            {onClose && (
              <Button onClick={onClose} tone="gray" className="!h-[38px] !text-[15px] !px-5">
                Close
              </Button>
            )}
          </div>
        )}
      </div>

      {run.steps.length > 0 && (
        <section>
          <Group className="ios-inset-icon">
            {run.steps.map((s) => (
              <Row
                key={s.index}
                leading={<StepIcon step={s} />}
                title={
                  <span style={{ color: s.status === 'pending' || s.status === 'skipped' ? ios.tertiary : s.status === 'failed' ? '#FF8A80' : ios.label }}>
                    {s.name}
                  </span>
                }
                subtitle={
                  (s.status === 'running' || s.status === 'failed') && s.detail ? (
                    <span className="line-clamp-2 break-words">{s.detail}</span>
                  ) : undefined
                }
                trailing={s.status === 'success' || s.status === 'failed' ? <span className="text-[13px] tabular-nums">{fmt(s.durationMs)}</span> : undefined}
              />
            ))}
          </Group>
          {running && <SectionFooter>You can close this screen. It keeps going, and the result is saved in Activity.</SectionFooter>}
          {!running && run.activityId && run.status === 'done' && (
            <SectionFooter>
              <LinkButton onClick={openActivity}>View Details in Activity</LinkButton>
            </SectionFooter>
          )}
        </section>
      )}
    </div>
  );
};
