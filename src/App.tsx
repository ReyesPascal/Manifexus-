import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  FolderKanban,
  Layers,
  Server,
  AlertCircle,
  FolderOpen,
  Terminal,
  ExternalLink,
  PlusCircle,
  ChevronRight,
  ShieldAlert,
  FolderPlus,
  RefreshCw,
  Trash2,
  Plus,
} from 'lucide-react';
import {
  DeepContainerMetadata,
  SystemStatus,
  ManifexusConfig,
  UserGroup,
  AppOverride,
  EmptyComposeStack,
} from './types';
import { PortsSheet } from './components/PortsSheet';
import { SoftwareUpdateSheet, SoftwareUpdateState } from './components/SoftwareUpdateSheet';
import { ActivitySheet } from './components/ActivitySheet';
import { AppCard } from './components/AppCard';
import { helperParents, helpersByApp } from './appHelpers';
import { AppDetailsSheet } from './components/AppDetailsSheet';
import { AssistantSheet } from './components/AssistantSheet';
import { FixSheet, FixRequest } from './components/FixSheet';
import type { AiAction } from './components/aiShared';
import { setPrefsFromConfig } from './prefs';
import { FEATURES } from './features';
import { GroupManagerModal } from './components/GroupManagerModal';
import { SettingsModal } from './components/SettingsModal';
import { SimulateContainerModal } from './components/SimulateContainerModal';
import { MoveAppsModal } from './components/MoveAppsModal';
import { DeleteStackDialog, DeleteStackTarget } from './components/DeleteStackDialog';
import { HostAutomationModal } from './components/HostAutomationModal';
import { ManifexusHeroHeader } from './components/ManifexusHeroHeader';
import { LibraryBar, Shelf, FolderIcon, Health, TileGrid, ShelfNote, panelStyle, displayFont } from './components/Shelf';
import type { MenuItem } from './components/ui/ios';
import { ios } from './components/ui/ios';
import { RestoreSheet } from './components/RestoreSheet';
import { StackDetailsSheet } from './components/StackDetailsSheet';
import { CleanupSheet } from './components/CleanupSheet';
import { CreateStackModal } from './components/CreateStackModal';
import { WebTerminalModal } from './components/WebTerminalModal';
import { AutomationPrivileges } from './types';

export default function App() {
  const [containers, setContainers] = useState<DeepContainerMetadata[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [privileges, setPrivileges] = useState<AutomationPrivileges | null>(null);
  const [isAutomationModalOpen, setIsAutomationModalOpen] = useState(false);
  const [config, setConfig] = useState<ManifexusConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // UX & View state
  const [viewMode, setViewMode] = useState<'groups' | 'compose'>('compose');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped'>('all');

  // Modals state
  const [inspectContainer, setInspectContainer] = useState<DeepContainerMetadata | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isGroupManagerOpen, setIsGroupManagerOpen] = useState(false);
  const [isSimulateOpen, setIsSimulateOpen] = useState(false);
  const [isMergeModalOpen, setIsMergeModalOpen] = useState(false);
  const [isRestoreOpen, setIsRestoreOpen] = useState(false);
  const [isCreateStackModalOpen, setIsCreateStackModalOpen] = useState(false);
  const [emptyStacks, setEmptyStacks] = useState<EmptyComposeStack[]>([]);
  // Folder the server puts new stacks in (the parent most existing stacks share)
  const [defaultStacksDir, setDefaultStacksDir] = useState<string | undefined>(undefined);
  // Move apps flow: opened either for a destination stack ("Add apps") or for one app ("Move")
  const [moveInitialDestination, setMoveInitialDestination] = useState<string | undefined>(undefined);
  const [moveInitialAppId, setMoveInitialAppId] = useState<string | undefined>(undefined);
  const openMoveForStack = (project: string) => {
    setMoveInitialAppId(undefined);
    setMoveInitialDestination(project);
    setIsMergeModalOpen(true);
  };
  const openMoveForApp = (c: DeepContainerMetadata) => {
    setMoveInitialDestination(undefined);
    setMoveInitialAppId(c.id);
    setIsMergeModalOpen(true);
  };

  // A button the AI offered under an answer: close the AI screens and open that one, ready to go
  const handleAiAction = (a: AiAction) => {
    const app = a.appId ? containers.find((c) => c.id === a.appId) : undefined;
    setFixRequest(null);
    setAssistant({ open: false });
    setOverDetails(null);
    if (a.screen !== 'diagnostics' && a.screen !== 'app_details') setInspectContainer(null);
    switch (a.screen) {
      case 'move_app':
        if (app) openMoveForApp(app);
        break;
      case 'new_stack':
        setIsCreateStackModalOpen(true);
        break;
      case 'restore':
        setIsRestoreOpen(true);
        break;
      case 'diagnostics':
        if (manifexusHeroContainer) setInspectContainer(manifexusHeroContainer);
        break;
      case 'activity':
        setActivity({ open: true });
        break;
      case 'updates':
        setIsUpdatesOpen(true);
        break;
      case 'settings':
        setIsSettingsOpen(true);
        break;
      case 'app_details':
        if (app) setInspectContainer(app);
        break;
    }
  };

  // Directive 2 & 3: Web Terminal state
  const [isTerminalModalOpen, setIsTerminalModalOpen] = useState(false);
  const [terminalTargetFile, setTerminalTargetFile] = useState<string>('');
  const [terminalStackName, setTerminalStackName] = useState<string | undefined>(undefined);

  // Directive 5: Auto-Updater state
  const [deleteStackTarget, setDeleteStackTarget] = useState<DeleteStackTarget | null>(null);

  // Software Update: state comes from the server, which checks on its own schedule
  const [softwareUpdate, setSoftwareUpdate] = useState<SoftwareUpdateState | null>(null);
  const [isUpdatesOpen, setIsUpdatesOpen] = useState(false);
  const refreshSoftwareUpdate = useCallback(async () => {
    try {
      const r = await fetch('/api/system/update', { cache: 'no-store' });
      if (r.ok) setSoftwareUpdate(await r.json());
    } catch {
      // offline or restarting
    }
  }, []);
  useEffect(() => {
    refreshSoftwareUpdate();
    const t = setInterval(refreshSoftwareUpdate, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [refreshSoftwareUpdate]);

  // Activity: the record of everything Manifexus did. Any screen can open it on a specific
  // activity with window.dispatchEvent(new CustomEvent('manifexus:open-activity', { detail: { id } })).
  const [activity, setActivity] = useState<{ open: boolean; id?: string; filter?: string }>({ open: false });
  // A screen opened from Diagnostics / App Details sits on top of it, with a way back
  const [overDetails, setOverDetails] = useState<null | 'activity' | 'restore' | 'updates' | 'settings' | 'assistant'>(null);
  // Ask Manifexus (the built-in AI); `from` is the screen it was opened from, for its Back button
  const [assistant, setAssistant] = useState<{
    open: boolean;
    view?: 'setup' | 'settings';
    question?: string;
    focus?: string;
    from?: 'settings';
    /** Setting up the AI on the way to this fix: go back to it when setup is done */
    fixAfter?: FixRequest;
    /** Carry on a conversation started in Fix with AI */
    seed?: { question: string; answer: string };
  }>({ open: false });
  // Fix with AI: its own screen for one problem, start to finish
  const [fixRequest, setFixRequest] = useState<FixRequest | null>(null);
  // The badge compares server timestamps only (the newest failure vs. the newest one already seen),
  // so a browser clock that's off can't hide it or make it stick
  const [unseenFailure, setUnseenFailure] = useState(false);
  const lastFailureAt = useRef<string | undefined>(undefined);
  const SEEN_KEY = 'manifexus.activity.seenFailureAt';
  const markFailuresSeen = useCallback((upTo: string | undefined) => {
    if (upTo) {
      try {
        localStorage.setItem(SEEN_KEY, upTo);
      } catch {
        // storage unavailable
      }
    }
    setUnseenFailure(false);
  }, []);
  const refreshActivityBadge = useCallback(async (markSeen = false) => {
    try {
      const r = await fetch('/api/logs/stats', { cache: 'no-store' });
      if (!r.ok) return;
      const s: { lastFailureAt?: string } = await r.json();
      lastFailureAt.current = s.lastFailureAt;
      if (markSeen) return markFailuresSeen(s.lastFailureAt);
      let seen: string | null = null;
      try {
        seen = localStorage.getItem(SEEN_KEY);
      } catch {
        // storage unavailable
      }
      setUnseenFailure(Boolean(s.lastFailureAt && (!seen || s.lastFailureAt > seen)));
    } catch {
      // offline or restarting
    }
  }, [markFailuresSeen]);
  useEffect(() => {
    refreshActivityBadge();
    const t = setInterval(() => refreshActivityBadge(), 60 * 1000);
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      setActivity({ open: true, id });
      markFailuresSeen(lastFailureAt.current);
    };
    // A move or undo just finished: check straight away rather than waiting a minute
    const onFleetChange = () => setTimeout(() => refreshActivityBadge(), 1500);
    window.addEventListener('manifexus:open-activity', onOpen);
    window.addEventListener('manifexus:refresh_fleet', onFleetChange);
    return () => {
      clearInterval(t);
      window.removeEventListener('manifexus:open-activity', onOpen);
      window.removeEventListener('manifexus:refresh_fleet', onFleetChange);
    };
  }, [refreshActivityBadge, markFailuresSeen]);

  // Fetch Container Telemetry & System Status
  const fetchData = useCallback(async (showRefreshingState = false) => {
    if (showRefreshingState) setIsRefreshing(true);
    try {
      const [containersRes, statusRes, configRes] = await Promise.all([
        fetch('/api/containers'),
        fetch('/api/status'),
        fetch('/api/config'),
      ]);

      if (!containersRes.ok || !statusRes.ok) {
        throw new Error('Failed to communicate with Manifexus backend');
      }

      const containersData = await containersRes.json();
      const statusData = await statusRes.json();
      const configData = await configRes.json();

      setContainers(containersData.containers || []);
      setEmptyStacks(containersData.emptyStacks || []);
      if (containersData.defaultStacksDir) setDefaultStacksDir(containersData.defaultStacksDir);
      setSystemStatus(statusData);
      setConfig(configData);
      setError(null);
    } catch (err) {
      console.error('[Manifexus] Polling error:', err);
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
      if (showRefreshingState) setIsRefreshing(false);
    }
  }, []);

  // Fetch host automation privilege status (detects sandboxed vs elevated mode)
  const fetchPrivileges = useCallback(async () => {
    try {
      const res = await fetch('/api/system/privileges');
      if (res.ok) {
        const data = await res.json();
        setPrivileges(data);
      }
    } catch (err) {
      console.error('[Manifexus] Error fetching privileges:', err);
    }
  }, []);

  // Initial fetch and auto-refresh interval
  useEffect(() => {
    fetchData();
    fetchPrivileges();

    const intervalSeconds = config?.refreshIntervalSeconds || 10;
    const timer = setInterval(() => {
      fetchData(false);
    }, intervalSeconds * 1000);

    return () => clearInterval(timer);
  }, [fetchData, fetchPrivileges, config?.refreshIntervalSeconds]);

  // Execute container lifecycle action
  const handleContainerAction = async (
    containerId: string,
    action: 'start' | 'stop' | 'restart'
  ) => {
    const call = (id: string, a: 'start' | 'stop' | 'restart') =>
      fetch(`/api/containers/${id}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: a }) });
    try {
      // An app and its database or cache are one: they start, stop and restart together.
      // Linked parts start before the app, and stop after it.
      const linked = helpersOf.get(containerId) || [];
      if (action !== 'stop') await Promise.all(linked.map((h) => call(h.id, action === 'restart' && h.state !== 'running' ? 'start' : action)));
      const res = await call(containerId, action);
      if (action === 'stop') await Promise.all(linked.map((h) => call(h.id, 'stop')));
      // Refresh either way: a failed action can still have changed the app's state.
      // Failures are recorded in Activity, which lights up its badge.
      await fetchData(true);
      if (!res.ok) refreshActivityBadge();
    } catch (err) {
      console.error(`Failed to ${action} container:`, err);
    }
  };

  // Quick group assignment
  const handleAssignGroup = async (containerId: string, groupId: string) => {
    try {
      const res = await fetch(`/api/containers/${containerId}/override`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customGroup: groupId || undefined }),
      });
      if (res.ok) {
        await fetchData(false);
      }
    } catch (err) {
      console.error('Failed to assign group:', err);
    }
  };

  // Save deep customization override from Inspect modal
  const handleSaveOverride = async (containerId: string, override: AppOverride) => {
    try {
      const res = await fetch(`/api/containers/${containerId}/override`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(override),
      });
      if (res.ok) {
        await fetchData(true);
      }
    } catch (err) {
      console.error('Failed to save override:', err);
    }
  };

  // Quick set primary Web UI port from app card
  const handleSetPrimaryPort = async (containerId: string, port: number) => {
    try {
      const res = await fetch(`/api/containers/${containerId}/override`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customPort: port }),
      });
      if (res.ok) {
        await fetchData(true);
      }
    } catch (err) {
      console.error('Failed to set primary port:', err);
    }
  };

  // Save dashboard configuration (host IP, refresh interval)
  // Throws when the save didn't go through, so Settings can say so
  const handleSaveConfig = async (updated: Partial<ManifexusConfig>) => {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Couldn’t save settings.');
    setConfig(await res.json());
    void fetchData(false);
  };

  // Add / Edit Group
  const handleSaveGroup = async (group: Partial<UserGroup> & { id: string; name: string }) => {
    try {
      const res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(group),
      });
      if (res.ok) {
        await fetchData(false);
      }
    } catch (err) {
      console.error('Failed to save group:', err);
    }
  };

  // Delete Group
  const handleDeleteGroup = async (groupId: string) => {
    try {
      const res = await fetch(`/api/groups/${groupId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await fetchData(false);
      }
    } catch (err) {
      console.error('Failed to delete group:', err);
    }
  };

  // Spawn simulated container in demo mode
  const handleSimulateContainer = async (data: {
    name: string;
    image: string;
    port: number;
    composeProject?: string;
    serviceName?: string;
  }) => {
    try {
      const res = await fetch('/api/demo/simulate-new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData(true);
      }
    } catch (err) {
      console.error('Failed to simulate container:', err);
    }
  };

  // Directive 1: Hero Layout & Structural Self-Protection Filter
  const isManifexus = useCallback((c: DeepContainerMetadata) => {
    const clean = (c.cleanName || c.name || '').toLowerCase();
    const proj = (c.compose?.project || '').toLowerCase();
    const img = (c.image || '').toLowerCase();
    return clean === 'manifexus' || clean === '/manifexus' || proj === 'manifexus' || img.includes('manifexus');
  }, []);

  const manifexusHeroContainer = useMemo(() => {
    return containers.find(isManifexus);
  }, [containers, isManifexus]);

  // Databases and caches that belong to an app are shown inside that app, not as cards of their own
  const helperOf = useMemo(() => helperParents(containers.filter((c) => !isManifexus(c) && !c.isHidden)), [containers, isManifexus]);
  const helpersOf = useMemo(() => helpersByApp(containers, helperOf), [containers, helperOf]);

  // Filtered containers based on search and status
  // Your own groups, while that feature is shown
  const userGroups = useMemo(() => (FEATURES.groups ? config?.groups || [] : []), [config?.groups]);

  const filteredContainers = useMemo(() => {
    const matched = containers.filter((c) => {
      // Directive 1: Never show Manifexus in standard cards grid - rendered as Hero element
      if (isManifexus(c)) return false;

      // Status filter
      if (statusFilter === 'running' && c.state !== 'running') return false;
      if (statusFilter === 'stopped' && c.state === 'running') return false;

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = [c.customName, c.friendlyName, c.cleanName].some((n) => (n || '').toLowerCase().includes(q));
        const matchImage = c.image.toLowerCase().includes(q);
        const matchProject = (c.compose.project || '').toLowerCase().includes(q);
        const matchService = (c.compose.service || '').toLowerCase().includes(q);
        const matchPort = c.ports.some(
          (p) => String(p.publicPort || '').includes(q) || String(p.privatePort).includes(q)
        );
        const matchGroup = userGroups.some(
          (g) => g.id === c.customGroup && g.name.toLowerCase().includes(q)
        );

        if (!matchName && !matchImage && !matchProject && !matchService && !matchPort && !matchGroup) {
          return false;
        }
      }

      return !c.isHidden;
    });
    // A helper that matched shows its app instead (searching "postgres" finds the app using it)
    const ids = new Set<string>();
    const out: DeepContainerMetadata[] = [];
    for (const c of matched) {
      const parentId = helperOf.get(c.id);
      const show = parentId ? containers.find((x) => x.id === parentId) : c;
      if (!show || ids.has(show.id)) continue;
      if (parentId && statusFilter !== 'all') continue;
      ids.add(show.id);
      out.push(show);
    }
    return out;
  }, [containers, statusFilter, searchQuery, userGroups, helperOf]);

  // Summary numbers, computed from exactly what the dashboard shows as app cards
  // (not Manifexus itself, not apps hidden in Settings)
  const visibleApps = useMemo(() => containers.filter((c) => !isManifexus(c) && !c.isHidden && !helperOf.has(c.id)), [containers, isManifexus, helperOf]);
  const stats = useMemo(() => {
    const running = visibleApps.filter((c) => c.state === 'running').length;
    const stackNames = new Set<string>();
    for (const c of visibleApps) if (c.compose?.isCompose && c.compose.project) stackNames.add(c.compose.project);
    for (const s of emptyStacks) if (s.project.toLowerCase() !== 'manifexus') stackNames.add(s.project);
    // Host ports actually in use: running apps plus Manifexus's own port
    const ports = new Set<number>();
    for (const c of containers) {
      if (c.state !== 'running' || c.isHidden) continue;
      for (const p of c.ports) if (p.publicPort) ports.add(p.publicPort);
    }
    return { running, stopped: visibleApps.length - running, total: visibleApps.length, stacks: stackNames.size, ports: ports.size };
  }, [visibleApps, emptyStacks, containers]);
  const [isPortsOpen, setIsPortsOpen] = useState(false);
  const [stackDetails, setStackDetails] = useState<string | null>(null);
  const [isCleanupOpen, setIsCleanupOpen] = useState(false);

  // Grouped containers by Custom User Groups
  const groupedByUserCategories = useMemo(() => {
    const groupsMap: Record<string, DeepContainerMetadata[]> = {};
    const uncategorized: DeepContainerMetadata[] = [];

    const groupIds = new Set(userGroups.map((g) => g.id));

    for (const c of filteredContainers) {
      if (c.customGroup && groupIds.has(c.customGroup)) {
        if (!groupsMap[c.customGroup]) groupsMap[c.customGroup] = [];
        groupsMap[c.customGroup].push(c);
      } else {
        uncategorized.push(c);
      }
    }

    return { groupsMap, uncategorized };
  }, [filteredContainers, userGroups]);

  // Grouped containers by Docker Compose Stacks (including discovered empty stacks)
  const groupedByComposeStacks = useMemo(() => {
    const stacksMap: Record<
      string,
      { containers: DeepContainerMetadata[]; workingDir?: string; configFiles?: string; isEmpty?: boolean }
    > = {};
    const standalone: DeepContainerMetadata[] = [];

    // Pre-populate with discovered or provisioned empty stacks
    for (const es of emptyStacks) {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        if (!es.project.toLowerCase().includes(q)) {
          continue;
        }
      }
      stacksMap[es.project] = {
        containers: [],
        workingDir: es.workingDir,
        configFiles: es.configFiles,
        isEmpty: true,
      };
    }

    for (const c of filteredContainers) {
      if (c.compose.isCompose && c.compose.project) {
        const proj = c.compose.project;
        if (!stacksMap[proj]) {
          stacksMap[proj] = {
            containers: [],
            workingDir: c.compose.workingDir,
            configFiles: c.compose.configFiles,
          };
        }
        stacksMap[proj].containers.push(c);
        stacksMap[proj].isEmpty = false;
      } else {
        standalone.push(c);
      }
    }

    return { stacksMap, standalone };
  }, [filteredContainers, emptyStacks, searchQuery]);

  // Simple / Advanced and Show Commands, for every screen
  useEffect(() => setPrefsFromConfig(config), [config]);

  // Any screen can open a file in the terminal editor (e.g. Do It Myself guides)
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ file: string; stack?: string }>).detail;
      if (!d?.file) return;
      setTerminalTargetFile(d.file);
      setTerminalStackName(d.stack || d.file.split('/').slice(-2, -1)[0] || '');
      setIsTerminalModalOpen(true);
    };
    window.addEventListener('manifexus:open-terminal', onOpen);
    return () => window.removeEventListener('manifexus:open-terminal', onOpen);
  }, []);

  const hostAddress = config?.hostAddress || 'localhost';

  // One app card, the same everywhere
  const card = (c: DeepContainerMetadata, inStack = false) => (
    <AppCard
      key={c.id}
      inStack={inStack}
      container={c}
      helpers={helpersOf.get(c.id)}
      hostAddress={hostAddress}
      groups={userGroups}
      onInspect={setInspectContainer}
      onAssignGroup={handleAssignGroup}
      onAction={handleContainerAction}
      onSetPrimaryPort={handleSetPrimaryPort}
      onMoveApp={openMoveForApp}
    />
  );

  // Start, restart or stop every app in a stack or group
  const stackActionItems = (apps: DeepContainerMetadata[]): MenuItem[] => {
    if (!apps.length) return [];
    const run = (action: 'start' | 'stop' | 'restart', only: (c: DeepContainerMetadata) => boolean) =>
      void Promise.all(apps.filter(only).map((c) => handleContainerAction(c.id, action)));
    const anyStopped = apps.some((c) => c.state !== 'running');
    const anyRunning = apps.some((c) => c.state === 'running');
    return [
      ...(anyStopped ? [{ key: 'start-all', label: apps.length === 1 ? 'Start' : 'Start All', onSelect: () => run('start', (c) => c.state !== 'running') }] : []),
      ...(anyRunning
        ? [
            { key: 'restart-all', label: apps.length === 1 ? 'Restart' : 'Restart All', onSelect: () => run('restart', (c) => c.state === 'running') },
            { key: 'stop-all', label: apps.length === 1 ? 'Stop' : 'Stop All', destructive: true, onSelect: () => run('stop', (c) => c.state === 'running') },
          ]
        : []),
    ];
  };

  // Screens opened on top of Diagnostics: Back returns to it, Done closes both
  const detailsLabel = inspectContainer && manifexusHeroContainer && inspectContainer.id === manifexusHeroContainer.id ? 'Diagnostics' : 'App Details';
  const backProps = (which: 'activity' | 'restore' | 'updates' | 'settings' | 'assistant', close: () => void) =>
    overDetails === which
      ? {
          backLabel: detailsLabel,
          onBack: () => {
            close();
            setOverDetails(null);
          },
          onClose: () => {
            close();
            setOverDetails(null);
            setInspectContainer(null);
          },
        }
      : { onClose: close };

  return (
    <div className="min-h-screen bg-[#09090b] text-slate-100 flex flex-col font-sans selection:bg-[#0A84FF]/40">

      {/* Main Dashboard Canvas */}
      <main data-dashboard className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-6 py-6">
        {/* Directive 1: Hero Layout & Structural Protection for Manifexus */}
        <ManifexusHeroHeader
          container={manifexusHeroContainer}
          systemStatus={systemStatus}
          onInspectContainer={(c) => setInspectContainer(c)}
          versionLabel={softwareUpdate?.current.label}
          updateAvailable={softwareUpdate?.status === 'available'}
          updating={Boolean(softwareUpdate?.installing && ['download', 'prepare', 'restart'].includes(softwareUpdate.installing.stage))}
          onOpenUpdates={() => {
            setIsUpdatesOpen(true);
            refreshSoftwareUpdate();
          }}
          stackCount={stats.stacks}
          running={stats.running}
          stopped={stats.stopped}
          total={stats.total}
          portsInUse={stats.ports}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          onShowPorts={() => setIsPortsOpen(true)}
          onShowStacks={() => {
            setStatusFilter('all');
            setViewMode('compose');
          }}
          onOpenActivity={() => {
            setActivity({ open: true });
            markFailuresSeen(lastFailureAt.current);
          }}
          activityAlert={unseenFailure}
          onOpenRestore={() => setIsRestoreOpen(true)}
          onOpenCleanup={() => setIsCleanupOpen(true)}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onRefresh={() => {
            fetchData(true);
            fetchPrivileges();
          }}
          isRefreshing={isRefreshing}
          search={searchQuery}
          onSearch={setSearchQuery}
          onNewStack={() => setIsCreateStackModalOpen(true)}
        />

        {/* Standby / Demo Mode Notification Banner (Visible when socket is not attached) */}
        {systemStatus?.isDemoMode && (
          <div className="mb-6 p-4 rounded-2xl bg-gradient-to-r from-amber-950/40 via-slate-900/80 to-cyan-950/30 border border-amber-500/30 shadow-[0_0_20px_rgba(245,158,11,0.08)] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 font-mono text-xs">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div>
                <span className="font-bold text-amber-300 text-sm block">
                  Standby / Demonstration Fleet Active
                </span>
                <span className="text-slate-300">
                  To discover your live host containers, mount <code className="text-cyan-300 font-bold">/var/run/docker.sock:ro</code> when deploying Manifexus on your Ubuntu server.
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => setIsSimulateOpen(true)}
                className="px-3 py-1.5 rounded-lg bg-cyan-950/80 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-900/60 transition-colors flex items-center gap-1.5"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                <span>Simulate Event</span>
              </button>
            </div>
          </div>
        )}

        {/* The break between the header and the stacks */}
        <LibraryBar
          showGroups={FEATURES.groups}
          view={viewMode}
          onView={setViewMode}
          count={isLoading || searchQuery || statusFilter !== 'all' ? undefined : stats.stacks}
          filter={statusFilter}
          onClearFilter={() => setStatusFilter('all')}
          groupItems={[
            { key: 'group', label: 'New Group…', onSelect: () => setIsGroupManagerOpen(true) },
            ...(viewMode === 'groups' ? [{ key: 'edit', label: 'Edit Groups…', divider: true, onSelect: () => setIsGroupManagerOpen(true) }] : []),
          ]}
        />

        {/* Error Notification */}
        {error && (
          <div className="mb-5 px-4 py-3 rounded-[16px] flex items-center gap-3 text-[14px]" style={{ ...panelStyle, color: '#FF8A80' }}>
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span>Can’t reach Docker right now: {error}</span>
          </div>
        )}

        {/* LOADING STATE */}
        {isLoading && (
          <div className="py-24 flex flex-col items-center justify-center gap-3" style={{ color: 'rgba(235,235,245,0.6)' }}>
            <div className="w-7 h-7 border-2 border-white/15 border-t-white/70 rounded-full animate-spin" />
            <p className="text-[14px]">Loading your apps…</p>
          </div>
        )}

        {/* Nothing matches */}
        {!isLoading && filteredContainers.length === 0 && (searchQuery || statusFilter !== 'all') && (
          <div className="py-16 text-center rounded-[22px] px-6" style={panelStyle}>
            <h3 className="text-[19px] font-semibold text-white" style={{ fontFamily: displayFont }}>
              No Results
            </h3>
            <p className="mt-1 text-[14px]" style={{ color: 'rgba(235,235,245,0.6)' }}>
              {searchQuery ? `No apps match “${searchQuery}”.` : `No ${statusFilter} apps.`}
            </p>
          </div>
        )}
        {!isLoading && visibleApps.length === 0 && !searchQuery && statusFilter === 'all' && (
          <div className="py-16 text-center rounded-[22px] px-6 mb-4" style={panelStyle}>
            <h3 className="text-[19px] font-semibold text-white" style={{ fontFamily: displayFont }}>
              No Apps Yet
            </h3>
            <p className="mt-1 text-[14px]" style={{ color: 'rgba(235,235,245,0.6)' }}>
              Docker isn’t running any apps on this server yet.
            </p>
            {systemStatus?.isDemoMode && (
              <button onClick={() => setIsSimulateOpen(true)} className="mt-4 h-9 px-4 rounded-full text-[14px] font-semibold text-white" style={{ background: '#0A84FF' }}>
                Add a Sample App
              </button>
            )}
          </div>
        )}

        {/* BY GROUP */}
        {!isLoading && FEATURES.groups && viewMode === 'groups' && (
          <div className="space-y-4">
            {userGroups.map((group) => {
              const items = groupedByUserCategories.groupsMap[group.id] || [];
              if (items.length === 0 && (searchQuery || statusFilter !== 'all')) return null;
              return (
                <Shelf
                  key={group.id}
                  id={`group:${group.id}`}
                  title={group.name}
                  icon={<FolderIcon apps={items} tint={group.color} />}
                  status={<Health apps={items} empty={group.description || 'No apps yet'} />}
                  forceOpen={items.some((c) => c.state === 'restarting')}
                  menu={[
                    ...stackActionItems(items),
                    { key: 'edit', label: 'Edit Groups…', divider: items.length > 0, onSelect: () => setIsGroupManagerOpen(true) },
                  ]}
                >
                  {items.length > 0 ? (
                    <TileGrid>{items.map((c) => card(c))}</TileGrid>
                  ) : (
                    <ShelfNote>No apps in this group yet. Choose ⋯ on any app and pick {group.name}.</ShelfNote>
                  )}
                </Shelf>
              );
            })}
            {groupedByUserCategories.uncategorized.length > 0 && (
              <Shelf
                id="group:none"
                title="Not in a Group"
                icon={<FolderIcon apps={groupedByUserCategories.uncategorized} />}
                status={<Health apps={groupedByUserCategories.uncategorized} />}
                menu={stackActionItems(groupedByUserCategories.uncategorized)}
              >
                <TileGrid>{groupedByUserCategories.uncategorized.map((c) => card(c))}</TileGrid>
              </Shelf>
            )}
          </div>
        )}

        {/* BY STACK */}
        {!isLoading && viewMode === 'compose' && (
          <div className="space-y-4">
            {Object.entries(groupedByComposeStacks.stacksMap)
              .filter(([, d]) => d.containers.length > 0 || statusFilter === 'all')
              .map(([projectName, stackData]) => {
                const apps = stackData.containers;
                const composePath = stackData.configFiles?.split(',')[0] || (stackData.workingDir ? `${stackData.workingDir}/docker-compose.yml` : undefined);
                const own = projectName.toLowerCase() === 'manifexus';
                return (
                  <Shelf
                    key={projectName}
                    id={`stack:${projectName}`}
                    title={projectName}
                    icon={<FolderIcon apps={apps} />}
                    status={<Health apps={apps} alsoCheck={apps.flatMap((a) => helpersOf.get(a.id) || [])} />}
                    forceOpen={apps.some((c) => c.state === 'restarting' || c.state === 'dead')}
                    action={own ? undefined : { label: 'Add App', onClick: () => openMoveForStack(projectName), title: `Move apps into ${projectName}` }}
                    menu={[
                      ...stackActionItems(apps),
                      ...(composePath
                        ? [
                            {
                              key: 'compose',
                              label: 'Edit Compose File…',
                              divider: apps.length > 0,
                              onSelect: () => {
                                setTerminalTargetFile(composePath);
                                setTerminalStackName(projectName);
                                setIsTerminalModalOpen(true);
                              },
                            },
                          ]
                        : []),
                      { key: 'details', label: 'Stack Details', divider: !composePath && apps.length > 0, onSelect: () => setStackDetails(projectName) },
                      ...(own
                        ? []
                        : [
                            {
                              key: 'delete',
                              label: 'Delete Stack…',
                              destructive: true,
                              divider: true,
                              onSelect: () =>
                                setDeleteStackTarget({
                                  projectName,
                                  targetDirectory: stackData.workingDir,
                                  servicesCount: apps.length,
                                  apps: apps.map((c) => ({ id: c.id, name: (c.customName || c.friendlyName || c.cleanName).replace(/^\//, ''), iconUrl: c.iconUrl })),
                                }),
                            },
                          ]),
                    ]}
                  >
                    {apps.length > 0 ? (
                      <TileGrid>{apps.map((c) => card(c, true))}</TileGrid>
                    ) : (
                      <ShelfNote>
                        No apps yet.{' '}
                        <button type="button" onClick={() => openMoveForStack(projectName)} className="font-medium hover:opacity-80" style={{ color: '#0A84FF' }}>
                          Add an app
                        </button>{' '}
                        or move one here from another stack.
                      </ShelfNote>
                    )}
                  </Shelf>
                );
              })}

            {groupedByComposeStacks.standalone.length > 0 && (
              <Shelf
                id="stack:none"
                title="Not in a Stack"
                icon={<FolderIcon apps={groupedByComposeStacks.standalone} />}
                status={
                  <span className="truncate">
                    <Health apps={groupedByComposeStacks.standalone} /> <span className="hidden sm:inline">· Started with docker run</span>
                  </span>
                }
                menu={[
                  ...stackActionItems(groupedByComposeStacks.standalone),
                  {
                    key: 'move',
                    label: 'Move into a Stack…',
                    divider: true,
                    onSelect: () => {
                      setMoveInitialDestination(undefined);
                      setMoveInitialAppId(undefined);
                      setIsMergeModalOpen(true);
                    },
                  },
                ]}
              >
                <TileGrid>{groupedByComposeStacks.standalone.map((c) => card(c))}</TileGrid>
              </Shelf>
            )}
          </div>
        )}
      </main>

      <footer className="px-4 lg:px-6 pt-6 pb-8 text-center text-[12px]" style={{ color: 'rgba(235,235,245,0.35)', fontFamily: ios.font }}>
        Manifexus{softwareUpdate?.current.version ? ` ${softwareUpdate.current.version}` : ''} · {hostAddress}
      </footer>

      {/* Unused folders on the server */}
      <CleanupSheet open={isCleanupOpen} onClose={() => setIsCleanupOpen(false)} onChanged={() => fetchData(false)} />

      {/* One stack: its apps, where it lives, and actions */}
      {(() => {
        const d = stackDetails ? groupedByComposeStacks.stacksMap[stackDetails] : undefined;
        const composeFile = d?.configFiles?.split(',')[0] || (d?.workingDir ? `${d.workingDir}/docker-compose.yml` : undefined);
        const own = stackDetails?.toLowerCase() === 'manifexus';
        return (
          <StackDetailsSheet
            project={d ? stackDetails : null}
            apps={d?.containers || []}
            helpersOf={helpersOf}
            workingDir={d?.workingDir}
            composeFile={composeFile}
            onClose={() => setStackDetails(null)}
            onOpenApp={(c) => {
              setStackDetails(null);
              setInspectContainer(c);
            }}
            onAddApp={() => {
              const p = stackDetails!;
              setStackDetails(null);
              openMoveForStack(p);
            }}
            onEditCompose={
              composeFile
                ? () => {
                    setTerminalTargetFile(composeFile);
                    setTerminalStackName(stackDetails || undefined);
                    setStackDetails(null);
                    setIsTerminalModalOpen(true);
                  }
                : undefined
            }
            onOpenRestore={() => {
              setStackDetails(null);
              setIsRestoreOpen(true);
            }}
            onDelete={
              own || !d
                ? undefined
                : () => {
                    setDeleteStackTarget({
                      projectName: stackDetails!,
                      targetDirectory: d.workingDir,
                      servicesCount: d.containers.length,
                      apps: d.containers.map((c) => ({ id: c.id, name: (c.customName || c.friendlyName || c.cleanName).replace(/^\//, ''), iconUrl: c.iconUrl })),
                    });
                    setStackDetails(null);
                  }
            }
          />
        );
      })()}

      {/* App details, and Diagnostics for Manifexus itself */}
      <AppDetailsSheet
        covered={Boolean(overDetails)}
        container={inspectContainer}
        helpers={inspectContainer ? helpersOf.get(inspectContainer.id) : undefined}
        partOf={inspectContainer && helperOf.get(inspectContainer.id) ? containers.find((x) => x.id === helperOf.get(inspectContainer.id)) : undefined}
        onOpenApp={setInspectContainer}
        system={Boolean(inspectContainer && manifexusHeroContainer && inspectContainer.id === manifexusHeroContainer.id)}
        groups={userGroups}
        hostAddress={hostAddress}
        onClose={() => setInspectContainer(null)}
        onSaveOverride={handleSaveOverride}
        onAction={handleContainerAction}
        onOpenUpdates={() => {
          setOverDetails('updates');
          setIsUpdatesOpen(true);
          refreshSoftwareUpdate();
        }}
        onOpenRestore={() => {
          setOverDetails('restore');
          setIsRestoreOpen(true);
        }}
        onOpenSettings={() => {
          setOverDetails('settings');
          setIsSettingsOpen(true);
        }}
        onFixWithAI={(r) => {
          setOverDetails('assistant');
          setFixRequest(r);
        }}
        onOpenActivity={(filter) => {
          setOverDetails('activity');
          setActivity({ open: true, filter });
          markFailuresSeen(lastFailureAt.current);
        }}
      />

      {/* Custom Group Manager Modal */}
      <GroupManagerModal
        isOpen={FEATURES.groups && isGroupManagerOpen}
        onClose={() => setIsGroupManagerOpen(false)}
        groups={config?.groups || []}
        onSaveGroup={handleSaveGroup}
        onDeleteGroup={handleDeleteGroup}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        {...backProps('settings', () => setIsSettingsOpen(false))}
        config={config}
        onSaveConfig={handleSaveConfig}
        detectedStacksDir={config?.stacksDir ? undefined : defaultStacksDir}
        privileges={privileges}
        onOpenAutomationModal={() => setIsAutomationModalOpen(true)}
        onOpenAssistant={() => setAssistant({ open: true, view: 'settings', from: 'settings' })}
      />

      <FixSheet
        request={fixRequest}
        onClose={() => {
          setFixRequest(null);
          setOverDetails(null);
        }}
        onNeedsSetup={(r) => {
          setFixRequest(null);
          setAssistant({ open: true, question: r.question, focus: r.focus, fixAfter: r });
        }}
        onAction={handleAiAction}
      />

      <AssistantSheet
        open={assistant.open}
        initialView={assistant.view}
        initialQuestion={assistant.fixAfter || assistant.seed ? undefined : assistant.question}
        focus={assistant.focus}
        seedChat={assistant.seed}
        setupFor={assistant.fixAfter?.question}
        onAction={handleAiAction}
        afterSetup={
          assistant.fixAfter
            ? () => {
                const r = assistant.fixAfter!;
                setAssistant({ open: false });
                setFixRequest(r);
              }
            : undefined
        }
        {...(assistant.from === 'settings'
          ? { backLabel: 'Settings', onBack: () => setAssistant({ open: false }), onClose: () => { setAssistant({ open: false }); setIsSettingsOpen(false); } }
          : backProps('assistant', () => setAssistant({ open: false })))}
      />

      {/* Simulate Container Modal */}
      <SimulateContainerModal
        isOpen={isSimulateOpen}
        onClose={() => setIsSimulateOpen(false)}
        onSimulate={handleSimulateContainer}
      />

      {/* Stack Merger & Migration Studio Modal */}
      <MoveAppsModal
        isOpen={isMergeModalOpen}
        onClose={() => setIsMergeModalOpen(false)}
        containers={containers}
        linkedTo={helperOf}
        emptyStacks={emptyStacks}
        defaultStacksDir={defaultStacksDir}
        initialDestination={moveInitialDestination}
        initialAppId={moveInitialAppId}
        privileges={privileges}
        onOpenAutomationModal={() => setIsAutomationModalOpen(true)}
        onMoved={() => {
          fetchData(true);
          fetchPrivileges();
        }}
      />

      {/* Host Automation & Privileges Elevation Modal */}
      <HostAutomationModal
        isOpen={isAutomationModalOpen}
        onClose={() => setIsAutomationModalOpen(false)}
        privileges={privileges}
        onRefreshPrivileges={fetchPrivileges}
      />

      {/* Restore: every change's backup, restorable */}
      <RestoreSheet open={isRestoreOpen} {...backProps('restore', () => setIsRestoreOpen(false))} onChanged={() => fetchData(true)} />

      {/* Directive 3: Create New Empty Stack Modal */}
      <CreateStackModal
        isOpen={isCreateStackModalOpen}
        onClose={() => setIsCreateStackModalOpen(false)}
        onSuccess={() => {
          fetchData(true);
        }}
        defaultBaseDir={
          defaultStacksDir ||
          (containers.find((c) => c.compose?.workingDir)?.compose?.workingDir || '/opt/stacks/x').split('/').slice(0, -1).join('/')
        }
      />

      {/* Directive 2: Host Web Terminal Modal (nano) */}
      <WebTerminalModal
        isOpen={isTerminalModalOpen}
        onClose={() => setIsTerminalModalOpen(false)}
        filePath={terminalTargetFile}
        stackName={terminalStackName}
      />

      <SoftwareUpdateSheet
        open={isUpdatesOpen}
        {...backProps('updates', () => setIsUpdatesOpen(false))}
        state={softwareUpdate}
        onStateChange={setSoftwareUpdate}
      />

      <ActivitySheet
        open={activity.open}
        initialActivityId={activity.id}
        initialFilter={activity.filter}
        {...backProps('activity', () => {
          setActivity({ open: false });
          // Anything that failed while it was open was on screen
          refreshActivityBadge(true);
        })}
      />

      <PortsSheet
        open={isPortsOpen}
        onClose={() => setIsPortsOpen(false)}
        containers={containers.filter((c) => !c.isHidden)}
        hostAddress={config?.hostAddress || 'localhost'}
      />

      <DeleteStackDialog
        target={deleteStackTarget}
        onCancel={() => setDeleteStackTarget(null)}
        onDeleted={() => {
          setDeleteStackTarget(null);
          fetchData(true);
        }}
      />

    </div>
  );
}
