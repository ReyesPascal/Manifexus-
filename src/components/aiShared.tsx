import React from 'react';
import { ios } from './ui/ios';
import type { Explain } from './Commands';

/**
 * What the Ask Manifexus screens share: the AI status from the server (mirrors server/aiService.ts),
 * formatting, the permission levels, and the assistant's icon.
 */

export type Freedom = 'look' | 'ask' | 'routine' | 'expert';
export type Fit = 'fits' | 'tight' | 'no';

export interface CatalogEntry {
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
  /** The speed comes from real answers on this server, not a guess */
  measured?: boolean;
  installed: boolean;
}

export interface DownloadStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
  ms?: number;
  progress?: number;
  eta?: number;
}

export interface Download {
  model: string;
  status: 'queued' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled';
  completed: number;
  total: number;
  message?: string;
  steps?: DownloadStep[];
  speed?: number;
  eta?: number;
}

export const ACTIVE_DL = ['queued', 'downloading', 'verifying'];

export interface Specs {
  cpu: { model: string; cores: number; physicalCores?: number; avx2: boolean; avx512: boolean; arch: string };
  memory: { totalBytes: number; availableBytes: number; manifexusLimitBytes?: number };
  gpus: { vendor: string; name: string; vramBytes?: number }[];
  nvidiaRuntime: boolean;
  gpuUsable: boolean;
  disk: { freeBytes: number; totalBytes: number };
  os: string;
}

/** What the AI may look at (mirrors AiAccess in server/aiService.ts) */
export interface Access {
  logs: boolean;
  files: boolean;
  history: boolean;
  server: boolean;
}

export const ACCESS: { key: keyof Access; title: string; sub: string }[] = [
  { key: 'logs', title: 'App Logs', sub: 'What your apps print while they run: the first place to look when something breaks.' },
  { key: 'files', title: 'Files on Your Server', sub: 'Compose files, .env files, settings files and folder listings. Needed to fix settings in files.' },
  { key: 'history', title: 'Activity and Restore', sub: 'What changed recently, what failed, and which backups can be restored.' },
  { key: 'server', title: 'Server Details', sub: 'Processor, memory, disk space, and Docker’s networks, volumes and ports.' },
];

export interface Status {
  engine: {
    included: boolean;
    running: boolean;
    error?: string;
    version: string;
    canInstall: boolean;
    install: { status: 'idle' | 'checking' | 'downloading' | 'verifying' | 'unpacking' | 'done' | 'failed'; completed: number; total: number; message?: string };
  };
  specs: Specs;
  budgetBytes: number;
  recommended: { quick?: string; fixer?: string; note?: string; single?: boolean; reasons?: Record<string, string> };
  catalog: CatalogEntry[];
  installed: { id: string; bytes: number }[];
  downloads: Download[];
  settings: { quickModel?: string; fixerModel?: string; freedom: Freedom; auto?: boolean; access?: Access; setupAt?: string };
  /** The recommended models being set up together */
  bundle?: { models: string[]; neededBytes: number; freeBytes: number };
  ready: boolean;
  /** What setup is still doing (questions wait for it), e.g. "GPT-OSS 20B: test answer" */
  setupBusy?: string;
}

export const fmtGB = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(b >= 10e9 ? 0 : 1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
export const fmtSecs = (s: number) => (s < 90 ? `~${Math.max(5, Math.round(s / 5) * 5)} s` : `~${(s / 60).toFixed(s < 600 ? 1 : 0).replace(/\.0$/, '')} min`);
export const fmtDur = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${Math.max(0.1, ms / 1000).toFixed(1)} s` : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);

export const FREEDOM: { value: Freedom; title: string; sub: string }[] = [
  { value: 'look', title: 'Look Only', sub: 'Explains and advises. Never changes anything.' },
  { value: 'ask', title: 'Ask Before Changes', sub: 'Shows every change for you to review first.' },
  { value: 'routine', title: 'Fix Routine Things', sub: 'Starts and restarts apps on its own. Anything else still asks.' },
  { value: 'expert', title: 'Expert', sub: 'Like “Ask”, and may also propose commands to run on your server. Each is shown first.' },
];

export const fmtLeft = (s: number) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);

/** A progress bar; a negative value means "can't tell how far": a segment keeps sliding across */
export const Bar: React.FC<{ value: number }> = ({ value }) => (
  <div className="relative h-[4px] rounded-full overflow-hidden" style={{ background: 'rgba(118,118,128,0.3)' }}>
    {value < 0 ? (
      <div className="absolute inset-y-0 w-2/5 rounded-full motion-safe:animate-[ios-indeterminate_1.4s_ease-in-out_infinite]" style={{ background: ios.blue }} />
    ) : (
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(2, Math.min(100, value * 100))}%`, background: ios.blue }} />
    )}
  </div>
);

/** The sparkle mark for the assistant */
export const Spark: React.FC<{ size?: number; color?: string }> = ({ size = 18, color = '#fff' }) => (
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


export interface PlanStep {
  action: { type: string; app?: string; stack?: string; path?: string; command?: string; reason: string };
  label: string;
  diff?: string[];
  newFile?: boolean;
  undoable: boolean;
  impact?: string;
  howTo?: { command: string; note?: string; equivalent?: boolean; explain: Explain[] }[];
}

export interface Plan {
  id: string;
  title: string;
  explanation: string;
  steps: PlanStep[];
  routine: boolean;
}

/** One line of the work log: what was decided, looked up, read, thought or checked */
export interface WorkStep {
  id: string;
  label: string;
  kind: 'plan' | 'lookup' | 'model' | 'check' | 'note';
  status: 'running' | 'done' | 'failed';
  detail?: string;
  ms?: number;
}

/** What it's doing this second, with a progress bar and time left when that can be worked out */
export interface Phase {
  label: string;
  detail?: string;
  progress?: number;
  eta?: number;
  at: number;
}

/** A button the AI offered under its answer, opening one of Manifexus's own screens */
export interface AiAction {
  screen: 'move_app' | 'new_stack' | 'restore' | 'diagnostics' | 'activity' | 'updates' | 'settings' | 'app_details';
  label: string;
  app?: string;
  appId?: string;
}

/** One answer from the AI as it comes in: the work log, the live step, the answer, a plan, buttons */
export interface Answer {
  /** The answer, shown all at once when it's complete */
  text: string;
  steps: WorkStep[];
  route?: { task: string; effort: string; name: string; why: string };
  plan?: Plan;
  /** expired: from a saved chat; the server no longer holds the plan */
  planState?: 'new' | 'done' | 'self' | 'failed' | 'expired';
  streaming?: boolean;
  error?: string;
  phase?: Phase;
  started?: number;
  /** "1 min 32 s · Qwen 3.5 Small", when it's done */
  summary?: string;
  /** Work log expanded after it's done */
  showWork?: boolean;
  actions?: AiAction[];
  /** It ended by asking the person something */
  asks?: boolean;
  /** The model currently working on it */
  modelName?: string;
}

export const newAnswer = (): Answer => ({ text: '', steps: [], streaming: true, started: Date.now(), phase: { label: 'Sending your question', at: Date.now() } });

/** Fold one event from /api/ai/chat into the answer */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyAiEvent(a: Answer, ev: any): Answer {
  switch (ev.type) {
    case 'model':
      return { ...a, modelName: ev.name, route: a.route ? { ...a.route, name: ev.name } : a.route };
    case 'route':
      return { ...a, route: { task: ev.task, effort: ev.effort, name: ev.name, why: ev.why } };
    case 'step': {
      const steps = a.steps.slice();
      const at = steps.findIndex((x) => x.id === ev.id);
      const st: WorkStep = { id: ev.id, label: ev.label, kind: ev.kind, status: ev.status, detail: ev.detail, ms: ev.ms };
      if (at >= 0) steps[at] = st;
      else steps.push(st);
      return { ...a, steps };
    }
    case 'phase':
      return { ...a, phase: { label: ev.label, detail: ev.detail, progress: ev.progress, eta: ev.eta, at: Date.now() } };
    case 'answer':
      return { ...a, text: ev.text };
    case 'actions':
      return { ...a, actions: ev.actions };
    case 'done':
      return { ...a, summary: ev.summary, asks: Boolean(ev.asks) };
    case 'plan':
      return { ...a, plan: ev.plan, planState: 'new' };
    case 'error':
      return { ...a, error: ev.message };
    default:
      return a;
  }
}

/** When it's over (finished, stopped or failed): nothing left spinning */
export const settleAnswer = (a: Answer, stopped: boolean): Answer => ({
  ...a,
  streaming: false,
  steps: a.steps.map((x) => (x.status === 'running' ? { ...x, status: 'failed' as const } : x)),
  text: a.text || (stopped ? 'Stopped.' : a.text),
});

/** Ask the AI and receive its events as they happen */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function streamAiChat(body: Record<string, unknown>, onEvent: (ev: any) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
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
      if (chunk.trim()) onEvent(JSON.parse(chunk));
    }
  }
}
