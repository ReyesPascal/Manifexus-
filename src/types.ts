export interface ContainerPort {
  ip?: string;
  privatePort: number;
  publicPort?: number;
  type: 'tcp' | 'udp';
}

export interface ContainerMount {
  type: string;
  source: string;
  destination: string;
  mode?: string;
  rw: boolean;
}

export interface ComposeMetadata {
  isCompose: boolean;
  project?: string;
  service?: string;
  workingDir?: string;
  configFiles?: string;
  version?: string;
  oneOff?: boolean;
}

export interface DeepContainerMetadata {
  id: string;
  name: string;
  cleanName: string;
  image: string;
  baseImage: string;
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'dead' | 'created';
  status: string;
  created: number; // Unix timestamp
  command?: string;
  entrypoint?: string;
  ports: ContainerPort[];
  primaryPort?: number;
  mounts: ContainerMount[];
  envVars: { key: string; value: string; isSensitive: boolean }[];
  labels: Record<string, string>;
  compose: ComposeMetadata;
  networks: string[];
  ipAddress?: string;
  restartPolicy?: string;
  iconUrl?: string;
  customGroup?: string;
  customName?: string;
  customUrl?: string;
  notes?: string;
  isHidden?: boolean;
}

export interface UserGroup {
  id: string;
  name: string;
  color: string;
  icon: string;
  description?: string;
  order: number;
}

export interface AppOverride {
  customName?: string;
  customGroup?: string;
  customPort?: number;
  customIcon?: string;
  customUrl?: string;
  isHidden?: boolean;
  notes?: string;
}

export interface ManifexusConfig {
  groups: UserGroup[];
  appOverrides: Record<string, AppOverride>; // key is container id or name
  hostAddress: string; // e.g., 'localhost' or '192.168.1.50'
  defaultViewMode: 'groups' | 'compose';
  refreshIntervalSeconds: number;
}

export interface SystemStatus {
  dockerConnected: boolean;
  isDemoMode: boolean;
  socketPath: string;
  dockerVersion?: string;
  operatingSystem?: string;
  serverTime: string;
  totalContainers: number;
  runningContainers: number;
  stoppedContainers: number;
  composeStacksCount: number;
}
