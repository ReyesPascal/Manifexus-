/**
 * The built-in AI: an Ollama engine that ships inside the Manifexus image and runs in the
 * background, models downloaded on demand into the data folder, and a catalog that recommends
 * models from the server's own specs. Two roles: a quick helper for explanations and summaries,
 * and a fixer for looking into problems and planning changes.
 */
import fs from 'fs';
import http from 'http';
import https from 'https';
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
/** How fast each model really is on this server, measured from every answer */
const SPEEDS_FILE = path.join(AI_DIR, 'speeds.json');
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
  /**
   * Automatic (default): each request picks the model, thinking and effort that fit it (quick
   * lookups on the quick helper, hard problems on the fixer when there's memory for it).
   * Off: always the fixer, with its usual settings.
   */
  auto: boolean;
  /** What it may look at (passwords, tokens and keys are always hidden, whatever this says) */
  access: AiAccess;
  /** When first-time setup was finished */
  setupAt?: string;
}

export interface AiAccess {
  /** What apps print (their logs) */
  logs: boolean;
  /** Files on the server: compose files, .env, configs, folder listings. Needed to change files. */
  files: boolean;
  /** Activity and Restore: what changed recently and what can be undone */
  history: boolean;
  /** The server itself: processor, memory, disk, Docker networks, volumes and ports */
  server: boolean;
}

const ALL_ACCESS: AiAccess = { logs: true, files: true, history: true, server: true };

export function getAiSettings(): AiSettings {
  let saved: Partial<AiSettings> = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    // defaults
  }
  return { freedom: 'ask', auto: true, ...saved, access: { ...ALL_ACCESS, ...(saved.access || {}) } };
}

export function saveAiSettings(patch: Partial<AiSettings>): AiSettings {
  const cur = getAiSettings();
  const next = { ...cur, ...patch, access: { ...cur.access, ...(patch.access || {}) } };
  for (const k of Object.keys(next.access) as (keyof AiAccess)[]) if (!(k in ALL_ACCESS)) delete next.access[k];
  for (const k of Object.keys(ALL_ACCESS) as (keyof AiAccess)[]) next.access[k] = next.access[k] !== false;
  if (!['look', 'ask', 'routine', 'expert'].includes(next.freedom)) next.freedom = 'ask';
  next.auto = next.auto !== false;
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
  /** How the engine runs it when nothing else is decided (reasoning off or low keeps CPU answers quick) */
  think: boolean | 'low';
  /** What thinking it supports: on/off (Qwen) or low/medium/high levels that can't be fully off (GPT-OSS) */
  thinking: 'onoff' | 'levels';
  /** How good it is at finding causes and planning fixes, 1 (basic) to 5 (best), for choosing per request */
  smarts: number;
}

const GB = 1e9;
export const CATALOG: CatalogModel[] = [
  { id: 'qwen3.5:2b', name: 'Qwen 3.5 Mini', role: 'quick', blurb: 'For small servers. Explains errors and summarizes logs.', downloadBytes: 2.7 * GB, memoryBytes: 3.6 * GB, activeBytes: 2.7 * GB, think: false, thinking: 'onoff', smarts: 1 },
  { id: 'qwen3.5:4b', name: 'Qwen 3.5 Small', role: 'quick', blurb: 'Quick, clear explanations, lookups and simple fixes.', downloadBytes: 3.4 * GB, memoryBytes: 4.6 * GB, activeBytes: 3.4 * GB, think: false, thinking: 'onoff', smarts: 2 },
  { id: 'qwen3.5:9b', name: 'Qwen 3.5', role: 'fixer', blurb: 'Solid at finding causes and planning fixes.', downloadBytes: 6.6 * GB, memoryBytes: 8.5 * GB, activeBytes: 6.6 * GB, think: false, thinking: 'onoff', smarts: 3 },
  // 14 GB of weights plus a small working space (half its layers only look at recent words)
  { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', role: 'fixer', blurb: 'Strong reasoning and tool use; fast for its size.', downloadBytes: 14 * GB, memoryBytes: 15 * GB, activeBytes: 2.4 * GB, moe: true, think: 'low', thinking: 'levels', smarts: 4 },
  { id: 'qwen3.5:35b-a3b', name: 'Qwen 3.5 Large', role: 'fixer', blurb: 'The smartest that still runs well without a graphics card.', downloadBytes: 24 * GB, memoryBytes: 27 * GB, activeBytes: 2.6 * GB, moe: true, think: false, thinking: 'onoff', smarts: 5 },
  { id: 'qwen3.5:27b', name: 'Qwen 3.5 Pro', role: 'fixer', blurb: 'Very capable, but needs a graphics card to be quick.', downloadBytes: 17 * GB, memoryBytes: 20 * GB, activeBytes: 17 * GB, think: false, thinking: 'onoff', smarts: 5 },
];

/** Every request uses the same working space, so switching thinking or effort never reloads a model */
export const NUM_CTX = 16384;

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

// ----------------------------------------------------------------------------
// Speed: predicted from the hardware, then measured from real answers on this server
// ----------------------------------------------------------------------------

/** Tokens (word pieces) per second: reading the prompt, and writing */
export interface Speed {
  prefill: number;
  gen: number;
  /** Seconds to load it into memory from disk */
  loadSecs?: number;
  /** Characters per token in what Manifexus sends it */
  charsPerToken?: number;
  /** The engine re-reads the whole conversation each turn (no reuse of what it read before) */
  noPrefixCache?: boolean;
  samples: number;
  at?: string;
}

let speeds: Record<string, Speed> | undefined;
function speedStore(): Record<string, Speed> {
  if (!speeds) {
    try {
      speeds = JSON.parse(fs.readFileSync(SPEEDS_FILE, 'utf8'));
    } catch {
      speeds = {};
    }
  }
  return speeds!;
}

/** What the hardware suggests before anything has been measured */
export function predictedSpeed(m: CatalogModel, specs: SystemSpecs): Speed {
  // Hyper-threads barely help: count real cores. Laptop and desktop CPUs stream roughly 5 GB/s of
  // memory per core in practice, and writing each word means reading the active part of the model once.
  const cores = specs.cpu.physicalCores || Math.max(1, Math.round(specs.cpu.cores / 2));
  const simd = specs.cpu.avx512 ? 1.3 : specs.cpu.avx2 ? 1 : 0.45;
  const activeGB = m.activeBytes / GB;
  const bandwidth = Math.min(60, 5 * cores);
  let gen = (bandwidth / activeGB) * (m.moe ? 0.75 : 1);
  // Reading is compute-bound: about 50 tokens/s per core for a 1B-parameter model (4-bit ≈ 0.6 GB per 1B)
  let prefill = ((cores * 50 * simd) / (activeGB / 0.6)) * (m.moe ? 0.8 : 1);
  if (specs.gpuUsable) {
    gen *= 6;
    prefill *= 15;
  }
  return { prefill: Math.max(2, prefill), gen: Math.max(0.5, gen), loadSecs: m.downloadBytes / (1.2 * GB) + 2, charsPerToken: 3.6, samples: 0 };
}

/** The measured speed if there is one, else the prediction */
export function speedOf(model: string, specs: SystemSpecs): Speed {
  const m = catalogModel(model);
  const guess = m ? predictedSpeed(m, specs) : { prefill: 20, gen: 5, loadSecs: 8, charsPerToken: 3.6, samples: 0 };
  const got = speedStore()[model];
  if (!got?.samples) return guess;
  return { ...guess, ...got, prefill: got.prefill || guess.prefill, gen: got.gen || guess.gen };
}

export interface EngineStats {
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  load_duration?: number;
}

/** Learn from an answer's timings (durations are in nanoseconds) */
export function recordSpeed(model: string, st: EngineStats, info: { promptChars: number; expectedNewChars: number; fresh: boolean; measureOnly?: boolean }) {
  const all = speedStore();
  const cur: Speed = all[model] || { prefill: 0, gen: 0, samples: 0 };
  const ema = (old: number, v: number) => (old ? old * 0.6 + v * 0.4 : v);
  const pc = st.prompt_eval_count || 0;
  if (pc >= 64 && st.prompt_eval_duration) cur.prefill = ema(cur.prefill, pc / (st.prompt_eval_duration / 1e9));
  if ((st.eval_count || 0) >= 16 && st.eval_duration) cur.gen = ema(cur.gen, st.eval_count! / (st.eval_duration / 1e9));
  if (st.load_duration && st.load_duration > 1e9) cur.loadSecs = ema(cur.loadSecs || 0, st.load_duration / 1e9);
  // A fresh read of everything tells us how long a token is in characters (not from plain test text)
  if (info.fresh && pc >= 200 && !info.measureOnly) cur.charsPerToken = ema(cur.charsPerToken || 0, info.promptChars / pc);
  // It re-read far more than what was new: this engine/model doesn't reuse what it read last turn
  if (!info.fresh && pc > 200 && !info.measureOnly) {
    const cpt = cur.charsPerToken || 3.6;
    cur.noPrefixCache = pc * cpt > Math.max(2000, info.expectedNewChars * 1.8);
  }
  cur.samples++;
  cur.at = new Date().toISOString();
  all[model] = cur;
  try {
    fs.mkdirSync(AI_DIR, { recursive: true });
    fs.writeFileSync(SPEEDS_FILE, JSON.stringify(all, null, 2));
  } catch {
    // best effort
  }
}

/** Rough seconds for a typical reply on this machine (reading the question and what it looked up, writing a paragraph) */
export function estimateSeconds(m: CatalogModel, specs: SystemSpecs): number {
  const sp = speedOf(m.id, specs);
  const reading = 1800 / sp.prefill;
  const writing = (200 + (m.thinking === 'levels' ? 80 : 0)) / sp.gen;
  return Math.round(reading + writing);
}

/** Whether a model can run right now without squeezing your apps (or it's already in memory) */
export async function fitsNow(model: string): Promise<{ ok: boolean; why?: string }> {
  const m = catalogModel(model);
  if (!m) return { ok: true };
  try {
    const ps = await ollama<{ models?: { name?: string; model?: string }[] }>('/api/ps', undefined, 'GET', 3000);
    if ((ps.models || []).some((x) => x.name === model || x.model === model)) return { ok: true };
  } catch {
    // can't tell: go by memory
  }
  const specs = await getSystemSpecs(true);
  const budget = aiMemoryBudget(specs);
  if (m.memoryBytes <= budget) return { ok: true };
  return { ok: false, why: `${m.name} needs about ${(m.memoryBytes / GB).toFixed(0)} GB and only ${(Math.max(0, budget) / GB).toFixed(0)} GB can be spared right now` };
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

/**
 * One request to the engine. Uses Node's http module rather than fetch: fetch gives up when a reply
 * hasn't started within 5 minutes, and on a slow processor reading a long question (or waiting for a
 * model to load) can legitimately take longer. Nothing here times out unless the caller asks.
 */
function engineRequest(p: string, body: unknown, method: string, signal?: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE}${p}`);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = (url.protocol === 'https:' ? https : http).request(
      url,
      { method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : undefined },
      resolve
    );
    const onAbort = () => req.destroy(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }
    req.on('error', (e) => reject(signal?.aborted ? e : new Error(plainEngineError(e))));
    if (data) req.write(data);
    req.end();
  });
}

/** Plain words for a dropped connection to the engine (instead of "fetch failed" or "socket hang up") */
function plainEngineError(e: Error & { code?: string }): string {
  if (/ECONNREFUSED|ECONNRESET|socket hang up|EPIPE/i.test(`${e.code || ''} ${e.message}`)) return 'The AI engine stopped answering (it may have restarted or run out of memory). Try again in a moment.';
  return e.message || 'Couldn’t reach the AI engine.';
}

async function readAll(res: http.IncomingMessage): Promise<string> {
  let text = '';
  res.setEncoding('utf8');
  for await (const chunk of res) text += chunk;
  return text;
}

export async function ollama<T>(p: string, body?: unknown, method = body ? 'POST' : 'GET', timeoutMs?: number): Promise<T> {
  await ensureEngine();
  const res = await engineRequest(p, body, method, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined);
  const text = await readAll(res).catch(() => '');
  if ((res.statusCode || 0) >= 400) throw new Error(engineError(text) || `The AI engine answered ${res.statusCode}.`);
  // Some answers have no body at all (removing a model): that's success, not a broken reply
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

/** The engine's own message from an error body like {"error":"model 'x' not found"} */
function engineError(text: string): string {
  try {
    const j = JSON.parse(text);
    if (typeof j?.error === 'string') return j.error;
  } catch {
    // not JSON
  }
  return text.trim();
}

/** Streams newline-delimited JSON from the engine, for as long as it takes */
export async function* ollamaStream<T>(p: string, body: unknown, signal?: AbortSignal): AsyncGenerator<T> {
  await ensureEngine();
  const res = await engineRequest(p, body, 'POST', signal);
  if ((res.statusCode || 0) >= 400) throw new Error(engineError(await readAll(res).catch(() => '')) || `The AI engine answered ${res.statusCode}.`);
  res.setEncoding('utf8');
  let buf = '';
  try {
    for await (const chunk of res) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line) as T;
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error(plainEngineError(e as Error));
  } finally {
    res.destroy();
  }
  if (buf.trim()) yield JSON.parse(buf) as T;
}

// ----------------------------------------------------------------------------
// Models: installed, downloading, removing
// ----------------------------------------------------------------------------

/** One stage of getting a model ready, shown as a checklist while it installs */
export interface DownloadStep {
  id: 'room' | 'connect' | 'download' | 'verify' | 'load' | 'test';
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
  /** How long it took, once done */
  ms?: number;
  startedAt?: number;
  /** 0–1 and seconds left, when they can be worked out */
  progress?: number;
  eta?: number;
}

export interface Download {
  model: string;
  /** queued: waiting for another model's download to finish (they download one after another, and are tested while the next downloads) */
  status: 'queued' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled';
  completed: number;
  total: number;
  message?: string;
  startedAt: string;
  steps: DownloadStep[];
  /** Download speed in bytes a second (smoothed) and seconds left */
  speed?: number;
  eta?: number;
  /** Files making up the model: how many are fully downloaded */
  parts?: { done: number; total: number };
}

const STEP_LABELS: [DownloadStep['id'], string][] = [
  ['room', 'Check disk space'],
  ['connect', 'Reach the model library'],
  ['download', 'Download'],
  ['verify', 'Check the download'],
  ['load', 'Load into memory'],
  ['test', 'Test answer'],
];

const downloads = new Map<string, Download>();
const aborts = new Map<string, AbortController>();

/** Still being downloaded, checked, loaded or tested */
const settingUp = (id: string) => ['queued', 'downloading', 'verifying'].includes(downloads.get(id)?.status || '');

/** Installed models that have finished setting up (not one that's still being tested) */
async function usableModels(): Promise<string[]> {
  return (await installedModels()).map((m) => m.id).filter((id) => !settingUp(id));
}

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
    fs.writeFileSync(DOWNLOADS_FILE, JSON.stringify(Array.from(downloads.values()).filter((d) => d.status === 'queued' || d.status === 'downloading' || d.status === 'verifying').map((d) => d.model)));
  } catch {
    // best effort
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Getting several models ready as soon as possible: they download one at a time (so the first isn't
 * slowed by sharing the connection), smallest first, and each is checked, loaded and tested while the
 * next one downloads. Only one model is loaded to test at a time, so memory is never doubled up.
 */
let downloadingNow: string | undefined;
let testing: Promise<void> = Promise.resolve();

async function waitForDownloadTurn(model: string, signal: AbortSignal) {
  for (;;) {
    await sleep(250); // let a "Download Both" arrive in full before choosing the order
    if (signal.aborted) throw new Error('cancelled');
    if (downloadingNow) continue;
    const waiting = Array.from(downloads.values())
      .filter((x) => x.status === 'queued')
      .sort((a, b) => (catalogModel(a.model)?.downloadBytes || 0) - (catalogModel(b.model)?.downloadBytes || 0));
    if (waiting[0]?.model === model) {
      downloadingNow = model;
      return;
    }
  }
}

const gbText = (b: number) => `${(b / GB).toFixed(b >= 10 * GB ? 0 : 1)} GB`;
const secsText = (s: number) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);

/** A short, fixed passage for the test answer, so the speed it measures is comparable every time */
const TEST_PROMPT =
  'Manifexus is a dashboard for the Docker apps on a home server. It shows which apps are running, groups them into stacks, ' +
  'moves them between stacks with a backup first, and records every change so it can be undone from Restore. Its built-in ' +
  'assistant can read app logs, compose files and settings, explain problems in plain words, and propose fixes that the ' +
  'person reviews before anything changes.\n\nIn one short sentence, what does Manifexus do?';

/**
 * Downloads a model in the background and gets it ready; progress is read from aiStatus(). Each stage
 * is a step with its own detail: disk space, the model library, the download (speed, time left, parts),
 * checking the files, loading into memory, and a test answer that also measures its speed here.
 */
export function installModel(model: string): Download {
  const existing = downloads.get(model);
  if (existing && ['queued', 'downloading', 'verifying'].includes(existing.status)) return existing;
  const info = catalogModel(model);
  const d: Download = {
    model,
    status: 'queued',
    completed: 0,
    total: info?.downloadBytes || 0,
    startedAt: new Date().toISOString(),
    message: 'Waiting its turn',
    steps: STEP_LABELS.map(([id, label]) => ({ id, label, status: 'pending' as const })),
  };
  downloads.set(model, d);
  rememberDownloads();
  const ac = new AbortController();
  aborts.set(model, ac);
  record('info', 'system', `Downloading AI model ${model}`, { model });

  const step = (id: DownloadStep['id']) => d.steps.find((x) => x.id === id)!;
  const start = (id: DownloadStep['id'], detail?: string) => Object.assign(step(id), { status: 'running', startedAt: Date.now(), detail, progress: undefined, eta: undefined });
  const done = (id: DownloadStep['id'], detail?: string) => {
    const x = step(id);
    Object.assign(x, { status: 'done', ms: Date.now() - (x.startedAt || Date.now()), progress: undefined, eta: undefined });
    if (detail !== undefined) x.detail = detail;
  };

  (async () => {
    const MAX = 6;
    try {
      await waitForDownloadTurn(model, ac.signal);
      d.status = 'downloading';
      d.message = undefined;
      try {
        // Room on disk for this one and any still waiting behind it
        start('room');
        const specs = await getSystemSpecs(true);
        const size = info?.downloadBytes || 0;
        const others = Array.from(downloads.values()).filter((x) => x.model !== model && x.status === 'queued').reduce((n, x) => n + (catalogModel(x.model)?.downloadBytes || 0), 0);
        if (size && specs.disk.freeBytes && specs.disk.freeBytes < size + 2e9) throw new Error(`no space left: needs about ${((size + 2e9) / 1e9).toFixed(0)} GB free`);
        done('room', `Needs ${gbText(size)}${others ? ` (${gbText(size + others)} with the next one)` : ''}; ${gbText(specs.disk.freeBytes)} free`);

        start('connect', 'registry.ollama.ai');
        if (!EXTERNAL) {
          const t = Date.now();
          try {
            await fetch('https://registry.ollama.ai/v2/', { method: 'HEAD', signal: AbortSignal.timeout(15000) });
          } catch (e) {
            throw new Error(`fetch failed: ${(e as Error).message}`);
          }
          done('connect', `registry.ollama.ai answered in ${Date.now() - t} ms`);
        } else done('connect', 'Using the AI engine you set up');

        start('download', 'Getting the list of files');
        let lastSample = { at: Date.now(), bytes: 0 };
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
              const now = Date.now();
              if (ev.digest && ev.total) {
                const prev = layers.get(ev.digest);
                if (!prev || (ev.completed || 0) !== prev.completed) lastMove = now;
                layers.set(ev.digest, { total: ev.total, completed: ev.completed || 0 });
                const total = Array.from(layers.values()).reduce((n, l) => n + l.total, 0);
                // Files are announced as they start: until most are listed, the catalog size is the better total
                if (total) d.total = info?.downloadBytes && total < info.downloadBytes * 0.8 ? info.downloadBytes : total;
                d.completed = Array.from(layers.values()).reduce((n, l) => n + l.completed, 0);
                d.parts = { done: Array.from(layers.values()).filter((l) => l.completed >= l.total).length, total: layers.size };
                // Smoothed speed from at least a second of progress
                if (now - lastSample.at >= 1000) {
                  const inst = Math.max(0, d.completed - lastSample.bytes) / ((now - lastSample.at) / 1000);
                  if (lastSample.bytes || d.completed < d.total) d.speed = d.speed ? d.speed * 0.7 + inst * 0.3 : inst;
                  lastSample = { at: now, bytes: d.completed };
                }
                d.eta = d.speed ? Math.max(1, (d.total - d.completed) / d.speed) : undefined;
                Object.assign(step('download'), {
                  progress: d.total ? d.completed / d.total : 0,
                  eta: d.eta,
                  detail: [`${gbText(d.completed)} of ${gbText(d.total)}`, d.speed ? `${(d.speed / 1e6).toFixed(1)} MB/s` : '', d.parts.total > 1 ? `part ${Math.min(d.parts.done + 1, d.parts.total)} of ${d.parts.total}` : '', attempt > 1 ? `try ${attempt} of ${MAX}` : '']
                    .filter(Boolean)
                    .join(' · '),
                });
              } else {
                lastMove = now;
                const st = ev.status || '';
                if (/^pulling manifest/.test(st)) step('download').detail = 'Getting the list of files';
                else if (/verifying/.test(st)) {
                  if (step('download').status === 'running') done('download', `${gbText(d.total)}${d.speed ? ` at ${(d.speed / 1e6).toFixed(1)} MB/s` : ''}`);
                  if (step('verify').status === 'pending') start('verify', 'Making sure every file arrived intact');
                } else if (/writing manifest/.test(st)) step('verify').detail = 'Adding it to the list of models';
                else if (/removing/.test(st)) step('verify').detail = 'Tidying up leftovers';
              }
              d.message = attempt > 1 && d.completed ? `Continuing (try ${attempt} of ${MAX})` : undefined;
            }
            break;
          } catch (e) {
            if (ac.signal.aborted) throw e;
            const raw = round.signal.aborted ? 'stalled' : (e as Error).message || '';
            if (attempt >= MAX || !retryable(raw)) throw new Error(raw);
            const wait = Math.min(60_000, 4000 * 2 ** (attempt - 1));
            d.message = `Connection dropped. Trying again (${attempt + 1} of ${MAX})…`;
            step('download').detail = `Connection dropped. Trying again in ${Math.round(wait / 1000)} s (${attempt + 1} of ${MAX}); it continues where it stopped`;
            await sleep(wait);
          } finally {
            clearInterval(watchdog);
            ac.signal.removeEventListener('abort', stopRound);
          }
        }
        if (step('download').status === 'running') done('download', `${gbText(d.total)}${d.speed ? ` at ${(d.speed / 1e6).toFixed(1)} MB/s` : ''}`);
        if (step('verify').status === 'pending') start('verify');
        done('verify', 'Every file checks out');
      } finally {
        // The next model starts downloading now, while this one is loaded and tested
        if (downloadingNow === model) downloadingNow = undefined;
      }
      d.status = 'verifying';
      d.completed = d.total;
      d.speed = undefined;
      d.eta = undefined;

      // One model in memory at a time for testing
      const prev = testing;
      let release!: () => void;
      testing = new Promise<void>((r) => (release = r));
      try {
        if (step('load').status === 'pending') step('load').detail = 'Waiting for the other model’s test to finish';
        d.message = 'Downloaded. Waiting to be tested';
        await prev;
        if (ac.signal.aborted) throw new Error('cancelled');
        d.message = undefined;
        const specs = await getSystemSpecs(true);
        const est = speedOf(model, specs).loadSecs || 10;
        start('load', `${gbText(info?.memoryBytes || d.total)} into memory (RAM). The AI reads from memory, so this happens before its first answer.`);
        const t0 = Date.now();
        const ticker = setInterval(() => {
          const el = (Date.now() - t0) / 1000;
          Object.assign(step('load'), { progress: Math.min(0.95, el / est), eta: el < est ? est - el : undefined });
        }, 500);
        try {
          await ollama('/api/generate', { model, keep_alive: '5m', options: { num_ctx: NUM_CTX } }, 'POST', 10 * 60 * 1000);
        } finally {
          clearInterval(ticker);
        }
        const loadMs = Date.now() - t0;
        recordSpeed(model, { load_duration: loadMs * 1e6 }, { promptChars: 0, expectedNewChars: 0, fresh: false, measureOnly: true });
        done('load', `Loaded in ${secsText(loadMs / 1000)}. It lets go of the memory a few minutes after it was last used.`);

        // A real (short) answer: proves it works here, and measures how fast it reads and writes
        start('test', 'Reading a short passage');
        let wrote = '';
        let stats: EngineStats = {};
        for await (const ch of ollamaStream<{ response?: string; thinking?: string; done?: boolean; error?: string } & EngineStats>(
          '/api/generate',
          { model, prompt: TEST_PROMPT, stream: true, think: info?.think ?? false, options: { num_ctx: NUM_CTX, temperature: 0, num_predict: 48 } },
          AbortSignal.any([ac.signal, AbortSignal.timeout(10 * 60 * 1000)])
        )) {
          if (ch.error) throw new Error(ch.error);
          if (ch.response || ch.thinking) {
            wrote += ch.response || ch.thinking || '';
            step('test').detail = `Writing its answer: ${Math.max(1, Math.round(wrote.length / 4.8))} words`;
          }
          if (ch.done) stats = ch;
        }
        // Only a fair measurement when nothing else is downloading or being tested alongside it
        const alone = !Array.from(downloads.values()).some((x) => x.model !== model && ['downloading', 'verifying'].includes(x.status));
        if (alone) recordSpeed(model, stats, { promptChars: TEST_PROMPT.length, expectedNewChars: TEST_PROMPT.length, fresh: true, measureOnly: true });
        const sp = speedOf(model, specs);
        done('test', `Works. On your server it reads about ${Math.round(sp.prefill * 0.75)} words a second and writes about ${Math.max(1, Math.round(sp.gen * 0.75))}`);
      } finally {
        release();
      }
      d.status = 'done';
      d.message = undefined;
      record('info', 'system', `AI model ${model} is ready`, { model });
      // The last model tested is the one in memory: put the everyday model back for the first question
      if (!Array.from(downloads.values()).some((x) => ['queued', 'downloading', 'verifying'].includes(x.status))) void loadEverydayModel(model);
    } catch (e) {
      d.status = ac.signal.aborted ? 'cancelled' : 'failed';
      const why = ac.signal.aborted ? 'Cancelled' : plainPullError((e as Error).message || '');
      d.message = why;
      for (const x of d.steps) if (x.status === 'running') Object.assign(x, { status: 'failed', detail: why, progress: undefined, eta: undefined, ms: Date.now() - (x.startedAt || Date.now()) });
      if (!ac.signal.aborted) record('warn', 'system', `Couldn’t get AI model ${model} ready`, { model, error: (e as Error).message });
    } finally {
      aborts.delete(model);
      rememberDownloads();
    }
  })();
  return d;
}

/** After installing, have the quick helper in memory (not the model tested last) so the first question starts at once */
let finishing: string | undefined;
async function loadEverydayModel(justTested: string) {
  const s = getAiSettings();
  const everyday = s.auto === false ? s.fixerModel : s.quickModel;
  if (!everyday || everyday === justTested) return;
  if (!(await installedModels()).some((m) => m.id === everyday)) return;
  finishing = `Loading ${catalogModel(everyday)?.name || everyday} into memory for your first question`;
  try {
    await ollama('/api/generate', { model: everyday, keep_alive: '5m', options: { num_ctx: NUM_CTX } }, 'POST', 10 * 60 * 1000);
  } catch {
    // it loads with the first question instead
  } finally {
    finishing = undefined;
  }
}

/**
 * Setup still running: a recommended model (the bundle) being downloaded, checked, loaded or tested,
 * or the everyday model being put back in memory. Questions wait for this, so the models they choose
 * from are all there and nothing else is competing for the processor while they're answered.
 */
export function setupInProgress(): string | undefined {
  if (finishing) return finishing;
  for (const id of bundle?.models || []) {
    const d = downloads.get(id);
    if (!d || !settingUp(id)) continue;
    const name = catalogModel(id)?.name || id;
    const running = d.steps.find((x) => x.status === 'running');
    if (d.status === 'queued') return `${name} is waiting to download`;
    return running ? `${name}: ${running.label.toLowerCase()}` : `Setting up ${name}`;
  }
  return undefined;
}

/**
 * The recommended models as one pipeline: disk space is checked for all of them up front (so it
 * doesn't fail halfway), each gets its role, and they download back to back, smallest first, each
 * tested while the next downloads.
 */
export interface Bundle {
  models: string[];
  startedAt: string;
  neededBytes: number;
  freeBytes: number;
}
let bundle: Bundle | undefined;

export async function installBundle(items: { model: string; role: 'quick' | 'fixer' | 'both' }[]): Promise<Bundle> {
  const list = items.filter((i) => catalogModel(i.model));
  if (!list.length) throw new Error('Nothing to download.');
  const have = (await installedModels()).map((m) => m.id);
  const todo = list.filter((i) => !have.includes(i.model)).sort((a, b) => catalogModel(a.model)!.downloadBytes - catalogModel(b.model)!.downloadBytes);
  const neededBytes = todo.reduce((n, i) => n + catalogModel(i.model)!.downloadBytes, 0);
  const specs = await getSystemSpecs(true);
  if (neededBytes && specs.disk.freeBytes && specs.disk.freeBytes < neededBytes + 2e9)
    throw new Error(`Not enough disk space: these need about ${gbText(neededBytes + 2e9)} and ${gbText(specs.disk.freeBytes)} is free.`);
  const patch: Partial<AiSettings> = {};
  for (const i of list) {
    if (i.role === 'quick' || i.role === 'both') patch.quickModel = i.model;
    if (i.role === 'fixer' || i.role === 'both') patch.fixerModel = i.model;
  }
  saveAiSettings(patch);
  bundle = { models: todo.map((i) => i.model), startedAt: new Date().toISOString(), neededBytes, freeBytes: specs.disk.freeBytes };
  for (const i of todo) installModel(i.model);
  return bundle;
}

export function cancelDownload(model: string) {
  aborts.get(model)?.abort();
}

export async function removeModel(model: string): Promise<void> {
  try {
    await ollama('/api/delete', { model }, 'DELETE');
  } catch (e) {
    // Already gone (e.g. a second tap on Remove): the goal is met, so just tidy up below
    if (!/not found/i.test((e as Error).message || '')) throw e;
  }
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
  const installed = await usableModels();
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
    catalog: CATALOG.map((m) => ({ ...m, ...fitOf(m, specs), seconds: estimateSeconds(m, specs), measured: Boolean(speedStore()[m.id]?.samples), installed: installed.some((i) => i.id === m.id) && !settingUp(m.id) })),
    installed,
    downloads: Array.from(downloads.values()),
    bundle,
    settings,
    // Ready once a model is downloaded *and* tested (the engine lists it as soon as its files arrive)
    // …and the whole setup has finished, so questions can choose between all the models
    ready: installed.some((m) => !settingUp(m.id)) && !setupInProgress(),
    setupBusy: setupInProgress(),
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
