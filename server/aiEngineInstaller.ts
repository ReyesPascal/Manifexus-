/**
 * Installs the AI engine (Ollama, processor-only) into the data folder when the Manifexus image
 * doesn't include it, so the built-in AI works even if the build couldn't package it. Everything
 * is done in Node, without relying on command-line tools:
 * resumable download with retries → checksum check → unpack (skipping graphics-card libraries)
 * → run check → swap into place.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { record } from './activityLog';

export const ENGINE_VERSION = '0.34.4';

export interface EngineInstall {
  status: 'idle' | 'checking' | 'downloading' | 'verifying' | 'unpacking' | 'done' | 'failed';
  completed: number;
  total: number;
  message?: string;
  attempt?: number;
}

let state: EngineInstall = { status: 'idle', completed: 0, total: 0 };
export const engineInstallState = () => state;

const arch = () => (process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined);
const releaseBase = () => `https://github.com/ollama/ollama/releases/download/v${ENGINE_VERSION}`;

/** Folders inside the package we don't need: graphics-card libraries are gigabytes */
const SKIP = /^lib\/ollama\/(cuda_|rocm|vulkan|mlx)/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function plain(err: unknown): string {
  const m = (err as Error)?.message || String(err);
  if (/ENOSPC|no space/i.test(m)) return 'Not enough disk space.';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|fetch failed|timeout|network|socket/i.test(m)) return 'Couldn’t reach github.com. Check that your server can reach the internet.';
  return m;
}

/** Download `url` to `file`, continuing a partial file, retrying dropped connections */
async function download(url: string, file: string, onProgress: (done: number, total: number) => void, attempts = 8): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    state.attempt = attempt;
    const have = fs.existsSync(file) ? fs.statSync(file).size : 0;
    try {
      const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) });
      if (res.status === 416) return; // already complete
      if (!res.ok && res.status !== 206) throw new Error(`The download server answered ${res.status}.`);
      const resumed = res.status === 206;
      const len = Number(res.headers.get('content-length') || 0);
      const total = (resumed ? have : 0) + len;
      const out = fs.createWriteStream(file, { flags: resumed ? 'a' : 'w' });
      let done = resumed ? have : 0;
      let lastByte = Date.now();
      const reader = res.body!.getReader();
      // A connection that stops sending for 60 s is treated as dropped
      const stall = setInterval(() => {
        if (Date.now() - lastByte > 60_000) reader.cancel(new Error('The download stalled')).catch(() => undefined);
      }, 5000);
      try {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          lastByte = Date.now();
          done += value.length;
          if (!out.write(value)) await new Promise((r) => out.once('drain', r));
          onProgress(done, total);
        }
      } finally {
        clearInterval(stall);
        await new Promise((r) => out.end(r));
      }
      if (total && fs.statSync(file).size < total) throw new Error('The download stopped early.');
      return;
    } catch (e) {
      if (attempt >= attempts) throw e;
      state.message = `Connection dropped. Trying again (${attempt + 1} of ${attempts})…`;
      await sleep(Math.min(60_000, 3000 * 2 ** (attempt - 1)));
    }
  }
}

async function sha256(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve()).on('error', reject));
  return h.digest('hex');
}

/**
 * A small streaming tar reader: regular files, folders, symlinks, hard links, and long names
 * (GNU and pax). Entries matching SKIP are read past without touching the disk.
 */
async function untarZst(archive: string, dest: string, onProgress: (bytes: number) => void): Promise<void> {
  const unzstd = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream }).createZstdDecompress;
  if (!unzstd) throw new Error('This version of Node can’t unpack the engine.');
  let buf: Buffer = Buffer.alloc(0);
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  let cur: { fd?: number; left: number; pad: number; kind: 'file' | 'skip' | 'L' | 'K' | 'x'; data?: Buffer[] } | null = null;
  let finished = false;
  const links: { from: string; to: string; hard: boolean }[] = [];

  const str = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '');
  const safe = (p: string) => {
    const n = path.posix.normalize(p).replace(/^(\.\/)+/, '');
    if (n.startsWith('..') || path.posix.isAbsolute(n)) throw new Error(`Unsafe path in the engine package: ${p}`);
    return n;
  };

  const consume = () => {
    for (;;) {
      if (finished) return;
      if (cur) {
        if (cur.left > 0) {
          if (!buf.length) return;
          const take = buf.subarray(0, Math.min(cur.left, buf.length));
          if (cur.kind === 'file' && cur.fd !== undefined) fs.writeSync(cur.fd, take);
          else if (cur.kind !== 'skip') cur.data!.push(Buffer.from(take));
          cur.left -= take.length;
          buf = buf.subarray(take.length);
          continue;
        }
        if (buf.length < cur.pad) return;
        buf = buf.subarray(cur.pad);
        if (cur.fd !== undefined) fs.closeSync(cur.fd);
        if (cur.kind === 'L') longName = str(Buffer.concat(cur.data!));
        if (cur.kind === 'K') longLink = str(Buffer.concat(cur.data!));
        if (cur.kind === 'x') {
          pax = {};
          for (const line of Buffer.concat(cur.data!).toString('utf8').split('\n')) {
            const m = /^\d+ ([^=]+)=(.*)$/.exec(line);
            if (m) pax[m[1]] = m[2];
          }
        }
        cur = null;
        continue;
      }
      if (buf.length < 512) return;
      const h = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (h.every((b) => b === 0)) {
        finished = true;
        return;
      }
      const type = String.fromCharCode(h[156] || 48);
      const size = parseInt(str(h.subarray(124, 136)).trim() || '0', 8);
      const mode = parseInt(str(h.subarray(100, 108)).trim() || '644', 8);
      const prefix = str(h.subarray(345, 500));
      const name = pax.path || longName || (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
      const link = pax.linkpath || longLink || str(h.subarray(157, 257));
      const pad = (512 - (size % 512)) % 512;
      if (type === 'L' || type === 'K' || type === 'x') {
        cur = { left: size, pad, kind: type as 'L' | 'K' | 'x', data: [] };
        continue;
      }
      if (type === 'g') {
        cur = { left: size, pad, kind: 'skip' };
        continue;
      }
      longName = undefined;
      longLink = undefined;
      pax = {};
      const rel = safe(name);
      const skip = SKIP.test(rel);
      const target = path.join(dest, rel);
      if (!skip && type === '5') fs.mkdirSync(target, { recursive: true });
      else if (!skip && (type === '2' || type === '1')) links.push({ from: target, to: type === '1' ? path.join(dest, safe(link)) : link, hard: type === '1' });
      if (!skip && (type === '0' || type === '\0' || type === '7')) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        cur = { fd: fs.openSync(target, 'w', mode & 0o777 || 0o644), left: size, pad, kind: 'file' };
      } else {
        cur = { left: size, pad, kind: 'skip' };
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(archive);
    let read = 0;
    input.on('data', (c) => {
      read += c.length;
      onProgress(read);
    });
    const z = unzstd();
    z.on('data', (c: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, c]) : c;
      try {
        consume();
      } catch (e) {
        input.destroy();
        reject(e);
      }
    });
    z.on('end', () => resolve());
    z.on('error', reject);
    input.on('error', reject);
    input.pipe(z);
  });
  // Links last, once their targets exist
  for (const l of links) {
    fs.mkdirSync(path.dirname(l.from), { recursive: true });
    fs.rmSync(l.from, { force: true });
    if (l.hard) fs.copyFileSync(l.to, l.from);
    else fs.symlinkSync(l.to, l.from);
  }
}

/**
 * Downloads and installs the engine into `engineDir` (bin/ollama + lib/ollama). Progress is read
 * from engineInstallState(). `freeBytes` is checked up front so it never fills the disk.
 */
export async function installEngine(engineDir: string, freeBytes: number, check: (bin: string) => Promise<boolean>): Promise<void> {
  if (['checking', 'downloading', 'verifying', 'unpacking'].includes(state.status)) return;
  const a = arch();
  state = { status: 'checking', completed: 0, total: 0, message: 'Getting ready…' };
  const work = `${engineDir}.download`;
  const archive = path.join(work, `ollama-linux-${a}.tar.zst`);
  try {
    if (!a) throw new Error(`The built-in AI isn’t available for this processor type (${process.arch}).`);
    fs.mkdirSync(work, { recursive: true });
    const url = `${releaseBase()}/ollama-linux-${a}.tar.zst`;
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!head.ok) throw new Error(`The engine download isn’t available (github answered ${head.status}).`);
    const size = Number(head.headers.get('content-length') || 0);
    const have = fs.existsSync(archive) ? fs.statSync(archive).size : 0;
    // The package, plus room to unpack the processor libraries, plus a safety margin
    const need = Math.max(0, size - have) + 1.5e9;
    if (freeBytes && freeBytes < need) throw new Error(`Not enough disk space: needs about ${(need / 1e9).toFixed(1)} GB free.`);

    state = { status: 'downloading', completed: have, total: size };
    record('info', 'system', 'Downloading the AI engine', { version: ENGINE_VERSION, bytes: size });
    await download(url, archive, (done, total) => {
      state.completed = done;
      state.total = total || size;
      if (state.message?.startsWith('Connection dropped') && done > have) state.message = undefined;
    });

    state = { ...state, status: 'verifying', message: 'Checking the download…' };
    const sums = await (await fetch(`${releaseBase()}/sha256sum.txt`, { redirect: 'follow', signal: AbortSignal.timeout(20000) })).text();
    const expected = new RegExp(`^([0-9a-f]{64})\\s+\\.?/?ollama-linux-${a}\\.tar\\.zst$`, 'm').exec(sums)?.[1];
    const actual = await sha256(archive);
    if (!expected || expected !== actual) {
      fs.rmSync(archive, { force: true });
      throw new Error('The download was damaged. Try again to download it fresh.');
    }

    state = { status: 'unpacking', completed: 0, total: fs.statSync(archive).size, message: 'Unpacking…' };
    const fresh = `${engineDir}.new`;
    fs.rmSync(fresh, { recursive: true, force: true });
    fs.mkdirSync(fresh, { recursive: true });
    await untarZst(archive, fresh, (n) => (state.completed = n));
    const bin = path.join(fresh, 'bin', 'ollama');
    if (!fs.existsSync(bin)) throw new Error('The engine package didn’t contain the engine.');
    fs.chmodSync(bin, 0o755);
    if (!(await check(bin))) throw new Error('The engine was installed but won’t run on this server.');

    fs.rmSync(engineDir, { recursive: true, force: true });
    fs.renameSync(fresh, engineDir);
    fs.rmSync(work, { recursive: true, force: true });
    state = { status: 'done', completed: state.total, total: state.total };
    record('info', 'system', 'The AI engine is installed', { version: ENGINE_VERSION });
  } catch (e) {
    state = { ...state, status: 'failed', message: plain(e) };
    record('warn', 'system', 'Couldn’t install the AI engine', { error: (e as Error).message });
  }
}
