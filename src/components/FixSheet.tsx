import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Group, IconTile, LinkButton, Row, SectionFooter, SectionHeader, Sheet, ios } from './ui/ios';
import { ProgressView, useRun } from './ProgressTracker';
import { CommandBlock } from './Commands';
import { Markdown } from './Markdown';
import { AiAction, Answer, AssistantIcon, Plan, Status, applyAiEvent, newAnswer, settleAnswer, streamAiChat } from './aiShared';
import { DiffView, RouteChips, StepTile, WorkLog } from './AssistantSheet';

/**
 * Fixing what Diagnostics found, one problem start to finish. First a choice:
 * - Fix Automatically: Manifexus knows the fix (no AI), shows the change, and makes it on your OK.
 * - Fix It Myself: step-by-step instructions with the exact commands and the screens that do each step.
 * - Fix with AI: the built-in AI looks into it with every step visible and proposes a change.
 * Either change is reviewed first (every file as a before/after), made with the same backup-first
 * progress as moves and restores, and then the checks run again to confirm the problem is gone.
 */

/** How to fix one problem without AI (mirrors server/fixCatalog.ts) */
export interface FixInfo {
  auto?: string;
  manual: { text: string; command?: string; screen?: 'settings' | 'restore' | 'updates' | 'activity' | 'logs' }[];
}

export interface FixRequest {
  /** What to ask the AI (e.g. "Please fix this: New stacks folder setting is broken") */
  question: string;
  /** The issues as Diagnostics reports them, for the AI */
  focus: string;
  issues: { id?: string; title: string; detail?: string; level?: string; fix?: FixInfo }[];
  /** Where to run the checks again afterwards */
  recheckUrl: string;
  /** What the problem belongs to, e.g. "Manifexus" or "kavita" */
  subject: string;
  /** The app the problems are about (not set for Manifexus itself) */
  appId?: string;
  /** Skip the choice and go straight to the AI (after setting it up for this fix) */
  withAi?: boolean;
}

type Stage = 'choose' | 'manual' | 'preparing' | 'starting' | 'working' | 'result' | 'applying' | 'done' | 'failed';
type Path = 'auto' | 'ai' | 'manual';

const SCREEN_LABEL: Record<NonNullable<FixInfo['manual'][number]['screen']>, string> = {
  settings: 'Open Settings',
  restore: 'Open Restore',
  updates: 'Open Updates',
  activity: 'Open Activity',
  logs: 'Open Its Logs',
};

export const FixSheet: React.FC<{
  request: FixRequest | null;
  onClose: () => void;
  /** The AI isn't set up yet: go through setup first */
  onNeedsSetup: (r: FixRequest) => void;
  /** A button it offered (e.g. open Move for an app) */
  onAction: (a: AiAction) => void;
}> = ({ request, onClose, onNeedsSetup, onAction }) => {
  const open = Boolean(request);
  const [stage, setStage] = useState<Stage>('choose');
  const [path, setPath] = useState<Path>('auto');
  const [answer, setAnswer] = useState<Answer>(newAnswer());
  const [autoPlan, setAutoPlan] = useState<Plan | null>(null);
  const [autoError, setAutoError] = useState<string>();
  const [status, setStatus] = useState<Status | null>(null);
  const [byHand, setByHand] = useState(false);
  const [recheck, setRecheck] = useState<'checking' | 'gone' | 'still' | 'unknown'>();
  const abort = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const run = useRun();

  const loadStatus = async () => {
    try {
      const s: Status = await (await fetch('/api/ai/status', { cache: 'no-store' })).json();
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  };

  const reset = () => {
    abort.current?.abort();
    setAnswer(newAnswer());
    setAutoPlan(null);
    setAutoError(undefined);
    setByHand(false);
    setRecheck(undefined);
    run.reset();
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: 0 }));
  };

  const withAi = useCallback(async (r: FixRequest) => {
    reset();
    setPath('ai');
    setStage('starting');
    const s = await loadStatus();
    if (!s?.ready) return onNeedsSetup({ ...r, withAi: true });
    setStage('working');
    const ac = new AbortController();
    abort.current = ac;
    try {
      await streamAiChat({ messages: [{ role: 'user', content: r.question }], focus: r.focus, mode: 'fix' }, (ev) => setAnswer((a) => applyAiEvent(a, ev)), ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) setAnswer((a) => ({ ...a, error: (e as Error).message || 'Something went wrong.' }));
    } finally {
      setAnswer((a) => settleAnswer(a, ac.signal.aborted));
      if (!ac.signal.aborted) setStage('result');
      abort.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onNeedsSetup]);

  // Manifexus's own fix: the change for the problems it knows how to fix, as a plan to review
  const automatically = async (r: FixRequest) => {
    reset();
    setPath('auto');
    setStage('preparing');
    void loadStatus();
    try {
      const res = await fetch('/api/diagnostics/autofix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkIds: r.issues.filter((i) => i.fix?.auto && i.id).map((i) => i.id), appId: r.appId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.id) throw new Error(j.error || 'Couldn’t prepare the fix.');
      setAutoPlan(j);
    } catch (e) {
      setAutoError((e as Error).message);
    }
    setStage('result');
  };

  const choose = () => {
    reset();
    setStage('choose');
  };

  useEffect(() => {
    if (!request) return;
    reset();
    if (request.withAi) void withAi(request);
    else {
      setStage('choose');
      void loadStatus();
    }
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const close = () => {
    abort.current?.abort();
    onClose();
  };

  const plan = path === 'auto' ? autoPlan : answer.plan;

  const makeChanges = () => {
    if (!plan) return;
    setStage('applying');
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: 0 }));
    void run.start(`/api/ai/plans/${encodeURIComponent(plan.id)}/run`, {});
  };

  // Changes made: run the checks again and see whether the problem is still reported
  const verify = useCallback(async () => {
    if (!request) return;
    setRecheck('checking');
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const j = await (await fetch(request.recheckUrl, { cache: 'no-store' })).json();
      const checks: { id: string; title: string; level: string }[] = j.checks || [];
      // An automatic fix is only judged on the problems it covered
      const targets = path === 'auto' ? request.issues.filter((i) => i.fix?.auto && i.id) : request.issues;
      const still = targets.some((i) => checks.some((c) => c.title === i.title && (!i.id || c.id === i.id) && (c.level === 'warn' || c.level === 'error')));
      setRecheck(still ? 'still' : 'gone');
    } catch {
      setRecheck('unknown');
    }
  }, [request, path]);

  if (!request) return null;
  // “Look only” limits the AI; Manifexus's own fixes are made on your OK either way
  const look = path === 'ai' && status?.settings.freedom === 'look';
  const issue = request.issues[0];
  const autoIssues = request.issues.filter((i) => i.fix?.auto && i.id);

  // ------------------------------------------------------------ the problem, always on top
  // Fixing automatically only covers the problems Manifexus knows the answer to
  const shown = path === 'auto' && stage !== 'choose' && autoIssues.length ? autoIssues : request.issues;
  const problem = (
    <Group className="ios-inset-icon">
      {shown.map((i, k) => (
        <Row
          key={k}
          leading={
            <IconTile color={i.level === 'error' ? ios.red : ios.orange}>
              <span className="text-white font-bold text-[15px]">!</span>
            </IconTile>
          }
          title={<span className="whitespace-normal">{i.title}</span>}
          subtitle={i.detail ? <span className="whitespace-normal">{i.detail}</span> : undefined}
        />
      ))}
    </Group>
  );

  let body: React.ReactNode;
  let footer: React.ReactNode = null;
  let title = path === 'auto' ? 'Fix Automatically' : path === 'manual' ? 'Fix It Myself' : 'Fix with AI';

  const recheckRow = recheck && (
    <Group>
      <Row
        leading={
          <IconTile color={recheck === 'gone' ? ios.green : recheck === 'still' ? ios.orange : '#636366'}>
            <span className="text-white font-bold text-[14px]">{recheck === 'gone' ? '✓' : recheck === 'still' ? '!' : '…'}</span>
          </IconTile>
        }
        title={
          recheck === 'checking'
            ? 'Checking it’s fixed…'
            : recheck === 'gone'
              ? `Diagnostics no longer reports ${shown.length > 1 ? 'these problems' : 'this problem'}`
              : recheck === 'still'
                ? `Diagnostics still reports ${shown.length > 1 ? 'some of these problems' : 'this problem'}`
                : 'Couldn’t check again'
        }
        subtitle={
          recheck === 'still'
            ? path === 'manual'
              ? 'Go through the steps again, or try another way.'
              : 'The change was made, but the check still fails. It may need a restart, or a different fix.'
            : recheck === 'gone'
              ? shown.length < request.issues.length
                ? 'The other problems still need fixing: Other Ways shows how.'
                : `${request.subject} checks out.`
              : undefined
        }
      />
    </Group>
  );

  // The change to make, every file as a before/after (Manifexus's own fix or the AI's)
  const changes = plan && (
    <section>
      <SectionHeader>What Will Change</SectionHeader>
      <div className="space-y-3">
        {plan.steps.map((st, i) => (
          <Group key={i} className="ios-inset-icon">
            <Row leading={<StepTile type={st.action.type} />} title={<span className="whitespace-normal">{st.label}</span>} subtitle={st.action.reason} />
            {st.diff && (
              <div className="px-3 pb-3">
                <DiffView lines={st.diff} />
              </div>
            )}
            {byHand && (st.howTo || []).length > 0 && (
              <div className="px-4 pb-3.5 space-y-2.5">
                <div className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: ios.tertiary }}>
                  To do it yourself
                </div>
                {st.howTo!.map((h, k) => (
                  <div key={k} className="space-y-1">
                    {h.note && <p className="text-[12.5px] leading-[18px]" style={{ color: ios.secondary }}>{h.note}</p>}
                    <CommandBlock command={h.command} explain={h.explain} />
                  </div>
                ))}
              </div>
            )}
          </Group>
        ))}
      </div>
      <SectionFooter>
        {plan.steps.some((s) => !s.undoable)
          ? 'Some steps run commands that can’t be undone. Everything else is backed up first and saved in Restore.'
          : 'A backup is saved first, and you can undo this anytime from Restore.'}
      </SectionFooter>
    </section>
  );

  const planFooter = (
    <div className="flex items-center justify-end gap-2">
      <span className="mr-auto">
        <LinkButton onClick={() => setByHand((v) => !v)}>{byHand ? 'Hide the Commands' : 'Do It Myself'}</LinkButton>
      </span>
      <Button tone="gray" onClick={close} className="hidden sm:inline-flex sm:min-w-[110px]">
        Not Now
      </Button>
      {!look && (
        <Button onClick={makeChanges} className="flex-1 sm:flex-none sm:min-w-[170px]">
          Make Changes
        </Button>
      )}
    </div>
  );

  if (stage === 'choose') {
    title = request.issues.length > 1 ? 'Fix These' : 'Fix This';
    const allAuto = autoIssues.length === request.issues.length;
    const aiReady = Boolean(status?.ready);
    body = (
      <div className="space-y-7">
        <section>
          <SectionHeader>The Problem</SectionHeader>
          {problem}
        </section>
        <section>
          <SectionHeader>How Do You Want to Fix It?</SectionHeader>
          <Group className="ios-inset-icon">
            {autoIssues.length > 0 && (
              <Row
                onClick={() => void automatically(request)}
                leading={
                  <IconTile color={ios.green}>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
                    </svg>
                  </IconTile>
                }
                title={<span className="flex items-center gap-2">Fix Automatically <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-md" style={{ color: '#64B5FF', background: 'rgba(10,132,255,0.16)' }}>Recommended</span></span>}
                subtitle={
                  <span className="whitespace-normal">
                    {autoIssues.length === 1 ? autoIssues[0].fix!.auto : `${autoIssues.length} changes Manifexus knows are right`}
                    {allAuto ? '' : ` (${autoIssues.length} of the ${request.issues.length} problems)`}. You see the change first; no AI needed.
                  </span>
                }
                chevron
              />
            )}
            <Row
              onClick={() => {
                reset();
                setPath('manual');
                setStage('manual');
              }}
              leading={
                <IconTile color="#0A84FF">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
                  </svg>
                </IconTile>
              }
              title="Fix It Myself"
              subtitle="Step-by-step instructions, with the commands to copy"
              chevron
            />
            <Row
              onClick={() => void withAi(request)}
              leading={<AssistantIcon size={30} />}
              title="Fix with AI"
              subtitle={aiReady ? 'The built-in AI looks into it and proposes a fix for you to review' : 'Sets up the built-in AI first (a few minutes), then it looks into it and proposes a fix'}
              chevron
            />
          </Group>
          <SectionFooter>
            {autoIssues.length > 0
              ? 'Every change is shown before it’s made, backed up first and saved in Restore.'
              : 'Manifexus can’t fix this by itself: it depends on your setup. Follow the steps, or let the AI look into it.'}
          </SectionFooter>
        </section>
      </div>
    );
    footer = (
      <div className="flex justify-end">
        <Button tone="gray" onClick={close} className="sm:min-w-[110px]">
          Not Now
        </Button>
      </div>
    );
  } else if (stage === 'manual') {
    body = (
      <div className="space-y-7">
        {request.issues.map((i, n) => {
          const steps = i.fix?.manual?.length ? i.fix.manual : [{ text: i.detail || i.title }];
          return (
            <section key={n}>
              <SectionHeader>{i.title}</SectionHeader>
              <ol className="rounded-[14px] divide-y divide-white/[0.06]" style={{ background: ios.group }}>
                {steps.map((st, k) => {
                  const btn = st.screen === 'logs' ? (request.appId ? { screen: 'app_details' as const, appId: request.appId } : undefined) : st.screen ? { screen: st.screen } : undefined;
                  return (
                    <li key={k} className="flex gap-3 px-4 py-3.5">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full text-[13px] font-semibold flex items-center justify-center tabular-nums" style={{ background: 'rgba(10,132,255,0.18)', color: '#64B5FF' }}>
                        {k + 1}
                      </span>
                      <div className="min-w-0 flex-1 space-y-2">
                        <p className="text-[14.5px] leading-[20px] text-white/90">{st.text}</p>
                        {st.command && <CommandBlock command={st.command} />}
                        {btn && st.screen && (
                          <Button tone="gray" onClick={() => onAction({ ...btn, label: SCREEN_LABEL[st.screen!] } as AiAction)} className="!h-[32px] !px-3.5 !text-[13.5px]">
                            {SCREEN_LABEL[st.screen]}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
        {recheckRow}
      </div>
    );
    footer = (
      <div className="flex items-center justify-end gap-2">
        <Button tone="gray" onClick={choose} className="sm:min-w-[110px]">
          Other Ways
        </Button>
        {recheck === 'gone' ? (
          <Button onClick={close} className="flex-1 sm:flex-none sm:min-w-[170px]">
            Close
          </Button>
        ) : (
          <Button onClick={() => void verify()} disabled={recheck === 'checking'} className="flex-1 sm:flex-none sm:min-w-[170px]">
            {recheck === 'checking' ? 'Checking…' : 'I’m Done: Check Again'}
          </Button>
        )}
      </div>
    );
  } else if (stage === 'applying' || stage === 'done' || stage === 'failed') {
    title = stage === 'applying' ? 'Making Changes' : stage === 'done' ? (recheck === 'gone' ? 'Fixed' : 'Changes Made') : 'Didn’t Finish';
    body = (
      <div className="space-y-6">
        <ProgressView
          run={run.state}
          runningTitle={plan?.title || 'Making the changes'}
          doneMessage="Done. It’s saved in Restore, so you can undo it anytime."
          onDone={() => {
            setStage('done');
            void verify();
          }}
          onClose={() => setStage('failed')}
        />
        {stage === 'done' && recheckRow}
      </div>
    );
    footer =
      stage === 'applying' ? null : (
        <div className="flex items-center justify-end gap-2">
          {(stage === 'failed' || recheck === 'still' || (recheck === 'gone' && shown.length < request.issues.length)) && (
            <Button tone="gray" onClick={choose} className="sm:min-w-[150px]">
              Other Ways
            </Button>
          )}
          <Button onClick={close} className="flex-1 sm:flex-none sm:min-w-[150px]">
            Close
          </Button>
        </div>
      );
  } else if (path === 'auto') {
    const preparing = stage === 'preparing';
    body = (
      <div className="space-y-7">
        <section>
          <SectionHeader>The Problem</SectionHeader>
          {problem}
        </section>
        {preparing && (
          <p className="text-[14px]" style={{ color: ios.secondary }}>
            Preparing the change…
          </p>
        )}
        {autoPlan && autoPlan.explanation && (
          <div className="rounded-[14px] px-4 py-3.5" style={{ background: ios.group, color: 'rgba(235,235,245,0.88)' }}>
            <Markdown text={autoPlan.explanation} lead />
          </div>
        )}
        {autoError && <p className="text-[14px]" style={{ color: ios.orange }}>{autoError}</p>}
        {changes}
      </div>
    );
    footer = preparing ? null : autoPlan ? (
      planFooter
    ) : (
      <div className="flex items-center justify-end gap-2">
        <Button tone="gray" onClick={close} className="sm:min-w-[110px]">
          Close
        </Button>
        <Button onClick={choose} className="flex-1 sm:flex-none sm:min-w-[150px]">
          Other Ways
        </Button>
      </div>
    );
  } else {
    const working = stage === 'starting' || answer.streaming;
    body = (
      <div className="space-y-7">
        <div className="flex items-center gap-3">
          <AssistantIcon size={40} />
          <div className="min-w-0">
            <div className="text-[17px] font-semibold text-white leading-[22px]">{working ? 'Looking into it' : plan ? 'Here’s the fix' : answer.error ? 'It couldn’t finish' : 'What it found'}</div>
            <div className="text-[13px]" style={{ color: ios.secondary }}>
              {working ? 'Nothing changes until you say so.' : plan ? 'Review it, then choose what to do.' : 'No change was proposed.'}
            </div>
          </div>
        </div>
        <section>
          <SectionHeader>The Problem</SectionHeader>
          {problem}
        </section>
        <section className="space-y-3">
          <SectionHeader>{working ? 'Working on It' : 'How It Worked It Out'}</SectionHeader>
          {answer.route && <RouteChips route={answer.route} />}
          <WorkLog item={{ ...answer, streaming: working, showWork: working || answer.showWork }} onToggle={() => setAnswer((a) => ({ ...a, showWork: !a.showWork }))} />
        </section>
        {!working && (answer.text || answer.error) && (
          <section className="space-y-3">
            <SectionHeader>{plan ? 'The Fix' : 'What It Found'}</SectionHeader>
            {answer.text && (
              <div className="rounded-[14px] px-4 py-3.5 motion-safe:animate-[ios-rise-in_280ms_ease-out]" style={{ background: ios.group, color: 'rgba(235,235,245,0.88)' }}>
                <Markdown text={answer.text} lead />
              </div>
            )}
            {answer.error && <p className="text-[14px]" style={{ color: ios.orange }}>{answer.error}</p>}
            {answer.actions && answer.actions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {answer.actions.map((x, k) => (
                  <Button key={k} tone="gray" onClick={() => onAction(x)} className="!h-[34px] !px-4 !text-[14px]">
                    {x.label}
                  </Button>
                ))}
              </div>
            )}
          </section>
        )}
        {!working && changes}
      </div>
    );
    if (working) {
      footer = (
        <div className="flex justify-end">
          <Button tone="gray" onClick={close} className="sm:min-w-[150px]">
            Stop
          </Button>
        </div>
      );
    } else if (plan) {
      footer = planFooter;
    } else {
      footer = (
        <div className="flex items-center justify-end gap-2">
          <Button tone="gray" onClick={close} className="sm:min-w-[110px]">
            Close
          </Button>
          {answer.error ? (
            <Button onClick={() => void withAi(request)} className="flex-1 sm:flex-none sm:min-w-[150px]">
              Try Again
            </Button>
          ) : (
            <Button onClick={choose} className="flex-1 sm:flex-none sm:min-w-[150px]">
              Other Ways
            </Button>
          )}
        </div>
      );
    }
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title={title}
      subtitle={request.issues.length > 1 ? `${request.subject}: ${request.issues.length} problems` : issue ? `${request.subject}: ${issue.title}` : request.subject}
      // One problem, start to finish: no Done, back link or settings in the bar; the buttons below decide
      rightAction={<span />}
      footer={footer}
      bodyRef={bodyRef}
      zIndex={66}
    >
      {body}
    </Sheet>
  );
};
