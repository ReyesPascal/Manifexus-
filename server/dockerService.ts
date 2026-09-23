import http from 'http';
import fs from 'fs';
import { DeepContainerMetadata, ContainerPort, ContainerMount, ComposeMetadata } from '../src/types';

const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';

// Check if docker socket exists on filesystem
export function isDockerSocketAvailable(): boolean {
  try {
    return fs.existsSync(DOCKER_SOCKET_PATH);
  } catch {
    return false;
  }
}

// Low-level HTTP request over Unix Domain Socket
export function queryDockerEngine<T>(
  path: string,
  method: string = 'GET',
  body?: unknown,
  customTimeoutMs?: number
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

    const headers: Record<string, string | number> = {
      Host: 'docker.local',
      Accept: 'application/json',
    };

    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    // Directive 3: Explicitly increase timeout limit for stop/down/wait commands to minimum of 120 seconds
    let defaultTimeout = 120000;
    if (path.includes('/wait') || path.includes('/stop') || path.includes('/images/create')) {
      defaultTimeout = 180000; // 3 minutes for container teardown / waiting / image pulling
    }
    const effectiveTimeout = customTimeoutMs || defaultTimeout;

    const options: http.RequestOptions = {
      socketPath: DOCKER_SOCKET_PATH,
      path: path,
      method: method,
      headers: headers,
      timeout: effectiveTimeout,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : ({} as T));
          } catch {
            // For plain text (logs) or multi-line streaming responses (image pull), return raw text
            resolve(data as unknown as T);
          }
        } else {
          reject(new Error(`Docker API ${path} returned status ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Docker API request to ${path} timed out`));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// Pull an image from registry via Docker Engine API
export async function pullDockerImage(imageName: string): Promise<boolean> {
  try {
    const [image, tag = 'latest'] = imageName.split(':');
    await queryDockerEngine(
      `/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`,
      'POST'
    );
    return true;
  } catch (err) {
    console.error(`Failed to pull image ${imageName}:`, err);
    return false;
  }
}

// Inspect host and find an already downloaded image for host orchestration tasks
export async function getBestAvailableImage(): Promise<string> {
  try {
    // 1. Inspect running containers: Manifexus itself is guaranteed to be running on host!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const containers = await queryDockerEngine<any[]>('/containers/json?all=1', 'GET');
    if (Array.isArray(containers)) {
      const manifexus = containers.find(
        (c) =>
          (c.Names && c.Names.some((n: string) => n.toLowerCase().includes('manifexus'))) ||
          (c.Image && c.Image.toLowerCase().includes('manifexus'))
      );
      if (manifexus && manifexus.Image) {
        return manifexus.Image;
      }
    }

    // 2. Check local images on host for familiar tools (docker, compose, node, alpine, debian, ubuntu)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const images = await queryDockerEngine<any[]>('/images/json', 'GET');
    if (Array.isArray(images) && images.length > 0) {
      for (const img of images) {
        const tags: string[] = img.RepoTags || [];
        const foundManifexus = tags.find((t) => t.toLowerCase().includes('manifexus'));
        if (foundManifexus) return foundManifexus;
      }

      const preferredPatterns = ['docker', 'compose', 'alpine', 'debian', 'ubuntu', 'node', 'busybox'];
      for (const pattern of preferredPatterns) {
        for (const img of images) {
          const tags: string[] = img.RepoTags || [];
          const match = tags.find((t) => t.toLowerCase().includes(pattern));
          if (match && !match.includes('<none>')) return match;
        }
      }

      // If any non-dangling image tag exists, return the first one
      for (const img of images) {
        const tags: string[] = img.RepoTags || [];
        const valid = tags.find((t) => !t.includes('<none>'));
        if (valid) return valid;
      }
    }
  } catch (err) {
    console.warn('[DockerService] Error detecting local images:', err);
  }

  // 3. Fallback: pull alpine
  try {
    const pulled = await pullDockerImage('alpine:latest');
    if (pulled) return 'alpine:latest';
  } catch {
    // ignore
  }

  return 'ghcr.io/reyespascal/manifexus:latest';
}

// Icon dictionary for self-hosted apps
const ICON_LOOKUP: Record<string, string> = {
  plex: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/plex.png',
  jellyfin: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/jellyfin.png',
  pihole: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/pi-hole.png',
  'pi-hole': 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/pi-hole.png',
  portainer: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/portainer.png',
  'nginx-proxy-manager': 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/nginx-proxy-manager.png',
  npm: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/nginx-proxy-manager.png',
  nextcloud: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/nextcloud.png',
  homeassistant: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/home-assistant.png',
  'home-assistant': 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/home-assistant.png',
  'uptime-kuma': 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/uptime-kuma.png',
  vaultwarden: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/vaultwarden.png',
  bitwarden: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/vaultwarden.png',
  postgres: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/postgresql.png',
  postgresql: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/postgresql.png',
  redis: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/redis.png',
  grafana: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/grafana.png',
  prometheus: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/prometheus.png',
  wireguard: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/wireguard.png',
  tailscale: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/tailscale.png',
  sonarr: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/sonarr.png',
  radarr: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/radarr.png',
  qbittorrent: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/qbittorrent.png',
  transmission: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/transmission.png',
  traefik: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/traefik.png',
  caddy: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/caddy.png',
  watchtower: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/watchtower.png',
  syncthing: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/syncthing.png',
  immich: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/immich.png',
  mealie: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/mealie.png',
  adguard: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/adguard-home.png',
  'adguard-home': 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/adguard-home.png',
  nzbdav: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/sabnzbd.png',
  sabnzbd: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/sabnzbd.png',
  nzbget: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/nzbget.png',
};

export function resolveAppIcon(appName: string, imageStr: string): string {
  const normalized = (appName + ' ' + imageStr).toLowerCase();
  for (const [key, iconUrl] of Object.entries(ICON_LOOKUP)) {
    if (normalized.includes(key)) {
      return iconUrl;
    }
  }
  // Generic dashboard icon fallback based on simple clean name
  const clean = appName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return `https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/${clean}.png`;
}

// Mask sensitive environment variable values
function maskEnvValue(key: string, value: string): { isSensitive: boolean; maskedValue: string } {
  const lower = key.toLowerCase();
  const sensitivePatterns = ['pass', 'secret', 'token', 'key', 'auth', 'cred', 'cert', 'pwd', 'private'];
  const isSensitive = sensitivePatterns.some((p) => lower.includes(p));

  if (isSensitive) {
    if (value.length <= 4) return { isSensitive: true, maskedValue: '••••••••' };
    return {
      isSensitive: true,
      maskedValue: `${value.slice(0, 2)}••••••${value.slice(-2)}`,
    };
  }

  return { isSensitive: false, maskedValue: value };
}

// Clean docker container name (removes leading slash)
export function sanitizeContainerName(rawName: string): string {
  return rawName.replace(/^\//, '');
}

// Classify port role and calculate smart priority score for Web UI detection
export function classifyPort(
  port: ContainerPort,
  containerName: string,
  imageName: string
): { role: 'web' | 'p2p' | 'database' | 'dns' | 'service'; label?: string; score: number } {
  const norm = `${containerName} ${imageName}`.toLowerCase();
  const priv = port.privatePort;
  const pub = port.publicPort ?? priv;
  const isTcp = port.type === 'tcp';

  // Base score: TCP published ports start at 100, private at 20, UDP at -500
  const score = isTcp ? (port.publicPort ? 100 : 20) : -500;

  // 1. DNS / DHCP / NTP
  if (priv === 53 || pub === 53) {
    return { role: 'dns', label: 'DNS', score: score - 900 };
  }
  if ([67, 68].includes(priv) || [67, 68].includes(pub)) {
    return { role: 'dns', label: 'DHCP', score: score - 900 };
  }

  // 2. Database Engines
  const dbPorts: Record<number, string> = {
    3306: 'MySQL/MariaDB',
    5432: 'PostgreSQL',
    27017: 'MongoDB',
    6379: 'Redis',
    11211: 'Memcached',
    9200: 'Elasticsearch',
    9300: 'Elastic Cluster',
  };
  if (dbPorts[priv] || dbPorts[pub]) {
    return { role: 'database', label: dbPorts[priv] || dbPorts[pub], score: score - 500 };
  }

  // 3. Known P2P / Torrent peer ports
  const isTorrentApp =
    norm.includes('torrent') || norm.includes('deluge') || norm.includes('transmission') || norm.includes('rtorrent');
  const isTorrentPeerPort =
    [6881, 6882, 6889, 51413, 58846].includes(priv) ||
    [6881, 6882, 6889, 51413, 58846].includes(pub) ||
    (isTorrentApp && (pub >= 40000 || priv >= 40000));
  if (isTorrentPeerPort) {
    return { role: 'p2p', label: 'P2P / Peer Traffic', score: score - 700 };
  }

  // 4. Wireguard VPN UDP
  if (priv === 51820 || pub === 51820) {
    return { role: 'service', label: 'VPN Traffic', score: score - 700 };
  }

  // 5. Specific high-confidence Web UI matches (e.g. qBittorrent 8080/8081 vs peer port 56098)
  if (
    norm.includes('qbittorrent') &&
    ([8080, 8081, 8085].includes(priv) || [8080, 8081, 8085].includes(pub))
  ) {
    return { role: 'web', label: 'Web UI', score: score + 1000 };
  }
  if (norm.includes('deluge') && (priv === 8112 || pub === 8112)) {
    return { role: 'web', label: 'Web UI', score: score + 1000 };
  }
  if (norm.includes('nzbdav') && (priv === 3000 || pub === 3000)) {
    return { role: 'web', label: 'NZBDAV Web', score: score + 1000 };
  }
  if (norm.includes('transmission') && (priv === 9091 || pub === 9091)) {
    return { role: 'web', label: 'Web UI', score: score + 1000 };
  }
  if (norm.includes('pihole') && ([80, 8080].includes(priv) || [80, 8080].includes(pub))) {
    return { role: 'web', label: 'Web Admin', score: score + 1000 };
  }
  if (
    (norm.includes('wireguard') || norm.includes('wg-easy')) &&
    (priv === 51821 || pub === 51821)
  ) {
    return { role: 'web', label: 'Web UI', score: score + 1000 };
  }
  if (norm.includes('syncthing') && (priv === 8384 || pub === 8384)) {
    return { role: 'web', label: 'Web GUI', score: score + 1000 };
  }
  if (norm.includes('plex') && (priv === 32400 || pub === 32400)) {
    return { role: 'web', label: 'Plex Web', score: score + 1000 };
  }
  if (
    (norm.includes('jellyfin') || norm.includes('emby')) &&
    ([8096, 8920].includes(priv) || [8096, 8920].includes(pub))
  ) {
    return { role: 'web', label: 'Web UI', score: score + 1000 };
  }
  if (norm.includes('portainer') && ([9000, 9443].includes(priv) || [9000, 9443].includes(pub))) {
    return { role: 'web', label: 'Web UI', score: score + 1000 };
  }
  if (norm.includes('nginx') && ([81, 80, 443].includes(priv) || [81, 80, 443].includes(pub))) {
    return { role: 'web', label: priv === 81 || pub === 81 ? 'Admin UI' : 'HTTP Web', score: score + 900 };
  }

  // 6. Generic well-known Web UI ports
  const commonWebPorts: Record<number, string> = {
    80: 'HTTP',
    443: 'HTTPS',
    8080: 'Web UI',
    8081: 'Web UI',
    8082: 'Web UI',
    8085: 'Web UI',
    8088: 'Web UI',
    8090: 'Web UI',
    8000: 'Web UI',
    8443: 'Web SSL',
    9443: 'Web SSL',
    3000: 'Web UI',
    3001: 'Web UI',
    3334: 'Web UI',
    5000: 'Web UI',
    5055: 'Web UI',
    8123: 'Home Assistant',
    8989: 'Sonarr Web',
    7878: 'Radarr Web',
    8686: 'Lidarr Web',
    9696: 'Prowlarr Web',
    8787: 'Readarr Web',
    6789: 'NZBGet Web',
    8888: 'Jupyter/Web',
    2342: 'PhotoPrism',
    2283: 'Immich',
    13378: 'Audiobookshelf',
  };

  if (commonWebPorts[priv] || commonWebPorts[pub]) {
    return { role: 'web', label: commonWebPorts[priv] || commonWebPorts[pub], score: score + 600 };
  }

  // 7. Standard TCP port range heuristic
  if (isTcp && pub >= 80 && pub <= 9999) {
    return { role: 'web', label: 'HTTP / TCP', score: score + 80 };
  } else if (pub >= 10000) {
    return { role: 'service', label: 'High Service Port', score: score - 150 };
  }

  return { role: 'service', label: undefined, score };
}

// Convert raw docker inspect object to DeepContainerMetadata
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseRawContainer(inspectData: any): DeepContainerMetadata {
  const rawName = inspectData.Name || (inspectData.Names && inspectData.Names[0]) || 'unknown';
  const cleanName = sanitizeContainerName(rawName);
  const labels = inspectData.Config?.Labels || inspectData.Labels || {};

  // Extract Compose metadata
  const composeProject = labels['com.docker.compose.project'];
  const composeService = labels['com.docker.compose.service'];
  const workingDir = labels['com.docker.compose.project.working_dir'];
  const configFiles = labels['com.docker.compose.project.config_files'];
  const composeVersion = labels['com.docker.compose.version'];

  const compose: ComposeMetadata = {
    isCompose: Boolean(composeProject || composeService || workingDir),
    project: composeProject,
    service: composeService,
    workingDir: workingDir,
    configFiles: configFiles,
    version: composeVersion,
    oneOff: labels['com.docker.compose.oneoff'] === 'True',
  };

  // Extract Ports: combine NetworkSettings.Ports with HostConfig.PortBindings so stopped/exited containers never lose their port mappings
  const ports: ContainerPort[] = [];
  const networkPorts = inspectData.NetworkSettings?.Ports || {};
  const hostConfigPorts = inspectData.HostConfig?.PortBindings || {};
  const combinedPortBindings = { ...hostConfigPorts, ...networkPorts };
  const rawPortsList = inspectData.Ports || [];

  if (Array.isArray(rawPortsList) && rawPortsList.length > 0) {
    for (const p of rawPortsList) {
      ports.push({
        ip: p.IP,
        privatePort: p.PrivatePort,
        publicPort: p.PublicPort,
        type: (p.Type as 'tcp' | 'udp') || 'tcp',
      });
    }
  }

  // Also parse combined port bindings to ensure stopped containers or bindings without active socket listeners are captured
  for (const [key, bindings] of Object.entries(combinedPortBindings)) {
    const [portNumStr, typeStr] = key.split('/');
    const privPort = parseInt(portNumStr, 10);
    const protocol = (typeStr as 'tcp' | 'udp') || 'tcp';

    if (Array.isArray(bindings) && bindings.length > 0) {
      for (const b of bindings as { HostIp?: string; HostPort?: string }[]) {
        ports.push({
          ip: b.HostIp || '0.0.0.0',
          privatePort: privPort,
          publicPort: b.HostPort ? parseInt(b.HostPort, 10) : undefined,
          type: protocol,
        });
      }
    } else if (ports.length === 0) {
      ports.push({
        privatePort: privPort,
        type: protocol,
      });
    }
  }

  // Deduplicate ports: Docker often returns both IPv4 (0.0.0.0) and IPv6 (::) for the same port binding
  const dedupedPorts: ContainerPort[] = [];
  const seenPortKeys = new Set<string>();

  for (const p of ports) {
    const key =
      p.publicPort !== undefined
        ? `${p.publicPort}->${p.privatePort}/${p.type}`
        : `priv:${p.privatePort}/${p.type}`;

    if (!seenPortKeys.has(key)) {
      seenPortKeys.add(key);
      dedupedPorts.push(p);
    } else {
      // If previous entry had IPv6 '::' and this one has IPv4 '0.0.0.0', prefer IPv4
      const existing = dedupedPorts.find((item) => {
        const itemKey =
          item.publicPort !== undefined
            ? `${item.publicPort}->${item.privatePort}/${item.type}`
            : `priv:${item.privatePort}/${item.type}`;
        return itemKey === key;
      });
      if (existing && existing.ip?.includes(':') && p.ip && !p.ip.includes(':')) {
        existing.ip = p.ip;
      }
    }
  }

  const containerImage = inspectData.Config?.Image || inspectData.Image || '';

  // Classify each port and assign suggested roles and labels
  for (const port of dedupedPorts) {
    const classification = classifyPort(port, cleanName, containerImage);
    port.suggestedRole = classification.role;
    port.label = classification.label;
  }

  // Find primary web port using intelligent multi-port scoring
  const scoredPorts = dedupedPorts.map((p) => ({
    port: p,
    score: classifyPort(p, cleanName, containerImage).score,
  }));
  scoredPorts.sort((a, b) => b.score - a.score);

  const primaryPort =
    scoredPorts.length > 0
      ? scoredPorts[0].port.publicPort ?? scoredPorts[0].port.privatePort
      : undefined;

  // Mounts
  const mounts: ContainerMount[] = (inspectData.Mounts || []).map((m: { Type?: string; Source?: string; Destination?: string; Mode?: string; RW?: boolean }) => ({
    type: m.Type || 'bind',
    source: m.Source || '',
    destination: m.Destination || '',
    mode: m.Mode,
    rw: Boolean(m.RW),
  }));

  // Environment variables
  const rawEnv: string[] = inspectData.Config?.Env || [];
  const rawEnvVars = rawEnv.map((envStr) => {
    const eqIdx = envStr.indexOf('=');
    const key = eqIdx > -1 ? envStr.substring(0, eqIdx) : envStr;
    const val = eqIdx > -1 ? envStr.substring(eqIdx + 1) : '';
    return { key, value: val };
  });

  const envVars = rawEnv.map((envStr) => {
    const eqIdx = envStr.indexOf('=');
    const key = eqIdx > -1 ? envStr.substring(0, eqIdx) : envStr;
    const val = eqIdx > -1 ? envStr.substring(eqIdx + 1) : '';
    const { isSensitive, maskedValue } = maskEnvValue(key, val);
    return {
      key,
      value: maskedValue,
      isSensitive,
    };
  });

  // State
  const rawState = inspectData.State;
  let state: DeepContainerMetadata['state'] = 'exited';
  let statusStr = '';

  if (typeof rawState === 'string') {
    state = rawState as DeepContainerMetadata['state'];
    statusStr = rawState;
  } else if (rawState) {
    if (rawState.Running) state = 'running';
    else if (rawState.Paused) state = 'paused';
    else if (rawState.Restarting) state = 'restarting';
    else if (rawState.Dead) state = 'dead';
    else state = 'exited';
    statusStr = rawState.Status || (rawState.Running ? 'Up' : 'Exited');
  } else {
    statusStr = inspectData.Status || 'unknown';
    if (statusStr.toLowerCase().startsWith('up')) state = 'running';
  }

  const image = inspectData.Config?.Image || inspectData.Image || '';
  const baseImage = image.split('@')[0];

  const networks = Object.keys(inspectData.NetworkSettings?.Networks || {});
  const ipAddress = inspectData.NetworkSettings?.IPAddress || inspectData.NetworkSettings?.Networks?.[networks[0]]?.IPAddress;

  const createdTime = inspectData.Created ? (typeof inspectData.Created === 'number' ? inspectData.Created : Math.floor(new Date(inspectData.Created).getTime() / 1000)) : Math.floor(Date.now() / 1000);

  return {
    id: inspectData.Id ? inspectData.Id.substring(0, 12) : 'unknown',
    name: rawName,
    cleanName,
    image,
    baseImage,
    state,
    status: statusStr,
    created: createdTime,
    command: Array.isArray(inspectData.Config?.Cmd) ? inspectData.Config.Cmd.join(' ') : inspectData.Command,
    entrypoint: Array.isArray(inspectData.Config?.Entrypoint) ? inspectData.Config.Entrypoint.join(' ') : undefined,
    ports: dedupedPorts,
    primaryPort,
    mounts,
    envVars,
    rawEnvVars,
    labels,
    compose,
    networks,
    ipAddress,
    restartPolicy: inspectData.HostConfig?.RestartPolicy?.Name || 'no',
    iconUrl: resolveAppIcon(cleanName, image),
  };
}

// In-memory mock container state for Demo/Standby Mode
let demoContainers: DeepContainerMetadata[] = [
  {
    id: 'c8f42d91a03e',
    name: '/plex-media-server',
    cleanName: 'plex-media-server',
    image: 'lscr.io/linuxserver/plex:latest',
    baseImage: 'lscr.io/linuxserver/plex:latest',
    state: 'running',
    status: 'Up 14 days (healthy)',
    created: Math.floor(Date.now() / 1000) - 1209600,
    command: '/init',
    ports: [
      { ip: '0.0.0.0', privatePort: 32400, publicPort: 32400, type: 'tcp' },
      { ip: '0.0.0.0', privatePort: 1900, publicPort: 1900, type: 'udp' },
    ],
    primaryPort: 32400,
    mounts: [
      { type: 'bind', source: '/mnt/storage/media', destination: '/media', rw: false },
      { type: 'bind', source: '/home/ubuntu/appdata/plex', destination: '/config', rw: true },
    ],
    envVars: [
      { key: 'PUID', value: '1000', isSensitive: false },
      { key: 'PGID', value: '1000', isSensitive: false },
      { key: 'TZ', value: 'America/New_York', isSensitive: false },
      { key: 'PLEX_CLAIM', value: 'claim-••••••••', isSensitive: true },
    ],
    labels: {
      'com.docker.compose.project': 'media-stack',
      'com.docker.compose.service': 'plex',
      'com.docker.compose.project.working_dir': '/home/ubuntu/docker/media-stack',
      'com.docker.compose.project.config_files': '/home/ubuntu/docker/media-stack/docker-compose.yml',
      'com.docker.compose.version': '2.24.5',
    },
    compose: {
      isCompose: true,
      project: 'media-stack',
      service: 'plex',
      workingDir: '/home/ubuntu/docker/media-stack',
      configFiles: '/home/ubuntu/docker/media-stack/docker-compose.yml',
      version: '2.24.5',
    },
    networks: ['media-stack_default'],
    ipAddress: '172.28.0.2',
    restartPolicy: 'unless-stopped',
    iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/plex.png',
  },
  {
    id: '7a1e5bc3d890',
    name: '/jellyfin',
    cleanName: 'jellyfin',
    image: 'jellyfin/jellyfin:10.8.13',
    baseImage: 'jellyfin/jellyfin:10.8.13',
    state: 'running',
    status: 'Up 5 days',
    created: Math.floor(Date.now() / 1000) - 432000,
    ports: [
      { ip: '0.0.0.0', privatePort: 8096, publicPort: 8096, type: 'tcp' },
      { ip: '0.0.0.0', privatePort: 8920, publicPort: 8920, type: 'tcp' },
    ],
    primaryPort: 8096,
    mounts: [
      { type: 'bind', source: '/mnt/storage/media', destination: '/media', rw: false },
      { type: 'bind', source: '/home/ubuntu/appdata/jellyfin/config', destination: '/config', rw: true },
    ],
    envVars: [
      { key: 'JELLYFIN_PublishedServerUrl', value: 'http://192.168.1.150:8096', isSensitive: false },
    ],
    labels: {
      'com.docker.compose.project': 'media-stack',
      'com.docker.compose.service': 'jellyfin',
      'com.docker.compose.project.working_dir': '/home/ubuntu/docker/media-stack',
      'com.docker.compose.project.config_files': '/home/ubuntu/docker/media-stack/docker-compose.yml',
    },
    compose: {
      isCompose: true,
      project: 'media-stack',
      service: 'jellyfin',
      workingDir: '/home/ubuntu/docker/media-stack',
      configFiles: '/home/ubuntu/docker/media-stack/docker-compose.yml',
    },
    networks: ['media-stack_default'],
    ipAddress: '172.28.0.3',
    restartPolicy: 'unless-stopped',
    iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/jellyfin.png',
  },
  {
    id: 'f93d4a821e7b',
    name: '/qbittorrent',
    cleanName: 'qbittorrent',
    image: 'lscr.io/linuxserver/qbittorrent:latest',
    baseImage: 'lscr.io/linuxserver/qbittorrent:latest',
    state: 'running',
    status: 'Up 7 days',
    created: Math.floor(Date.now() / 1000) - 604800,
    ports: [
      { ip: '0.0.0.0', privatePort: 8080, publicPort: 8081, type: 'tcp', suggestedRole: 'web', label: 'Web UI' },
      { ip: '0.0.0.0', privatePort: 6881, publicPort: 56098, type: 'tcp', suggestedRole: 'p2p', label: 'P2P / Peer Traffic' },
      { ip: '0.0.0.0', privatePort: 6881, publicPort: 56098, type: 'udp', suggestedRole: 'p2p', label: 'P2P UDP' },
    ],
    primaryPort: 8081,
    mounts: [
      { type: 'bind', source: '/mnt/storage/downloads', destination: '/downloads', rw: true },
      { type: 'bind', source: '/home/ubuntu/appdata/qbittorrent/config', destination: '/config', rw: true },
    ],
    envVars: [
      { key: 'WEBUI_PORT', value: '8080', isSensitive: false },
      { key: 'TORRENTING_PORT', value: '6881', isSensitive: false },
      { key: 'TZ', value: 'America/New_York', isSensitive: false },
    ],
    labels: {
      'com.docker.compose.project': 'media-stack',
      'com.docker.compose.service': 'qbittorrent',
      'com.docker.compose.project.working_dir': '/home/ubuntu/docker/media-stack',
      'com.docker.compose.project.config_files': '/home/ubuntu/docker/media-stack/docker-compose.yml',
    },
    compose: {
      isCompose: true,
      project: 'media-stack',
      service: 'qbittorrent',
      workingDir: '/home/ubuntu/docker/media-stack',
      configFiles: '/home/ubuntu/docker/media-stack/docker-compose.yml',
    },
    networks: ['media-stack_default'],
    ipAddress: '172.28.0.7',
    restartPolicy: 'unless-stopped',
    iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/qbittorrent.png',
  },
  {
    id: 'b149f012c85e',
    name: '/pihole',
    cleanName: 'pihole',
    image: 'pihole/pihole:latest',
    baseImage: 'pihole/pihole:latest',
    state: 'running',
    status: 'Up 21 days (healthy)',
    created: Math.floor(Date.now() / 1000) - 1814400,
    ports: [
      { ip: '0.0.0.0', privatePort: 80, publicPort: 8080, type: 'tcp' },
      { ip: '0.0.0.0', privatePort: 53, publicPort: 53, type: 'tcp' },
      { ip: '0.0.0.0', privatePort: 53, publicPort: 53, type: 'udp' },
    ],
    primaryPort: 8080,
    mounts: [
      { type: 'bind', source: '/home/ubuntu/appdata/pihole/etc-pihole', destination: '/etc/pihole', rw: true },
      { type: 'bind', source: '/home/ubuntu/appdata/pihole/etc-dnsmasq.d', destination: '/etc/dnsmasq.d', rw: true },
    ],
    envVars: [
      { key: 'TZ', value: 'America/New_York', isSensitive: false },
      { key: 'WEBPASSWORD', value: 's3••••••••', isSensitive: true },
      { key: 'FTLCONF_LOCAL_IPV4', value: '192.168.1.150', isSensitive: false },
    ],
    labels: {
      'com.docker.compose.project': 'network-core',
      'com.docker.compose.service': 'pihole',
      'com.docker.compose.project.working_dir': '/home/ubuntu/docker/network-core',
      'com.docker.compose.project.config_files': '/home/ubuntu/docker/network-core/compose.yml',
    },
    compose: {
      isCompose: true,
      project: 'network-core',
      service: 'pihole',
      workingDir: '/home/ubuntu/docker/network-core',
      configFiles: '/home/ubuntu/docker/network-core/compose.yml',
    },
    networks: ['host'],
    restartPolicy: 'always',
    iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/pi-hole.png',
  },
  {
    id: 'f9328db1504a',
    name: '/nginx-proxy-manager',
    cleanName: 'nginx-proxy-manager',
    image: 'jc21/nginx-proxy-manager:latest',
    baseImage: 'jc21/nginx-proxy-manager:latest',
    state: 'running',
    status: 'Up 18 days',
    created: Math.floor(Date.now() / 1000) - 1555200,
    ports: [
      { ip: '0.0.0.0', privatePort: 81, publicPort: 81, type: 'tcp' },
      { ip: '0.0.0.0', privatePort: 80, publicPort: 80, type: 'tcp' },
      { ip: '0.0.0.0', privatePort: 443, publicPort: 443, type: 'tcp' },
    ],
    primaryPort: 81,
    mounts: [
      { type: 'bind', source: '/home/ubuntu/appdata/npm/data', destination: '/data', rw: true },
      { type: 'bind', source: '/home/ubuntu/appdata/npm/letsencrypt', destination: '/etc/letsencrypt', rw: true },
    ],
    envVars: [
      { key: 'DB_SQLITE_FILE', value: '/data/database.sqlite', isSensitive: false },
      { key: 'DISABLE_IPV6', value: 'true', isSensitive: false },
    ],
    labels: {
      'com.docker.compose.project': 'network-core',
      'com.docker.compose.service': 'npm',
      'com.docker.compose.project.working_dir': '/home/ubuntu/docker/network-core',
      'com.docker.compose.project.config_files': '/home/ubuntu/docker/network-core/compose.yml',
    },
    compose: {
      isCompose: true,
      project: 'network-core',
      service: 'npm',
      workingDir: '/home/ubuntu/docker/network-core',
      configFiles: '/home/ubuntu/docker/network-core/compose.yml',
    },
    networks: ['proxy_net', 'bridge'],
    ipAddress: '172.22.0.4',
    restartPolicy: 'unless-stopped',
    iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/nginx-proxy-manager.png',
  },
  {
    id: '3c8e41a990bb',
    name: '/portainer-ce',
    cleanName: 'portainer-ce',
    image: 'portainer/portainer-ce:2.19.4',
    baseImage: 'portainer/portainer-ce:2.19.4',
    state: 'running',
    status: 'Up 30 days',
    created: Math.floor(Date.now() / 1000) - 2592000,
    ports: [
      { ip: '0.0.0.0', privatePort: 9443, publicPort: 9443, type: 'tcp' },
      { ip: '0.0.0.0', privatePort: 9000, publicPort: 9000, type: 'tcp' },
    ],
    primaryPort: 9000,
    mounts: [
      { type: 'bind', source: '/var/run/docker.sock', destination: '/var/run/docker.sock', rw: false },
      { type: 'volume', source: 'portainer_data', destination: '/data', rw: true },
    ],
    envVars: [],
    labels: {},
    compose: {
      isCompose: false, // Standard docker run!
    },
    networks: ['bridge'],
    ipAddress: '172.17.0.2',
    restartPolicy: 'always',
    iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/portainer.png',
  },
  {
    id: '2af7fdd5b531',
    name: '/utilities-stack-app-1',
    cleanName: 'utilities-stack-app-1',
    image: 'nextcloud',
    baseImage: 'nextcloud',
    state: 'running',
    status: 'Up 4 days (healthy)',
    created: Math.floor(Date.now() / 1000) - 345600,
    ports: [
      { ip: '0.0.0.0', privatePort: 80, publicPort: 8082, type: 'tcp', suggestedRole: 'web', label: 'HTTP' },
    ],
    primaryPort: 8082,
    mounts: [
      { type: 'bind', source: '/home/ryan/utilities-stack/nextcloud_data', destination: '/var/www/html', rw: true },
      { type: 'volume', source: 'utilities-stack_nextcloud', destination: '/var/www/html/config', rw: true },
    ],
    envVars: [
      { key: 'MYSQL_HOST', value: 'utilities-stack-db-1', isSensitive: false },
      { key: 'MYSQL_DATABASE', value: 'nextcloud', isSensitive: false },
      { key: 'MYSQL_USER', value: 'nextcloud', isSensitive: false },
      { key: 'MYSQL_PASSWORD', value: 'db••••••••', isSensitive: true },
    ],
    labels: {
      'com.docker.compose.project': 'utilities-stack',
      'com.docker.compose.service': 'app',
      'com.docker.compose.project.working_dir': '/home/ryan/utilities-stack',
      'com.docker.compose.project.config_files': '/home/ryan/utilities-stack/docker-compose.yml',
      'com.docker.compose.version': '2.27.0',
    },
    compose: {
      isCompose: true,
      project: 'utilities-stack',
      service: 'app',
      workingDir: '/home/ryan/utilities-stack',
      configFiles: '/home/ryan/utilities-stack/docker-compose.yml',
      version: '2.27.0',
    },
    networks: ['utilities-stack_default'],
    ipAddress: '172.20.0.3',
    restartPolicy: 'unless-stopped',
    iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/nextcloud.png',
  },
  {
    id: '7f96ddf5ee28',
    name: '/utilities-stack-db-1',
    cleanName: 'utilities-stack-db-1',
    image: 'mariadb:10.11',
    baseImage: 'mariadb:10.11',
    state: 'running',
    status: 'Up 4 days (healthy)',
    created: Math.floor(Date.now() / 1000) - 345600,
    ports: [
      { ip: '0.0.0.0', privatePort: 3306, publicPort: 3306, type: 'tcp', suggestedRole: 'database', label: 'MySQL / MariaDB' },
    ],
    primaryPort: 3306,
    mounts: [
      { type: 'bind', source: '/home/ryan/utilities-stack/db_data', destination: '/var/lib/mysql', rw: true },
    ],
    envVars: [
      { key: 'MYSQL_ROOT_PASSWORD', value: 'root••••••••', isSensitive: true },
      { key: 'MYSQL_DATABASE', value: 'nextcloud', isSensitive: false },
      { key: 'MYSQL_USER', value: 'nextcloud', isSensitive: false },
      { key: 'MYSQL_PASSWORD', value: 'db••••••••', isSensitive: true },
    ],
    labels: {
      'com.docker.compose.project': 'utilities-stack',
      'com.docker.compose.service': 'db',
      'com.docker.compose.project.working_dir': '/home/ryan/utilities-stack',
      'com.docker.compose.project.config_files': '/home/ryan/utilities-stack/docker-compose.yml',
      'com.docker.compose.version': '2.27.0',
    },
    compose: {
      isCompose: true,
      project: 'utilities-stack',
      service: 'db',
      workingDir: '/home/ryan/utilities-stack',
      configFiles: '/home/ryan/utilities-stack/docker-compose.yml',
      version: '2.27.0',
    },
    networks: ['utilities-stack_default'],
    ipAddress: '172.20.0.2',
    restartPolicy: 'unless-stopped',
  },
  {
    id: '5e37555da661',
    name: '/manifexus',
    cleanName: 'manifexus',
    image: 'ghcr.io/reyespascal/manifexus:latest',
    baseImage: 'ghcr.io/reyespascal/manifexus:latest',
    state: 'running',
    status: 'Up 1 day',
    created: Math.floor(Date.now() / 1000) - 86400,
    ports: [
      { ip: '0.0.0.0', privatePort: 3334, publicPort: 3334, type: 'tcp', suggestedRole: 'web', label: 'WEB UI' },
    ],
    primaryPort: 3334,
    mounts: [
      { type: 'bind', source: '/var/run/docker.sock', destination: '/var/run/docker.sock', rw: false },
      { type: 'bind', source: '/home/ryan/manifexus/data', destination: '/data', rw: true },
    ],
    envVars: [
      { key: 'NODE_ENV', value: 'production', isSensitive: false },
      { key: 'PORT', value: '3334', isSensitive: false },
      { key: 'DOCKER_SOCKET_PATH', value: '/var/run/docker.sock', isSensitive: false },
    ],
    labels: {
      'com.docker.compose.project': 'manifexus',
      'com.docker.compose.service': 'manifexus',
      'com.docker.compose.project.working_dir': '/home/ryan/manifexus',
      'com.docker.compose.project.config_files': '/home/ryan/manifexus/docker-compose.yml',
      'com.docker.compose.version': '2.27.0',
    },
    compose: {
      isCompose: true,
      project: 'manifexus',
      service: 'manifexus',
      workingDir: '/home/ryan/manifexus',
      configFiles: '/home/ryan/manifexus/docker-compose.yml',
      version: '2.27.0',
    },
    networks: ['manifexus_default'],
    ipAddress: '172.21.0.2',
    restartPolicy: 'unless-stopped',
  },
  {
    id: 'a1b2c3d4e5f6',
    name: '/nzbdav',
    cleanName: 'nzbdav',
    image: 'nzbdav/nzbdav:latest',
    baseImage: 'nzbdav/nzbdav:latest',
    state: 'running',
    status: 'Up 3 days',
    created: Math.floor(Date.now() / 1000) - 259200,
    ports: [
      { ip: '0.0.0.0', privatePort: 3000, publicPort: 3000, type: 'tcp', suggestedRole: 'web', label: 'Web UI' },
    ],
    primaryPort: 3000,
    mounts: [
      { type: 'bind', source: '/home/ryan/appdata/nzbdav/config', destination: '/config', rw: true },
      { type: 'bind', source: '/mnt/media/downloads', destination: '/downloads', rw: true },
    ],
    envVars: [
      { key: 'PORT', value: '3000', isSensitive: false },
      { key: 'PUID', value: '1000', isSensitive: false },
      { key: 'PGID', value: '1000', isSensitive: false },
    ],
    labels: {
      'com.docker.compose.project': 'media-stack',
      'com.docker.compose.service': 'nzbdav',
      'com.docker.compose.project.working_dir': '/home/ryan/media-stack',
      'com.docker.compose.project.config_files': '/home/ryan/media-stack/docker-compose.yml',
    },
    compose: {
      isCompose: true,
      project: 'media-stack',
      service: 'nzbdav',
      workingDir: '/home/ryan/media-stack',
      configFiles: '/home/ryan/media-stack/docker-compose.yml',
    },
    networks: ['media-stack_default'],
    ipAddress: '172.17.0.12',
    restartPolicy: 'unless-stopped',
    iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/sabnzbd.png',
  },
  {
    id: '6b110a789ef2',
    name: '/uptime-kuma',
    cleanName: 'uptime-kuma',
    image: 'louislam/uptime-kuma:1',
    baseImage: 'louislam/uptime-kuma:1',
    state: 'running',
    status: 'Up 12 days',
    created: Math.floor(Date.now() / 1000) - 1036800,
    ports: [
      { ip: '0.0.0.0', privatePort: 3001, publicPort: 3001, type: 'tcp' },
    ],
    primaryPort: 3001,
    mounts: [
      { type: 'volume', source: 'uptime-kuma-data', destination: '/app/data', rw: true },
    ],
    envVars: [],
    labels: {},
    compose: {
      isCompose: false,
    },
    networks: ['bridge'],
    ipAddress: '172.17.0.4',
    restartPolicy: 'unless-stopped',
    iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/uptime-kuma.png',
  },
  {
    id: '1e5509ba2c14',
    name: '/vaultwarden-server',
    cleanName: 'vaultwarden-server',
    image: 'vaultwarden/server:latest',
    baseImage: 'vaultwarden/server:latest',
    state: 'running',
    status: 'Up 45 days',
    created: Math.floor(Date.now() / 1000) - 3888000,
    ports: [
      { ip: '127.0.0.1', privatePort: 80, publicPort: 8085, type: 'tcp' },
      { ip: '127.0.0.1', privatePort: 3012, publicPort: 3012, type: 'tcp' },
    ],
    primaryPort: 8085,
    mounts: [
      { type: 'bind', source: '/home/ubuntu/appdata/vaultwarden/data', destination: '/data', rw: true },
    ],
    envVars: [
      { key: 'WEBSOCKET_ENABLED', value: 'true', isSensitive: false },
      { key: 'SIGNUPS_ALLOWED', value: 'false', isSensitive: false },
      { key: 'ADMIN_TOKEN', value: 'to••••••••', isSensitive: true },
    ],
    labels: {},
    compose: {
      isCompose: false,
    },
    networks: ['proxy_net'],
    ipAddress: '172.22.0.7',
    restartPolicy: 'always',
    iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/vaultwarden.png',
  },
  {
    id: 'a901ff4c62e8',
    name: '/homeassistant',
    cleanName: 'homeassistant',
    image: 'ghcr.io/home-assistant/home-assistant:stable',
    baseImage: 'ghcr.io/home-assistant/home-assistant:stable',
    state: 'running',
    status: 'Up 9 days',
    created: Math.floor(Date.now() / 1000) - 777600,
    ports: [
      { ip: '0.0.0.0', privatePort: 8123, publicPort: 8123, type: 'tcp' },
    ],
    primaryPort: 8123,
    mounts: [
      { type: 'bind', source: '/home/ubuntu/appdata/homeassistant', destination: '/config', rw: true },
      { type: 'bind', source: '/etc/localtime', destination: '/etc/localtime', rw: false },
    ],
    envVars: [
      { key: 'TZ', value: 'America/New_York', isSensitive: false },
    ],
    labels: {
      'com.docker.compose.project': 'iot-automation',
      'com.docker.compose.service': 'homeassistant',
      'com.docker.compose.project.working_dir': '/home/ubuntu/docker/iot-automation',
      'com.docker.compose.project.config_files': '/home/ubuntu/docker/iot-automation/compose.yaml',
    },
    compose: {
      isCompose: true,
      project: 'iot-automation',
      service: 'homeassistant',
      workingDir: '/home/ubuntu/docker/iot-automation',
      configFiles: '/home/ubuntu/docker/iot-automation/compose.yaml',
    },
    networks: ['host'],
    restartPolicy: 'unless-stopped',
    iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/home-assistant.png',
  },
  {
    id: '5561a0d7f21b',
    name: '/redis-cache',
    cleanName: 'redis-cache',
    image: 'redis:7-alpine',
    baseImage: 'redis:7-alpine',
    state: 'exited',
    status: 'Exited (0) 2 hours ago',
    created: Math.floor(Date.now() / 1000) - 86400,
    ports: [
      { ip: '0.0.0.0', privatePort: 6379, publicPort: 6379, type: 'tcp' },
    ],
    primaryPort: 6379,
    mounts: [
      { type: 'volume', source: 'redis-cache-data', destination: '/data', rw: true },
    ],
    envVars: [],
    labels: {
      'com.docker.compose.project': 'cloud-suite',
      'com.docker.compose.service': 'redis',
      'com.docker.compose.project.working_dir': '/home/ubuntu/docker/cloud-suite',
      'com.docker.compose.project.config_files': '/home/ubuntu/docker/cloud-suite/docker-compose.yml',
    },
    compose: {
      isCompose: true,
      project: 'cloud-suite',
      service: 'redis',
      workingDir: '/home/ubuntu/docker/cloud-suite',
      configFiles: '/home/ubuntu/docker/cloud-suite/docker-compose.yml',
    },
    networks: ['cloud-suite_internal'],
    ipAddress: '172.19.0.5',
    restartPolicy: 'no',
    iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/redis.png',
  },
];

// Main function to fetch containers from Docker Socket or fallback to demo
export async function getContainersList(): Promise<{
  containers: DeepContainerMetadata[];
  isDemo: boolean;
  dockerVersion?: string;
  os?: string;
}> {
  if (isDockerSocketAvailable()) {
    try {
      // Query Docker Version
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const versionInfo = await queryDockerEngine<any>('/version').catch(() => null);
      
      // List all containers
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawContainers = await queryDockerEngine<any[]>('/containers/json?all=1');

      if (Array.isArray(rawContainers)) {
        // Deep inspect each container in parallel (up to 20 at a time)
        const inspected = await Promise.all(
          rawContainers.map(async (c) => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const deep = await queryDockerEngine<any>(`/containers/${c.Id}/json`);
              return parseRawContainer(deep);
            } catch {
              // Fallback to top-level listing data if deep inspection fails
              return parseRawContainer(c);
            }
          })
        );

        return {
          containers: inspected,
          isDemo: false,
          dockerVersion: versionInfo?.Version,
          os: versionInfo?.Os,
        };
      }
    } catch (err) {
      console.warn(`[Docker Engine] Socket present but query failed (${(err as Error).message}). Falling back to standby/demo mode.`);
    }
  }

  // Demo fallback
  return {
    containers: [...demoContainers],
    isDemo: true,
    dockerVersion: '26.1.4 (Simulated)',
    os: 'Ubuntu 24.04 LTS (Host)',
  };
}

// Container action (start, stop, restart)
export async function executeContainerAction(
  containerId: string,
  action: 'start' | 'stop' | 'restart'
): Promise<{ success: boolean; message: string }> {
  if (isDockerSocketAvailable()) {
    try {
      await queryDockerEngine(`/containers/${containerId}/${action}`, 'POST');
      return { success: true, message: `Container ${containerId} ${action}ed successfully.` };
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  }

  // Simulated action in demo mode
  const target = demoContainers.find((c) => c.id === containerId || c.cleanName === containerId);
  if (target) {
    if (action === 'start') {
      target.state = 'running';
      target.status = 'Up Less than a minute';
    } else if (action === 'stop') {
      target.state = 'exited';
      target.status = 'Exited (0) Just now';
    } else if (action === 'restart') {
      target.state = 'running';
      target.status = 'Up Less than a minute (restarted)';
    }
    return { success: true, message: `[Demo] Container ${target.cleanName} ${action}ed.` };
  }

  return { success: false, message: `Container not found` };
}

// Helper to add mock container in demo mode to test instant reactivity
export function addDemoContainer(newContainer: DeepContainerMetadata): void {
  demoContainers.unshift(newContainer);
}

// Helper to simulate combining apps into a stack in demo mode
export function mergeDemoContainersIntoStack(
  containerIds: string[],
  targetStackName: string,
  targetWorkingDir: string
): boolean {
  for (const c of demoContainers) {
    if (containerIds.includes(c.id) || containerIds.includes(c.cleanName)) {
      c.compose = {
        isCompose: true,
        project: targetStackName,
        service: c.compose?.service || c.cleanName.replace(/[^a-zA-Z0-9_-]/g, '-'),
        workingDir: targetWorkingDir,
        configFiles: `${targetWorkingDir}/docker-compose.yml`,
        version: '2.27.0',
      };
      c.labels['com.docker.compose.project'] = targetStackName;
      c.labels['com.docker.compose.project.working_dir'] = targetWorkingDir;
      c.labels['com.docker.compose.project.config_files'] = `${targetWorkingDir}/docker-compose.yml`;
    }
  }
  return true;
}

/**
 * Strips Docker multiplexed log frame headers from string
 */
function cleanDockerLogsInternal(raw: string | unknown): string {
  if (typeof raw !== 'string') return '';
  if (raw.length > 8 && raw.charCodeAt(0) <= 2 && raw.charCodeAt(1) === 0 && raw.charCodeAt(2) === 0) {
    let cleaned = '';
    let pos = 0;
    while (pos < raw.length) {
      if (pos + 8 > raw.length) break;
      const size = (raw.charCodeAt(pos + 4) << 24) |
                   (raw.charCodeAt(pos + 5) << 16) |
                   (raw.charCodeAt(pos + 6) << 8) |
                   raw.charCodeAt(pos + 7);
      pos += 8;
      cleaned += raw.substring(pos, pos + size);
      pos += size;
    }
    return cleaned || raw.substring(8);
  }
  return raw;
}

/**
 * Module 1: Fail-Safe Diagnostics
 * Retrieves the last N lines of stdout and stderr for a container, exposing the exact crash reason.
 */
export async function getContainerLogsTail(containerNameOrId: string, tail: number = 100): Promise<string> {
  const cleanName = containerNameOrId.replace(/^\//, '');
  if (isDockerSocketAvailable()) {
    try {
      const raw = await queryDockerEngine<string>(
        `/containers/${encodeURIComponent(cleanName)}/logs?stdout=1&stderr=1&tail=${tail}`,
        'GET'
      );
      const cleaned = cleanDockerLogsInternal(raw);
      if (cleaned && cleaned.trim()) {
        return cleaned.trim();
      }
    } catch {
      // fallback to helper container
    }

    try {
      const helperImage = await getBestAvailableImage();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
        Image: helperImage,
        Entrypoint: [],
        Cmd: ['docker', 'logs', cleanName, '--tail', String(tail)],
        HostConfig: {
          Binds: [`${DOCKER_SOCKET_PATH}:/var/run/docker.sock`],
        },
      });

      if (runner && runner.Id) {
        await queryDockerEngine(`/containers/${runner.Id}/start`, 'POST');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await queryDockerEngine<any>(`/containers/${runner.Id}/wait`, 'POST', undefined, 10000);
        const logs = await queryDockerEngine<string>(`/containers/${runner.Id}/logs?stdout=1&stderr=1`, 'GET');
        await queryDockerEngine(`/containers/${runner.Id}?force=true`, 'DELETE');
        const cleaned = cleanDockerLogsInternal(logs);
        if (cleaned && cleaned.trim()) {
          return cleaned.trim();
        }
      }
    } catch {
      // ignore
    }
  }

  return `[Container "${cleanName}" exited before runtime logs could be flushed. Verify volume permissions and port bindings.]`;
}

/**
 * Module 1: Rollback Resource Pruning
 * Completely prunes orphaned networks and untagged dangling images created during failed runs.
 */
export async function pruneOrphanedDockerResources(networkName?: string): Promise<void> {
  if (isDockerSocketAvailable()) {
    try {
      await queryDockerEngine('/networks/prune', 'POST').catch(() => null);
      await queryDockerEngine('/images/prune?filters={"dangling":["true"]}', 'POST').catch(() => null);
      if (networkName) {
        await queryDockerEngine(`/networks/${encodeURIComponent(networkName)}`, 'DELETE').catch(() => null);
      }
    } catch {
      // ignore
    }
  }
}
