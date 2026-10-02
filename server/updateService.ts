/**
 * Software Update
 *
 * How versions work: every image the GitHub Action publishes carries OCI labels with the git commit
 * (org.opencontainers.image.revision), build time (…created) and source repo (…source). The version
 * Manifexus reports is read from the image it is *actually running* (not from the tag, which may
 * already point at something newer).
 *
 * Checking: ask the registry for the digest behind the image tag (e.g. ghcr.io/…/manifexus:latest)
 * and compare it with the running image's digests. When different, read the new image's labels and
 * download size, and list the commits in between from GitHub.
 *
 * Installing:
 *   1. download   – pull the new image with live progress
 *   2. prepare    – record the job in /data so the new instance can report the outcome
 *   3. restart    – a helper container (running the *current* image, so it has the Docker CLI)
 *                   recreates Manifexus: `docker compose up` for compose installs, or an exact
 *                   API-level clone for `docker run` installs
 *   4. verify     – the helper waits for the new container to be running/healthy; if it isn't,
 *                   it puts the previous version back and records a rollback
 *
 * A version chosen by the developer: `update-policy.json` in the repo (read from the build's own source on
 * GitHub, so only whoever can push there can set it) names a version every Manifexus installs, back or forward,
 * whatever its settings say. It's the same install, from that version's numbered image (3.4 -> :3.4.0), which
 * the helper tags as the image Manifexus runs from. People can't choose a version themselves. Going back never
 * goes before 3.4 (the first version that reads the policy, so servers can be brought forward again) nor before
 * the newest version that changed how data is stored (see versionHistory); settings are saved first. While a
 * version is set, ordinary updates wait, so servers stay on it until the policy is cleared.
 * The browser follows along and reloads once the new version answers.
 */
import { localVersion, localReleases, remoteReleases, releasesSince, Release, fullVersion, canGoBackTo, compareVersions } from './releaseNotes';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { queryDockerEngine } from './dockerService';
import { getSelfContainerId } from './dataBackupService';
import { fetchContainerLogs } from './dockerService';
import {
  currentActivityId,
  finishActivity,
  pipelineRecorder,
  record,
  runInActivity,
  startActivity,
  withActivity,
} from './activityLog';
import { globalLogService } from './globalLogService';
import { writeJsonAtomic } from './safeJson';

const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'software-update.json');
const JOB_FILE = path.join(DATA_DIR, 'update-job.json');
const RESULT_FILE = path.join(DATA_DIR, 'update-result.json');
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_INSTALL_HOUR = 4; // server local time

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface BuildInfo {
  /** Short commit, e.g. "782fa84"; undefined for local builds without labels */
  revision?: string;
  /** ISO build time */
  created?: string;
  /** Human label, e.g. "Version 1.1" (or "Build 782fa84" for builds without release notes) */
  label: string;
  /** "1.1", from the build's release notes */
  version?: string;
}

export interface ReleaseNote {
  sha: string;
  title: string;
  date?: string;
}

export interface UpdateSettings {
  autoCheck: boolean;
  autoInstall: boolean;
}

export interface UpdateOutcome {
  status: 'success' | 'rolled_back' | 'failed';
  from?: string;
  to?: string;
  message: string;
  finishedAt: string;
}

export interface UpdateProgress {
  stage: 'download' | 'prepare' | 'restart' | 'done' | 'error';
  percent?: number;
  message: string;
  bytesDone?: number;
  bytesTotal?: number;
  toImageId?: string;
  fromImageId?: string;
}

export interface SoftwareUpdateState {
  /** False when Manifexus can't update itself (not in Docker, read-only socket, …) */
  supported: boolean;
  unsupportedReason?: string;
  imageRef?: string;
  installMode?: 'compose' | 'standalone';
  current: BuildInfo & { imageId?: string };
  status: 'up_to_date' | 'available' | 'unknown';
  latest?: BuildInfo & { digest: string; sizeBytes?: number; downloadBytes?: number; notes: ReleaseNote[]; totalCommits?: number; releases?: Release[] };
  lastCheckedAt?: string;
  checkError?: string;
  checking: boolean;
  installing?: UpdateProgress;
  lastOutcome?: UpdateOutcome;
  settings: UpdateSettings;
  /** This version's own release notes */
  currentRelease?: Release;
  /** The developer has set the version every Manifexus runs (update-policy.json); ordinary updates wait */
  pinned?: UpdatePolicy;
}

/** update-policy.json: the version the developer wants every Manifexus on, and an optional note for people */
export interface UpdatePolicy {
  version: string;
  message?: string;
}

export interface SelfInfo {
  id: string;
  name: string;
  imageRef: string;
  imageId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inspect: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  image: any;
  compose?: { project: string; service: string; workingDir: string; configFiles: string[] };
}

// ----------------------------------------------------------------------------
// Persistent state
// ----------------------------------------------------------------------------

interface Persisted {
  settings: UpdateSettings;
  lastCheckedAt?: string;
  latest?: SoftwareUpdateState['latest'];
  checkError?: string;
  lastOutcome?: UpdateOutcome;
  /** The developer's last policy that could be read (kept when GitHub can't be reached) */
  policy?: UpdatePolicy | null;
}

function loadPersisted(): Persisted {
  try {
    const p = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { settings: { autoCheck: true, autoInstall: false, ...(p.settings || {}) }, ...p };
  } catch {
    return { settings: { autoCheck: true, autoInstall: false } };
  }
}

function savePersisted(p: Persisted): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeJsonAtomic(STATE_FILE, p);
  } catch (err) {
    globalLogService.log({ level: 'WARN', source: 'update', message: 'Could not save update state', error: err });
  }
}

let persisted = loadPersisted();
let checking = false;
let installing: UpdateProgress | undefined;
let installListeners: ((p: UpdateProgress) => void)[] = [];

// ----------------------------------------------------------------------------
// Self inspection
// ----------------------------------------------------------------------------

const shortSha = (s?: string) => (s ? s.replace(/^sha256:/, '').slice(0, 7) : undefined);

function buildInfoFromLabels(labels: Record<string, string> | undefined, version?: string): BuildInfo {
  const revision = shortSha(labels?.['org.opencontainers.image.revision']);
  const created = labels?.['org.opencontainers.image.created'];
  return { revision, created, version, label: version ? `Version ${version}` : revision ? `Build ${revision}` : 'Development build' };
}

export async function getSelf(): Promise<SelfInfo | null> {
  const id = await getSelfContainerId();
  if (!id) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inspect = await queryDockerEngine<any>(`/containers/${id}/json`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const image = await queryDockerEngine<any>(`/images/${encodeURIComponent(inspect.Image)}/json`);
  const labels = inspect.Config?.Labels || {};
  const compose = labels['com.docker.compose.project']
    ? {
        project: labels['com.docker.compose.project'],
        service: labels['com.docker.compose.service'],
        workingDir: labels['com.docker.compose.project.working_dir'],
        configFiles: String(labels['com.docker.compose.project.config_files'] || '')
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean),
      }
    : undefined;
  return {
    id: inspect.Id,
    name: String(inspect.Name || '').replace(/^\//, ''),
    imageRef: inspect.Config?.Image,
    imageId: inspect.Image,
    inspect,
    image,
    compose: compose && compose.workingDir && compose.service ? compose : undefined,
  };
}

// ----------------------------------------------------------------------------
// Registry
// ----------------------------------------------------------------------------

interface ParsedRef {
  registry: string;
  repo: string;
  tag: string;
}

function parseRef(ref: string): ParsedRef | null {
  if (!ref || ref.startsWith('sha256:')) return null;
  let rest = ref.split('@')[0];
  let registry = 'registry-1.docker.io';
  const first = rest.split('/')[0];
  if (rest.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first;
    rest = rest.slice(first.length + 1);
  } else if (!rest.includes('/')) {
    rest = `library/${rest}`;
  }
  const colon = rest.lastIndexOf(':');
  const tag = colon > rest.lastIndexOf('/') ? rest.slice(colon + 1) : 'latest';
  const repo = colon > rest.lastIndexOf('/') ? rest.slice(0, colon) : rest;
  if (registry === 'docker.io') registry = 'registry-1.docker.io';
  return { registry, repo, tag };
}

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

async function registryToken(r: ParsedRef): Promise<string | undefined> {
  const url =
    r.registry === 'registry-1.docker.io'
      ? `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${r.repo}:pull`
      : `https://${r.registry}/token?service=${r.registry}&scope=repository:${r.repo}:pull`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return undefined;
  const j = (await res.json()) as { token?: string; access_token?: string };
  return j.token || j.access_token;
}

async function registryGet(r: ParsedRef, pathPart: string, token: string | undefined, accept?: string, method = 'GET') {
  return fetch(`https://${r.registry}/v2/${r.repo}/${pathPart}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(accept ? { Accept: accept } : {}) },
    signal: AbortSignal.timeout(15000),
  });
}

const DOCKER_ARCH: Record<string, string> = { x64: 'amd64', arm64: 'arm64', arm: 'arm' };

/**
 * What an update really downloads: only the parts this server doesn't have yet. Usually just the part with
 * Manifexus's own code (a few MB), because the base system, Docker tools and AI engine stay the same.
 * Undefined when it can't be worked out (then the full size is shown as the most it can be).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function neededDownload(parts: { size: number; diffId?: string }[] | undefined, localImage: any): number | undefined {
  const have: string[] | undefined = localImage?.RootFS?.Layers;
  if (!parts?.length || !Array.isArray(have) || parts.some((p) => !p.diffId)) return undefined;
  const local = new Set(have);
  return parts.filter((p) => !local.has(p.diffId!)).reduce((t, p) => t + p.size, 0);
}

async function fetchRemote(ref: string): Promise<{
  digest: string;
  labels?: Record<string, string>;
  sizeBytes?: number;
  layerSizes: Record<string, number>;
  /** Each part's size with its content id, to tell which parts this server already has */
  parts?: { size: number; diffId?: string }[];
}> {
  const r = parseRef(ref);
  if (!r) throw new Error('The running image has no tag to check against.');
  const token = await registryToken(r).catch(() => undefined);
  const head = await registryGet(r, `manifests/${r.tag}`, token, MANIFEST_ACCEPT);
  if (!head.ok) throw new Error(`${r.registry} answered ${head.status} for ${r.repo}:${r.tag}.`);
  const digest = head.headers.get('docker-content-digest') || '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let manifest: any = await head.json();

  // Multi-arch index: pick this machine's platform
  if (Array.isArray(manifest.manifests)) {
    const arch = DOCKER_ARCH[process.arch] || process.arch;
    const entry =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manifest.manifests.find((m: any) => m.platform?.os === 'linux' && m.platform?.architecture === arch) ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manifest.manifests.find((m: any) => m.platform?.os === 'linux');
    if (!entry) return { digest, layerSizes: {} };
    const res = await registryGet(r, `manifests/${entry.digest}`, token, MANIFEST_ACCEPT);
    if (!res.ok) return { digest, layerSizes: {} };
    manifest = await res.json();
  }

  const layerSizes: Record<string, number> = {};
  let sizeBytes = 0;
  for (const l of manifest.layers || []) {
    layerSizes[String(l.digest).replace('sha256:', '').slice(0, 12)] = l.size || 0;
    sizeBytes += l.size || 0;
  }

  let labels: Record<string, string> | undefined;
  let diffIds: string[] | undefined;
  if (manifest.config?.digest) {
    const cfg = await registryGet(r, `blobs/${manifest.config.digest}`, token);
    if (cfg.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j: any = await cfg.json();
      labels = j.config?.Labels || undefined;
      diffIds = Array.isArray(j.rootfs?.diff_ids) ? j.rootfs.diff_ids : undefined;
    }
  }
  // The image's parts in order; the config lists their content ids in the same order
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts = (manifest.layers || []).map((l: any, i: number) => ({ size: l.size || 0, diffId: diffIds?.[i] }));
  return { digest, labels, sizeBytes: sizeBytes || undefined, layerSizes, parts };
}

/** "fix(stacks): one default location" -> "One default location" */
function cleanCommitTitle(msg: string): string {
  const first = msg.split('\n')[0].trim();
  const stripped = first.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '');
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

async function fetchReleaseNotes(
  source: string | undefined,
  from: string | undefined,
  to: string | undefined
): Promise<{ notes: ReleaseNote[]; total?: number }> {
  const m = source?.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!m || !from || !to) return { notes: [] };
  const repo = `${m[1]}/${m[2].replace(/\.git$/, '')}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/compare/${from}...${to}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Manifexus' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { notes: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const commits = (j.commits || []).filter((c: any) => (c.parents || []).length < 2);
    const notes: ReleaseNote[] = commits
      .reverse()
      .slice(0, 12)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any) => ({ sha: String(c.sha).slice(0, 7), title: cleanCommitTitle(c.commit?.message || ''), date: c.commit?.author?.date }));
    return { notes, total: commits.length };
  } catch {
    return { notes: [] };
  }
}

// ----------------------------------------------------------------------------
// Public: state & check
// ----------------------------------------------------------------------------

async function supportCheck(self: SelfInfo | null): Promise<string | undefined> {
  if (!self) return 'Manifexus isn’t running in Docker, so it can’t update itself.';
  if (!parseRef(self.imageRef)) return 'Manifexus was started from an image without a tag, so there’s nothing to check against.';
  try {
    fs.accessSync(DOCKER_SOCKET_PATH, fs.constants.W_OK);
  } catch {
    return 'The Docker socket is mounted read-only. Mount it read-write to update from here.';
  }
  return undefined;
}

export async function getSoftwareUpdateState(): Promise<SoftwareUpdateState> {
  let self: SelfInfo | null = null;
  try {
    self = await getSelf();
  } catch {
    self = null;
  }
  const unsupportedReason = await supportCheck(self);
  const current = { ...buildInfoFromLabels(self?.image?.Config?.Labels, localVersion()), imageId: self?.imageId };
  const runningDigests: string[] = self?.image?.RepoDigests || [];
  const latest = persisted.latest;
  let status: SoftwareUpdateState['status'] = 'unknown';
  if (latest?.digest) {
    const same = runningDigests.some((d) => d.endsWith(latest.digest)) || (latest.revision && latest.revision === current.revision);
    status = same ? 'up_to_date' : 'available';
  }
  return {
    supported: !unsupportedReason,
    unsupportedReason,
    imageRef: self?.imageRef,
    installMode: self ? (self.compose ? 'compose' : 'standalone') : undefined,
    current,
    status,
    latest: status === 'available' ? latest : undefined,
    lastCheckedAt: persisted.lastCheckedAt,
    currentRelease: localReleases()[0],
    pinned: persisted.policy || undefined,
    checkError: persisted.checkError,
    checking,
    installing,
    lastOutcome: persisted.lastOutcome,
    settings: persisted.settings,
  };
}

export async function checkForUpdate(): Promise<SoftwareUpdateState> {
  if (checking) return getSoftwareUpdateState();
  checking = true;
  try {
    const self = await getSelf();
    if (!self || !parseRef(self.imageRef)) {
      persisted.checkError = (await supportCheck(self)) || 'Can’t check for updates.';
    } else {
      const remote = await fetchRemote(self.imageRef);
      const currentLabels = self.image?.Config?.Labels || {};
      const running = (self.image?.RepoDigests || []).some((d: string) => d.endsWith(remote.digest));
      const source = remote.labels?.['org.opencontainers.image.source'] || currentLabels['org.opencontainers.image.source'];
      // Friendly notes from the offered build's release-notes.json (commit titles are the fallback)
      const theirs = running ? null : await remoteReleases(source, remote.labels?.['org.opencontainers.image.revision']);
      const latestBuild = buildInfoFromLabels(remote.labels, running ? localVersion() : theirs?.[0]?.version);
      const releases = theirs ? releasesSince(theirs, localVersion()) : [];
      const notes =
        running || !latestBuild.revision || releases.length
          ? { notes: [] as ReleaseNote[] }
          : await fetchReleaseNotes(
              remote.labels?.['org.opencontainers.image.source'] || currentLabels['org.opencontainers.image.source'],
              currentLabels['org.opencontainers.image.revision'],
              remote.labels?.['org.opencontainers.image.revision']
            );
      persisted.latest = {
        ...latestBuild,
        digest: remote.digest,
        sizeBytes: remote.sizeBytes,
        downloadBytes: neededDownload(remote.parts, self.image),
        notes: notes.notes,
        totalCommits: notes.total,
        releases,
      };
      layerSizesCache = remote.layerSizes;
      persisted.checkError = undefined;
    }
  } catch (err) {
    persisted.checkError = `Couldn’t reach the update server. ${(err as Error).message}`;
  } finally {
    persisted.lastCheckedAt = new Date().toISOString();
    checking = false;
    savePersisted(persisted);
  }
  const st = await getSoftwareUpdateState();
  record(st.checkError ? 'warn' : 'info', 'update', st.checkError ? `Update check failed: ${st.checkError}` : st.status === 'available' ? `Update available: ${st.latest?.label}` : `Up to date (${st.current.label})`, {
    status: st.status,
    current: st.current,
    latest: st.latest,
    error: st.checkError,
  });
  if (st.checkError && currentActivityId()) finishActivity(currentActivityId(), 'failed', { message: st.checkError });
  return st;
}

export function updateSettings(s: Partial<UpdateSettings>): UpdateSettings {
  persisted.settings = {
    autoCheck: typeof s.autoCheck === 'boolean' ? s.autoCheck : persisted.settings.autoCheck,
    autoInstall: typeof s.autoInstall === 'boolean' ? s.autoInstall : persisted.settings.autoInstall,
  };
  savePersisted(persisted);
  return persisted.settings;
}

// ----------------------------------------------------------------------------
// Install
// ----------------------------------------------------------------------------

let layerSizesCache: Record<string, number> = {};

/**
 * Something that mustn't be cut off by a restart is running (a move, restore or delete). Set by the server;
 * an update waits for it before restarting Manifexus.
 */
let busyCheck: () => string | null = () => null;
export function setUpdateBusyCheck(fn: () => string | null) {
  busyCheck = fn;
}

let clearTimer: ReturnType<typeof setTimeout> | undefined;
function emit(p: UpdateProgress) {
  installing = p;
  // A finished or failed install is shown for a while, then forgotten, so the next one (or the nightly
  // automatic install) can start again
  clearTimeout(clearTimer);
  if (p.stage === 'error' || p.stage === 'done') {
    clearTimer = setTimeout(() => {
      if (!installRun && installing === p) installing = undefined;
    }, 2 * 60 * 1000);
  }
  for (const l of installListeners) {
    try {
      l(p);
    } catch {
      // ignore
    }
  }
}

/** Pulls an image through the Docker API, streaming per-layer progress. */
function pullImage(ref: string, onProgress: (done: number, total: number) => void): Promise<void> {
  const r = parseRef(ref)!;
  const repoPath = r.registry === 'registry-1.docker.io' ? r.repo.replace(/^library\//, '') : `${r.registry}/${r.repo}`;
  const layers = new Map<string, { total: number; downloaded: number; extracted: number; extracting: boolean; done: boolean; present: boolean }>();
  const known = layerSizesCache;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET_PATH,
        path: `/images/create?fromImage=${encodeURIComponent(repoPath)}&tag=${encodeURIComponent(r.tag)}`,
        method: 'POST',
        headers: { Host: 'docker' },
      },
      (res) => {
        if ((res.statusCode || 500) >= 400) {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => reject(new Error(`Download failed (${res.statusCode}): ${body.slice(0, 200)}`)));
          return;
        }
        let buf = '';
        let failed: string | undefined;
        let lastEmit = 0;
        // One fixed total: the size of the parts that really need downloading (parts already on the server
        // don't count), settled once Docker has listed every part and the download has begun, and never
        // changed after that. Until then no total is shown rather than one that keeps growing.
        let fixedTotal = 0;
        let started = false;
        const report = (force = false) => {
          const now = Date.now();
          if (!force && now - lastEmit < 250) return;
          lastEmit = now;
          const needed = [...layers.values()].filter((l) => !l.present);
          if (!fixedTotal && started && needed.every((l) => l.total > 0)) fixedTotal = needed.reduce((t, l) => t + l.total, 0);
          if (!fixedTotal) return onProgress(0, 0);
          let done = 0;
          for (const l of needed) {
            // 80% weight on download, 20% on unpacking
            done += l.done ? l.total : l.total * (0.8 * Math.min(1, l.downloaded / l.total) + 0.2 * (l.extracting ? Math.min(1, l.extracted) : 0));
          }
          onProgress(Math.min(done, fixedTotal), fixedTotal);
        };
        res.on('data', (chunk) => {
          buf += chunk.toString();
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const ev = JSON.parse(line);
              if (ev.error) failed = ev.error;
              const id: string | undefined = ev.id;
              if (!id || !/^[0-9a-f]{12}$/.test(id)) continue;
              if (!layers.has(id)) layers.set(id, { total: known[id] || 0, downloaded: 0, extracted: 0, extracting: false, done: false, present: false });
              const l = layers.get(id)!;
              const status = String(ev.status || '');
              if (status === 'Already exists') {
                l.present = true;
                l.done = true;
              } else if (status === 'Downloading') {
                started = true;
                l.downloaded = ev.progressDetail?.current || l.downloaded;
                // The download size (compressed), never the unpacked size
                if (!l.total && ev.progressDetail?.total) l.total = ev.progressDetail.total;
              } else if (status === 'Download complete' || status === 'Verifying Checksum') {
                started = true;
                l.downloaded = l.total;
              } else if (status === 'Extracting') {
                started = true;
                l.downloaded = l.total;
                l.extracting = true;
                // Unpacking is reported in its own (unpacked) bytes: keep it as a fraction
                if (ev.progressDetail?.total) l.extracted = (ev.progressDetail.current || 0) / ev.progressDetail.total;
              } else if (status === 'Pull complete') {
                l.done = true;
              }
              report();
            } catch {
              // partial line
            }
          }
        });
        res.on('end', () => {
          report(true);
          if (failed) reject(new Error(failed));
          else resolve();
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Create payload that recreates this container exactly, but from the new image. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cloneCreatePayload(self: SelfInfo): any {
  const cfg = { ...(self.inspect.Config || {}) };
  const imgCfg = self.image?.Config || {};
  // Drop values that only came from the old image so the new image's defaults apply
  const imgEnv = new Set<string>(imgCfg.Env || []);
  cfg.Env = (cfg.Env || []).filter((e: string) => !imgEnv.has(e));
  const imgLabels = imgCfg.Labels || {};
  cfg.Labels = Object.fromEntries(
    Object.entries(cfg.Labels || {}).filter(([k, v]) => imgLabels[k] !== v)
  );
  for (const key of ['Cmd', 'Entrypoint', 'WorkingDir', 'Healthcheck', 'User', 'StopSignal'] as const) {
    if (JSON.stringify(cfg[key]) === JSON.stringify(imgCfg[key])) delete cfg[key];
  }
  if (cfg.Hostname && self.id.startsWith(cfg.Hostname)) delete cfg.Hostname;
  delete cfg.Image;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const endpoints: Record<string, any> = {};
  for (const [net, ep] of Object.entries(self.inspect.NetworkSettings?.Networks || {})) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = ep as any;
    endpoints[net] = {
      Aliases: (e.Aliases || []).filter((a: string) => !self.id.startsWith(a)),
      IPAMConfig: e.IPAMConfig || undefined,
      Links: e.Links || undefined,
    };
  }
  return { ...cfg, Image: self.imageRef, HostConfig: keepVolumes(self), NetworkingConfig: { EndpointsConfig: endpoints } };
}

/**
 * The new container gets the same folders. Docker only lists folders you set up yourself in
 * HostConfig; a data folder it created on its own (an unnamed volume for /data or /app/backups)
 * would be left behind, losing settings, history, backups and downloaded AI models. Carry those over.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function keepVolumes(self: SelfInfo): any {
  const hc = { ...(self.inspect.HostConfig || {}) };
  const covered = new Set<string>([
    ...((hc.Binds as string[]) || []).map((b) => b.split(':')[1]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(((hc.Mounts as any[]) || []).map((m) => m.Target)),
  ]);
  const extra: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of (self.inspect.Mounts || []) as any[]) {
    if (m.Type === 'volume' && m.Name && !covered.has(m.Destination)) extra.push(`${m.Name}:${m.Destination}`);
  }
  if (extra.length) hc.Binds = [...((hc.Binds as string[]) || []), ...extra];
  return hc;
}

function mountSource(self: SelfInfo, destination: string): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = (self.inspect.Mounts || []).find((x: any) => x.Destination === destination);
  if (!m) return undefined;
  return m.Type === 'volume' ? m.Name : m.Source;
}

const WAIT_HEALTHY = `
wait_healthy() {
  n=0; ok=0
  while [ $n -lt 150 ]; do
    s=$(docker inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CNAME" 2>/dev/null || echo missing)
    case "$s" in
      running\\|healthy) return 0 ;;
      running\\|) ok=$((ok+1)); [ $ok -ge 8 ] && return 0 ;;
      running\\|starting) ok=0 ;;
      *unhealthy*|exited*|dead*|missing) [ $n -gt 5 ] && return 1 ;;
    esac
    n=$((n+1)); sleep 1
  done
  return 1
}
result() {
  printf '{"job":"%s","status":"%s","message":"%s","finishedAt":"%s"}' "$JOB" "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /mfx-data/update-result.json 2>/dev/null || true
}
`;

/**
 * Records the job and starts the helper that swaps Manifexus onto the new image, verifies it, and
 * rolls back if it doesn't come up. After this returns, the helper will stop this process.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function startRestartHelper(self: SelfInfo, pulled: any, toVersion?: string): Promise<string> {
  const job = `upd_${Date.now().toString(36)}`;
  const fromLabel = buildInfoFromLabels(self.image?.Config?.Labels, localVersion()).label;
  const toRevision = shortSha(pulled.Config?.Labels?.['org.opencontainers.image.revision']);
  const toLabel = buildInfoFromLabels(pulled.Config?.Labels, toVersion || (persisted.latest?.revision === toRevision ? persisted.latest?.version : undefined)).label;
  const cur = localVersion();
  const back = !!(toVersion && cur && compareVersions(toVersion, cur) < 0);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    JOB_FILE,
    JSON.stringify({
      job,
      activityId: currentActivityId(),
      from: fromLabel,
      to: toLabel,
      fromImageId: self.imageId,
      toImageId: pulled.Id,
      startedAt: new Date().toISOString(),
    })
  );
  try {
    fs.unlinkSync(RESULT_FILE);
  } catch {
    // none
  }

  const socketSource = mountSource(self, DOCKER_SOCKET_PATH) || '/var/run/docker.sock';
  const dataSource = mountSource(self, '/data');
  const binds = [`${socketSource}:/var/run/docker.sock`];
  if (dataSource) binds.push(`${dataSource}:/mfx-data`);

  // TO_IMAGE becomes the image Manifexus runs from (for an update it already is; going back, it's the earlier
  // version's image), and the new container must really be running it before the change counts as done
  const env = [`CNAME=${self.name}`, `JOB=${job}`, `IMAGE_REF=${self.imageRef}`, `FROM_IMAGE=${self.imageId}`, `TO_IMAGE=${pulled.Id}`];
  let script: string;
  if (self.compose) {
    const dirs = new Set<string>([self.compose.workingDir, ...self.compose.configFiles.map((f) => path.posix.dirname(f))]);
    for (const d of dirs) binds.push(`${d}:${d}`);
    const files = self.compose.configFiles.map((f) => `-f ${sh(f)}`).join(' ');
    const up = `docker compose -p ${sh(self.compose.project)} ${files} up -d --no-deps --force-recreate ${sh(self.compose.service)}`;
    script = `${WAIT_HEALTHY}
sleep 2
cd ${sh(self.compose.workingDir)} || { result failed "Compose folder not found"; exit 1; }
docker tag "$TO_IMAGE" "$IMAGE_REF" || { result failed "The new version couldn't be prepared"; exit 1; }
if ${up} && wait_healthy && [ "$(docker inspect -f '{{.Image}}' "$CNAME" 2>/dev/null)" = "$TO_IMAGE" ]; then
result success "${back ? `Went back to ${toLabel}` : `Updated to ${toLabel}`}"
else
docker tag "$FROM_IMAGE" "$IMAGE_REF"
${up}
result rolled_back "${back ? `${toLabel} didn't start, so you're still on ${fromLabel}.` : `The new version didn't start, so ${fromLabel} was restored.`}"
fi`;
  } else {
    env.push(`CREATE_B64=${Buffer.from(JSON.stringify(cloneCreatePayload(self))).toString('base64')}`);
    script = `${WAIT_HEALTHY}
sleep 2
docker tag "$TO_IMAGE" "$IMAGE_REF" || { result failed "The new version couldn't be prepared"; exit 1; }
echo "$CREATE_B64" | base64 -d > /tmp/create.json
docker stop -t 20 "$CNAME" >/dev/null 2>&1
docker rm -f "$CNAME-previous" >/dev/null 2>&1
docker rename "$CNAME" "$CNAME-previous"
if curl -sf --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -d @/tmp/create.json "http://localhost/containers/create?name=$CNAME" >/dev/null \\
 && docker start "$CNAME" >/dev/null && wait_healthy; then
docker rm -f "$CNAME-previous" >/dev/null 2>&1
result success "${back ? `Went back to ${toLabel}` : `Updated to ${toLabel}`}"
else
docker rm -f "$CNAME" >/dev/null 2>&1
docker rename "$CNAME-previous" "$CNAME"
docker start "$CNAME" >/dev/null
docker tag "$FROM_IMAGE" "$IMAGE_REF"
result rolled_back "${back ? `${toLabel} didn't start, so you're still on ${fromLabel}.` : `The new version didn't start, so ${fromLabel} was restored.`}"
fi`;
  }

  // 3. Restart — the helper runs the *current* image, which has the Docker CLI and curl
  record('info', 'update', `Handing over to the restart helper (${self.compose ? 'docker compose' : 'docker run clone'})`, {
    job,
    from: fromLabel,
    to: toLabel,
    fromImageId: self.imageId,
    toImageId: pulled.Id,
    binds,
    env: env.map((e) => (e.startsWith('CREATE_B64=') ? 'CREATE_B64=[container definition]' : e)),
    script,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const helper = await queryDockerEngine<any>('/containers/create', 'POST', {
    Image: self.imageId,
    Entrypoint: ['sh', '-c'],
    Cmd: [script],
    Env: env,
    User: '0:0',
    Labels: { 'dev.manifexus.update-job': job },
    // json-file so its output can be read back for the update's record, whatever the daemon default is
    HostConfig: { Binds: binds, LogConfig: { Type: 'json-file', Config: {} } },
  });
  await queryDockerEngine(`/containers/${helper.Id}/start`, 'POST');
  return job;
}

/**
 * Downloads and installs the latest image, then hands off to a helper that restarts Manifexus.
 * Progress goes to `listener` (and to anyone polling the state).
 */
let installRun: Promise<void> | null = null;

/**
 * Updates to the newest version; `version` (only ever from the developer's policy) installs that version
 * instead. Throws before anything starts when that version can't be installed from here.
 */
export async function installUpdate(listener?: (p: UpdateProgress) => void, version?: string): Promise<{ joined: boolean }> {
  if (version) {
    const why = forcedVersionProblem(version);
    if (why) throw new Error(why);
    if (installRun || installing?.stage === 'restart') throw new Error('An update is installing right now. Try again once it’s done.');
  } else if (persisted.policy) {
    throw new Error(`Updates are paused: Manifexus’s developer is keeping every server on ${persisted.policy.version} for now.`);
  }
  if (listener) installListeners.push(listener);
  // Already installing: follow that install's progress until it finishes instead of starting another
  if (installRun) {
    try {
      await installRun;
    } finally {
      if (listener) installListeners = installListeners.filter((l) => l !== listener);
    }
    return { joined: true };
  }
  // Already handed off to the restart helper: Manifexus is about to restart with the new version
  if (installing && installing.stage === 'restart') {
    if (listener) {
      listener(installing);
      installListeners = installListeners.filter((l) => l !== listener);
    }
    return { joined: true };
  }
  installRun = runInstall(version);
  try {
    await installRun;
  } finally {
    installRun = null;
    if (listener) installListeners = installListeners.filter((l) => l !== listener);
  }
  return { joined: false };
}

/** The same image Manifexus runs from, at another tag: ghcr.io/x/manifexus:latest -> ghcr.io/x/manifexus:3.3.0 */
export function imageRefWithTag(ref: string, tag: string): string {
  const base = ref.split('@')[0];
  const slash = base.lastIndexOf('/');
  const colon = base.lastIndexOf(':');
  return `${colon > slash ? base.slice(0, colon) : base}:${tag}`;
}

/**
 * Before going back: a copy of Manifexus's own settings and records (the .json files in its data folder),
 * kept in before-going-back/ (the newest 5), so nothing the earlier version does to them is lost.
 */
function saveSettingsCopy(fromVersion: string | undefined, toVersion: string): string {
  const dir = path.join(DATA_DIR, 'before-going-back', `${new Date().toISOString().replace(/[:.]/g, '-')}_${fromVersion || 'unknown'}-to-${toVersion}`);
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(DATA_DIR)) {
    const p = path.join(DATA_DIR, f);
    if (f.endsWith('.json') && fs.statSync(p).isFile()) {
      fs.copyFileSync(p, path.join(dir, f));
      n++;
    }
  }
  const parent = path.dirname(dir);
  const all = fs.readdirSync(parent).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 5))) fs.rmSync(path.join(parent, old), { recursive: true, force: true });
  record('info', 'update', `Saved ${n} settings files before going back to ${toVersion}`, { folder: dir });
  return dir;
}

async function runInstall(version?: string): Promise<void> {
  const what = version ? `Downloading ${version}…` : 'Downloading update…';
  try {
    const self = await getSelf();
    const reason = await supportCheck(self);
    if (reason || !self) throw new Error(reason || 'Can’t update.');
    const source = version ? imageRefWithTag(self.imageRef, fullVersion(version)) : self.imageRef;

    // 1. Download
    emit({ stage: 'download', percent: 0, message: what, fromImageId: self.imageId });
    if (version || !Object.keys(layerSizesCache).length) {
      try {
        layerSizesCache = (await fetchRemote(source)).layerSizes;
      } catch (err) {
        // Going back: the earlier version's image must exist before anything is downloaded
        if (version) throw new Error(`${version} can’t be downloaded right now. ${(err as Error).message}`);
        // progress falls back to sizes Docker reports
      }
    }
    await pullImage(source, (done, total) => {
      emit({
        stage: 'download',
        percent: total ? Math.min(99, Math.round((done / total) * 100)) : undefined,
        bytesDone: Math.round(done),
        bytesTotal: total || undefined,
        message: what,
        fromImageId: self.imageId,
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pulled = await queryDockerEngine<any>(`/images/${encodeURIComponent(source)}/json`);
    if (pulled.Id === self.imageId) {
      emit({ stage: 'done', percent: 100, message: version ? `Manifexus is already on ${version}.` : 'Manifexus is already up to date.', toImageId: pulled.Id, fromImageId: self.imageId });
      await checkForUpdate();
      return;
    }

    // Never restart in the middle of a move, restore or delete: wait for it to finish (up to 2 hours)
    for (const until = Date.now() + 2 * 60 * 60 * 1000; ; ) {
      const busy = busyCheck();
      if (!busy) break;
      if (Date.now() > until) throw new Error(`Not installed: ${busy} is still running. Try again when it’s done.`);
      emit({ stage: 'prepare', percent: 100, message: `Downloaded. Waiting for ${busy} to finish before restarting…`, toImageId: pulled.Id, fromImageId: self.imageId });
      await new Promise((r) => setTimeout(r, 5000));
    }

    // 2. Prepare + 3. Restart
    emit({ stage: 'prepare', percent: 100, message: 'Preparing to restart…', toImageId: pulled.Id, fromImageId: self.imageId });
    if (version) {
      const current = localVersion();
      if (current && compareVersions(version, current) < 0) saveSettingsCopy(current, version);
      // What's on offer is worked out again by the version installed, against itself
      persisted.latest = undefined;
      persisted.lastCheckedAt = undefined;
      savePersisted(persisted);
    }
    await startRestartHelper(self, pulled, version);
    emit({ stage: 'restart', percent: 100, message: 'Restarting Manifexus…', toImageId: pulled.Id, fromImageId: self.imageId });
    // From here the helper stops this process and starts the new version.
  } catch (err) {
    emit({ stage: 'error', message: (err as Error).message });
    globalLogService.log({ level: 'ERROR', source: 'update', message: 'Update failed', error: err });
  }
}

// ----------------------------------------------------------------------------
// Startup + scheduler
// ----------------------------------------------------------------------------

/** Called at startup: records the outcome of an update the previous instance started. */
/** The activity of an update the previous instance started (it stays open across the restart). */
export function pendingUpdateActivityId(): string | undefined {
  try {
    return JSON.parse(fs.readFileSync(JOB_FILE, 'utf8')).activityId || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Called at startup: records the outcome of an update the previous instance started, attaches the
 * restart helper's full output to that update's activity, and closes it.
 */
export async function recordFinishedUpdate(): Promise<void> {
  let job: { job: string; activityId?: string; from?: string; to?: string; toImageId?: string } | undefined;
  try {
    if (!fs.existsSync(JOB_FILE)) return;
    job = JSON.parse(fs.readFileSync(JOB_FILE, 'utf8'));
    fs.unlinkSync(JOB_FILE);
  } catch {
    return;
  }
  if (!job) return;
  const readResult = () => {
    try {
      const r = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
      return r && r.job === job!.job ? (r as { job?: string; status?: string; message?: string; finishedAt?: string }) : undefined;
    } catch {
      return undefined;
    }
  };
  const helperOutput = async () => {
    try {
      const filters = encodeURIComponent(JSON.stringify({ label: [`dev.manifexus.update-job=${job!.job}`] }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = await queryDockerEngine<any[]>(`/containers/json?all=1&filters=${filters}`);
      const h = (list || [])[0];
      if (!h) return undefined;
      const out = await fetchContainerLogs(h.Id);
      return { container: String(h.Id).slice(0, 12), state: h.State, output: out.combined };
    } catch {
      return undefined;
    }
  };
  const settle = async (final: boolean) => {
    const result = readResult();
    if (!result && !final) return false;
    // No result from the helper: judge by what's actually running
    let running: string | undefined;
    if (!result) {
      try {
        running = (await getSelf())?.imageId;
      } catch {
        running = undefined;
      }
    }
    const noResultOk = !result && (!job!.toImageId || !running || running === job!.toImageId);
    const status = result
      ? result.status === 'rolled_back'
        ? 'rolled_back'
        : result.status === 'failed'
          ? 'failed'
          : 'success'
      : noResultOk
        ? 'success'
        : 'failed';
    persisted.lastOutcome = {
      status,
      from: job!.from,
      to: job!.to,
      message: result?.message || (status === 'success' ? `Updated to ${job!.to}` : 'The update didn’t take effect: Manifexus is still running the previous version.'),
      finishedAt: result?.finishedAt || new Date().toISOString(),
    };
    savePersisted(persisted);
    const helper = await helperOutput();
    record(status === 'success' ? 'info' : 'error', 'update', `Restart helper finished: ${persisted.lastOutcome.message}`, {
      result: result || { note: 'The restart helper left no result file', runningImage: running, expectedImage: job!.toImageId },
      helper,
    }, { activityId: job!.activityId || null });
    if (job!.activityId) {
      finishActivity(
        job!.activityId,
        status === 'success' ? 'succeeded' : status === 'rolled_back' ? 'rolled_back' : 'failed',
        status === 'success' ? undefined : { message: persisted.lastOutcome.message, detail: helper?.output }
      );
    }
    return true;
  };
  // The helper writes its result after the new container is confirmed healthy, which can be a
  // moment after this process starts. Re-check for a while before assuming success.
  if (!(await settle(false))) {
    // One check at a time (a slow check must not overlap the next one)
    void (async () => {
      for (let tries = 1; tries <= 12; tries++) {
        await new Promise((r) => setTimeout(r, 10 * 1000));
        if (await settle(tries >= 12)) return;
      }
    })();
  }
}

// ----------------------------------------------------------------------------
// The developer's chosen version (update-policy.json)
// ----------------------------------------------------------------------------

/** The first version that reads the policy: going back below it would strand servers there */
export const FIRST_POLICY_VERSION = '3.4';
const POLICY_FILE = 'update-policy.json';
const POLICY_BRANCH = 'main';

/** Why `version` can't be installed as the developer's choice from this version (null when it can) */
export function forcedVersionProblem(version: string, current: string | undefined = localVersion()): string | null {
  if (!/^\d+(\.\d+){0,2}$/.test(version)) return `${version} isn’t a Manifexus version.`;
  if (!current) return 'This build has no version number.';
  const c = compareVersions(version, current);
  if (c === 0) return `Manifexus is already on ${version}.`;
  if (c > 0) return null;
  if (compareVersions(version, FIRST_POLICY_VERSION) < 0) return `Manifexus can’t go back before ${FIRST_POLICY_VERSION}.`;
  return canGoBackTo(version);
}

/**
 * Reads update-policy.json from the GitHub repo this build came from. Null when no version is set; undefined
 * when it couldn't be read (then the last policy read stays in force).
 */
async function fetchPolicy(source: string | undefined): Promise<UpdatePolicy | null | undefined> {
  const m = source?.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!m) return undefined;
  const repo = `${m[1]}/${m[2].replace(/\.git$/, '')}`;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${POLICY_BRANCH}/${POLICY_FILE}?t=${Date.now()}`, {
      headers: { 'User-Agent': 'Manifexus', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await res.json();
    const version = typeof j?.version === 'string' ? j.version.trim() : '';
    if (!version) return null;
    return { version, message: typeof j.message === 'string' && j.message.trim() ? j.message.trim() : undefined };
  } catch {
    return undefined;
  }
}

/** Reads the policy and, when it names another version this one may install, installs it */
export async function applyPolicy(source?: string): Promise<void> {
  let self: SelfInfo | null = null;
  if (!source) {
    try {
      self = await getSelf();
    } catch {
      self = null;
    }
    source = self?.image?.Config?.Labels?.['org.opencontainers.image.source'];
  }
  const p = await fetchPolicy(source);
  if (p !== undefined && JSON.stringify(p) !== JSON.stringify(persisted.policy ?? null)) {
    persisted.policy = p;
    savePersisted(persisted);
    record('info', 'update', p ? `Manifexus’s developer set every server to ${p.version}` : 'Manifexus’s developer cleared the chosen version: ordinary updates resume', { policy: p });
  }
  const want = persisted.policy?.version;
  if (!want) return;
  const why = forcedVersionProblem(want);
  if (why) {
    // Already there (the usual case), or a version this one can't go to: stays put
    if (!/already on/.test(why)) record('warn', 'update', `Not installing ${want}, chosen by the developer: ${why}`);
    return;
  }
  if (installRun || installing?.stage === 'restart' || busyCheck()) return; // tries again on the next tick
  const me = self || (await getSelf().catch(() => null));
  if (await supportCheck(me)) return;
  const a = startActivity({ type: 'update', title: `Install Manifexus ${want} (chosen by the developer)`, actor: { kind: 'system' } });
  const rec = pipelineRecorder(a.id);
  void runInActivity(a.id, () => installUpdate(rec.onEvent, want)).finally(() => rec.finish());
}

export async function startUpdateScheduler(): Promise<void> {
  await recordFinishedUpdate();
  const tick = async () => {
    // The developer's chosen version comes first, whatever the settings say
    await applyPolicy().catch(() => {});
    const s = persisted.settings;
    const due = !persisted.lastCheckedAt || Date.now() - new Date(persisted.lastCheckedAt).getTime() >= CHECK_INTERVAL_MS;
    if ((s.autoCheck || s.autoInstall) && due) {
      await withActivity({ type: 'update', title: 'Automatic update check', actor: { kind: 'system' }, meta: { background: true } }, () => checkForUpdate()).catch(() => {});
    }
    if (s.autoInstall && !persisted.policy && new Date().getHours() === AUTO_INSTALL_HOUR) {
      const st = await getSoftwareUpdateState();
      // Not while another install runs, nor while a move, restore or delete is in progress (it tries again later)
      if (st.supported && st.status === 'available' && !installRun && installing?.stage !== 'restart' && !busyCheck()) {
        const a = startActivity({ type: 'update', title: 'Automatic update install', actor: { kind: 'system' } });
        const rec = pipelineRecorder(a.id);
        void runInActivity(a.id, () => installUpdate(rec.onEvent)).finally(() => rec.finish());
      }
    }
  };
  setTimeout(() => void tick(), 45 * 1000);
  // Every 15 minutes, so a version the developer sets reaches every server quickly
  setInterval(() => void tick(), 15 * 60 * 1000);
}


/** Internal hooks for tests. */
export const __test = {
  fetchRemote,
  fetchReleaseNotes,
  pullImage,
  parseRef,
  imageRefWithTag,
  saveSettingsCopy,
  fetchPolicy,
  setPolicy: (p: UpdatePolicy | null) => {
    persisted.policy = p;
  },
  setLayerSizes: (s: Record<string, number>) => {
    layerSizesCache = s;
  },
};
