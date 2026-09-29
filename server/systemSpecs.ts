/**
 * What the server Manifexus runs on can do: CPU, memory, graphics card and disk space. Read from
 * the kernel's own files (a container sees the host's CPU and memory there) plus Docker's info, so
 * it needs no helper containers and answers instantly.
 */
import fs from 'fs';
import os from 'os';
import { queryDockerEngine } from './dockerService';

export interface Gpu {
  vendor: 'nvidia' | 'amd' | 'intel' | 'other';
  name: string;
  /** Video memory, when the system reports it */
  vramBytes?: number;
}

export interface SystemSpecs {
  /** cores = threads the OS sees; physicalCores = real cores (what decides AI speed on a CPU) */
  cpu: { model: string; cores: number; physicalCores: number; avx2: boolean; avx512: boolean; arch: string };
  memory: { totalBytes: number; availableBytes: number; manifexusLimitBytes?: number };
  gpus: Gpu[];
  /** Whether Docker can hand an NVIDIA card to containers (the NVIDIA container toolkit is installed) */
  nvidiaRuntime: boolean;
  /** Whether Manifexus itself can use a graphics card right now */
  gpuUsable: boolean;
  disk: { path: string; freeBytes: number; totalBytes: number };
  os: string;
  checkedAt: string;
}

const read = (p: string): string => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

function meminfo(): { total: number; available: number } {
  const txt = read('/proc/meminfo');
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(txt)?.[1] || 0) * 1024;
  const total = kb('MemTotal') || os.totalmem();
  const available = kb('MemAvailable') || os.freemem();
  return { total, available };
}

/** A memory limit set on the Manifexus container itself (cgroup v2 or v1), if any */
function containerMemoryLimit(): number | undefined {
  const v2 = read('/sys/fs/cgroup/memory.max').trim();
  if (v2 && v2 !== 'max' && /^\d+$/.test(v2)) return Number(v2);
  const v1 = read('/sys/fs/cgroup/memory/memory.limit_in_bytes').trim();
  if (v1 && /^\d+$/.test(v1) && Number(v1) < 2 ** 60) return Number(v1);
  return undefined;
}

function cpuInfo() {
  const txt = read('/proc/cpuinfo');
  const model =
    /^model name\s*:\s*(.+)$/m.exec(txt)?.[1]?.trim() ||
    /^Model\s*:\s*(.+)$/m.exec(txt)?.[1]?.trim() ||
    os.cpus()[0]?.model ||
    'Unknown CPU';
  const flags = /^(flags|Features)\s*:\s*(.+)$/m.exec(txt)?.[2] || '';
  const cores = os.cpus().length || 1;
  // Real cores: unique (physical id, core id) pairs. Hyper-threads share a core and barely help the AI.
  const pairs = new Set<string>();
  for (const block of txt.split(/\n\s*\n/)) {
    const core = /^core id\s*:\s*(\d+)/m.exec(block)?.[1];
    if (core !== undefined) pairs.add(`${/^physical id\s*:\s*(\d+)/m.exec(block)?.[1] || 0}:${core}`);
  }
  return {
    model: model.replace(/\s+/g, ' '),
    cores,
    physicalCores: Math.min(cores, pairs.size || cores),
    avx2: /\bavx2\b/.test(flags),
    avx512: /\bavx512f\b/.test(flags),
    arch: os.arch(),
  };
}

/** Graphics cards the kernel knows about (the NVIDIA driver and /sys are visible from containers) */
function gpus(): Gpu[] {
  const found: Gpu[] = [];
  // NVIDIA: the driver publishes one folder per card
  try {
    for (const d of fs.readdirSync('/proc/driver/nvidia/gpus')) {
      const info = read(`/proc/driver/nvidia/gpus/${d}/information`);
      found.push({ vendor: 'nvidia', name: /^Model:\s*(.+)$/m.exec(info)?.[1]?.trim() || 'NVIDIA graphics card' });
    }
  } catch {
    // no NVIDIA driver
  }
  // Everything else: display devices under /sys/class/drm
  try {
    for (const card of fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c))) {
      const vendor = read(`/sys/class/drm/${card}/device/vendor`).trim();
      if (vendor === '0x10de') continue; // NVIDIA: already listed above
      const vram = Number(read(`/sys/class/drm/${card}/device/mem_info_vram_total`).trim()) || undefined;
      if (vendor === '0x1002') found.push({ vendor: 'amd', name: 'AMD graphics card', vramBytes: vram });
      else if (vendor === '0x8086') found.push({ vendor: 'intel', name: 'Intel integrated graphics' });
    }
  } catch {
    // no /sys access
  }
  return found;
}

function disk(p: string) {
  try {
    const s = (fs as unknown as { statfsSync: (p: string) => { bavail: number; bsize: number; blocks: number } }).statfsSync(p);
    return { path: p, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return { path: p, freeBytes: 0, totalBytes: 0 };
  }
}

let cache: { at: number; specs: SystemSpecs } | undefined;

export async function getSystemSpecs(fresh = false): Promise<SystemSpecs> {
  if (!fresh && cache && Date.now() - cache.at < 15_000) return cache.specs;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info: any = await queryDockerEngine<any>('/info').catch(() => ({}));
  const mem = meminfo();
  const list = gpus();
  const nvidiaRuntime = Boolean(info?.Runtimes && Object.keys(info.Runtimes).some((r) => /nvidia/i.test(r)));
  // Manifexus can only use an NVIDIA card if its own container was given one
  const gpuUsable = fs.existsSync('/dev/nvidia0') || fs.existsSync('/dev/dri/renderD128') && list.some((g) => g.vendor === 'amd');
  const dataDir = fs.existsSync('/data') ? '/data' : process.cwd();
  const specs: SystemSpecs = {
    cpu: cpuInfo(),
    memory: { totalBytes: mem.total, availableBytes: mem.available, manifexusLimitBytes: containerMemoryLimit() },
    gpus: list,
    nvidiaRuntime,
    gpuUsable,
    disk: disk(dataDir),
    os: info?.OperatingSystem || os.type(),
    checkedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), specs };
  return specs;
}
