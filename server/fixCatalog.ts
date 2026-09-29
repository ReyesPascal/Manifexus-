/**
 * How to fix what Diagnostics finds, without AI: for each kind of problem, whether Manifexus can fix it
 * by itself (a change it knows is right, shown for review and backed up like any other), and how to fix
 * it by hand, step by step with the exact commands. Problems it can't know the answer to (why an app
 * crashes) have instructions only; that's where Fix with AI helps.
 */
import yaml from 'yaml';
import type { Check } from './diagnosticsService';
import type { PlanAction } from './aiAgent';
import { readHostFile } from './hostFsService';
import { explain, Explain } from './commandLog';

export interface ManualStep {
  text: string;
  /** A command to type in a terminal on the server */
  command?: string;
  /** A Manifexus screen that does this step */
  screen?: 'settings' | 'restore' | 'updates' | 'activity' | 'logs';
  /** What each part of the command means, in plain words */
  explain?: Explain[];
}

export interface FixInfo {
  /** Manifexus can fix this itself: what it would do, in a few words */
  auto?: string;
  manual: ManualStep[];
}

export interface FixContext {
  /** The app a check is about (app diagnostics), by its container name */
  app?: string;
  /** Manifexus's own compose folder, when known */
  selfDir?: string;
}

const q = (s: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Whether Manifexus can fix it by itself, and the steps to do it by hand */
export function describeFix(c: Check, ctx: FixContext): FixInfo | undefined {
  const info = describeFixRaw(c, ctx);
  if (info) info.manual = info.manual.map((m) => (m.command && !m.command.startsWith('- ') ? { ...m, explain: explain(m.command) } : m));
  return info;
}

function describeFixRaw(c: Check, ctx: FixContext): FixInfo | undefined {
  if (c.level === 'ok' || c.level === 'info') return undefined;
  const app = ctx.app || 'the app';
  const inSelf = (cmd: string) => (ctx.selfDir ? `cd ${q(ctx.selfDir)} && ${cmd}` : cmd);
  switch (c.id) {
    case 'stacks-dir': {
      const value = c.data?.value || '';
      const fixed = `/${value.replace(/^\/+/, '').replace(/\/+$/, '')}`;
      return {
        auto: c.data?.file ? `Change the setting to ${fixed}` : undefined,
        manual: [
          { text: `Open Settings and set “New stacks folder” to the full path ${fixed} (it must start with /), then press Enter.`, screen: 'settings' },
          ...(c.data?.file
            ? [
                { text: 'Or edit the settings file directly: keep a copy first.', command: `cp ${q(c.data.file)} ${q(`${c.data.file}.backup`)}` },
                { text: `Open it and change the "stacksDir" line to "${fixed}". Save with Ctrl+O then Enter, exit with Ctrl+X.`, command: `nano ${q(c.data.file)}` },
              ]
            : []),
        ],
      };
    }
    case 'duplicates': {
      const d = c.data || {};
      if (!d.file || !d.service) return { manual: [{ text: c.detail }] };
      const dir = d.file.replace(/\/[^/]+$/, '');
      return {
        auto: `Remove ${d.service} from ${d.stack}’s compose file (the running ${d.app} is left alone)`,
        manual: [
          { text: 'Keep a copy of the compose file first.', command: `cp ${q(d.file)} ${q(`${d.file}.backup`)}` },
          { text: `Open it and delete the “${d.service}:” section under services (every line indented below it). Save with Ctrl+O then Enter, exit with Ctrl+X.`, command: `nano ${q(d.file)}` },
          ...(d.detached
            ? [{ text: `Or, to keep it in this stack instead: replace the running ${d.app} with one made from the file (its volumes and folders are kept).`, command: `docker rm -f ${q(d.app)} && cd ${q(dir)} && docker compose up -d ${q(d.service)}` }]
            : []),
          { text: 'Check the stack starts cleanly.', command: `cd ${q(dir)} && docker compose config --quiet && echo OK` },
        ],
      };
    }
    case 'state':
      if (c.title === 'Keeps restarting')
        return {
          manual: [
            { text: `Read what ${app} prints just before it stops: the cause is usually there.`, screen: 'logs', command: `docker logs --tail 100 ${q(app)}` },
            { text: 'Common causes: a wrong setting or path in its compose file or .env, a folder it can’t write to, or a port already in use. Fix that, then restart it.', command: `docker restart ${q(app)}` },
          ],
        };
      return {
        auto: `Start ${app}`,
        manual: [
          { text: `Start ${app}.`, command: `docker start ${q(app)}` },
          { text: 'If it stops again, read its last output for the reason.', screen: 'logs', command: `docker logs --tail 100 ${q(app)}` },
        ],
      };
    case 'health':
      return {
        auto: `Restart ${app}`,
        manual: [
          { text: `Restart ${app}; a stuck app often recovers.`, command: `docker restart ${q(app)}` },
          { text: 'If the health check keeps failing, its logs say why.', screen: 'logs', command: `docker logs --tail 100 ${q(app)}` },
        ],
      };
    case 'oom':
    case 'memory':
      return {
        manual: [
          { text: `See how much memory ${app} uses now.`, command: `docker stats --no-stream ${q(app)}` },
          { text: `Give it more room: in its compose file, raise (or remove) the memory limit under ${app}’s service, e.g. mem_limit: 2g. Then recreate it.`, command: `docker compose up -d ${q(app)}` },
        ],
      };
    case 'restarts':
      return { manual: [{ text: `Docker restarted ${app} after it stopped. Its logs say why.`, screen: 'logs', command: `docker logs --tail 100 ${q(app)}` }] };
    case 'docker':
      return {
        manual: [
          { text: 'Manifexus needs the Docker socket. In Manifexus’s docker-compose.yml, under volumes, add this line:', command: '- /var/run/docker.sock:/var/run/docker.sock' },
          { text: 'Then recreate Manifexus (your apps keep running).', command: inSelf('docker compose up -d') },
        ],
      };
    case 'automation':
      return {
        manual: [
          { text: 'In Manifexus’s docker-compose.yml, make the Docker socket writable: remove “:ro” from the /var/run/docker.sock line.' },
          { text: 'Then recreate Manifexus (your apps keep running).', command: inSelf('docker compose up -d') },
          { text: 'Settings shows what full automation needs and checks it for you.', screen: 'settings' },
        ],
      };
    case 'data':
      return {
        manual: [
          { text: 'In Manifexus’s docker-compose.yml, under volumes, add a folder for its data:', command: '- ./data:/data' },
          { text: 'Then recreate Manifexus. Settings, history and backups are kept from then on.', command: inSelf('docker compose up -d') },
        ],
      };
    case 'backups':
      return {
        manual: [
          { text: 'Open Restore and delete old changes you no longer need, or keep backups for fewer days (the gear in Restore).', screen: 'restore' },
          { text: 'See what’s using the disk.', command: 'df -h' },
        ],
      };
    case 'updates':
      return {
        manual: [
          { text: 'Check that the server can reach the internet.', command: 'curl -sI https://ghcr.io | head -1' },
          { text: 'Then check again in Updates.', screen: 'updates' },
        ],
      };
    default:
      return { manual: [{ text: c.detail }] };
  }
}

/** The changes for an automatic fix, reviewed and run like any other change */
export async function autoFixActions(c: Check, ctx: FixContext): Promise<PlanAction[] | { problem: string }> {
  switch (c.id) {
    case 'stacks-dir': {
      const file = c.data?.file;
      const value = c.data?.value || '';
      if (!file) return { problem: 'Manifexus can’t tell where its settings file is on your server.' };
      const fixed = `/${value.replace(/^\/+/, '').replace(/\/+$/, '')}`;
      return [{ type: 'edit_file', path: file, find: `"stacksDir": ${JSON.stringify(value)}`, replace: `"stacksDir": ${JSON.stringify(fixed)}`, reason: `A full path starting with /, so Manifexus can use it` }];
    }
    case 'duplicates': {
      const d = c.data || {};
      if (!d.file || !d.service) return { problem: 'Manifexus couldn’t tell which file lists it twice.' };
      const text = await readHostFile(d.file).catch(() => null);
      if (text === null) return { problem: `Couldn’t read ${d.file}.` };
      // Edit the file as a document so comments and formatting elsewhere are kept
      const doc = yaml.parseDocument(text);
      if (!doc.hasIn(['services', d.service])) return { problem: `${d.service} isn’t in ${d.file} any more.` };
      doc.deleteIn(['services', d.service]);
      return [{ type: 'write_file', path: d.file, content: String(doc), reason: `${d.app} runs elsewhere; listing it here too stops ${d.stack} from starting as a whole` }];
    }
    case 'state':
      if (c.title === 'Keeps restarting' || !ctx.app) break;
      return [{ type: 'start', app: ctx.app, reason: `${ctx.app} isn’t running` }];
    case 'health':
      if (!ctx.app) break;
      return [{ type: 'restart', app: ctx.app, reason: 'Its health check is failing; a restart often clears it' }];
  }
  return { problem: 'Manifexus doesn’t have an automatic fix for this one.' };
}
