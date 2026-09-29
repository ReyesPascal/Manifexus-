/**
 * Who an app is, beyond its container: which port is its web page, where its project lives on
 * GitHub (and its latest release), and its real icon.
 *
 * Everything here is looked up in the background and remembered in /data/apps (icons are saved
 * as files), so the dashboard never waits on the network and it all works offline afterwards.
 *
 * - Web page: each published TCP port of a running app is asked for "/" once in a while. The one
 *   that answers with a web page (or a login redirect) is what Open opens.
 * - Project page: the image's own label (org.opencontainers.image.source), mapped from
 *   LinuxServer's wrapper repos to the real project, or ghcr.io/<owner>/<repo> when that exists.
 * - Icon: the community icon sets (dashboard-icons, selfh.st) by the app's name, then the icon the
 *   app's own web page uses, then the GitHub organization's picture when it's the app's own.
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import type { DeepContainerMetadata } from '../src/types';

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data');
const DIR = path.join(DATA_DIR, 'apps');
const ICON_DIR = path.join(DIR, 'icons');
const STATE_FILE = path.join(DIR, 'identity.json');

const HOUR = 60 * 60 * 1000;
const PROBE_EVERY = 30 * 60 * 1000;
const PROBE_FAILED_EVERY = 3 * 60 * 1000;
const PROJECT_EVERY = 24 * HOUR;
const RELEASE_EVERY = 6 * HOUR;
const ICON_RETRY = 24 * HOUR;

interface PortProbe {
  web: boolean;
  /** false when nothing answered at all (can't tell: maybe a firewall) */
  reached?: boolean;
  /** How it was reached, e.g. http://172.18.0.5:8080 */
  base?: string;
  title?: string;
  icons?: string[];
  at: number;
}

export interface ProjectInfo {
  /** https://github.com/owner/repo of the app itself */
  url?: string;
  /** owner/repo */
  repo?: string;
  /** Where the image is built, when that's a different repo (e.g. linuxserver/docker-sonarr) */
  imageSource?: string;
  /** Latest release tag, e.g. v4.0.9 */
  latest?: string;
  latestAt?: number;
  at: number;
}

interface IconInfo {
  file?: string;
  source?: string;
  /** The app's web page had been checked when this lookup ran */
  hadProbes?: boolean;
  at: number;
}

interface State {
  probes: Record<string, PortProbe>;
  projects: Record<string, ProjectInfo>;
  icons: Record<string, IconInfo>;
}

let state: State = { probes: {}, projects: {}, icons: {} };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
} catch {
  // first run
}

let saveTimer: NodeJS.Timeout | undefined;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch {
      // best effort
    }
  }, 1500);
}

// ----------------------------------------------------------------------------
// Small HTTP helper (follows redirects, returns the first bytes)
// ----------------------------------------------------------------------------

interface Got {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  url: string;
}

function get(url: string, opts: { timeoutMs?: number; maxBytes?: number; method?: string; follow?: number } = {}): Promise<Got> {
  const { timeoutMs = 4000, maxBytes = 256 * 1024, method = 'GET', follow = 3 } = opts;
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method, timeout: timeoutMs, headers: { 'User-Agent': 'Manifexus', Accept: '*/*' }, rejectUnauthorized: false },
      (res) => {
        const status = res.statusCode || 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc && follow > 0) {
          res.resume();
          const next = new URL(loc, u).toString();
          // A redirect to a login page on the same app still counts as the app's web page
          get(next, { ...opts, follow: follow - 1 })
            .then(resolve)
            .catch(() => resolve({ status, headers: res.headers, body: Buffer.alloc(0), url: next }));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= maxBytes) chunks.push(c);
          else res.destroy();
        });
        const done = () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks), url: u.toString() });
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

// ----------------------------------------------------------------------------
// Web page detection
// ----------------------------------------------------------------------------

let hostCandidates: string[] = [];
/** Addresses that reach the server's published ports from inside Manifexus */
export function setHostCandidates(list: string[]) {
  hostCandidates = Array.from(new Set(list.filter(Boolean)));
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? m[2] ?? m[3] ?? m[4] : undefined;
}

/** Icons a page links to, best first (apple-touch-icon and big or SVG icons before tiny favicons) */
function pageIcons(html: string, base: string): string[] {
  const found: { url: string; score: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    if (!/icon/.test(rel)) continue;
    const href = attr(tag, 'href');
    if (!href || href.startsWith('data:')) continue;
    const sizes = attr(tag, 'sizes') || '';
    const px = Math.max(0, ...sizes.split(/\s+/).map((s) => parseInt(s, 10) || 0));
    const type = attr(tag, 'type') || '';
    let score = px || 32;
    if (rel.includes('apple-touch-icon')) score += 200;
    if (/svg/.test(type) || /\.svg(\?|$)/i.test(href)) score += 150;
    if (rel.includes('mask-icon')) score -= 300; // single-colour outlines
    try {
      found.push({ url: new URL(href, base).toString(), score });
    } catch {
      // bad href
    }
  }
  found.sort((a, b) => b.score - a.score);
  const urls = found.map((f) => f.url);
  urls.push(new URL('/favicon.ico', base).toString());
  return Array.from(new Set(urls));
}

async function probePort(c: DeepContainerMetadata, privatePort: number, publicPort: number): Promise<PortProbe> {
  const bases = [
    ...(c.ipAddress ? [`http://${c.ipAddress}:${privatePort}`] : []),
    ...hostCandidates.map((h) => `http://${h}:${publicPort}`),
  ];
  for (const base of bases) {
    for (const scheme of ['http', 'https']) {
      const b = scheme === 'https' ? base.replace(/^http:/, 'https:') : base;
      try {
        const r = await get(b + '/', { timeoutMs: 2500, maxBytes: 128 * 1024 });
        const type = String(r.headers['content-type'] || '');
        const text = r.body.toString('utf8');
        const html = /html/i.test(type) || /<html|<!doctype html/i.test(text.slice(0, 2000));
        const web = r.status > 0 && r.status < 500 && (html || r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400));
        if (!r.status) continue;
        const title = text.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim();
        return { web, reached: true, base: b, title, icons: html ? pageIcons(text, r.url) : undefined, at: Date.now() };
      } catch (e) {
        // Something answered, but not with HTTP (a database, a game server…): not a web page
        const code = String((e as NodeJS.ErrnoException).code || '');
        if (code.startsWith('HPE_') || /parse error/i.test((e as Error).message)) return { web: false, reached: true, at: Date.now() };
        // otherwise try the next way in
      }
    }
  }
  return { web: false, reached: false, at: Date.now() };
}

const probing = new Set<string>();
const probeKey = (c: DeepContainerMetadata, privatePort: number) => `${c.cleanName}:${privatePort}`;

/** Check the apps' ports in the background (a few at a time); results show on the next refresh */
export function refreshProbes(containers: DeepContainerMetadata[]) {
  const jobs: (() => Promise<void>)[] = [];
  for (const c of containers) {
    if (c.state !== 'running') continue;
    for (const p of c.ports) {
      if (p.type !== 'tcp' || !p.publicPort) continue;
      const k = probeKey(c, p.privatePort);
      const prev = state.probes[k];
      const age = prev ? Date.now() - prev.at : Infinity;
      if (probing.has(k) || age < (prev?.web ? PROBE_EVERY : PROBE_FAILED_EVERY)) continue;
      probing.add(k);
      jobs.push(async () => {
        try {
          state.probes[k] = await probePort(c, p.privatePort, p.publicPort!);
          save();
        } finally {
          probing.delete(k);
        }
      });
    }
  }
  void runLimited(jobs, 4);
}

async function runLimited(jobs: (() => Promise<void>)[], n: number) {
  const queue = jobs.slice();
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      for (let j = queue.shift(); j; j = queue.shift()) await j().catch(() => undefined);
    })
  );
}

export interface WebInfo {
  /** The port Open uses (published port) */
  port?: number;
  /** Other published ports that answer with a web page */
  others: number[];
  /** false when every port was checked and none is a web page */
  hasWeb?: boolean;
  /** The page's title, e.g. "Sonarr" */
  title?: string;
}

/** Which port is the app's web page, from what the checks found (falls back to the port scoring) */
export function webInfo(c: DeepContainerMetadata): WebInfo {
  const published = c.ports.filter((p) => p.type === 'tcp' && p.publicPort);
  const seen = published.map((p) => ({ p, probe: state.probes[probeKey(c, p.privatePort)] }));
  const web = seen.filter((s) => s.probe?.web);
  // Keep the scorer's order among the ones that answered (it knows qBittorrent's 8080 from its peer port)
  const order = (port?: number) => {
    const i = c.ports.findIndex((p) => p.publicPort === port);
    return c.primaryPort === port ? -1 : i;
  };
  if (web.length) {
    const sorted = web.map((s) => s.p.publicPort!).sort((a, b) => order(a) - order(b));
    const first = web.find((s) => s.p.publicPort === sorted[0]);
    return { port: sorted[0], others: sorted.slice(1), hasWeb: true, title: first?.probe?.title };
  }
  // Only say "no web page" when every port answered and none was a page. Ports that don't answer
  // at all can't be judged (a firewall, or an app that only talks another protocol), so guess then.
  const allAnswered = published.length > 0 && seen.every((s) => s.probe?.reached);
  if (allAnswered && c.state === 'running') return { others: [], hasWeb: false };
  // Not checked yet (or stopped): trust the scoring, but only for ports it thinks are web pages
  const guess = c.ports.find((p) => p.publicPort === c.primaryPort && p.suggestedRole === 'web');
  const others = published.filter((p) => p.suggestedRole === 'web' && p.publicPort !== c.primaryPort).map((p) => p.publicPort!);
  return { port: guess?.publicPort, others, hasWeb: published.length ? undefined : false };
}

// ----------------------------------------------------------------------------
// Project page
// ----------------------------------------------------------------------------

/** LinuxServer and other wrapper images → the app's own project */
const UPSTREAM: Record<string, string> = {
  sonarr: 'Sonarr/Sonarr',
  radarr: 'Radarr/Radarr',
  lidarr: 'Lidarr/Lidarr',
  readarr: 'Readarr/Readarr',
  prowlarr: 'Prowlarr/Prowlarr',
  whisparr: 'Whisparr/Whisparr',
  bazarr: 'morpheus65535/bazarr',
  qbittorrent: 'qbittorrent/qBittorrent',
  transmission: 'transmission/transmission',
  deluge: 'deluge-torrent/deluge',
  sabnzbd: 'sabnzbd/sabnzbd',
  nzbget: 'nzbgetcom/nzbget',
  jellyfin: 'jellyfin/jellyfin',
  emby: 'MediaBrowser/Emby.Releases',
  kavita: 'Kareadita/Kavita',
  komga: 'gotson/komga',
  tautulli: 'Tautulli/Tautulli',
  overseerr: 'sct/overseerr',
  jellyseerr: 'Fallenbagel/jellyseerr',
  syncthing: 'syncthing/syncthing',
  nextcloud: 'nextcloud/server',
  'calibre-web': 'janeczku/calibre-web',
  calibre: 'kovidgoyal/calibre',
  audiobookshelf: 'advplyr/audiobookshelf',
  homeassistant: 'home-assistant/core',
  'code-server': 'coder/code-server',
  duplicati: 'duplicati/duplicati',
  mylar3: 'mylar3/mylar3',
  heimdall: 'linuxserver/Heimdall',
  plex: '',
  'unifi-network-application': '',
  wireguard: '',
  mariadb: 'MariaDB/server',
  swag: 'linuxserver/docker-swag',
  lazylibrarian: '',
  jackett: 'Jackett/Jackett',
  flaresolverr: 'FlareSolverr/FlareSolverr',
  homarr: 'homarr-labs/homarr',
  photoprism: 'photoprism/photoprism',
  immich: 'immich-app/immich',
  'immich-server': 'immich-app/immich',
  vaultwarden: 'dani-garcia/vaultwarden',
  'uptime-kuma': 'louislam/uptime-kuma',
  portainer: 'portainer/portainer',
  'portainer-ce': 'portainer/portainer',
  gluetun: 'qdm12/gluetun',
  watchtower: 'containrrr/watchtower',
  'nginx-proxy-manager': 'NginxProxyManager/nginx-proxy-manager',
  pihole: 'pi-hole/pi-hole',
  adguardhome: 'AdguardTeam/AdGuardHome',
  grafana: 'grafana/grafana',
  prometheus: 'prometheus/prometheus',
  traefik: 'traefik/traefik',
  caddy: 'caddyserver/caddy',
  redis: 'redis/redis',
  postgres: 'postgres/postgres',
  mongo: 'mongodb/mongo',
  mealie: 'mealie-recipes/mealie',
  paperless: 'paperless-ngx/paperless-ngx',
  'paperless-ngx': 'paperless-ngx/paperless-ngx',
  navidrome: 'navidrome/navidrome',
  filebrowser: 'filebrowser/filebrowser',
  dozzle: 'amir20/dozzle',
  homepage: 'gethomepage/homepage',
  'stirling-pdf': 'Stirling-Tools/Stirling-PDF',
  tdarr: 'HaveAGitGat/Tdarr',
  recyclarr: 'recyclarr/recyclarr',
  autobrr: 'autobrr/autobrr',
  unpackerr: 'Unpackerr/unpackerr',
  maintainerr: 'jorenn92/Maintainerr',
  nzbhydra2: 'theotherp/nzbhydra2',
  lidify: '',
};

/** The app's short name from its image: ghcr.io/linuxserver/sonarr:latest → sonarr */
export function imageSlug(image: string): string {
  const noTag = image.split('@')[0].replace(/:[^/]*$/, '');
  const last = noTag.split('/').pop() || noTag;
  return last.toLowerCase().replace(/^docker-/, '');
}

function imageOwnerRepo(image: string): { registry: string; owner?: string; repo: string } {
  const noTag = image.split('@')[0].replace(/:[^/]*$/, '');
  const parts = noTag.split('/');
  const registry = parts.length > 1 && /[.:]/.test(parts[0]) ? parts.shift()! : 'docker.io';
  const repo = parts.pop() || '';
  return { registry, owner: parts.join('/') || undefined, repo };
}

const ghRepo = (url?: string): string | undefined => url?.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/)?.slice(1, 3).map((s) => s.replace(/\.git$/, '')).join('/');

async function exists(url: string): Promise<boolean> {
  try {
    const r = await get(url, { method: 'HEAD', timeoutMs: 6000, follow: 2 });
    return r.status >= 200 && r.status < 400;
  } catch {
    return false;
  }
}

async function latestRelease(repo: string): Promise<string | undefined> {
  try {
    const r = await get(`https://github.com/${repo}/releases/latest`, { method: 'HEAD', timeoutMs: 6000, follow: 0 });
    const loc = String(r.headers.location || '');
    const tag = loc.match(/\/releases\/tag\/([^/?#]+)/)?.[1];
    return tag ? decodeURIComponent(tag) : undefined;
  } catch {
    return undefined;
  }
}

const projectKey = (c: DeepContainerMetadata) => c.image.split('@')[0].replace(/:[^/]*$/, '').toLowerCase();

async function findProject(c: DeepContainerMetadata): Promise<ProjectInfo> {
  const labels = c.labels || {};
  const source = labels['org.opencontainers.image.source'] || labels['org.label-schema.vcs-url'] || labels['org.opencontainers.image.url'];
  const fromLabel = ghRepo(source);
  const slug = imageSlug(c.image);
  const { registry, owner, repo } = imageOwnerRepo(c.image);
  const upstream = UPSTREAM[slug] ?? UPSTREAM[(c.compose?.service || '').toLowerCase()];
  let project: string | undefined;
  let imageSource: string | undefined;

  const isWrapper = (r?: string) => !!r && (/^linuxserver\//i.test(r) || /\/docker-[^/]+$/i.test(r) || /^hotio\//i.test(r) || /^binhex\//i.test(r));
  if (fromLabel && !isWrapper(fromLabel)) project = fromLabel;
  else {
    if (fromLabel) imageSource = `https://github.com/${fromLabel}`;
    if (upstream) project = upstream;
    else if (upstream === undefined && registry === 'ghcr.io' && owner && !/^(linuxserver|hotio)$/i.test(owner)) {
      if (await exists(`https://github.com/${owner}/${repo}`)) project = `${owner}/${repo}`;
    } else if (upstream === undefined && registry === 'docker.io' && owner && owner !== 'library' && !/^(linuxserver|hotio|binhex)$/i.test(owner)) {
      if (await exists(`https://github.com/${owner}/${repo}`)) project = `${owner}/${repo}`;
    }
  }
  const info: ProjectInfo = { at: Date.now(), imageSource };
  if (project) {
    info.repo = project;
    info.url = `https://github.com/${project}`;
    info.latest = await latestRelease(project);
    info.latestAt = Date.now();
  }
  return info;
}

const finding = new Set<string>();
export function refreshProjects(containers: DeepContainerMetadata[]) {
  const jobs: (() => Promise<void>)[] = [];
  for (const c of containers) {
    const k = projectKey(c);
    const prev = state.projects[k];
    if (finding.has(k)) continue;
    const stale = !prev || Date.now() - prev.at > PROJECT_EVERY || (prev.repo && Date.now() - (prev.latestAt || 0) > RELEASE_EVERY);
    if (!stale) continue;
    finding.add(k);
    jobs.push(async () => {
      try {
        if (prev?.repo && Date.now() - prev.at < PROJECT_EVERY) {
          const latest = await latestRelease(prev.repo);
          state.projects[k] = { ...prev, latest: latest ?? prev.latest, latestAt: Date.now() };
        } else state.projects[k] = await findProject(c);
        save();
      } finally {
        finding.delete(k);
      }
    });
  }
  void runLimited(jobs, 2);
}

export function projectInfo(c: DeepContainerMetadata): ProjectInfo | undefined {
  return state.projects[projectKey(c)];
}

// ----------------------------------------------------------------------------
// Icons
// ----------------------------------------------------------------------------

const ICON_SETS = [
  (s: string) => `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${s}.svg`,
  (s: string) => `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/${s}.png`,
  (s: string) => `https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/png/${s}.png`,
  (s: string) => `https://cdn.jsdelivr.net/gh/selfhst/icons/png/${s}.png`,
  (s: string) => `https://raw.githubusercontent.com/selfhst/icons/main/png/${s}.png`,
];

/** Names the icon sets might use for this app, most specific first */
function iconSlugs(c: DeepContainerMetadata): string[] {
  const out: string[] = [];
  const add = (s?: string) => {
    if (!s) return;
    const base = s.toLowerCase().replace(/[_\s.]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
    if (!base || /^(app|web|server|main|latest|service)$/.test(base)) return;
    out.push(base, base.replace(/-/g, ''));
    const trimmed = base.replace(/-(server|app|web|ce|ee|ng|docker|oss|core)$/, '');
    if (trimmed !== base) out.push(trimmed);
  };
  const upstream = UPSTREAM[imageSlug(c.image)];
  if (upstream) add(upstream.split('/')[1]);
  add(imageSlug(c.image));
  add(c.compose?.service);
  add(c.cleanName.replace(/-\d+$/, ''));
  const aliases: Record<string, string> = { pihole: 'pi-hole', adguardhome: 'adguard-home', homeassistant: 'home-assistant', 'nginx-proxy-manager': 'nginx-proxy-manager', 'portainer-ce': 'portainer' };
  for (const s of [...out]) if (aliases[s]) out.push(aliases[s]);
  return Array.from(new Set(out));
}

function isImage(r: Got): string | undefined {
  const type = String(r.headers['content-type'] || '').toLowerCase();
  if (r.status !== 200 || r.body.length < 60) return undefined;
  if (type.includes('svg') || r.body.slice(0, 200).toString().includes('<svg')) return 'svg';
  if (type.includes('png') || r.body.slice(1, 4).toString() === 'PNG') return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('icon') || (r.body[0] === 0 && r.body[1] === 0 && r.body[2] === 1)) return 'ico';
  if (type.includes('gif')) return 'gif';
  return undefined;
}

async function tryIcon(url: string): Promise<{ body: Buffer; ext: string } | undefined> {
  try {
    const r = await get(url, { timeoutMs: 6000, maxBytes: 1024 * 1024 });
    const ext = isImage(r);
    return ext ? { body: r.body, ext } : undefined;
  } catch {
    return undefined;
  }
}

const iconKey = (c: DeepContainerMetadata) => (imageSlug(c.image) || c.cleanName).replace(/[^a-z0-9-]/gi, '_');

async function findIcon(c: DeepContainerMetadata): Promise<IconInfo> {
  const key = iconKey(c);
  const store = (got: { body: Buffer; ext: string }, source: string): IconInfo => {
    fs.mkdirSync(ICON_DIR, { recursive: true });
    const file = `${key}.${got.ext}`;
    for (const f of fs.readdirSync(ICON_DIR)) if (f.startsWith(`${key}.`) && f !== file) fs.rmSync(path.join(ICON_DIR, f), { force: true });
    fs.writeFileSync(path.join(ICON_DIR, file), got.body);
    return { file, source, at: Date.now() };
  };
  // 1. The community icon sets, by name
  for (const slug of iconSlugs(c)) {
    for (const make of ICON_SETS) {
      const got = await tryIcon(make(slug));
      if (got) return store(got, make(slug));
    }
  }
  // 2. The icon the app's own web page uses (skipping tiny favicons unless nothing else is found)
  const probes = c.ports.map((p) => state.probes[probeKey(c, p.privatePort)]).filter((p) => p?.web && p.icons?.length);
  let small: { got: { body: Buffer; ext: string }; url: string } | undefined;
  for (const p of probes) {
    for (const url of p!.icons!) {
      const got = await tryIcon(url);
      if (!got) continue;
      if (got.ext === 'ico' && !small) {
        small = { got, url };
        continue;
      }
      return store(got, url);
    }
  }
  // 3. The project's GitHub organization picture, when the organization is the app (jellyfin/jellyfin)
  const repo = projectInfo(c)?.repo;
  if (repo) {
    const [owner, name] = repo.split('/');
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm(owner) === norm(name) || norm(name).startsWith(norm(owner)) || norm(owner).startsWith(norm(name))) {
      const got = await tryIcon(`https://github.com/${owner}.png?size=128`);
      if (got) return store(got, `https://github.com/${owner}`);
    }
  }
  if (small) return store(small.got, small.url);
  return { at: Date.now(), hadProbes: probes.length > 0 || c.ports.some((p) => state.probes[probeKey(c, p.privatePort)]) };
}

const iconing = new Set<string>();
export function refreshIcons(containers: DeepContainerMetadata[]) {
  const jobs: (() => Promise<void>)[] = [];
  for (const c of containers) {
    const k = iconKey(c);
    const prev = state.icons[k];
    if (iconing.has(k)) continue;
    if (prev?.file && fs.existsSync(path.join(ICON_DIR, prev.file))) continue;
    // Nothing found yet: look again once the web page has been checked, then once a day
    const probed = c.ports.some((p) => state.probes[probeKey(c, p.privatePort)]);
    if (prev && !(probed && !prev.hadProbes) && Date.now() - prev.at < ICON_RETRY) continue;
    iconing.add(k);
    jobs.push(async () => {
      try {
        state.icons[k] = await findIcon(c);
        save();
      } finally {
        iconing.delete(k);
      }
    });
  }
  void runLimited(jobs, 3);
}

/** The saved icon's address for the dashboard, when one was found */
export function iconUrl(c: DeepContainerMetadata): string | undefined {
  const i = state.icons[iconKey(c)];
  return i?.file ? `/api/apps/icons/${encodeURIComponent(i.file)}?v=${i.at}` : undefined;
}

export function iconSource(c: DeepContainerMetadata): string | undefined {
  return state.icons[iconKey(c)]?.source;
}

export function iconFile(name: string): string | undefined {
  const safe = path.basename(name);
  const p = path.join(ICON_DIR, safe);
  return fs.existsSync(p) ? p : undefined;
}

/** Look for this app's icon again (after the person asks for it) */
export function forgetIcon(c: DeepContainerMetadata) {
  delete state.icons[iconKey(c)];
  save();
}

/** Start all background lookups for these apps */
export function refreshIdentity(containers: DeepContainerMetadata[]) {
  refreshProbes(containers);
  refreshProjects(containers);
  refreshIcons(containers);
}

/** A friendly name: the app's own page title when it matches the app ("Usenet Ultimate"), else its
 *  service name in the stack (qbittorrent rather than music-stack-qbittorrent-1) */
export function friendlyName(c: DeepContainerMetadata, title?: string): string {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const service = c.compose?.service || '';
  const slug = imageSlug(c.image);
  const t = title?.split(/\s+[-|–·:]\s+/)[0]?.trim();
  if (t && t.length <= 40) {
    const nt = norm(t);
    if (nt.length >= 3 && [slug, service, c.cleanName].some((x) => x && (norm(x).includes(nt) || nt.includes(norm(x))))) return t;
  }
  // "app", "web" or "server" says nothing: use the image's name then ("nextcloud")
  if (/^(app|web|server|main|frontend|backend|ui|application)$/i.test(service) && slug) return slug;
  return service || c.cleanName;
}
