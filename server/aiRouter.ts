/**
 * Automatic mode for Ask Manifexus: before the AI starts, work out what kind of request this is and
 * how hard it looks, then choose the model, how much it thinks, and what to look up for it
 * straight away. All of this is plain rules, so it costs no time: on a server without a graphics
 * card every extra AI round is tens of seconds, so the rules aim for the fewest, cheapest rounds
 * that still get a good answer, and save the big model and deep thinking for problems that need them.
 */
import type { SystemSpecs } from './systemSpecs';
import { quotedNames } from './aiDigest';
import { AiSettings, CatalogModel, catalogModel, fitsNow, modelFor, speedOf } from './aiService';

export type Task = 'question' | 'fix' | 'change' | 'check';
export type Effort = 'quick' | 'standard' | 'deep';
export type Think = boolean | 'low' | 'medium' | 'high';

export interface Lookup {
  name: string;
  args: Record<string, unknown>;
}

export interface Route {
  task: Task;
  effort: Effort;
  model: string;
  /** A bigger model to hand over to if the first one gets stuck */
  backup?: string;
  /** Plain words for why it chose this, shown with the answer */
  why: string;
  /** What to look up before the AI starts, so it doesn't spend a round asking for it */
  lookups: Lookup[];
}

const TASK_LABEL: Record<Task, string> = { question: 'Question', fix: 'Fix', change: 'Change', check: 'Check' };
const EFFORT_LABEL: Record<Effort, string> = { quick: 'Quick', standard: 'Standard', deep: 'Thorough' };
export const taskLabel = (t: Task) => TASK_LABEL[t];
export const effortLabel = (e: Effort) => EFFORT_LABEL[e];

const FIX_WORDS = /\b(fix|broken|repair|not working|doesn['’]?t work|won['’]?t (start|run|load|open)|fail(s|ed|ing)?|error|crash(es|ed|ing)?|keeps? (restarting|stopping|crashing)|down|issues?|problems?|wrong)\b/i;
const ACTION_VERBS = '(restart|start|stop|change|set|update|upgrade|move|edit|add|remove|delete|rename|open|expose|turn (on|off)|enable|disable|make|create|put|install|recreate|clean( up)?)';
const CHANGE_WORDS = new RegExp(`^\\s*(please\\s+)?${ACTION_VERBS}\\b`, 'i');
/** "Can you move kavita…", "I want to add…", "Help me restart…": requests, even with a question mark */
const REQUEST_WORDS = new RegExp(`^\\s*(please\\s+)?((can|could|would|will) you( please)?|i (want|need|would like|'d like) to|help me|let's|lets)\\s+(\\w+\\s+)?${ACTION_VERBS}\\b`, 'i');
const HARD_WORDS = /\b(why|keeps?|random(ly)?|sometimes|intermittent|slow(er)?|crash|loop|after (the |an )?update|still|again|didn['’]?t (work|help|fix)|not fixed|every time|can['’]?t figure|weird|strange)\b/i;
const DEEP_ASK = /\b(think (hard|carefully|deeply)|thorough(ly)?|in depth|deep dive|take your time|investigate)\b/i;
const QUICK_ASK = /\b(quick(ly)?|briefly|short answer|tl;?dr|in a word|one line)\b/i;
const LOG_WORDS = /\b(logs?|crash|error|exit|stopp?ed|restart|won['’]?t start|fail)/i;

/** Full paths to files that the question or the issue names, e.g. /home/ryan/manifexus/data/config.json */
function mentionedFiles(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s"'`(:])(\/[A-Za-z0-9._\-/]+)/g)) {
    const p = m[1].replace(/[.,:;)]+$/, '');
    const base = p.split('/').pop() || '';
    if (/\.[A-Za-z0-9]{1,8}$/.test(base) || /^\.env/.test(base)) out.add(p);
  }
  return Array.from(out).slice(0, 3);
}

/** Apps the question names (by their shown name, container name or compose service) */
function mentionedApps(text: string, apps: { cleanName: string; service?: string }[]): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const a of apps) {
    for (const n of [a.cleanName, a.service].filter(Boolean) as string[]) {
      if (n.length < 3) continue;
      const re = new RegExp(`(^|[^a-z0-9_-])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_-])`);
      if (re.test(lower)) {
        out.push(a.cleanName);
        break;
      }
    }
    if (out.length >= 2) break;
  }
  return out;
}

export async function planRoute(
  args: { question: string; focus?: string; history: { role: string; content: string }[]; apps: { cleanName: string; service?: string }[] },
  settings: AiSettings,
  specs: SystemSpecs,
  role?: 'quick' | 'fixer'
): Promise<Route | undefined> {
  const q = args.question.trim();
  const all = `${q}\n${args.focus || ''}`;
  const fromDiagnostics = /shows these issues to fix/i.test(args.focus || '');
  const issueCount = (args.focus || '').split('\n').filter((l) => l.startsWith('- ')).length;
  const prevFailed = args.history.slice(-4).some((m) => m.role === 'assistant' && /didn[’']t finish|didn[’']t work|went wrong|couldn[’']t/i.test(m.content));

  // What kind of request
  // "Is anything wrong?" is a question; "fix it" or "kavita won't start" asks for a fix
  const asking = /\?\s*$/.test(q) || /^\s*(is|are|was|were|what|which|why|how|when|where|who|does|do|did|can|could|should|will|would|has|have)\b/i.test(q);
  let task: Task = 'question';
  if (/^I made these changes myself/i.test(q)) task = 'check';
  else if (fromDiagnostics || /\b(fix|repair|solve|sort (it|this) out)\b/i.test(q) || (!asking && FIX_WORDS.test(q))) task = 'fix';
  else if (CHANGE_WORDS.test(q) || REQUEST_WORDS.test(q)) task = 'change';

  // How hard it looks
  const files = mentionedFiles(all);
  // "Manifexus Diagnostics", "Manifexus’s settings file": the issue text names Manifexus itself, not an app to look at
  const appsNamed = mentionedApps(`${q}\n${(args.focus || '').replace(/manifexus(['’]s)?/gi, '')}`, args.apps);
  const concrete = files.length > 0 || appsNamed.length > 0 || (fromDiagnostics && issueCount === 1);
  let hard = HARD_WORDS.test(q) || prevFailed || issueCount > 2 || (task === 'fix' && !concrete);
  if (fromDiagnostics && issueCount === 1 && !prevFailed) hard = false; // Diagnostics already says what's wrong and where
  let effort: Effort = task === 'question' ? (hard ? 'standard' : 'quick') : hard ? 'deep' : 'standard';
  if (task === 'check') effort = 'standard';
  if (DEEP_ASK.test(q)) effort = 'deep';
  else if (QUICK_ASK.test(q) && task === 'question') effort = 'quick';

  // Which model
  const quick = await modelFor('quick');
  const fixer = await modelFor('fixer');
  if (!quick && !fixer) return undefined;
  const light = quick || fixer!;
  const heavy = fixer || quick!;
  const mLight = catalogModel(light);
  const mHeavy = catalogModel(heavy);
  let model = light;
  let why: string;

  if (!settings.auto || role === 'fixer') {
    model = heavy;
    effort = settings.auto ? effort : 'standard';
    why = settings.auto ? 'You asked for the fixer.' : 'Automatic is off, so it always uses the fixer.';
  } else if (light === heavy) {
    why = `${nameOf(light)} is the only model downloaded, so it does everything; it thinks harder only where it helps.`;
  } else {
    const heavyFits = await fitsNow(heavy);
    // A basic quick model shouldn't plan changes if the fixer can run
    const wantHeavy = effort === 'deep' || ((task === 'fix' || task === 'change') && (mLight?.smarts || 2) < 2);
    // The fixer isn't worth it when it's far slower than the quick model for this machine
    const tooSlow = slowerBy(mHeavy, mLight, specs) > 4 && effort !== 'deep';
    if (wantHeavy && heavyFits.ok && !tooSlow) {
      model = heavy;
      why = effort === 'deep' ? `This looks tricky, so ${nameOf(heavy)} takes it and thinks it through.` : `${nameOf(heavy)} plans changes more reliably than ${nameOf(light)}.`;
    } else if (wantHeavy && !heavyFits.ok) {
      why = `${heavyFits.why}, so ${nameOf(light)} takes it and thinks it through instead.`;
    } else if (task === 'question') {
      why = `A ${effort === 'quick' ? 'quick question' : 'question'}: ${nameOf(light)} answers fastest.`;
    } else if (fromDiagnostics && issueCount === 1) {
      why = `Diagnostics already found where the problem is, so ${nameOf(light)} can fix it quickly. ${nameOf(heavy)} steps in if it gets stuck.`;
    } else {
      why = `${nameOf(light)} starts, since it’s quickest. ${nameOf(heavy)} steps in if it gets stuck.`;
    }
  }

  // Look up the obvious things now, all at once, instead of one AI round each
  const lookups: Lookup[] = [];
  // A setting the issue names ("stacksDir"): read only the lines around it, not the whole file
  const names = quotedNames(args.focus || q);
  for (const p of files) lookups.push({ name: 'read_file', args: names.length ? { path: p, around: names.join(', ') } : { path: p } });
  for (const a of appsNamed) {
    lookups.push({ name: 'app_details', args: { app: a } });
    if (task === 'fix' || LOG_WORDS.test(q)) lookups.push({ name: 'app_logs', args: { app: a, lines: 80 } });
  }
  if ((task === 'fix' || task === 'check') && !files.length && !appsNamed.length) lookups.push({ name: 'diagnostics', args: {} });
  if (/\b(anything wrong|is everything ok|health|status)\b/i.test(q) && !lookups.some((l) => l.name === 'diagnostics')) lookups.push({ name: 'diagnostics', args: {} });
  if (/\b(last change|what changed|recent(ly)?|went wrong|history)\b/i.test(q)) lookups.push({ name: 'activity', args: { only_problems: /\b(fail|wrong|problem)/i.test(q) } });
  if (/\bports?\b/i.test(q)) lookups.push({ name: 'docker_overview', args: {} });
  if (/\b(memory|ram|cpu|processor|disk|space|specs?)\b/i.test(q)) lookups.push({ name: 'server_specs', args: {} });

  return { task, effort, model, backup: model !== heavy && settings.auto ? heavy : undefined, why, lookups: lookups.slice(0, 5) };
}

const nameOf = (id: string) => catalogModel(id)?.name || id;

function slowerBy(a: CatalogModel | undefined, b: CatalogModel | undefined, specs: SystemSpecs): number {
  if (!a || !b) return 1;
  const sa = speedOf(a.id, specs);
  const sb = speedOf(b.id, specs);
  const t = (s: { prefill: number; gen: number }) => 1800 / s.prefill + 200 / s.gen;
  return t(sa) / t(sb);
}

/**
 * How much a round should think. Thinking is where the quality comes from on hard problems, and
 * where the time goes on a CPU (every thought is written out word by word), so:
 * quick → never; standard → only to recover from a mistake (or when a graphics card makes it cheap);
 * deep → whenever it has something to think about.
 */
export function thinkFor(model: string, effort: Effort, state: { hasEvidence: boolean; retry: boolean }, gpu: boolean): Think {
  const m = catalogModel(model);
  const levels = m?.thinking === 'levels';
  const on = effort === 'deep' ? state.hasEvidence || state.retry : effort === 'standard' ? state.retry || (gpu && state.hasEvidence) : false;
  if (!levels) return on;
  if (effort === 'deep') return state.retry || gpu ? 'high' : 'medium';
  if (on) return 'medium';
  return 'low';
}

export const thinkLabel = (t: Think) => (t === false ? 'no extra thinking' : t === true ? 'thinking it through' : `${t} thinking`);
