import fs from 'fs';
import path from 'path';
import { ManifexusConfig, UserGroup, AppOverride } from '../src/types';

// Use /data if available (production Docker volume), else local ./data
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_GROUPS: UserGroup[] = [
  { id: 'media', name: 'Media & Streaming', color: '#ec4899', icon: 'Film', description: 'Plex, Jellyfin, Sonarr, Radarr', order: 1 },
  { id: 'networking', name: 'Networking & DNS', color: '#06b6d4', icon: 'Network', description: 'Pi-hole, Nginx Proxy Manager, WireGuard', order: 2 },
  { id: 'databases', name: 'Databases & Storage', color: '#eab308', icon: 'Database', description: 'PostgreSQL, Redis, Nextcloud', order: 3 },
  { id: 'monitoring', name: 'Monitoring & Ops', color: '#10b981', icon: 'Activity', description: 'Portainer, Uptime Kuma, Grafana', order: 4 },
  { id: 'home', name: 'Home Automation', color: '#8b5cf6', icon: 'Home', description: 'Home Assistant, Zigbee2MQTT', order: 5 },
  { id: 'tools', name: 'Utilities & Tools', color: '#64748b', icon: 'Wrench', description: 'Vaultwarden, Watchtower, Syncthing', order: 6 },
];

const DEFAULT_CONFIG: ManifexusConfig = {
  groups: DEFAULT_GROUPS,
  appOverrides: {},
  hostAddress: 'localhost',
  defaultViewMode: 'compose',
  refreshIntervalSeconds: 10,
};

// Ensure directory exists
export function ensureDataDirectory(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error(`[Storage] Failed to initialize storage dir ${DATA_DIR}:`, err);
  }
}

export function getConfig(): ManifexusConfig {
  ensureDataDirectory();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        groups: Array.isArray(parsed.groups) && parsed.groups.length > 0 ? parsed.groups : DEFAULT_CONFIG.groups,
      };
    }
  } catch (err) {
    console.error('[Storage] Error reading config file:', err);
  }
  return DEFAULT_CONFIG;
}

export function saveConfig(config: Partial<ManifexusConfig>): ManifexusConfig {
  ensureDataDirectory();
  const current = getConfig();
  const updated: ManifexusConfig = {
    ...current,
    ...config,
    groups: config.groups || current.groups,
    appOverrides: {
      ...current.appOverrides,
      ...(config.appOverrides || {}),
    },
  };

  try {
    const tempFile = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(updated, null, 2), 'utf-8');
    fs.renameSync(tempFile, CONFIG_FILE);
  } catch (err) {
    console.error('[Storage] Error saving config file:', err);
  }

  return updated;
}

export function updateAppOverride(containerKey: string, override: AppOverride): ManifexusConfig {
  const current = getConfig();
  const appOverrides = { ...current.appOverrides };
  
  if (Object.keys(override).length === 0) {
    delete appOverrides[containerKey];
  } else {
    appOverrides[containerKey] = {
      ...(appOverrides[containerKey] || {}),
      ...override,
    };
  }

  return saveConfig({ appOverrides });
}
