/**
 * Ask Manifexus: the built-in AI as an assistant that can look at everything Manifexus can see
 * (apps, stacks, files, logs, Activity, Restore, Diagnostics, the server's specs) and propose
 * changes. It never changes anything by itself: changes come back as a plan the person reviews,
 * and running a plan takes a backup first, saves it in Restore and records it in Activity.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { getContainersList, executeContainerAction, queryDockerEngine } from './dockerService';
import { readHostFile, writeHostFile, forceRemoveContainer } from './hostFsService';
import { runComposeCapture, composeErrorTail, runHostCommand, runHelperScript, formatBytes } from './dataBackupService';
import { appDiagnostics, appLogs, systemDiagnostics } from './diagnosticsService';
import { listActivities, redactText, record, currentActivityId } from './activityLog';
import { listRestorePoints } from './restoreService';
import { getRegisteredCreatedStacks } from './stackService';
import { resolveBackupDir, saveMergeHistoryRecord, MergeHistoryRecord } from './historyService';
import { getSystemSpecs } from './systemSpecs';
import { getAiSettings, modelFor, ollama, ollamaStream, catalogModel, Freedom, NUM_CTX, speedOf, recordSpeed, EngineStats, fitsNow, AiAccess, AiSettings, setupInProgress } from './aiService';
import { planRoute, thinkFor, thinkLabel, taskLabel, effortLabel, Think } from './aiRouter';
import type { DeepContainerMetadata } from '../src/types';
import { explain, Explain } from './commandLog';
import { compactLogs, fileExcerpt } from './aiDigest';

const sq = (s: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The commands a person would type for a step (Do It Myself, and Show Commands in the review) */
async function howToFor(a: PlanAction): Promise<PlanStep['howTo']> {
  const one = (command: string, note?: string, equivalent = true) => ({ command, note, equivalent, explain: explain(command) });
  if (a.type === 'restart' || a.type === 'start' || a.type === 'stop') {
    const c = await findApp(a.app || '');
    return [one(`docker ${a.type} ${sq(c?.name.replace(/^\//, '') || a.app || '')}`)];
  }
  if (a.type === 'remove_container') {
    const c = await findApp(a.app || '');
    return [one(`docker rm -f ${sq(c?.name.replace(/^\//, '') || a.app || '')}`, 'Removes the container only. Its folders and volumes stay.')];
  }
  if (a.type === 'compose_up') {
    const st = await findStack(a.stack || '');
    return [one(`cd ${sq(st?.dir || a.stack || '')} && docker compose up -d${a.services?.length ? ` ${a.services.join(' ')}` : ''}`, undefined, false)];
  }
  if (a.type === 'write_file' && a.path) {
    return [
      one(`cp ${sq(a.path)} ${sq(`${a.path}.backup`)}`, 'First keep a copy, so you can go back if something goes wrong.'),
      one(`nano ${sq(a.path)}`, 'Make the changes shown below: delete the red lines, add the green ones, keep everything else the same. Save with Ctrl+O then Enter, and exit with Ctrl+X.'),
    ];
  }
  if (a.type === 'run_command' && a.command) return [one(a.command, undefined, false)];
  return [];
}

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

const clip = (s: string, n = 6000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters cut)` : s);
const norm = (p?: string) => (p ? path.posix.normalize(p).replace(/\/+$/, '') : '');

async function apps(): Promise<DeepContainerMetadata[]> {
  return (await getContainersList()).containers.filter((c) => !c.isHidden);
}

async function findApp(name: string): Promise<DeepContainerMetadata | undefined> {
  const n = String(name || '').trim().replace(/^\//, '').toLowerCase();
  const list = await apps();
  return (
    list.find((c) => c.cleanName.toLowerCase() === n || c.name.replace(/^\//, '').toLowerCase() === n || c.id.startsWith(n)) ||
    list.find((c) => (c.compose?.service || '').toLowerCase() === n) ||
    list.find((c) => (c.customName || '').toLowerCase() === n)
  );
}

interface StackRef {
  project: string;
  dir: string;
  file: string;
}

async function stacks(): Promise<StackRef[]> {
  const m = new Map<string, StackRef>();
  for (const c of await apps()) {
    if (!c.compose?.project || !c.compose.workingDir) continue;
    const file = (c.compose.configFiles || '').split(',')[0]?.trim() || path.posix.join(c.compose.workingDir, 'docker-compose.yml');
    if (!m.has(c.compose.project)) m.set(c.compose.project, { project: c.compose.project, dir: c.compose.workingDir, file });
  }
  for (const s of getRegisteredCreatedStacks()) {
    if (!m.has(s.project)) m.set(s.project, { project: s.project, dir: s.workingDir, file: String(s.configFiles || '').split(',')[0] || path.posix.join(s.workingDir, 'docker-compose.yml') });
  }
  return Array.from(m.values());
}

async function findStack(name: string): Promise<StackRef | undefined> {
  const n = String(name || '').trim().toLowerCase();
  const all = await stacks();
  return all.find((s) => s.project.toLowerCase() === n) || all.find((s) => norm(s.dir) === norm(name));
}

/** The stack whose compose or .env file this is, if any */
async function stackOfFile(file: string): Promise<StackRef | undefined> {
  const dir = norm(path.posix.dirname(file));
  const base = path.posix.basename(file);
  if (!/^(docker-)?compose\.ya?ml$|^\.env$/.test(base)) return undefined;
  return (await stacks()).find((s) => norm(s.dir) === dir);
}

/** A simple line diff for showing file changes: lines prefixed with "+ ", "- " or "  " */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) return [...a.map((l) => `- ${l}`), ...b.map((l) => `+ ${l}`)];
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out;
}

/**
 * Swap each ••••••-masked line for the original line with the same key (KEY=…, key: …, - KEY=…).
 * Returns null when a masked line has no match, so a secret is never overwritten with dots.
 */
export function restoreSecrets(before: string, after: string): string | null {
  const keyOf = (line: string) => /^\s*(-\s*)?["']?([A-Za-z0-9_.-]+)["']?\s*[=:]/.exec(line)?.[2];
  const originals = new Map<string, string[]>();
  for (const line of before.split('\n')) {
    const k = keyOf(line);
    if (k) originals.set(k, [...(originals.get(k) || []), line]);
  }
  const out: string[] = [];
  for (const line of after.split('\n')) {
    if (!line.includes('••••••')) {
      out.push(line);
      continue;
    }
    const k = keyOf(line);
    const match = k ? originals.get(k)?.shift() : undefined;
    if (!match) return null;
    out.push(match);
  }
  return out.join('\n');
}

// ----------------------------------------------------------------------------
// Tools: everything the assistant can look at
// ----------------------------------------------------------------------------

type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolDef => ({
  type: 'function',
  // No empty "required" lists: every character of these is read before every answer
  function: { name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } },
});
const str = (description: string) => ({ type: 'string', description });

// Kept short: every word here is read by the AI before every answer
const READ_TOOLS: ToolDef[] = [
  tool('list_apps', 'Apps: stack, state, image, ports.'),
  tool('app_details', 'One app: health, exit code, restarts, memory/CPU, folders, settings, networks, events.', { app: str('App name') }, ['app']),
  tool('app_logs', 'An app’s recent output: errors, warnings and latest lines; repeats merged.', { app: str('App name') }, ['app']),
  tool('list_stacks', 'Stacks with folder and compose file.'),
  tool('read_file', 'Read a file on the server. Secrets hidden.', { path: str('Full path'), around: str('Optional: only the lines near this text') }, ['path']),
  tool('list_folder', 'Folder contents with owners and permissions.', { path: str('Full path') }, ['path']),
  tool('diagnostics', 'Manifexus health checks with problems.'),
  tool('activity', 'Recent changes and results.', { only_problems: { type: 'boolean', description: 'Only failures' } }),
  tool('restore_points', 'Backups that can be restored.'),
  tool('server_specs', 'CPU, memory, graphics, disk.'),
  tool('docker_overview', 'Networks, volumes, host ports in use.'),
];

/** Which lookups each kind of access allows (apps, stacks and Diagnostics are always allowed) */
const ACCESS_TOOLS: Record<keyof AiAccess, string[]> = {
  logs: ['app_logs'],
  files: ['read_file', 'list_folder'],
  history: ['activity', 'restore_points'],
  server: ['server_specs', 'docker_overview'],
};

export function allowedTool(name: string, access: AiAccess): boolean {
  for (const [k, names] of Object.entries(ACCESS_TOOLS)) if (names.includes(name)) return access[k as keyof AiAccess];
  return true;
}

function changeTool(freedom: Freedom, access: AiAccess): ToolDef {
  // Without seeing files it can't change them safely
  const types = ['restart', 'start', 'stop', ...(access.files ? ['edit_file', 'write_file'] : []), 'compose_up', 'remove_container', ...(freedom === 'expert' ? ['run_command'] : [])];
  return tool(
    'propose_changes',
    'Changes for the person to review; nothing happens until they approve. edit_file: replace exact text `find` with `replace`. write_file: whole new file. compose_up: (re)create a stack’s services. remove_container keeps volumes.' +
      (freedom === 'expert' ? ' run_command: one shell command, only if nothing else works.' : ''),
    {
      title: str('Short plain title'),
      explanation: str('Plain words: what is wrong and what this does'),
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: types },
            app: str('App'),
            stack: str('Stack'),
            services: { type: 'array', items: { type: 'string' }, description: 'Services; omit for all' },
            path: str('File path'),
            find: str('Exact current text, unique in the file'),
            replace: str('New text'),
            content: str('Whole new file'),
            command: str('Shell command'),
            reason: str('Why, in plain words'),
          },
          required: ['type', 'reason'],
        },
      },
    },
    ['title', 'explanation', 'actions']
  );
}

async function runTool(name: string, args: Record<string, unknown>): Promise<{ label: string; result: string }> {
  const a = (k: string) => String(args[k] ?? '').trim();
  switch (name) {
    case 'list_apps': {
      const list = await apps();
      return {
        label: 'Looked at your apps',
        result: list
          .map((c) => `${c.cleanName} · stack ${c.compose?.project || '(standalone)'} · ${c.state}${c.status ? ` (${c.status})` : ''} · ${c.image}${c.ports.filter((p) => p.publicPort).length ? ` · ports ${c.ports.filter((p) => p.publicPort).map((p) => `${p.publicPort}->${p.privatePort}/${p.type}`).join(', ')}` : ''}`)
          .join('\n'),
      };
    }
    case 'app_details': {
      const c = await findApp(a('app'));
      if (!c) return { label: `Looked for ${a('app')}`, result: `No app named "${a('app')}". Use list_apps.` };
      const d = await appDiagnostics(c.id);
      const env = c.envVars.map((e) => `${e.key}=${e.isSensitive ? '••••••' : e.value}`);
      return {
        label: `Checked ${c.cleanName}`,
        result: clip(
          [
            `Name: ${c.cleanName} (container ${c.name.replace(/^\//, '')}, id ${c.id.slice(0, 12)})`,
            `Stack: ${c.compose?.project || 'standalone'}${c.compose?.service ? `, service ${c.compose.service}` : ''}${c.compose?.configFiles ? `, file ${c.compose.configFiles}` : ''}`,
            `Image: ${c.image} · restart policy: ${c.restartPolicy || 'no'}`,
            `State: ${d.running ? 'running' : 'stopped'} · exit code ${d.exitCode} · restarts ${d.restartCount}`,
            `Checks: ${d.checks.map((k) => `[${k.level}] ${k.title}: ${k.detail}`).join(' | ')}`,
            d.resources ? `Memory: ${formatBytes(d.resources.memoryBytes || 0)} of ${formatBytes(d.resources.memoryLimitBytes || 0)} · CPU ${d.resources.cpuPercent}%` : '',
            `Folders: ${c.mounts.map((m) => `${m.source} -> ${m.destination} (${m.rw ? 'rw' : 'ro'}${m.type === 'volume' ? ', volume' : ''})`).join('; ') || 'none'}`,
            `Ports: ${c.ports.map((p) => `${p.publicPort || '-'}->${p.privatePort}/${p.type}`).join(', ') || 'none'}`,
            `Networks: ${c.networks.join(', ') || 'default'}`,
            `Settings: ${env.join(', ') || 'none'}`,
            `Recent events: ${d.recent.map((e) => `${e.ts} ${e.message}`).join(' | ') || 'none'}`,
          ]
            .filter(Boolean)
            .join('\n')
        ),
      };
    }
    case 'app_logs': {
      const c = await findApp(a('app'));
      if (!c) return { label: `Looked for ${a('app')}`, result: `No app named "${a('app')}".` };
      // Read plenty, then boil it down: errors, warnings and the latest lines, repeats merged
      const out = await appLogs(c.id, 400);
      return { label: `Read ${c.cleanName}’s logs`, result: out.text ? compactLogs(redactText(out.text), 3000) : out.error || '(no output)' };
    }
    case 'list_stacks': {
      const list = await stacks();
      return { label: 'Looked at your stacks', result: list.map((s) => `${s.project} · folder ${s.dir} · file ${s.file}`).join('\n') || 'No stacks.' };
    }
    case 'read_file': {
      const p = a('path');
      if (!p.startsWith('/')) return { label: 'Tried to read a file', result: 'Give a full path starting with /.' };
      const text = await readHostFile(p).catch(() => null);
      if (text === null) return { label: `Read ${p}`, result: `${p} doesn’t exist or can’t be read.` };
      // Only the part that matters, when it says what it's after (e.g. one setting in a long file)
      const part = fileExcerpt(redactText(text), a('around') ? a('around').split(/\s*,\s*/) : []);
      return { label: part.partial ? `Read the relevant part of ${p}` : `Read ${p}`, result: clip(part.text, 12000) };
    }
    case 'list_folder': {
      const p = a('path');
      if (!p.startsWith('/')) return { label: 'Tried to list a folder', result: 'Give a full path starting with /.' };
      // Mount the whole server read-only, so a missing folder isn't created by Docker
      const out = await runHelperScript(`ls -la --time-style=+%F ${JSON.stringify('/host' + p)} 2>&1 | head -200`, ['/:/host:ro'], `List ${p}`);
      return { label: `Looked in ${p}`, result: clip(out.output.replace(/\/host\//g, '/'), 6000) };
    }
    case 'diagnostics': {
      const d = await systemDiagnostics();
      // Only what needs attention; the rest is just counted
      const bad = d.checks.filter((c) => c.level !== 'ok');
      const good = d.checks.length - bad.length;
      return { label: 'Ran Diagnostics', result: [...bad.map((c) => `[${c.level}] ${c.title}: ${c.detail}`), `${good} other check${good === 1 ? '' : 's'} OK.`].join('\n') };
    }
    case 'activity': {
      const onlyProblems = Boolean(args.only_problems);
      // Its own questions to the AI aren't worth reading back
      const list = listActivities({ statuses: onlyProblems ? ['failed', 'rolled_back', 'interrupted'] : undefined, limit: 20 }).activities.filter((x) => x.type !== 'ask').slice(0, 10);
      return {
        label: onlyProblems ? 'Looked at recent problems' : 'Looked at recent activity',
        result:
          list
            .map((x) => {
              const err = x.error ? (typeof x.error === 'string' ? x.error : (x.error as { message?: string }).message || '') : '';
              return `${x.startedAt.slice(0, 16).replace('T', ' ')} · ${x.title} · ${x.status}${err ? ` · ${redactText(err).slice(0, 240)}` : ''}`;
            })
            .join('\n') || 'Nothing recorded.',
      };
    }
    case 'restore_points': {
      const pts = listRestorePoints().points.filter((p) => p.state === 'available').slice(0, 15);
      return { label: 'Looked at Restore', result: pts.map((p) => `${p.at} · ${p.title}${p.detail ? ` (${p.detail})` : ''} · stacks ${p.stacks.join(', ')}`).join('\n') || 'No backups.' };
    }
    case 'server_specs': {
      const s = await getSystemSpecs();
      return {
        label: 'Checked the server',
        result: `CPU: ${s.cpu.model}, ${s.cpu.cores} cores (${s.cpu.arch}) · Memory: ${formatBytes(s.memory.availableBytes)} free of ${formatBytes(s.memory.totalBytes)} · Graphics: ${s.gpus.map((g) => g.name).join(', ') || 'none'} · Disk: ${formatBytes(s.disk.freeBytes)} free of ${formatBytes(s.disk.totalBytes)} · ${s.os}`,
      };
    }
    case 'docker_overview': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [nets, vols] = await Promise.all([queryDockerEngine<any[]>('/networks').catch(() => []), queryDockerEngine<any>('/volumes').catch(() => ({}))]);
      const ports = (await apps()).flatMap((c) => c.ports.filter((p) => p.publicPort).map((p) => `${p.publicPort}/${p.type} → ${c.cleanName}`));
      return {
        label: 'Looked at Docker networks, volumes and ports',
        result: [`Networks: ${(nets || []).map((n: { Name: string }) => n.Name).join(', ')}`, `Volumes: ${((vols?.Volumes as { Name: string }[]) || []).map((v) => v.Name).join(', ') || 'none'}`, `Ports in use: ${ports.join(', ') || 'none'}`].join('\n'),
      };
    }
  }
  return { label: `Unknown tool ${name}`, result: `There is no tool named ${name}.` };
}

// ----------------------------------------------------------------------------
// Plans
// ----------------------------------------------------------------------------

export interface PlanAction {
  type: 'restart' | 'start' | 'stop' | 'edit_file' | 'write_file' | 'compose_up' | 'remove_container' | 'run_command';
  app?: string;
  stack?: string;
  services?: string[];
  path?: string;
  /** edit_file: the exact text to change and what it becomes (turned into write_file with the whole new file) */
  find?: string;
  replace?: string;
  content?: string;
  command?: string;
  reason: string;
}

export interface PlanStep {
  action: PlanAction;
  /** Plain description for the review, e.g. "Restart lidarr" */
  label: string;
  /** For file changes: the diff and whether the file is new */
  diff?: string[];
  newFile?: boolean;
  /** Can Restore undo this step? */
  undoable: boolean;
  /** What it interrupts, e.g. "lidarr stops for a few seconds" */
  impact?: string;
  /** How to do this step yourself, in your server's terminal */
  howTo?: { command: string; note?: string; equivalent?: boolean; explain: Explain[] }[];
}

export interface Plan {
  id: string;
  title: string;
  explanation: string;
  steps: PlanStep[];
  /** Everything here only starts or restarts apps (can run on its own at the "routine" level) */
  routine: boolean;
  createdAt: string;
  model: string;
}

const plans = new Map<string, Plan>();

async function buildPlan(args: { title?: string; explanation?: string; actions?: PlanAction[] }, freedom: Freedom, model: string): Promise<{ plan?: Plan; problem?: string }> {
  const actions = Array.isArray(args.actions) ? args.actions : [];
  if (!actions.length) return { problem: 'The plan has no actions.' };
  const steps: PlanStep[] = [];
  for (const act of actions) {
    if ((act.type === 'edit_file' || act.type === 'write_file') && !getAiSettings().access.files) return { problem: 'Changing files is off: the person hasn’t allowed looking at files. Use the other actions, or explain the change in words.' };
    // A small edit becomes the whole new file, so it's reviewed, backed up and run like any file change
    if (act.type === 'edit_file') {
      const edited = await applyEdit(act);
      if (typeof edited !== 'string') return edited;
      act.type = 'write_file';
      act.content = edited;
      delete act.find;
      delete act.replace;
    }
    const t = act.type;
    if (t === 'restart' || t === 'start' || t === 'stop' || t === 'remove_container') {
      const c = await findApp(act.app || '');
      if (!c) return { problem: `There is no app named "${act.app}". Use list_apps for exact names.` };
      act.app = c.cleanName;
      steps.push({
        action: act,
        label: t === 'remove_container' ? `Remove ${c.cleanName}’s container (its data and folders are kept)` : `${t[0].toUpperCase()}${t.slice(1)} ${c.cleanName}`,
        undoable: t === 'remove_container' ? Boolean(c.compose?.project) : true,
        impact: t === 'start' ? undefined : t === 'stop' ? `${c.cleanName} stays stopped` : `${c.cleanName} is unavailable for a few seconds`,
      });
    } else if (t === 'write_file') {
      const p = String(act.path || '');
      if (!p.startsWith('/')) return { problem: `write_file needs a full path; got "${p}".` };
      if (typeof act.content !== 'string') return { problem: 'write_file needs the complete new content.' };
      if (/\.json$/i.test(p)) {
        try {
          JSON.parse(act.content);
        } catch (e) {
          return { problem: `The new ${path.posix.basename(p)} isn’t valid JSON: ${(e as Error).message}. Fix it and propose again.` };
        }
      }
      if (/\.ya?ml$/.test(p)) {
        try {
          yaml.parse(act.content);
        } catch (e) {
          return { problem: `The new ${path.posix.basename(p)} isn’t valid YAML: ${(e as Error).message}. Fix it and propose again.` };
        }
      }
      const before = await readHostFile(p).catch(() => null);
      // The assistant only ever sees secrets as ••••••: put the real values back from the current file
      if (act.content.includes('••••••')) {
        const restored = restoreSecrets(before || '', act.content);
        if (restored === null) return { problem: `Some hidden values (••••••) in the new ${path.posix.basename(p)} don’t match a line in the current file. Keep those lines exactly as they were.` };
        act.content = restored;
      }
      // Keep the file's ending exactly as it was (models often drop the final newline)
      if (before !== null && before.endsWith('\n') && !act.content.endsWith('\n')) act.content += '\n';
      if (before !== null && before === act.content) return { problem: `${p} already has exactly that content.` };
      steps.push({
        action: act,
        label: before === null ? `Create ${p}` : `Edit ${p}`,
        diff: lineDiff(before || '', act.content).map((l) => (/(password|passwd|secret|token|api[_-]?key)\s*[=:]/i.test(l) ? l.replace(/([=:]\s*).+$/, '$1••••••') : l)),
        newFile: before === null,
        undoable: true,
      });
    } else if (t === 'compose_up') {
      const s = await findStack(act.stack || '');
      if (!s) return { problem: `There is no stack named "${act.stack}". Use list_stacks.` };
      act.stack = s.project;
      const svc = (act.services || []).filter((x) => /^[A-Za-z0-9._-]+$/.test(x));
      act.services = svc;
      steps.push({ action: act, label: `Start ${svc.length ? svc.join(', ') : 'everything'} in ${s.project} from its compose file`, undoable: true, impact: 'Apps whose settings changed are recreated (a few seconds each)' });
    } else if (t === 'run_command') {
      if (freedom !== 'expert') return { problem: 'Running commands is turned off. Use the other actions.' };
      if (!act.command?.trim()) return { problem: 'run_command needs a command.' };
      steps.push({ action: act, label: `Run on the server: ${act.command}`, undoable: false, impact: 'Commands can’t be undone by Restore' });
    } else {
      return { problem: `Unknown action "${t}".` };
    }
  }
  for (const st of steps) st.howTo = await howToFor(st.action);
  const plan: Plan = {
    id: `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    title: String(args.title || 'Proposed changes').slice(0, 120),
    explanation: String(args.explanation || '').slice(0, 2000),
    steps,
    routine: steps.every((s) => s.action.type === 'restart' || s.action.type === 'start'),
    createdAt: new Date().toISOString(),
    model,
  };
  plans.set(plan.id, plan);
  // Plans are short-lived: forget old ones
  for (const [id, p] of plans) if (Date.now() - new Date(p.createdAt).getTime() > 6 * 3600e3) plans.delete(id);
  return { plan };
}

export const getPlan = (id: string) => plans.get(id);

/** Apply an edit_file action to the current file: the new content, or why it can't be applied */
async function applyEdit(act: PlanAction): Promise<string | { problem: string }> {
  const p = String(act.path || '');
  if (!p.startsWith('/')) return { problem: `edit_file needs a full path; got "${p}".` };
  const find = typeof act.find === 'string' ? act.find : '';
  const replace = typeof act.replace === 'string' ? act.replace : '';
  if (!find) return { problem: 'edit_file needs the exact text to find.' };
  if (find.includes('••••••') || replace.includes('••••••')) return { problem: 'Hidden values (••••••) can’t be used in edit_file. Choose text next to them instead, or use write_file.' };
  const before = await readHostFile(p).catch(() => null);
  if (before === null) return { problem: `${p} doesn’t exist or can’t be read. Use write_file to create it.` };
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;
  let n = count(before, find);
  if (n === 1) return before.replace(find, () => replace);
  if (n > 1) return { problem: `The text to find appears ${n} times in ${p}. Include more of the lines around it so it’s unique.` };
  // Models often get spacing slightly wrong: match ignoring differences in spaces and line breaks
  const loose = new RegExp(find.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
  const matches = before.match(loose) || [];
  n = matches.length;
  // The match has no surrounding whitespace, so neither should the replacement if the find text had some
  if (n === 1) return before.replace(loose, () => (find.trim() !== find ? replace.trim() : replace));
  if (n > 1) return { problem: `The text to find appears ${n} times in ${p}. Include more of the lines around it so it’s unique.` };
  return { problem: `The text to find isn’t in ${p}. Read the file again and copy the text exactly.` };
}

// ----------------------------------------------------------------------------
// Chat
// ----------------------------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

type Emit = (e: Record<string, unknown>) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = any;

/**
 * The instructions never change between requests, so the engine can keep what it already read of
 * them (and of the tool list) in memory: on a CPU that saves the slowest part of every answer.
 * Everything that changes (the apps right now, what the person is looking at) goes in their message.
 */
function systemPrompt(freedom: Freedom, access?: AiAccess): string {
  const off = access ? (Object.keys(ACCESS_WORDS) as (keyof AiAccess)[]).filter((k) => !access[k]).map((k) => ACCESS_WORDS[k]) : [];
  return [
    'You are the assistant in Manifexus, a dashboard for the Docker apps on a home server. Look with your tools before answering; never guess names, paths or causes. Use what was already looked up; don’t fetch it again. Call tools without announcing them, several at once when you can.',
    freedom === 'look'
      ? 'You can only look and advise, not change anything.'
      : 'To change something, call propose_changes (the person reviews it; it is backed up and can be undone). For a small file change use edit_file. Smallest safe fix; never delete volumes or data folders.',
    'If unsure, say so and what you would check next.',
    off.length ? `The person has not allowed you to look at ${off.join(', ')}. If you need them, say what you would look at and that they can allow it in AI Settings.` : '',
    'Answer for someone who may never have used a terminal: first one sentence with the answer or cause, key point in **bold**; then only what helps (a short paragraph or numbered steps). Names, paths and values in `code`, commands and file contents in code blocks. Plain words, no filler, under 150 words unless asked.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function userTurn(question: string, snapshot: string, focus?: string): string {
  return [question, '---', `(From Manifexus, not typed by the person) Apps: ${snapshot}`, focus ? `They're looking at: ${focus}` : ''].filter(Boolean).join('\n');
}

/** The tools for a request: the change form (the longest part) only when it's a fix or a change */
const FIX_SKIPS = ['restore_points', 'server_specs'];
const toolsFor = (s: AiSettings, canChange = true) => {
  // Fixes rarely need the backup list or the server's specs; questions keep every lookup
  const read = READ_TOOLS.filter((t) => allowedTool(t.function.name, s.access) && !(canChange && FIX_SKIPS.includes(t.function.name)));
  return s.freedom === 'look' || !canChange ? read : [...read, changeTool(s.freedom, s.access)];
};

const ACCESS_WORDS: Record<keyof AiAccess, string> = { logs: 'app logs', files: 'files on the server', history: 'Activity and Restore', server: 'details of the server itself' };

async function snapshotText(list?: DeepContainerMetadata[]): Promise<string> {
  const all = list || (await apps().catch(() => []));
  if (!all.length) return '(no apps found)';
  // One line per stack; only apps that aren't running get their state spelled out
  const byStack = new Map<string, string[]>();
  for (const c of all.slice(0, 80)) {
    const k = c.compose?.project || 'standalone';
    byStack.set(k, [...(byStack.get(k) || []), c.state === 'running' ? c.cleanName : `${c.cleanName} (${c.state})`]);
  }
  const stopped = all.filter((c) => c.state !== 'running').length;
  return `${all.length} apps, ${stopped ? `${stopped} not running` : 'all running'}. ${Array.from(byStack, ([k, v]) => `${k}: ${v.join(', ')}`).join(' · ')}`;
}

/** What a tool is doing right now, for the progress line ("Reading sonarr’s logs…") */
function doingLabel(name: string, args: Record<string, unknown>): string {
  const a = (k: string) => String(args?.[k] ?? '').trim();
  switch (name) {
    case 'list_apps':
      return 'Looking at your apps…';
    case 'app_details':
      return a('app') ? `Checking ${a('app')}…` : 'Checking an app…';
    case 'app_logs':
      return a('app') ? `Reading ${a('app')}’s logs…` : 'Reading logs…';
    case 'list_stacks':
      return 'Looking at your stacks…';
    case 'read_file':
      return a('path') ? `Reading ${a('path')}…` : 'Reading a file…';
    case 'list_folder':
      return a('path') ? `Looking in ${a('path')}…` : 'Looking in a folder…';
    case 'diagnostics':
      return 'Running Diagnostics…';
    case 'activity':
      return 'Looking at recent activity…';
    case 'restore_points':
      return 'Looking at Restore…';
    case 'server_specs':
      return 'Checking the server…';
    case 'docker_overview':
      return 'Looking at Docker networks, volumes and ports…';
    default:
      return 'Looking…';
  }
}

/** Is the model already in memory? If not, the first answer waits for it to load */
async function modelLoaded(model: string): Promise<boolean> {
  try {
    const r = await ollama<{ models?: { name?: string; model?: string }[] }>('/api/ps', undefined, 'GET', 3000);
    return (r.models || []).some((m) => m.name === model || m.model === model || m.name === `${model}:latest`);
  } catch {
    return true;
  }
}

const nameOf = (id: string) => catalogModel(id)?.name || id;
const words = (tokens: number) => Math.max(1, Math.round(tokens * 0.75));
const wordsText = (tokens: number) => (words(tokens) === 1 ? '1 word' : `${words(tokens).toLocaleString('en-US')} words`);
const nice = (n: number) => n.toLocaleString('en-US');
const secsText = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.max(1, Math.round(s))} s`);

/** The progress the person sees: a timeline of steps, the live line under it, notes and the answer */
function makeUi(emit: Emit) {
  let n = 0;
  let lastNote = '';
  return {
    step(label: string, kind: 'plan' | 'lookup' | 'model' | 'check' | 'note', detail?: string) {
      const id = `s${++n}`;
      const t = Date.now();
      emit({ type: 'step', id, label, kind, status: 'running', detail });
      return {
        done: (l?: string, d?: string) => emit({ type: 'step', id, label: l || label, kind, status: 'done', detail: d ?? detail, ms: Date.now() - t }),
        fail: (l?: string, d?: string) => emit({ type: 'step', id, label: l || label, kind, status: 'failed', detail: d ?? detail, ms: Date.now() - t }),
      };
    },
    note: (text: string) => {
      if (text === lastNote) return;
      lastNote = text;
      emit({ type: 'step', id: `s${++n}`, label: text, kind: 'note', status: 'done' });
    },
    phase: (p: { label: string; detail?: string; progress?: number; eta?: number }) => emit({ type: 'phase', ...p }),
    answer: (text: string) => emit({ type: 'answer', text }),
  };
}
type Ui = ReturnType<typeof makeUi>;

/**
 * The last text the engine read (and wrote), so the next estimate knows how much is new to it: the
 * engine keeps what it read in memory and only reads from where the new conversation differs.
 */
let lastCall: { model: string; text: string; at: number } | undefined;
const promptText = (tools: ToolDef[] | undefined, convo: Msg[]) => `${tools ? JSON.stringify(tools) : ''}${JSON.stringify(convo).slice(0, -1)}`;
function sharedStart(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

interface RoundResult {
  text: string;
  thought: string;
  calls: Msg[];
  stats: EngineStats;
  cutShort: boolean;
}

/**
 * One AI round, with a live account of it: loading the model, reading (with a progress bar from its
 * measured speed on this server), thinking, writing. The answer is collected and shown all at once
 * when it's complete instead of trickling in word by word.
 */
async function runModel(o: { model: string; convo: Msg[]; tools?: ToolDef[]; think: Think; maxTokens: number; purpose: string }, ui: Ui, signal?: AbortSignal): Promise<RoundResult> {
  const specs = await getSystemSpecs();
  const sp = speedOf(o.model, specs);
  const name = nameOf(o.model);
  const text0 = promptText(o.tools, o.convo);
  const promptChars = text0.length;
  const loaded = await modelLoaded(o.model);
  const remembered = loaded && lastCall && lastCall.model === o.model && Date.now() - lastCall.at < 4.5 * 60e3 && !sp.noPrefixCache ? sharedStart(lastCall.text, text0) : 0;
  const continuing = remembered > 1000;
  const newChars = continuing ? promptChars - remembered : promptChars;
  const readTokens = Math.max(1, newChars / (sp.charsPerToken || 3.6));
  const loadSecs = loaded ? 0 : sp.loadSecs || 8;
  const readSecs = readTokens / sp.prefill;
  // Writing counts too: what this model usually writes in a round here (a lookup request, a change,
  // or an answer), which it only hands over once complete. Thinking adds its thoughts.
  const writeTokens = o.think ? sp.outThinking || 350 : sp.out || 90;
  const writeSecs = writeTokens / sp.gen;
  const step = ui.step(`${name} · ${thinkLabel(o.think)}`, 'model', o.purpose);

  const t0 = Date.now();
  let first = 0;
  let last = 0;
  let text = '';
  let thought = '';
  let calls: Msg[] = [];
  let stats: EngineStats = {};
  let cutShort = false;
  const tick = () => {
    const now = Date.now();
    const el = (now - t0) / 1000;
    const readBy = loadSecs + readSecs;
    const doneBy = readBy + writeSecs;
    if (thought && !text && now - last < 3000) {
      const w = words(thought.length / (sp.charsPerToken || 3.6));
      return ui.phase({ label: 'Thinking it through', detail: `${w === 1 ? '1 word' : `${nice(w)} words`} of thinking so far · about ${Math.max(1, Math.round(sp.gen * 0.75))} words a second on your server` });
    }
    if (text && now - last < 3000) {
      const w = words(text.length / (sp.charsPerToken || 3.6));
      return ui.phase({ label: 'Writing', detail: `${w === 1 ? '1 word' : `${nice(w)} words`} so far · you’ll see it all at once when it’s done`, progress: Math.min(0.95, w / 160) });
    }
    if (text || thought) {
      const writingChange = /\b(propos|fix|chang|updat|edit|correct|set)/i.test(text + thought);
      return ui.phase({
        label: writingChange ? 'Writing up the change for you to review' : 'Deciding what to do next',
        detail: `${writingChange ? 'It writes the whole change out before it can be checked and shown' : 'Next: a lookup, a change or the answer'} · ${secsText((now - last) / 1000)}`,
      });
    }
    if (el < loadSecs) {
      const size = catalogModel(o.model)?.downloadBytes;
      return ui.phase({ label: `Loading ${name} into memory`, detail: `${size ? `${(size / 1e9).toFixed(1)} GB from disk. ` : ''}Only the first answer in a while waits for this.`, progress: el / doneBy, eta: doneBy - el });
    }
    const what = `${wordsText(readTokens)}${continuing ? ' that are new to it (it remembers the rest)' : ', including its instructions'}`;
    const measured = sp.samples ? '' : ' (estimated)';
    if (el < readBy) {
      return ui.phase({
        label: o.purpose,
        detail: `Reading ${what} · about ${nice(Math.round(sp.prefill * 0.75))} words a second on your server${measured}`,
        progress: Math.min(0.97, el / doneBy),
        eta: Math.max(1, doneBy - el),
      });
    }
    if (el < doneBy) {
      return ui.phase({
        label: o.think ? 'Thinking it through' : 'Writing its next step',
        detail: `${o.think ? 'Thinking, then writing' : 'Writing'} a lookup, a change or the answer · about ${Math.max(1, Math.round(sp.gen * 0.75))} words a second on your server${measured}. It shows once it’s complete.`,
        progress: Math.min(0.97, el / doneBy),
        eta: Math.max(1, doneBy - el),
      });
    }
    // Past the estimate with nothing back yet. The engine reports nothing until it has words to show
    // or its next step is complete, so say honestly that it could be either, and keep the bar moving.
    return ui.phase({
      label: 'Still working on it',
      detail: `Taking longer than the ${secsText(doneBy)} estimate (${secsText(el - doneBy)} over). It’s still reading ${what}, or writing its next step; the engine only reports once that’s done. The estimate improves with every answer.`,
      progress: -1,
    });
  };
  tick();
  const timer = setInterval(tick, 1000);
  try {
    for await (const chunk of ollamaStream<{ message?: { content?: string; thinking?: string; tool_calls?: Msg[] }; done?: boolean; done_reason?: string; error?: string } & EngineStats>(
      '/api/chat',
      { model: o.model, messages: o.convo, tools: o.tools, stream: true, think: o.think, options: { num_ctx: NUM_CTX, temperature: 0.2, num_predict: o.maxTokens } },
      signal
    )) {
      if (chunk.error) throw new Error(chunk.error);
      const now = Date.now();
      const stageBefore = thought && !text ? 1 : text ? 2 : 0;
      if (!first) first = now;
      last = now;
      if (chunk.message?.thinking) thought += chunk.message.thinking;
      if (chunk.message?.content) text += chunk.message.content;
      if (chunk.message?.tool_calls?.length) calls = calls.concat(chunk.message.tool_calls);
      if (chunk.done) {
        stats = chunk;
        cutShort = chunk.done_reason === 'length';
      }
      if ((thought && !text ? 1 : text ? 2 : 0) !== stageBefore) tick();
    }
  } catch (e) {
    step.fail(`${name} stopped`, (e as Error).message);
    throw e;
  } finally {
    clearInterval(timer);
  }
  recordSpeed(o.model, stats, { promptChars, expectedNewChars: newChars, fresh: !continuing, thinking: Boolean(o.think) });
  lastCall = { model: o.model, text: promptText(o.tools, [...o.convo, { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) }]), at: Date.now() };
  const read = stats.prompt_eval_count || readTokens;
  // Where the words went, so it's clear what makes a question slow to read
  const cpt = sp.charsPerToken || 3.6;
  const w = (chars: number) => nice(words(chars / cpt));
  const len = (m: Msg) => String(m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
  const instr = String(o.convo[0]?.content || '').length + (o.tools ? JSON.stringify(o.tools).length : 0);
  const talk = o.convo.slice(1).filter((m: Msg) => m.role !== 'tool').reduce((n: number, m: Msg) => n + len(m), 0);
  const found = o.convo.filter((m: Msg) => m.role === 'tool').reduce((n: number, m: Msg) => n + len(m), 0);
  const breakdown = `Instructions ~${w(instr)} words · conversation ~${w(talk)} · looked up ~${w(found)}`;
  const parts = [`read ${wordsText(read)}`];
  if (thought) parts.push(`thought ${nice(words(thought.length / (sp.charsPerToken || 3.6)))}`);
  parts.push(`wrote ${nice(words(Math.max(0, (stats.eval_count || 0) - (thought ? thought.length / (sp.charsPerToken || 3.6) : 0))))}`);
  step.done(`${name} ${parts.join(', ')}`, `${o.purpose} · ${thinkLabel(o.think)} · ${breakdown}`);
  return { text, thought, calls, stats, cutShort };
}

/** Load the everyday model and have it read the instructions while the person types */
let lastWarm = 0;
export async function warm(): Promise<void> {
  if (Date.now() - lastWarm < 4 * 60e3) return;
  const settings = getAiSettings();
  const model = settings.auto ? await modelFor('quick') : await modelFor('fixer');
  if (!model) return;
  lastWarm = Date.now();
  const tools = toolsFor(settings);
  const convo = [{ role: 'system', content: systemPrompt(settings.freedom, settings.access) }];
  const wasLoaded = await modelLoaded(model);
  try {
    const r = await ollama<EngineStats>(
      '/api/chat',
      { model, messages: convo, tools, stream: false, think: thinkFor(model, 'quick', { hasEvidence: false, retry: false }, false), options: { num_ctx: NUM_CTX, temperature: 0.2, num_predict: 1 } },
      'POST',
      10 * 60e3
    );
    const text = promptText(tools, convo);
    recordSpeed(model, r, { promptChars: text.length, expectedNewChars: text.length, fresh: !wasLoaded });
    lastCall = { model, text, at: Date.now() };
  } catch {
    lastWarm = 0;
  }
}

const argsOf = (call: Msg): Record<string, unknown> => {
  const a = call?.function?.arguments ?? {};
  if (typeof a !== 'string') return a;
  try {
    return JSON.parse(a);
  } catch {
    return {};
  }
};

/**
 * Answer a question, looking things up with tools; may end with a plan to review. In Automatic mode
 * the request is sorted first (question, fix, change), the obvious things are looked up at once,
 * and each round gets the model and amount of thinking it needs; a stronger model takes over if
 * the first gets stuck.
 */
export async function chat(messages: ChatMessage[], opts: { focus?: string; role?: 'quick' | 'fixer' }, emit: Emit, signal?: AbortSignal): Promise<void> {
  const started = Date.now();
  const settings = getAiSettings();
  const freedom = settings.freedom;
  const specs = await getSystemSpecs();
  const ui = makeUi(emit);
  const question = String(messages[messages.length - 1]?.content || '').slice(0, 8000);
  // Earlier messages, shortened: the latest question matters most, and every word is read again each round
  const history = messages
    .slice(0, -1)
    .slice(-8)
    .map((m) => {
      const t = String(m.content);
      const max = m.role === 'user' ? 1000 : 700;
      return { role: m.role, content: t.length > max ? `${t.slice(0, max)}…` : t };
    });

  // Never start while setup is still running: the models to choose from wouldn't all be there yet,
  // and the answer would share the processor with a download or a model being tested
  if (setupInProgress()) {
    const waiting = ui.step('Waiting for setup to finish', 'plan');
    while (setupInProgress()) {
      if (signal?.aborted) return;
      ui.phase({ label: 'Waiting for setup to finish', detail: `${setupInProgress()}. Your question starts as soon as everything is ready.` });
      await new Promise((r) => setTimeout(r, 1000));
    }
    waiting.done('Setup finished');
  }

  const sorting = ui.step('Working out what you need', 'plan');
  ui.phase({ label: 'Working out what you need' });
  const list = await apps().catch(() => [] as DeepContainerMetadata[]);
  const route = await planRoute({ question, focus: opts.focus, history, apps: list.map((c) => ({ cleanName: c.cleanName, service: c.compose?.service })) }, settings, specs, opts.role);
  if (!route) {
    sorting.fail('No AI model is installed');
    emit({ type: 'error', message: 'No AI model is installed yet. Set one up first.' });
    return;
  }
  sorting.done(`${taskLabel(route.task)} · ${effortLabel(route.effort).toLowerCase()} effort`, route.why);
  let model = route.model;
  const used = new Set([model]);
  emit({ type: 'route', task: taskLabel(route.task), effort: effortLabel(route.effort), model, name: nameOf(model), why: route.why });
  emit({ type: 'model', model, name: nameOf(model) });
  record('info', 'system', `Asked the AI: ${question.slice(0, 160)}`, { model, task: route.task, effort: route.effort });

  // The obvious lookups, all at once, before the AI starts
  route.lookups = route.lookups.filter((l) => allowedTool(l.name, settings.access));
  if (route.lookups.length) ui.phase({ label: `Looking up ${route.lookups.length === 1 ? 'one thing' : `${route.lookups.length} things`} first`, detail: 'So the AI doesn’t have to ask for them one at a time' });
  const looked = (
    await Promise.all(
      route.lookups.map(async (l) => {
        const st = ui.step(doingLabel(l.name, l.args).replace(/…$/, ''), 'lookup');
        try {
          const r = await runTool(l.name, l.args);
          st.done(r.label);
          return { l, result: clip(r.result, 5000) };
        } catch (e) {
          st.fail(`${doingLabel(l.name, l.args).replace(/…$/, '')} didn’t work`, (e as Error).message);
          return undefined;
        }
      })
    )
  ).filter(Boolean) as { l: { name: string; args: Record<string, unknown> }; result: string }[];

  // A plain question gets no change form; asking it to fix something afterwards is a new request that does
  const tools = toolsFor(settings, route.task !== 'question');
  const base: Msg[] = [{ role: 'system', content: systemPrompt(freedom, settings.access) }, ...history, { role: 'user', content: userTurn(question, await snapshotText(list), opts.focus) }];
  // What was looked up, in the form the model expects (as if it had asked), for this model and any that takes over
  const evidence: Msg[] = looked.length
    ? [{ role: 'assistant', content: '', tool_calls: looked.map((x) => ({ function: { name: x.l.name, arguments: x.l.args } })) }, ...looked.map((x) => ({ role: 'tool', tool_name: x.l.name, content: x.result }))]
    : [];
  let convo: Msg[] = [...base, ...evidence];

  let hasEvidence = looked.length > 0;
  let retry = false;
  let rejections = 0;
  let lastProblem: string | undefined;
  let handedOver = false;
  let recovered = false;

  const finish = (answer: string) => {
    ui.answer(answer);
    const secs = (Date.now() - started) / 1000;
    emit({ type: 'done', seconds: Math.round(secs), summary: `${secsText(secs)} · ${Array.from(used).map(nameOf).join(' + ')}` });
  };

  /** Hand the problem to the stronger model, with what's been found but without the dead ends */
  const handOver = async (reason: string): Promise<boolean> => {
    if (handedOver || !route.backup || route.backup === model) return false;
    const fit = await fitsNow(route.backup);
    if (!fit.ok) {
      ui.step(`${nameOf(route.backup)} can’t step in right now`, 'plan').done(undefined, fit.why);
      return false;
    }
    handedOver = true;
    const from = model;
    model = route.backup;
    used.add(model);
    ui.step(`Handing over to ${nameOf(model)}`, 'plan').done(undefined, `${reason} ${nameOf(from)} passes on what it found.`);
    emit({ type: 'model', model, name: nameOf(model) });
    convo = [...base, ...evidence, ...(lastProblem ? [{ role: 'user', content: `(From Manifexus: an earlier proposal was rejected because: ${lastProblem})` }] : [])];
    return true;
  };

  for (let round = 0; round < 8; round++) {
    const think: Think = settings.auto ? thinkFor(model, route.effort, { hasEvidence, retry }, specs.gpuUsable) : (catalogModel(model)?.think ?? false);
    const purpose = round === 0 ? (hasEvidence ? 'Reading your question and what was looked up' : 'Reading your question') : retry ? 'Correcting the proposed change' : 'Going over what it found';
    let r: RoundResult;
    try {
      r = await runModel({ model, convo, tools, think, maxTokens: think ? 4000 : route.effort === 'quick' ? 700 : 2500, purpose }, ui, signal);
    } catch (e) {
      // Not enough memory for this model right now: carry on with the smaller one
      const msg = (e as Error).message || '';
      const smaller = await modelFor('quick');
      if (!signal?.aborted && !recovered && /memory/i.test(msg) && smaller && smaller !== model) {
        recovered = true;
        ui.step(`Switching to ${nameOf(smaller)}`, 'plan').done(undefined, `${nameOf(model)} couldn’t get enough memory.`);
        model = smaller;
        used.add(model);
        emit({ type: 'model', model, name: nameOf(model) });
        convo = [...base, ...evidence];
        round--;
        continue;
      }
      throw e;
    }
    const calls = r.calls;
    convo.push({ role: 'assistant', content: r.text, ...(calls.length ? { tool_calls: calls } : {}) });

    if (!calls.length) {
      // Unsure after looking around: one more try with the stronger model
      if (route.effort !== 'quick' && round < 6 && /\b(not sure|can['’]t tell|unclear|need more (info|information|details))\b/i.test(r.text) && (await handOver('The first model wasn’t sure.'))) continue;
      let answer = r.text.trim() || 'I didn’t come up with an answer. Try asking in a different way.';
      if (r.cutShort) answer += '\n\n_That was cut short. Ask me to continue._';
      return finish(answer);
    }

    retry = false;
    let planned: Plan | undefined;
    for (const call of calls) {
      const name = call?.function?.name as string;
      const args = argsOf(call);
      if (name === 'propose_changes') {
        ui.phase({ label: 'Checking the proposed change', detail: 'Is the file still valid, does the text to change exist, will anything break' });
        const st = ui.step('Checking the proposed change', 'check');
        const { plan, problem } = await buildPlan(args, freedom, model);
        if (plan) {
          st.done(`Checked the proposed change: ${plan.steps.length === 1 ? 'one step' : `${plan.steps.length} steps`}`);
          planned = plan;
          convo.push({ role: 'tool', tool_name: name, content: 'The plan is shown to the person for review.' });
        } else {
          st.fail('The proposed change didn’t check out, so it’s being corrected', problem);
          rejections++;
          retry = true;
          lastProblem = problem;
          convo.push({ role: 'tool', tool_name: name, content: `The plan was rejected: ${problem}` });
        }
        continue;
      }
      if (!allowedTool(name, settings.access)) {
        ui.step(`Wanted to use ${name.replace(/_/g, ' ')}, which you haven’t allowed`, 'lookup').fail();
        convo.push({ role: 'tool', tool_name: name, content: 'Not allowed: the person has turned this off in AI Settings.' });
        continue;
      }
      ui.phase({ label: doingLabel(name, args) });
      const st = ui.step(doingLabel(name, args).replace(/…$/, ''), 'lookup');
      try {
        const res = await runTool(name, args);
        st.done(res.label);
        const msg = { role: 'tool', tool_name: name, content: res.result };
        convo.push(msg);
        evidence.push({ role: 'assistant', content: '', tool_calls: [call] }, msg);
      } catch (e) {
        st.fail(`${doingLabel(name, args).replace(/…$/, '')} didn’t work`, (e as Error).message);
        convo.push({ role: 'tool', tool_name: name, content: `Error: ${(e as Error).message}` });
      }
    }

    if (planned) {
      // The plan carries its own explanation: no extra round just to sum up
      const lead = r.text.trim();
      if (lead && planned.explanation && lead !== planned.explanation) ui.note(lead);
      emit({ type: 'plan', plan: planned });
      return finish(planned.explanation || lead || 'Here’s what I’d change. Nothing happens until you review it.');
    }
    if (r.text.trim()) ui.note(r.text.trim());
    hasEvidence = true;
    if (rejections >= 2 && (await handOver('The proposed change didn’t check out twice.'))) {
      rejections = 0;
      retry = false;
    } else if (round === 4 && route.effort !== 'quick') await handOver('This is taking a while.');
  }
  finish('I looked at a lot and still need more to be sure. Tell me more about what you’re seeing, or try again.');
}

// ----------------------------------------------------------------------------
// Running a plan: backup, each step, check; saved in Restore and recorded in Activity
// ----------------------------------------------------------------------------

export async function runPlan(id: string, emit: Emit): Promise<void> {
  const plan = plans.get(id);
  if (!plan) return emit({ type: 'failed', log: 'This plan has expired. Ask again to get a fresh one.' });
  const settings = getAiSettings();
  if (settings.freedom === 'look') return emit({ type: 'failed', log: 'The assistant is set to “Look only”, so it can’t make changes.' });

  const names = ['Saving a backup', ...plan.steps.map((s) => s.label), 'Checking everything is running'];
  names.forEach((n, i) => emit({ type: 'step_update', stepIndex: i + 1, stepName: n, status: 'pending' }));
  let idx = 0;
  const step = async (fn: (log: (m: string) => void) => Promise<void>) => {
    const n = ++idx;
    const t = Date.now();
    emit({ type: 'step_update', stepIndex: n, stepName: names[n - 1], status: 'running' });
    const log = (m: string) => emit({ type: 'log', stepIndex: n, log: m });
    try {
      await fn(log);
    } catch (e) {
      emit({ type: 'step_update', stepIndex: n, stepName: names[n - 1], status: 'failed', durationMs: Date.now() - t });
      throw e;
    }
    emit({ type: 'step_update', stepIndex: n, stepName: names[n - 1], status: 'success', durationMs: Date.now() - t });
  };

  const fixId = `fix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const snapDir = path.join(resolveBackupDir(), `snapshot_${fixId}`);
  const dirSnapshots: NonNullable<MergeHistoryRecord['dirSnapshots']> = [];
  const fileSnapshots: { path: string; content: string | null }[] = [];
  const resultFiles: { path: string; content: string | null }[] = [];
  const involvedApps = new Set<string>();
  let failure: string | undefined;

  try {
    await step(async (log) => {
      fs.mkdirSync(snapDir, { recursive: true });
      const stackDirs = new Map<string, StackRef>();
      for (const s of plan.steps) {
        const a = s.action;
        if (a.type === 'write_file' && a.path) {
          const st = await stackOfFile(a.path);
          if (st) stackDirs.set(norm(st.dir), st);
          else if (!fileSnapshots.some((f) => f.path === a.path)) fileSnapshots.push({ path: a.path, content: await readHostFile(a.path).catch(() => null) });
        }
        if (a.type === 'compose_up' && a.stack) {
          const st = await findStack(a.stack);
          if (st) stackDirs.set(norm(st.dir), st);
        }
        if (a.type === 'remove_container' && a.app) {
          const c = await findApp(a.app);
          const st = c?.compose?.project ? await findStack(c.compose.project) : undefined;
          if (st) stackDirs.set(norm(st.dir), st);
        }
        if (a.app) involvedApps.add(a.app);
      }
      for (const st of stackDirs.values()) {
        const compose = await readHostFile(path.posix.join(st.dir, 'docker-compose.yml')).catch(() => null);
        const env = await readHostFile(path.posix.join(st.dir, '.env')).catch(() => null);
        dirSnapshots.push({ dir: st.dir, project: st.project, existed: compose !== null, compose, env });
        if (compose !== null) fs.writeFileSync(path.join(snapDir, `${st.project.replace(/[^a-zA-Z0-9_.-]/g, '_')}.docker-compose.yml`), compose);
        for (const c of await apps()) if (c.compose?.project === st.project) involvedApps.add(c.cleanName);
      }
      fileSnapshots.forEach((f, i) => f.content !== null && fs.writeFileSync(path.join(snapDir, `file_${i}_${path.posix.basename(f.path)}`), f.content));
      fs.writeFileSync(path.join(snapDir, 'plan.json'), JSON.stringify(plan, null, 2));
      const n = dirSnapshots.length + fileSnapshots.length;
      log(n ? `Saved ${n} ${n === 1 ? 'thing' : 'things'} so this can be undone from Restore.` : 'Nothing to back up: these steps only start or restart apps.');
    });

    for (const s of plan.steps) {
      const a = s.action;
      await step(async (log) => {
        if (a.type === 'restart' || a.type === 'start' || a.type === 'stop') {
          const c = await findApp(a.app || '');
          if (!c) throw new Error(`${a.app} isn’t there anymore.`);
          const r = await executeContainerAction(c.id, a.type);
          if (!r.success) throw new Error(r.message);
          log(r.message);
        } else if (a.type === 'write_file' && a.path && typeof a.content === 'string') {
          if (!(await writeHostFile(a.path, a.content))) throw new Error(`Couldn’t write ${a.path}.`);
          resultFiles.push({ path: a.path, content: a.content });
          log(`Saved ${a.path}.`);
        } else if (a.type === 'compose_up' && a.stack) {
          const st = await findStack(a.stack);
          if (!st) throw new Error(`${a.stack} isn’t there anymore.`);
          const up = await runComposeCapture(st.dir, `up -d${a.services?.length ? ` ${a.services.join(' ')}` : ''}`);
          if (!up.ok) {
            const why = composeErrorTail(up.output);
            throw new Error(`Docker couldn’t start ${st.project}${why ? `: ${why.split('\n').pop()}` : '.'}`);
          }
          log(`${st.project} is up.`);
        } else if (a.type === 'remove_container' && a.app) {
          const c = await findApp(a.app);
          if (!c) return log(`${a.app} was already gone.`);
          if (!(await forceRemoveContainer(c.id))) throw new Error(`Couldn’t remove ${a.app}.`);
          log(`Removed ${a.app}’s container. Its volumes and folders are untouched.`);
        } else if (a.type === 'run_command' && a.command) {
          const out = await runHostCommand(a.command);
          if (out.output.trim()) log(redactText(out.output.trim()).slice(-1500));
          if (out.code !== 0) throw new Error(`The command ended with exit code ${out.code}.`);
        }
      });
    }

    await step(async (log) => {
      await new Promise((r) => setTimeout(r, 4000));
      const list = await apps();
      const stopped = Array.from(involvedApps).filter((n) => {
        const c = list.find((x) => x.cleanName === n);
        const wantStopped = plan.steps.some((s) => s.action.type === 'stop' && s.action.app === n) || plan.steps.some((s) => s.action.type === 'remove_container' && s.action.app === n);
        return c && c.state !== 'running' && !wantStopped;
      });
      if (stopped.length) log(`Not running yet: ${stopped.join(', ')}. Check their logs.`);
      else log(involvedApps.size ? 'Everything involved is running.' : 'Done.');
    });
  } catch (e) {
    failure = (e as Error).message;
  }

  // Save it in Restore (even a partial run, so whatever did change can be put back)
  if (dirSnapshots.length || fileSnapshots.length) {
    const rec: MergeHistoryRecord = {
      id: fixId,
      timestamp: new Date().toISOString(),
      targetStackName: dirSnapshots[0]?.project || '',
      targetDirectory: '',
      backupArchiveDir: snapDir,
      sourceStacks: [],
      affectedServices: Array.from(involvedApps),
      sourceConfigs: [],
      status: 'active',
      archiveSizeBytes: 0,
      summary: `Fixed: ${plan.title}`,
      sourceUrl: `by the built-in AI`,
      type: 'FIX',
      dirSnapshots,
      fileSnapshots: fileSnapshots.length ? fileSnapshots : undefined,
      resultFiles,
      activityId: currentActivityId(),
    };
    saveMergeHistoryRecord(rec);
  } else {
    fs.rmSync(snapDir, { recursive: true, force: true });
  }
  plans.delete(id);
  if (failure) return emit({ type: 'failed', log: `${failure}${dirSnapshots.length || fileSnapshots.length ? ' What changed before this is saved in Restore, so it can be undone.' : ''}` });
  emit({ type: 'completed', payload: { restoreId: dirSnapshots.length || fileSnapshots.length ? fixId : undefined } });
}
