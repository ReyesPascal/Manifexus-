import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Layers,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { AutomationPrivileges, DeepContainerMetadata, EmptyComposeStack, StackMergePlan } from '../types';
import { ExecutionPipelineConsole } from './ExecutionPipelineConsole';

/**
 * Move apps between stacks.
 *
 * Entry points (each opens this modal already pointed at something):
 *   - Stack header "Add apps"        -> destination fixed to that stack, starts at the app picker
 *   - App card "Move to another stack" -> that app selected, starts at the destination picker
 *
 * The sentence at the top ("Move <apps> into <stack>") is both the summary and the navigation.
 * Nothing is preselected except the app the user explicitly started from.
 */

interface MoveAppsModalProps {
  isOpen: boolean;
  onClose: () => void;
  containers: DeepContainerMetadata[];
  emptyStacks?: EmptyComposeStack[];
  /** Open with this stack as the destination (from a stack's "Add apps") */
  initialDestination?: string;
  /** Open with this app selected (from an app card's "Move") */
  initialAppId?: string;
  privileges?: AutomationPrivileges | null;
  onOpenAutomationModal?: () => void;
  onMoved?: () => void;
}

type Stage = 'destination' | 'apps' | 'review';

type Destination =
  | { kind: 'existing'; project: string }
  | { kind: 'new'; name: string; dir: string; dirEdited: boolean };

interface StackInfo {
  project: string;
  workingDir?: string;
  apps: DeepContainerMetadata[];
}

interface Footprint {
  project: string;
  directoryBytes: number;
  volumes: { name: string; bytes: number }[];
  externalMounts: string[];
  totalBytes: number;
}

export function isManifexusContainer(c: DeepContainerMetadata): boolean {
  const clean = (c.cleanName || c.name || '').toLowerCase().replace(/^\//, '');
  const proj = (c.compose?.project || '').toLowerCase();
  const img = (c.image || '').toLowerCase();
  return clean === 'manifexus' || proj === 'manifexus' || img.includes('manifexus');
}

const slugify = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Small square app icon with a letter fallback, matching the dashboard cards. */
const AppIcon: React.FC<{ app: DeepContainerMetadata; size?: number }> = ({ app, size = 28 }) => {
  const [failed, setFailed] = useState(false);
  const label = (app.customName || app.cleanName || '?').replace(/^\//, '');
  return (
    <span
      className="inline-flex items-center justify-center rounded-lg bg-slate-800/80 border border-slate-700/60 overflow-hidden flex-shrink-0 text-[11px] font-bold text-slate-300"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {app.iconUrl && !failed ? (
        <img src={app.iconUrl} alt="" className="w-[70%] h-[70%] object-contain" onError={() => setFailed(true)} />
      ) : (
        label.slice(0, 2).toUpperCase()
      )}
    </span>
  );
};

const Disclosure: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({ title, hint, children }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-slate-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left text-sm text-slate-300 hover:text-white focus-visible:outline-2 focus-visible:outline-cyan-400 rounded-xl"
      >
        <span>
          {title}
          {hint && <span className="ml-2 text-slate-500">{hint}</span>}
        </span>
        <ChevronDown className={`w-4 h-4 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
};

/** One clickable part of the header sentence (apps or destination). */
const SentencePart: React.FC<{
  active: boolean;
  onClick: () => void;
  empty: string;
  children?: React.ReactNode;
  tone: 'app' | 'stack';
}> = ({ active, onClick, empty, children, tone }) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active ? 'step' : undefined}
    className={`group inline-flex flex-wrap items-center gap-1.5 min-h-[40px] px-2.5 py-1.5 rounded-xl border text-left transition-colors focus-visible:outline-2 focus-visible:outline-cyan-400 ${
      active
        ? tone === 'stack'
          ? 'border-purple-400/60 bg-purple-500/10'
          : 'border-cyan-400/60 bg-cyan-500/10'
        : 'border-slate-700/70 bg-slate-900/60 hover:border-slate-500'
    }`}
  >
    {children || <span className="text-slate-500 italic px-1">{empty}</span>}
  </button>
);

export const MoveAppsModal: React.FC<MoveAppsModalProps> = ({
  isOpen,
  onClose,
  containers,
  emptyStacks = [],
  initialDestination,
  initialAppId,
  privileges,
  onOpenAutomationModal,
  onMoved,
}) => {
  const [stage, setStage] = useState<Stage>('destination');
  const [destination, setDestination] = useState<Destination | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [newStackName, setNewStackName] = useState('');
  const [showFolderField, setShowFolderField] = useState(false);

  const [plan, setPlan] = useState<StackMergePlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [backupData, setBackupData] = useState(true);
  const [footprints, setFootprints] = useState<Footprint[] | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [footprintLoading, setFootprintLoading] = useState(false);

  const [copied, setCopied] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleMode, setConsoleMode] = useState<'merge' | 'revert'>('merge');
  const [consoleUrl, setConsoleUrl] = useState('/api/stacks/execute-merge-stream');
  const [consolePayload, setConsolePayload] = useState<Record<string, unknown>>({});
  const [consoleMergeId, setConsoleMergeId] = useState<string | undefined>(undefined);

  const searchRef = useRef<HTMLInputElement>(null);

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------
  const apps = useMemo(() => containers.filter((c) => !isManifexusContainer(c)), [containers]);
  const appById = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);

  const stacks = useMemo<StackInfo[]>(() => {
    const map = new Map<string, StackInfo>();
    for (const a of apps) {
      const p = a.compose?.isCompose ? a.compose.project : undefined;
      if (!p) continue;
      if (!map.has(p)) map.set(p, { project: p, workingDir: a.compose.workingDir, apps: [] });
      map.get(p)!.apps.push(a);
    }
    for (const es of emptyStacks as EmptyComposeStack[]) {
      if (es.project.toLowerCase() === 'manifexus' || map.has(es.project)) continue;
      map.set(es.project, { project: es.project, workingDir: es.workingDir, apps: [] });
    }
    return Array.from(map.values()).sort((a, b) => a.project.localeCompare(b.project));
  }, [apps, emptyStacks]);
  const stackByName = useMemo(() => new Map(stacks.map((s) => [s.project, s])), [stacks]);

  /** Where new stacks go: the folder most existing stacks share */
  const defaultParentDir = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of stacks) {
      if (!s.workingDir) continue;
      const parent = s.workingDir.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
      counts.set(parent, (counts.get(parent) || 0) + 1);
    }
    let best = '/opt/stacks';
    let bestCount = 0;
    counts.forEach((n, dir) => {
      if (n > bestCount) {
        best = dir;
        bestCount = n;
      }
    });
    return best;
  }, [stacks]);

  const destName = destination ? (destination.kind === 'existing' ? destination.project : slugify(destination.name)) : '';
  const destDir =
    destination?.kind === 'existing'
      ? stackByName.get(destination.project)?.workingDir
      : destination?.kind === 'new'
        ? destination.dir
        : undefined;

  const isInDestination = useCallback(
    (a: DeepContainerMetadata) =>
      destination?.kind === 'existing' && a.compose?.isCompose && a.compose.project === destination.project,
    [destination]
  );

  const selectedApps = useMemo(
    () => selected.map((id) => appById.get(id)).filter((a): a is DeepContainerMetadata => Boolean(a)),
    [selected, appById]
  );

  const newNameError = useMemo(() => {
    if (destination?.kind !== 'new') return null;
    const slug = slugify(destination.name);
    if (!slug) return 'Give the new stack a name.';
    if (slug.length < 2) return 'Use at least 2 letters or numbers.';
    if (stackByName.has(slug)) return `A stack called ${slug} already exists. Pick it from the list instead.`;
    if (slug === 'manifexus') return 'That name is reserved.';
    return null;
  }, [destination, stackByName]);

  const destinationReady = Boolean(destination) && !newNameError;

  // ---------------------------------------------------------------------------
  // Open / reset
  // ---------------------------------------------------------------------------
  const wasOpen = useRef(false);
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      setQuery('');
      setPlan(null);
      setPlanError(null);
      setFootprints(null);
      setBackupData(true);
      setConsoleOpen(false);
      setShowFolderField(false);
      setNewStackName('');
      if (initialDestination && stackByName.has(initialDestination)) {
        setDestination({ kind: 'existing', project: initialDestination });
        setSelected([]);
        setStage('apps');
      } else {
        setDestination(null);
        setSelected(initialAppId && appById.has(initialAppId) ? [initialAppId] : []);
        setStage('destination');
      }
    }
    wasOpen.current = isOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Esc closes (unless the progress console is open)
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !consoleOpen) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, consoleOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(() => {
      if (stage === 'apps') searchRef.current?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [stage, isOpen]);

  // Selecting a destination drops any selected apps that already live there
  useEffect(() => {
    if (destination?.kind === 'existing') {
      setSelected((prev) => prev.filter((id) => {
        const a = appById.get(id);
        return a ? !isInDestination(a) : false;
      }));
    }
  }, [destination, appById, isInDestination]);

  // ---------------------------------------------------------------------------
  // Review: build the plan and measure the backup
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isOpen || stage !== 'review' || !destination || selected.length === 0) return;
    let cancelled = false;
    setPlan(null);
    setPlanError(null);
    setPlanLoading(true);
    fetch('/api/stacks/plan-merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceContainerIds: selected,
        targetStackName: destName,
        targetDirectory: destDir,
        mode: destination.kind === 'existing' ? 'existing-stack' : 'new-stack',
        volumeHandling: 'preserve-absolute',
      }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not prepare the move.');
        if (!cancelled) setPlan(data);
      })
      .catch((err) => !cancelled && setPlanError((err as Error).message))
      .finally(() => !cancelled && setPlanLoading(false));
    return () => {
      cancelled = true;
    };
  }, [isOpen, stage, destination, selected, destName, destDir]);

  const involvedStacks = useMemo(() => {
    const list: { project: string; workingDir?: string }[] = [];
    if (destination?.kind === 'existing') list.push({ project: destination.project, workingDir: destDir });
    const seen = new Set(list.map((l) => l.project));
    for (const a of selectedApps) {
      const p = a.compose?.isCompose ? a.compose.project : undefined;
      if (p && !seen.has(p)) {
        seen.add(p);
        list.push({ project: p, workingDir: a.compose.workingDir });
      }
    }
    return list;
  }, [destination, destDir, selectedApps]);

  useEffect(() => {
    if (!isOpen || stage !== 'review' || !backupData || involvedStacks.length === 0) return;
    let cancelled = false;
    setFootprintLoading(true);
    fetch('/api/stacks/data-footprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stacks: involvedStacks }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setFootprints(d.footprints || []);
        setFreeBytes(typeof d.freeBytes === 'number' ? d.freeBytes : null);
      })
      .catch(() => !cancelled && setFootprints(null))
      .finally(() => !cancelled && setFootprintLoading(false));
    return () => {
      cancelled = true;
    };
  }, [isOpen, stage, backupData, involvedStacks]);

  const backupTotal = footprints?.reduce((s, f) => s + f.totalBytes, 0) ?? 0;
  const notEnoughSpace = backupData && freeBytes !== null && footprints !== null && backupTotal > freeBytes;

  // Stacks that lose apps, and whether they end up empty
  const sourceImpact = useMemo(() => {
    const bySource = new Map<string, { moving: DeepContainerMetadata[]; staying: DeepContainerMetadata[] }>();
    for (const a of selectedApps) {
      const p = a.compose?.isCompose ? a.compose.project : undefined;
      if (!p) continue;
      if (!bySource.has(p)) {
        const all = stackByName.get(p)?.apps || [];
        bySource.set(p, { moving: [], staying: all.filter((x) => !selected.includes(x.id)) });
      }
      bySource.get(p)!.moving.push(a);
    }
    return Array.from(bySource.entries()).map(([project, v]) => ({ project, ...v }));
  }, [selectedApps, stackByName, selected]);

  const portConflicts = plan?.portConflicts?.filter((c) => c.conflict) || [];
  const canRun = Boolean(privileges?.isSocketWritable ?? true);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  const toggleApp = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const chooseExisting = (project: string) => {
    setDestination({ kind: 'existing', project });
  };

  const chooseNew = () => {
    const name = newStackName;
    setDestination({ kind: 'new', name, dir: `${defaultParentDir}/${slugify(name) || 'new-stack'}`, dirEdited: false });
  };

  const updateNewName = (name: string) => {
    setNewStackName(name);
    setDestination((d) =>
      d && d.kind === 'new'
        ? { ...d, name, dir: d.dirEdited ? d.dir : `${defaultParentDir}/${slugify(name) || 'new-stack'}` }
        : d
    );
  };

  const startMove = () => {
    if (!plan) return;
    setConsoleMode('merge');
    setConsoleMergeId(undefined);
    setConsoleUrl('/api/stacks/execute-merge-stream');
    setConsolePayload({
      sourceContainerIds: selected,
      targetStackName: plan.targetStackName,
      targetDirectory: plan.targetDirectory,
      yamlContent: plan.generatedComposeYaml,
      backupData,
    });
    setConsoleOpen(true);
  };

  const primary = (() => {
    if (stage === 'destination') {
      if (selected.length > 0) return { label: 'Review move', disabled: !destinationReady, go: () => setStage('review') };
      return { label: 'Choose apps', disabled: !destinationReady, go: () => setStage('apps') };
    }
    if (stage === 'apps') {
      if (!destination) return { label: 'Choose a stack', disabled: selected.length === 0, go: () => setStage('destination') };
      return { label: 'Review move', disabled: selected.length === 0, go: () => setStage('review') };
    }
    return {
      label: planLoading ? 'Preparing…' : `Move ${plural(selected.length, 'app')}`,
      disabled: planLoading || !plan || Boolean(planError) || !canRun,
      go: startMove,
    };
  })();

  const back = (() => {
    if (stage === 'review') return () => setStage('apps');
    if (stage === 'apps' && !initialDestination) return () => setStage('destination');
    if (stage === 'destination' && initialDestination) return () => setStage('apps');
    return null;
  })();

  if (!isOpen) return null;

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------
  const filterApp = (a: DeepContainerMetadata) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [a.cleanName, a.customName, a.image, a.compose?.project, a.compose?.service]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  };

  const appGroups = (() => {
    const groups: { key: string; title: string; path?: string; apps: DeepContainerMetadata[] }[] = [];
    for (const s of stacks) {
      if (destination?.kind === 'existing' && s.project === destination.project) continue;
      const list = s.apps.filter(filterApp);
      if (list.length) groups.push({ key: s.project, title: s.project, path: s.workingDir, apps: list });
    }
    const loose = apps.filter((a) => !(a.compose?.isCompose && a.compose.project)).filter(filterApp);
    if (loose.length) groups.push({ key: '__standalone', title: 'Not in a stack', apps: loose });
    return groups;
  })();
  const alreadyHere = destination?.kind === 'existing' ? stackByName.get(destination.project)?.apps.length || 0 : 0;

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-6 bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-apps-title"
        className="w-full sm:max-w-3xl h-[92vh] sm:h-[min(820px,88vh)] flex flex-col bg-[#0d1220] border border-slate-800 sm:rounded-2xl rounded-t-2xl shadow-2xl shadow-black/60 text-slate-200"
      >
        {/* Header: the move sentence */}
        <div className="px-5 sm:px-7 pt-5 pb-4 border-b border-slate-800/80">
          <div className="flex items-start justify-between gap-4">
            <h2 id="move-apps-title" className="text-lg font-semibold text-white">
              Move apps
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-2 -mt-1 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-cyan-400"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[15px] text-slate-400">
            <span>Move</span>
            <SentencePart tone="app" active={stage === 'apps'} onClick={() => setStage('apps')} empty="choose apps">
              {selectedApps.length > 0 &&
                (selectedApps.length <= 3 ? (
                  selectedApps.map((a) => (
                    <span key={a.id} className="inline-flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-lg bg-slate-800 text-slate-100 text-sm">
                      <AppIcon app={a} size={20} />
                      {a.customName || a.cleanName}
                    </span>
                  ))
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-slate-100 text-sm">
                    <span className="flex -space-x-1.5">
                      {selectedApps.slice(0, 4).map((a) => (
                        <AppIcon key={a.id} app={a} size={20} />
                      ))}
                    </span>
                    {plural(selectedApps.length, 'app')}
                  </span>
                ))}
            </SentencePart>
            <span>into</span>
            <SentencePart
              tone="stack"
              active={stage === 'destination'}
              onClick={() => setStage('destination')}
              empty="choose a stack"
            >
              {destination && destName && (
                <span className="inline-flex items-center gap-1.5 px-1.5 text-sm text-slate-100">
                  <Layers className="w-4 h-4 text-purple-400" />
                  {destName}
                  {destination.kind === 'new' && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-purple-500/15 text-purple-300">new</span>
                  )}
                </span>
              )}
            </SentencePart>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-5">
          {/* ------------------------------ Destination ------------------------------ */}
          {stage === 'destination' && (
            <section aria-labelledby="dest-heading" className="space-y-4">
              <div>
                <h3 id="dest-heading" className="text-base font-semibold text-white">
                  Where should {selectedApps.length === 1 ? (selectedApps[0].customName || selectedApps[0].cleanName) : 'they'} go?
                </h3>
                <p className="text-sm text-slate-400 mt-1">Pick a stack, or start a new one.</p>
              </div>

              <ul className="space-y-2" role="list">
                {stacks.map((s) => {
                  const chosen = destination?.kind === 'existing' && destination.project === s.project;
                  const allAlreadyHere =
                    selectedApps.length > 0 && selectedApps.every((a) => a.compose?.isCompose && a.compose.project === s.project);
                  return (
                    <li key={s.project}>
                      <button
                        type="button"
                        disabled={allAlreadyHere}
                        onClick={() => chooseExisting(s.project)}
                        aria-pressed={chosen}
                        className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-colors focus-visible:outline-2 focus-visible:outline-purple-400 ${
                          chosen
                            ? 'border-purple-400/70 bg-purple-500/10'
                            : allAlreadyHere
                              ? 'border-slate-800 opacity-45 cursor-not-allowed'
                              : 'border-slate-800 hover:border-slate-600 hover:bg-slate-900/60'
                        }`}
                      >
                        <span
                          className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                            chosen ? 'bg-purple-500/20 text-purple-300' : 'bg-slate-800/80 text-purple-400/80'
                          }`}
                        >
                          <Layers className="w-[18px] h-[18px]" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="text-[15px] font-medium text-slate-100 truncate">{s.project}</span>
                            <span className="text-xs text-slate-500 flex-shrink-0">
                              {s.apps.length === 0 ? 'empty' : plural(s.apps.length, 'app')}
                            </span>
                          </span>
                          {s.workingDir && (
                            <span className="block text-xs font-mono text-slate-500 truncate mt-0.5">{s.workingDir}</span>
                          )}
                        </span>
                        {allAlreadyHere ? (
                          <span className="text-xs text-slate-500">Already here</span>
                        ) : (
                          <span
                            className={`w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 ${
                              chosen ? 'bg-purple-400 border-purple-400 text-slate-950' : 'border-slate-600'
                            }`}
                          >
                            {chosen && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}

                {/* New stack */}
                <li>
                  {destination?.kind === 'new' ? (
                    <div className="px-4 py-4 rounded-xl border border-purple-400/70 bg-purple-500/10 space-y-3">
                      <label htmlFor="new-stack-name" className="block text-sm font-medium text-slate-100">
                        New stack name
                      </label>
                      <input
                        id="new-stack-name"
                        autoFocus
                        value={newStackName}
                        onChange={(e) => updateNewName(e.target.value)}
                        placeholder="e.g. media"
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={Boolean(newNameError && newStackName)}
                        aria-describedby="new-stack-help"
                        className="w-full px-3.5 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-white text-[15px] placeholder:text-slate-600 focus:border-purple-400 focus:outline-none"
                      />
                      <p id="new-stack-help" className={`text-xs ${newNameError && newStackName ? 'text-amber-300' : 'text-slate-500'}`}>
                        {newNameError && newStackName ? (
                          newNameError
                        ) : (
                          <>
                            Created in <span className="font-mono text-slate-400">{destination.dir}</span>{' '}
                            {!showFolderField && (
                              <button
                                type="button"
                                onClick={() => setShowFolderField(true)}
                                className="text-purple-300 hover:text-purple-200 underline underline-offset-2"
                              >
                                Change folder
                              </button>
                            )}
                          </>
                        )}
                      </p>
                      {showFolderField && (
                        <div>
                          <label htmlFor="new-stack-dir" className="block text-xs text-slate-400 mb-1">
                            Folder on the server
                          </label>
                          <input
                            id="new-stack-dir"
                            value={destination.dir}
                            onChange={(e) =>
                              setDestination({ ...destination, dir: e.target.value, dirEdited: true })
                            }
                            spellCheck={false}
                            className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 text-sm font-mono focus:border-purple-400 focus:outline-none"
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={chooseNew}
                      className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-dashed border-slate-700 text-left text-slate-300 hover:border-purple-400/60 hover:text-white transition-colors focus-visible:outline-2 focus-visible:outline-purple-400"
                    >
                      <span className="w-9 h-9 rounded-lg flex items-center justify-center bg-slate-800/60 text-purple-300">
                        <Plus className="w-[18px] h-[18px]" />
                      </span>
                      <span className="text-[15px]">New stack</span>
                    </button>
                  )}
                </li>
              </ul>
            </section>
          )}

          {/* --------------------------------- Apps --------------------------------- */}
          {stage === 'apps' && (
            <section aria-labelledby="apps-heading" className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
                <div>
                  <h3 id="apps-heading" className="text-base font-semibold text-white">
                    {destination ? `Which apps should move into ${destName}?` : 'Which apps do you want to move?'}
                  </h3>
                  <p className="text-sm text-slate-400 mt-1">
                    Other apps in their current stacks keep running.
                  </p>
                </div>
                {selected.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelected([])}
                    className="self-start sm:self-auto text-sm text-slate-400 hover:text-white"
                  >
                    Clear selection
                  </button>
                )}
              </div>

              <div className="relative">
                <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search apps, images or stacks"
                  aria-label="Search apps"
                  className="w-full pl-10 pr-3 py-2.5 rounded-xl bg-slate-950/70 border border-slate-800 text-[15px] text-white placeholder:text-slate-600 focus:border-cyan-500/70 focus:outline-none"
                />
              </div>

              {appGroups.length === 0 && (
                <p className="text-sm text-slate-500 py-8 text-center">
                  {query ? `No apps match “${query}”.` : 'There are no other apps to move.'}
                </p>
              )}

              <div className="space-y-5">
                {appGroups.map((g) => {
                  const ids = g.apps.map((a) => a.id);
                  const allOn = ids.every((id) => selected.includes(id));
                  return (
                    <fieldset key={g.key}>
                      <div className="flex items-baseline justify-between gap-3 mb-2">
                        <legend className="flex items-baseline gap-2 min-w-0">
                          <span className="text-sm font-medium text-slate-300">{g.title}</span>
                          {g.path && <span className="text-xs font-mono text-slate-600 truncate">{g.path}</span>}
                        </legend>
                        {g.apps.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              setSelected((prev) =>
                                allOn ? prev.filter((id) => !ids.includes(id)) : Array.from(new Set([...prev, ...ids]))
                              )
                            }
                            className="text-xs text-cyan-300/90 hover:text-cyan-200 flex-shrink-0"
                          >
                            {allOn ? 'Deselect all' : 'Select all'}
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {g.apps.map((a) => {
                          const on = selected.includes(a.id);
                          const port = a.ports?.find((p) => p.publicPort)?.publicPort;
                          return (
                            <label
                              key={a.id}
                              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-cyan-400 ${
                                on ? 'border-cyan-400/60 bg-cyan-500/[0.07]' : 'border-slate-800 hover:border-slate-600'
                              }`}
                            >
                              <input type="checkbox" className="sr-only" checked={on} onChange={() => toggleApp(a.id)} />
                              <span
                                aria-hidden="true"
                                className={`w-[18px] h-[18px] rounded-md border flex items-center justify-center flex-shrink-0 ${
                                  on ? 'bg-cyan-400 border-cyan-400 text-slate-950' : 'border-slate-600'
                                }`}
                              >
                                {on && <Check className="w-3 h-3" strokeWidth={3.5} />}
                              </span>
                              <AppIcon app={a} />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-2">
                                  <span className="text-[15px] text-slate-100 truncate">{a.customName || a.cleanName}</span>
                                  <span
                                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${a.state === 'running' ? 'bg-emerald-400' : 'bg-slate-600'}`}
                                    title={a.state === 'running' ? 'Running' : 'Stopped'}
                                  />
                                </span>
                                <span className="block text-xs font-mono text-slate-500 truncate">
                                  {a.image}
                                  {port ? ` · :${port}` : ''}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                  );
                })}
              </div>

              {alreadyHere > 0 && !query && (
                <p className="text-xs text-slate-500">
                  {plural(alreadyHere, 'app')} already in {destName} {alreadyHere === 1 ? 'is' : 'are'} not listed.
                </p>
              )}
            </section>
          )}

          {/* -------------------------------- Review -------------------------------- */}
          {stage === 'review' && (
            <section aria-label="Review the move" className="space-y-5">

              {/* What moves */}
              <div className="rounded-xl border border-slate-800 divide-y divide-slate-800/80">
                {selectedApps.map((a) => {
                  const from = a.compose?.isCompose ? a.compose.project : 'not in a stack';
                  return (
                    <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                      <AppIcon app={a} size={32} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[15px] text-slate-100 truncate">{a.customName || a.cleanName}</div>
                        <div className="text-xs text-slate-500 truncate">
                          from <span className="text-slate-300">{from}</span>
                        </div>
                      </div>
                      <div className="text-xs font-mono text-slate-500 hidden sm:block">
                        {a.ports
                          ?.filter((p) => p.publicPort)
                          .slice(0, 3)
                          .map((p) => `:${p.publicPort}`)
                          .join(' ')}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* What else happens */}
              <ul className="space-y-2.5 text-sm text-slate-300" role="list">
                <li className="flex gap-2.5">
                  <Check className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                  <span>
                    {destination?.kind === 'new' ? (
                      <>
                        A new stack <b className="text-white font-medium">{destName}</b> is created in{' '}
                        <span className="font-mono text-slate-400">{destDir}</span>.
                      </>
                    ) : (
                      <>
                        The apps are added to <b className="text-white font-medium">{destName}</b>’s compose file. Its current apps are not
                        changed.
                      </>
                    )}
                  </span>
                </li>
                <li className="flex gap-2.5">
                  <Check className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                  <span>Each app keeps using its current data where it is. Nothing is copied or deleted.</span>
                </li>
                {sourceImpact.map((s) =>
                  s.staying.length === 0 ? (
                    <li key={s.project} className="flex gap-2.5">
                      <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                      <span>
                        <b className="text-white font-medium">{s.project}</b> will have no apps left. It stays as an empty stack you can
                        reuse or delete.
                      </span>
                    </li>
                  ) : (
                    <li key={s.project} className="flex gap-2.5">
                      <Check className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                      <span>
                        In <b className="text-white font-medium">{s.project}</b>,{' '}
                        {s.staying.map((x) => x.customName || x.cleanName).join(', ')} keep{s.staying.length === 1 ? 's' : ''} running.
                      </span>
                    </li>
                  )
                )}
                <li className="flex gap-2.5">
                  <Check className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                  <span>Moved apps restart once. You can undo the whole move from History.</span>
                </li>
              </ul>

              {portConflicts.length > 0 && (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-100">
                  <div className="flex items-center gap-2 font-medium text-amber-300">
                    <AlertTriangle className="w-4 h-4" />
                    {portConflicts.length === 1 ? 'Two apps use the same port' : 'Some apps use the same ports'}
                  </div>
                  <ul className="mt-1.5 space-y-1 text-amber-100/80">
                    {portConflicts.map((c) => (
                      <li key={c.port}>
                        Port <span className="font-mono">{c.port}</span>: {c.services.join(', ')}.{' '}
                        {c.recommendation ? c.recommendation : 'Only one of them can start until one port is changed.'}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Backup */}
              <div className={`rounded-xl border px-4 py-3.5 ${backupData ? 'border-emerald-500/30 bg-emerald-500/[0.04]' : 'border-slate-800'}`}>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={backupData}
                    onChange={(e) => setBackupData(e.target.checked)}
                    className="mt-1 w-4 h-4 accent-emerald-400"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-2 text-[15px] text-slate-100">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      Back up app data first
                    </span>
                    <span className="block text-sm text-slate-400 mt-1">
                      {!backupData ? (
                        'Compose files are still saved, so the move can be undone. App data is not copied.'
                      ) : footprintLoading || !footprints ? (
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Measuring stack folders and volumes…
                        </span>
                      ) : (
                        <>
                          Saves {footprints.length === 1 ? 'the stack folder' : 'the stack folders'} and volumes of{' '}
                          {footprints.map((f) => f.project).join(', ')}: about{' '}
                          <b className="text-slate-200 font-medium">{formatBytes(backupTotal)}</b> before compression
                          {freeBytes !== null && <> ({formatBytes(freeBytes)} free)</>}.
                        </>
                      )}
                    </span>
                    {notEnoughSpace && (
                      <span className="block text-sm text-amber-300 mt-1.5">
                        There may not be enough free space for this backup. Free up space or turn the backup off.
                      </span>
                    )}
                  </span>
                </label>
              </div>

              {planError && (
                <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-200">
                  {planError}
                </div>
              )}

              {!canRun && (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-100 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
                  <span>Manifexus needs write access to Docker to move apps.</span>
                  {onOpenAutomationModal && (
                    <button
                      type="button"
                      onClick={onOpenAutomationModal}
                      className="px-3 py-1.5 rounded-lg bg-amber-400 text-slate-950 text-sm font-medium hover:bg-amber-300"
                    >
                      Set up access
                    </button>
                  )}
                </div>
              )}

              {plan && (
                <div className="space-y-2">
                  {plan.volumeSafetyAudit?.length > 0 && (
                    <Disclosure title="Where each app’s data lives" hint={plural(plan.volumeSafetyAudit.length, 'mount')}>
                      <ul className="space-y-2 text-xs">
                        {plan.volumeSafetyAudit.map((v, i) => (
                          <li key={`${v.service}-${i}`} className="flex flex-col gap-0.5">
                            <span className="text-slate-300">
                              {v.service}
                              <span className="text-slate-500"> · {v.type === 'named_volume' ? 'volume' : 'folder'}</span>
                              {v.verdict === 'requires_migration' && <span className="text-amber-300"> · needs attention</span>}
                            </span>
                            <span className="font-mono text-slate-500 break-all">
                              {v.source} <span className="text-slate-600">→</span> {v.destination}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </Disclosure>
                  )}
                  <Disclosure title="New compose file" hint={`for ${plan.targetStackName}`}>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(plan.generatedComposeYaml);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }}
                        className="absolute right-2 top-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-800 text-xs text-slate-300 hover:text-white"
                      >
                        {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                      <pre className="p-3 pr-20 rounded-lg bg-black/40 text-[12px] leading-relaxed font-mono text-slate-300 overflow-x-auto max-h-72">
                        {plan.generatedComposeYaml}
                      </pre>
                    </div>
                  </Disclosure>
                </div>
              )}

              {planLoading && (
                <p className="flex items-center gap-2 text-sm text-slate-400">
                  <Loader2 className="w-4 h-4 animate-spin" /> Preparing the new compose file…
                </p>
              )}
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 sm:px-7 py-4 border-t border-slate-800/80 flex items-center justify-between gap-3">
          <div className="min-w-0 text-sm text-slate-500 truncate">
            {back ? (
              <button
                type="button"
                onClick={back}
                className="inline-flex items-center gap-1.5 px-3 py-2 -ml-3 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800/70"
              >
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
            ) : stage === 'apps' && selected.length > 0 ? (
              <span>{plural(selected.length, 'app')} selected</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={primary.go}
              disabled={primary.disabled}
              className="px-5 py-2.5 rounded-xl text-[15px] font-semibold transition-colors bg-cyan-400 text-slate-950 hover:bg-cyan-300 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
            >
              {primary.label}
            </button>
          </div>
        </div>
      </div>

      <ExecutionPipelineConsole
        isOpen={consoleOpen}
        onClose={() => setConsoleOpen(false)}
        title={consoleMode === 'merge' ? `Moving apps into ${plan?.targetStackName || destName}` : 'Undoing the move'}
        mode={consoleMode}
        mergeId={consoleMergeId}
        streamUrl={consoleUrl}
        streamPayload={consolePayload}
        onKeepChanges={() => {
          setConsoleOpen(false);
          onMoved?.();
          setTimeout(() => onMoved?.(), 2500);
          onClose();
        }}
        onTriggerRevert={(mergeId) => {
          setConsoleMode('revert');
          setConsoleMergeId(mergeId);
          setConsoleUrl(`/api/history/${mergeId}/revert-stream`);
          setConsolePayload({});
          setConsoleOpen(true);
        }}
        onSuccessDone={() => onMoved?.()}
      />
    </div>
  );
};
