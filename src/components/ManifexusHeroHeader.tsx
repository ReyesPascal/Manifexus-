import React, { useState } from 'react';
import {
  Shield,
  Server,
  Activity,
  Cpu,
  HardDrive,
  Clock,
  Terminal,
  ExternalLink,
  Lock,
  Zap,
  Info,
  ChevronRight,
} from 'lucide-react';
import { DeepContainerMetadata, SystemStatus, AutomationPrivileges } from '../types';

interface ManifexusHeroHeaderProps {
  container?: DeepContainerMetadata;
  systemStatus: SystemStatus | null;
  privileges: AutomationPrivileges | null;
  onOpenElevateModal: () => void;
  onInspectContainer?: (container: DeepContainerMetadata) => void;
}

export const ManifexusHeroHeader: React.FC<ManifexusHeroHeaderProps> = ({
  container,
  systemStatus,
  privileges,
  onOpenElevateModal,
  onInspectContainer,
}) => {
  const [showQuickLogs, setShowQuickLogs] = useState(false);

  const isRunning = container?.state === 'running' || systemStatus?.dockerConnected;
  const isElevated = privileges?.mode === 'elevated';
  const containerId = container?.id ? container.id.substring(0, 12) : 'local-core';
  const uptime = container?.status || 'Up & Healthy';
  const port = container?.ports?.[0]?.publicPort || 3334;

  return (
    <div className="w-full mb-6">
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-[#0d1424] via-[#090e1c] to-[#070a14] border border-cyan-500/30 shadow-[0_4px_30px_rgba(6,182,212,0.08)]">
        
        {/* Subtle Decorative Background Glow */}
        <div className="absolute top-0 right-0 w-96 h-full bg-gradient-to-l from-cyan-500/5 to-transparent pointer-events-none" />
        <div className="absolute -top-12 -left-12 w-48 h-48 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />

        <div className="relative p-5 sm:p-6 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
          
          {/* Left: Identity & Protected Status */}
          <div className="flex items-start gap-4">
            <div className="relative flex-shrink-0">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-cyan-500/20 via-slate-800 to-slate-900 border border-cyan-400/40 flex items-center justify-center shadow-lg shadow-cyan-950/50">
                <Shield className="w-7 h-7 text-cyan-400" />
              </div>
              <span className="absolute -bottom-1 -right-1 flex h-4 w-4">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-4 w-4 bg-cyan-500 border-2 border-slate-950"></span>
              </span>
            </div>

            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-xl font-black tracking-tight text-white flex items-center gap-2">
                  Manifexus
                  <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-cyan-950/90 text-cyan-300 border border-cyan-500/40">
                    v2.5.0 Core
                  </span>
                </h2>

                {/* Directive 1: Distinctive "System Orchestrator / Protected Stack" badge */}
                <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono uppercase bg-cyan-950/80 border border-cyan-400/50 text-cyan-300 shadow-sm">
                  <Lock className="w-3 h-3 text-cyan-400" />
                  System Orchestrator · Protected Stack
                </div>
              </div>

              <p className="text-xs text-slate-400 mt-1.5 max-w-xl leading-relaxed">
                Immutable core control plane managing host compose synthesis, automated AST migrations, and zero-loss container orchestration.
              </p>

              {/* Telemetry Pills */}
              <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-3 text-[11px] font-mono text-slate-400">
                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-900/90 border border-slate-800 text-slate-300">
                  <Activity className="w-3.5 h-3.5 text-emerald-400" />
                  {uptime}
                </span>

                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-900/90 border border-slate-800 text-slate-300">
                  <Server className="w-3.5 h-3.5 text-cyan-400" />
                  ID: <code className="text-cyan-300 font-bold">{containerId}</code>
                </span>

                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-900/90 border border-slate-800 text-slate-300">
                  <Clock className="w-3.5 h-3.5 text-slate-400" />
                  Port: <code className="text-slate-200">:{port}</code>
                </span>

                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-900/90 border border-slate-800 text-slate-300">
                  <HardDrive className="w-3.5 h-3.5 text-purple-400" />
                  Backups: <code className="text-purple-300 font-bold">/app/backups</code>
                </span>
              </div>
            </div>
          </div>

          {/* Right: Privilege Mode & Protected Controls (No standard merge/delete!) */}
          <div className="flex flex-col sm:flex-row lg:flex-col items-stretch lg:items-end gap-3 w-full lg:w-auto flex-shrink-0">
            {/* Automation Privilege Status Badge */}
            <div
              onClick={onOpenElevateModal}
              className={`px-4 py-2 rounded-xl border flex items-center justify-between gap-3 cursor-pointer transition-all hover:scale-[1.02] ${
                isElevated
                  ? 'bg-emerald-950/50 border-emerald-500/40 text-emerald-300 hover:border-emerald-400'
                  : 'bg-cyan-950/40 border-cyan-500/40 text-cyan-300 hover:border-cyan-400'
              }`}
            >
              <div className="flex items-center gap-2.5 text-xs font-mono">
                <Zap className={`w-4 h-4 ${isElevated ? 'text-emerald-400' : 'text-cyan-400'}`} />
                <div>
                  <div className="font-bold flex items-center gap-1.5">
                    {isElevated ? 'ELEVATED AUTOMATION' : 'SANDBOXED MODE'}
                    <span className="text-[10px] opacity-70">
                      ({privileges?.isHostFsMounted ? 'Host FS Mounted' : 'Docker Socket'})
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-400 font-normal">
                    {isElevated ? 'Full 1-click AST deployment active' : 'Click to elevate permissions'}
                  </div>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 opacity-70" />
            </div>

            {/* Read-Only Inspection Buttons (Safe, no mutating controls) */}
            <div className="flex items-center gap-2">
              {container && onInspectContainer && (
                <button
                  onClick={() => onInspectContainer(container)}
                  className="px-3.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-mono text-slate-300 hover:text-white transition-all flex items-center gap-1.5"
                >
                  <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                  Health & Logs
                </button>
              )}

              <button
                onClick={() => setShowQuickLogs(!showQuickLogs)}
                className="px-3 py-1.5 rounded-lg bg-slate-900/60 hover:bg-slate-800 border border-slate-800 text-xs font-mono text-slate-400 hover:text-slate-200 transition-all flex items-center gap-1.5"
              >
                <Info className="w-3.5 h-3.5 text-slate-400" />
                {showQuickLogs ? 'Hide Stats' : 'Quick Stats'}
              </button>
            </div>
          </div>
        </div>

        {/* Quick Stats Drawer */}
        {showQuickLogs && (
          <div className="px-6 py-4 bg-slate-950/80 border-t border-slate-800/80 text-xs font-mono text-slate-400 flex flex-wrap gap-6 items-center">
            <div>
              <span className="text-slate-500">Host OS:</span>{' '}
              <span className="text-slate-200">{systemStatus?.operatingSystem || 'Linux (Docker Container)'}</span>
            </div>
            <div>
              <span className="text-slate-500">Docker Version:</span>{' '}
              <span className="text-slate-200">{systemStatus?.dockerVersion || 'v27.0+'}</span>
            </div>
            <div>
              <span className="text-slate-500">Root Directory:</span>{' '}
              <span className="text-cyan-400">{container?.compose?.workingDir || '/app'}</span>
            </div>
            <div>
              <span className="text-slate-500">Self-Protection:</span>{' '}
              <span className="text-emerald-400 font-bold">ACTIVE (Excluded from Merge Studio)</span>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};
