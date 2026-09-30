import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import type { DeepContainerMetadata } from '../src/types';
import { currentActivityId } from './activityLog';
import { friendlyName, isHelperImage } from './appIdentity';
import {
  removeServicesFromCompose,
  standaloneSpec,
  startContainer,
  stopContainerAndWait,
} from './automationService';
import {
  appOwnData,
  archiveAppData,
  formatBytes,
  getBackupFreeBytes,
  measureAppData,
  removeHostDirectory,
  removeVolume,
  type AppDataParams,
} from './dataBackupService';
import { getContainersList, removeDemoContainers } from './dockerService';
import { globalLogService } from './globalLogService';
import { resolveBackupDir, saveMergeHistoryRecord, type MergeHistoryRecord } from './historyService';
import { forceRemoveContainer, readHostFile, writeHostFile } from './hostFsService';
import { isManifexusContainer, registerCreatedStack } from './stackService';

/**
 * Deleting one app (with its own database or cache), leaving the rest of its stack running.
 *
 * Safety model, the same as deleting a stack:
 *   1. The app's compose entry (or, for a standalone app, everything needed to recreate it) is saved.
 *   2. The app is stopped, and its own data (its volumes and the folders only it uses) is backed up.
 *      If the backup fails, the app is started again and nothing is deleted.
 *   3. Only then is it taken out of its compose file, its containers removed, and its own volumes and
 *      folders deleted. Shared folders (a media library, downloads) are never touched.
 * Restore brings it back: compose entry, data, and the app running again.
 */

interface Resolved {
  apps: DeepContainerMetadata[];
  others: DeepContainerMetadata[];
  isDemo: boolean;
  project?: string;
  workingDir?: string;
  composePath?: string;
  label: string;
  dataParams: AppDataParams;
}

async function resolve(ids: string[]): Promise<Resolved> {
  const { containers, isDemo } = await getContainersList();
  const apps = containers.filter((c) => ids.includes(c.id));
  if (!apps.length) throw new Error('That app isn’t on this server anymore.');
  if (apps.some((c) => isManifexusContainer(c))) throw new Error('Manifexus can’t delete itself.');
  const projects = Array.from(new Set(apps.map((c) => (c.compose?.isCompose && c.compose.project) || '')));
  if (projects.length > 1) throw new Error('These apps are in different stacks. Delete them one at a time.');
  const project = projects[0] || undefined;
  const first = apps[0];
  const workingDir = project ? first.compose?.workingDir : undefined;
  const firstConfig = (first.compose?.configFiles || '').split(',')[0]?.trim();
  const composePath = workingDir ? (firstConfig && firstConfig.startsWith('/') ? firstConfig : path.posix.join(workingDir, 'docker-compose.yml')) : undefined;
  // Name it as the dashboard does: the app, not its database
  const mains = apps.filter((c) => !isHelperImage(c.image));
  const label = (mains[0] ? friendlyName(mains[0]) : friendlyName(first)) || first.cleanName;
  const others = containers.filter((c) => !ids.includes(c.id));
  const dataParams: AppDataParams = {
    apps: apps.map((c) => ({ name: friendlyName(c), workingDir: c.compose?.workingDir, mounts: c.mounts || [] })),
    stackDirs: Array.from(new Set(containers.map((c) => c.compose?.workingDir).filter(Boolean) as string[])),
    sharedDirs: others.flatMap((c) => (c.mounts || []).filter((m) => m.type === 'bind' && m.source).map((m) => m.source)),
    sharedVolumes: others.flatMap((c) => (c.mounts || []).filter((m) => m.type === 'volume' && m.name).map((m) => m.name as string)),
  };
  return { apps, others, isDemo, project, workingDir, composePath, label, dataParams };
}

/** What deleting would remove and back up, for the confirmation screen */
export async function planAppDelete(ids: string[]) {
  const r = await resolve(ids);
  if (r.isDemo) {
    return { label: r.label, stack: r.project, own: [], shared: [], totalBytes: 0, freeBytes: getBackupFreeBytes() };
  }
  const { own, shared } = await appOwnData(r.dataParams);
  const measured = await measureAppData(own);
  return {
    label: r.label,
    stack: r.project,
    own: measured,
    shared,
    totalBytes: measured.reduce((s, x) => s + x.bytes, 0),
    freeBytes: getBackupFreeBytes(),
  };
}

/** Named volumes the compose file declares that no service uses anymore (they belonged to the deleted app) */
function dropUnusedVolumes(composeText: string): string {
  try {
    const doc = yaml.parseDocument(composeText);
    const declared = doc.get('volumes');
    if (!yaml.isMap(declared)) return composeText;
    const used = new Set<string>();
    const svcs = doc.toJS()?.services || {};
    for (const s of Object.values<{ volumes?: (string | { source?: string })[] }>(svcs)) {
      for (const v of s?.volumes || []) {
        const src = typeof v === 'string' ? v.split(':')[0] : v?.source;
        if (src && !src.startsWith('.') && !src.startsWith('/') && !src.startsWith('~')) used.add(src);
      }
    }
    for (const item of [...declared.items]) {
      const key = String((item.key as yaml.Scalar)?.value ?? item.key);
      if (!used.has(key)) doc.deleteIn(['volumes', key]);
    }
    if (yaml.isMap(doc.get('volumes')) && !(doc.get('volumes') as yaml.YAMLMap).items.length) doc.delete('volumes');
    return doc.toString();
  } catch {
    return composeText;
  }
}

export async function deleteApps(params: { ids: string[]; skipDataBackup?: boolean; label?: string }): Promise<{
  success: boolean;
  message: string;
  historyRecordId: string;
  dataBackupBytes: number;
  /** Folders or volumes that couldn't be removed */
  left: string[];
}> {
  const r = await resolve(params.ids);
  const { apps, isDemo, project, workingDir, composePath } = r;
  // The name people see on the dashboard (theirs, if they renamed it)
  const label = (params.label || '').trim().slice(0, 80) || r.label;
  const skip = params.skipDataBackup === true;
  const services = apps.map((c) => c.compose?.service).filter(Boolean) as string[];

  // 1. Save what's needed to bring it back
  let originalCompose: string | undefined;
  if (composePath && !isDemo) {
    originalCompose = (await readHostFile(composePath)) || undefined;
    if (!originalCompose) throw new Error(`Couldn’t read ${composePath}, so ${label} can’t be taken out of ${project} safely. Nothing was changed.`);
  }
  const id = `appdelete_${label.replace(/[^a-zA-Z0-9_.-]/g, '_').toLowerCase()}_${Date.now()}`;
  const backupArchiveDir = path.join(resolveBackupDir(), `snapshot_${id}`);
  fs.mkdirSync(backupArchiveDir, { recursive: true });
  if (originalCompose && project) fs.writeFileSync(path.join(backupArchiveDir, `${project}.docker-compose.pre-merge.yml`), originalCompose);
  const standaloneApps: { name: string; spec: Record<string, unknown> }[] = [];
  if (!project && !isDemo) {
    for (const c of apps) standaloneApps.push({ name: c.name.replace(/^\//, ''), spec: await standaloneSpec(c.id) });
  }
  const own = isDemo ? [] : (await appOwnData(r.dataParams)).own;

  // 2. Stop it, then back up its own data (or record that the person chose not to)
  if (!isDemo) for (const c of apps) await stopContainerAndWait(c.id);
  let dataArchives: MergeHistoryRecord['dataArchives'] = [];
  if (!isDemo && !skip) {
    try {
      dataArchives = await archiveAppData({ ...r.dataParams, archiveDir: backupArchiveDir });
    } catch (err) {
      for (const c of apps) await startContainer(c.id);
      fs.rmSync(backupArchiveDir, { recursive: true, force: true });
      throw new Error(`Delete cancelled: the backup of ${label}’s data failed (${(err as Error).message}). Nothing was deleted and ${label} was started again.`);
    }
  }
  const dataBackupBytes = dataArchives.reduce((s, a) => s + a.bytes, 0);
  const updatedCompose = originalCompose ? dropUnusedVolumes(removeServicesFromCompose(originalCompose, services)) : undefined;

  const rec: MergeHistoryRecord = {
    id,
    timestamp: new Date().toISOString(),
    targetStackName: project || '',
    targetDirectory: '',
    backupArchiveDir,
    sourceStacks: [project || 'standalone'],
    affectedServices: apps.map((c) => c.cleanName),
    sourceConfigs: [
      {
        project: project || 'standalone',
        workingDir: workingDir || '',
        composeContent: originalCompose,
        composePath,
        containers: apps.map((c) => ({
          name: c.cleanName,
          id: c.id,
          image: c.image,
          ports: c.ports.map((p) => `${p.publicPort || p.privatePort}:${p.privatePort}/${p.type}`),
          volumes: c.mounts.map((m) => `${m.source}:${m.destination}`),
        })),
      },
    ],
    status: 'active',
    archiveSizeBytes: dataBackupBytes,
    summary: `Deleted ${label}${project ? ` from ${project}` : ''}${skip ? ' (data backup skipped by user)' : ''}`,
    type: 'APP_DELETE',
    deletedApps: { names: apps.map((c) => friendlyName(c)), project, workingDir },
    dataArchives,
    dataBackupSkipped: skip || undefined,
    movedServices: project && workingDir ? [{ project, workingDir, services }] : [],
    standaloneApps,
    appLabels: [label],
    activityId: currentActivityId(),
    resultFiles: composePath && updatedCompose !== undefined ? [{ path: composePath, content: updatedCompose }] : [],
  };
  saveMergeHistoryRecord(rec);

  // 3. Take it out of its stack, remove its containers, then its own data
  if (isDemo) {
    removeDemoContainers(apps.map((c) => c.id));
  } else {
    if (composePath && updatedCompose !== undefined) {
      if (!(await writeHostFile(composePath, updatedCompose))) {
        for (const c of apps) await startContainer(c.id);
        rec.failed = true;
        saveMergeHistoryRecord(rec);
        throw new Error(`Couldn’t update ${composePath}. Nothing was deleted and ${label} was started again.`);
      }
    }
    for (const c of apps) await forceRemoveContainer(c.id);
  }
  const left: string[] = [];
  for (const it of own) {
    const ok = it.kind === 'volume' ? await removeVolume(it.source).catch(() => false) : await removeHostDirectory(it.source).catch(() => false);
    if (!ok) left.push(it.source);
  }

  // A stack whose last app was deleted stays on the dashboard (empty): only Delete Stack removes a stack
  if (!isDemo && project && workingDir && composePath && updatedCompose !== undefined) {
    let remaining = 1;
    try {
      remaining = Object.keys(yaml.parse(updatedCompose)?.services || {}).length;
    } catch {
      // keep as is
    }
    if (remaining === 0) registerCreatedStack({ project, workingDir, configFiles: composePath, serviceCount: 0, source: 'provisioned' });
  }

  globalLogService.log({
    eventType: 'STACK_OP',
    level: left.length ? 'WARN' : 'INFO',
    source: 'appDeleteService',
    message: `Deleted ${label}${project ? ` from ${project}` : ''} (data backup ${skip ? 'skipped' : formatBytes(dataBackupBytes)}${left.length ? `; couldn’t remove ${left.join(', ')}` : ''})`,
    payload: { ids: params.ids, project, backupArchiveDir, historyRecordId: id, dataBackupBytes, left },
  });

  const where = project ? ` from ${project}` : '';
  return {
    success: true,
    historyRecordId: id,
    dataBackupBytes,
    left,
    message: left.length
      ? `${label} was deleted${where}, but ${left.join(', ')} couldn’t be removed from the server. ${skip ? '' : 'Everything is backed up in Restore.'}`.trim()
      : skip
        ? `${label} was deleted${where}. Its settings were saved, but its data was not backed up.`
        : `${label} was deleted${where}. Its settings${dataBackupBytes ? ` and ${formatBytes(dataBackupBytes)} of data` : ''} are backed up. Bring it back anytime from Restore.`,
  };
}
