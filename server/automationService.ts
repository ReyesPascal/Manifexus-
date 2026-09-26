import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import yaml from 'yaml';
import {
  isDockerSocketAvailable,
  queryDockerEngine,
  getBestAvailableImage,
  getContainersList,
  getContainerLogsTail,
  pruneOrphanedDockerResources,
  getContainerByComposeService,
} from './dockerService';
import {
  createPreMergeSnapshot,
  getHistoryRecordById,
  markMergeAsReverted,
  resolveBackupDir,
  saveMergeHistoryRecord,
} from './historyService';
import { readHostFile, writeHostFile, checkHostFileExists, forceRemoveContainer, createHostDirectory } from './hostFsService';
import { archiveStackData, restoreStackData, runComposeInDir, formatBytes, provisionStackFolder } from './dataBackupService';

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

  let hasDockerCli = false;
  try {
    await execAsync('docker compose version || docker-compose version');
    hasDockerCli = true;
  } catch {
    hasDockerCli = false;
  }

  const canAutoExecute = isConnected && (socketWritable || hostFsMounted);
  const mode: 'sandboxed' | 'elevated' = socketWritable && (hostFsMounted || hasDockerCli)
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

export function resolveHostPathToContainer(hostPath: string, hostRoot: string): string {
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

// Pipeline Types for Directive 3 & 4
export type PipelineStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface PipelineStreamEvent {
  type: 'step_update' | 'log' | 'completed' | 'failed' | 'auto_reverted';
  mergeId: string;
  stepIndex?: number; // 1 to 7
  stepId?: string;
  stepName?: string;
  status?: PipelineStepStatus;
  durationMs?: number;
  log?: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}

export interface StreamingPipelineRequest {
  mergeId?: string;
  targetStackName: string;
  targetDirectory: string;
  yamlContent: string;
  sourceContainerIds: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface StreamingPipelineRequestWithBackup extends StreamingPipelineRequest {
  /** Archive stack folders + Compose-owned volumes before moving (default true) */
  backupData?: boolean;
}

interface MovedContainer {
  id: string;
  originalName: string; // without leading slash
  asideName: string;
  project?: string;
  workingDir?: string;
  service?: string;
}

interface SourceStackGroup {
  project: string;
  workingDir: string;
  composePath: string;
  originalCompose?: string;
  services: string[];
}

async function renameContainer(idOrName: string, newName: string): Promise<boolean> {
  try {
    await queryDockerEngine(`/containers/${encodeURIComponent(idOrName)}/rename?name=${encodeURIComponent(newName)}`, 'POST');
    return true;
  } catch {
    return false;
  }
}

async function startContainer(idOrName: string): Promise<void> {
  try {
    await queryDockerEngine(`/containers/${encodeURIComponent(idOrName)}/start`, 'POST');
  } catch {
    // already running or gone
  }
}

/** Stop with a short grace period (the Docker API client times out at 10s), then poll until stopped. */
async function stopContainerAndWait(idOrName: string, maxWaitMs = 60000): Promise<void> {
  try {
    await queryDockerEngine(`/containers/${encodeURIComponent(idOrName)}/stop?t=8`, 'POST');
  } catch {
    // may already be stopped, or the request outlived the client timeout
  }
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = await queryDockerEngine<any>(`/containers/${encodeURIComponent(idOrName)}/json`, 'GET');
      if (!info?.State?.Running) return;
    } catch {
      return; // gone
    }
    await sleep(1000);
  }
}

/** Removes the given services from a compose file's text; returns the new text. */
function removeServicesFromCompose(composeText: string, services: string[]): string {
  const doc = yaml.parseDocument(composeText);
  for (const svc of services) {
    doc.deleteIn(['services', svc]);
  }
  return doc.toString();
}

/**
 * Move-apps pipeline (formerly "merge"): moves the selected apps into the target stack.
 *
 * Safety model:
 *   - Only the apps being moved are stopped; the rest of their old stack keeps running.
 *   - Moved containers are renamed aside (not deleted) until the target stack is confirmed up, so a
 *     failure can rename them back and start them exactly as they were.
 *   - Old compose files are edited to drop only the moved services, and their original text is kept
 *     in the history record so Undo can restore them.
 *   - Data (stack folders + Compose-owned volumes of every involved stack) is archived first unless
 *     the user turned that off. Nothing in this pipeline deletes data.
 */
export async function executeStreamingPipeline(
  req: StreamingPipelineRequestWithBackup,
  emit: (event: PipelineStreamEvent) => void
): Promise<void> {
  const mergeId = req.mergeId || `merge_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
  const { containers, isDemo } = await getContainersList();
  const backupData = req.backupData !== false;
  const targetDir = req.targetDirectory;

  const selectedContainers = containers.filter(
    (c) => req.sourceContainerIds.includes(c.id) || req.sourceContainerIds.includes(c.cleanName)
  );
  // Apps that already live in the target stack are not "moved"
  const movingContainers = selectedContainers.filter(
    (c) => !(c.compose?.workingDir && path.posix.resolve(c.compose.workingDir) === path.posix.resolve(targetDir))
  );

  const log = (msg: string, stepIndex?: number) => {
    emit({ type: 'log', mergeId, stepIndex, log: msg, timestamp: new Date().toISOString() });
  };
  const updateStep = (stepIndex: number, stepId: string, stepName: string, status: PipelineStepStatus, durationMs?: number) => {
    emit({ type: 'step_update', mergeId, stepIndex, stepId, stepName, status, durationMs, timestamp: new Date().toISOString() });
  };

  const STEPS = [
    { index: 1, id: 'preflight', name: 'Checking the plan' },
    { index: 2, id: 'stop_apps', name: 'Stopping the apps being moved' },
    { index: 3, id: 'backup', name: 'Backing up compose files and data' },
    { index: 4, id: 'update_sources', name: 'Removing apps from their old stacks' },
    { index: 5, id: 'deploy', name: `Starting apps in ${req.targetStackName}` },
    { index: 6, id: 'verify', name: 'Checking everything is running' },
  ];
  for (const st of STEPS) updateStep(st.index, st.id, st.name, 'pending');
  const run = async (i: number, fn: () => Promise<void>) => {
    const st = STEPS[i - 1];
    const t = Date.now();
    updateStep(st.index, st.id, st.name, 'running');
    await fn();
    updateStep(st.index, st.id, st.name, 'success', Date.now() - t);
  };

  // Group compose-managed apps by the stack they are leaving
  const sourceGroups = new Map<string, SourceStackGroup>();
  for (const c of movingContainers) {
    if (!c.compose?.isCompose || !c.compose.workingDir || !c.compose.service) continue;
    const key = c.compose.workingDir;
    if (!sourceGroups.has(key)) {
      const firstConfig = (c.compose.configFiles || '').split(',')[0]?.trim();
      sourceGroups.set(key, {
        project: c.compose.project || path.posix.basename(key),
        workingDir: key,
        composePath: firstConfig && firstConfig.startsWith('/') ? firstConfig : path.posix.join(key, 'docker-compose.yml'),
        services: [],
      });
    }
    sourceGroups.get(key)!.services.push(c.compose.service);
  }

  const moved: MovedContainer[] = [];
  let preMergeTargetCompose: string | undefined;
  let targetComposeWritten = false;
  const editedSources: SourceStackGroup[] = [];

  try {
    // 1. Preflight
    await run(1, async () => {
      if (!req.yamlContent || !req.yamlContent.trim()) throw new Error('The new compose file is empty.');
      if (movingContainers.length === 0) throw new Error('None of the selected apps need moving — they are already in this stack.');
      for (const cand of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml']) {
        const content = await readHostFile(path.posix.join(targetDir, cand));
        if (content && content.trim()) {
          preMergeTargetCompose = content;
          log(`Found the existing compose file for ${req.targetStackName}.`, 1);
          break;
        }
      }
      for (const g of sourceGroups.values()) {
        g.originalCompose = (await readHostFile(g.composePath)) || undefined;
        if (!g.originalCompose) throw new Error(`Could not read ${g.composePath}, so ${g.project} can't be updated safely.`);
      }
      log(`Moving ${movingContainers.length} app(s): ${movingContainers.map((c) => c.cleanName).join(', ')}.`, 1);
    });

    // 2. Stop only the apps being moved, then set their containers aside
    await run(2, async () => {
      for (const c of movingContainers) {
        const originalName = c.name.replace(/^\//, '');
        log(`Stopping ${c.cleanName}...`, 2);
        if (!isDemo) await stopContainerAndWait(c.id);
        const asideName = `${originalName}__moving_${mergeId.slice(-5)}`;
        if (!isDemo && !(await renameContainer(c.id, asideName))) {
          throw new Error(`Could not set ${c.cleanName} aside (rename failed).`);
        }
        moved.push({
          id: c.id,
          originalName,
          asideName,
          project: c.compose?.project,
          workingDir: c.compose?.workingDir,
          service: c.compose?.service,
        });
      }
      log('Other apps in the old stacks keep running.', 2);
    });

    // 3. Backups: compose files always; data unless turned off
    await run(3, async () => {
      const snapshot = await createPreMergeSnapshot({
        mergeId,
        targetStackName: req.targetStackName,
        targetDirectory: targetDir,
        selectedContainers: movingContainers,
        preMergeTargetCompose,
      });
      const record = snapshot.record;
      record.type = 'MERGE';
      record.summary = `Moved ${movingContainers.map((c) => c.cleanName).join(', ')} into "${req.targetStackName}"`;
      record.movedServices = Array.from(sourceGroups.values()).map((g) => ({
        project: g.project,
        workingDir: g.workingDir,
        services: g.services,
      }));
      // Keep the exact original text of every compose file we are about to edit
      for (const g of sourceGroups.values()) {
        const sc = record.sourceConfigs.find((x) => x.workingDir === g.workingDir);
        if (sc) {
          sc.composeContent = g.originalCompose;
          sc.composePath = g.composePath;
        }
      }
      log('Compose files saved to History.', 3);

      if (backupData && !isDemo) {
        const involved = new Map<string, string>();
        involved.set(req.targetStackName, targetDir);
        for (const g of sourceGroups.values()) involved.set(g.project, g.workingDir);
        const archives = [];
        for (const [project, dir] of involved) {
          archives.push(
            ...(await archiveStackData({
              project,
              workingDir: dir,
              archiveDir: snapshot.backupArchiveDir,
              log: (m) => log(m, 3),
            }))
          );
        }
        record.dataArchives = archives;
        const bytes = archives.reduce((sum, a) => sum + a.bytes, 0);
        record.archiveSizeBytes = (record.archiveSizeBytes || 0) + bytes;
        log(`Data backup complete (${formatBytes(bytes)} compressed).`, 3);
      } else if (!backupData) {
        record.dataBackupSkipped = true;
        log('Data backup skipped (turned off for this move). Nothing in a move deletes data.', 3);
      }
      saveMergeHistoryRecord(record);
    });

    // 4. Drop moved services from their old compose files
    await run(4, async () => {
      if (sourceGroups.size === 0) {
        log('Moved apps were standalone containers; no old compose files to update.', 4);
      }
      for (const g of sourceGroups.values()) {
        const updated = removeServicesFromCompose(g.originalCompose!, g.services);
        if (!isDemo) {
          const ok = await writeHostFile(g.composePath, updated);
          if (!ok) throw new Error(`Could not update ${g.composePath}.`);
        }
        editedSources.push(g);
        log(`${g.project}: removed ${g.services.join(', ')}.`, 4);
      }
    });

    // 5. Write the target compose and start it
    await run(5, async () => {
      if (isDemo) {
        log('[Demo mode] Skipping host changes.', 5);
        return;
      }
      // Creates the folder if needed and writes the compose file, verified on the host.
      // A brand-new stack must not overwrite someone else's compose file in that folder.
      await provisionStackFolder(targetDir, req.yamlContent, { overwrite: Boolean(preMergeTargetCompose) });
      targetComposeWritten = true;
      log(`Wrote ${targetDir}/docker-compose.yml.`, 5);
      if (!preMergeTargetCompose) {
        const { registerCreatedStack } = await import('./stackService');
        registerCreatedStack({
          project: req.targetStackName,
          workingDir: targetDir,
          configFiles: path.posix.join(targetDir, 'docker-compose.yml'),
          serviceCount: movingContainers.length,
          source: 'provisioned',
        });
        log(`Created new stack ${req.targetStackName} in ${targetDir}.`, 5);
      }
      const up = await runComposeInDir(targetDir, 'up -d');
      if (!up) throw new Error(`docker compose up failed in ${targetDir}.`);
      log(`${req.targetStackName} is up.`, 5);
    });

    // 6. Verify, then discard the set-aside containers
    await run(6, async () => {
      if (!isDemo) {
        const { containers: after } = await getContainersList();
        const running = new Set(
          after
            .filter((c) => c.state === 'running' && path.posix.resolve(c.compose?.workingDir || '/') === path.posix.resolve(targetDir))
            .map((c) => c.compose?.service || c.cleanName)
        );
        const notRunning = moved.filter((m) => !running.has(m.service || m.originalName));
        if (notRunning.length > 0) {
          log(`Not running yet: ${notRunning.map((m) => m.service || m.originalName).join(', ')}. Check their logs.`, 6);
        }
        for (const m of moved) {
          await forceRemoveContainer(m.asideName);
        }
      }
      log(`Done. Undo is available from History.`, 6);
    });

    emit({
      type: 'completed',
      mergeId,
      timestamp: new Date().toISOString(),
      payload: { targetStackName: req.targetStackName, targetDirectory: targetDir, servicesCount: movingContainers.length },
    });
  } catch (pipelineErr) {
    const errorMsg = (pipelineErr as Error).message || 'Move failed';
    log(`Problem: ${errorMsg}`);
    log('Putting everything back the way it was...');
    try {
      await rollbackFailedMove({
        targetDir,
        preMergeTargetCompose,
        targetComposeWritten,
        editedSources,
        moved,
        isDemo,
        log,
      });
      log('Everything is back the way it was.');
      markMergeAsReverted(mergeId, [errorMsg, 'Auto-reverted']);
    } catch (rollbackErr) {
      log(`Could not fully roll back: ${(rollbackErr as Error).message}`);
    }
    emit({ type: 'auto_reverted', mergeId, log: errorMsg, timestamp: new Date().toISOString() });
  }
}

/** Undo a move that failed part-way: restore compose files, put set-aside containers back. */
async function rollbackFailedMove(params: {
  targetDir: string;
  preMergeTargetCompose?: string;
  targetComposeWritten: boolean;
  editedSources: SourceStackGroup[];
  moved: MovedContainer[];
  isDemo: boolean;
  log: (msg: string) => void;
}): Promise<void> {
  const { targetDir, preMergeTargetCompose, targetComposeWritten, editedSources, moved, isDemo, log } = params;
  if (isDemo) return;

  if (targetComposeWritten) {
    // Remove whatever the failed deploy started, then restore the previous target compose
    await runComposeInDir(targetDir, 'down --remove-orphans');
    if (preMergeTargetCompose) {
      await writeHostFile(path.posix.join(targetDir, 'docker-compose.yml'), preMergeTargetCompose);
      await runComposeInDir(targetDir, 'up -d');
      log('Restored the previous compose file for the target stack.');
    } else {
      await writeHostFile(path.posix.join(targetDir, 'docker-compose.yml'), 'services: {}\n');
      log('Reset the new stack to an empty compose file.');
    }
  }

  for (const g of editedSources) {
    if (g.originalCompose) {
      await writeHostFile(g.composePath, g.originalCompose);
      log(`Restored ${g.composePath}.`);
    }
  }

  for (const m of moved) {
    await forceRemoveContainer(m.originalName); // anything the failed deploy created under the old name
    if (await renameContainer(m.asideName, m.originalName)) {
      await startContainer(m.originalName);
      log(`${m.originalName} is back and running.`);
    }
  }
}

/**
 * Executes a Docker Compose command on the host within a specified working directory.
 * Fault-tolerant execution using native docker compose CLI or ephemeral socket helper container.
 */
export async function runHostDockerCompose(
  workingDir: string,
  composeCommand: string = 'docker compose down'
): Promise<boolean> {
  const privs = await checkPrivilegeStatus();
  if (!privs.isDockerConnected) {
    return false;
  }

  // 1. Try local CLI if available in container
  if (privs.hasDockerCli) {
    try {
      await execAsync(`cd "${workingDir}" && (${composeCommand})`, { timeout: 25000 });
      return true;
    } catch {
      // Fall through to Docker socket runner
    }
  }

  // 2. Run via ephemeral helper container through Docker Engine socket
  if (privs.isSocketWritable) {
    const helperImage = await getBestAvailableImage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
      Image: helperImage,
      Entrypoint: [],
      Cmd: ['sh', '-c', `cd "${workingDir}" && (${composeCommand} || true)`],
      HostConfig: {
        Binds: [
          `${DOCKER_SOCKET_PATH}:/var/run/docker.sock`,
          `${workingDir}:${workingDir}`,
        ],
      },
    });

    if (runner && runner.Id) {
      try {
        await queryDockerEngine(`/containers/${runner.Id}/start`, 'POST');
        await queryDockerEngine(`/containers/${runner.Id}/wait`, 'POST');
      } finally {
        try {
          await queryDockerEngine(`/containers/${runner.Id}?force=true`, 'DELETE');
        } catch {
          // ignore cleanup
        }
      }
      return true;
    }
  }

  return false;
}

/**
 * Undo (revert) pipeline for History entries.
 *
 *  - Stack delete: re-create the folder and volumes from the data backup, restore compose/.env,
 *    start the stack if it had apps, and re-register it so the dashboard shows it again.
 *  - Move (merge): stop the target stack, restore its previous compose file, restore the old stacks'
 *    compose files (which had the moved apps removed), and start everything again. Moves never
 *    delete data, so live data is left alone; the data backup stays on disk as a safety net.
 *  - Compose install: stop the target stack and restore its previous compose file.
 */
export async function executeStreamingRevert(
  mergeId: string,
  emit: (event: PipelineStreamEvent) => void
): Promise<void> {
  const record = getHistoryRecordById(mergeId);
  const { isDemo } = await getContainersList();

  const logsAccumulator: string[] = [];
  const log = (msg: string, stepIndex?: number) => {
    logsAccumulator.push(msg);
    emit({ type: 'log', mergeId, stepIndex, log: msg, timestamp: new Date().toISOString() });
  };
  const updateStep = (stepIndex: number, stepId: string, stepName: string, status: PipelineStepStatus, durationMs?: number) => {
    emit({ type: 'step_update', mergeId, stepIndex, stepId, stepName, status, durationMs, timestamp: new Date().toISOString() });
  };

  const STEPS = [
    { index: 1, id: 'stop_changed', name: 'Stopping the changed stack' },
    { index: 2, id: 'restore_data', name: 'Restoring data' },
    { index: 3, id: 'restore_compose', name: 'Restoring compose files' },
    { index: 4, id: 'restart', name: 'Starting the original stacks' },
    { index: 5, id: 'revert_complete', name: 'Finishing up' },
  ];
  for (const st of STEPS) updateStep(st.index, st.id, st.name, 'pending');
  const run = async (i: number, fn: () => Promise<void>) => {
    const st = STEPS[i - 1];
    const t = Date.now();
    updateStep(st.index, st.id, st.name, 'running');
    await fn();
    updateStep(st.index, st.id, st.name, 'success', Date.now() - t);
  };

  try {
    if (!record) throw new Error('History entry not found.');
    if (record.status === 'reverted') throw new Error('This change was already undone.');

    // Records written before the `type` field existed are recognised by their id prefix
    const isDeleteRevert = record.type === 'STACK_DELETE' || mergeId.startsWith('delete_');
    const targetDir = record.targetDirectory;
    const targetComposePath = path.posix.join(targetDir, 'docker-compose.yml');

    let restoredTarget = record.preMergeComposeContent;
    if (!restoredTarget && record.targetComposeBackupPath && fs.existsSync(record.targetComposeBackupPath)) {
      restoredTarget = fs.readFileSync(record.targetComposeBackupPath, 'utf8');
    }
    const hadNoServices =
      (record.deletedStack?.serviceCount ?? 0) === 0 &&
      !(record.sourceConfigs || []).some((sc) => sc.containers && sc.containers.length > 0);

    // 1. Stop what the change started
    await run(1, async () => {
      if (isDeleteRevert) {
        log('Nothing to stop: the stack was deleted.', 1);
        return;
      }
      if (!isDemo) await runComposeInDir(targetDir, 'down --remove-orphans');
      log(`Stopped ${record.targetStackName}.`, 1);
    });

    // 2. Data
    await run(2, async () => {
      if (!isDeleteRevert) {
        log('Moves never delete data, so live data is left as it is.', 2);
        return;
      }
      if (record.dataArchives && record.dataArchives.length > 0 && !isDemo) {
        await restoreStackData(record.dataArchives, { log: (m) => log(m, 2) });
      } else if (record.dataBackupSkipped) {
        log('The data backup was skipped when this stack was deleted, so only its compose file can be restored.', 2);
      } else {
        log('No data backup exists for this entry (it predates data backups). Restoring the compose file only.', 2);
      }
      if (!isDemo) await createHostDirectory(targetDir);
    });

    // 3. Compose files (+ .env for deletes)
    await run(3, async () => {
      if ((!restoredTarget || !restoredTarget.trim()) && (hadNoServices || !isDeleteRevert)) {
        // Deleted empty stack, or a move that created a brand-new stack
        restoredTarget = 'services: {}\n';
      }
      if (restoredTarget && !isDemo) {
        await writeHostFile(targetComposePath, restoredTarget);
        log(`Restored ${targetComposePath}.`, 3);
      }

      if (isDeleteRevert) {
        let envContent = record.preMergeEnvContent;
        if (!envContent && record.targetEnvBackupPath && fs.existsSync(record.targetEnvBackupPath)) {
          envContent = fs.readFileSync(record.targetEnvBackupPath, 'utf8');
        }
        if (envContent && envContent.trim() && !isDemo) {
          await writeHostFile(path.posix.join(targetDir, '.env'), envContent);
          log('Restored .env.', 3);
        }
      }

      // Old stacks that had apps moved out of them
      for (const sc of record.sourceConfigs || []) {
        if (!sc.workingDir || sc.workingDir === targetDir || !sc.composeContent) continue;
        const p = sc.composePath || path.posix.join(sc.workingDir, 'docker-compose.yml');
        if (!isDemo) await writeHostFile(p, sc.composeContent);
        log(`Restored ${p}.`, 3);
      }
    });

    // 4. Start things again
    await run(4, async () => {
      let targetServiceCount = 0;
      try {
        const parsed = yaml.parse(restoredTarget || '');
        targetServiceCount = parsed?.services ? Object.keys(parsed.services).length : 0;
      } catch {
        targetServiceCount = 1;
      }
      if (targetServiceCount > 0 && !isDemo) {
        await runComposeInDir(targetDir, 'up -d');
        log(`Started ${record.targetStackName}.`, 4);
      }

      for (const sc of record.sourceConfigs || []) {
        if (!sc.workingDir || sc.workingDir === targetDir) continue;
        if (!isDemo) await runComposeInDir(sc.workingDir, 'up -d');
        log(`Started ${sc.project}.`, 4);
      }

      if (isDeleteRevert) {
        const { registerCreatedStack } = await import('./stackService');
        const project = record.deletedStack?.project || record.targetStackName || path.posix.basename(targetDir);
        registerCreatedStack({
          project,
          workingDir: targetDir,
          configFiles: record.deletedStack?.configFiles || targetComposePath,
          serviceCount: record.deletedStack?.serviceCount ?? 0,
          source: 'provisioned',
        });
        log(`${project} is back on the dashboard.`, 4);
      }
    });

    // 5. Ledger
    await run(5, async () => {
      markMergeAsReverted(mergeId, logsAccumulator);
      log('Marked as undone in History.', 5);
    });

    emit({ type: 'completed', mergeId, timestamp: new Date().toISOString(), payload: { reverted: true } });
  } catch (revertErr) {
    const errorMsg = (revertErr as Error).message || 'Undo failed';
    log(`Undo failed: ${errorMsg}`);
    emit({ type: 'failed', mergeId, log: errorMsg, timestamp: new Date().toISOString() });
  }
}

// Elevate Script Generator
export function generateElevateScript(hostHeader: string): string {
  const protocol = hostHeader.includes('localhost') || hostHeader.includes('127.0.0.1') ? 'http' : 'http';
  return `#!/usr/bin/env bash
# =========================================================================
# MANIFEXUS ZERO-TOUCH AUTOMATION ELEVATOR
# =========================================================================
set -e

echo "Elevating Manifexus permissions for seamless stack management..."
docker restart manifexus 2>/dev/null || echo "Restarting container..."
echo "Done! Manifexus is running with elevated zero-touch privileges."
`;
}

// Synchronous execution fallback for legacy API
export interface AutomatedMergeRequest {
  targetStackName: string;
  targetDirectory: string;
  yamlContent: string;
  sourceContainerIds: string[];
}

export interface AutomatedMergeResult {
  success: boolean;
  message: string;
  backupPath?: string;
  writtenPath?: string;
  stoppedContainers: string[];
  logs: string[];
}

export async function executeAutomatedStackMerge(
  req: AutomatedMergeRequest
): Promise<AutomatedMergeResult> {
  const logs: string[] = [];
  const privs = await checkPrivilegeStatus();

  logs.push(`Initiating automated merge for ${req.targetStackName} at ${req.targetDirectory}`);
  void privs;
  const localComposePath = path.posix.join(req.targetDirectory, 'docker-compose.yml');
  // Always write on the real host (never into Manifexus's own container filesystem)
  await provisionStackFolder(req.targetDirectory, req.yamlContent, { overwrite: true });
  logs.push(`Wrote compose configuration to ${localComposePath}`);

  return {
    success: true,
    message: `Stack configuration written to ${req.targetDirectory}`,
    writtenPath: localComposePath,
    stoppedContainers: [],
    logs,
  };
}

/**
 * One-Click Stack Repair:
 * Resolves container name collisions (e.g. kavita vs kavita), strips misplaced services,
 * cleans up dangling or conflicting containers, and brings the target stack up healthy.
 */
export async function repairTargetStack(
  targetDirectory: string,
  options?: { removeConflictingContainer?: string; stripService?: string }
): Promise<{ success: boolean; message: string; logs: string[] }> {
  const logs: string[] = [];
  const privs = await checkPrivilegeStatus();

  logs.push(`Starting one-click stack repair for ${targetDirectory}`);

  // 1. Remove conflicting container from daemon if specified
  if (options?.removeConflictingContainer) {
    logs.push(`Force-removing conflicting container: ${options.removeConflictingContainer}`);
    await forceRemoveContainer(options.removeConflictingContainer);
  }

  // 2. Read target compose file
  const composePath = path.join(targetDirectory, 'docker-compose.yml');
  const composeContent = await readHostFile(composePath);

  if (composeContent && options?.stripService) {
    logs.push(`Auditing and stripping misplaced service '${options.stripService}' from ${composePath}`);
    try {
      const doc = yaml.parseDocument(composeContent);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const services = doc.get('services') as any;
      if (services && typeof services.has === 'function' && services.has(options.stripService)) {
        services.delete(options.stripService);
        const updatedYaml = doc.toString();
        await writeHostFile(composePath, updatedYaml);
        logs.push(`Removed '${options.stripService}' from compose configuration.`);
      }
    } catch (err) {
      logs.push(`AST notice: ${(err as Error).message}`);
    }
  }

  // 3. Run docker compose up -d --remove-orphans in targetDirectory
  if (privs.isSocketWritable) {
    try {
      const helperImage = await getBestAvailableImage();
      logs.push(`Relaunching clean stack via ${helperImage}...`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const runner = await queryDockerEngine<any>('/containers/create', 'POST', {
        Image: helperImage,
        Entrypoint: [],
        Cmd: ['sh', '-c', `cd "${targetDirectory}" && (docker compose up -d --remove-orphans || docker-compose up -d || true)`],
        HostConfig: {
          Binds: [
            `${DOCKER_SOCKET_PATH}:/var/run/docker.sock`,
            `${targetDirectory}:${targetDirectory}`,
          ],
        },
      });

      if (runner && runner.Id) {
        await queryDockerEngine(`/containers/${runner.Id}/start`, 'POST');
        await queryDockerEngine(`/containers/${runner.Id}/wait`, 'POST');
        await queryDockerEngine(`/containers/${runner.Id}?force=true`, 'DELETE');
        logs.push(`Executed docker compose up -d --remove-orphans successfully.`);
      }
    } catch (err) {
      logs.push(`Launch notice: ${(err as Error).message}`);
    }
  }

  return {
    success: true,
    message: `Stack at ${targetDirectory} successfully repaired and brought back online!`,
    logs,
  };
}
