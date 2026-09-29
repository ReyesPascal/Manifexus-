import { useEffect, useState } from 'react';
import type { ManifexusConfig } from './types';

/**
 * How the person likes Manifexus to look, shared by every screen: Simple or Advanced, and whether
 * to show the command behind each step. Set from the saved settings; screens read it with usePrefs().
 */
export interface Prefs {
  advanced: boolean;
  showCommands: boolean;
}

let prefs: Prefs = { advanced: false, showCommands: false };
const listeners = new Set<() => void>();

export function setPrefsFromConfig(cfg: Partial<ManifexusConfig> | null | undefined) {
  const advanced = cfg?.experienceMode === 'advanced';
  const next = { advanced, showCommands: cfg?.showCommands ?? advanced };
  if (next.advanced === prefs.advanced && next.showCommands === prefs.showCommands) return;
  prefs = next;
  listeners.forEach((l) => l());
}

export function usePrefs(): Prefs {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return prefs;
}
