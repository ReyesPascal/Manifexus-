import React from 'react';
import {
  Activity,
  Layers,
  Radio,
  Server,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';
import { SystemStatus } from '../types';

interface StatsBarProps {
  systemStatus: SystemStatus | null;
  portsCount: number;
}

export const StatsBar: React.FC<StatsBarProps> = ({ systemStatus, portsCount }) => {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
      {/* Total Active Containers */}
      <div className="bg-[#0b0f19]/90 border border-slate-800/90 rounded-xl p-3.5 relative overflow-hidden group hover:border-cyan-500/40 transition-all">
        <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-1">
          <span>FLEET RUNNING</span>
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 animate-pulse"></span>
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold font-mono text-emerald-400">
            {systemStatus?.runningContainers ?? 0}
          </span>
          <span className="text-xs text-slate-500 font-mono">
            / {systemStatus?.totalContainers ?? 0} total
          </span>
        </div>
      </div>

      {/* Stopped / Inactive */}
      <div className="bg-[#0b0f19]/90 border border-slate-800/90 rounded-xl p-3.5 relative overflow-hidden group hover:border-rose-500/30 transition-all">
        <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-1">
          <span>EXITED / STOPPED</span>
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500 animate-pulse shadow-[0_0_8px_rgba(244,63,94,0.8)]"></span>
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold font-mono text-rose-400">
            {systemStatus?.stoppedContainers ?? 0}
          </span>
          <span className="text-xs text-slate-500 font-mono">offline</span>
        </div>
      </div>

      {/* Compose Stacks */}
      <div className="bg-[#0b0f19]/90 border border-slate-800/90 rounded-xl p-3.5 relative overflow-hidden group hover:border-purple-500/40 transition-all">
        <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-1">
          <span>COMPOSE STACKS</span>
          <Layers className="w-3.5 h-3.5 text-purple-400" />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold font-mono text-purple-400">
            {systemStatus?.composeStacksCount ?? 0}
          </span>
          <span className="text-xs text-slate-500 font-mono">projects</span>
        </div>
      </div>

      {/* Discovered Web Ports */}
      <div className="bg-[#0b0f19]/90 border border-slate-800/90 rounded-xl p-3.5 relative overflow-hidden group hover:border-cyan-500/40 transition-all">
        <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-1">
          <span>DISCOVERED PORTS</span>
          <Activity className="w-3.5 h-3.5 text-cyan-400" />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold font-mono text-cyan-400">
            {portsCount}
          </span>
          <span className="text-xs text-slate-500 font-mono">mapped</span>
        </div>
      </div>

      {/* Daemon Environment Info */}
      <div className="col-span-2 sm:col-span-3 lg:col-span-1 bg-[#0b0f19]/90 border border-slate-800/90 rounded-xl p-3.5 relative overflow-hidden group hover:border-slate-700 transition-all">
        <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-1">
          <span>DOCKER ENGINE</span>
          <Server className="w-3.5 h-3.5 text-slate-400" />
        </div>
        <div className="text-xs font-mono text-slate-300 truncate">
          v{systemStatus?.dockerVersion || '26.x'}
        </div>
        <div className="text-[11px] font-mono text-slate-500 truncate mt-0.5">
          {systemStatus?.operatingSystem || 'Ubuntu Linux'}
        </div>
      </div>
    </div>
  );
};
