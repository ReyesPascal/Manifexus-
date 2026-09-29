/**
 * Server Changes: turning it on gets the server ready for Manifexus to make changes, for real:
 *
 * 1. Docker lets Manifexus make changes (it starts and removes a small helper, the way every change runs).
 * 2. Docker Compose works (stacks are started and stopped with it).
 * 3. The stacks folder exists and Manifexus can write in it (created if missing, owned like its parent).
 * 4. Commands can run on the server itself (used to remove stubborn folders and for approved fixes).
 *
 * Only when every step works is Server Changes switched on. Turning it off needs nothing on the server:
 * from then on Manifexus refuses every change (see CHANGE_ROUTES in server.ts and the terminal).
 */
import path from 'path';
import { queryDockerEngine, getContainersList } from './dockerService';
import { runHelperScript, runHostCommand } from './dataBackupService';
import { getDefaultHostStacksBaseDir } from './stackService';
import { saveConfig } from './storageService';
import { record } from './activityLog';

export interface AccessStep {
  id: string;
  title: string;
  /** warn: didn't work, but only a few things need it, so Server Changes still turns on */
  status: 'running' | 'done' | 'failed' | 'warn';
  detail?: string;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function enableServerChanges(emit: (s: AccessStep) => void): Promise<{ ok: boolean; problem?: string }> {
  const step = async (id: string, title: string, fn: () => Promise<string | void>, optional?: string): Promise<boolean> => {
    emit({ id, title, status: 'running' });
    try {
      const detail = (await fn()) || undefined;
      emit({ id, title, status: 'done', detail });
      return true;
    } catch (e) {
      if (optional) {
        emit({ id, title, status: 'warn', detail: optional });
        return true;
      }
      emit({ id, title, status: 'failed', detail: (e as Error).message });
      return false;
    }
  };

  let base = '';
  const steps: [string, string, () => Promise<string | void>, string?][] = [
    [
      'docker',
      'Docker lets Manifexus make changes',
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v = await queryDockerEngine<any>('/version', 'GET').catch(() => null);
        if (!v) throw new Error('Manifexus can’t reach Docker.');
        const r = await runHelperScript('echo ok', [], 'Check that Docker lets Manifexus make changes', 60 * 1000);
        if (r.code !== 0 || !r.output.includes('ok')) throw new Error('Docker didn’t let Manifexus start its helper.');
        return `Docker ${v.Version}`;
      },
    ],
    [
      'compose',
      'Docker Compose works',
      async () => {
        const r = await runHelperScript(
          'docker compose version --short 2>/dev/null || docker-compose version --short 2>/dev/null || exit 127',
          [],
          'Check that Docker Compose works',
          60 * 1000
        );
        if (r.code !== 0) throw new Error('Docker Compose isn’t available.');
        const ver = r.output.trim().split('\n').pop();
        return ver ? `Version ${ver}` : undefined;
      },
    ],
    [
      'folder',
      'Your stacks folder is ready',
      async () => {
        const { containers } = await getContainersList();
        base = getDefaultHostStacksBaseDir(containers);
        if (!base.startsWith('/') || base === '/') throw new Error('There’s no stacks folder set in Settings.');
        const parent = path.posix.dirname(base);
        const name = q(path.posix.basename(base));
        const script = [
          `[ -d /parent ] || exit 30`,
          `made=0; [ -d /parent/${name} ] || { mkdir -p /parent/${name} && made=1; } || exit 31`,
          // A new folder belongs to the same person as its parent (your user, not root)
          `[ $made = 1 ] && chown "$(stat -c %u:%g /parent)" /parent/${name} 2>/dev/null`,
          `t=/parent/${name}/.manifexus-check; { printf ok > "$t" && rm -f "$t"; } || exit 32`,
          `echo made=$made`,
        ].join('; ');
        const r = await runHelperScript(script, [`${parent}:/parent`], `Get the stacks folder ${base} ready`, 60 * 1000);
        if (r.code === 30) throw new Error(`${parent} doesn’t exist on your server.`);
        if (r.code === 31) throw new Error(`Couldn’t create ${base}.`);
        if (r.code !== 0) throw new Error(`Manifexus can’t write in ${base}.`);
        return r.output.includes('made=1') ? `Created ${base}` : base;
      },
    ],
    [
      'host',
      'Commands can run on your server',
      async () => {
        const r = await runHostCommand('echo ok', 60 * 1000);
        if (r.code !== 0 || !r.output.includes('ok')) throw new Error('Docker didn’t allow running commands on the server.');
      },
      // Everything else works without it
      'Not allowed on this server. Everything else still works.',
    ],
  ];

  for (const [id, title, fn, optional] of steps) {
    if (!(await step(id, title, fn, optional))) {
      record('warn', 'step', 'Server Changes couldn’t be turned on', { failedStep: title });
      return { ok: false, problem: title };
    }
  }
  saveConfig({ allowServerChanges: true });
  record('info', 'step', 'Server Changes turned on', { stacksFolder: base });
  return { ok: true };
}

export function disableServerChanges(): void {
  saveConfig({ allowServerChanges: false });
  record('info', 'step', 'Server Changes turned off');
}
