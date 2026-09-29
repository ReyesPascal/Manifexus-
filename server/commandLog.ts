/**
 * Learn how it was done: turns what an activity recorded (Docker calls, commands run on the server,
 * files written) into the commands a person would type to do the same thing, grouped by step, each
 * with a plain explanation of every part. Commands Manifexus really ran are shown as they ran;
 * things it did by talking to Docker directly are shown as the equivalent command.
 */
import { activityEvents, getActivity, listActivities, queryEvents, LogEvent } from './activityLog';

export interface Explain {
  part: string;
  meaning: string;
}

export interface LearnCommand {
  /** Plain words: "Stopped lidarr" */
  title: string;
  command: string;
  /** Manifexus did this through Docker directly; this command does the same thing */
  equivalent: boolean;
  explain: Explain[];
  ok: boolean;
  ts: string;
  /** What it printed (real commands only, trimmed) */
  output?: string;
}

export interface LearnStep {
  index: number;
  name: string;
  status: 'running' | 'success' | 'failed' | 'pending';
  commands: LearnCommand[];
}

// ----------------------------------------------------------------------------
// Explanations
// ----------------------------------------------------------------------------

/** Split a shell command into words, keeping quoted parts together */
function words(cmd: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const DOCKER_SUB: Record<string, string> = {
  start: 'start a stopped app',
  stop: 'stop a running app (it asks the app to shut down cleanly first)',
  restart: 'stop the app, then start it again',
  rm: 'remove the app’s container (its settings file and data folders stay)',
  rename: 'give the container a new name',
  pull: 'download a newer copy of the app’s image',
  logs: 'show what the app has printed',
  ps: 'list containers',
  inspect: 'show every detail Docker knows about it',
  run: 'create a new container from an image and start it',
  pause: 'freeze the app',
  unpause: 'unfreeze the app',
  kill: 'stop the app immediately',
};

const COMPOSE_SUB: Record<string, string> = {
  up: 'create and start the apps in the stack’s file (only the ones that aren’t already running as described)',
  down: 'stop and remove the stack’s apps (data folders are kept)',
  pull: 'download newer images for the stack’s apps',
  restart: 'restart the stack’s apps',
  ps: 'list the stack’s apps',
  config: 'check the stack’s file and show it fully expanded',
  logs: 'show what the stack’s apps have printed',
};

const FLAGS: Record<string, string> = {
  '-d': 'in the background, so the command returns right away',
  '--detach': 'in the background, so the command returns right away',
  '--remove-orphans': 'also remove apps that are no longer in the file',
  '-v': 'also delete the stack’s volumes (its data!)',
  '-f': 'force it, without asking',
  '--force': 'force it, without asking',
  '--force-recreate': 'recreate the apps even if nothing changed',
  '-t': 'how many seconds to wait for a clean shutdown',
  '--name': 'the name to give it',
  '-p': 'keep file owners and permissions',
  '-R': 'for everything inside the folder too',
};

export function explain(cmd: string): Explain[] {
  const out: Explain[] = [];
  for (const part of cmd.split(/\s*&&\s*/)) {
    const w = words(part);
    if (!w.length) continue;
    const [c, ...rest] = w;
    if (c === 'cd') out.push({ part: `cd ${rest[0] || ''}`, meaning: 'go into this folder first (where the stack’s file is)' });
    else if (c === 'docker' && rest[0] === 'compose') {
      out.push({ part: 'docker compose', meaning: 'work with the stack described by docker-compose.yml in this folder' });
      const sub = rest[1];
      if (sub) out.push({ part: sub, meaning: COMPOSE_SUB[sub] || sub });
      for (const a of rest.slice(2)) {
        if (FLAGS[a]) out.push({ part: a, meaning: FLAGS[a] });
        else if (!a.startsWith('-')) out.push({ part: a, meaning: 'only this app from the file' });
      }
    } else if (c === 'docker') {
      const sub = rest[0];
      out.push({ part: `docker ${sub || ''}`.trim(), meaning: DOCKER_SUB[sub] || 'a Docker command' });
      for (const a of rest.slice(1)) if (FLAGS[a]) out.push({ part: a, meaning: FLAGS[a] });
      if (sub === 'volume' && rest[1] === 'rm') out.push({ part: 'volume rm', meaning: 'delete a volume and everything stored in it' });
    } else if (c === 'tar') {
      const mode = rest.find((a) => a.startsWith('-')) || '';
      const extract = mode.includes('x');
      out.push({ part: 'tar', meaning: extract ? 'unpack an archive' : 'pack files into one archive' });
      if (mode) {
        const letters: Record<string, string> = { c: 'create', x: 'extract', z: 'gzip-compressed', p: 'keep owners and permissions', f: 'this archive file', v: 'list each file' };
        out.push({ part: mode, meaning: mode.replace(/-/g, '').split('').map((l) => letters[l]).filter(Boolean).join(', ') });
      }
      const i = rest.indexOf('-C');
      if (i >= 0) out.push({ part: `-C ${rest[i + 1]}`, meaning: extract ? 'unpack into this folder' : 'take the files from this folder' });
    } else if (c === 'nano') out.push({ part: `nano ${rest[0] || ''}`, meaning: 'open the file in a simple text editor (Ctrl+O then Enter saves, Ctrl+X exits)' });
    else if (c === 'cp') out.push({ part: 'cp', meaning: 'copy a file (here: keep a backup before changing it)' });
    else if (c === 'mkdir') out.push({ part: 'mkdir -p', meaning: 'create the folder (and any missing folders above it)' });
    else if (c === 'rm') out.push({ part: 'rm -rf', meaning: 'delete the folder and everything in it' });
    else if (c === 'chown') out.push({ part: `chown ${rest.filter((a) => !a.startsWith('-'))[0] || ''}`, meaning: 'change who owns the files (user:group), so the app can write to them' });
    else if (c === 'chmod') out.push({ part: 'chmod', meaning: 'change who may read or write the files' });
    else if (c === 'test' || c === '[') out.push({ part: c, meaning: 'check whether something exists' });
    else if (c === 'sudo') out.push({ part: 'sudo', meaning: 'run as the administrator (it may ask for your password)' });
    else out.push({ part: c, meaning: 'a command on your server' });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Translating recorded events
// ----------------------------------------------------------------------------

const q = (s: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Container names, learned from the activity itself (ids change names as moves rename them) */
class Names {
  private m = new Map<string, string>();
  helpers = new Set<string>();
  set(id: string, name: string) {
    if (id && name) this.m.set(id.slice(0, 12), name.replace(/^\//, ''));
  }
  get(ref: string): string {
    const r = decodeURIComponent(ref);
    return this.m.get(r.slice(0, 12)) || (/^[0-9a-f]{12,64}$/.test(r) ? r.slice(0, 12) : r);
  }
  isHelper(ref: string) {
    return this.helpers.has(decodeURIComponent(ref).slice(0, 12));
  }
}

/** Helper scripts run in a container with host folders mounted; put the host paths back */
function hostScript(script: string, binds: string[] = []): string {
  let s = script;
  const pairs = binds.map((b) => b.split(':')).filter((p) => p.length >= 2).sort((a, b) => b[1].length - a[1].length);
  for (const [host, inside] of pairs) {
    if (inside === '/' || !inside) continue;
    s = s.split(`${inside}/`).join(`${host}/`).replace(new RegExp(`${inside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=['"\\s;)]|$)`, 'g'), host);
  }
  return s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromHelper(ev: LogEvent, d: any): LearnCommand | null {
  const purpose: string = d.purpose || '';
  const script: string = d.script || '';
  const ok = d.exitCode === 0 && !d.timedOut;
  const output = typeof d.output === 'string' && d.output.trim() ? d.output.trim().slice(-800) : undefined;
  const base = { ok, ts: ev.ts, output };
  // docker compose … in a folder
  // The real command sits after the "is compose installed?" check: `then docker compose up -d …;`
  const compose = /then docker compose ([^;]+?);/.exec(script) || /(?:^|;\s*)docker compose (?!version)([^;]+?)(?:;|$)/.exec(script);
  const dir = /^cd '([^']+)'/.exec(script)?.[1] || /in (\/\S+)$/.exec(purpose)?.[1];
  if (compose && dir) {
    const cmd = `cd ${q(dir)} && docker compose ${compose[1].trim()}`;
    const sub = compose[1].trim().split(/\s+/)[0];
    const stack = dir.split('/').filter(Boolean).pop();
    return { ...base, title: sub === 'up' ? `Started ${stack}` : sub === 'down' ? `Stopped and removed ${stack}’s apps` : `Ran docker compose ${sub} in ${stack}`, command: cmd, equivalent: false, explain: explain(cmd) };
  }
  // Commands run straight on the server
  const host = /^nsenter .*? -- sh -c (.+)$/.exec(script);
  if (host) {
    const w = words(host[1]);
    const cmd = w[0] || host[1];
    return { ...base, title: 'Ran a command on the server', command: cmd, equivalent: false, explain: explain(cmd) };
  }
  // Backups and restores of folders (tar)
  if (/\btar\b/.test(script) && /back up|restore|copy|extract/i.test(purpose)) {
    const t = /(tar [^;]+)/.exec(hostScript(script, d.binds))?.[1] || '';
    const cmd = t.replace(/--warning=\S+\s*/g, '').replace(/\s+/g, ' ').trim();
    return { ...base, title: purpose.replace(/^./, (c) => c.toUpperCase()), command: cmd, equivalent: false, explain: explain(cmd) };
  }
  // Reads and checks aren't changes, and file writes are shown from the file record itself
  if (/^(Check|Read|List|Look|Probe|Write |Create folder|Delete folder)/i.test(purpose) || d.probe) return null;
  const cmd = hostScript(script, d.binds).replace(/\s+/g, ' ').trim();
  if (!cmd || cmd.length > 400) return null;
  return { ...base, title: purpose || 'Ran a command on the server', command: cmd, equivalent: false, explain: explain(cmd) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromDocker(ev: LogEvent, d: any, names: Names): LearnCommand | null {
  const method: string = d.method;
  const p: string = d.path || '';
  const ok = typeof d.status === 'number' && d.status < 400;
  const base = { ok, ts: ev.ts, equivalent: true };
  // Learn names as we go
  if (method === 'GET' && /^\/containers\/[^/]+\/json/.test(p)) {
    const id = p.split('/')[2];
    const name = typeof d.response === 'object' ? d.response?.Name : /"Name":"\/?([^"]+)"/.exec(String(d.response || ''))?.[1];
    if (name) names.set(id, name);
    return null;
  }
  if (method === 'GET' && p.startsWith('/containers/json') && Array.isArray(d.response)) {
    for (const c of d.response) if (c?.Id && c?.Names?.[0]) names.set(c.Id, c.Names[0]);
    return null;
  }
  if (method === 'GET' || method === 'HEAD') return null;
  if (method === 'POST' && p.startsWith('/containers/create')) {
    const helper = d.request?.Labels?.['dev.manifexus.helper'] === 'true';
    const id = d.response?.Id;
    const name = /[?&]name=([^&]+)/.exec(p)?.[1];
    if (helper && id) names.helpers.add(String(id).slice(0, 12));
    if (helper) return null;
    if (id && name) names.set(id, decodeURIComponent(name));
    const image = d.request?.Image || 'IMAGE';
    const cmd = `docker run -d --name ${q(decodeURIComponent(name || 'NAME'))} … ${image}`;
    return { ...base, title: `Created ${decodeURIComponent(name || 'a container')} with its saved settings`, command: cmd, explain: [{ part: 'docker run -d', meaning: 'create a container and start it in the background' }, { part: '…', meaning: 'plus its saved ports, folders and settings' }] };
  }
  const m = /^\/containers\/([^/?]+)(?:\/([a-z]+))?/.exec(p);
  if (m) {
    const [, ref, action] = m;
    if (names.isHelper(ref)) return null;
    const name = names.get(ref);
    if (method === 'DELETE' && !action) {
      const cmd = `docker rm -f ${q(name)}`;
      return { ...base, title: `Removed ${name}’s container`, command: cmd, explain: explain(cmd) };
    }
    if (method === 'POST' && action === 'rename') {
      const to = decodeURIComponent(/[?&]name=([^&]+)/.exec(p)?.[1] || '');
      const cmd = `docker rename ${q(name)} ${q(to)}`;
      names.set(ref, to);
      return { ...base, title: to.includes('__moving') ? `Set ${name} aside while moving` : `Renamed ${name} to ${to}`, command: cmd, explain: explain(cmd) };
    }
    if (method === 'POST' && action && ['start', 'stop', 'restart', 'kill', 'pause', 'unpause'].includes(action)) {
      const t = /[?&]t=(\d+)/.exec(p)?.[1];
      const cmd = `docker ${action}${t && action !== 'start' ? ` -t ${t}` : ''} ${q(name)}`;
      const past: Record<string, string> = { start: 'Started', stop: 'Stopped', restart: 'Restarted', kill: 'Force-stopped', pause: 'Paused', unpause: 'Unpaused' };
      return { ...base, title: `${past[action]} ${name}`, command: cmd, explain: explain(cmd) };
    }
    return null;
  }
  if (method === 'POST' && p.startsWith('/images/create')) {
    const img = decodeURIComponent(/fromImage=([^&]+)/.exec(p)?.[1] || '');
    const tag = decodeURIComponent(/tag=([^&]+)/.exec(p)?.[1] || '');
    const cmd = `docker pull ${img}${tag ? `:${tag}` : ''}`;
    return { ...base, title: `Downloaded ${img}`, command: cmd, explain: explain(cmd) };
  }
  if (method === 'DELETE' && p.startsWith('/volumes/')) {
    const v = decodeURIComponent(p.split('/')[2].split('?')[0]);
    const cmd = `docker volume rm ${q(v)}`;
    return { ...base, title: `Deleted volume ${v}`, command: cmd, explain: explain(cmd) };
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromFile(ev: LogEvent, d: any): LearnCommand | null {
  if (!/^Wrote |^Deleted folder|^Folder ready/.test(ev.msg)) return null;
  const p: string = d.path || /(?:Wrote|folder) (\/\S+)/.exec(ev.msg)?.[1] || '';
  if (!p) return null;
  const ok = d.ok !== false;
  if (ev.msg.startsWith('Deleted folder')) {
    const cmd = `rm -rf ${q(p)}`;
    return { title: `Deleted the folder ${p}`, command: cmd, equivalent: true, explain: explain(cmd), ok, ts: ev.ts };
  }
  if (ev.msg.startsWith('Folder ready')) {
    const cmd = `mkdir -p ${q(p)}`;
    return { title: `Made sure ${p} exists`, command: cmd, equivalent: true, explain: explain(cmd), ok, ts: ev.ts };
  }
  const cmd = `nano ${q(p)}`;
  return { title: `Saved a new version of ${p.split('/').pop()}`, command: cmd, equivalent: true, explain: [...explain(cmd), { part: '', meaning: 'Manifexus wrote the whole file at once; by hand you’d make the same edits and save.' }].filter((e) => e.part || e.meaning), ok, ts: ev.ts };
}

/** An activity as steps, each with the commands behind it */
export async function learnActivity(id: string): Promise<{ steps: LearnStep[]; loose: LearnCommand[] } | null> {
  if (!getActivity(id)) return null;
  return learnFromEvents(await activityEvents(id));
}

function learnFromEvents(list: LogEvent[]): { steps: LearnStep[]; loose: LearnCommand[] } {
  const events = list.slice().sort((a, b) => (a.ts === b.ts ? a.seq - b.seq : a.ts < b.ts ? -1 : 1));
  const names = new Names();
  const steps = new Map<number, LearnStep>();
  const loose: LearnCommand[] = [];
  let current: number | undefined;
  for (const ev of events) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = ev.data || {};
    if (ev.cat === 'step' && typeof d.step === 'number' && d.status) {
      const name = ev.msg.replace(/^Step \d+:\s*/, '').replace(/\s+—\s+\w+$/, '');
      const s = steps.get(d.step) || { index: d.step, name, status: 'pending', commands: [] };
      s.status = d.status === 'started' ? 'running' : d.status === 'success' ? 'success' : d.status === 'failed' ? 'failed' : s.status;
      steps.set(d.step, s);
      current = d.status === 'started' ? d.step : current;
      continue;
    }
    let c: LearnCommand | null = null;
    if (ev.cat === 'docker') c = fromDocker(ev, d, names);
    else if (ev.cat === 'helper' || ev.cat === 'compose' || ev.cat === 'backup') c = fromHelper(ev, d);
    else if (ev.cat === 'file') c = fromFile(ev, d);
    if (!c) continue;
    const target = current !== undefined ? steps.get(current) : undefined;
    if (target) target.commands.push(c);
    else loose.push(c);
  }
  return { steps: Array.from(steps.values()).sort((a, b) => a.index - b.index), loose };
}

const LEARN_CATS: LogEvent['cat'][] = ['step', 'docker', 'helper', 'compose', 'backup', 'file'];

/** Every command behind recent activities, newest first (one pass over the log, grouped by activity) */
export async function recentCommands(limit = 150): Promise<{ activityId: string; activityTitle: string; status: string; command: LearnCommand }[]> {
  const out: { activityId: string; activityTitle: string; status: string; command: LearnCommand }[] = [];
  const acts = listActivities({ limit: 60 }).activities.filter((a) => a.type !== 'settings' && a.type !== 'plan');
  if (!acts.length) return out;
  const since = new Date(new Date(acts[acts.length - 1].startedAt).getTime() - 1000).toISOString();
  const { events } = await queryEvents({ categories: LEARN_CATS, since, limit: 200000 });
  const byAct = new Map<string, LogEvent[]>();
  for (const e of events) {
    if (!e.act) continue;
    if (!byAct.has(e.act)) byAct.set(e.act, []);
    byAct.get(e.act)!.push(e);
  }
  for (const a of acts) {
    const evs = byAct.get(a.id);
    if (!evs) continue;
    const l = learnFromEvents(evs);
    const cmds = [...l.steps.flatMap((s) => s.commands), ...l.loose];
    for (const c of cmds.reverse()) out.push({ activityId: a.id, activityTitle: a.title, status: a.status, command: c });
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}
