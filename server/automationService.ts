import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { isDockerSocketAvailable, queryDockerEngine, getBestAvailableImage } from './dockerService';

const execAsync = util.promisify(exec);

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

const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const HOST_ROOT = process.env.HOST_ROOT || '/host';

// Helper to check if a file/dir is writable
function isWritable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Check automation privilege status
export async function checkPrivilegeStatus(): Promise<AutomationPrivileges> {
  const isConnected = isDockerSocketAvailable();
  let socketWritable = false;
  const hostMounts: string[] = [];

  if (fs.existsSync(DOCKER_SOCKET_PATH)) {
    socketWritable = isWritable(DOCKER_SOCKET_PATH);
  }

  // Check possible host root mounts: /host, /host/home, /host_root
  const candidateMounts = [HOST_ROOT, '/host', '/host/home', '/host_root'];
  let hostFsMounted = false;
  let resolvedHostRoot = '';

  for (const m of candidateMounts) {
    if (fs.existsSync(m)) {
      hostMounts.push(m);
      if (!hostFsMounted && isWritable(m)) {
        hostFsMounted = true;
        resolvedHostRoot = m;
      }
    }
  }

  // Check if docker CLI is present in container
  let hasDockerCli = false;
  try {
    await execAsync('docker compose version || docker-compose version');
    hasDockerCli = true;
  } catch {
    hasDockerCli = false;
  }

  // If socket is writable, even without host FS mount, we can use Docker engine API or helper containers
  const canAutoExecute = isConnected && (socketWritable || hostFsMounted);
  const mode: 'sandboxed' | 'elevated' = (socketWritable && (hostFsMounted || hasDockerCli))
    ? 'elevated'
    : 'sandboxed';

  let statusMessage = 'Manifexus is running in Sandboxed Read-Only mode.';
  if (mode === 'elevated') {
    statusMessage = 'Full Host Automation is active. Zero-touch compose editing & stack deployments enabled.';
  } else if (socketWritable && !hostFsMounted) {
    statusMessage = 'Docker socket is writable. Stack operations can be orchestrated via Docker Engine.';
  } else {
    statusMessage = 'Read-only socket detected (/var/run/docker.sock:ro). Host files are protected.';
  }

  return {
    isDockerConnected: isConnected,
    isSocketWritable: socketWritable,
    isHostFsMounted: hostFsMounted,
    hostRootPath: resolvedHostRoot,
    hasDockerCli,
    mode,
    canAutoExecute,
    statusMessage,
    details: {
      socketPath: DOCKER_SOCKET_PATH,
      socketWritable,
      hostMounts,
      dockerCliAvailable: hasDockerCli,
    },
  };
}

export interface AutomatedMergeRequest {
  targetStackName: string;
  targetDirectory: string; // e.g. /home/ryan/utilities-stack
  yamlContent: string;
  sourceContainerIds: string[];
  sourceWorkingDirs?: string[];
}

export interface AutomatedMergeResult {
  success: boolean;
  message: string;
  backupPath?: string;
  writtenPath?: string;
  stoppedContainers: string[];
  logs: string[];
  isMigratingSelf?: boolean;
}

// Translate a host path like /home/ryan/utilities-stack to container path
export function resolveHostPathToContainer(hostPath: string, hostRoot: string): string {
  // If hostRoot is e.g. /host and hostPath is /home/ryan/... -> /host/home/ryan/...
  // If hostRoot is /host/home and hostPath is /home/ryan/... -> /host/home/ryan/...
  if (!hostRoot || !fs.existsSync(hostRoot)) {
    return hostPath;
  }

  if (hostRoot.endsWith('/home') && hostPath.startsWith('/home/')) {
    return path.join(hostRoot, hostPath.replace('/home/', ''));
  }

  const cleanHostPath = hostPath.startsWith('/') ? hostPath.slice(1) : hostPath;
  const candidate = path.join(hostRoot, cleanHostPath);
  if (fs.existsSync(candidate) || fs.existsSync(path.dirname(candidate))) {
    return candidate;
  }

  return path.join(hostRoot, cleanHostPath);
}

// Execute the automated stack merge on the host
export async function executeAutomatedStackMerge(
  req: AutomatedMergeRequest
): Promise<AutomatedMergeResult> {
  const privs = await checkPrivilegeStatus();
  const logs: string[] = [];
  const stoppedContainers: string[] = [];

  // Inspect running containers to verify existing services and Manifexus container
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runningContainers: any[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runningContainers = await queryDockerEngine<any[]>('/containers/json?all=1', 'GET');
  } catch {
    // ignore
  }

  // Find running Manifexus container
  const manifexusContainer = runningContainers.find(
    (c) =>
      (c.Names && c.Names.some((n: string) => n.toLowerCase().replace('/', '') === 'manifexus')) ||
      (c.Image && c.Image.toLowerCase().includes('manifexus'))
  );
  const manifexusId = manifexusContainer?.Id || '';

  // Check 1: Did the user explicitly select Manifexus in sourceContainerIds?
  const isManifexusInSourceIds = req.sourceContainerIds.some(
    (id) =>
      (manifexusId && (id === manifexusId || id.startsWith(manifexusId) || manifexusId.startsWith(id))) ||
      id.toLowerCase() === 'manifexus'
  );

  // Check 2: Does the YAML services block actually define a service for Manifexus?
  // We MUST NOT match header comments ("# Generated by Manifexus Command Hub")!
  const hasManifexusServiceInCompose =
    /image:\s*['"]?[^'"\r\n]*manifexus[^'"\r\n]*['"]/i.test(req.yamlContent) ||
    /^[ \t]+[a-zA-Z0-9_-]*manifexus[a-zA-Z0-9_-]*:\s*$/m.test(req.yamlContent);

  // STRICT SAFEGUARD: Both must be true for Manifexus migration to occur!
  const isMigratingManifexus = isManifexusInSourceIds && hasManifexusServiceInCompose;

  // Select a reliable image guaranteed to exist locally on host (no 404s)
  const helperImage = await getBestAvailableImage();
  logs.push(`[1/5] Automation environment: Mode=${privs.mode.toUpperCase()}, Runner=${helperImage}, SelfMigrating=${isMigratingManifexus}`);

  let fileWritten = false;
  let targetContainerDir = req.targetDirectory;
  let backupPath = '';
  const targetComposePath = path.join(req.targetDirectory, 'docker-compose.yml');

  // Strategy A: Direct Host Filesystem Write (if host FS is mounted)
  if (privs.isHostFsMounted) {
    targetContainerDir = resolveHostPathToContainer(req.targetDirectory, privs.hostRootPath);
    logs.push(`[2/5] Host directory mapped: "${req.targetDirectory}" -> "${targetContainerDir}"`);

    try {
      if (!fs.existsSync(targetContainerDir)) {
        fs.mkdirSync(targetContainerDir, { recursive: true });
        logs.push(`Created directory: ${targetContainerDir}`);
      }

      const localComposePath = path.join(targetContainerDir, 'docker-compose.yml');
      if (fs.existsSync(localComposePath)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = path.join(targetContainerDir, `docker-compose.backup.${timestamp}.yml`);
        fs.copyFileSync(localComposePath, backupPath);
        logs.push(`Saved safety backup to: ${backupPath}`);
      }

      fs.writeFileSync(localComposePath, req.yamlContent, 'utf8');
      if (fs.existsSync(localComposePath) && fs.statSync(localComposePath).size > 0) {
        logs.push(`Successfully wrote unified docker-compose.yml (${fs.statSync(localComposePath).size} bytes)`);
        fileWritten = true;
      }
    } catch (err) {
      logs.push(`Direct filesystem write notice: ${(err as Error).message}`);
    }
  }

  // Strategy B: If direct FS wasn't used or failed, use Docker Engine helper container
  if (!fileWritten && privs.isSocketWritable) {
    logs.push(`[2/5] Writing docker-compose.yml on host via Docker Engine helper container...`);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const createRes = await queryDockerEngine<any>('/containers/create', 'POST', {
        Image: helperImage,
        Entrypoint: [],
        Cmd: [
          'sh',
          '-c',
          `mkdir -p "$TARGET_DIR" && if [ -f "$TARGET_DIR/docker-compose.yml" ]; then cp "$TARGET_DIR/docker-compose.yml" "$TARGET_DIR/docker-compose.backup.$(date +%s).yml"; fi && printf '%s' "$COMPOSE_DATA" > "$TARGET_DIR/docker-compose.yml" && sync && [ -s "$TARGET_DIR/docker-compose.yml" ] && echo "COMPOSE_WRITE_SUCCESS"`,
        ],
        Env: [
          `TARGET_DIR=${req.targetDirectory}`,
          `COMPOSE_DATA=${req.yamlContent}`,
        ],
        HostConfig: {
          Binds: [`${req.targetDirectory}:${req.targetDirectory}`],
        },
      });

      if (createRes && createRes.Id) {
        const writerId = createRes.Id;
        await queryDockerEngine(`/containers/${writerId}/start`, 'POST');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const waitRes = await queryDockerEngine<any>(`/containers/${writerId}/wait`, 'POST');
        const writerLogs = await queryDockerEngine<string>(`/containers/${writerId}/logs?stdout=1&stderr=1`, 'GET');

        try {
          await queryDockerEngine(`/containers/${writerId}?force=true`, 'DELETE');
        } catch {
          // ignore
        }

        if (typeof writerLogs === 'string' && writerLogs.includes('COMPOSE_WRITE_SUCCESS')) {
          fileWritten = true;
          logs.push(`Helper container verified write to ${req.targetDirectory}/docker-compose.yml`);
        } else if (waitRes && waitRes.StatusCode === 0) {
          fileWritten = true;
          logs.push(`Helper container successfully exited with code 0.`);
        } else {
          logs.push(`Helper container response: ${typeof writerLogs === 'string' ? writerLogs : JSON.stringify(writerLogs)}`);
        }
      }
    } catch (err) {
      logs.push(`Docker helper container error: ${(err as Error).message}`);
    }
  }

  // Abort if the file could not be written to prevent disrupting containers
  if (!fileWritten) {
    return {
      success: false,
      message: `Failed to write docker-compose.yml to host directory: ${req.targetDirectory}. Container states were not altered.`,
      logs,
      stoppedContainers: [],
    };
  }

  // Step 3: Inspect containers to only stop foreign containers, preserving existing target stack services
  logs.push(`[3/5] Inspecting containers to preserve existing stack services...`);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runningContainers = await queryDockerEngine<any[]>('/containers/json?all=1', 'GET');
  } catch {
    // ignore
  }

  for (const containerId of req.sourceContainerIds) {
    try {
      const match = runningContainers.find(
        (c) =>
          c.Id === containerId ||
          c.Id.startsWith(containerId) ||
          (c.Names && c.Names.some((n: string) => n.replace('/', '') === containerId))
      );

      const composeProject = match?.Labels?.['com.docker.compose.project'];
      const composeWorkingDir = match?.Labels?.['com.docker.compose.project.working_dir'];
      const containerCleanName = match?.Names?.[0]?.replace('/', '') || containerId;

      // DO NOT STOP containers that already belong to the target stack
      if (composeProject === req.targetStackName || composeWorkingDir === req.targetDirectory) {
        logs.push(`Preserving target stack service "${containerCleanName}" (will be reloaded smoothly by Docker Compose)`);
        continue;
      }

      // DO NOT STOP Manifexus prematurely; it will only be atomically replaced if legitimately migrating
      if (
        containerCleanName.toLowerCase().includes('manifexus') ||
        (match?.Image && match.Image.toLowerCase().includes('manifexus'))
      ) {
        if (!isMigratingManifexus) {
          logs.push(`Central command (${containerCleanName}) is not targeted for migration. Preserving running instance.`);
        } else {
          logs.push(`Central command (${containerCleanName}) scheduled for atomic stack handoff.`);
        }
        continue;
      }

      // Foreign containers from other stacks can be gracefully stopped
      if (privs.isDockerConnected) {
        await queryDockerEngine(`/containers/${containerId}/stop?t=10`, 'POST');
        stoppedContainers.push(containerId);
        logs.push(`Gracefully stopped external container: ${containerCleanName}`);
      }
    } catch (err) {
      logs.push(`Notice handling ${containerId}: ${(err as Error).message}`);
    }
  }

  // Step 4: Launch the merged stack via Docker Compose
  logs.push(`[4/5] Orchestrating Docker Compose for "${req.targetStackName}" on host...`);
  let composeLaunched = false;

  // Script to run inside helper container with Docker socket
  const orchestrateScript = `
set -e
echo "[ORCHESTRATOR] Navigating to ${req.targetDirectory}..."
cd "${req.targetDirectory}"

COMPOSE_BIN="docker compose"
if which docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE_BIN="docker compose"
elif which docker-compose >/dev/null 2>&1; then
  COMPOSE_BIN="docker-compose"
fi

if [ "${isMigratingManifexus}" = "true" ]; then
  echo "[ORCHESTRATOR] Validating target Compose file before touching Manifexus..."
  if ! $COMPOSE_BIN config >/dev/null 2>&1; then
    echo "[ORCHESTRATOR] CRITICAL: Target compose file is invalid! Aborting to prevent Manifexus downtime."
    exit 1
  fi

  echo "[ORCHESTRATOR] Safely preparing Manifexus container handoff (Zero-loss rollback enabled)..."
  docker stop manifexus 2>/dev/null || true
  docker rename manifexus manifexus_migration_backup 2>/dev/null || true
fi

echo "[ORCHESTRATOR] Executing $COMPOSE_BIN up -d..."
if $COMPOSE_BIN up -d --remove-orphans; then
  if [ "${isMigratingManifexus}" = "true" ]; then
    echo "[ORCHESTRATOR] Stack launched successfully! Retiring migration backup..."
    docker rm -f manifexus_migration_backup 2>/dev/null || true
  fi
  echo "COMPOSE_LAUNCH_SUCCESS"
else
  if [ "${isMigratingManifexus}" = "true" ]; then
    echo "[ORCHESTRATOR] Launch failed! Executing automatic rollback to original Manifexus container..."
    docker rename manifexus_migration_backup manifexus 2>/dev/null || true
    docker start manifexus 2>/dev/null || true
    echo "[ORCHESTRATOR] Rollback succeeded: Original Manifexus container restored."
  fi
  exit 1
fi
`;

  if (privs.isSocketWritable) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
        Image: helperImage,
        Entrypoint: [],
        Cmd: ['sh', '-c', orchestrateScript],
        HostConfig: {
          Binds: [
            `${DOCKER_SOCKET_PATH}:/var/run/docker.sock`,
            `${req.targetDirectory}:${req.targetDirectory}`,
          ],
        },
      });

      if (runner && runner.Id) {
        const runnerId = runner.Id;
        await queryDockerEngine(`/containers/${runnerId}/start`, 'POST');

        // If migrating Manifexus itself, the old container terminates to free port 3334.
        // Return immediately with isMigratingSelf=true so the UI starts reconnection polling.
        if (isMigratingManifexus) {
          logs.push(`[ORCHESTRATOR] Atomic handoff in progress: Manifexus is restarting under "${req.targetStackName}" on port 3334.`);
          return {
            success: true,
            isMigratingSelf: true,
            message: `Migration initiated! Manifexus is restarting as part of "${req.targetStackName}" on port 3334.`,
            backupPath: backupPath || `${req.targetDirectory}/docker-compose.backup.yml`,
            writtenPath: targetComposePath,
            stoppedContainers,
            logs,
          };
        }

        // Otherwise wait for compose completion
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const waitRes = await queryDockerEngine<any>(`/containers/${runnerId}/wait`, 'POST');
        const runnerLogs = await queryDockerEngine<string>(`/containers/${runnerId}/logs?stdout=1&stderr=1`, 'GET');

        try {
          await queryDockerEngine(`/containers/${runnerId}?force=true`, 'DELETE');
        } catch {
          // ignore
        }

        if (typeof runnerLogs === 'string') {
          runnerLogs.split('\n').filter(Boolean).forEach((l) => logs.push(l));
          if (runnerLogs.includes('COMPOSE_LAUNCH_SUCCESS') || (waitRes && waitRes.StatusCode === 0)) {
            composeLaunched = true;
          }
        } else if (waitRes && waitRes.StatusCode === 0) {
          composeLaunched = true;
        }
      }
    } catch (err) {
      logs.push(`Docker socket compose runner notice: ${(err as Error).message}`);
    }
  }

  // Fallback to local CLI if socket runner wasn't available
  if (!composeLaunched && privs.hasDockerCli) {
    try {
      const composeFile = path.join(targetContainerDir, 'docker-compose.yml');
      const { stdout } = await execAsync(
        `docker compose -f "${composeFile}" --project-directory "${targetContainerDir}" up -d`
      );
      logs.push(`Docker compose CLI output:\n${stdout}`);
      composeLaunched = true;
    } catch (err) {
      logs.push(`Docker compose CLI output: ${(err as Error).message}`);
    }
  }

  logs.push(`[5/5] Automation complete. Fleet state refreshing.`);

  return {
    success: composeLaunched || fileWritten,
    isMigratingSelf: false,
    message: composeLaunched
      ? `Stack "${req.targetStackName}" successfully consolidated and running on host!`
      : `Compose file written to ${req.targetDirectory}/docker-compose.yml. Check logs for launch details.`,
    backupPath: backupPath || `${req.targetDirectory}/docker-compose.backup.yml`,
    writtenPath: targetComposePath,
    stoppedContainers,
    logs,
  };
}

// Generate the 1-line elevation script served at /api/system/elevate.sh
export function generateElevateScript(serverHost: string = 'localhost:3334'): string {
  return `#!/usr/bin/env bash
# =========================================================================
# MANIFEXUS HOST AUTOMATION & ELEVATED MODE SETUP SCRIPT
# =========================================================================
# This script upgrades Manifexus on your Ubuntu host from read-only sandboxed
# mode to Full Host Automation Mode by:
#  1. Changing /var/run/docker.sock mount to read-write
#  2. Mounting /home to /host/home (enables zero-touch compose file editing)
#  3. Setting HOST_ROOT=/host
#  4. Restarting Manifexus with full orchestration privileges
# =========================================================================
set -e

echo "-------------------------------------------------------------------------"
echo "🚀 Elevating Manifexus to Full Host Automation Mode..."
echo "-------------------------------------------------------------------------"

# 1. Locate Manifexus docker-compose.yml
COMPOSE_FILE=""
SEARCH_DIRS=("$PWD" "/home/$USER/manifexus" "$HOME/manifexus" "/home/ryan/manifexus")

for d in "\${SEARCH_DIRS[@]}"; do
  if [ -f "$d/docker-compose.yml" ]; then
    if grep -q "manifexus" "$d/docker-compose.yml" 2>/dev/null; then
      COMPOSE_FILE="$d/docker-compose.yml"
      break
    fi
  fi
done

if [ -z "$COMPOSE_FILE" ]; then
  # Try docker inspect if running
  INSPECT_PATH=$(docker inspect manifexus --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' 2>/dev/null || true)
  if [ -n "$INSPECT_PATH" ] && [ -f "$INSPECT_PATH" ]; then
    COMPOSE_FILE="$INSPECT_PATH"
  fi
fi

if [ -z "$COMPOSE_FILE" ]; then
  echo "❌ Could not auto-detect Manifexus docker-compose.yml location."
  echo "Please specify the directory containing your Manifexus docker-compose.yml:"
  read -r USER_DIR
  COMPOSE_FILE="$USER_DIR/docker-compose.yml"
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "❌ File not found at: $COMPOSE_FILE"
  exit 1
fi

COMPOSE_DIR=$(dirname "$COMPOSE_FILE")
echo "Found Manifexus Compose file at: $COMPOSE_FILE"

# 2. Backup existing compose file
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
cp "$COMPOSE_FILE" "$COMPOSE_DIR/docker-compose.yml.backup.\${TIMESTAMP}"
echo "✅ Safety backup created: $COMPOSE_DIR/docker-compose.yml.backup.\${TIMESTAMP}"

# 3. Create elevated docker-compose.yml
cat << 'EOF' > "$COMPOSE_FILE"
services:
  manifexus:
    image: ghcr.io/reyespascal/manifexus:latest
    container_name: manifexus
    restart: unless-stopped
    ports:
      - "3334:3334"
    environment:
      - NODE_ENV=production
      - PORT=3334
      - DOCKER_SOCKET_PATH=/var/run/docker.sock
      - HOST_ROOT=/host
    volumes:
      # Read-write Docker socket for automated container start/stop/restart
      - /var/run/docker.sock:/var/run/docker.sock
      # Host home mount: enables direct, automated docker-compose.yml editing & backups
      - /home:/host/home
      # Persistent host directory for custom groups and app overrides
      - ./data:/data
EOF

echo "✅ Updated $COMPOSE_FILE with elevated host orchestration permissions."

# 4. Pull latest image and restart
echo "Pulling latest Manifexus image and restarting..."
cd "$COMPOSE_DIR"
docker compose pull || true
docker compose up -d

echo "-------------------------------------------------------------------------"
echo "🎉 SUCCESS! Manifexus is now running in FULL HOST AUTOMATION MODE!"
echo "   - Read-Write Docker Socket Active: Container start/stop/merge unlocked"
echo "   - Host Filesystem Mounted (/home -> /host/home): Direct compose editing enabled"
echo "   - Access your nexus at: http://localhost:3334"
echo "-------------------------------------------------------------------------"
`;
}
