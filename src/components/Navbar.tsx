import React from 'react';
import { Layers, FolderKanban, Settings, RefreshCw, PlusCircle, RotateCcw, FolderPlus } from 'lucide-react';
import { SystemStatus } from '../types';
import { UpdateGlyph } from './SoftwareUpdateSheet';

interface NavbarProps {
  systemStatus: SystemStatus | null;
  viewMode: 'groups' | 'compose';
  onViewModeChange: (mode: 'groups' | 'compose') => void;
  onOpenSettings: () => void;
  onOpenGroupManager: () => void;
  onOpenSimulateModal: () => void;
  onOpenCreateStack?: () => void;
  onOpenHistory?: () => void;
  /** Opens Software Update */
  onOpenUpdates: () => void;
  updateAvailable: boolean;
  updating: boolean;
  onRefresh: () => void;
  isRefreshing: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  systemStatus,
  viewMode,
  onViewModeChange,
  onOpenSettings,
  onOpenGroupManager,
  onOpenSimulateModal,
  onOpenCreateStack,
  onOpenHistory,
  onOpenUpdates,
  updateAvailable,
  updating,
  onRefresh,
  isRefreshing,
}) => {
  const iconBtn =
    'p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700 transition-colors focus-visible:outline-2 focus-visible:outline-cyan-400';

  return (
    <header className="sticky top-0 z-40 bg-[#07090e]/90 backdrop-blur-md border-b border-slate-800/80 px-4 lg:px-6 py-3">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
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

        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {onOpenCreateStack && (
            <button
              onClick={onOpenCreateStack}
              className="px-2.5 py-1.5 rounded-lg bg-cyan-950/80 border border-cyan-500/40 text-xs font-mono text-cyan-300 hover:bg-cyan-900/60 transition-colors flex items-center gap-1.5 shadow-[0_0_12px_rgba(6,182,212,0.15)] cursor-pointer"
              title="Create a new empty compose stack directory"
            >
              <FolderPlus className="w-3.5 h-3.5 text-cyan-400" />
              <span>New Stack</span>
            </button>
          )}

          {onOpenHistory && (
            <button
              onClick={onOpenHistory}
              className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700/80 text-xs font-mono text-purple-300 hover:border-purple-500/40 hover:bg-purple-950/40 transition-colors flex items-center gap-1.5"
              title="History: undo moves and deletes"
            >
              <RotateCcw className="w-3.5 h-3.5 text-purple-400" />
              <span className="hidden lg:inline">History</span>
            </button>
          )}

          {systemStatus?.isDemoMode && (
            <button
              onClick={onOpenSimulateModal}
              className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700/80 text-xs font-mono text-cyan-300 hover:border-cyan-500/40 hover:bg-slate-800 transition-colors flex items-center gap-1.5"
              title="Simulate adding or testing a container"
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>Simulate</span>
            </button>
          )}

          {/* Software Update: quiet icon normally; a labeled pill when an update is ready */}
          {updateAvailable || updating ? (
            <button
              onClick={onOpenUpdates}
              className="pl-2 pr-2.5 py-1.5 rounded-lg bg-[#0A84FF]/15 border border-[#0A84FF]/50 text-xs font-medium text-[#6CB6FF] hover:bg-[#0A84FF]/25 transition-colors flex items-center gap-1.5 focus-visible:outline-2 focus-visible:outline-[#0A84FF]"
              title={updating ? 'Manifexus is updating' : 'A new version of Manifexus is available'}
            >
              {updating ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <span className="relative flex">
                  <UpdateGlyph className="w-4 h-4" />
                  <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-[#0A84FF] ring-2 ring-[#07090e]" />
                </span>
              )}
              <span>{updating ? 'Updating…' : 'Update'}</span>
            </button>
          ) : (
            <button onClick={onOpenUpdates} className={iconBtn} title="Software Update" aria-label="Software Update">
              <UpdateGlyph className="w-4 h-4" />
            </button>
          )}

          <button onClick={onOpenGroupManager} className={iconBtn} title="Manage custom groups" aria-label="Manage custom groups">
            <FolderKanban className="w-4 h-4" />
          </button>

          <button onClick={onOpenSettings} className={iconBtn} title="Settings" aria-label="Settings">
            <Settings className="w-4 h-4" />
          </button>

          <button onClick={onRefresh} className={iconBtn} title="Refresh" aria-label="Refresh">
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-cyan-400' : ''}`} />
          </button>
        </div>
      </div>
    </header>
  );
};
