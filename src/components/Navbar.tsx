import React from 'react';
import {
  Layers,
  FolderKanban,
  HelpCircle,
  Settings,
  RefreshCw,
  PlusCircle,
  Search,
  CheckCircle2,
  AlertTriangle,
  Server,
  History,
  Terminal,
} from 'lucide-react';
import { SystemStatus, AutomationPrivileges } from '../types';
import { Zap, ShieldAlert } from 'lucide-react';

interface NavbarProps {
  systemStatus: SystemStatus | null;
  privileges: AutomationPrivileges | null;
  onOpenAutomationModal: () => void;
  viewMode: 'groups' | 'compose';
  onViewModeChange: (mode: 'groups' | 'compose') => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  statusFilter: 'all' | 'running' | 'stopped';
  onStatusFilterChange: (status: 'all' | 'running' | 'stopped') => void;
  onToggleHelp: () => void;
  onOpenSettings: () => void;
  onOpenGroupManager: () => void;
  onOpenSimulateModal: () => void;
  onOpenStackMerger?: () => void;
  onOpenHistory?: () => void;
  onOpenLogs?: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  systemStatus,
  privileges,
  onOpenAutomationModal,
  viewMode,
  onViewModeChange,
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  onToggleHelp,
  onOpenSettings,
  onOpenGroupManager,
  onOpenSimulateModal,
  onOpenStackMerger,
  onOpenHistory,
  onOpenLogs,
  onRefresh,
  isRefreshing,
}) => {
  return (
    <header className="sticky top-0 z-40 bg-[#07090e]/90 backdrop-blur-md border-b border-slate-800/80 px-4 lg:px-6 py-3">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
        {/* Brand & Logo */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Minimal Tech Nexus SVG Logo */}
            <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-950/80 to-slate-900 border border-cyan-500/30 shadow-[0_0_15px_rgba(6,182,212,0.2)]">
              <svg
                viewBox="0 0 40 40"
                className="w-6 h-6 text-cyan-400"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                {/* Orbital nodes and interconnected nexus lines */}
                <circle cx="20" cy="20" r="4.5" className="fill-cyan-400 drop-shadow-[0_0_6px_#06b6d4]" />
                <circle cx="20" cy="8" r="2.5" className="fill-cyan-300" />
                <circle cx="31" cy="28" r="2.5" className="fill-cyan-300" />
                <circle cx="9" cy="28" r="2.5" className="fill-cyan-300" />
                <path
                  d="M20 12.5V15.5M28.5 24.5L23.5 22.5M11.5 24.5L16.5 22.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeOpacity="0.8"
                />
                <circle
                  cx="20"
                  cy="20"
                  r="14"
                  stroke="currentColor"
                  strokeWidth="1"
                  strokeDasharray="2 3"
                  strokeOpacity="0.4"
                />
              </svg>
            </div>

            <div>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold tracking-tight text-white font-mono flex items-center">
                  MANI<span className="text-cyan-400">FEXUS</span>
                </span>
                <span className="px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded bg-cyan-950/80 border border-cyan-500/30 text-cyan-300">
                  v1.0
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                The central nexus for your container fleet.
              </p>
            </div>
          </div>

          {/* Mobile refresh & help buttons */}
          <div className="flex items-center gap-1.5 md:hidden">
            <button
              onClick={onRefresh}
              className="p-2 rounded-lg bg-slate-800/80 text-slate-300 hover:text-white"
              title="Refresh containers"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-cyan-400' : ''}`} />
            </button>
            <button
              onClick={onToggleHelp}
              className="p-2 rounded-lg bg-cyan-950/60 border border-cyan-500/30 text-cyan-300"
              title="Quick Start"
            >
              <HelpCircle className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Center: Search & Status Filters */}
        <div className="flex flex-1 max-w-md items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search apps, ports, images..."
              className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg bg-slate-900/90 border border-slate-800 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/30 transition-all font-mono"
            />
          </div>

          <div className="flex rounded-lg bg-slate-900 border border-slate-800 p-0.5 text-xs font-mono">
            <button
              onClick={() => onStatusFilterChange('all')}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                statusFilter === 'all'
                  ? 'bg-slate-800 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All
            </button>
            <button
              onClick={() => onStatusFilterChange('running')}
              className={`px-2.5 py-1 rounded-md flex items-center gap-1 transition-colors ${
                statusFilter === 'running'
                  ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-500/30'
                  : 'text-slate-400 hover:text-emerald-400'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              Up
            </button>
            <button
              onClick={() => onStatusFilterChange('stopped')}
              className={`px-2.5 py-1 rounded-md flex items-center gap-1 transition-colors ${
                statusFilter === 'stopped'
                  ? 'bg-rose-950/80 text-rose-400 border border-rose-500/30'
                  : 'text-slate-400 hover:text-rose-400'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400"></span>
              Exited
            </button>
          </div>
        </div>

        {/* Right: Layout Switcher, Daemon Status, Actions */}
        <div className="flex flex-wrap items-center justify-end gap-2.5">
          {/* View Toggle: Custom Groups vs Compose Stacks */}
          <div className="flex rounded-lg bg-slate-900/90 border border-slate-800 p-0.5 text-xs font-mono">
            <button
              onClick={() => onViewModeChange('groups')}
              className={`px-3 py-1.5 rounded-md flex items-center gap-1.5 transition-all ${
                viewMode === 'groups'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-medium shadow-[0_0_10px_rgba(6,182,212,0.15)]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Group by custom user-defined categories"
            >
              <FolderKanban className="w-3.5 h-3.5" />
              <span>User Groups</span>
            </button>
            <button
              onClick={() => onViewModeChange('compose')}
              className={`px-3 py-1.5 rounded-md flex items-center gap-1.5 transition-all ${
                viewMode === 'compose'
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 font-medium shadow-[0_0_10px_rgba(168,85,247,0.15)]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Group automatically by docker-compose.yml project name"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Compose Stacks</span>
            </button>
          </div>

          {/* Socket Connection Pill */}
          <div
            className={`hidden xl:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-mono ${
              systemStatus?.dockerConnected
                ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
                : 'bg-amber-950/40 border-amber-500/30 text-amber-300'
            }`}
            title={
              systemStatus?.dockerConnected
                ? `Connected to host Docker Socket at ${systemStatus?.socketPath}`
                : `Standby / Demo Mode (Mount /var/run/docker.sock on Ubuntu for live socket)`
            }
          >
            {systemStatus?.dockerConnected ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Socket Active</span>
              </>
            ) : (
              <>
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                <span>Demo Mode</span>
              </>
            )}
          </div>

          {/* Host Automation & Privileges Badge */}
          <button
            onClick={onOpenAutomationModal}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-mono transition-all ${
              privileges?.mode === 'elevated'
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300 hover:bg-emerald-900/50 shadow-[0_0_10px_rgba(16,185,129,0.15)]'
                : 'bg-purple-950/50 border-purple-500/40 text-purple-300 hover:bg-purple-900/60 shadow-[0_0_10px_rgba(168,85,247,0.15)]'
            }`}
            title={
              privileges?.mode === 'elevated'
                ? 'Full Host Automation Active: Click to manage permissions'
                : 'Host Sandboxed: Click to view instructions to unlock 1-click execution'
            }
          >
            {privileges?.mode === 'elevated' ? (
              <>
                <Zap className="w-3.5 h-3.5 text-emerald-400" />
                <span className="hidden sm:inline">Host Automation:</span>
                <span className="font-bold text-emerald-400">Elevated</span>
              </>
            ) : (
              <>
                <ShieldAlert className="w-3.5 h-3.5 text-purple-400 animate-pulse" />
                <span className="hidden sm:inline">Host Mode:</span>
                <span className="font-bold text-purple-300">Sandboxed</span>
              </>
            )}
          </button>

          {/* Action buttons */}
          <div className="hidden md:flex items-center gap-1.5">
            {/* Combine / Merge Stacks Studio */}
            {onOpenStackMerger && (
              <button
                onClick={onOpenStackMerger}
                className="px-2.5 py-1.5 rounded-lg bg-purple-950/80 border border-purple-500/40 text-xs font-mono text-purple-300 hover:bg-purple-900/60 transition-colors flex items-center gap-1.5 shadow-[0_0_12px_rgba(168,85,247,0.15)]"
                title="Combine separate Docker Compose apps into a single stack"
              >
                <Layers className="w-3.5 h-3.5 text-purple-400" />
                <span>Merge Stacks</span>
              </button>
            )}

            {/* Merge State Ledger & Backups */}
            {onOpenHistory && (
              <button
                onClick={onOpenHistory}
                className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700/80 text-xs font-mono text-purple-300 hover:border-purple-500/40 hover:bg-purple-950/40 transition-colors flex items-center gap-1.5"
                title="Open Merge State Ledger & Snapshots"
              >
                <History className="w-3.5 h-3.5 text-purple-400" />
                <span className="hidden lg:inline">Ledger</span>
              </button>
            )}

            {/* System Diagnostic Logs Dashboard */}
            {onOpenLogs && (
              <button
                onClick={onOpenLogs}
                className="px-2.5 py-1.5 rounded-lg bg-emerald-950/80 border border-emerald-500/40 text-xs font-mono text-emerald-300 hover:bg-emerald-900/60 transition-colors flex items-center gap-1.5 shadow-[0_0_12px_rgba(16,185,129,0.15)]"
                title="Open Global Diagnostic Logging & Observability Dashboard"
              >
                <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                <span>Logs</span>
              </button>
            )}

            {/* Quick Simulate in Demo Mode */}
            {systemStatus?.isDemoMode && (
              <button
                onClick={onOpenSimulateModal}
                className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700/80 text-xs font-mono text-cyan-300 hover:border-cyan-500/40 hover:bg-slate-800 transition-colors flex items-center gap-1.5"
                title="Simulate adding or testing a container"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                <span>+ Simulate</span>
              </button>
            )}

            <button
              onClick={onOpenGroupManager}
              className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700 transition-colors"
              title="Manage Custom Categories"
            >
              <FolderKanban className="w-4 h-4" />
            </button>

            <button
              onClick={onOpenSettings}
              className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700 transition-colors"
              title="Dashboard Settings & Host IP"
            >
              <Settings className="w-4 h-4" />
            </button>

            <button
              onClick={onRefresh}
              className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700 transition-colors"
              title="Refresh Container Telemetry"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-cyan-400' : ''}`} />
            </button>

            {/* Help / Quick Start Toggle Button */}
            <button
              onClick={onToggleHelp}
              className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-cyan-950 to-slate-900 border border-cyan-500/40 text-xs font-medium text-cyan-300 hover:border-cyan-400 hover:shadow-[0_0_12px_rgba(6,182,212,0.25)] transition-all flex items-center gap-1.5"
              title="Toggle Help & Deployment Guide"
            >
              <HelpCircle className="w-3.5 h-3.5" />
              <span>Help / Deploy</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
