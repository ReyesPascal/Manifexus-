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
import { StatsBar } from './components/StatsBar';
import { PortsSheet } from './components/PortsSheet';
import { SoftwareUpdateSheet, SoftwareUpdateState } from './components/SoftwareUpdateSheet';
import { ActivitySheet } from './components/ActivitySheet';
import { AppCard } from './components/AppCard';
import { AppDetailsSheet } from './components/AppDetailsSheet';
import { AssistantSheet } from './components/AssistantSheet';
import { setPrefsFromConfig } from './prefs';
import { GroupManagerModal } from './components/GroupManagerModal';
import { SettingsModal } from './components/SettingsModal';
import { SimulateContainerModal } from './components/SimulateContainerModal';
import { MoveAppsModal } from './components/MoveAppsModal';
import { DeleteStackDialog, DeleteStackTarget } from './components/DeleteStackDialog';
import { HostAutomationModal } from './components/HostAutomationModal';
import { ManifexusHeroHeader } from './components/ManifexusHeroHeader';
import { ViewBar } from './components/ViewBar';
import { RestoreSheet } from './components/RestoreSheet';
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
  const [assistant, setAssistant] = useState<{ open: boolean; view?: 'setup' | 'settings'; question?: string; focus?: string; from?: 'settings' }>({ open: false });
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
    try {
      const res = await fetch(`/api/containers/${containerId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
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

  // Filtered containers based on search and status
  const filteredContainers = useMemo(() => {
    return containers.filter((c) => {
      // Directive 1: Never show Manifexus in standard cards grid - rendered as Hero element
      if (isManifexus(c)) return false;

      // Status filter
      if (statusFilter === 'running' && c.state !== 'running') return false;
      if (statusFilter === 'stopped' && c.state === 'running') return false;

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = (c.customName || c.cleanName).toLowerCase().includes(q);
        const matchImage = c.image.toLowerCase().includes(q);
        const matchProject = (c.compose.project || '').toLowerCase().includes(q);
        const matchService = (c.compose.service || '').toLowerCase().includes(q);
        const matchPort = c.ports.some(
          (p) => String(p.publicPort || '').includes(q) || String(p.privatePort).includes(q)
        );
        const matchGroup = config?.groups.some(
          (g) => g.id === c.customGroup && g.name.toLowerCase().includes(q)
        );

        if (!matchName && !matchImage && !matchProject && !matchService && !matchPort && !matchGroup) {
          return false;
        }
      }

      return !c.isHidden;
    });
  }, [containers, statusFilter, searchQuery, config?.groups]);

  // Summary numbers, computed from exactly what the dashboard shows as app cards
  // (not Manifexus itself, not apps hidden in Settings)
  const visibleApps = useMemo(() => containers.filter((c) => !isManifexus(c) && !c.isHidden), [containers, isManifexus]);
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

  // Grouped containers by Custom User Groups
  const groupedByUserCategories = useMemo(() => {
    const groupsMap: Record<string, DeepContainerMetadata[]> = {};
    const uncategorized: DeepContainerMetadata[] = [];

    const groupIds = new Set((config?.groups || []).map((g) => g.id));

    for (const c of filteredContainers) {
      if (c.customGroup && groupIds.has(c.customGroup)) {
        if (!groupsMap[c.customGroup]) groupsMap[c.customGroup] = [];
        groupsMap[c.customGroup].push(c);
      } else {
        uncategorized.push(c);
      }
    }

    return { groupsMap, uncategorized };
  }, [filteredContainers, config?.groups]);

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
    <div className="min-h-screen bg-[#07090e] text-slate-100 flex flex-col font-sans selection:bg-cyan-500/30 selection:text-cyan-200">

      {/* Main Dashboard Canvas */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-6 py-6">
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
          onOpenActivity={() => {
            setActivity({ open: true });
            markFailuresSeen(lastFailureAt.current);
          }}
          activityAlert={unseenFailure}
          onOpenRestore={() => setIsRestoreOpen(true)}
          onOpenAssistant={() => setAssistant({ open: true })}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onRefresh={() => {
            fetchData(true);
            fetchPrivileges();
          }}
          isRefreshing={isRefreshing}
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

        {/* Central Fleet Telemetry Metric Cards */}
        <StatsBar
          running={stats.running}
          stopped={stats.stopped}
          total={stats.total}
          stacks={stats.stacks}
          portsInUse={stats.ports}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          onShowStacks={() => {
            setStatusFilter('all');
            setViewMode('compose');
          }}
          onShowPorts={() => setIsPortsOpen(true)}
        />

        {/* Arrange apps by stack or by group */}
        <ViewBar
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onOpenGroupManager={() => setIsGroupManagerOpen(true)}
          onOpenCreateStack={() => setIsCreateStackModalOpen(true)}
        />

        {/* Error Notification */}
        {error && (
          <div className="mb-6 p-4 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs font-mono flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-rose-400 flex-shrink-0" />
            <span>Connection Warning: {error}</span>
          </div>
        )}

        {/* LOADING STATE */}
        {isLoading && (
          <div className="py-20 flex flex-col items-center justify-center space-y-3 font-mono">
            <div className="w-10 h-10 border-2 border-cyan-500/20 border-t-cyan-400 rounded-full animate-spin"></div>
            <p className="text-xs text-slate-400">Querying Docker Daemon socket...</p>
          </div>
        )}

        {/* EMPTY STATE */}
        {!isLoading && filteredContainers.length === 0 && (
          <div className="py-16 text-center rounded-2xl bg-slate-900/40 border border-slate-800 p-8 font-mono">
            <Server className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <h3 className="text-base font-bold text-slate-200">No Containers Detected</h3>
            <p className="text-xs text-slate-500 max-w-md mx-auto mt-1 mb-4">
              {searchQuery
                ? `No containers match your search query "${searchQuery}".`
                : 'No running or exited containers found on the Docker daemon.'}
            </p>
            {systemStatus?.isDemoMode && (
              <button
                onClick={() => setIsSimulateOpen(true)}
                className="px-4 py-2 rounded-xl bg-cyan-500 text-slate-950 font-bold text-xs hover:bg-cyan-400 transition-colors"
              >
                + Spawn Sample Container
              </button>
            )}
          </div>
        )}

        {/* VIEW MODE 1: CUSTOM USER GROUPS */}
        {!isLoading && viewMode === 'groups' && (
          <div className="space-y-8">
            {/* User defined categories */}
            {(config?.groups || []).map((group) => {
              const items = groupedByUserCategories.groupsMap[group.id] || [];
              if (items.length === 0 && searchQuery) return null;

              return (
                <section key={group.id} className="space-y-4">
                  {/* Category Header */}
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800/80">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="w-3.5 h-3.5 rounded-md shadow-sm"
                        style={{ backgroundColor: group.color }}
                      ></span>
                      <h2 className="text-base font-bold font-mono tracking-tight text-white flex items-center gap-2">
                        {group.name}
                        <span className="text-xs font-normal text-slate-500 font-mono px-2 py-0.5 rounded-full bg-slate-900 border border-slate-800">
                          {items.length} {items.length === 1 ? 'service' : 'services'}
                        </span>
                      </h2>
                    </div>

                    {group.description && (
                      <span className="text-xs text-slate-500 font-mono hidden md:block">
                        {group.description}
                      </span>
                    )}
                  </div>

                  {/* Grid of App Cards */}
                  {items.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {items.map((container) => (
                        <AppCard
                          key={container.id}
                          container={container}
                          hostAddress={hostAddress}
                          groups={config?.groups || []}
                          onInspect={setInspectContainer}
                          onAssignGroup={handleAssignGroup}
                          onAction={handleContainerAction}
                          onSetPrimaryPort={handleSetPrimaryPort}
                          onMoveApp={openMoveForApp}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="p-6 rounded-xl border border-dashed border-slate-800 text-center font-mono text-xs text-slate-500">
                      No services assigned to this category yet. Use the category icon on any app card to assign it here.
                    </div>
                  )}
                </section>
              );
            })}

            {/* Uncategorized Services */}
            {groupedByUserCategories.uncategorized.length > 0 && (
              <section className="space-y-4 pt-4">
                <div className="flex items-center justify-between pb-2 border-b border-slate-800/80">
                  <div className="flex items-center gap-2.5">
                    <span className="w-3.5 h-3.5 rounded-md bg-slate-600"></span>
                    <h2 className="text-base font-bold font-mono tracking-tight text-white flex items-center gap-2">
                      Uncategorized Services
                      <span className="text-xs font-normal text-slate-500 font-mono px-2 py-0.5 rounded-full bg-slate-900 border border-slate-800">
                        {groupedByUserCategories.uncategorized.length}
                      </span>
                    </h2>
                  </div>
                  <span className="text-xs text-slate-500 font-mono hidden sm:block">
                    Auto-discovered containers awaiting category assignment
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {groupedByUserCategories.uncategorized.map((container) => (
                    <AppCard
                      key={container.id}
                      container={container}
                      hostAddress={hostAddress}
                      groups={config?.groups || []}
                      onInspect={setInspectContainer}
                      onAssignGroup={handleAssignGroup}
                      onAction={handleContainerAction}
                      onSetPrimaryPort={handleSetPrimaryPort}
                      onMoveApp={openMoveForApp}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {/* VIEW MODE 2: COMPOSE STACKS */}
        {!isLoading && viewMode === 'compose' && (
          <div className="space-y-8">
            {/* Visual Compose Stacks */}
            {Object.entries(groupedByComposeStacks.stacksMap).map(([projectName, stackData]) => (
              <section
                key={projectName}
                className="space-y-4 rounded-2xl bg-[#0a0e1a]/60 border border-purple-500/20 p-5 shadow-lg relative overflow-hidden"
              >
                {/* Compose Stack Header Banner */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-purple-500/20">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-purple-950/60 border border-purple-500/40 text-purple-300">
                      <Layers className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-base font-bold font-mono text-white tracking-tight">
                          {projectName}
                        </h2>
                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-mono border ${
                          stackData.containers.length === 0
                            ? 'bg-cyan-950/80 border-cyan-500/40 text-cyan-300'
                            : 'bg-purple-950/80 border-purple-500/40 text-purple-300'
                        }`}>
                          {stackData.containers.length === 0 ? 'Empty Stack (0 services)' : `${stackData.containers.length} ${stackData.containers.length === 1 ? 'service' : 'services'}`}
                        </span>
                      </div>
                      {stackData.workingDir && (
                        <div className="flex items-center gap-1.5 text-xs text-slate-400 font-mono mt-0.5 truncate max-w-xl">
                          <FolderOpen className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
                          <span className="truncate">{stackData.workingDir}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-start sm:self-center">
                    {/* Directive 3: Open Compose in Terminal Button next to Compose File Path */}
                    {(() => {
                      const composePath =
                        stackData.configFiles ||
                        (stackData.workingDir ? `${stackData.workingDir}/docker-compose.yml` : undefined);
                      if (!composePath) return null;
                      return (
                        <div className="flex items-center gap-1.5 bg-slate-950/80 px-2.5 py-1 rounded-lg border border-slate-800/80">
                          <span
                            className="text-[11px] font-mono text-slate-400 truncate max-w-xs hidden md:inline"
                            title={composePath}
                          >
                            {composePath}
                          </span>
                          <button
                            onClick={() => {
                              setTerminalTargetFile(composePath);
                              setTerminalStackName(projectName);
                              setIsTerminalModalOpen(true);
                            }}
                            className="px-2 py-0.5 rounded bg-slate-900 hover:bg-cyan-950 hover:border-cyan-500/50 border border-slate-700/80 text-cyan-300 text-[11px] font-mono transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
                            title={`Open ${composePath} in Host Web Terminal (nano)`}
                          >
                            <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                            <span className="hidden sm:inline">Open in Terminal</span>
                          </button>
                        </div>
                      );
                    })()}

                    {projectName.toLowerCase() !== 'manifexus' && (
                      <button
                        onClick={() => openMoveForStack(projectName)}
                        className="px-2.5 py-1 rounded-lg bg-purple-950/80 hover:bg-purple-900 border border-purple-500/40 text-purple-200 text-xs transition-colors flex items-center gap-1.5 cursor-pointer"
                        title={`Move apps from other stacks into ${projectName}`}
                      >
                        <Plus className="w-3.5 h-3.5 text-purple-400" />
                        <span>Add apps</span>
                      </button>
                    )}

                    {/* Directive 4: Red Trash-Can Safe Delete Stack Button */}
                    {projectName.toLowerCase() !== 'manifexus' && (
                      <button
                        onClick={() => {
                          setDeleteStackTarget({
                            projectName,
                            targetDirectory: stackData.workingDir,
                            servicesCount: stackData.containers.length,
                            apps: stackData.containers.map((c) => ({
                              id: c.id,
                              name: (c.customName || c.cleanName).replace(/^\//, ''),
                              iconUrl: c.iconUrl,
                            })),
                          });
                        }}
                        className="px-2.5 py-1 rounded-lg bg-rose-950/80 hover:bg-rose-900/90 border border-rose-500/40 text-rose-300 hover:text-rose-100 text-xs font-mono transition-colors flex items-center gap-1.5 shadow-[0_0_10px_rgba(244,63,94,0.15)] cursor-pointer"
                        title={`Delete ${projectName} (backed up first)`}
                      >
                        <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                        <span className="hidden sm:inline">Delete</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Stack Service Grid or Empty Stack Placeholder */}
                {stackData.containers.length === 0 ? (
                  <div className="py-7 px-4 rounded-xl border border-dashed border-slate-800/80 bg-slate-950/30 flex flex-col items-center justify-center gap-3">
                    <p className="text-slate-400 text-sm">This stack has no apps yet.</p>
                    <button
                      onClick={() => openMoveForStack(projectName)}
                      className="px-3.5 py-2 rounded-lg bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/40 text-purple-200 text-sm flex items-center gap-1.5 cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Add apps</span>
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {stackData.containers.map((container) => (
                      <AppCard
                        key={container.id}
                        container={container}
                        hostAddress={hostAddress}
                        groups={config?.groups || []}
                        onInspect={setInspectContainer}
                        onAssignGroup={handleAssignGroup}
                        onAction={handleContainerAction}
                        onSetPrimaryPort={handleSetPrimaryPort}
                        onMoveApp={openMoveForApp}
                      />
                    ))}
                  </div>
                )}
              </section>
            ))}

            {/* Standalone Containers (Docker Run) */}
            {groupedByComposeStacks.standalone.length > 0 && (
              <section className="space-y-4 rounded-2xl bg-[#0a0e1a]/40 border border-slate-800 p-5">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400">
                      <Terminal className="w-5 h-5" />
                    </div>
                    <div>
                      <h2 className="text-base font-bold font-mono text-white tracking-tight">
                        Standalone Containers
                      </h2>
                      <p className="text-xs text-slate-400 font-mono">
                        Containers launched individually via `docker run` without a Compose stack
                      </p>
                    </div>
                  </div>

                  <span className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-slate-900 border border-slate-800 text-slate-400">
                    {groupedByComposeStacks.standalone.length} containers
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {groupedByComposeStacks.standalone.map((container) => (
                    <AppCard
                      key={container.id}
                      container={container}
                      hostAddress={hostAddress}
                      groups={config?.groups || []}
                      onInspect={setInspectContainer}
                      onAssignGroup={handleAssignGroup}
                      onAction={handleContainerAction}
                      onSetPrimaryPort={handleSetPrimaryPort}
                      onMoveApp={openMoveForApp}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      {/* Footer Command Telemetry */}
      <footer className="border-t border-slate-800/80 bg-[#07090e] px-4 lg:px-6 py-4 text-xs font-mono text-slate-500">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
            <span>MANIFEXUS v1.0 — Central Command Hub</span>
            <span className="text-slate-600">|</span>
            <span>Host: {hostAddress}</span>
          </div>
          <div>
            Data volume: <code className="text-slate-400">/data/config.json</code> (Persistent)
          </div>
        </div>
      </footer>

      {/* App details, and Diagnostics for Manifexus itself */}
      <AppDetailsSheet
        covered={Boolean(overDetails)}
        container={inspectContainer}
        system={Boolean(inspectContainer && manifexusHeroContainer && inspectContainer.id === manifexusHeroContainer.id)}
        groups={config?.groups || []}
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
        onAskAI={(question, focus) => {
          setOverDetails('assistant');
          setAssistant({ open: true, question, focus });
        }}
        onOpenActivity={(filter) => {
          setOverDetails('activity');
          setActivity({ open: true, filter });
          markFailuresSeen(lastFailureAt.current);
        }}
      />

      {/* Custom Group Manager Modal */}
      <GroupManagerModal
        isOpen={isGroupManagerOpen}
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

      <AssistantSheet
        open={assistant.open}
        initialView={assistant.view}
        initialQuestion={assistant.question}
        focus={assistant.focus}
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
