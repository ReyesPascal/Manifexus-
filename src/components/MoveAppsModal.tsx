import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { enter } from '../motion';
import { AutomationPrivileges, DeepContainerMetadata, EmptyComposeStack, StackMergePlan } from '../types';
import { ProgressView, useRun } from './ProgressTracker';
import { AppIcon } from './AppCard';
import {
  Alert,
  AppTile,
  Button,
  Checkmark,
  FieldRow,
  Group,
  IconTile,
  LinkButton,
  Row,
  SectionFooter,
  SectionHeader,
  SelectCircle,
  StackGlyph,
  Switch,
  ios,
  sheetBackdropClass,
  sheetPanelClass,
  sheetPanelStyle,
  sheetBodyStyle,
  ScrollEdges,
  sheetFooterClass,
} from './ui/ios';

/**
 * Move apps between stacks (Apple-style sheet).
 *
 * Entry points:
 *   - Stack "Add apps"               -> destination fixed to that stack, starts at the app list
 *   - App card "Move to another stack" -> that app selected, starts at the stack list
 *
 * Nothing is preselected except the app the user started from. Data is backed up by default;
 * turning that off needs a confirmation and turns the backup row red.
 */

interface MoveAppsModalProps {
  isOpen: boolean;
  onClose: () => void;
  containers: DeepContainerMetadata[];
  /** Names you gave stacks on the dashboard, by folder name */
  stackNames?: Record<string, string>;
  /** Databases and caches, by id, mapped to the app they belong to: they move with it and aren't listed */
  linkedTo?: Map<string, string>;
  emptyStacks?: EmptyComposeStack[];
  /** Folder new stacks go in by default (reported by the server) */
  defaultStacksDir?: string;
  initialDestination?: string;
  initialAppId?: string;
  privileges?: AutomationPrivileges | null;
  onOpenAutomationModal?: () => void;
  onMoved?: () => void;
}

type Page = 'destination' | 'apps' | 'review' | 'data' | 'compose' | 'progress';

type Destination = { kind: 'existing'; project: string } | { kind: 'new' };

interface StackInfo {
  project: string;
  workingDir?: string;
  apps: DeepContainerMetadata[];
}

interface Footprint {
  project: string;
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
  if (!bytes || bytes < 1024) return `${bytes || 0} bytes`;
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

/** "a", "a and b", "a, b and c" */
const listJoin = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

const appName = (a: DeepContainerMetadata) => (a.customName || a.friendlyName || a.cleanName || '').replace(/^\//, '');

const ShieldGlyph: React.FC<{ off?: boolean }> = ({ off }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
    {off ? <path d="m4 4 16 16" /> : <path d="m9 12 2 2 4-4" />}
  </svg>
);

const BangGlyph: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
    <path d="M12 6v8M12 18.5v.01" />
  </svg>
);

const PlusGlyph: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const MoveAppsModal: React.FC<MoveAppsModalProps> = ({
  isOpen,
  onClose,
  containers,
  stackNames = {},
  linkedTo,
  emptyStacks = [],
  defaultStacksDir,
  initialDestination,
  initialAppId,
  privileges,
  onOpenAutomationModal,
  onMoved,
}) => {
  const [page, setPage] = useState<Page>('destination');
  const [destination, setDestination] = useState<Destination | null>(null);
  const [newName, setNewName] = useState('');
  const [newDir, setNewDir] = useState('');
  const [newDirEdited, setNewDirEdited] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');

  const [plan, setPlan] = useState<StackMergePlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [backupData, setBackupData] = useState(true);
  const [confirmNoBackup, setConfirmNoBackup] = useState(false);
  const [footprints, setFootprints] = useState<Footprint[] | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);

  const [copied, setCopied] = useState(false);
  const move = useRun();

  const bodyRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------
  const apps = useMemo(() => containers.filter((c) => !isManifexusContainer(c) && !linkedTo?.has(c.id)), [containers, linkedTo]);
  // What actually moves: the chosen apps plus their databases and caches
  const withLinked = useCallback(
    (ids: string[]) => [...ids, ...Array.from(linkedTo || []).filter(([, parent]) => ids.includes(parent)).map(([id]) => id)],
    [linkedTo]
  );
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

  const parentDir = useMemo(() => {
    if (defaultStacksDir) return defaultStacksDir.replace(/\/+$/, '');
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
  }, [defaultStacksDir, stacks]);

  const newSlug = slugify(newName);
  const destName = destination ? (destination.kind === 'existing' ? destination.project : newSlug) : '';
  const destDir =
    destination?.kind === 'existing' ? stackByName.get(destination.project)?.workingDir : destination?.kind === 'new' ? newDir : undefined;

  const newNameError = useMemo(() => {
    if (destination?.kind !== 'new') return null;
    if (!newSlug) return 'Enter a name for the new stack.';
    if (newSlug.length < 2) return 'Use at least 2 letters or numbers.';
    if (newSlug === 'manifexus') return 'That name is reserved.';
    if (stackByName.has(newSlug)) return `${newSlug} already exists. Choose it from the list above.`;
    if (!newDir.trim().startsWith('/')) return 'The location must be a full path, like /home/you/stacks/media.';
    return null;
  }, [destination, newSlug, newDir, stackByName]);
  const destinationReady = Boolean(destination) && !newNameError;

  const isInDestination = useCallback(
    (a: DeepContainerMetadata) =>
      destination?.kind === 'existing' && Boolean(a.compose?.isCompose) && a.compose.project === destination.project,
    [destination]
  );

  const selectedApps = useMemo(
    () => selected.map((id) => appById.get(id)).filter((a): a is DeepContainerMetadata => Boolean(a)),
    [selected, appById]
  );

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
      setConfirmNoBackup(false);
      move.reset();
      setNewName('');
      setNewDirEdited(false);
      setNewDir('');
      if (initialDestination && stackByName.has(initialDestination)) {
        setDestination({ kind: 'existing', project: initialDestination });
        setSelected([]);
        setPage('apps');
      } else {
        setDestination(null);
        setSelected(initialAppId && appById.has(initialAppId) ? [initialAppId] : []);
        setPage('destination');
      }
    }
    wasOpen.current = isOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Keep the default folder in step with the name until the user edits it
  useEffect(() => {
    if (!newDirEdited) setNewDir(`${parentDir}/${newSlug || 'new-stack'}`);
  }, [newSlug, parentDir, newDirEdited]);

  // Apps already in the chosen stack can't be moved there
  useEffect(() => {
    if (destination?.kind === 'existing') {
      setSelected((prev) => prev.filter((id) => {
        const a = appById.get(id);
        return a ? !isInDestination(a) : false;
      }));
    }
  }, [destination, appById, isInDestination]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [page]);

  // ---------------------------------------------------------------------------
  // Review data
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isOpen || page !== 'review' || !destination || selected.length === 0 || !destDir) return;
    let cancelled = false;
    setPlan(null);
    setPlanError(null);
    setPlanLoading(true);
    fetch('/api/stacks/plan-merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceContainerIds: withLinked(selected),
        targetStackName: destName,
        targetDirectory: destDir,
        mode: destination.kind === 'existing' ? 'existing-stack' : 'new-stack',
        volumeHandling: 'preserve-absolute',
      }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'The move could not be prepared.');
        if (!cancelled) setPlan(data);
      })
      .catch((err) => !cancelled && setPlanError((err as Error).message))
      .finally(() => !cancelled && setPlanLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, page === 'review', destName, destDir, selected.join(',')]);

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
    if (!isOpen || page !== 'review' || involvedStacks.length === 0) return;
    let cancelled = false;
    setFootprints(null);
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
      .catch(() => !cancelled && setFootprints([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, page === 'review', involvedStacks.map((s) => s.project).join(',')]);

  const backupTotal = footprints?.reduce((s, f) => s + f.totalBytes, 0) ?? 0;
  const notEnoughSpace = backupData && freeBytes !== null && footprints !== null && backupTotal > freeBytes;

  const emptiedStacks = useMemo(() => {
    const out: string[] = [];
    const bySource = new Map<string, number>();
    for (const a of selectedApps) {
      const p = a.compose?.isCompose ? a.compose.project : undefined;
      if (p) bySource.set(p, (bySource.get(p) || 0) + 1);
    }
    bySource.forEach((n, p) => {
      if ((stackByName.get(p)?.apps.length || 0) === n) out.push(p);
    });
    return out;
  }, [selectedApps, stackByName]);

  const portConflicts = plan?.portConflicts?.filter((c) => c.conflict) || [];
  const canRun = privileges ? Boolean(privileges.allowChanges) : true;

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  const entryPage: Page = initialDestination ? 'apps' : 'destination';

  const toggleApp = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const startMove = () => {
    if (!plan) return;
    setPage('progress');
    void move.start('/api/stacks/execute-merge-stream', {
      sourceContainerIds: withLinked(selected),
      targetStackName: plan.targetStackName,
      targetDirectory: plan.targetDirectory,
      yamlContent: plan.generatedComposeYaml,
      backupData,
    });
  };

  const setBackup = (on: boolean) => {
    if (on) setBackupData(true);
    else setConfirmNoBackup(true);
  };

  const back: { label: string; go: () => void } | null = (() => {
    switch (page) {
      case 'data':
      case 'compose':
        return { label: 'Review', go: () => setPage('review') };
      case 'review':
        return { label: 'Apps', go: () => setPage('apps') };
      case 'apps':
        return entryPage === 'apps' ? null : { label: 'Stacks', go: () => setPage('destination') };
      case 'destination':
        return entryPage === 'destination' ? null : { label: 'Apps', go: () => setPage('apps') };
      default:
        return null;
    }
  })();

  const primary = (() => {
    if (page === 'destination') {
      return {
        label: 'Next',
        disabled: !destinationReady,
        go: () => setPage(selected.length > 0 ? 'review' : 'apps'),
      };
    }
    if (page === 'apps') {
      return {
        label: 'Next',
        disabled: selected.length === 0,
        go: () => setPage(destinationReady ? 'review' : 'destination'),
      };
    }
    if (page === 'review') {
      return {
        label: planLoading ? 'Preparing…' : `Move ${plural(selected.length, 'App')}`,
        disabled: planLoading || !plan || Boolean(planError) || !canRun || (plan?.blockers?.length || 0) > 0,
        go: startMove,
      };
    }
    return null;
  })();

  const titles: Record<Page, string> = {
    destination: 'Choose a Stack',
    apps: 'Choose Apps',
    review: 'Review',
    data: 'Data Locations',
    compose: 'Compose File',
    progress: move.state.status === 'done' ? 'Done' : move.state.status === 'running' ? 'Moving Apps' : 'Move Apps',
  };
  const title = titles[page as Page];

  // Esc goes back, or closes on the first page (alerts handle their own Esc)
  useEffect(() => {
    if (!isOpen || page === 'progress' || confirmNoBackup) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (back) back.go();
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, page, confirmNoBackup, back, onClose]);

  if (!isOpen) return null;

  // ---------------------------------------------------------------------------
  // Pieces
  // ---------------------------------------------------------------------------
  const filterApp = (a: DeepContainerMetadata) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [a.cleanName, a.customName, a.image, a.compose?.project].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  };

  const appGroups = (() => {
    const groups: { key: string; title: string; apps: DeepContainerMetadata[] }[] = [];
    for (const s of stacks) {
      if (destination?.kind === 'existing' && s.project === destination.project) continue;
      const list = s.apps.filter(filterApp);
      if (list.length) groups.push({ key: s.project, title: s.project, apps: list });
    }
    const loose = apps.filter((a) => !(a.compose?.isCompose && a.compose.project)).filter(filterApp);
    if (loose.length) groups.push({ key: '__standalone', title: 'Not in a stack', apps: loose });
    return groups;
  })();
  const alreadyHere = destination?.kind === 'existing' ? stackByName.get(destination.project)?.apps.length || 0 : 0;

  /** The summary under the title: "qbittorrent and lidarr → utilities-stack" */
  const summary = page === 'destination' || page === 'apps' || page === 'review' ? (
    <p className="mt-1 text-[13px] text-center truncate px-10" style={{ color: ios.secondary }}>
      <button
        type="button"
        onClick={() => setPage('apps')}
        className="hover:underline underline-offset-2 rounded focus-visible:outline-2 focus-visible:outline-[#0A84FF]"
        style={{ color: selectedApps.length ? ios.label : ios.secondary }}
      >
        {selectedApps.length === 0
          ? 'No apps yet'
          : selectedApps.length <= 2
            ? listJoin(selectedApps.map(appName))
            : `${appName(selectedApps[0])} and ${selectedApps.length - 1} more`}
      </button>
      <span className="mx-1.5" aria-hidden="true">→</span>
      <span className="sr-only">into</span>
      <button
        type="button"
        onClick={() => setPage('destination')}
        className="hover:underline underline-offset-2 rounded focus-visible:outline-2 focus-visible:outline-[#0A84FF]"
        style={{ color: destName ? ios.purple : ios.secondary }}
      >
        {destName || 'No stack yet'}
      </button>
    </p>
  ) : null;

  // ---------------------------------------------------------------------------
  // Pages
  // ---------------------------------------------------------------------------
  const destinationPage = (
    <div className="space-y-7">
      <section>
        <SectionHeader>Stacks</SectionHeader>
        <Group className="ios-inset-icon">
          {stacks.map((s) => {
            const chosen = destination?.kind === 'existing' && destination.project === s.project;
            const current = selectedApps.length > 0 && selectedApps.every((a) => a.compose?.isCompose && a.compose.project === s.project);
            return (
              <Row
                key={s.project}
                onClick={() => setDestination({ kind: 'existing', project: s.project })}
                disabled={current}
                role="radio"
                ariaChecked={chosen}
                leading={
                  <IconTile color={ios.purple}>
                    <StackGlyph />
                  </IconTile>
                }
                title={stackNames[s.project] || s.project}
                trailing={
                  <>
                    <span className="text-[15px]">{current ? 'Current' : s.apps.length === 0 ? 'Empty' : plural(s.apps.length, 'app')}</span>
                    <span className="w-[15px] flex justify-center">{chosen && <Checkmark />}</span>
                  </>
                }
              />
            );
          })}
        </Group>
      </section>

      <section>
        {destination?.kind === 'new' ? (
          <>
            <SectionHeader>New Stack</SectionHeader>
            <Group>
              <FieldRow id="new-stack-name" label="Name" value={newName} onChange={setNewName} placeholder="media" autoFocus />
              <FieldRow
                id="new-stack-dir"
                label="Location"
                value={newDir}
                mono
                onChange={(v) => {
                  setNewDir(v);
                  setNewDirEdited(true);
                }}
              />
            </Group>
            {newNameError && newName ? (
              <SectionFooter>
                <span style={{ color: ios.orange }}>{newNameError}</span>
              </SectionFooter>
            ) : (
              <SectionFooter>The folder and its compose file are created on the server when you move apps into it.</SectionFooter>
            )}
          </>
        ) : (
          <Group className="ios-inset-icon">
            <Row
              onClick={() => setDestination({ kind: 'new' })}
              leading={
                <IconTile color={ios.blue}>
                  <PlusGlyph />
                </IconTile>
              }
              title="New Stack"
              titleColor={ios.blue}
            />
          </Group>
        )}
      </section>
    </div>
  );

  const appsPage = (
    <div className="space-y-6">
      <div className="relative">
        <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={ios.secondary} strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          aria-label="Search apps"
          className="w-full h-9 pl-8 pr-3 rounded-[10px] text-[15px] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF] placeholder:text-[rgba(235,235,245,0.6)]"
          style={{ background: ios.fill }}
        />
      </div>

      {appGroups.length === 0 && (
        <p className="text-[15px] text-center py-10" style={{ color: ios.secondary }}>
          {query ? `No apps match “${query}”.` : 'There are no other apps to move.'}
        </p>
      )}

      {appGroups.map((g) => {
        const ids = g.apps.map((a) => a.id);
        const allOn = ids.every((id) => selected.includes(id));
        return (
          <section key={g.key}>
            <SectionHeader
              action={
                g.apps.length > 1 ? (
                  <LinkButton
                    onClick={() =>
                      setSelected((prev) => (allOn ? prev.filter((id) => !ids.includes(id)) : Array.from(new Set([...prev, ...ids]))))
                    }
                  >
                    {allOn ? 'Deselect All' : 'Select All'}
                  </LinkButton>
                ) : undefined
              }
            >
              {g.title}
            </SectionHeader>
            <Group className="ios-inset-select">
              {g.apps.map((a) => {
                const on = selected.includes(a.id);
                return (
                  <Row
                    key={a.id}
                    onClick={() => toggleApp(a.id)}
                    role="checkbox"
                    ariaChecked={on}
                    leading={
                      <span className="flex items-center gap-3">
                        <SelectCircle on={on} />
                        <AppIcon container={a} size={29} />
                      </span>
                    }
                    title={appName(a)}
                    trailing={a.state !== 'running' ? <span style={{ color: ios.secondary }}>Stopped</span> : undefined}
                  />
                );
              })}
            </Group>
          </section>
        );
      })}

      {alreadyHere > 0 && !query && (
        <p className="px-4 text-[13px]" style={{ color: ios.secondary }}>
          {plural(alreadyHere, 'app')} already in {destName} {alreadyHere === 1 ? 'isn’t' : 'aren’t'} shown.
        </p>
      )}
    </div>
  );

  const summaryFooter = (() => {
    const parts: string[] = [`${selectedApps.length === 1 ? 'It restarts' : 'They restart'} once and keep${selectedApps.length === 1 ? 's' : ''} ${selectedApps.length === 1 ? 'its' : 'their'} data where it is.`];
    if (destination?.kind === 'new') parts.push(`A new folder is created at ${destDir}.`);
    if (emptiedStacks.length) parts.push(`${listJoin(emptiedStacks)} will be empty afterward and ${emptiedStacks.length === 1 ? 'stays' : 'stay'} on your dashboard until you delete ${emptiedStacks.length === 1 ? 'it' : 'them'}.`);
    return parts.join(' ');
  })();

  const reviewPage = (
    <div className="space-y-7">
      <section>
        <SectionHeader>
          Moving to {destName}
          {destination?.kind === 'new' ? ' (new)' : ''}
        </SectionHeader>
        <Group className="ios-inset-icon">
          {selectedApps.map((a) => (
            <Row
              key={a.id}
              leading={<AppIcon container={a} size={29} />}
              title={appName(a)}
              trailing={<span className="text-[15px]">{a.compose?.isCompose ? `from ${a.compose.project}` : 'standalone'}</span>}
            />
          ))}
        </Group>
        <SectionFooter>{summaryFooter}</SectionFooter>
      </section>

      {(plan?.blockers?.length || 0) > 0 && (
        <section>
          <Group className="ios-inset-icon">
            {plan!.blockers!.map((b, i) => (
              <Row
                key={`b${i}`}
                leading={
                  <IconTile color={ios.red}>
                    <BangGlyph />
                  </IconTile>
                }
                title="Can’t move this way"
                subtitle={b}
              />
            ))}
          </Group>
          <SectionFooter>Go back to Apps and select the missing app too, or leave these where they are.</SectionFooter>
        </section>
      )}

      {(plan?.warnings?.length || 0) > 0 && !(plan?.blockers?.length) && (
        <section>
          <Group className="ios-inset-icon">
            {plan!.warnings!.map((w, i) => (
              <Row
                key={`w${i}`}
                leading={
                  <IconTile color={ios.orange}>
                    <BangGlyph />
                  </IconTile>
                }
                title="Heads up"
                subtitle={w}
              />
            ))}
          </Group>
        </section>
      )}

      {portConflicts.length > 0 && (
        <section>
          <Group className="ios-inset-icon">
            {portConflicts.map((c) => (
              <Row
                key={c.port}
                leading={
                  <IconTile color={ios.orange}>
                    <BangGlyph />
                  </IconTile>
                }
                title={`Port ${c.port} is used twice`}
                subtitle={`${listJoin(c.services)} can’t both use it. One won’t start until you change a port.`}
              />
            ))}
          </Group>
        </section>
      )}

      <section>
        <Group className="ios-inset-icon">
          <Row
            leading={
              <IconTile color={backupData ? ios.green : ios.red}>
                <ShieldGlyph off={!backupData} />
              </IconTile>
            }
            title={backupData ? 'Back Up Data First' : 'Backup Off'}
            titleColor={backupData ? ios.label : ios.red}
            trailing={<Switch checked={backupData} onChange={setBackup} label="Back up data first" />}
          />
        </Group>
        {backupData ? (
          <SectionFooter>
            {footprints === null
              ? 'Measuring stack folders and volumes…'
              : `Saves about ${formatBytes(backupTotal)} from ${plural(footprints.length, 'stack')}${freeBytes !== null ? `. ${formatBytes(freeBytes)} free` : ''}.`}
            {notEnoughSpace && (
              <span className="block mt-1" style={{ color: ios.orange }}>
                There may not be enough space for this backup.
              </span>
            )}
          </SectionFooter>
        ) : (
          <SectionFooter tone="danger">
            App data won’t be backed up. If something goes wrong, only the compose files can be restored.{' '}
            <LinkButton onClick={() => setBackupData(true)}>Turn On Backup</LinkButton>
          </SectionFooter>
        )}
      </section>

      <section>
        <Group>
          <Row
            onClick={() => setPage('data')}
            disabled={!plan}
            title="Data Locations"
            trailing={plan ? <span>{plan.volumeSafetyAudit?.length || 0}</span> : undefined}
            chevron
          />
          <Row onClick={() => setPage('compose')} disabled={!plan} title="Compose File" chevron />
        </Group>
      </section>

      {!canRun && (
        <section>
          <Group className="ios-inset-icon">
            <Row
              leading={
                <IconTile color={ios.orange}>
                  <BangGlyph />
                </IconTile>
              }
              title="Server Changes is off"
              subtitle="Turn it on to move apps."
              trailing={onOpenAutomationModal ? <LinkButton onClick={onOpenAutomationModal}>Turn On</LinkButton> : undefined}
            />
          </Group>
        </section>
      )}

      {planError && (
        <p role="alert" className="px-4 text-[13px]" style={{ color: ios.redText }}>
          {planError}
        </p>
      )}
    </div>
  );

  const dataPage = plan && (
    <div className="space-y-7">
      <section>
        <Group>
          {(plan.volumeSafetyAudit || []).map((v, i) => (
            <Row
              key={`${v.service}-${i}`}
              title={
                <>
                  {v.service}
                  <span style={{ color: ios.secondary }}> · {v.type === 'named_volume' ? 'volume' : 'folder'}</span>
                </>
              }
              subtitle={
                <span className="font-mono text-[12px]">
                  {v.source} <span style={{ color: ios.secondary }}>→</span> {v.destination}
                </span>
              }
              trailing={v.verdict === 'requires_migration' ? <span style={{ color: ios.orange }}>Check</span> : undefined}
            />
          ))}
        </Group>
        <SectionFooter>Moved apps keep using these same locations. Nothing is copied or deleted.</SectionFooter>
      </section>
    </div>
  );

  const composePage = plan && (
    <section>
      <SectionHeader
        action={
          <LinkButton
            onClick={() => {
              navigator.clipboard.writeText(plan.generatedComposeYaml);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </LinkButton>
        }
      >
        {destDir}/docker-compose.yml
      </SectionHeader>
      <Group>
        <pre className="p-4 text-[12px] leading-[18px] font-mono overflow-x-auto" style={{ color: ios.secondary }}>
          {plan.generatedComposeYaml}
        </pre>
      </Group>
    </section>
  );

  const movingNames = selectedApps.map(appName);
  const movingLabel = movingNames.length <= 2 ? movingNames.join(' and ') : `${movingNames.length} apps`;
  const progressPage = (
    <ProgressView
      run={move.state}
      runningTitle={`Moving ${movingLabel} to ${plan?.targetStackName || destName}`}
      doneMessage={`${movingLabel} ${movingNames.length === 1 ? 'is' : 'are'} now in ${plan?.targetStackName || destName}. You can restore to before this move anytime from Restore.`}
      onDone={() => {
        onMoved?.();
        onClose();
      }}
      onClose={() => {
        onMoved?.();
        onClose();
      }}
    />
  );

  const content =
    page === 'progress'
      ? progressPage
      : page === 'destination'
        ? destinationPage
        : page === 'apps'
          ? appsPage
          : page === 'review'
            ? reviewPage
            : page === 'data'
              ? dataPage
              : composePage;

  // ---------------------------------------------------------------------------
  // Sheet
  // ---------------------------------------------------------------------------
  return (
    <div
      className={`${sheetBackdropClass} z-50`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !confirmNoBackup) onClose();
      }}
      style={{ fontFamily: ios.font }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-apps-title"
        ref={enter('sheet')}
        className={sheetPanelClass}
        style={sheetPanelStyle}
      >
        {/* Navigation bar */}
        <div className="relative px-4 pt-3.5 pb-3" style={{ borderBottom: `0.5px solid ${ios.separator}` }}>
          <div className="h-[28px] flex items-center justify-between">
            {back ? (
              <button
                type="button"
                onClick={back.go}
                className="-ml-1 inline-flex items-center gap-1 text-[17px] rounded focus-visible:outline-2 focus-visible:outline-[#0A84FF] hover:opacity-80"
                style={{ color: ios.link }}
              >
                <svg width="11" height="18" viewBox="0 0 11 18" aria-hidden="true">
                  <path d="M9 2 2 9l7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {back.label}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (page === 'progress') onMoved?.();
                  onClose();
                }}
                className="text-[17px] rounded focus-visible:outline-2 focus-visible:outline-[#0A84FF] hover:opacity-80"
                style={{ color: ios.link }}
              >
                {page === 'progress' ? 'Close' : 'Cancel'}
              </button>
            )}
            <span className="w-[60px]" />
          </div>
          <h2 id="move-apps-title" className="absolute left-1/2 top-3.5 -translate-x-1/2 h-[28px] flex items-center text-[17px] font-semibold text-white whitespace-nowrap">
            {title}
          </h2>
          {summary}
        </div>

        {/* Body */}
        <div className="relative flex-1 min-h-0 flex flex-col">
          <ScrollEdges />
          <div ref={bodyRef} className="mfx-sheet-body flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 pt-5 pb-10" style={sheetBodyStyle}>
            <div key={page} ref={page === 'data' || page === 'compose' ? enter('push') : undefined}>
              {content}
            </div>
          </div>
        </div>

        {/* Action bar */}
        {primary && (
          <div className={`${sheetFooterClass} flex justify-end`} style={{ borderTop: `0.5px solid ${ios.separator}` }}>
            <Button onClick={primary.go} disabled={primary.disabled} className="w-full sm:w-auto sm:min-w-[160px]">
              {primary.label}
            </Button>
          </div>
        )}
      </div>

      <Alert
        open={confirmNoBackup}
        title="Move without a backup?"
        message="If something goes wrong, the apps’ data can’t be restored. Compose files are still saved, so you can restore to before the move."
        confirmLabel="Turn Off"
        destructive
        onCancel={() => setConfirmNoBackup(false)}
        onConfirm={() => {
          setBackupData(false);
          setConfirmNoBackup(false);
        }}
      />

    </div>
  );
};
