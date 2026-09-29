/**
 * How fast this server can stream memory, measured once in a second or two. On a server without a
 * graphics card, that's what decides how fast an AI model writes: each word means reading the active
 * part of the model from memory. Core count alone can't tell a laptop from a workstation.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Worker } from 'worker_threads';

export interface Bench {
  /** Memory read speed with every core reading, in GB/s */
  bandwidthGBs: number;
  at: string;
}

let cached: Bench | undefined;
let running: Promise<Bench | undefined> | undefined;

// Each worker copies a 128 MB buffer (bigger than any processor cache) a few times (a native copy, as fast as memory allows); a copy
// reads and writes every byte, so it moves twice the buffer size each pass
const WORKER = `
const { parentPort, workerData } = require('worker_threads');
const size = workerData.mb * 1024 * 1024;
const src = Buffer.alloc(size, 7);
const dst = Buffer.allocUnsafe(size);
src.copy(dst); // warm up
const t = process.hrtime.bigint();
for (let r = 0; r < workerData.passes; r++) src.copy(dst);
const secs = Number(process.hrtime.bigint() - t) / 1e9;
parentPort.postMessage({ bytes: size * 2 * workerData.passes, secs });
`;

async function measure(threads: number): Promise<number> {
  const runs = await Promise.all(
    Array.from({ length: threads }, () =>
      new Promise<{ bytes: number; secs: number }>((resolve, reject) => {
        const w = new Worker(WORKER, { eval: true, workerData: { mb: 128, passes: 4 } });
        w.once('message', resolve);
        w.once('error', reject);
      })
    )
  );
  // They ran side by side: total bytes over the slowest one's time
  const bytes = runs.reduce((n, r) => n + r.bytes, 0);
  const secs = Math.max(...runs.map((r) => r.secs));
  return bytes / secs / 1e9;
}

/** The measured memory speed (cached on disk, measured again after a month) */
export async function memoryBench(aiDir: string, physicalCores: number): Promise<Bench | undefined> {
  const file = path.join(aiDir, 'bench.json');
  if (!cached) {
    try {
      cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // not measured yet
    }
  }
  if (cached && Date.now() - new Date(cached.at).getTime() < 30 * 86400e3) return cached;
  if (running) return running;
  running = (async () => {
    try {
      const gbs = await measure(Math.max(1, Math.min(physicalCores || os.cpus().length, 16)));
      cached = { bandwidthGBs: Math.round(gbs * 10) / 10, at: new Date().toISOString() };
      fs.mkdirSync(aiDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(cached, null, 2));
      return cached;
    } catch {
      return undefined;
    } finally {
      running = undefined;
    }
  })();
  return running;
}

/** What was measured, without measuring (for places that can't wait) */
export const benchNow = () => cached;
