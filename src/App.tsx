import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  FolderKanban,
  Layers,
  Server,
  AlertCircle,
  HelpCircle,
  FolderOpen,
  Terminal,
  ExternalLink,
  PlusCircle,
  ChevronRight,
  ShieldAlert,
} from 'lucide-react';
import {
  DeepContainerMetadata,
  SystemStatus,
  ManifexusConfig,
  UserGroup,
  AppOverride,
} from './types';
import { Navbar } from './components/Navbar';
import { StatsBar } from './components/StatsBar';
import { AppCard } from './components/AppCard';
import { InspectModal } from './components/InspectModal';
import { HelpDrawer } from './components/HelpDrawer';
import { GroupManagerModal } from './components/GroupManagerModal';
import { SettingsModal } from './components/SettingsModal';
import { SimulateContainerModal } from './components/SimulateContainerModal';
import { StackMergeModal } from './components/StackMergeModal';
import { ComposeInstallModal } from './components/ComposeInstallModal';
import { HostAutomationModal } from './components/HostAutomationModal';
import { ManifexusHeroHeader } from './components/ManifexusHeroHeader';
import { MergeHistoryModal } from './components/MergeHistoryModal';
import { ExecutionPipelineConsole } from './components/ExecutionPipelineConsole';
import { SystemLogsModal } from './components/SystemLogsModal';
import { AutomationPrivileges } from './types';
import { History } from 'lucide-react';

export default function App() {
  const [containers, setContainers] = useState<DeepContainerMetadata[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [privileges, setPrivileges] = useState<AutomationPrivileges | null>(null);
  const [isAutomationModalOpen, setIsAutomationModalOpen] = useState(false);
  const [isComposeInstallOpen, setIsComposeInstallOpen] = useState(false);
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
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isGroupManagerOpen, setIsGroupManagerOpen] = useState(false);
  const [isSimulateOpen, setIsSimulateOpen] = useState(false);
  const [isMergeModalOpen, setIsMergeModalOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [isSystemLogsOpen, setIsSystemLogsOpen] = useState(false);
  const [revertRecordToStream, setRevertRecordToStream] = useState<any | null>(null);
  const [mergeModalInitialIds, setMergeModalInitialIds] = useState<string[]>([]);
  const [mergeModalInitialStack, setMergeModalInitialStack] = useState<string | undefined>(undefined);

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

    const handleRefreshFleet = () => {
      fetchData(true);
      fetchPrivileges();
    };
    window.addEventListener('manifexus:refresh_fleet', handleRefreshFleet);

    return () => {
      clearInterval(timer);
      window.removeEventListener('manifexus:refresh_fleet', handleRefreshFleet);
    };
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
      if (res.ok) {
        await fetchData(true);
      }
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
  const handleSaveConfig = async (updated: Partial<ManifexusConfig>) => {
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      if (res.ok) {
        const saved = await res.json();
        setConfig(saved);
        await fetchData(false);
      }
    } catch (err) {
      console.error('Failed to save config:', err);
    }
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

  // Unique ports count
  const discoveredPortsCount = useMemo(() => {
    const set = new Set<number>();
    for (const c of containers) {
      for (const p of c.ports) {
        if (p.publicPort) set.add(p.publicPort);
      }
    }
    return set.size;
  }, [containers]);

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

  // Grouped containers by Docker Compose Stacks
  const groupedByComposeStacks = useMemo(() => {
    const stacksMap: Record<string, { containers: DeepContainerMetadata[]; workingDir?: string; configFiles?: string }> = {};
    const standalone: DeepContainerMetadata[] = [];

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
      } else {
        standalone.push(c);
      }
    }

    return { stacksMap, standalone };
  }, [filteredContainers]);

  const hostAddress = config?.hostAddress || 'localhost';

  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100 flex flex-col font-sans selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* Top Command Navbar */}
      <Navbar
        systemStatus={systemStatus}
        privileges={privileges}
        onOpenAutomationModal={() => setIsAutomationModalOpen(true)}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        onToggleHelp={() => setIsHelpOpen(!isHelpOpen)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenGroupManager={() => setIsGroupManagerOpen(true)}
        onOpenSimulateModal={() => setIsSimulateOpen(true)}
        onOpenComposeInstall={() => setIsComposeInstallOpen(true)}
        onOpenStackMerger={() => {
          setMergeModalInitialIds([]);
          setMergeModalInitialStack(undefined);
          setIsMergeModalOpen(true);
        }}
        onOpenHistory={() => setIsHistoryModalOpen(true)}
        onOpenSystemLogs={() => setIsSystemLogsOpen(true)}
        onRefresh={() => {
          fetchData(true);
          fetchPrivileges();
        }}
        isRefreshing={isRefreshing}
      />

      {/* Main Dashboard Canvas */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-6 py-6">
        {/* Directive 1: Hero Layout & Structural Protection for Manifexus */}
        <ManifexusHeroHeader
          container={manifexusHeroContainer}
          systemStatus={systemStatus}
          privileges={privileges}
          onOpenElevateModal={() => setIsAutomationModalOpen(true)}
          onInspectContainer={(c) => setInspectContainer(c)}
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
              <button
                onClick={() => setIsHelpOpen(true)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors flex items-center gap-1.5"
              >
                <HelpCircle className="w-3.5 h-3.5" />
                <span>Deploy Command</span>
              </button>
            </div>
          </div>
        )}

        {/* Central Fleet Telemetry Metric Cards */}
        <StatsBar
          systemStatus={systemStatus}
          portsCount={discoveredPortsCount}
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
                          onMergeToStack={(c) => {
                            setMergeModalInitialIds([c.id]);
                            setMergeModalInitialStack(c.compose?.project);
                            setIsMergeModalOpen(true);
                          }}
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
                      onMergeToStack={(c) => {
                        setMergeModalInitialIds([c.id]);
                        setMergeModalInitialStack(c.compose?.project);
                        setIsMergeModalOpen(true);
                      }}
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
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-purple-950/80 border border-purple-500/40 text-purple-300">
                          {stackData.containers.length} {stackData.containers.length === 1 ? 'service' : 'services'}
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
                    {stackData.configFiles && (
                      <div className="text-[11px] font-mono text-slate-500 truncate max-w-xs bg-slate-950 px-2 py-1 rounded border border-slate-800 hidden md:block">
                        {stackData.configFiles}
                      </div>
                    )}
                    <button
                      onClick={() => {
                        setMergeModalInitialStack(projectName);
                        setMergeModalInitialIds(stackData.containers.map((c) => c.id));
                        setIsMergeModalOpen(true);
                      }}
                      className="px-2.5 py-1 rounded-lg bg-purple-950/80 hover:bg-purple-900 border border-purple-500/40 text-purple-200 text-xs font-mono transition-colors flex items-center gap-1.5 shadow-[0_0_10px_rgba(168,85,247,0.15)]"
                      title="Add app into this stack or combine with other stacks"
                    >
                      <Layers className="w-3.5 h-3.5 text-purple-400" />
                      <span>Merge / Add Apps</span>
                    </button>
                  </div>
                </div>

                {/* Stack Service Grid */}
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
                      onMergeToStack={(c) => {
                        setMergeModalInitialIds([c.id]);
                        setMergeModalInitialStack(projectName);
                        setIsMergeModalOpen(true);
                      }}
                    />
                  ))}
                </div>
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
                      onMergeToStack={(c) => {
                        setMergeModalInitialIds([c.id]);
                        setMergeModalInitialStack(undefined);
                        setIsMergeModalOpen(true);
                      }}
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

      {/* Deep Inspection Modal */}
      <InspectModal
        container={inspectContainer}
        groups={config?.groups || []}
        hostAddress={hostAddress}
        onClose={() => setInspectContainer(null)}
        onSaveOverride={handleSaveOverride}
      />

      {/* Quick Start & Deployment Guide Drawer */}
      <HelpDrawer
        isOpen={isHelpOpen}
        onClose={() => setIsHelpOpen(false)}
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
        onClose={() => setIsSettingsOpen(false)}
        config={config}
        onSaveConfig={handleSaveConfig}
      />

      {/* Simulate Container Modal */}
      <SimulateContainerModal
        isOpen={isSimulateOpen}
        onClose={() => setIsSimulateOpen(false)}
        onSimulate={handleSimulateContainer}
      />

      {/* Stack Merger & Migration Studio Modal */}
      <StackMergeModal
        isOpen={isMergeModalOpen}
        onClose={() => setIsMergeModalOpen(false)}
        containers={containers}
        initialSelectedIds={mergeModalInitialIds}
        initialTargetStack={mergeModalInitialStack}
        privileges={privileges}
        onOpenAutomationModal={() => setIsAutomationModalOpen(true)}
        onRefreshPrivileges={fetchPrivileges}
        onMergeSuccess={() => {
          fetchData(true);
          fetchPrivileges();
        }}
      />

      {/* Remote Compose Installation Studio Modal */}
      <ComposeInstallModal
        isOpen={isComposeInstallOpen}
        onClose={() => setIsComposeInstallOpen(false)}
        containers={containers}
        privileges={privileges}
        onInstallSuccess={() => {
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

      {/* Directive 6: Merge State Ledger & Backups Modal */}
      <MergeHistoryModal
        isOpen={isHistoryModalOpen}
        onClose={() => setIsHistoryModalOpen(false)}
        onTriggerRevert={(record) => {
          setIsHistoryModalOpen(false);
          setRevertRecordToStream(record);
        }}
      />

      {/* Directive 4 & 6: Revert Execution Pipeline Console */}
      {revertRecordToStream && (
        <ExecutionPipelineConsole
          isOpen={Boolean(revertRecordToStream)}
          onClose={() => setRevertRecordToStream(null)}
          title={`Rollback: Reverting "${revertRecordToStream.targetStackName}" to Pre-Merge State`}
          mode="revert"
          mergeId={revertRecordToStream.id}
          streamUrl={`/api/history/${revertRecordToStream.id}/revert-stream`}
          streamPayload={{}}
          onSuccessDone={() => {
            fetchData(true);
            setRevertRecordToStream(null);
          }}
        />
      )}

      {/* Module 3: Centralized System Logs Modal */}
      <SystemLogsModal
        isOpen={isSystemLogsOpen}
        onClose={() => setIsSystemLogsOpen(false)}
      />
    </div>
  );
}
