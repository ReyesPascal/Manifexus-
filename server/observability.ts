/**
 * Observability glue: environment snapshots, Docker's own container event stream, the HTTP
 * request tracker (every user action becomes an Activity), and diagnostic exports
 * (a JSON bundle and a Markdown report written for troubleshooting, e.g. by an AI assistant).
 */
import { localVersion } from './releaseNotes';
import http from 'http';
import os from 'os';
import type { NextFunction, Request, Response } from 'express';
import {
  Activity,
  LogEvent,
  activityEvents,
  finishActivity,
  getActivity,
  getLogSettings,
  queryEvents,
  record,
  runInActivity,
  setBuildLabel,
  startActivity,
} from './activityLog';
import { queryDockerEngine, HELPER_LABEL } from './dockerService';
import { getSelf } from './updateService';
import { checkPrivilegeStatus } from './automationService';
import { getConfig } from './storageService';

const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const bootedAt = new Date().toISOString();

// ----------------------------------------------------------------------------
// Environment snapshot
// ----------------------------------------------------------------------------

let envCache: { at: number; value: Record<string, unknown> } | undefined;

/** Everything about where Manifexus runs that could explain a problem. Cached for a minute. */
export async function environmentSnapshot(force = false): Promise<Record<string, unknown>> {
  if (!force && envCache && Date.now() - envCache.at < 60 * 1000) return envCache.value;
  const safe = async <T>(fn: () => Promise<T>): Promise<T | { error: string }> => {
    try {
      return await fn();
    } catch (err) {
      return { error: (err as Error).message };
    }
  };
  const self = await getSelf().catch(() => null);
  const labels = self?.image?.Config?.Labels || {};
  const revision = labels['org.opencontainers.image.revision'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const version: any = await safe(() => queryDockerEngine<any>('/version'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info: any = await safe(() => queryDockerEngine<any>('/info'));
  const config = getConfig();
  const value = {
    capturedAt: new Date().toISOString(),
    manifexus: {
      build: localVersion() ? `Version ${localVersion()}${revision ? ` (${String(revision).slice(0, 7)})` : ''}` : revision ? `Build ${String(revision).slice(0, 7)}` : 'Development build',
      revision,
      builtAt: labels['org.opencontainers.image.created'],
      source: labels['org.opencontainers.image.source'],
      image: self?.imageRef,
      imageId: self?.imageId,
      container: self?.name,
      containerId: self?.id?.slice(0, 12),
      installMode: self ? (self.compose ? 'compose' : 'docker run') : 'not in Docker',
      compose: self?.compose,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mounts: (self?.inspect?.Mounts || []).map((m: any) => ({ type: m.Type, source: m.Source || m.Name, destination: m.Destination, rw: m.RW })),
      restartPolicy: self?.inspect?.HostConfig?.RestartPolicy?.Name,
      startedAt: self?.inspect?.State?.StartedAt || bootedAt,
      processStartedAt: bootedAt,
      node: process.version,
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    docker: {
      version: version?.Version,
      apiVersion: version?.ApiVersion,
      os: info?.OperatingSystem,
      kernel: info?.KernelVersion || version?.KernelVersion,
      arch: version?.Arch || info?.Architecture,
      storageDriver: info?.Driver,
      rootDir: info?.DockerRootDir,
      cpus: info?.NCPU,
      memoryGB: info?.MemTotal ? Math.round((info.MemTotal / 1024 ** 3) * 10) / 10 : undefined,
      containers: info?.Containers,
      running: info?.ContainersRunning,
      images: info?.Images,
      rootless: Array.isArray(info?.SecurityOptions) ? info.SecurityOptions.some((s: string) => s.includes('rootless')) : undefined,
      cgroup: info?.CgroupVersion,
      socket: DOCKER_SOCKET_PATH,
    },
    permissions: await safe(() => checkPrivilegeStatus()),
    settings: {
      hostAddress: config.hostAddress,
      stacksDir: config.stacksDir || '(automatic)',
      refreshIntervalSeconds: config.refreshIntervalSeconds,
      log: getLogSettings(),
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hostname: os.hostname(),
      uptimeSeconds: Math.round(process.uptime()),
    },
  };
  envCache = { at: Date.now(), value };
  setBuildLabel(value.manifexus.build);
  return value;
}

// ----------------------------------------------------------------------------
// Docker container events (crashes, OOM kills, health changes, restarts…)
// ----------------------------------------------------------------------------

const WATCHED = ['create', 'start', 'die', 'oom', 'kill', 'restart', 'health_status', 'destroy', 'rename', 'pause', 'unpause'];

export function watchDockerEvents() {
  let retry = 2000;
  const connect = () => {
    if (!getLogSettings().containerEvents) {
      setTimeout(connect, 30000);
      return;
    }
    const filters = encodeURIComponent(JSON.stringify({ type: ['container'], event: WATCHED }));
    // One reconnect per connection: a reset fires 'error' on both the request and the response
    let reconnecting = false;
    const reconnect = (backoff: boolean) => {
      if (reconnecting) return;
      reconnecting = true;
      if (backoff) retry = Math.min(retry * 2, 60000);
      setTimeout(connect, retry);
    };
    const req = http.request({ socketPath: DOCKER_SOCKET_PATH, path: `/events?filters=${filters}`, method: 'GET', headers: { Host: 'docker' } }, (res) => {
      retry = 2000;
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handleDockerEvent(line);
        }
      });
      res.on('end', () => reconnect(false));
      res.on('error', () => reconnect(false));
    });
    req.on('error', () => reconnect(true));
    req.end();
  };
  connect();
}

function handleDockerEvent(line: string) {
  if (!getLogSettings().containerEvents) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  const attrs = e.Actor?.Attributes || {};
  if (attrs[HELPER_LABEL] === 'true') return; // Manifexus's own helpers are recorded elsewhere
  const cid = String(e.Actor?.ID || e.id || '');
  const name = attrs.name || cid.slice(0, 12);
  const action: string = e.Action || e.status || '';
  const ts = e.timeNano ? new Date(Math.floor(e.timeNano / 1e6)).toISOString() : new Date().toISOString();
  const data = {
    container: name,
    id: cid.slice(0, 12),
    action,
    image: attrs.image,
    project: attrs['com.docker.compose.project'],
    service: attrs['com.docker.compose.service'],
    exitCode: attrs.exitCode !== undefined ? Number(attrs.exitCode) : undefined,
    signal: attrs.signal,
  };
  let level: 'debug' | 'info' | 'warn' | 'error' = 'info';
  let msg = `${name}: ${action}`;
  if (action === 'die') {
    const code = Number(attrs.exitCode);
    const why = code === 137 ? ' (killed — out of memory or forced stop)' : code === 143 ? ' (stopped)' : code === 139 ? ' (crashed: segmentation fault)' : '';
    msg = `${name} stopped with exit code ${code}${why}`;
    level = code === 0 || code === 143 ? 'info' : 'warn';
  } else if (action === 'oom') {
    msg = `${name} ran out of memory`;
    level = 'error';
  } else if (action.startsWith('health_status')) {
    const st = action.split(':')[1]?.trim() || '';
    msg = `${name} is ${st}`;
    level = st === 'unhealthy' ? 'warn' : 'info';
  } else if (action === 'start') msg = `${name} started`;
  else if (action === 'restart') msg = `${name} restarted`;
  else if (action === 'kill') {
    msg = `${name} was sent signal ${attrs.signal}`;
    level = 'debug';
  } else if (action === 'create' || action === 'destroy') {
    msg = `${name} ${action === 'create' ? 'created' : 'removed'}`;
    level = 'debug';
  } else if (action === 'rename') msg = `${attrs.oldName?.replace(/^\//, '') || 'container'} renamed to ${name}`;
  record(level, 'container', msg, data, { activityId: null, ts });
}

// ----------------------------------------------------------------------------
// Request tracker: every user action becomes an Activity
// ----------------------------------------------------------------------------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Describer = (req: Request, body: any) => { type: string; title: string } | null;

const ROUTES: [string, RegExp, Describer][] = [
  ['POST', /^\/api\/stacks\/execute-merge-stream$/, (_r, b) => ({ type: 'move', title: `Move apps into ${b?.targetStackName || 'a stack'}` })],
  ['POST', /^\/api\/stacks\/plan-merge$/, (_r, b) => ({ type: 'plan', title: `Review move into ${b?.targetStackName || 'a stack'}` })],
  ['POST', /^\/api\/stacks\/execute-merge$/, (_r, b) => ({ type: 'move', title: `Move apps into ${b?.targetStackName || 'a stack'}` })],
  ['POST', /^\/api\/stacks\/create$/, (_r, b) => ({ type: 'stack', title: `Create stack ${b?.stackName || ''}`.trim() })],
  ['POST', /^\/api\/cleanup\/run$/, (_r, b) => ({ type: 'delete', title: `Clean up ${Array.isArray(b?.paths) ? b.paths.length : ''} unused folder${Array.isArray(b?.paths) && b.paths.length === 1 ? '' : 's'}`.replace('  ', ' ') })],
  ['POST', /^\/api\/stacks\/delete$/, (_r, b) => ({ type: 'delete', title: `Delete stack ${b?.projectName || ''}`.trim() })],
  ['POST', /^\/api\/apps\/delete$/, (_r, b) => ({ type: 'delete', title: `Delete ${b?.label || 'app'}`.trim() })],
  ['POST', /^\/api\/restore\/([^/]+)\/run$/, () => ({ type: 'undo', title: 'Restore' })],
  ['POST', /^\/api\/ai\/plans\/([^/]+)\/run$/, () => ({ type: 'fix', title: 'Fix with the built-in AI' })],
  ['POST', /^\/api\/ai\/settings$/, () => ({ type: 'settings', title: 'Change AI settings' })],
  ['POST', /^\/api\/ai\/engine\/install$/, () => ({ type: 'settings', title: 'Install the AI engine' })],
  ['POST', /^\/api\/ai\/models\/install$/, (_r, b) => ({ type: 'settings', title: `Download AI model ${b?.model || ''}`.trim() })],
  ['POST', /^\/api\/ai\/models\/install-bundle$/, () => ({ type: 'settings', title: 'Download the recommended AI models' })],
  ['POST', /^\/api\/ai\/models\/cancel$/, (_r, b) => ({ type: 'settings', title: `Cancel download of AI model ${b?.model || ''}`.trim() })],
  ['POST', /^\/api\/ai\/chat$/, (_r, b) => {
    const list = Array.isArray(b?.messages) ? b.messages : [];
    const q = String(list[list.length - 1]?.content || '').replace(/\s+/g, ' ').replace(/^Please fix (this|these \d+ issues):?\s*/i, '').trim();
    const t = q.length > 80 ? `${q.slice(0, 79)}…` : q;
    return b?.mode === 'fix' ? { type: 'ask', title: `Fix with AI: ${t || 'a problem'}` } : { type: 'ask', title: `Ask Manifexus: ${t || 'a question'}` };
  }],
  ['POST', /^\/api\/ai\/models\/remove$/, (_r, b) => ({ type: 'settings', title: `Remove AI model ${b?.model || ''}`.trim() })],
  ['POST', /^\/api\/restore\/([^/]+)\/copy$/, () => ({ type: 'undo', title: 'Restore a backup to another folder' })],
  ['POST', /^\/api\/restore\/delete$/, (_r, b) => ({ type: 'undo', title: `Delete ${Array.isArray(b?.ids) && b.ids.length > 1 ? `${b.ids.length} changes` : 'a change'} from Restore` })],
  ['POST', /^\/api\/restore\/([^/]+)\/pin$/, (_r, b) => ({ type: 'settings', title: b?.pinned === false ? 'Unpin a backup' : 'Pin a backup' })],
  ['POST', /^\/api\/restore\/archive\/clear$/, () => ({ type: 'undo', title: 'Clear archived changes' })],
  ['POST', /^\/api\/restore\/settings$/, () => ({ type: 'settings', title: 'Change how long backups are kept' })],
  ['POST', /^\/api\/system\/update\/check$/, () => ({ type: 'update', title: 'Check for updates' })],
  ['POST', /^\/api\/system\/update\/install$/, () => ({ type: 'update', title: 'Install Manifexus update' })],
  ['POST', /^\/api\/system\/update\/settings$/, () => ({ type: 'settings', title: 'Change update settings' })],
  ['POST', /^\/api\/containers\/([^/]+)\/action$/, (_r, b) => ({ type: 'app', title: `${cap(String(b?.action || 'Change'))} app` })],
  ['PUT', /^\/api\/containers\/([^/]+)\/override$/, () => ({ type: 'app', title: 'Edit app details' })],
  ['POST', /^\/api\/config$/, () => ({ type: 'settings', title: 'Change settings' })],
  ['POST', /^\/api\/groups$/, (_r, b) => ({ type: 'settings', title: `Save group ${b?.name || ''}`.trim() })],
  ['DELETE', /^\/api\/groups\/([^/]+)$/, () => ({ type: 'settings', title: 'Delete group' })],
  ['POST', /^\/api\/demo\//, () => ({ type: 'system', title: 'Simulate a container' })],
];

/** Read-only POSTs and the log API itself: no activity, low-detail request event only. */
// Background requests the person didn't ask for directly: logged, but not listed in Activity
const QUIET = [/^\/api\/apps\/[^/]+\/icon\/(seen|refresh)$/, /^\/api\/stacks\/data-footprint$/, /^\/api\/apps\/delete-plan$/, /^\/api\/logs(\/|$)/, /^\/api\/ai\/warm$/, /^\/api\/diagnostics\/autofix$/];

export function requestTracker(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api/')) return next();
  if (/^\/api\/logs(\/|$)/.test(req.path)) return next();
  const started = Date.now();
  const quiet = QUIET.some((r) => r.test(req.path));
  let activity: Activity | undefined;
  if (!quiet && req.method !== 'GET') {
    const route = ROUTES.find(([m, r]) => m === req.method && r.test(req.path));
    const d = route ? route[2](req, req.body) : { type: 'other', title: `${req.method} ${req.path}` };
    if (d) {
      activity = startActivity({
        type: d.type,
        title: d.title,
        actor: { kind: 'user', ip: req.ip, userAgent: req.get('user-agent') || undefined },
        input: { method: req.method, path: req.originalUrl, body: req.body },
      });
      res.setHeader('X-Activity-Id', activity.id);
      res.setHeader('Access-Control-Expose-Headers', 'X-Activity-Id');
    }
  }

  // Keep the JSON response for the record (errors especially)
  let responseBody: unknown;
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    responseBody = body;
    return originalJson(body);
  };

  let done = false;
  const onDone = () => {
    if (done) return;
    done = true;
    const status = res.statusCode;
    const isStream = String(res.getHeader('Content-Type') || '').includes('text/event-stream');
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : activity ? 'info' : req.method === 'GET' ? 'trace' : 'debug';
    const error = (responseBody as { error?: string } | undefined)?.error;
    record(
      level,
      'api',
      `${req.method} ${req.originalUrl} → ${status}${error ? `: ${error}` : ''}`,
      {
        method: req.method,
        path: req.originalUrl,
        status,
        request: req.method === 'GET' ? undefined : req.body,
        response: status >= 400 || activity ? responseBody : undefined,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        aborted: !res.writableFinished,
      },
      { activityId: activity?.id ?? null, durationMs: Date.now() - started }
    );
    // Streams (move / undo / update) finish their activity from the pipeline's own outcome
    if (activity && !isStream) {
      if (status >= 400) finishActivity(activity.id, 'failed', { message: error || `Request failed with HTTP ${status}` });
      else finishActivity(activity.id, 'succeeded');
    }
  };
  res.on('finish', onDone);
  res.on('close', onDone);

  if (activity) runInActivity(activity.id, next);
  else next();
}

// ----------------------------------------------------------------------------
// Exports
// ----------------------------------------------------------------------------

/** Container events from the same time window (they aren't part of the activity itself). */
async function eventsAround(a: Activity): Promise<LogEvent[]> {
  const since = new Date(new Date(a.startedAt).getTime() - 10 * 1000).toISOString();
  const until = new Date(new Date(a.endedAt || Date.now()).getTime() + 60 * 1000).toISOString();
  const { events } = await queryEvents({ categories: ['container', 'system'], since, until, limit: 500 });
  return events.filter((e) => !e.act).reverse();
}

export async function activityBundle(id: string) {
  const activity = getActivity(id);
  if (!activity) return null;
  const [events, containerEventsAround, environment] = await Promise.all([activityEvents(id), eventsAround(activity), environmentSnapshot()]);
  return {
    format: 'manifexus.activity-bundle.v1',
    exportedAt: new Date().toISOString(),
    activity,
    events,
    containerEventsAround,
    environment,
  };
}

const fmtDur = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);

function fence(text: string, lang = ''): string {
  const t = text.replace(/\s+$/, '');
  const ticks = t.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${t}\n${ticks}`;
}

/** A Markdown report designed to be pasted into an AI assistant (or a bug report) as-is. */
export async function activityMarkdown(id: string): Promise<string | null> {
  const b = await activityBundle(id);
  if (!b) return null;
  const a = b.activity;
  const t0 = new Date(a.startedAt).getTime();
  const rel = (ts: string) => `+${((new Date(ts).getTime() - t0) / 1000).toFixed(3)}s`;
  const L: string[] = [];
  L.push(`# Manifexus diagnostic report: ${a.title}`);
  L.push('');
  L.push(`- **Status:** ${a.status}${a.durationMs !== undefined ? ` after ${fmtDur(a.durationMs)}` : ''}`);
  L.push(`- **Started:** ${a.startedAt} (${a.actor?.kind === 'system' ? 'automatic' : `by ${a.actor?.ip || 'user'}${a.actor?.userAgent ? `, ${a.actor.userAgent}` : ''}`})`);
  L.push(`- **Activity ID:** ${a.id} · type \`${a.type}\` · ${plural(a.counts.events, 'event')}, ${plural(a.counts.warnings, 'warning')}, ${plural(a.counts.errors, 'error')}`);
  const env = b.environment as Record<string, Record<string, unknown>>;
  L.push(`- **Manifexus:** ${env.manifexus?.build} (${env.manifexus?.installMode}), image ${env.manifexus?.image}`);
  L.push(`- **Docker:** ${env.docker?.version} on ${env.docker?.os}, kernel ${env.docker?.kernel}, ${env.docker?.arch}`);
  L.push('');
  if (a.error) {
    L.push('## What went wrong');
    L.push('');
    L.push(a.error.message);
    if (a.error.detail) L.push('', fence(a.error.detail));
    if (a.error.stack) L.push('', fence(a.error.stack));
    L.push('');
  }
  const failures = b.events.filter((e) => e.level === 'error' || e.level === 'warn');
  if (failures.length) {
    L.push('## Warnings and errors');
    L.push('');
    for (const e of failures) {
      L.push(`### ${rel(e.ts)} ${e.level.toUpperCase()} [${e.cat}] ${e.msg}`);
      const d = e.data as Record<string, unknown> | undefined;
      if (d?.output) L.push('', 'Output:', fence(String(d.output)));
      if (d?.response && typeof d.response === 'object') L.push('', 'Response:', fence(JSON.stringify(d.response, null, 2), 'json'));
      else if (d?.response) L.push('', 'Response:', fence(String(d.response)));
      if (d?.error && typeof d.error !== 'string') L.push('', fence(JSON.stringify(d.error, null, 2), 'json'));
      if (d?.script) L.push('', 'Script:', fence(String(d.script), 'sh'));
      L.push('');
    }
  }
  const steps = b.events.filter((e) => e.cat === 'step' && /^Step \d+:.* — /.test(e.msg));
  if (steps.length) {
    L.push('## Steps');
    L.push('');
    for (const s of steps) L.push(`- ${s.msg}${s.durationMs !== undefined ? ` (${fmtDur(s.durationMs)})` : ''}`);
    L.push('');
  }
  const files = b.events.filter((e) => e.cat === 'file' && (e.data as { content?: string })?.content && e.level !== 'trace');
  if (files.length) {
    L.push('## Files written');
    L.push('');
    for (const f of files) {
      const d = f.data as { path?: string; content?: string };
      L.push(`### ${d.path} (${rel(f.ts)})`, '', fence(String(d.content), d.path?.match(/ya?ml$/) ? 'yaml' : ''), '');
    }
  }
  const helpers = b.events.filter((e) => ['helper', 'compose', 'backup'].includes(e.cat) && e.level !== 'warn');
  if (helpers.length) {
    L.push('## Commands run on the host');
    L.push('');
    for (const h of helpers) {
      const d = h.data as { script?: string; output?: string; binds?: string[] };
      L.push(`### ${rel(h.ts)} ${h.msg}${h.durationMs !== undefined ? ` (${fmtDur(h.durationMs)})` : ''}`);
      if (d?.binds?.length) L.push('', `Mounts: ${d.binds.join(', ')}`);
      if (d?.output?.trim()) L.push('', fence(d.output));
      L.push('');
    }
  }
  if (a.input !== undefined) {
    L.push('## Request', '', fence(JSON.stringify(a.input, null, 2), 'json'), '');
  }
  L.push('## Full timeline', '');
  for (const e of b.events) {
    L.push(`${rel(e.ts)} ${e.level.padEnd(5)} ${e.cat.padEnd(9)} ${e.msg}${e.durationMs !== undefined ? ` (${fmtDur(e.durationMs)})` : ''}`);
  }
  L.push('');
  if (b.containerEventsAround.length) {
    L.push('## Container events around this time', '');
    for (const e of b.containerEventsAround) L.push(`${e.ts} ${e.level.padEnd(5)} ${e.msg}`);
    L.push('');
  }
  L.push('## Environment', '', fence(JSON.stringify(b.environment, null, 2), 'json'), '');

  // Every non-trace event with its data (capped per event). Trace-level reads (container
  // inspections, file reads) are listed in the timeline; the JSON export has them in full.
  const detailed = b.events.filter((e) => e.level !== 'trace' && e.data !== undefined);
  if (detailed.length) {
    L.push('## Details', '');
    for (const e of detailed) {
      let json = JSON.stringify(e.data, null, 1);
      if (json.length > 6000) json = `${json.slice(0, 6000)}\n… [${json.length - 6000} more characters in the JSON export]`;
      L.push(`### ${rel(e.ts)} ${e.level} [${e.cat}] ${e.msg}`, '', fence(json, 'json'), '');
    }
  }
  const traced = b.events.length - b.events.filter((e) => e.level !== 'trace').length;
  L.push(`_${b.events.length} events in this activity (${traced} low-level reads shown in the timeline only). Export as JSON for every field of every event._`);
  return L.join('\n');
}

export function eventsToCsv(events: LogEvent[]): string {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['time', 'level', 'category', 'message', 'activity', 'duration_ms', 'data'].join(',')];
  for (const e of events) rows.push([e.ts, e.level, e.cat, e.msg, e.act || '', e.durationMs ?? '', e.data].map(esc).join(','));
  return rows.join('\n');
}

/** Boot record: what Manifexus is and where it runs, so every later event has context. */
export async function recordStartup() {
  const env = await environmentSnapshot(true);
  record('info', 'system', `Manifexus started (${(env.manifexus as { build?: string }).build})`, env, { activityId: null });
}
