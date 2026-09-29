import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Group, IconTile, LinkButton, Row, SectionFooter, SectionHeader, Sheet, ios } from './ui/ios';
import { ProgressView, useRun } from './ProgressTracker';
import { CommandBlock } from './Commands';
import { Markdown } from './Markdown';
import { AiAction, Answer, AssistantIcon, Status, applyAiEvent, newAnswer, settleAnswer, streamAiChat } from './aiShared';
import { DiffView, RouteChips, StepTile, WorkLog } from './AssistantSheet';

/**
 * Fix with AI: its own screen, not a chat. It shows the problem, works on it with every step visible,
 * then the change it proposes (every file as a before/after) with Make Changes, Do It Myself or Not
 * Now. Making the change uses the same backup-first progress as moves and restores, and afterwards
 * the checks run again to confirm the problem is gone. Nothing to type, no settings, no new chats:
 * one problem, start to finish.
 */

export interface FixRequest {
  /** What to ask (e.g. "Please fix this: New stacks folder setting is broken") */
  question: string;
  /** The issues as Diagnostics reports them, for the AI */
  focus: string;
  issues: { title: string; detail?: string; level?: string }[];
  /** Where to run the checks again afterwards */
  recheckUrl: string;
  /** What the problem belongs to, e.g. "Manifexus" or "kavita" */
  subject: string;
}

type Stage = 'starting' | 'working' | 'result' | 'applying' | 'done' | 'failed';

export const FixSheet: React.FC<{
  request: FixRequest | null;
  onClose: () => void;
  /** The AI isn't set up yet: go through setup first */
  onNeedsSetup: (r: FixRequest) => void;
  /** A button it offered (e.g. open Move for an app) */
  onAction: (a: AiAction) => void;
  /** It needs an answer from the person (or they have a follow-up): carry on in Ask with this conversation */
  onContinueInAsk: (question: string, answer: string, focus: string) => void;
}> = ({ request, onClose, onNeedsSetup, onAction, onContinueInAsk }) => {
  const open = Boolean(request);
  const [stage, setStage] = useState<Stage>('starting');
  const [answer, setAnswer] = useState<Answer>(newAnswer());
  const [status, setStatus] = useState<Status | null>(null);
  const [byHand, setByHand] = useState(false);
  const [recheck, setRecheck] = useState<'checking' | 'gone' | 'still' | 'unknown'>();
  const abort = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const run = useRun();

  const start = useCallback(async (r: FixRequest) => {
    abort.current?.abort();
    setStage('starting');
    setAnswer(newAnswer());
    setByHand(false);
    setRecheck(undefined);
    run.reset();
    let s: Status | null = null;
    try {
      s = await (await fetch('/api/ai/status', { cache: 'no-store' })).json();
    } catch {
      // handled below
    }
    setStatus(s);
    if (!s?.ready) return onNeedsSetup(r);
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

  useEffect(() => {
    if (request) void start(request);
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const close = () => {
    abort.current?.abort();
    onClose();
  };

  const makeChanges = () => {
    if (!answer.plan) return;
    setStage('applying');
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: 0 }));
    void run.start(`/api/ai/plans/${encodeURIComponent(answer.plan.id)}/run`, {});
  };

  // Changes made: run the checks again and see whether the problem is still reported
  const verify = useCallback(async () => {
    if (!request) return;
    setRecheck('checking');
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const j = await (await fetch(request.recheckUrl, { cache: 'no-store' })).json();
      const checks: { title: string; level: string }[] = j.checks || [];
      const still = request.issues.some((i) => checks.some((c) => c.title === i.title && (c.level === 'warn' || c.level === 'error')));
      setRecheck(still ? 'still' : 'gone');
    } catch {
      setRecheck('unknown');
    }
  }, [request]);

  if (!request) return null;
  const plan = answer.plan;
  const look = status?.settings.freedom === 'look';
  const issue = request.issues[0];

  // ------------------------------------------------------------ the problem, always on top
  const problem = (
    <Group className="ios-inset-icon">
      {request.issues.map((i, k) => (
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
  let title = 'Fix with AI';

  if (stage === 'applying' || stage === 'done' || stage === 'failed') {
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
        {stage === 'done' && (
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
                    ? `Diagnostics no longer reports ${request.issues.length > 1 ? 'these problems' : 'this problem'}`
                    : recheck === 'still'
                      ? `Diagnostics still reports ${request.issues.length > 1 ? 'some of these problems' : 'this problem'}`
                      : 'Couldn’t check again'
              }
              subtitle={
                recheck === 'still'
                  ? 'The change was made, but the check still fails. It may need a restart, or a different fix.'
                  : recheck === 'gone'
                    ? `${request.subject} checks out.`
                    : undefined
              }
            />
          </Group>
        )}
      </div>
    );
    footer =
      stage === 'applying' ? null : (
        <div className="flex items-center justify-end gap-2">
          {stage === 'done' && recheck === 'still' && (
            <Button tone="gray" onClick={() => void start(request)} className="sm:min-w-[150px]">
              Try Again
            </Button>
          )}
          <Button onClick={close} className="flex-1 sm:flex-none sm:min-w-[150px]">
            Close
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
        {!working && plan && (
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
        )}
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
      footer = (
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
    } else {
      footer = (
        <div className="flex items-center justify-end gap-2">
          <Button tone="gray" onClick={close} className="sm:min-w-[110px]">
            Close
          </Button>
          {answer.error ? (
            <Button onClick={() => void start(request)} className="flex-1 sm:flex-none sm:min-w-[150px]">
              Try Again
            </Button>
          ) : (
            <Button onClick={() => onContinueInAsk(request.question, answer.text, request.focus)} className="flex-1 sm:flex-none sm:min-w-[170px]">
              {answer.asks ? 'Answer in Ask' : 'Ask a Follow-Up'}
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
