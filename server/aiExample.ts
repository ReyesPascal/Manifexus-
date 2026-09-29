/**
 * Version 1.1 comes with a real problem for the built-in AI to fix: the "New stacks folder"
 * setting is saved without its leading slash (home/ryan/stacks instead of /home/ryan/stacks), so
 * Manifexus can't use it. Diagnostics puts it on the To Fix list, and Fix with AI finds the
 * setting in Manifexus's settings file and puts the slash back. It's harmless while broken:
 * new stacks still go where most of your stacks already are. Done once, on the first start.
 */
import { getConfig, saveConfig } from './storageService';
import { getContainersList } from './dockerService';
import { getDefaultHostStacksBaseDir } from './stackService';

export async function seedAiExample(): Promise<void> {
  const config = getConfig();
  if (config.aiExampleSeeded) return;
  const { containers } = await getContainersList();
  const folder = ((config.stacksDir || '').trim() || getDefaultHostStacksBaseDir(containers)).replace(/\/+$/, '');
  const broken = folder.replace(/^\/+/, '');
  saveConfig(broken ? { aiExampleSeeded: true, stacksDir: broken } : { aiExampleSeeded: true });
  if (broken) console.log(`[AI example] New stacks folder saved as "${broken}" for the built-in AI to fix`);
}
