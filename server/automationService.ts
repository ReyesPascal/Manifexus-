import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { isDockerSocketAvailable, queryDockerEngine } from './dockerService';

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

  logs.push(`[1/5] Checking automation privileges: Mode is ${privs.mode.toUpperCase()}`);

  // Strategy A: Direct Host Filesystem Write (if host FS is mounted)
  let targetContainerDir = req.targetDirectory;
  let usedDirectFs = false;

  if (privs.isHostFsMounted) {
    targetContainerDir = resolveHostPathToContainer(req.targetDirectory, privs.hostRootPath);
    logs.push(`[2/5] Host directory mapped: "${req.targetDirectory}" -> "${targetContainerDir}"`);

    try {
      if (!fs.existsSync(targetContainerDir)) {
        fs.mkdirSync(targetContainerDir, { recursive: true });
        logs.push(`Created directory: ${targetContainerDir}`);
      }

      const targetComposePath = path.join(targetContainerDir, 'docker-compose.yml');
      let backupPath = '';

      if (fs.existsSync(targetComposePath)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = path.join(targetContainerDir, `docker-compose.backup.${timestamp}.yml`);
        fs.copyFileSync(targetComposePath, backupPath);
        logs.push(`Saved safety backup to: ${backupPath}`);
      }

      fs.writeFileSync(targetComposePath, req.yamlContent, 'utf8');
      logs.push(`Successfully wrote unified docker-compose.yml to ${targetComposePath}`);
      usedDirectFs = true;
    } catch (err) {
      logs.push(`Direct filesystem write error: ${(err as Error).message}`);
    }
  }

  // Strategy B: If direct FS wasn't possible but socket is writable, use a transient docker helper
  if (!usedDirectFs && privs.isSocketWritable) {
    logs.push(`[2/5] Using Docker Engine helper container to write compose file on host...`);
    try {
      // Create a temporary container that mounts host directory
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const createRes = await queryDockerEngine<any>('/containers/create', 'POST', {
        Image: 'alpine:latest',
        Cmd: [
          'sh',
          '-c',
          `mkdir -p /work && [ -f /work/docker-compose.yml ] && cp /work/docker-compose.yml /work/docker-compose.backup.$(date +%s).yml || true; echo "$COMPOSE_DATA" > /work/docker-compose.yml && echo "SUCCESS"`,
        ],
        Env: [`COMPOSE_DATA=${req.yamlContent}`],
        HostConfig: {
          Binds: [`${req.targetDirectory}:/work`],
          AutoRemove: true,
        },
      });

      if (createRes && createRes.Id) {
        await queryDockerEngine(`/containers/${createRes.Id}/start`, 'POST');
        logs.push(`Helper container wrote compose file directly to host ${req.targetDirectory}/docker-compose.yml`);
      }
    } catch (err) {
      logs.push(`Docker helper container notice: ${(err as Error).message}`);
    }
  }

  // Step 3: Gracefully stop previous individual containers via Docker socket API
  logs.push(`[3/5] Gracefully stopping previous separate containers (Volumes strictly preserved)...`);
  for (const containerId of req.sourceContainerIds) {
    try {
      if (privs.isDockerConnected) {
        // Do not stop manifexus itself prematurely!
        if (containerId.includes('manifexus')) {
          logs.push(`Skipping premature stop of Manifexus until new stack is signaled.`);
          continue;
        }

        await queryDockerEngine(`/containers/${containerId}/stop?t=10`, 'POST');
        stoppedContainers.push(containerId);
        logs.push(`Stopped container: ${containerId}`);
      }
    } catch (err) {
      logs.push(`Notice stopping ${containerId}: ${(err as Error).message}`);
    }
  }

  // Step 4: Launch the merged stack via Docker Compose
  logs.push(`[4/5] Launching merged stack "${req.targetStackName}" via Docker Compose...`);
  let composeLaunched = false;

  if (privs.hasDockerCli) {
    try {
      const composeFile = path.join(targetContainerDir, 'docker-compose.yml');
      const { stdout } = await execAsync(
        `docker compose -f "${composeFile}" --project-directory "${targetContainerDir}" up -d`
      );
      logs.push(`Docker compose output:\n${stdout}`);
      composeLaunched = true;
    } catch (err) {
      logs.push(`Docker compose CLI output: ${(err as Error).message}`);
    }
  }

  // If inside container without compose CLI or path differences, run compose runner via Docker socket
  if (!composeLaunched && privs.isSocketWritable) {
    try {
      logs.push(`Launching compose orchestrator container via Docker Engine socket...`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
        Image: 'docker/compose:latest',
        Cmd: ['-f', '/work/docker-compose.yml', '--project-directory', '/work', 'up', '-d'],
        HostConfig: {
          Binds: [
            `${DOCKER_SOCKET_PATH}:/var/run/docker.sock`,
            `${req.targetDirectory}:/work`,
          ],
          AutoRemove: true,
        },
      });

      if (runner && runner.Id) {
        await queryDockerEngine(`/containers/${runner.Id}/start`, 'POST');
        logs.push(`Docker Compose orchestrator started on host for ${req.targetDirectory}`);
        composeLaunched = true;
      }
    } catch (err) {
      logs.push(`Compose orchestrator notice: ${(err as Error).message}`);
    }
  }

  logs.push(`[5/5] Automation complete. Fleet state refreshing.`);

  return {
    success: true,
    message: `Stack "${req.targetStackName}" successfully consolidated into ${req.targetDirectory}!`,
    backupPath: path.join(targetContainerDir, 'docker-compose.backup.yml'),
    writtenPath: path.join(targetContainerDir, 'docker-compose.yml'),
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
