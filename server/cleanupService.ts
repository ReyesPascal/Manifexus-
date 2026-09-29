/**
 * Server Cleanup: find folders in the stacks locations that nothing uses anymore, and delete the ones
 * the person picks.
 *
 * Only two kinds are ever offered:
 * - Empty folders: nothing inside at all.
 * - Stacks with no apps: a folder with a compose file that no container (running or stopped) comes
 *   from. These are deleted like any stack: backed up first, and restorable from Restore.
 *
 * A folder any container uses (as its stack folder, or anything it mounts inside it) is never offered,
 * and neither are Manifexus's own folder, its data or its backups.
 */
import path from 'path';
import { getContainersList } from './dockerService';
import { runHelperScript, removeHostDirectory } from './dataBackupService';
import { resolveBackupDir } from './historyService';
import { getDefaultHostStacksBaseDir, getRegisteredCreatedStacks, deleteHostStack, isManifexusContainer } from './stackService';
import { getSelf } from './updateService';

export interface CleanupItem {
  path: string;
  kind: 'empty' | 'stack';
  /** Files inside (compose file, .env…) */
  files: number;
  bytes: number;
  /** What's in it, in a few words */
  note: string;
}

const norm = (p: string) => path.posix.normalize(p).replace(/\/+$/, '');
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + '/');

export async function scanCleanup(): Promise<{ items: CleanupItem[]; looked: string[] }> {
  const { containers } = await getContainersList();
  // Where stacks live: the default place, and wherever existing stacks sit
  const bases = new Set<string>([norm(getDefaultHostStacksBaseDir(containers))]);
  for (const c of containers) if (c.compose?.workingDir) bases.add(norm(path.posix.dirname(c.compose.workingDir)));
  for (const s of getRegisteredCreatedStacks()) if (s.workingDir) bases.add(norm(path.posix.dirname(s.workingDir)));
  const looked = Array.from(bases).filter((b) => b.split('/').filter(Boolean).length >= 1 && b !== '/');

  // Everything in use: stack folders and anything a container mounts
  const used: string[] = [];
  for (const c of containers) {
    if (c.compose?.workingDir) used.push(norm(c.compose.workingDir));
    for (const m of c.mounts || []) if (m.type === 'bind' && m.source) used.push(norm(m.source));
  }
  // Manifexus's own folders
  const protectedDirs = [norm(resolveBackupDir())];
  const self = await getSelf().catch(() => null);
  if (self?.compose?.workingDir) protectedDirs.push(norm(self.compose.workingDir));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of ((self?.inspect as any)?.Mounts || []) as { Source?: string }[]) if (m.Source) protectedDirs.push(norm(m.Source));
  for (const c of containers) if (isManifexusContainer(c) && c.compose?.workingDir) protectedDirs.push(norm(c.compose.workingDir));

  const items: CleanupItem[] = [];
  for (const base of looked) {
    // One line per folder: path | files inside (up to 1000) | compose file | size in KB
    const script =
      `B=${JSON.stringify('/host' + base)}; [ -d "$B" ] || exit 0; ` +
      `for d in "$B"/*/ "$B"/.[!.]*/; do [ -d "$d" ] || continue; [ -L "\${d%/}" ] && continue; ` +
      `n=$(find "$d" -mindepth 1 2>/dev/null | head -1000 | wc -l); ` +
      `c=$(ls "$d"docker-compose.yml "$d"docker-compose.yaml "$d"compose.yml "$d"compose.yaml 2>/dev/null | head -1); ` +
      `s=$(du -sk "$d" 2>/dev/null | cut -f1); echo "\${d%/}|$n|$c|$s"; done`;
    const out = await runHelperScript(script, ['/:/host:ro'], `Look for unused folders in ${base}`).catch(() => ({ code: 1, output: '' }));
    for (const line of out.output.split('\n')) {
      const [p, n, compose, kb] = line.trim().split('|');
      if (!p || !p.startsWith('/host/')) continue;
      const dir = norm(p.slice(5));
      const files = parseInt(n, 10) || 0;
      // In use: an app's stack folder or something it mounts is this folder or inside it
      if (used.some((u) => inside(u, dir))) continue;
      if (protectedDirs.some((x) => x && inside(x, dir))) continue;
      const bytes = (parseInt(kb, 10) || 0) * 1024;
      if (files === 0) items.push({ path: dir, kind: 'empty', files: 0, bytes: 0, note: 'Empty' });
      else if (compose) {
        const onlyCompose = files === 1;
        items.push({ path: dir, kind: 'stack', files, bytes, note: onlyCompose ? 'Only a compose file, no apps' : `A compose file and ${files - 1} other item${files - 1 === 1 ? '' : 's'}, no apps` });
      }
    }
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  return { items, looked };
}

export interface CleanupResult {
  path: string;
  ok: boolean;
  message: string;
}

/** Delete the chosen folders, only if a fresh scan still offers them */
export async function runCleanup(paths: string[]): Promise<CleanupResult[]> {
  const { items } = await scanCleanup();
  const results: CleanupResult[] = [];
  for (const p of paths) {
    const item = items.find((i) => i.path === norm(p));
    if (!item) {
      results.push({ path: p, ok: false, message: 'Skipped: it’s in use now, or already gone.' });
      continue;
    }
    try {
      if (item.kind === 'empty') {
        const ok = await removeHostDirectory(item.path);
        results.push({ path: p, ok, message: ok ? 'Deleted' : 'Couldn’t be deleted.' });
      } else {
        const r = await deleteHostStack({ projectName: path.posix.basename(item.path), targetDirectory: item.path });
        results.push({ path: p, ok: !r.folderLeft, message: r.folderLeft ? 'Backed up, but the folder couldn’t be removed.' : 'Backed up and deleted (in Restore)' });
      }
    } catch (e) {
      results.push({ path: p, ok: false, message: (e as Error).message });
    }
  }
  return results;
}
