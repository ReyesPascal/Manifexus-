/**
 * Version 1.1 came with a practice problem for the built-in AI: it saved the New Stacks location without its
 * leading slash (home/ryan/stacks instead of /home/ryan/stacks). That left Getting Started stuck on step 2 with
 * a greyed-out Continue, so it's no longer done. Settings only ever accepts a full path, so a location without
 * its slash can only come from that: on every start, the slash is put back.
 */
import { getConfig, saveConfig } from './storageService';
import { record } from './activityLog';

/** Puts the leading / back on a New Stacks location saved without it. Returns the fixed location, if any. */
export function repairStacksDir(): string | undefined {
  const config = getConfig();
  const saved = (config.stacksDir || '').trim();
  if (!saved || saved.startsWith('/')) {
    if (!config.aiExampleSeeded) saveConfig({ aiExampleSeeded: true });
    return undefined;
  }
  const fixed = `/${saved.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  saveConfig({ aiExampleSeeded: true, stacksDir: fixed });
  record('info', 'system', `Fixed the New Stacks location: ${fixed} (it was saved without its leading /)`);
  return fixed;
}
