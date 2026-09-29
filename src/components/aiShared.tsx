import React from 'react';
import { ios } from './ui/ios';

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
  recommended: { quick?: string; fixer?: string; note?: string };
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

