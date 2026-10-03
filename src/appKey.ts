import type { DeepContainerMetadata } from './types';

/**
 * How an app is known while it moves: its stack (empty for "Not in a Stack", apps started with docker run)
 * and its name in that stack (its container name when it isn't in one).
 */
export const appProject = (c: Pick<DeepContainerMetadata, 'compose'>) => (c.compose?.isCompose && c.compose.project) || '';
export const appService = (c: Pick<DeepContainerMetadata, 'compose' | 'cleanName' | 'name'>) =>
  c.compose?.service || (c.cleanName || c.name || '').replace(/^\//, '');
