import { friendlyName, isHelperImage } from './appIdentity';
import fs from 'fs';
import { getConfig } from './storageService';
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
  markMergeAsReverted,
  resolveBackupDir,
  saveMergeHistoryRecord,
} from './historyService';
import { readHostFile, writeHostFile, forceRemoveContainer } from './hostFsService';
import { record, setActivityTitle, currentActivityId } from './activityLog';
import type { MergeHistoryRecord } from './historyService';
import {
  archiveStackData,
  runComposeInDir,
  runComposeCapture,
  composeErrorTail,
  formatBytes,
  provisionStackFolder,
} from './dataBackupService';

const execAsync = util.promisify(exec);

export interface AutomationPrivileges {
  isDockerConnected: boolean;
  isSocketWritable: boolean;
  isHostFsMounted: boolean;
  hostRootPath: string;
  hasDockerCli: boolean;
  mode: 'sandboxed' | 'elevated';
  /** Server Changes is turned on in Manifexus (off until someone turns it on) */
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

const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';

/** Server Changes: off until the person turns it on in Manifexus */
export function serverChangesAllowed(): boolean {
  return getConfig().allowServerChanges === true;
}

/** The plain reason shown when something needs Server Changes */
export const CHANGES_OFF_MESSAGE = 'Server Changes is off, so Manifexus can’t change this. Turn it on in Settings → Server Changes.';

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

  // Changes are only ever made when the person has turned Server Changes on, and Docker allows it
  const allowChanges = serverChangesAllowed();
  const canAutoExecute = allowChanges && isConnected && socketWritable;
  const mode: 'sandboxed' | 'elevated' = canAutoExecute ? 'elevated' : 'sandboxed';

  const statusMessage = !socketWritable
    ? 'Docker only lets Manifexus look.'
    : allowChanges
      ? 'Server Changes is on.'
      : 'Server Changes is off.';

  return {
    isDockerConnected: isConnected,
    isSocketWritable: socketWritable,
    isHostFsMounted: hostFsMounted,
    hostRootPath: resolvedHostRoot,
    hasDockerCli,
    mode,
    allowChanges,
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
  // Remaining services must not point at the ones that left, or `compose up` refuses to run
  const remaining = doc.get('services') as yaml.YAMLMap | undefined;
  if (remaining && yaml.isMap(remaining)) {
    for (const item of remaining.items) {
      const name = String((item.key as yaml.Scalar)?.value ?? item.key);
      for (const field of ['depends_on', 'links']) {
        const node = doc.getIn(['services', name, field]);
        if (yaml.isSeq(node)) {
          node.items = node.items.filter((i) => !services.includes(String((i as yaml.Scalar).value ?? i).split(':')[0]));
          if (!node.items.length) doc.deleteIn(['services', name, field]);
        } else if (yaml.isMap(node)) {
          for (const svc of services) node.delete(svc);
          if (!node.items.length) doc.deleteIn(['services', name, field]);
        }
      }
    }
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

  // As the dashboard names them ("nextcloud"), leaving out their databases and caches
  const movingNames = Array.from(new Set(movingContainers.filter((c) => !isHelperImage(c.image) || movingContainers.every((x) => isHelperImage(x.image))).map((c) => friendlyName(c))));
  setActivityTitle(
    `Move ${movingNames.length <= 3 ? movingNames.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${movingNames.length} apps`} into ${req.targetStackName}`
  );
  record('info', 'step', 'Move requested', {
    mergeId,
    targetStackName: req.targetStackName,
    targetDirectory: targetDir,
    backupData,
    apps: movingContainers.map((c) => ({
      name: c.cleanName,
      id: c.id.slice(0, 12),
      image: c.image,
      state: c.state,
      project: c.compose?.project,
      service: c.compose?.service,
      workingDir: c.compose?.workingDir,
      configFiles: c.compose?.configFiles,
      ports: c.ports,
      mounts: c.mounts,
      networks: c.networks,
    })),
    composeToWrite: req.yamlContent,
  });

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
    try {
      await fn();
    } catch (err) {
      updateStep(st.index, st.id, st.name, 'failed', Date.now() - t);
      throw err;
    }
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
  let moveRecord: MergeHistoryRecord | undefined;
  const standaloneApps: { name: string; spec: Record<string, unknown> }[] = [];
  const resultFiles: { path: string; content: string }[] = [];

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
        // A standalone (docker run) app has no compose file to go back to: keep its full definition
        if (!c.compose?.project && !isDemo) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const inspect = await queryDockerEngine<any>(`/containers/${c.id}/json`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const endpoints: Record<string, any> = {};
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const [net, ep] of Object.entries<any>(inspect.NetworkSettings?.Networks || {})) {
            endpoints[net] = {
              Aliases: (ep.Aliases || []).filter((a: string) => !String(inspect.Id).startsWith(a)),
              IPAMConfig: ep.IPAMConfig || undefined,
              Links: ep.Links || undefined,
            };
          }
          const cfg = { ...(inspect.Config || {}) };
          if (cfg.Hostname && String(inspect.Id).startsWith(cfg.Hostname)) delete cfg.Hostname;
          standaloneApps.push({ name: originalName, spec: { ...cfg, HostConfig: inspect.HostConfig, NetworkingConfig: { EndpointsConfig: endpoints } } });
          log(`Saved ${c.cleanName}’s settings, so a restore can recreate it exactly.`, 2);
        }
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
      moveRecord = record;
      record.type = 'MERGE';
      record.activityId = currentActivityId();
      record.standaloneApps = standaloneApps;
      // Name the apps as the dashboard does, leaving out their databases and caches
      const mains = movingContainers.filter((c) => !isHelperImage(c.image) || movingContainers.every((x) => isHelperImage(x.image)));
      record.appLabels = Array.from(new Set(mains.map((c) => friendlyName(c))));
      record.summary = `Moved ${record.appLabels.join(', ')} into "${req.targetStackName}"`;
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
      log('Compose files saved for Restore.', 3);

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
        resultFiles.push({ path: g.composePath, content: updated });
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
      // Start only the apps being moved in (and anything they depend on). The stack's own apps are
      // already running and are left alone, so a stale entry elsewhere in its file can't sink the move.
      const listed = (text?: string): string[] => {
        try {
          return Object.keys(yaml.parse(text || '')?.services || {});
        } catch {
          return [];
        }
      };
      const already = new Set(listed(preMergeTargetCompose));
      const incoming = listed(req.yamlContent).filter((n) => !already.has(n));
      const safe = incoming.length > 0 && incoming.every((n) => /^[A-Za-z0-9._-]+$/.test(n));
      if (safe) log(`Starting ${incoming.join(', ')}.`, 5);
      const up = await runComposeCapture(targetDir, safe ? `up -d ${incoming.join(' ')}` : 'up -d', {
        extraDirs: Array.from(sourceGroups.values()).map((g) => g.workingDir),
      });
      if (!up.ok) {
        const why = composeErrorTail(up.output);
        if (why) log(why, 5);
        throw new Error(`Docker couldn't start the apps in ${req.targetStackName}${why ? `: ${why.split('\n').pop()}` : '.'}`);
      }
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
      log('Done. You can restore to before this move from Restore.', 6);
    });

    // The change is final: record how it left each file so a later restore can tell what changed since
    if (moveRecord) {
      resultFiles.push({ path: path.posix.join(targetDir, 'docker-compose.yml'), content: req.yamlContent });
      moveRecord.resultFiles = resultFiles;
      moveRecord.status = 'active';
      saveMergeHistoryRecord(moveRecord);
    }

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
        newComposeText: req.yamlContent,
      });
      log('Everything is back the way it was.');
      markMergeAsReverted(mergeId, [errorMsg, 'Auto-reverted'], { failed: true });
      emit({ type: 'auto_reverted', mergeId, log: errorMsg, timestamp: new Date().toISOString() });
    } catch (rollbackErr) {
      const why = (rollbackErr as Error).message;
      log(`Could not fully roll back: ${why}`);
      // Not "rolled back": some of it is still changed. Its Restore entry stays, so it can be restored from there.
      emit({
        type: 'failed',
        mergeId,
        log: `${errorMsg}. Putting things back also failed (${why}); restore it from Restore.`,
        timestamp: new Date().toISOString(),
      });
    }
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
  /** The compose file the failed move wrote, to know which services it added */
  newComposeText?: string;
}): Promise<void> {
  const { targetDir, preMergeTargetCompose, targetComposeWritten, editedSources, moved, isDemo, log, newComposeText } = params;
  if (isDemo) return;

  if (targetComposeWritten) {
    if (preMergeTargetCompose) {
      // Remove only the containers the failed move added; apps already in this stack keep running
      const serviceNames = (text?: string): string[] => {
        try {
          return Object.keys(yaml.parse(text || '')?.services || {});
        } catch {
          return [];
        }
      };
      const before = new Set(serviceNames(preMergeTargetCompose));
      const added = serviceNames(newComposeText).filter((n) => !before.has(n));
      try {
        const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project.working_dir=${targetDir}`] }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list = await queryDockerEngine<any[]>(`/containers/json?all=1&filters=${filters}`);
        for (const c of list || []) {
          if (added.includes(c.Labels?.['com.docker.compose.service'])) await forceRemoveContainer(c.Id);
        }
      } catch {
        // fall through: compose below still restores the stack
      }
      // Its own apps were never stopped, so putting the file back is all that's needed
      await writeHostFile(path.posix.join(targetDir, 'docker-compose.yml'), preMergeTargetCompose);
      log('Restored the previous compose file for the target stack. Its own apps kept running.');
    } else {
      // A brand-new stack only contains the moved apps
      await runComposeInDir(targetDir, 'down --remove-orphans');
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

