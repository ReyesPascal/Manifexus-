import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackButton, Button, Checkmark, GearButton, Group, IconTile, LinkButton, Row, SectionFooter, SectionHeader, Sheet, ios } from './ui/ios';
import { ProgressView, useRun } from './ProgressTracker';

/**
 * Ask Manifexus: the built-in AI. First run sets it up (your server's specs, the models that fit,
 * one-tap download). Then it's a chat that can look at everything and propose changes, which you
 * review (with a before/after of every file) and run with the same progress tracker as moves and
 * restores. Every change is backed up first and saved in Restore.
 */

// ----------------------------------------------------------------------------
// Types (mirror server/aiService.ts and server/aiAgent.ts)
// ----------------------------------------------------------------------------

type Freedom = 'look' | 'ask' | 'routine' | 'expert';
type Fit = 'fits' | 'tight' | 'no';

interface CatalogEntry {
  id: string;
  name: string;
  role: 'quick' | 'fixer';
  blurb: string;
  downloadBytes: number;
  memoryBytes: number;
  moe?: boolean;
  fit: Fit;
  why?: string;
  seconds: number;
  installed: boolean;
}

interface Download {
  model: string;
  status: 'downloading' | 'done' | 'failed' | 'cancelled';
  completed: number;
  total: number;
  message?: string;
}

interface Specs {
  cpu: { model: string; cores: number; avx2: boolean; avx512: boolean; arch: string };
  memory: { totalBytes: number; availableBytes: number; manifexusLimitBytes?: number };
  gpus: { vendor: string; name: string; vramBytes?: number }[];
  nvidiaRuntime: boolean;
  gpuUsable: boolean;
  disk: { freeBytes: number; totalBytes: number };
  os: string;
}

interface Status {
  engine: { included: boolean; running: boolean; error?: string };
  specs: Specs;
  budgetBytes: number;
  recommended: { quick?: string; fixer?: string; note?: string };
  catalog: CatalogEntry[];
  installed: { id: string; bytes: number }[];
  downloads: Download[];
  settings: { quickModel?: string; fixerModel?: string; freedom: Freedom };
  ready: boolean;
}

interface PlanStep {
  action: { type: string; app?: string; stack?: string; path?: string; command?: string; reason: string };
  label: string;
  diff?: string[];
  newFile?: boolean;
  undoable: boolean;
  impact?: string;
}

interface Plan {
  id: string;
  title: string;
  explanation: string;
  steps: PlanStep[];
  routine: boolean;
}

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; tools: { label: string; ok?: boolean; running?: boolean }[]; plan?: Plan; planState?: 'new' | 'done' | 'failed'; streaming?: boolean; error?: string };

type View = 'chat' | 'setup' | 'models' | 'settings' | 'review' | 'progress';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const fmtGB = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(b >= 10e9 ? 0 : 1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const fmtSecs = (s: number) => (s < 60 ? `~${Math.max(5, Math.round(s / 5) * 5)} s` : `~${Math.round(s / 60)} min`);

const FREEDOM: { value: Freedom; title: string; sub: string }[] = [
  { value: 'look', title: 'Look Only', sub: 'Explains and advises. Never changes anything.' },
  { value: 'ask', title: 'Ask Before Changes', sub: 'Shows every change for you to review first.' },
  { value: 'routine', title: 'Fix Routine Things', sub: 'Starts and restarts apps on its own. Anything else still asks.' },
  { value: 'expert', title: 'Expert', sub: 'Like “Ask”, and may also propose commands to run on your server. Each is shown first.' },
];

/** The sparkle mark for the assistant */
const Spark: React.FC<{ size?: number; color?: string }> = ({ size = 18, color = '#fff' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
    <path d="M12 2.5c.4 3.9 1.9 6.4 4.4 7.6 1.3.6 2.9 1 4.6 1.2v1.4c-1.7.2-3.3.6-4.6 1.2-2.5 1.2-4 3.7-4.4 7.6h-1.2c-.4-3.9-1.9-6.4-4.4-7.6-1.3-.6-2.9-1-4.6-1.2v-1.4c1.7-.2 3.3-.6 4.6-1.2 2.5-1.2 4-3.7 4.4-7.6h1.2Z" />
  </svg>
);

export const AssistantIcon: React.FC<{ size?: number }> = ({ size = 29 }) => (
  <span
    className="flex items-center justify-center flex-shrink-0"
    style={{ width: size, height: size, borderRadius: size * 0.24, background: 'linear-gradient(135deg, #5E5CE6 0%, #BF5AF2 55%, #FF6482 100%)' }}
  >
    <Spark size={size * 0.58} />
  </span>
);

/** Plain text with **bold**, `code`, and "- " bullet lines */
const RichText: React.FC<{ text: string }> = ({ text }) => {
  const inline = (s: string, key: string | number) =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={`${key}-${i}`} className="font-semibold text-white">{part.slice(2, -2)}</strong>
      ) : part.startsWith('`') && part.endsWith('`') ? (
        <code key={`${key}-${i}`} className="font-mono text-[13px] px-1 py-px rounded" style={{ background: 'rgba(255,255,255,0.08)' }}>{part.slice(1, -1)}</code>
      ) : (
        <React.Fragment key={`${key}-${i}`}>{part}</React.Fragment>
      )
    );
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  const flush = (k: number) => {
    if (!bullets.length) return;
    blocks.push(
      <ul key={`ul${k}`} className="space-y-1 pl-1">
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-2">
            <span style={{ color: ios.tertiary }}>•</span>
            <span>{inline(b, i)}</span>
          </li>
        ))}
      </ul>
    );
    bullets = [];
  };
  text.split('\n').forEach((line, i) => {
    const m = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (m) return bullets.push(m[1]);
    flush(i);
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    if (h) blocks.push(<p key={i} className="font-semibold text-white">{inline(h[1], i)}</p>);
    else if (line.trim()) blocks.push(<p key={i}>{inline(line, i)}</p>);
  });
  flush(-1);
  return <div className="space-y-2">{blocks}</div>;
};

/** A file change as a before/after, showing only the changed parts with a little context */
const DiffView: React.FC<{ lines: string[] }> = ({ lines }) => {
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.startsWith('+ ') || l.startsWith('- ')) for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) keep.add(k);
  });
  const out: React.ReactNode[] = [];
  let gap = false;
  lines.forEach((l, i) => {
    if (!keep.has(i)) {
      if (!gap && out.length) out.push(<div key={`g${i}`} className="px-3 py-0.5" style={{ color: ios.tertiary }}>⋯</div>);
      gap = true;
      return;
    }
    gap = false;
    const add = l.startsWith('+ ');
    const del = l.startsWith('- ');
    out.push(
      <div
        key={i}
        className="px-3 whitespace-pre-wrap break-all"
        style={{ background: add ? 'rgba(48,209,88,0.13)' : del ? 'rgba(255,69,58,0.14)' : undefined, color: add ? '#7EE39A' : del ? '#FF8A80' : 'rgba(235,235,245,0.65)' }}
      >
        <span className="select-none inline-block w-3 opacity-70">{add ? '+' : del ? '−' : ' '}</span>
        {l.slice(2) || ' '}
      </div>
    );
  });
  return (
    <div className="rounded-[10px] py-2 font-mono text-[12px] leading-[18px] overflow-hidden" style={{ background: 'rgba(0,0,0,0.35)' }}>
      {out}
    </div>
  );
};

const stepIcon = (t: string) =>
  t === 'write_file' ? 'M8 3.5h6l4.5 4.5v11A1.5 1.5 0 0 1 17 20.5H8A1.5 1.5 0 0 1 6.5 19V5A1.5 1.5 0 0 1 8 3.5ZM14 3.5V8h4.5M10 13l4 4M14 13l-4 4'
  : t === 'run_command' ? 'M4 6l5 5-5 5M11 17h9'
  : t === 'remove_container' ? 'M5 7h14M10 11v6M14 11v6M6 7l1 12a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 19l1-12M9 7V4.5h6V7'
  : t === 'stop' ? 'M7 7h10v10H7z'
  : 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4.5h-4.5';

const StepTile: React.FC<{ type: string }> = ({ type }) => (
  <IconTile color={type === 'run_command' ? '#FF9F0A' : type === 'remove_container' ? ios.red : type === 'write_file' ? '#0A84FF' : '#30D158'}>
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={stepIcon(type)} />
    </svg>
  </IconTile>
);

const Bar: React.FC<{ value: number }> = ({ value }) => (
  <div className="h-[4px] rounded-full overflow-hidden" style={{ background: 'rgba(118,118,128,0.3)' }}>
    <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(2, Math.min(100, value * 100))}%`, background: ios.blue }} />
  </div>
);

// ----------------------------------------------------------------------------
// Sheet
// ----------------------------------------------------------------------------

export const AssistantSheet: React.FC<{
  open: boolean;
  onClose: () => void;
  /** Start straight on the setup / settings screens */
  initialView?: 'setup' | 'settings';
  /** Ask this right away (e.g. "Fix: kavita is listed in two stacks …") */
  initialQuestion?: string;
  /** Extra context for the AI about what the person is looking at */
  focus?: string;
  backLabel?: string;
  onBack?: () => void;
}> = ({ open, onClose, initialView, initialQuestion, focus, backLabel, onBack }) => {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [stack, setStack] = useState<View[]>(['chat']);
  const view = stack[stack.length - 1];
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [modelName, setModelName] = useState<string>();
  const [reviewPlan, setReviewPlan] = useState<Plan | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const asked = useRef<string | undefined>(undefined);
  const run = useRun();

  const push = (v: View) => {
    setStack((s) => [...s, v]);
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: 0 }));
  };
  const pop = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  const scrollDown = () => requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' }));

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/ai/status', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setStatus(j);
      setLoadError(undefined);
      return j as Status;
    } catch (e) {
      setLoadError((e as Error).message || 'Couldn’t reach Manifexus.');
      return null;
    }
  }, []);

  // Open: set up first if no model is installed yet
  useEffect(() => {
    if (!open) return;
    asked.current = undefined;
    setReviewPlan(null);
    run.reset();
    load().then((s) => {
      if (initialView) setStack(s?.ready || initialView === 'settings' ? ['chat', initialView] : ['setup']);
      else setStack(s?.ready ? ['chat'] : ['setup']);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep download progress fresh while anything is downloading
  const downloading = status?.downloads.some((d) => d.status === 'downloading');
  useEffect(() => {
    if (!open || !downloading) return;
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [open, downloading, load]);

  // A download finished: the chat becomes available
  const prevReady = useRef(false);
  useEffect(() => {
    if (status?.ready && !prevReady.current && view === 'setup' && !downloading) setStack(['chat']);
    prevReady.current = Boolean(status?.ready);
  }, [status?.ready, view, downloading]);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      const history = items
        .filter((i) => (i.kind === 'user' || (i.kind === 'assistant' && i.text)))
        .map((i) => ({ role: i.kind === 'user' ? 'user' : 'assistant', content: i.kind === 'user' ? i.text : i.text }));
      setItems((list) => [...list, { kind: 'user', text: q }, { kind: 'assistant', text: '', tools: [], streaming: true }]);
      setDraft('');
      setBusy(true);
      scrollDown();
      const ac = new AbortController();
      abort.current = ac;
      const patch = (fn: (a: Extract<Item, { kind: 'assistant' }>) => Extract<Item, { kind: 'assistant' }>) =>
        setItems((list) => {
          const copy = list.slice();
          const last = copy[copy.length - 1];
          if (last?.kind === 'assistant') copy[copy.length - 1] = fn(last);
          return copy;
        });
      try {
        const res = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [...history, { role: 'user', content: q }], focus }),
          signal: ac.signal,
        });
        if (!res.body) throw new Error('No answer.');
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i).replace(/^data: /, '');
            buf = buf.slice(i + 2);
            if (!chunk.trim()) continue;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ev: any = JSON.parse(chunk);
            if (ev.type === 'model') setModelName(ev.name);
            else if (ev.type === 'text') patch((a) => ({ ...a, text: a.text + ev.delta }));
            else if (ev.type === 'tool')
              patch((a) => {
                const tools = a.tools.slice();
                const runningIdx = tools.findIndex((t) => t.running);
                if (ev.running) tools.push({ label: ev.label, running: true });
                else if (runningIdx >= 0) tools[runningIdx] = { label: ev.label, ok: ev.ok };
                else tools.push({ label: ev.label, ok: ev.ok });
                return { ...a, tools };
              });
            else if (ev.type === 'plan') patch((a) => ({ ...a, plan: ev.plan, planState: 'new' }));
            else if (ev.type === 'error') patch((a) => ({ ...a, error: ev.message }));
            scrollDown();
          }
        }
      } catch (e) {
        if (!ac.signal.aborted) patch((a) => ({ ...a, error: (e as Error).message || 'Something went wrong.' }));
      } finally {
        patch((a) => ({ ...a, streaming: false, text: a.text || (ac.signal.aborted ? 'Stopped.' : a.text) }));
        setBusy(false);
        abort.current = null;
        requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
      }
    },
    [busy, items, focus]
  );

  // Ask the question we were opened with, once the AI is ready
  useEffect(() => {
    if (!open || !initialQuestion || !status?.ready || view !== 'chat' || asked.current === initialQuestion) return;
    asked.current = initialQuestion;
    setItems([]);
    setTimeout(() => send(initialQuestion), 0);
  }, [open, initialQuestion, status?.ready, view, send]);

  const setting = async (patch: Record<string, unknown>) => {
    await fetch('/api/ai/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    load();
  };
  const install = async (model: string, role?: 'quick' | 'fixer' | 'both') => {
    await fetch('/api/ai/models/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, role }) });
    load();
  };
  const cancelDl = async (model: string) => {
    await fetch('/api/ai/models/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    setTimeout(load, 400);
  };
  const remove = async (model: string) => {
    await fetch('/api/ai/models/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    load();
  };

  const startPlan = (plan: Plan) => {
    setReviewPlan(plan);
    push('progress');
    void run.start(`/api/ai/plans/${encodeURIComponent(plan.id)}/run`, {});
  };

  // Routine level: start/restart-only plans run by themselves
  useEffect(() => {
    const last = items[items.length - 1];
    if (status?.settings.freedom !== 'routine' || last?.kind !== 'assistant' || last.streaming || !last.plan?.routine || last.planState !== 'new') return;
    setItems((list) => list.map((it) => (it === last ? { ...last, planState: 'done' } : it)));
    startPlan(last.plan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, status?.settings.freedom]);

  const byId = useMemo(() => new Map((status?.catalog || []).map((m) => [m.id, m])), [status]);
  const dl = (id: string) => status?.downloads.find((d) => d.model === id && d.status === 'downloading');
  const failedDl = (id: string) => status?.downloads.find((d) => d.model === id && d.status === 'failed');

  // ---------------------------------------------------------------- views
  let title = 'Ask Manifexus';
  let body: React.ReactNode = null;
  let footer: React.ReactNode = null;

  if (!status) {
    body = <p className="text-[15px] text-center py-20" style={{ color: loadError ? ios.orange : ios.secondary }}>{loadError || 'Loading…'}</p>;
  } else if (view === 'setup' || view === 'models') {
    const s = status.specs;
    const rq = status.recommended.quick ? byId.get(status.recommended.quick) : undefined;
    const rf = status.recommended.fixer && status.recommended.fixer !== status.recommended.quick ? byId.get(status.recommended.fixer) : undefined;
    const rec = [rq && { m: rq, role: 'quick' as const, label: 'Quick Helper', sub: 'Explains errors and logs' }, rf && { m: rf, role: 'fixer' as const, label: 'Fixer', sub: 'Finds causes and plans fixes' }].filter(Boolean) as {
      m: CatalogEntry;
      role: 'quick' | 'fixer';
      label: string;
      sub: string;
    }[];
    const toGet = rec.filter((r) => !r.m.installed && !dl(r.m.id));
    const total = toGet.reduce((n, r) => n + r.m.downloadBytes, 0);
    const graphics = s.gpus.length ? s.gpus.map((g) => g.name).join(', ') : 'None';
    title = view === 'models' ? 'All Models' : 'Built-in AI';

    const modelRow = (m: CatalogEntry, extra?: { label: string; sub: string }) => {
      const d = dl(m.id);
      const failed = !d && !m.installed ? failedDl(m.id) : undefined;
      return (
        <Row
          key={m.id + (extra?.label || '')}
          leading={<AssistantIcon size={32} />}
          title={
            <span className="flex items-center gap-2">
              {extra ? <span>{extra.label}</span> : <span>{m.name}</span>}
              {m.moe && !extra && (
                <span className="text-[11px] font-medium px-1.5 py-px rounded" style={{ background: 'rgba(191,90,242,0.18)', color: '#D69CFA' }}>
                  Efficient
                </span>
              )}
            </span>
          }
          subtitle={
            d ? (
              <span className="block pt-1 pr-2 space-y-1.5">
                <Bar value={d.total ? d.completed / d.total : 0} />
                <span className="block tabular-nums">
                  {d.total ? `${fmtGB(d.completed)} of ${fmtGB(d.total)}` : d.message || 'Starting…'}
                </span>
              </span>
            ) : failed ? (
              <span className="block" style={{ color: ios.orange }}>
                {failed.message || 'The download didn’t finish.'}
              </span>
            ) : (
              <span className="block">
                {extra ? `${m.name} · ${extra.sub}` : m.blurb}
                <span className="block mt-0.5 tabular-nums" style={{ color: m.fit === 'no' ? ios.red : m.fit === 'tight' ? ios.orange : ios.tertiary }}>
                  {fmtGB(m.downloadBytes)} · answers in {fmtSecs(m.seconds)}
                  {m.why ? ` · ${m.why}` : ''}
                </span>
              </span>
            )
          }
          trailing={
            d ? (
              <LinkButton onClick={() => cancelDl(m.id)}>Cancel</LinkButton>
            ) : m.installed ? (
              <span className="inline-flex items-center gap-1.5 text-[13px]" style={{ color: ios.green }}>
                <Checkmark /> Ready
              </span>
            ) : (
              <button
                type="button"
                disabled={m.fit === 'no'}
                onClick={() => install(m.id, extra ? (extra.label === 'Fixer' ? 'fixer' : 'quick') : undefined)}
                className="h-[28px] px-3.5 rounded-full text-[14px] font-semibold disabled:opacity-35"
                style={{ background: 'rgba(10,132,255,0.18)', color: ios.blue }}
              >
                {failed ? 'Try Again' : 'Get'}
              </button>
            )
          }
        />
      );
    };

    body = (
      <div className="space-y-7">
        {view === 'setup' && (
          <div className="flex flex-col items-center text-center pt-1">
            <AssistantIcon size={64} />
            <h3 className="mt-4 text-[22px] leading-[27px] font-semibold text-white">Ask Manifexus</h3>
            <p className="mt-1.5 text-[14px] leading-[20px] max-w-[440px]" style={{ color: ios.secondary }}>
              An assistant that can look at your apps, logs and files, and fix things with your OK. It runs on your server: free, private, nothing leaves your network.
            </p>
          </div>
        )}

        {!status.engine.included && (
          <Group>
            <Row leading={<IconTile color={ios.orange}><span className="text-white font-bold">!</span></IconTile>} title="Update Manifexus to use the built-in AI" subtitle="This version doesn’t include the AI engine yet." />
          </Group>
        )}

        {view === 'setup' && (
          <section>
            <SectionHeader>Your Server</SectionHeader>
            <Group>
              <Row title="Processor" trailing={<span className="text-[14px] truncate max-w-[60vw] sm:max-w-[420px]">{s.cpu.model.replace(/\(R\)|\(TM\)|CPU|Processor/g, '').replace(/\s+/g, ' ').trim()} · {s.cpu.cores} cores</span>} />
              <Row title="Memory" trailing={<span className="text-[14px] tabular-nums">{fmtGB(s.memory.availableBytes)} free of {fmtGB(s.memory.totalBytes)}</span>} />
              <Row title="Graphics" trailing={<span className="text-[14px]">{graphics}</span>} />
              <Row title="Disk" trailing={<span className="text-[14px] tabular-nums">{fmtGB(s.disk.freeBytes)} free</span>} />
            </Group>
            <SectionFooter>
              {s.gpus.some((g) => g.vendor === 'nvidia') && !s.gpuUsable
                ? 'Your graphics card isn’t shared with Manifexus yet, so the AI runs on the processor.'
                : s.gpuUsable
                  ? 'The AI can use your graphics card, so it answers quickly.'
                  : 'The AI runs on the processor. The AI keeps up to ' + fmtGB(status.budgetBytes) + ' of memory for itself, so your apps never run short.'}
            </SectionFooter>
          </section>
        )}

        {view === 'setup' && (
          <section>
            <SectionHeader>Recommended for Your Server</SectionHeader>
            <Group className="ios-inset-icon">{rec.length ? rec.map((r) => modelRow(r.m, { label: r.label, sub: r.sub })) : <Row title={status.recommended.note || 'Nothing fits right now.'} />}</Group>
            <SectionFooter>
              {status.recommended.note ||
                'Picked to fit your memory and processor. Each is downloaded once and kept in Manifexus’s data folder. Only one runs at a time, and it lets go of the memory a few minutes after you’re done.'}
            </SectionFooter>
          </section>
        )}

        {view === 'models' && (
          <>
            {(['quick', 'fixer'] as const).map((role) => (
              <section key={role}>
                <SectionHeader>{role === 'quick' ? 'Quick Helpers' : 'Fixers'}</SectionHeader>
                <Group className="ios-inset-icon">{status.catalog.filter((m) => m.role === role).map((m) => modelRow(m))}</Group>
              </section>
            ))}
            <SectionFooter>“Efficient” models are large but only use part of themselves per word, so they’re quick without a graphics card.</SectionFooter>
          </>
        )}

        {view === 'setup' && (
          <Group>
            <Row onClick={() => push('models')} title="All Models" subtitle="Smaller or smarter options, and what fits" chevron />
          </Group>
        )}
      </div>
    );
    if (view === 'setup' && toGet.length && status.engine.included) {
      footer = (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px]" style={{ color: ios.secondary }}>
            {fmtGB(total)} download
          </span>
          <Button onClick={() => toGet.forEach((r) => install(r.m.id, rec.length === 1 ? 'both' : r.role))} className="sm:min-w-[200px]">
            Download {toGet.length === 1 ? '' : 'Both'}
          </Button>
        </div>
      );
    } else if (view === 'setup' && status.ready && !downloading) {
      footer = (
        <div className="flex justify-end">
          <Button onClick={() => setStack(['chat'])} className="sm:min-w-[200px]">
            Start Asking
          </Button>
        </div>
      );
    }
  } else if (view === 'settings') {
    title = 'AI Settings';
    const installed = status.installed.map((i) => byId.get(i.id)).filter(Boolean) as CatalogEntry[];
    body = (
      <div className="space-y-7">
        <section>
          <SectionHeader>What It May Do</SectionHeader>
          <Group>
            {FREEDOM.map((f) => (
              <Row
                key={f.value}
                role="radio"
                ariaChecked={status.settings.freedom === f.value}
                onClick={() => setting({ freedom: f.value })}
                title={f.title}
                subtitle={f.sub}
                trailing={<span className="w-[15px] flex justify-center">{status.settings.freedom === f.value && <Checkmark />}</span>}
              />
            ))}
          </Group>
          <SectionFooter>Every change is backed up first and saved in Restore, except commands, which can’t be undone.</SectionFooter>
        </section>
        {(['quick', 'fixer'] as const).map((role) => {
          const current = role === 'quick' ? status.settings.quickModel : status.settings.fixerModel;
          return (
            <section key={role}>
              <SectionHeader>{role === 'quick' ? 'Quick Helper' : 'Fixer'}</SectionHeader>
              <Group>
                {installed.length === 0 && <Row title={<span style={{ color: ios.secondary }}>No models downloaded</span>} />}
                {installed.map((m) => (
                  <Row
                    key={m.id}
                    role="radio"
                    ariaChecked={current === m.id}
                    onClick={() => setting(role === 'quick' ? { quickModel: m.id } : { fixerModel: m.id })}
                    title={m.name}
                    subtitle={`${fmtGB(m.downloadBytes)} · answers in ${fmtSecs(m.seconds)}`}
                    trailing={<span className="w-[15px] flex justify-center">{current === m.id && <Checkmark />}</span>}
                  />
                ))}
              </Group>
            </section>
          );
        })}
        <section>
          <Group>
            <Row onClick={() => push('models')} title="Get More Models" chevron />
          </Group>
        </section>
        {installed.length > 0 && (
          <section>
            <SectionHeader>Downloaded</SectionHeader>
            <Group>
              {installed.map((m) => (
                <Row key={m.id} title={m.name} subtitle={fmtGB(m.downloadBytes)} trailing={<LinkButton tone="red" onClick={() => remove(m.id)}>Remove</LinkButton>} />
              ))}
            </Group>
            <SectionFooter>Removing a model frees its disk space. You can download it again anytime.</SectionFooter>
          </section>
        )}
      </div>
    );
  } else if (view === 'review' && reviewPlan) {
    title = 'Review Changes';
    const risky = reviewPlan.steps.some((s) => !s.undoable);
    const impacts = Array.from(new Set(reviewPlan.steps.map((s) => s.impact).filter(Boolean)));
    body = (
      <div className="space-y-7">
        <div className="flex flex-col items-center text-center pt-1">
          <AssistantIcon size={52} />
          <h3 className="mt-3.5 text-[20px] leading-[25px] font-semibold text-white px-4">{reviewPlan.title}</h3>
          <div className="mt-2 text-[14px] leading-[21px] max-w-[520px] text-left" style={{ color: ios.secondary }}>
            <RichText text={reviewPlan.explanation} />
          </div>
        </div>
        <section>
          <SectionHeader>What Will Happen</SectionHeader>
          <div className="space-y-3">
            {reviewPlan.steps.map((s, i) => (
              <Group key={i} className="ios-inset-icon">
                <Row leading={<StepTile type={s.action.type} />} title={<span className="whitespace-normal">{s.label}</span>} subtitle={s.action.reason} />
                {s.diff && (
                  <div className="px-3 pb-3">
                    <DiffView lines={s.diff} />
                  </div>
                )}
              </Group>
            ))}
          </div>
        </section>
        <Group>
          <Row
            leading={<IconTile color={risky ? ios.orange : ios.green}><span className="text-white text-[15px] font-bold">{risky ? '!' : '✓'}</span></IconTile>}
            title={risky ? 'Some steps can’t be undone' : 'Can be undone'}
            subtitle={
              (risky ? 'Commands run directly on your server. Everything else is backed up and saved in Restore.' : 'A backup is saved first. You can undo this anytime from Restore.') +
              (impacts.length ? ` ${impacts.join('. ')}.` : '')
            }
          />
        </Group>
      </div>
    );
    footer = (
      <div className="flex justify-end gap-2">
        <Button tone="gray" onClick={pop} className="sm:min-w-[110px]">
          Cancel
        </Button>
        <Button
          onClick={() => {
            setItems((list) => list.map((it) => (it.kind === 'assistant' && it.plan?.id === reviewPlan.id ? { ...it, planState: 'done' } : it)));
            startPlan(reviewPlan);
          }}
          className="flex-1 sm:flex-none sm:min-w-[170px]"
        >
          Make Changes
        </Button>
      </div>
    );
  } else if (view === 'progress' && reviewPlan) {
    title = run.state.status === 'done' ? 'Done' : 'Making Changes';
    body = (
      <ProgressView
        run={run.state}
        runningTitle={reviewPlan.title}
        doneMessage="All done. It’s saved in Restore, so you can undo it anytime."
        onDone={() => {
          setItems((list) => [...list, { kind: 'assistant', text: `Done: **${reviewPlan.title}**. It’s saved in Restore if you want to undo it.`, tools: [] }]);
          setStack(['chat']);
          scrollDown();
        }}
        onClose={() => {
          setItems((list) => [...list, { kind: 'assistant', text: 'That didn’t finish. What changed before the problem is saved in Restore. Want me to look at what went wrong?', tools: [] }]);
          setStack(['chat']);
          scrollDown();
        }}
      />
    );
  } else {
    // ---------------------------------------------------------------- chat
    const suggestions = ['Is anything wrong right now?', 'Why did my last change fail?', 'Which app is using the most memory?', 'What changed in the last day?'];
    body =
      items.length === 0 ? (
        <div className="flex flex-col items-center text-center pt-6">
          <AssistantIcon size={64} />
          <h3 className="mt-4 text-[22px] font-semibold text-white">How can I help?</h3>
          <p className="mt-1.5 text-[14px] leading-[20px] max-w-[420px]" style={{ color: ios.secondary }}>
            I can look at your apps, logs and files, explain what’s going on, and fix things after you approve.
          </p>
          <Group className="mt-7 w-full max-w-[460px] text-left">
            {suggestions.map((q) => (
              <Row key={q} onClick={() => send(q)} title={q} chevron />
            ))}
          </Group>
        </div>
      ) : (
        <div className="space-y-5 pb-2">
          {items.map((it, i) =>
            it.kind === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] px-3.5 py-2 rounded-[18px] rounded-br-[6px] text-[15px] leading-[21px] text-white whitespace-pre-wrap" style={{ background: ios.blue }}>
                  {it.text}
                </div>
              </div>
            ) : (
              <div key={i} className="flex gap-3">
                <AssistantIcon size={26} />
                <div className="flex-1 min-w-0 space-y-2.5 text-[15px] leading-[22px]" style={{ color: 'rgba(235,235,245,0.88)' }}>
                  {it.tools.length > 0 && (
                    <ul className="space-y-1">
                      {it.tools.map((t, k) => (
                        <li key={k} className="flex items-center gap-2 text-[13px]" style={{ color: ios.secondary }}>
                          {t.running ? (
                            <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin motion-reduce:animate-none" />
                          ) : (
                            <span style={{ color: t.ok === false ? ios.orange : ios.green }}>{t.ok === false ? '!' : '✓'}</span>
                          )}
                          {t.label}
                        </li>
                      ))}
                    </ul>
                  )}
                  {it.text ? <RichText text={it.text} /> : it.streaming && !it.tools.some((t) => t.running) ? (
                    <span className="inline-flex gap-1 py-2" aria-label="Thinking">
                      {[0, 1, 2].map((d) => (
                        <span key={d} className="w-1.5 h-1.5 rounded-full motion-safe:animate-pulse" style={{ background: ios.secondary, animationDelay: `${d * 180}ms` }} />
                      ))}
                    </span>
                  ) : null}
                  {it.plan && (
                    <div className="rounded-[14px] overflow-hidden mt-1" style={{ background: ios.group, boxShadow: '0 0 0 0.5px rgba(255,255,255,0.08)' }}>
                      <div className="px-4 pt-3 pb-2.5">
                        <div className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: '#D69CFA' }}>
                          Proposed Changes
                        </div>
                        <div className="mt-1 text-[16px] font-semibold text-white">{it.plan.title}</div>
                        <ul className="mt-2 space-y-1 text-[14px]" style={{ color: ios.secondary }}>
                          {it.plan.steps.map((s, k) => (
                            <li key={k} className="flex gap-2">
                              <span style={{ color: ios.tertiary }}>{k + 1}.</span>
                              <span>{s.label}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="flex items-center justify-between px-4 py-2.5" style={{ borderTop: `0.5px solid ${ios.separator}` }}>
                        <span className="text-[13px]" style={{ color: it.planState === 'done' ? ios.green : ios.tertiary }}>
                          {it.planState === 'done' ? 'Started' : status.settings.freedom === 'look' ? 'Look-only mode: nothing will change' : 'Nothing changes until you review it'}
                        </span>
                        {it.planState === 'new' && status.settings.freedom !== 'look' && (
                          <Button
                            onClick={() => {
                              setReviewPlan(it.plan!);
                              push('review');
                            }}
                            className="!h-[32px] !px-4 !text-[14px]"
                          >
                            Review
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                  {it.error && (
                    <p className="text-[14px]" style={{ color: ios.orange }}>
                      {it.error}
                    </p>
                  )}
                </div>
              </div>
            )
          )}
        </div>
      );
    footer = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
        className="flex items-end gap-2"
      >
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
          }}
          rows={1}
          placeholder={status.ready ? 'Ask about your apps, or what to fix…' : 'Set up the built-in AI first'}
          disabled={!status.ready}
          aria-label="Ask Manifexus"
          className="flex-1 min-h-[38px] max-h-[140px] resize-none rounded-[19px] px-4 py-[8px] text-[15px] leading-[21px] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF] placeholder:text-[rgba(235,235,245,0.4)] disabled:opacity-50"
          style={{ background: ios.fill, fieldSizing: 'content' } as React.CSSProperties}
        />
        {busy ? (
          <button type="button" onClick={() => abort.current?.abort()} aria-label="Stop" className="w-[38px] h-[38px] rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(118,118,128,0.4)' }}>
            <span className="w-3 h-3 rounded-[3px] bg-white" />
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim() || !status.ready} aria-label="Send" className="w-[38px] h-[38px] rounded-full flex items-center justify-center flex-shrink-0 disabled:opacity-35" style={{ background: ios.blue }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
            </svg>
          </button>
        )}
      </form>
    );
  }

  // ---------------------------------------------------------------- navigation
  const gear = <GearButton label="AI settings" onClick={() => push(status?.ready ? 'settings' : 'setup')} />;
  const prev = stack[stack.length - 2];
  const backText = prev === 'chat' ? 'Ask' : prev === 'setup' ? 'Built-in AI' : prev === 'settings' ? 'Settings' : 'Back';
  const leftAction =
    view === 'progress' ? undefined : stack.length > 1 ? <BackButton label={backText} onClick={pop} /> : backLabel && onBack ? <BackButton label={backLabel} onClick={onBack} /> : view === 'chat' ? gear : undefined;
  const rightExtra =
    view === 'chat' && stack.length === 1 ? (
      <span className="flex items-center gap-4">
        {backLabel && onBack && gear}
        {items.length > 0 && !busy && (
          <button type="button" onClick={() => setItems([])} aria-label="New conversation" title="New conversation" className="p-1 -m-1 rounded hover:opacity-80" style={{ color: ios.blue }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        )}
      </span>
    ) : undefined;

  return (
    <Sheet
      open={open}
      onClose={() => {
        abort.current?.abort();
        onClose();
      }}
      title={title}
      subtitle={view === 'chat' && modelName ? `${modelName} · on your server` : undefined}
      leftAction={leftAction}
      rightExtra={rightExtra}
      footer={footer}
      bodyRef={bodyRef}
      zIndex={65}
    >
      <div key={view} className={stack.length > 1 ? 'motion-safe:animate-[ios-push-in_200ms_ease-out]' : ''}>
        {body}
      </div>
    </Sheet>
  );
};
