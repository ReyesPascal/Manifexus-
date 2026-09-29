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
import { getAiSettings, modelFor, ollamaStream, catalogModel, Freedom } from './aiService';
import type { DeepContainerMetadata } from '../src/types';

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
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const str = (description: string) => ({ type: 'string', description });

const READ_TOOLS: ToolDef[] = [
  tool('list_apps', 'Every app (container): name, stack, state, image, ports.'),
  tool('app_details', 'Health checks, exit code, restarts, memory/CPU, folders, settings (secrets hidden), networks and recent events for one app.', { app: str('App name') }, ['app']),
  tool('app_logs', 'The last lines an app printed.', { app: str('App name'), lines: { type: 'number', description: 'How many lines, up to 500' } }, ['app']),
  tool('list_stacks', 'Every stack with its folder and compose file path.'),
  tool('read_file', 'Read a text file on the server (compose files, .env, configs). Secrets are hidden.', { path: str('Full path on the server') }, ['path']),
  tool('list_folder', 'List what is in a folder on the server, with owners and permissions.', { path: str('Full path on the server') }, ['path']),
  tool('diagnostics', 'Manifexus health checks and current issues.'),
  tool('activity', 'Recent changes and what happened (moves, restores, updates, failures).', { only_problems: { type: 'boolean', description: 'Only failed or rolled back ones' } }),
  tool('restore_points', 'Backups that can be restored, newest first.'),
  tool('server_specs', 'CPU, memory, graphics card and disk space of the server.'),
  tool('docker_overview', 'Networks, volumes, and which host ports are in use by which app.'),
];

function changeTool(freedom: Freedom): ToolDef {
  const types = ['restart', 'start', 'stop', 'write_file', 'compose_up', 'remove_container', ...(freedom === 'expert' ? ['run_command'] : [])];
  return tool(
    'propose_changes',
    'Propose changes for the person to review. Nothing happens until they approve. Use write_file with the COMPLETE new file content. ' +
      'compose_up starts or recreates services of a stack from its compose file. remove_container removes a container but keeps its volumes and folders.' +
      (freedom === 'expert' ? ' run_command runs one shell command on the server; use only when nothing else can do it.' : ''),
    {
      title: str('Short plain title, e.g. "Remove the extra kavita from music-stack"'),
      explanation: str('Plain words: what is wrong, why, and what these changes do. No jargon.'),
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: types },
            app: str('App name (restart, start, stop, remove_container)'),
            stack: str('Stack name (compose_up)'),
            services: { type: 'array', items: { type: 'string' }, description: 'Services to start (compose_up); omit for all' },
            path: str('File path (write_file)'),
            content: str('Complete new file content (write_file)'),
            command: str('Shell command (run_command)'),
            reason: str('Why this step, in plain words'),
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
      const n = Math.min(500, Math.max(20, Number(args.lines) || 150));
      const out = await appLogs(c.id, n);
      return { label: `Read ${c.cleanName}’s logs`, result: clip(redactText(out.text || out.error || '(no output)'), 9000) };
    }
    case 'list_stacks': {
      const list = await stacks();
      return { label: 'Looked at your stacks', result: list.map((s) => `${s.project} · folder ${s.dir} · file ${s.file}`).join('\n') || 'No stacks.' };
    }
    case 'read_file': {
      const p = a('path');
      if (!p.startsWith('/')) return { label: 'Tried to read a file', result: 'Give a full path starting with /.' };
      const text = await readHostFile(p).catch(() => null);
      return { label: `Read ${p}`, result: text === null ? `${p} doesn’t exist or can’t be read.` : clip(redactText(text), 12000) };
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
      return { label: 'Ran Diagnostics', result: d.checks.map((c) => `[${c.level}] ${c.title}: ${c.detail}`).join('\n') };
    }
    case 'activity': {
      const onlyProblems = Boolean(args.only_problems);
      const list = listActivities({ statuses: onlyProblems ? ['failed', 'rolled_back', 'interrupted'] : undefined, limit: 15 }).activities;
      return {
        label: onlyProblems ? 'Looked at recent problems' : 'Looked at recent activity',
        result: list.map((x) => `${x.startedAt} · ${x.title} · ${x.status}${x.error ? ` · error: ${redactText(String(x.error)).slice(0, 400)}` : ''}`).join('\n') || 'Nothing recorded.',
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
  type: 'restart' | 'start' | 'stop' | 'write_file' | 'compose_up' | 'remove_container' | 'run_command';
  app?: string;
  stack?: string;
  services?: string[];
  path?: string;
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

// ----------------------------------------------------------------------------
// Chat
// ----------------------------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

type Emit = (e: Record<string, unknown>) => void;

function systemPrompt(freedom: Freedom, snapshot: string, focus?: string): string {
  return [
    'You are the assistant built into Manifexus, a dashboard for the Docker apps on this person’s home server.',
    'You can look at everything with your tools: apps, stacks, compose files, logs, Activity, Restore, Diagnostics and the server itself. Look before you answer; never guess names, paths or causes.',
    'Talk like a friendly expert to someone who may never have used a terminal: short, plain sentences, no jargon (if you must use a term, explain it). Use bullet points only for steps.',
    freedom === 'look'
      ? 'You can only look and advise: explain what is wrong and what could be done, but you cannot change anything.'
      : 'When something should change, call propose_changes with every step. Nothing happens until the person approves; they see a before/after of every file. Manifexus backs everything up first and saves it in Restore, so it can be undone.',
    'Prefer the smallest safe fix. Keep data safe: never delete volumes or data folders. When editing a file, keep everything else in it exactly as it was.',
    'If you are not sure what is wrong, say so, and say what you would check next.',
    `What Manifexus shows right now:\n${snapshot}`,
    focus ? `The person is asking about this: ${focus}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function snapshotText(): Promise<string> {
  const list = await apps().catch(() => []);
  const lines = list.slice(0, 60).map((c) => `- ${c.cleanName} (${c.compose?.project || 'standalone'}): ${c.state}`);
  return lines.join('\n') || '(no apps found)';
}

/** Answer a question, looking things up with tools; may end with a plan to review */
export async function chat(messages: ChatMessage[], opts: { focus?: string; role?: 'quick' | 'fixer' }, emit: Emit, signal?: AbortSignal): Promise<void> {
  const settings = getAiSettings();
  const model = await modelFor(opts.role || 'fixer');
  if (!model) {
    emit({ type: 'error', message: 'No AI model is installed yet. Set one up first.' });
    return;
  }
  const info = catalogModel(model);
  const freedom = settings.freedom;
  const tools = freedom === 'look' ? READ_TOOLS : [...READ_TOOLS, changeTool(freedom)];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const convo: any[] = [
    { role: 'system', content: systemPrompt(freedom, await snapshotText(), opts.focus) },
    ...messages.slice(-12).map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000) })),
  ];
  emit({ type: 'model', model, name: info?.name || model });
  record('info', 'system', `Asked the AI: ${String(messages[messages.length - 1]?.content || '').slice(0, 160)}`, { model });

  for (let round = 0; round < 10; round++) {
    let text = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let calls: any[] = [];
    emit({ type: 'thinking' });
    for await (const chunk of ollamaStream<{ message?: { content?: string; tool_calls?: unknown[] }; done?: boolean; error?: string }>(
      '/api/chat',
      { model, messages: convo, tools, stream: true, think: info?.think ?? false, options: { num_ctx: 16384, temperature: 0.2 } },
      signal
    )) {
      if (chunk.error) throw new Error(chunk.error);
      const piece = chunk.message?.content || '';
      if (piece) {
        text += piece;
        emit({ type: 'text', delta: piece });
      }
      if (chunk.message?.tool_calls?.length) calls = calls.concat(chunk.message.tool_calls);
    }
    convo.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      emit({ type: 'done' });
      return;
    }
    let planned = false;
    for (const call of calls) {
      const name = call?.function?.name as string;
      let args = call?.function?.arguments ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      if (name === 'propose_changes') {
        const { plan, problem } = await buildPlan(args, freedom, model);
        if (plan) {
          emit({ type: 'plan', plan });
          planned = true;
          convo.push({ role: 'tool', tool_name: name, content: 'The plan is shown to the person for review. Briefly tell them what to expect, then stop.' });
        } else {
          emit({ type: 'tool', label: 'Checked the proposed changes', ok: false });
          convo.push({ role: 'tool', tool_name: name, content: `The plan was rejected: ${problem}` });
        }
        continue;
      }
      emit({ type: 'tool', label: 'Looking…', running: true, name });
      try {
        const r = await runTool(name, args);
        emit({ type: 'tool', label: r.label, ok: true, name });
        convo.push({ role: 'tool', tool_name: name, content: r.result });
      } catch (e) {
        emit({ type: 'tool', label: `Couldn’t ${name.replace(/_/g, ' ')}`, ok: false, name });
        convo.push({ role: 'tool', tool_name: name, content: `Error: ${(e as Error).message}` });
      }
    }
    if (planned) {
      // One short closing sentence, then stop
      let closing = '';
      let first = true;
      for await (const chunk of ollamaStream<{ message?: { content?: string } }>(
        '/api/chat',
        { model, messages: convo, stream: true, think: info?.think ?? false, options: { num_ctx: 16384, temperature: 0.2 } },
        signal
      )) {
        const piece = chunk.message?.content || '';
        closing += piece;
        if (piece) {
          emit({ type: 'text', delta: first && text.trim() ? `\n\n${piece.trimStart()}` : piece });
          first = false;
        }
      }
      emit({ type: 'done' });
      return;
    }
  }
  emit({ type: 'text', delta: '\n\nI looked at a lot and still need more to be sure. Tell me more about what you’re seeing, or try again.' });
  emit({ type: 'done' });
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
