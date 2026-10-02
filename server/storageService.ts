import fs from 'fs';
import path from 'path';
import { ManifexusConfig, UserGroup, AppOverride } from '../src/types';
import { cachedJsonReader, writeJsonAtomic } from './safeJson';

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
  // A brand-new install starts with Getting Started
  onboardingDone: false,
};

// Ensure directory exists (checked once; settings are read on every refresh)
let dataDirReady = false;
export function ensureDataDirectory(): void {
  if (dataDirReady) return;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(CONFIG_FILE) && !fs.existsSync(`${CONFIG_FILE}.bak`)) {
      writeJsonAtomic(CONFIG_FILE, DEFAULT_CONFIG, { backup: false });
    }
    dataDirReady = true;
  } catch (err) {
    console.error(`[Storage] Failed to initialize storage dir ${DATA_DIR}:`, err);
  }
}

// Settings stay in memory and are read again only when the file changes; a damaged file is set aside and
// the last good copy is used, so a bad read can never turn into a save that resets everything to defaults
const configReader = cachedJsonReader<Partial<ManifexusConfig> | null>(CONFIG_FILE, () => null);

export function getConfig(): ManifexusConfig {
  ensureDataDirectory();
  try {
    const parsed = configReader.read();
    if (parsed && typeof parsed === 'object') {
      return {
        ...DEFAULT_CONFIG,
        // Settings saved before Getting Started existed: that's an install already in use, so don't start it
        onboardingDone: parsed.onboardingDone ?? true,
        ...parsed,
        groups: Array.isArray(parsed.groups) && parsed.groups.length > 0 ? parsed.groups : DEFAULT_CONFIG.groups,
      } as ManifexusConfig;
    }
  } catch (err) {
    console.error('[Storage] Error reading config file:', err);
  }
  return structuredClone(DEFAULT_CONFIG);
}

/**
 * Saves settings. App customisations passed in are added to the saved ones, unless `replaceOverrides` is set
 * (the caller sends the complete, updated list, e.g. after removing one).
 */
export function saveConfig(config: Partial<ManifexusConfig>, opts: { replaceOverrides?: boolean } = {}): ManifexusConfig {
  ensureDataDirectory();
  const current = getConfig();
  const updated: ManifexusConfig = {
    ...current,
    ...config,
    groups: config.groups || current.groups,
    appOverrides: opts.replaceOverrides && config.appOverrides
      ? config.appOverrides
      : {
          ...current.appOverrides,
          ...(config.appOverrides || {}),
        },
  };

  try {
    writeJsonAtomic(CONFIG_FILE, updated);
    configReader.forget();
  } catch (err) {
    console.error('[Storage] Error saving config file:', err);
    throw new Error('Your settings couldn’t be saved. Check that Manifexus’s data folder has free space.');
  }

  return updated;
}

export function updateAppOverride(containerKey: string, override: AppOverride): ManifexusConfig {
  const current = getConfig();
  const appOverrides = { ...current.appOverrides };
  // Cleared fields (empty or null) are removed, so the app goes back to its own name, icon and so on
  const merged: Record<string, unknown> = { ...(appOverrides[containerKey] || {}), ...override };
  for (const [k, v] of Object.entries(merged)) if (v === null || v === undefined || v === '') delete merged[k];
  if (Object.keys(override).length === 0 || Object.keys(merged).length === 0) delete appOverrides[containerKey];
  else appOverrides[containerKey] = merged as AppOverride;

  return saveConfig({ appOverrides }, { replaceOverrides: true });
}
