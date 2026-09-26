import React from 'react';
import { Activity, ChevronRight, Layers } from 'lucide-react';

export type StatusFilter = 'all' | 'running' | 'stopped';

interface StatsBarProps {
  running: number;
  stopped: number;
  total: number;
  stacks: number;
  portsInUse: number;
  statusFilter: StatusFilter;
  onStatusFilterChange: (f: StatusFilter) => void;
  onShowStacks: () => void;
  onShowPorts: () => void;
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/**
 * Dashboard summary cards. Running / Stopped filter the app list (click again to show all),
 * Stacks switches to the stacks view, Ports opens the ports sheet.
 * All numbers are computed from the same list the dashboard shows.
 */
export const StatsBar: React.FC<StatsBarProps> = ({
  running,
  stopped,
  total,
  stacks,
  portsInUse,
  statusFilter,
  onStatusFilterChange,
  onShowStacks,
  onShowPorts,
}) => {
  const toggle = (f: StatusFilter) => onStatusFilterChange(statusFilter === f ? 'all' : f);

  const base =
    'text-left bg-[#0b0f19]/90 border rounded-xl p-3.5 transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400';

  return (
    <div className="mb-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <button
          type="button"
          onClick={() => toggle('running')}
          aria-pressed={statusFilter === 'running'}
          className={`${base} ${
            statusFilter === 'running'
              ? 'border-emerald-400/70 bg-emerald-500/[0.07] shadow-[0_0_0_1px_rgba(52,211,153,0.25)]'
              : 'border-slate-800/90 hover:border-emerald-500/40'
          }`}
          title={statusFilter === 'running' ? 'Show all apps' : 'Show only running apps'}
        >
          <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-1">
            <span>RUNNING</span>
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-emerald-400">{running}</span>
            <span className="text-xs text-slate-500 font-mono">
              of {total} {plural(total, 'app')}
            </span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => toggle('stopped')}
          aria-pressed={statusFilter === 'stopped'}
          className={`${base} ${
            statusFilter === 'stopped'
              ? 'border-rose-400/70 bg-rose-500/[0.07] shadow-[0_0_0_1px_rgba(251,113,133,0.25)]'
              : 'border-slate-800/90 hover:border-rose-500/40'
          }`}
          title={statusFilter === 'stopped' ? 'Show all apps' : 'Show only stopped apps'}
        >
          <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-1">
            <span>STOPPED</span>
            <span className={`h-2 w-2 rounded-full ${stopped > 0 ? 'bg-rose-400' : 'bg-slate-600'}`} />
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`text-2xl font-bold font-mono ${stopped > 0 ? 'text-rose-400' : 'text-slate-500'}`}>{stopped}</span>
            <span className="text-xs text-slate-500 font-mono">{plural(stopped, 'app')}</span>
          </div>
        </button>

        <button
          type="button"
          onClick={onShowStacks}
          className={`${base} border-slate-800/90 hover:border-purple-500/40`}
          title="Show apps grouped by stack"
        >
          <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-1">
            <span>STACKS</span>
            <Layers className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-purple-400">{stacks}</span>
            <span className="text-xs text-slate-500 font-mono">{plural(stacks, 'stack')}</span>
          </div>
        </button>

        <button
          type="button"
          onClick={onShowPorts}
          className={`${base} border-slate-800/90 hover:border-cyan-500/40 group`}
          title="See which ports are in use"
        >
          <div className="flex items-center justify-between text-xs text-slate-400 font-mono mb-1">
            <span>PORTS</span>
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-cyan-400">{portsInUse}</span>
            <span className="text-xs text-slate-500 font-mono">in use</span>
            <ChevronRight className="w-3.5 h-3.5 text-slate-600 ml-auto self-center group-hover:text-cyan-400 transition-colors" />
          </div>
        </button>
      </div>

    </div>
  );
};
