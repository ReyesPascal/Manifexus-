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
import { installEngine, engineInstallState, ENGINE_VERSION } from './aiEngineInstaller';

const DATA_DIR = process.env.DATA_DIR && fs.existsSync(process.env.DATA_DIR) ? process.env.DATA_DIR : fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data');
export const AI_DIR = path.join(DATA_DIR, 'ai');
const SETTINGS_FILE = path.join(AI_DIR, 'settings.json');
const MODELS_DIR = path.join(AI_DIR, 'models');
/** Where Manifexus installs the engine itself when the image doesn't include it */
const ENGINE_DIR = path.join(AI_DIR, 'engine');
const DOWNLOADS_FILE = path.join(AI_DIR, 'downloads.json');
/** A private port, so it never collides with an Ollama you already run */
const PORT = 11439;

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
  for (const p of [process.env.OLLAMA_BIN, '/usr/bin/ollama', '/usr/local/bin/ollama', path.join(ENGINE_DIR, 'bin', 'ollama')]) if (p && fs.existsSync(p)) return p;
  return undefined;
}

/** Runs `bin --help` to make sure the engine works on this machine */
function engineRuns(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn(bin, ['--help'], { stdio: 'ignore' });
      const t = setTimeout(() => {
        p.kill('SIGKILL');
        resolve(false);
      }, 20000);
      p.on('exit', (code) => {
        clearTimeout(t);
        resolve(code === 0);
      });
      p.on('error', () => {
        clearTimeout(t);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Download the engine into the data folder (when this build doesn't include it) */
export async function installEngineNow(): Promise<void> {
  const specs = await getSystemSpecs(true);
  void installEngine(ENGINE_DIR, specs.disk.freeBytes, engineRuns).then(() => {
    if (engineInstallState().status === 'done') ensureEngine().catch(() => undefined);
  });
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
    // First start on a slow machine can take a while
    for (let i = 0; i < 240; i++) {
      if (!proc) throw new Error(lastEngineError || 'The AI engine stopped while starting.');
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

export async function ollama<T>(p: string, body?: unknown, method = body ? 'POST' : 'GET', timeoutMs?: number): Promise<T> {
  await ensureEngine();
  const r = await fetch(`${BASE}${p}`, {
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
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
  status: 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled';
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

function plainPullError(raw: string): string {
  if (/timeout|dial tcp|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|no such host|network is unreachable|fetch failed|stalled|connection reset|EOF/i.test(raw))
    return 'Couldn’t reach the model library (registry.ollama.ai). Check that your server can reach the internet, then try again.';
  if (/no space left|ENOSPC/i.test(raw)) return 'Not enough disk space for this model.';
  if (/file does not exist|manifest unknown|not found/i.test(raw)) return 'That model isn’t in the library anymore.';
  if (/requires more system memory|out of memory|insufficient memory/i.test(raw)) return 'This model needs more free memory than the server has right now. Try a smaller one.';
  return raw;
}
const retryable = (raw: string) => /timeout|dial tcp|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|no such host|unreachable|fetch failed|stalled|connection reset|EOF|max retries|TLS/i.test(raw);

/** Downloads in progress are remembered, so they continue after Manifexus restarts */
function rememberDownloads() {
  try {
    fs.mkdirSync(AI_DIR, { recursive: true });
    fs.writeFileSync(DOWNLOADS_FILE, JSON.stringify(Array.from(downloads.values()).filter((d) => d.status === 'downloading').map((d) => d.model)));
  } catch {
    // best effort
  }
}

/**
 * Downloads a model in the background; progress is read from aiStatus(). Checks disk space and the
 * connection first, retries dropped connections (the engine continues partial files), treats a
 * download that stops moving as dropped, then asks the model a tiny question before calling it Ready.
 */
export function installModel(model: string): Download {
  const existing = downloads.get(model);
  if (existing?.status === 'downloading' || existing?.status === 'verifying') return existing;
  const d: Download = { model, status: 'downloading', completed: 0, total: catalogModel(model)?.downloadBytes || 0, startedAt: new Date().toISOString(), message: 'Getting ready…' };
  downloads.set(model, d);
  rememberDownloads();
  const ac = new AbortController();
  aborts.set(model, ac);
  record('info', 'system', `Downloading AI model ${model}`, { model });
  (async () => {
    const MAX = 6;
    try {
      // Before starting: room on disk, and a way to the model library
      const specs = await getSystemSpecs(true);
      const size = catalogModel(model)?.downloadBytes || 0;
      if (size && specs.disk.freeBytes && specs.disk.freeBytes < size + 2e9) throw new Error(`no space left: needs about ${((size + 2e9) / 1e9).toFixed(0)} GB free`);
      if (!EXTERNAL) {
        try {
          await fetch('https://registry.ollama.ai/v2/', { method: 'HEAD', signal: AbortSignal.timeout(15000) });
        } catch (e) {
          throw new Error(`fetch failed: ${(e as Error).message}`);
        }
      }
      for (let attempt = 1; ; attempt++) {
        const round = new AbortController();
        const stopRound = () => round.abort();
        ac.signal.addEventListener('abort', stopRound);
        let lastMove = Date.now();
        const watchdog = setInterval(() => {
          if (Date.now() - lastMove > 90_000) round.abort(new Error('stalled'));
        }, 5000);
        try {
          const layers = new Map<string, { total: number; completed: number }>();
          for await (const ev of ollamaStream<{ status: string; digest?: string; total?: number; completed?: number; error?: string }>('/api/pull', { model, stream: true }, round.signal)) {
            if (ev.error) throw new Error(ev.error);
            if (ev.digest && ev.total) {
              const prev = layers.get(ev.digest);
              if (!prev || (ev.completed || 0) !== prev.completed) lastMove = Date.now();
              layers.set(ev.digest, { total: ev.total, completed: ev.completed || 0 });
            } else lastMove = Date.now();
            const total = Array.from(layers.values()).reduce((n, l) => n + l.total, 0);
            if (total) d.total = total;
            d.completed = Array.from(layers.values()).reduce((n, l) => n + l.completed, 0);
            d.message = ev.status === 'success' ? undefined : attempt > 1 && d.completed ? `Continuing (try ${attempt} of ${MAX})` : undefined;
          }
          break;
        } catch (e) {
          if (ac.signal.aborted) throw e;
          const raw = round.signal.aborted ? 'stalled' : (e as Error).message || '';
          if (attempt >= MAX || !retryable(raw)) throw new Error(raw);
          d.message = `Connection dropped. Trying again (${attempt + 1} of ${MAX})…`;
          await new Promise((r) => setTimeout(r, Math.min(60_000, 4000 * 2 ** (attempt - 1))));
        } finally {
          clearInterval(watchdog);
          ac.signal.removeEventListener('abort', stopRound);
        }
      }
      // Downloaded: make sure it actually runs here before calling it Ready
      d.status = 'verifying';
      d.completed = d.total;
      d.message = 'Making sure it works on your server…';
      await ollama('/api/generate', { model, prompt: 'Reply with the single word OK.', stream: false, think: catalogModel(model)?.think ?? false, options: { num_predict: 16 } }, 'POST', 10 * 60 * 1000);
      d.status = 'done';
      d.message = undefined;
      record('info', 'system', `AI model ${model} is ready`, { model });
    } catch (e) {
      d.status = ac.signal.aborted ? 'cancelled' : 'failed';
      d.message = ac.signal.aborted ? 'Cancelled' : plainPullError((e as Error).message || '');
      if (!ac.signal.aborted) record('warn', 'system', `Couldn’t get AI model ${model} ready`, { model, error: (e as Error).message });
    } finally {
      aborts.delete(model);
      rememberDownloads();
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
  const install = engineInstallState();
  return {
    engine: {
      included,
      running,
      error: lastEngineError,
      version: ENGINE_VERSION,
      canInstall: !included && (process.arch === 'x64' || process.arch === 'arm64'),
      install,
    },
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

/** On startup: continue downloads that were cut off by a restart, and wake the engine if models exist */
export function warmUpEngine() {
  if (!engineIncluded()) return;
  let pending: string[] = [];
  try {
    pending = JSON.parse(fs.readFileSync(DOWNLOADS_FILE, 'utf8'));
  } catch {
    // none
  }
  for (const m of pending) if (catalogModel(m)) installModel(m);
  if (pending.length || (fs.existsSync(MODELS_DIR) && fs.readdirSync(MODELS_DIR).length)) ensureEngine().catch(() => undefined);
}
