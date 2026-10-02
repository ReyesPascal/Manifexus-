/**
 * The Backups status in plain words, shared by the header's Backups button and the Backups screen (kept apart
 * from the screen so the dashboard doesn't load the whole screen just to show the button's status).
 */
import { ios } from './ui/ios';

export interface StackBackup {
  project: string;
  dir?: string;
  lastAt?: string;
  lastOkAt?: string;
  bytes?: number;
  newBytes?: number;
  items?: { label: string; kind: 'folder' | 'volume' | 'database'; bytes: number }[];
  skipped?: { path: string; reason: string; bytes?: number }[];
  problem?: string;
}

export interface BackupsState {
  enabled: boolean;
  time: string;
  usable: boolean;
  unusableReason?: string;
  running?: { project: string; startedAt: string };
  queued: string[];
  stacks: StackBackup[];
  storeBytes: number;
  freeBytes: number | null;
  nextAt?: string;
}

export const fmtBytes = (b?: number) =>
  !b ? '0 KB' : b < 1024 ** 2 ? `${Math.max(1, Math.round(b / 1024))} KB` : b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0)} MB` : `${(b / 1024 ** 3).toFixed(1)} GB`;

/** "2 hours ago", "yesterday at 3:00 AM" */
export function whenAgo(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 12) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = new Date();
  if (d.toDateString() === day.toDateString()) return `today at ${t}`;
  day.setDate(day.getDate() - 1);
  if (d.toDateString() === day.toDateString()) return `yesterday at ${t}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${t}`;
}

function nextLabel(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.getHours() >= 18 ? `tonight at ${t}` : `today at ${t}`;
  today.setDate(today.getDate() + 1);
  return d.toDateString() === today.toDateString() && d.getHours() < 6 ? `tonight at ${t}` : `tomorrow at ${t}`;
}

/** The overall picture, for the header button and this screen */
export function backupSummary(s: BackupsState | null): { tone: 'ok' | 'busy' | 'attention' | 'off'; title: string; detail: string } {
  if (!s) return { tone: 'off', title: 'Backups', detail: '' };
  if (!s.usable) return { tone: 'attention', title: 'Backups Can’t Run', detail: s.unusableReason ? `The backup store can’t be used: ${s.unusableReason}.` : 'The backup store can’t be used.' };
  if (s.running) {
    const left = s.queued.length;
    return { tone: 'busy', title: `Backing Up ${s.running.project}…`, detail: left ? `${left} more stack${left === 1 ? '' : 's'} after this one.` : 'Your apps keep running while it works.' };
  }
  const problems = s.stacks.filter((x) => x.problem);
  const never = s.stacks.filter((x) => !x.lastOkAt && !x.problem);
  if (problems.length) return { tone: 'attention', title: `${problems.length} Stack${problems.length === 1 ? '' : 's'} Need${problems.length === 1 ? 's' : ''} Attention`, detail: 'The last backup didn’t finish. Details are below.' };
  if (!s.enabled) return { tone: 'off', title: 'Automatic Backups Are Off', detail: 'Moves and deletes still back up first. Turn this on to protect every stack.' };
  if (never.length) return { tone: 'busy', title: 'Getting Ready', detail: `${never.length} stack${never.length === 1 ? '' : 's'} will be backed up shortly.` };
  const last = s.stacks.map((x) => x.lastOkAt).filter(Boolean).sort().pop();
  return { tone: 'ok', title: 'All Stacks Backed Up', detail: `Last backup ${whenAgo(last)}${s.nextAt ? ` · next ${nextLabel(s.nextAt)}` : ''}.` };
}


export const toneColor = { ok: ios.green, busy: ios.blue, attention: ios.orange, off: '#8E8E93' };
