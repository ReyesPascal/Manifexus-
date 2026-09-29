import React, { useEffect, useState } from 'react';
import { ios } from './ui/ios';

/**
 * The command behind a step, for people who want to learn how it's done: the command itself with
 * Copy, and a plain explanation of each part, which also says so when Manifexus did it by talking to
 * Docker directly rather than running that exact command.
 */

export interface Explain {
  part: string;
  meaning: string;
}

export interface LearnCommand {
  title: string;
  command: string;
  equivalent: boolean;
  explain: Explain[];
  ok: boolean;
  ts: string;
  output?: string;
}

export interface LearnStep {
  index: number;
  name: string;
  status: 'running' | 'success' | 'failed' | 'pending';
  commands: LearnCommand[];
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  }
}

/** One command in a dark code block with Copy; the explanation shows under it */
export const CommandBlock: React.FC<{ command: string; equivalent?: boolean; explain?: Explain[]; failed?: boolean; compact?: boolean; collapsible?: boolean }> = ({
  command,
  equivalent,
  explain,
  failed,
  compact,
  collapsible,
}) => {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(!collapsible);
  // When Manifexus did it by asking Docker directly, say so once, inside the explanation
  if (equivalent && explain && !explain.some((e) => !e.part)) explain = [...explain, { part: '', meaning: 'Manifexus asked Docker directly; typing this does the same thing.' }];
  else if (equivalent && !explain) explain = [{ part: '', meaning: 'Manifexus asked Docker directly; typing this does the same thing.' }];
  return (
    <div className="min-w-0">
      <div className="rounded-[10px] overflow-hidden" style={{ background: 'rgba(0,0,0,0.42)', boxShadow: '0 0 0 0.5px rgba(255,255,255,0.08)' }}>
        <div className="flex items-start gap-2 pl-3 pr-1.5 py-2">
          <span className="font-mono text-[12.5px] leading-[19px] select-none" style={{ color: failed ? ios.red : ios.green }}>
            $
          </span>
          <code className="flex-1 min-w-0 font-mono text-[12.5px] leading-[19px] whitespace-pre-wrap break-all" style={{ color: 'rgba(235,235,245,0.92)' }}>
            {command}
          </code>
          <button
            type="button"
            onClick={async () => {
              if (await copy(command)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }
            }}
            className="flex-shrink-0 h-[24px] px-2 rounded-[6px] text-[12px] font-medium hover:bg-white/[0.08] focus-visible:outline-2 focus-visible:outline-[#0A84FF]"
            style={{ color: copied ? ios.green : ios.blue }}
            aria-label={`Copy ${command}`}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      {explain && explain.length > 0 && !compact && collapsible && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 pl-1 text-[12px] font-medium hover:opacity-80" style={{ color: ios.blue }} aria-expanded={open}>
          {open ? 'Hide explanation' : 'What does this mean?'}
        </button>
      )}
      {explain && explain.length > 0 && !compact && open && (
        <dl className="mt-1.5 space-y-0.5 pl-1">
          {explain.map((e, i) => (
            <div key={i} className="flex gap-2 text-[12.5px] leading-[18px]">
              {e.part && (
                <dt className="font-mono flex-shrink-0" style={{ color: 'rgba(235,235,245,0.85)' }}>
                  {e.part}
                </dt>
              )}
              <dd style={{ color: e.part ? ios.secondary : ios.tertiary }}>{e.part ? `— ${e.meaning}` : e.meaning}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
};

/** A titled command: "Stopped lidarr" above its command block (no title when the step already says it) */
export const CommandItem: React.FC<{ c: LearnCommand; compact?: boolean; collapsible?: boolean; hideTitle?: boolean }> = ({ c, compact, collapsible, hideTitle }) => (
  <div className="space-y-1.5">
    {!(hideTitle && c.ok) && (
      <div className="flex items-center gap-1.5 text-[13px]" style={{ color: c.ok ? ios.secondary : ios.red }}>
        <span>{c.ok ? '✓' : '✕'}</span>
        <span className="truncate">{c.title}</span>
      </div>
    )}
    <CommandBlock command={c.command} equivalent={c.equivalent} explain={c.explain} failed={!c.ok} compact={compact} collapsible={collapsible} />
  </div>
);

/**
 * Commands for a running (or finished) activity, fetched as it goes. Returns the steps, keyed by
 * step number, so a progress list can show each step's commands under it.
 */
export function useLearnSteps(activityId: string | undefined, live: boolean): Map<number, LearnCommand[]> {
  return useLearn(activityId, live).steps;
}

/** Steps (by number) and commands outside any step, for an activity */
export function useLearn(activityId: string | undefined, live: boolean): { steps: Map<number, LearnCommand[]>; loose: LearnCommand[]; loaded: boolean } {
  const [data, setData] = useState<{ steps: Map<number, LearnCommand[]>; loose: LearnCommand[]; loaded: boolean }>({ steps: new Map(), loose: [], loaded: false });
  const setSteps = (m: Map<number, LearnCommand[]>, loose: LearnCommand[]) => setData({ steps: m, loose, loaded: true });
  useEffect(() => {
    if (!activityId) return;
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/learn/activities/${encodeURIComponent(activityId)}`, { cache: 'no-store' });
        if (!r.ok) return;
        const j: { steps: LearnStep[]; loose: LearnCommand[] } = await r.json();
        if (!stop) setSteps(new Map(j.steps.map((s) => [s.index, s.commands])), j.loose || []);
      } catch {
        // try again next time
      }
    };
    load();
    const t = live ? setInterval(load, 1500) : undefined;
    // One last look a moment after it finishes, for the final step's commands
    const last = live ? undefined : setTimeout(load, 1200);
    return () => {
      stop = true;
      if (t) clearInterval(t);
      if (last) clearTimeout(last);
    };
  }, [activityId, live]);
  return data;
}
