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
function queryDockerEngine<T>(path: string, method: string = 'GET'): Promise<T> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      socketPath: DOCKER_SOCKET_PATH,
      path: path,
      method: method,
      headers: {
        Host: 'docker.local',
        Accept: 'application/json',
      },
      timeout: 5000,
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
          } catch (e) {
            reject(new Error(`Failed to parse Docker response from ${path}: ${(e as Error).message}`));
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

    req.end();
  });
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

  // Extract Ports
  const ports: ContainerPort[] = [];
  const rawPortBindings = inspectData.NetworkSettings?.Ports || {};
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
  } else {
    for (const [key, bindings] of Object.entries(rawPortBindings)) {
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
      } else {
        ports.push({
          privatePort: privPort,
          type: protocol,
        });
      }
    }
  }

  // Find primary web port: prioritize published publicPort (like 80, 8080, 3000, 8096, 32400)
  const sortedPublished = ports.filter((p) => p.publicPort && p.type === 'tcp');
  const primaryPort = sortedPublished.length > 0 ? sortedPublished[0].publicPort : ports[0]?.publicPort || ports[0]?.privatePort;

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
    ports,
    primaryPort,
    mounts,
    envVars,
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
    id: '4d156b829cc1',
    name: '/nextcloud-hub',
    cleanName: 'nextcloud-hub',
    image: 'nextcloud:28-apache',
    baseImage: 'nextcloud:28-apache',
    state: 'running',
    status: 'Up 3 days',
    created: Math.floor(Date.now() / 1000) - 259200,
    ports: [
      { ip: '0.0.0.0', privatePort: 80, publicPort: 8088, type: 'tcp' },
    ],
    primaryPort: 8088,
    mounts: [
      { type: 'bind', source: '/mnt/storage/nextcloud_data', destination: '/var/www/html/data', rw: true },
      { type: 'bind', source: '/home/ubuntu/appdata/nextcloud/config', destination: '/var/www/html/config', rw: true },
    ],
    envVars: [
      { key: 'POSTGRES_HOST', value: 'db-postgres', isSensitive: false },
      { key: 'POSTGRES_DB', value: 'nextcloud', isSensitive: false },
      { key: 'POSTGRES_USER', value: 'oc_admin', isSensitive: false },
      { key: 'POSTGRES_PASSWORD', value: 'db••••••••', isSensitive: true },
      { key: 'NEXTCLOUD_ADMIN_USER', value: 'sysadmin', isSensitive: false },
      { key: 'NEXTCLOUD_ADMIN_PASSWORD', value: 'ad••••••••', isSensitive: true },
    ],
    labels: {
      'com.docker.compose.project': 'cloud-suite',
      'com.docker.compose.service': 'app',
      'com.docker.compose.project.working_dir': '/home/ubuntu/docker/cloud-suite',
      'com.docker.compose.project.config_files': '/home/ubuntu/docker/cloud-suite/docker-compose.yml',
    },
    compose: {
      isCompose: true,
      project: 'cloud-suite',
      service: 'app',
      workingDir: '/home/ubuntu/docker/cloud-suite',
      configFiles: '/home/ubuntu/docker/cloud-suite/docker-compose.yml',
    },
    networks: ['cloud-suite_internal'],
    ipAddress: '172.19.0.3',
    restartPolicy: 'unless-stopped',
    iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/nextcloud.png',
  },
  {
    id: '92e8ca4b11f3',
    name: '/db-postgres',
    cleanName: 'db-postgres',
    image: 'postgres:16-alpine',
    baseImage: 'postgres:16-alpine',
    state: 'running',
    status: 'Up 3 days (healthy)',
    created: Math.floor(Date.now() / 1000) - 259200,
    ports: [
      { ip: '127.0.0.1', privatePort: 5432, publicPort: 5432, type: 'tcp' },
    ],
    primaryPort: 5432,
    mounts: [
      { type: 'bind', source: '/home/ubuntu/appdata/postgres/data', destination: '/var/lib/postgresql/data', rw: true },
    ],
    envVars: [
      { key: 'POSTGRES_DB', value: 'nextcloud', isSensitive: false },
      { key: 'POSTGRES_USER', value: 'oc_admin', isSensitive: false },
      { key: 'POSTGRES_PASSWORD', value: 'db••••••••', isSensitive: true },
    ],
    labels: {
      'com.docker.compose.project': 'cloud-suite',
      'com.docker.compose.service': 'db',
      'com.docker.compose.project.working_dir': '/home/ubuntu/docker/cloud-suite',
      'com.docker.compose.project.config_files': '/home/ubuntu/docker/cloud-suite/docker-compose.yml',
    },
    compose: {
      isCompose: true,
      project: 'cloud-suite',
      service: 'db',
      workingDir: '/home/ubuntu/docker/cloud-suite',
      configFiles: '/home/ubuntu/docker/cloud-suite/docker-compose.yml',
    },
    networks: ['cloud-suite_internal'],
    ipAddress: '172.19.0.2',
    restartPolicy: 'unless-stopped',
    iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/postgresql.png',
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
