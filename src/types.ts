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
  /** Docker volume name, for type 'volume' mounts */
  name?: string;
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
  ipAddresses?: string[];
  restartPolicy?: string;
  iconUrl?: string;
  /** Where the icon came from (an icon set, the app's own page, GitHub) */
  iconSource?: string;
  /** A friendlier name than the container's (its page title or service name) */
  friendlyName?: string;
  /** The published port Open uses: the app's web page (none when it has no web page) */
  webPort?: number;
  /** Other published ports that are web pages too */
  otherWebPorts?: number[];
  /** false when the app was checked and has no web page */
  hasWeb?: boolean;
  /** The app's project on GitHub and its latest release */
  project?: { url?: string; repo?: string; latest?: string; imageSource?: string };
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
  /** Folder new stacks are created in. Empty = use the folder existing stacks share. */
  stacksDir?: string;
  /** Version 1.1 set up its example problem for the built-in AI (only ever done once) */
  aiExampleSeeded?: boolean;
  /** Names shown for stacks on the dashboard, by compose project; the folder keeps its real name */
  stackNames?: Record<string, string>;
  /** Icons people chose for their stacks, by stack */
  stackIcons?: Record<string, { symbol?: string; svg?: string; color?: string; logo?: string }>;
  /** Simple keeps screens clean; Advanced shows the technical side (commands, and later the terminal editor) */
  experienceMode?: 'simple' | 'advanced';
  /** Show the command behind each step. Unset = follow the mode (on in Advanced) */
  showCommands?: boolean;
  /** Text Size: the smallest the dashboard is drawn (it grows to fit when there's room) */
  textSize?: 'default' | 'large' | 'larger';
  /** Server Changes: off until turned on. Off, Manifexus only looks (and starts, stops or restarts apps) */
  allowServerChanges?: boolean;
  /** Getting Started (setup and tour) was finished or skipped; false only on a brand-new install */
  onboardingDone?: boolean;
}

export interface EmptyComposeStack {
  project: string;
  workingDir: string;
  configFiles: string;
  serviceCount: number;
  source?: 'discovered' | 'provisioned';
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
  /** Problems that make the move impossible as selected (e.g. a VPN dependency left behind) */
  blockers?: string[];
  /** Things that change and the user should know about */
  warnings?: string[];
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
  /** Server Changes is turned on in Manifexus */
  allowChanges: boolean;
  canAutoExecute: boolean;
  statusMessage: string;
  details: {
    socketPath: string;
    socketWritable: boolean;
    hostMounts: string[];
    dockerCliAvailable: boolean;
  };
}

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export type LogEventType =
  | 'API_CALL'
  | 'DOCKER_EXEC'
  | 'STATE_CHANGE'
  | 'SYSTEM'
  | 'AUTH'
  | 'STACK_OP';

export interface StructuredLogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  eventType: LogEventType;
  message: string;
  source: string;
  payload?: Record<string, unknown> | unknown[];
  metadata?: {
    method?: string;
    route?: string;
    statusCode?: number;
    durationMs?: number;
    ip?: string;
    userAgent?: string;
    [key: string]: unknown;
  };
  executionDetails?: {
    command?: string;
    targetContainer?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    durationMs?: number;
  };
  error?: {
    message: string;
    stack?: string;
    code?: string | number;
  };
}

export interface LogQueryResult {
  logs: StructuredLogEntry[];
  total: number;
  filteredCount: number;
  logFilesCount: number;
  activeLogFile: string;
  storageDir: string;
}
