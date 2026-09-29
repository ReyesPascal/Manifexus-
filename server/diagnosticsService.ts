/**
 * Diagnostics: plain-language health checks for Manifexus itself and for any app, plus live
 * resource use and container logs. Each check says what's fine, what isn't, and what to do.
 */
import fs from 'fs';
import path from 'path';
import { getConfig } from './storageService';
import { onServerSince } from './appIdentity';
import { queryDockerEngine, fetchContainerLogs } from './dockerService';
import { checkPrivilegeStatus } from './automationService';
import { getSelfContainerId, formatBytes } from './dataBackupService';
import { resolveBackupDir } from './historyService';
import { environmentSnapshot } from './observability';
import { logStats, getLogSettings, listActivities, queryEvents, redactText } from './activityLog';
import { getSoftwareUpdateState } from './updateService';
import { listRestorePoints } from './restoreService';
import { readHostFile } from './hostFsService';
import { getRegisteredCreatedStacks } from './stackService';
import yaml from 'yaml';

export interface Check {
  id: string;
  level: 'ok' | 'warn' | 'error' | 'info';
  title: string;
  detail: string;
  /** Opens a related screen in the dashboard */
  link?: 'activity' | 'updates' | 'restore' | 'settings' | 'logs' | 'storage';
  /** Specifics a fix needs (which file, app or value), not shown */
  data?: Record<string, string>;
}

export interface Resources {
  memoryBytes?: number;
  memoryLimitBytes?: number;
  cpuPercent?: number;
  pids?: number;
  netRxBytes?: number;
  netTxBytes?: number;
}

const ago = (iso?: string): string => {
  if (!iso || iso.startsWith('0001')) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
};

const duration = (iso?: string): string => {
  if (!iso || iso.startsWith('0001')) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} hours`;
  return `${Math.round(s / 86400)} days`;
};

/** What an exit code usually means */
export function exitMeaning(code: number): string {
  if (code === 0) return 'it stopped normally';
  if (code === 137) return 'it was killed (out of memory, or it didn’t stop in time)';
  if (code === 143) return 'it was asked to stop';
  if (code === 139) return 'it crashed (segmentation fault)';
  if (code === 1) return 'the app reported an error';
  if (code === 126 || code === 127) return 'its start command couldn’t run';
  return 'it stopped with an error';
}

/** One reading of CPU and memory (Docker needs about a second to measure CPU) */
export async function containerResources(id: string): Promise<Resources | undefined> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = await queryDockerEngine<any>(`/containers/${encodeURIComponent(id)}/stats?stream=false`, 'GET', undefined, 15000);
    const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.total_inactive_file ?? 0;
    const mem = s.memory_stats?.usage !== undefined ? Math.max(0, s.memory_stats.usage - cache) : undefined;
    const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
    const cpus = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
    const cpu = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cpus * 100 : undefined;
    let rx = 0;
    let tx = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const n of Object.values<any>(s.networks || {})) {
      rx += n.rx_bytes || 0;
      tx += n.tx_bytes || 0;
    }
    const limit = s.memory_stats?.limit;
    return {
      memoryBytes: mem,
      // Docker reports the whole machine's memory when there's no limit
      memoryLimitBytes: limit && limit < 2 ** 50 ? limit : undefined,
      cpuPercent: cpu !== undefined ? Math.round(cpu * 10) / 10 : undefined,
      pids: s.pids_stats?.current,
      netRxBytes: rx || undefined,
      netTxBytes: tx || undefined,
    };
  } catch {
    return undefined;
  }
}

// ----------------------------------------------------------------------------
// Any app
// ----------------------------------------------------------------------------

/** The most telling recent log line: the last error-looking line, else the last line */
async function lastWords(id: string): Promise<string | undefined> {
  try {
    const out = await fetchContainerLogs(id, 40);
    const lines = String(out.combined || '')
      .split('\n')
      .map((l) => l.replace(/^\S+Z\s+/, '').trim())
      .filter(Boolean);
    const bad = [...lines].reverse().find((l) => /\b(error|fatal|panic|exception|failed|denied|not found|missing|cannot|can't|unable)\b/i.test(l));
    const line = bad || lines[lines.length - 1];
    return line ? (line.length > 160 ? `${line.slice(0, 157)}…` : line) : undefined;
  } catch {
    return undefined;
  }
}

export async function appDiagnostics(id: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inspect = await queryDockerEngine<any>(`/containers/${encodeURIComponent(id)}/json`);
  const st = inspect.State || {};
  const name = String(inspect.Name || '').replace(/^\//, '');
  const running = Boolean(st.Running);
  const checks: Check[] = [];

  if (st.Restarting) {
    const said = await lastWords(id);
    checks.push({ id: 'state', level: 'error', title: 'Keeps restarting', detail: `It stops and Docker starts it again. Last exit code ${st.ExitCode}: ${exitMeaning(st.ExitCode)}.${said ? ` Its last message: “${said}”` : ''}`, link: 'logs' });
  } else if (running) {
    checks.push({ id: 'state', level: 'ok', title: 'Running', detail: `Running for ${duration(st.StartedAt)} since it last started.` });
  } else if (st.Status === 'created') {
    checks.push({ id: 'state', level: 'warn', title: 'Never started', detail: 'The container exists but hasn’t been started.' });
  } else {
    const code = Number(st.ExitCode ?? 0);
    const said = code !== 0 && code !== 143 && !st.OOMKilled ? await lastWords(id) : undefined;
    checks.push({
      id: 'state',
      level: code === 0 || code === 143 ? 'info' : 'error',
      title: 'Stopped',
      detail: `${ago(st.FinishedAt) ? `Stopped ${ago(st.FinishedAt)}, e` : 'E'}xit code ${code}: ${exitMeaning(code)}.${st.Error ? ` Docker said: ${st.Error}` : said ? ` Its last message: “${said}”` : ''}`,
      link: code === 0 || code === 143 ? undefined : 'logs',
    });
  }

  if (st.OOMKilled) {
    checks.push({ id: 'oom', level: 'error', title: 'Ran out of memory', detail: 'The last time it stopped, it was using more memory than it’s allowed, so it was killed.' });
  }

  const health = st.Health;
  if (health?.Status) {
    const last = (health.Log || []).slice(-1)[0];
    const out = last?.Output ? String(last.Output).trim().split('\n').slice(-2).join(' ').slice(0, 300) : '';
    checks.push({
      id: 'health',
      level: health.Status === 'healthy' ? 'ok' : health.Status === 'starting' ? 'info' : 'error',
      title: health.Status === 'healthy' ? 'Health check passing' : health.Status === 'starting' ? 'Health check starting' : 'Health check failing',
      detail:
        health.Status === 'unhealthy'
          ? `Failed ${health.FailingStreak} time${health.FailingStreak === 1 ? '' : 's'} in a row.${out ? ` Last result: ${out}` : ''}`
          : out
            ? `Last result: ${out}`
            : 'Its built-in health check reports it’s working.',
      link: health.Status === 'unhealthy' ? 'logs' : undefined,
    });
  }

  const restarts = Number(inspect.RestartCount || 0);
  if (restarts > 0) {
    checks.push({
      id: 'restarts',
      level: restarts >= 3 ? 'warn' : 'info',
      title: `Restarted ${restarts} time${restarts === 1 ? '' : 's'}`,
      detail: 'Docker restarted it automatically after it stopped. Its logs usually say why.',
      link: 'logs',
    });
  }

  const resources = running ? await containerResources(id) : undefined;
  if (resources?.memoryBytes !== undefined && resources.memoryLimitBytes) {
    const pct = (resources.memoryBytes / resources.memoryLimitBytes) * 100;
    if (pct > 90) {
      checks.push({ id: 'memory', level: 'warn', title: 'Close to its memory limit', detail: `Using ${formatBytes(resources.memoryBytes)} of ${formatBytes(resources.memoryLimitBytes)} (${Math.round(pct)}%).` });
    }
  }

  // Recent crashes and restarts from the Activity log
  const { events } = await queryEvents({ categories: ['container'], search: name, since: new Date(Date.now() - 7 * 86400000).toISOString(), limit: 20 });
  const recent = events
    .filter((e) => (e.data as { container?: string } | undefined)?.container === name)
    .slice(0, 8)
    .map((e) => ({ ts: e.ts, level: e.level, message: e.msg }));

  // How long it has really been on this server (updates recreate the container and reset Docker's clock)
  const volumeTimes: number[] = [];
  for (const m of (inspect.Mounts || []) as { Type?: string; Name?: string }[]) {
    if (m.Type !== 'volume' || !m.Name) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = await queryDockerEngine<any>(`/volumes/${encodeURIComponent(m.Name)}`).catch(() => null);
    if (v?.CreatedAt) volumeTimes.push(new Date(v.CreatedAt).getTime());
  }
  const labels = inspect.Config?.Labels || {};
  const since = onServerSince(
    { cleanName: name, image: String(inspect.Config?.Image || ''), compose: { service: labels['com.docker.compose.service'] } },
    [new Date(inspect.Created).getTime(), ...volumeTimes, /manifexus/i.test(String(inspect.Config?.Image || '')) ? dataFolderBirth() : undefined]
  );

  return {
    name,
    running,
    onServerSince: new Date(since).toISOString(),
    startedAt: st.StartedAt,
    finishedAt: st.FinishedAt,
    exitCode: st.ExitCode,
    restartCount: restarts,
    checks,
    resources,
    recent,
    checkedAt: new Date().toISOString(),
  };
}

/** Recent output of a container, newest last. */
export async function appLogs(id: string, tail: number | 'all' = 300): Promise<{ text: string; error?: string }> {
  const out = await fetchContainerLogs(id, tail);
  return { text: out.combined, error: out.error };
}

// ----------------------------------------------------------------------------
// Manifexus itself
// ----------------------------------------------------------------------------

function freeSpace(dir: string): { free: number; total: number } | undefined {
  try {
    // statfsSync exists on Node 18.15+
    const s = (fs as unknown as { statfsSync: (p: string) => { bavail: number; bsize: number; blocks: number } }).statfsSync(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return undefined;
  }
}

/**
 * An app listed in two stacks' compose files (same container_name). Only one container can have
 * that name, so starting the other stack as a whole fails with "name already in use".
 */
async function duplicateAppsCheck(): Promise<Check | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = await queryDockerEngine<any[]>('/containers/json?all=1');
  // container name -> the stack and service that made it ('' = started on its own)
  const owner = new Map<string, { project: string; service: string; oneoff: boolean }>();
  const files = new Map<string, string>(); // compose file -> stack
  for (const c of list || []) {
    const labels = c.Labels || {};
    if (labels['dev.manifexus.helper']) continue;
    const name = String(c.Names?.[0] || '').replace(/^\//, '');
    const project = labels['com.docker.compose.project'] || '';
    if (name) owner.set(name, { project, service: labels['com.docker.compose.service'] || '', oneoff: labels['com.docker.compose.oneoff'] !== 'False' });
    const file = String(labels['com.docker.compose.project.config_files'] || '').split(',')[0]?.trim();
    if (project && file?.startsWith('/')) files.set(file, project);
  }
  for (const st of getRegisteredCreatedStacks()) {
    const file = String(st.configFiles || '').split(',')[0]?.trim();
    if (st.project && file?.startsWith('/') && !files.has(file)) files.set(file, st.project);
  }
  const found: { app: string; stack: string; file: string; runsIn: string; service: string }[] = [];
  const DETACHED = '\u0000'; // same stack name, but not a container this file made
  await Promise.all(
    Array.from(files.entries()).map(async ([file, stack]) => {
      const text = await readHostFile(file).catch(() => null);
      if (!text) return;
      let services: Record<string, { container_name?: string }> = {};
      try {
        services = yaml.parse(text)?.services || {};
      } catch {
        return;
      }
      for (const [key, svc] of Object.entries(services)) {
        const n = svc?.container_name;
        if (!n || !owner.has(n)) continue;
        const o = owner.get(n)!;
        // Compose only adopts a container it made for this very service; anything else is in the way
        if (o.project === stack && o.service === key && !o.oneoff) continue;
        found.push({ app: n, stack, file, runsIn: o.project === stack ? DETACHED : o.project, service: key });
      }
    })
  );
  if (!found.length) return undefined;
  const first = found[0];
  const where =
    first.runsIn === DETACHED
      ? `the ${first.app} that’s running wasn’t created from that file, so Docker won’t reuse it`
      : first.runsIn
        ? `the ${first.app} that’s running belongs to ${first.runsIn}`
        : `the ${first.app} that’s running was started on its own`;
  return {
    id: 'duplicates',
    level: 'warn',
    data: { app: first.app, stack: first.stack, file: first.file, service: first.service, detached: first.runsIn === DETACHED ? 'yes' : '' },
    title:
      first.runsIn === DETACHED && found.length === 1
        ? `${first.app} can’t be started from ${first.stack}’s file`
        : found.length === 1
          ? `${first.app} is listed in two stacks`
          : `${found.length} apps are listed in two stacks`,
    detail:
      `${first.stack}’s compose file ${first.runsIn === DETACHED ? 'lists' : 'also lists'} ${first.app}, but ${where}. Starting ${first.stack} as a whole would fail. ` +
      (first.runsIn === DETACHED
        ? `Either remove it from ${first.file}, or replace the container with one made from the file: docker rm -f ${first.app}, then docker compose up -d ${first.app} in ${first.file.replace(/\/[^/]+$/, '')} (its volumes and folders are kept).`
        : `Remove ${first.app} from ${first.file}.`) +
      (found.length > 1 ? ` Also: ${found.slice(1).map((f) => `${f.app} in ${f.stack}`).join(', ')}.` : ''),
  };
}

export async function systemDiagnostics() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env: any = await environmentSnapshot(true);
  const checks: Check[] = [];

  // Docker
  const dockerOk = Boolean(env.docker?.version);
  checks.push(
    dockerOk
      ? { id: 'docker', level: 'ok', title: 'Connected to Docker', detail: `Docker ${env.docker.version} on ${env.docker.os || 'the host'} · ${env.docker.running ?? '?'} of ${env.docker.containers ?? '?'} containers running.` }
      : { id: 'docker', level: 'error', title: 'Can’t reach Docker', detail: `Manifexus can’t talk to ${env.docker?.socket || '/var/run/docker.sock'}. Mount the Docker socket into the container.` }
  );

  // Automation
  const priv = await checkPrivilegeStatus().catch(() => null);
  if (priv) {
    checks.push(
      priv.mode === 'elevated'
        ? { id: 'automation', level: 'ok', title: 'Full automation', detail: 'Manifexus can edit stack files on your server, so moves and restores run in one click.', link: 'settings' }
        : {
            id: 'automation',
            level: 'warn',
            title: 'Limited automation',
            detail: priv.isSocketWritable ? 'It can manage containers but can’t edit stack files. Moves and restores need full access.' : 'The Docker socket is read-only, so Manifexus can only look, not change anything.',
            link: 'settings',
          }
    );
  }

  // Stack folders it can see
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const binds = (env.manifexus?.mounts || []).filter((m: any) => m.type === 'bind' && !String(m.destination).startsWith('/var/run') && !['/data', '/app/backups'].includes(m.destination));
  checks.push(
    binds.length
      ? { id: 'folders', level: 'ok', title: 'Stack folders visible', detail: `Can see ${binds.map((m: { source: string }) => m.source).join(', ')}.` }
      : { id: 'folders', level: 'info', title: 'No stack folders mounted', detail: 'Stack files are reached through Docker helpers instead of a direct mount. That works, but is a little slower.' }
  );

  // Where Manifexus keeps its data: it must outlive updates (settings, history, backups, AI models)
  const selfMounts = (env.manifexus?.mounts || []) as { type: string; source: string; destination: string }[];
  const dataMount = selfMounts.find((m) => m.destination === '/data');
  if (env.manifexus?.containerId && !dataMount) {
    checks.push({ id: 'data', level: 'error', title: 'Your data isn’t saved outside Manifexus', detail: 'Settings, history, backups and AI models would be lost when Manifexus is recreated. Add a volume for /data (for example ./data:/data) to its compose file.' });
  } else if (dataMount?.type === 'volume' && /^[0-9a-f]{64}$/.test(dataMount.source.split('/').filter(Boolean).slice(-2, -1)[0] || dataMount.source)) {
    checks.push({ id: 'data', level: 'info', title: 'Data is in an unnamed Docker volume', detail: 'Manifexus keeps it across its own updates, but removing the container by hand would lose it. Adding ./data:/data to its compose file makes it permanent.' });
  }

  // The New stacks folder setting must be a full path, or Manifexus can't use it
  const stacksSetting = (getConfig().stacksDir || '').trim();
  if (stacksSetting && !stacksSetting.startsWith('/')) {
    const settingsFile = dataMount ? `${dataMount.source.replace(/\/+$/, '')}/config.json` : 'config.json in Manifexus’s data folder';
    checks.push({
      id: 'stacks-dir',
      level: 'error',
      data: { value: stacksSetting, ...(dataMount ? { file: settingsFile } : {}) },
      title: 'New stacks folder setting is broken',
      detail: `It’s saved as “${stacksSetting}”, which isn’t a full path (it should start with /), so Manifexus ignores it. It’s the "stacksDir" line in Manifexus’s settings file: ${settingsFile}.`,
    });
  }

  // Apps listed in two stacks
  const dup = await duplicateAppsCheck().catch(() => undefined);
  if (dup) checks.push(dup);

  // Backups
  const backupDir = resolveBackupDir();
  const space = freeSpace(backupDir);
  const restore = listRestorePoints();
  const lowSpace = space && space.free < 2 * 1024 ** 3;
  checks.push({
    id: 'backups',
    level: !space ? 'info' : lowSpace ? 'warn' : 'ok',
    // Named after the screen it opens
    title: lowSpace ? 'Restore: backup space is low' : 'Restore',
    detail: `Backups use ${formatBytes(restore.storage.bytes)} (${restore.storage.count}) · ${space ? `${formatBytes(space.free)} free · ` : ''}kept ${restore.storage.keepDays ? `${restore.storage.keepDays} days` : 'forever'}.`,
    link: 'restore',
  });

  // Activity log
  const stats = logStats();
  const logs = getLogSettings();
  const since = new Date(Date.now() - 86400000).toISOString();
  const problems = listActivities({ statuses: ['failed', 'rolled_back', 'interrupted'], limit: 200 }).activities.filter((a) => (a.endedAt || a.startedAt) > since && !a.meta?.background);
  checks.push(
    // History, not a current issue: a plain counter that never raises the alarm on its own
    problems.length
      ? {
          id: 'problems',
          level: 'info',
          title: `Last 24 hours: ${problems.length} failed change${problems.length === 1 ? '' : 's'}`,
          detail:
            problems
              .slice(0, 2)
              .map((a) => a.title)
              .join(' · ') + (problems.length > 2 ? ` and ${problems.length - 2} more` : '') + '. Details are in Activity.',
        }
      : { id: 'problems', level: 'ok', title: 'Last 24 hours: no failed changes', detail: `Activity keeps ${formatBytes(stats.bytes)} of records for ${logs.retentionDays} days.` }
  );

  // Updates
  const upd = await getSoftwareUpdateState().catch(() => null);
  if (upd) {
    checks.push(
      upd.status === 'available'
        ? { id: 'updates', level: 'info', title: 'Update available', detail: `${upd.latest?.label || 'A new build'} is ready to install.`, link: 'updates' }
        : upd.checkError
          ? { id: 'updates', level: 'warn', title: 'Couldn’t check for updates', detail: /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/i.test(upd.checkError) ? 'Couldn’t reach the update server. Check that your server is online.' : upd.checkError, link: 'updates' }
          : { id: 'updates', level: 'ok', title: 'Up to date', detail: `${upd.current.label}${upd.lastCheckedAt ? ` · checked ${ago(upd.lastCheckedAt)}` : ''}.`, link: 'updates' }
    );
  }

  const selfId = await getSelfContainerId();
  const resources = selfId ? await containerResources(selfId) : undefined;

  const worst = checks.some((c) => c.level === 'error') ? 'error' : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok';
  const attention = checks.filter((c) => c.level === 'error' || c.level === 'warn').length;
  return {
    summary: {
      level: worst,
      text: worst === 'ok' ? 'All Clear' : `Attention: ${attention} Issue${attention === 1 ? '' : 's'} to Fix!`,
    },
    checks,
    resources,
    selfId,
    environment: env,
    checkedAt: new Date().toISOString(),
  };
}

/** A Markdown report of the checks, environment and recent Manifexus output, for pasting into any AI assistant or a support request. */
export async function systemReport(): Promise<string> {
  const d = await systemDiagnostics();
  const L: string[] = [];
  L.push('# Manifexus diagnostics');
  L.push('');
  L.push(`- **Checked:** ${d.checkedAt}`);
  L.push(`- **Summary:** ${d.summary.text}`);
  if (d.resources) {
    L.push(
      `- **Manifexus is using:** ${d.resources.memoryBytes !== undefined ? formatBytes(d.resources.memoryBytes) : '?'} memory, ${d.resources.cpuPercent ?? '?'}% CPU`
    );
  }
  L.push('');
  L.push('## Checks');
  for (const c of d.checks) L.push(`- **${c.level.toUpperCase()}** ${c.title}: ${c.detail}`);
  L.push('');
  L.push('## Environment');
  L.push('```json');
  L.push(redactText(JSON.stringify(d.environment, null, 2)));
  L.push('```');
  if (d.selfId) {
    const logs = await appLogs(d.selfId, 150);
    L.push('');
    L.push('## Last 150 lines from the Manifexus container');
    L.push('```');
    L.push(redactText(logs.text.trim() || logs.error || '(no output)'));
    L.push('```');
  }
  return L.join('\n');
}

/** When Manifexus's own data folder was made: when Manifexus was first set up on this server */
function dataFolderBirth(): number | undefined {
  try {
    const dir = fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data');
    const times = ['config.json', '.'].map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return Math.min(...[st.birthtimeMs, st.mtimeMs, st.ctimeMs].filter((t) => t > 0));
    });
    return Math.min(...times);
  } catch {
    return undefined;
  }
}
