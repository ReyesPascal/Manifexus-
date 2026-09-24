export interface ContainerPort {
  ip?: string;
  privatePort: number;
  publicPort?: number;
  type: 'tcp' | 'udp';
  suggestedRole?: 'web' | 'p2p' | 'database' | 'dns' | 'service';
  label?: string;
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
  rawEnvVars?: { key: string; value: string }[];
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

export interface VolumeSafetyAuditItem {
  service: string;
  type: 'bind' | 'named_volume';
  source: string;
  destination: string;
  verdict: 'safe_absolute' | 'safe_external_volume' | 'safe_converted_absolute' | 'requires_migration';
  badgeText: string;
  explanation: string;
}

export interface PortConflictItem {
  port: number;
  services: string[];
  conflict: boolean;
  recommendation?: string;
}

export interface StackMergePlan {
  targetStackName: string;
  targetDirectory: string;
  mode: 'existing-stack' | 'new-stack';
  sourceStacks: string[];
  sourceContainersCount: number;
  services: {
    serviceName: string;
    containerName: string;
    image: string;
    ports: string[];
    volumes: string[];
    originalProject?: string;
    originalWorkingDir?: string;
  }[];
  volumeSafetyAudit: VolumeSafetyAuditItem[];
  portConflicts: PortConflictItem[];
  generatedComposeYaml: string;
  migrationScript: string;
  rollbackScript: string;
  cleanupScript: string;
}

export interface AutomationPrivileges {
  isDockerConnected: boolean;
  isSocketWritable: boolean;
  isHostFsMounted: boolean;
  hostRootPath: string;
  hasDockerCli: boolean;
  mode: 'sandboxed' | 'elevated';
  canAutoExecute: boolean;
  statusMessage: string;
  details: {
    socketPath: string;
    socketWritable: boolean;
    hostMounts: string[];
    dockerCliAvailable: boolean;
  };
}

export interface RemappedPort {
  service: string;
  originalHostPort: number;
  allocatedHostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
  hostIp?: string;
  reason: string;
}

export interface RemoteComposeMetadata {
  url: string;
  resolvedSourceUrl: string;
  rawYaml: string;
  serviceNames: string[];
  serviceDetails: {
    name: string;
    image?: string;
    containerName?: string;
    ports: {
      service: string;
      hostPort?: number;
      containerPort: number;
      protocol: 'tcp' | 'udp';
      hostIp?: string;
    }[];
    volumeCount: number;
    networkCount: number;
  }[];
  isGitHubRepo: boolean;
  repoOwner?: string;
  repoName?: string;
  occupiedPorts?: number[];
}

export interface DiagnosticMicroStep {
  stepIndex: number;
  stepId: string;
  stepName: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  timestamp: string;
  durationMs?: number;
  logs: string[];
  metadata?: Record<string, unknown>;
}

export interface DiagnosticBundle {
  installId: string;
  timestamp: string;
  completedAt?: string;
  deploymentType: 'new-stack' | 'existing-stack';
  targetStackName: string;
  targetPath: string;
  sourceUrl: string;
  initialAstSnapshot?: Record<string, unknown> | null;
  fetchedRemoteAst?: Record<string, unknown> | null;
  finalMergedAst?: Record<string, unknown> | null;
  fileWriteBytes?: number;
  targetComposePath?: string;
  dockerExecutionCommand?: string;
  cwd?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  success: boolean;
  errorStackTrace?: string | null;
  microSteps: DiagnosticMicroStep[];
  systemEnvironment?: {
    nodeEnv: string;
    dockerSocket: string;
    hostRoot: string;
    logsDir: string;
    platform: string;
  };
}

