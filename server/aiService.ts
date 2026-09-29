/**
 * The built-in AI: an Ollama engine that ships inside the Manifexus image and runs in the
 * background, models downloaded on demand into the data folder, and a catalog that recommends
 * models from the server's own specs. Two roles: a quick helper for explanations and summaries,
 * and a fixer for looking into problems and planning changes.
 */
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { getSystemSpecs, SystemSpecs } from './systemSpecs';
import { record } from './activityLog';

const DATA_DIR = process.env.DATA_DIR && fs.existsSync(process.env.DATA_DIR) ? process.env.DATA_DIR : fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data');
export const AI_DIR = path.join(DATA_DIR, 'ai');
const SETTINGS_FILE = path.join(AI_DIR, 'settings.json');
const MODELS_DIR = path.join(AI_DIR, 'models');
const PORT = 11434;

/** Set OLLAMA_URL to use an Ollama that's already running elsewhere (also how tests plug in a stand-in) */
const EXTERNAL = process.env.OLLAMA_URL?.replace(/\/+$/, '');
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;

// ----------------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------------

/**
 * How much the assistant may do on its own:
 * look = explain and advise only; ask = show a plan and wait for Continue (default);
 * routine = restarts and starts happen by themselves, anything else still asks;
 * expert = like ask, plus it may propose raw commands on the server (each one shown and approved).
 */
export type Freedom = 'look' | 'ask' | 'routine' | 'expert';

export interface AiSettings {
  quickModel?: string;
  fixerModel?: string;
  freedom: Freedom;
}

export function getAiSettings(): AiSettings {
  try {
    return { freedom: 'ask', ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { freedom: 'ask' };
  }
}

export function saveAiSettings(patch: Partial<AiSettings>): AiSettings {
  const next = { ...getAiSettings(), ...patch };
  if (!['look', 'ask', 'routine', 'expert'].includes(next.freedom)) next.freedom = 'ask';
  fs.mkdirSync(AI_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

// ----------------------------------------------------------------------------
// Catalog
// ----------------------------------------------------------------------------

export interface CatalogModel {
  id: string; // as used by `ollama pull`
  name: string;
  role: 'quick' | 'fixer';
  blurb: string;
  downloadBytes: number;
  /** Memory while it's thinking (model + working space) */
  memoryBytes: number;
  /** Size of the part that runs for each word: what decides speed on a CPU */
  activeBytes: number;
  /** Mixture-of-experts: big-model smarts, small-model speed */
  moe?: boolean;
  /** How the engine should run it (reasoning off or low keeps CPU answers quick) */
  think: boolean | 'low';
}

const GB = 1e9;
export const CATALOG: CatalogModel[] = [
  { id: 'qwen3.5:2b', name: 'Qwen 3.5 Mini', role: 'quick', blurb: 'For small servers. Explains errors and summarizes logs.', downloadBytes: 2.7 * GB, memoryBytes: 3.6 * GB, activeBytes: 2.7 * GB, think: false },
  { id: 'qwen3.5:4b', name: 'Qwen 3.5 Small', role: 'quick', blurb: 'Quick, clear explanations of errors and logs.', downloadBytes: 3.4 * GB, memoryBytes: 4.6 * GB, activeBytes: 3.4 * GB, think: false },
  { id: 'qwen3.5:9b', name: 'Qwen 3.5', role: 'fixer', blurb: 'Solid at finding causes and planning fixes.', downloadBytes: 6.6 * GB, memoryBytes: 8.5 * GB, activeBytes: 6.6 * GB, think: false },
  { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', role: 'fixer', blurb: 'Strong reasoning and tool use; fast for its size.', downloadBytes: 14 * GB, memoryBytes: 16 * GB, activeBytes: 2.4 * GB, moe: true, think: 'low' },
  { id: 'qwen3.5:35b-a3b', name: 'Qwen 3.5 Large', role: 'fixer', blurb: 'The smartest that still runs well without a graphics card.', downloadBytes: 24 * GB, memoryBytes: 27 * GB, activeBytes: 2.6 * GB, moe: true, think: false },
  { id: 'qwen3.5:27b', name: 'Qwen 3.5 Pro', role: 'fixer', blurb: 'Very capable, but needs a graphics card to be quick.', downloadBytes: 17 * GB, memoryBytes: 20 * GB, activeBytes: 17 * GB, think: false },
];

export const catalogModel = (id?: string) => CATALOG.find((m) => m.id === id);

/**
 * How much memory the AI may use without squeezing your apps: at most 60% of the machine, and
 * always leaving 3 GB free beyond what's in use now. A container memory limit caps it further.
 */
export function aiMemoryBudget(specs: SystemSpecs): number {
  let budget = Math.min(specs.memory.totalBytes * 0.6, specs.memory.availableBytes - 3 * GB);
  if (specs.memory.manifexusLimitBytes) budget = Math.min(budget, specs.memory.manifexusLimitBytes * 0.8);
  return Math.max(0, budget);
}

/** Rough seconds for a typical reply on this machine (reading a few pages of logs, writing a paragraph) */
export function estimateSeconds(m: CatalogModel, specs: SystemSpecs): number {
  const coreFactor = Math.min(1.5, Math.max(0.5, specs.cpu.cores / 8)) * (specs.cpu.avx512 ? 1.15 : specs.cpu.avx2 ? 1 : 0.6);
  const wordsPerSec = Math.min(40, (40 / (m.activeBytes / GB)) * coreFactor);
  const gpu = specs.gpuUsable ? 6 : 1;
  const reading = 3000 / (wordsPerSec * 8 * gpu); // reading the problem is much faster than writing
  const writing = 250 / (wordsPerSec * gpu);
  return Math.round(reading + writing);
}

export type Fit = 'fits' | 'tight' | 'no';

export function fitOf(m: CatalogModel, specs: SystemSpecs): { fit: Fit; why?: string } {
  const budget = aiMemoryBudget(specs);
  if (specs.disk.freeBytes && m.downloadBytes > specs.disk.freeBytes - 5 * GB) return { fit: 'no', why: 'Not enough disk space' };
  if (m.memoryBytes > specs.memory.totalBytes * 0.85) return { fit: 'no', why: 'Needs more memory than this server has' };
  if (m.memoryBytes > budget) return { fit: 'tight', why: 'Would leave your apps short on memory' };
  if (!specs.gpuUsable && m.activeBytes > 10 * GB) return { fit: 'tight', why: 'Slow without a graphics card' };
  return { fit: 'fits' };
}

/** The best quick helper and fixer for this server */
export function recommend(specs: SystemSpecs): { quick?: string; fixer?: string; note?: string } {
  const ok = (m: CatalogModel) => fitOf(m, specs).fit === 'fits';
  const quick = ['qwen3.5:4b', 'qwen3.5:2b'].map(catalogModel).find((m) => m && ok(m));
  const fixerOrder = specs.gpuUsable ? ['qwen3.5:27b', 'qwen3.5:35b-a3b', 'gpt-oss:20b', 'qwen3.5:9b'] : ['qwen3.5:35b-a3b', 'gpt-oss:20b', 'qwen3.5:9b'];
  const fixer = fixerOrder.map(catalogModel).find((m) => m && ok(m));
  if (!quick) return { note: 'This server doesn’t have enough free memory or disk for the built-in AI right now.' };
  return { quick: quick.id, fixer: fixer?.id || quick.id, note: fixer ? undefined : 'Only a small model fits, so it will be one model for everything.' };
}

// ----------------------------------------------------------------------------
// Engine
// ----------------------------------------------------------------------------

let proc: ChildProcess | undefined;
let starting: Promise<void> | undefined;
let lastEngineError: string | undefined;
const engineLog: string[] = [];

function ollamaBinary(): string | undefined {
  for (const p of [process.env.OLLAMA_BIN, '/usr/bin/ollama', '/usr/local/bin/ollama']) if (p && fs.existsSync(p)) return p;
  return undefined;
}

/** The engine ships with this build (or an external one is configured) */
export const engineIncluded = () => Boolean(EXTERNAL || ollamaBinary());

async function ping(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Starts the engine if it isn't running; resolves when it answers */
export async function ensureEngine(): Promise<void> {
  if (await ping()) return;
  if (EXTERNAL) throw new Error('The AI engine isn’t answering.');
  if (starting) return starting;
  const bin = ollamaBinary();
  if (!bin) throw new Error('This version of Manifexus doesn’t include the AI engine yet. Update Manifexus to get it.');
  starting = (async () => {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    proc = spawn(bin, ['serve'], {
      env: {
        ...process.env,
        OLLAMA_HOST: `127.0.0.1:${PORT}`,
        OLLAMA_MODELS: MODELS_DIR,
        OLLAMA_KEEP_ALIVE: '5m', // free the memory for your apps a few minutes after the last question
        OLLAMA_MAX_LOADED_MODELS: '1',
        OLLAMA_NUM_PARALLEL: '1',
        HOME: AI_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keep = (b: Buffer) => {
      for (const line of b.toString().split('\n').filter(Boolean)) {
        engineLog.push(line.slice(0, 400));
        if (engineLog.length > 200) engineLog.shift();
      }
    };
    proc.stdout?.on('data', keep);
    proc.stderr?.on('data', keep);
    proc.on('exit', (code) => {
      if (code) {
        lastEngineError = `The AI engine stopped (exit ${code}). ${engineLog.slice(-2).join(' ')}`;
        record('warn', 'system', 'The AI engine stopped', { code, lines: engineLog.slice(-20) });
      }
      proc = undefined;
    });
    for (let i = 0; i < 40; i++) {
      if (await ping()) {
        lastEngineError = undefined;
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('The AI engine didn’t start.');
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}

export function stopEngine() {
  proc?.kill('SIGTERM');
}

export async function ollama<T>(p: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<T> {
  await ensureEngine();
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `The AI engine answered ${r.status}.`);
  return (await r.json()) as T;
}

/** Streams newline-delimited JSON from the engine */
export async function* ollamaStream<T>(p: string, body: unknown, signal?: AbortSignal): AsyncGenerator<T> {
  await ensureEngine();
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!r.ok || !r.body) throw new Error((await r.text().catch(() => '')) || `The AI engine answered ${r.status}.`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as T;
    }
  }
  if (buf.trim()) yield JSON.parse(buf) as T;
}

// ----------------------------------------------------------------------------
// Models: installed, downloading, removing
// ----------------------------------------------------------------------------

export interface Download {
  model: string;
  status: 'downloading' | 'done' | 'failed' | 'cancelled';
  completed: number;
  total: number;
  message?: string;
  startedAt: string;
}

const downloads = new Map<string, Download>();
const aborts = new Map<string, AbortController>();

export async function installedModels(): Promise<{ id: string; bytes: number }[]> {
  try {
    const j = await ollama<{ models?: { name: string; model?: string; size: number }[] }>('/api/tags');
    return (j.models || []).map((m) => ({ id: m.model || m.name, bytes: m.size }));
  } catch {
    return [];
  }
}

/** Downloads in the background; progress is read from aiStatus() */
export function installModel(model: string): Download {
  const existing = downloads.get(model);
  if (existing?.status === 'downloading') return existing;
  const d: Download = { model, status: 'downloading', completed: 0, total: catalogModel(model)?.downloadBytes || 0, startedAt: new Date().toISOString() };
  downloads.set(model, d);
  const ac = new AbortController();
  aborts.set(model, ac);
  record('info', 'system', `Downloading AI model ${model}`, { model });
  (async () => {
    try {
      // Layers download one after another: add up what's done across all of them
      const layers = new Map<string, { total: number; completed: number }>();
      for await (const ev of ollamaStream<{ status: string; digest?: string; total?: number; completed?: number; error?: string }>('/api/pull', { model, stream: true }, ac.signal)) {
        if (ev.error) throw new Error(ev.error);
        if (ev.digest && ev.total) layers.set(ev.digest, { total: ev.total, completed: ev.completed || 0 });
        const total = Array.from(layers.values()).reduce((n, l) => n + l.total, 0);
        d.total = Math.max(total, d.total && !layers.size ? d.total : total);
        d.completed = Array.from(layers.values()).reduce((n, l) => n + l.completed, 0);
        d.message = ev.status;
      }
      d.status = 'done';
      d.completed = d.total;
      record('info', 'system', `AI model ${model} is ready`, { model });
    } catch (e) {
      d.status = ac.signal.aborted ? 'cancelled' : 'failed';
      const raw = (e as Error).message || '';
      d.message = ac.signal.aborted
        ? 'Cancelled'
        : /timeout|dial tcp|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|no such host|network is unreachable|fetch failed/i.test(raw)
          ? 'Couldn’t reach the model library (registry.ollama.ai). Check that your server can reach the internet, then try again.'
          : /no space left/i.test(raw)
            ? 'Not enough disk space for this model.'
            : /file does not exist|not found/i.test(raw)
              ? 'That model isn’t in the library anymore.'
              : raw;
      if (!ac.signal.aborted) record('warn', 'system', `Couldn’t download AI model ${model}`, { model, error: d.message });
    } finally {
      aborts.delete(model);
    }
  })();
  return d;
}

export function cancelDownload(model: string) {
  aborts.get(model)?.abort();
}

export async function removeModel(model: string): Promise<void> {
  await ollama('/api/delete', { model }, 'DELETE');
  downloads.delete(model);
  const s = getAiSettings();
  const patch: Partial<AiSettings> = {};
  if (s.quickModel === model) patch.quickModel = undefined;
  if (s.fixerModel === model) patch.fixerModel = undefined;
  if (Object.keys(patch).length) saveAiSettings(patch);
  record('info', 'system', `Removed AI model ${model}`, { model });
}

/** The model to use for a job: the chosen one if installed, else anything installed */
export async function modelFor(role: 'quick' | 'fixer'): Promise<string | undefined> {
  const installed = (await installedModels()).map((m) => m.id);
  const s = getAiSettings();
  const pick = role === 'quick' ? s.quickModel : s.fixerModel;
  if (pick && installed.includes(pick)) return pick;
  const other = role === 'quick' ? s.fixerModel : s.quickModel;
  if (other && installed.includes(other)) return other;
  return installed[0];
}

export async function aiStatus() {
  const specs = await getSystemSpecs();
  const included = engineIncluded();
  let running = false;
  if (included) running = await ping();
  const installed = running ? await installedModels() : [];
  const settings = getAiSettings();
  return {
    engine: { included, running, error: lastEngineError },
    specs,
    budgetBytes: aiMemoryBudget(specs),
    recommended: recommend(specs),
    catalog: CATALOG.map((m) => ({ ...m, ...fitOf(m, specs), seconds: estimateSeconds(m, specs), installed: installed.some((i) => i.id === m.id) })),
    installed,
    downloads: Array.from(downloads.values()),
    settings,
    ready: installed.length > 0,
  };
}

/** Wake the engine in the background when models exist, so the first question isn't slow */
export function warmUpEngine() {
  if (!engineIncluded()) return;
  if (!fs.existsSync(MODELS_DIR) || !fs.readdirSync(MODELS_DIR).length) return;
  ensureEngine().catch(() => undefined);
}
