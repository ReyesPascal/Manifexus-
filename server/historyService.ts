import fs from 'fs';
import path from 'path';
import { DeepContainerMetadata } from '../src/types';
import { readHostFile } from './hostFsService';

export interface MergeHistoryRecord {
  id: string; // unique merge run id, e.g. merge_20260921_123456_abc
  timestamp: string; // ISO timestamp
  targetStackName: string;
  targetDirectory: string;
  backupArchiveDir: string;
  sourceStacks: string[];
  affectedServices: string[];
  preMergeComposeContent?: string;
  targetComposeBackupPath?: string;
  sourceConfigs: {
    project: string;
    workingDir: string;
    composeContent?: string;
    containers: { name: string; id: string; image: string; ports: string[]; volumes: string[] }[];
  }[];
  status: 'active' | 'reverted' | 'pending_decision';
  archiveSizeBytes: number;
  summary: string;
  logs?: string[];
  type?: 'MERGE' | 'COMPOSE_INSTALL';
  installMode?: 'existing-stack' | 'new-stack';
  sourceUrl?: string;
  remappedPorts?: { service: string; originalHostPort: number; allocatedHostPort: number }[];
}

// Backup paths: Prefer /app/backups as required by Directive 6, fallback to ./data/backups or ./backups
export function resolveBackupDir(): string {
  const preferred = '/app/backups';
  try {
    if (fs.existsSync(preferred)) {
      return preferred;
    }
    // Attempt to create if in container
    if (process.platform === 'linux' && fs.existsSync('/app')) {
      fs.mkdirSync(preferred, { recursive: true });
      return preferred;
    }
  } catch {
    // fallback
  }

  const localFallback = path.join(process.cwd(), 'data', 'backups');
  if (!fs.existsSync(localFallback)) {
    fs.mkdirSync(localFallback, { recursive: true });
  }
  return localFallback;
}

export function getLedgerPath(): string {
  const backupDir = resolveBackupDir();
  return path.join(backupDir, 'history.json');
}

/**
 * Load state ledger from history.json
 */
export function getMergeHistory(): MergeHistoryRecord[] {
  try {
    const ledgerPath = getLedgerPath();
    if (!fs.existsSync(ledgerPath)) {
      return [];
    }
    const raw = fs.readFileSync(ledgerPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }
    return [];
  } catch (err) {
    console.error('[HistoryService] Error loading history:', err);
    return [];
  }
}

/**
 * Save state ledger to history.json
 */
export function saveMergeHistoryRecord(record: MergeHistoryRecord): void {
  try {
    const backupDir = resolveBackupDir();
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const history = getMergeHistory();
    const existingIndex = history.findIndex((h) => h.id === record.id);
    if (existingIndex >= 0) {
      history[existingIndex] = record;
    } else {
      history.unshift(record);
    }
    const ledgerPath = getLedgerPath();
    fs.writeFileSync(ledgerPath, JSON.stringify(history, null, 2), 'utf8');
  } catch (err) {
    console.error('[HistoryService] Error saving history record:', err);
  }
}

/**
 * Create a full pre-merge snapshot in /app/backups tagged with merge ID and ISO timestamp
 */
export async function createPreMergeSnapshot(params: {
  mergeId: string;
  targetStackName: string;
  targetDirectory: string;
  selectedContainers: DeepContainerMetadata[];
  preMergeTargetCompose?: string;
}): Promise<{ backupArchiveDir: string; record: MergeHistoryRecord }> {
  const { mergeId, targetStackName, targetDirectory, selectedContainers, preMergeTargetCompose } = params;
  const backupRoot = resolveBackupDir();
  const archiveDirName = `snapshot_${mergeId}`;
  const backupArchiveDir = path.join(backupRoot, archiveDirName);

  if (!fs.existsSync(backupArchiveDir)) {
    fs.mkdirSync(backupArchiveDir, { recursive: true });
  }

  // Backup target compose file if it exists
  let targetComposeBackupPath: string | undefined;
  if (preMergeTargetCompose) {
    targetComposeBackupPath = path.join(backupArchiveDir, 'target-docker-compose.pre-merge.yml');
    fs.writeFileSync(targetComposeBackupPath, preMergeTargetCompose, 'utf8');
  }

  // Group source containers by stack/working directory
  const sourceStacksSet = new Set<string>();
  const sourceConfigsMap: Record<string, MergeHistoryRecord['sourceConfigs'][0]> = {};

  for (const c of selectedContainers) {
    const proj = c.compose?.project || 'standalone';
    const workingDir = c.compose?.workingDir || '';
    sourceStacksSet.add(proj);

    if (!sourceConfigsMap[proj]) {
      let originalCompose: string | undefined;
      if (workingDir) {
        const compPath = path.join(workingDir, 'docker-compose.yml');
        try {
          const content = await readHostFile(compPath);
          if (content && content.trim().length > 0) {
            originalCompose = content;
            const archiveCompPath = path.join(backupArchiveDir, `${proj}.docker-compose.pre-merge.yml`);
            fs.writeFileSync(archiveCompPath, originalCompose, 'utf8');
          }
        } catch {
          // ignore
        }
      }

      sourceConfigsMap[proj] = {
        project: proj,
        workingDir,
        composeContent: originalCompose,
        containers: [],
      };
    }

    sourceConfigsMap[proj].containers.push({
      name: c.cleanName,
      id: c.id,
      image: c.image,
      ports: c.ports.map((p) => `${p.publicPort || p.privatePort}:${p.privatePort}/${p.type}`),
      volumes: c.mounts.map((m) => `${m.source}:${m.destination}`),
    });
  }

  // Calculate snapshot size
  let archiveSizeBytes = 0;
  try {
    const files = fs.readdirSync(backupArchiveDir);
    for (const f of files) {
      const st = fs.statSync(path.join(backupArchiveDir, f));
      archiveSizeBytes += st.size;
    }
  } catch {
    archiveSizeBytes = 1024;
  }

  const record: MergeHistoryRecord = {
    id: mergeId,
    timestamp: new Date().toISOString(),
    targetStackName,
    targetDirectory,
    backupArchiveDir,
    sourceStacks: Array.from(sourceStacksSet),
    affectedServices: selectedContainers.map((c) => c.cleanName),
    preMergeComposeContent: preMergeTargetCompose,
    targetComposeBackupPath,
    sourceConfigs: Object.values(sourceConfigsMap),
    status: 'pending_decision',
    archiveSizeBytes,
    summary: `Merged ${selectedContainers.length} service(s) into ${targetStackName}`,
  };

  saveMergeHistoryRecord(record);

  return { backupArchiveDir, record };
}

/**
 * Revert a past merge from its backup snapshot
 */
export function getHistoryRecordById(id: string): MergeHistoryRecord | undefined {
  const list = getMergeHistory();
  return list.find((h) => h.id === id);
}

/**
 * Mark merge status as active (user clicked "Keep Changes")
 */
export function finalizeMergeRecord(id: string): boolean {
  const record = getHistoryRecordById(id);
  if (!record) return false;
  record.status = 'active';
  saveMergeHistoryRecord(record);
  return true;
}

/**
 * Mark merge status as reverted
 */
export function markMergeAsReverted(id: string, logs: string[]): boolean {
  const record = getHistoryRecordById(id);
  if (!record) return false;
  record.status = 'reverted';
  record.logs = logs;
  saveMergeHistoryRecord(record);
  return true;
}

/**
 * Directives 4 & 5: Create state ledger entry & zero-data-loss backup snapshot for COMPOSE_INSTALL
 */
export async function createComposeInstallSnapshot(params: {
  installId: string;
  targetStackName: string;
  targetDirectory: string;
  installMode: 'existing-stack' | 'new-stack';
  sourceUrl: string;
  affectedServices: string[];
  preMergeComposeContent?: string;
  remappedPorts?: { service: string; originalHostPort: number; allocatedHostPort: number }[];
}): Promise<{ backupArchiveDir: string; record: MergeHistoryRecord }> {
  const {
    installId,
    targetStackName,
    targetDirectory,
    installMode,
    sourceUrl,
    affectedServices,
    preMergeComposeContent,
    remappedPorts,
  } = params;

  const backupRoot = resolveBackupDir();
  const archiveDirName = `snapshot_${installId}`;
  const backupArchiveDir = path.join(backupRoot, archiveDirName);

  if (!fs.existsSync(backupArchiveDir)) {
    fs.mkdirSync(backupArchiveDir, { recursive: true });
  }

  let targetComposeBackupPath: string | undefined;
  if (preMergeComposeContent) {
    targetComposeBackupPath = path.join(backupArchiveDir, 'target-docker-compose.pre-merge.yml');
    fs.writeFileSync(targetComposeBackupPath, preMergeComposeContent, 'utf8');
  }

  let archiveSizeBytes = 1024;
  try {
    const files = fs.readdirSync(backupArchiveDir);
    archiveSizeBytes = files.reduce((acc, f) => acc + fs.statSync(path.join(backupArchiveDir, f)).size, 0);
  } catch {
    // ignore
  }

  const record: MergeHistoryRecord = {
    id: installId,
    timestamp: new Date().toISOString(),
    targetStackName,
    targetDirectory,
    backupArchiveDir,
    sourceStacks: [sourceUrl],
    affectedServices,
    preMergeComposeContent,
    targetComposeBackupPath,
    sourceConfigs: [],
    status: 'pending_decision',
    archiveSizeBytes,
    type: 'COMPOSE_INSTALL',
    installMode,
    sourceUrl,
    remappedPorts,
    summary:
      installMode === 'new-stack'
        ? `Provisioned new stack "${targetStackName}" with ${affectedServices.length} service(s) from remote Compose`
        : `Installed ${affectedServices.length} service(s) into existing stack "${targetStackName}" from remote Compose`,
  };

  saveMergeHistoryRecord(record);

  return { backupArchiveDir, record };
}

