import React from 'react';
import { Shield, Layers, Clock, Search, GitCommit } from 'lucide-react';
import { DeepContainerMetadata, SystemStatus } from '../types';

interface ManifexusHeroHeaderProps {
  container?: DeepContainerMetadata;
  systemStatus: SystemStatus | null;
  onInspectContainer?: (container: DeepContainerMetadata) => void;
  versionLabel?: string;
  updateAvailable?: boolean;
  onOpenUpdates?: () => void;
  /** Number of stacks, same as the Stacks card */
  stackCount?: number;
}

/** A small label with a tooltip that appears above it on hover or keyboard focus */
const Pill: React.FC<{
  tip: string;
  className?: string;
  onClick?: () => void;
  children: React.ReactNode;
}> = ({ tip, className = '', onClick, children }) => {
  const base = `group relative flex items-center gap-1.5 px-2 py-0.5 rounded-md border transition-colors ${className}`;
  const tooltip = (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-1/2 bottom-full z-20 mb-2 w-max max-w-[220px] -translate-x-1/2 translate-y-1 rounded-lg border border-slate-700/80 bg-slate-950/95 px-2.5 py-1.5 text-[10.5px] font-sans font-normal leading-snug text-slate-300 opacity-0 shadow-xl shadow-black/40 backdrop-blur transition-all duration-150 delay-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 whitespace-normal text-center"
    >
      {tip}
      <span className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-slate-700/80" />
    </span>
  );
  return onClick ? (
    <button type="button" onClick={onClick} aria-label={tip} className={`${base} cursor-pointer focus:outline-none`}>
      {children}
      {tooltip}
    </button>
  ) : (
    <span tabIndex={0} aria-label={tip} className={`${base} cursor-default focus:outline-none`}>
      {children}
      {tooltip}
    </span>
  );
};

const neutral = 'bg-slate-900/90 border-slate-800 text-slate-300 hover:border-slate-700';

export const ManifexusHeroHeader: React.FC<ManifexusHeroHeaderProps> = ({
  container,
  systemStatus,
  onInspectContainer,
  versionLabel,
  updateAvailable,
  onOpenUpdates,
  stackCount,
}) => {
  const port = container?.ports?.[0]?.publicPort || 3334;
  const socketOn = !!systemStatus?.dockerConnected;
  // The server labels builds "Build <revision>" or "Development build"; show just the revision after "Build:"
  const build = !versionLabel ? undefined : versionLabel.startsWith('Build ') ? versionLabel.slice(6) : 'dev';

  return (
    <div className="w-full mb-6">
      <div className="relative rounded-2xl bg-gradient-to-r from-[#0d1424] via-[#090e1c] to-[#070a14] border border-cyan-500/30 shadow-[0_4px_30px_rgba(6,182,212,0.08)]">
        {/* Subtle Decorative Background Glow */}
        <div className="absolute inset-0 overflow-hidden rounded-2xl pointer-events-none">
          <div className="absolute top-0 right-0 w-96 h-full bg-gradient-to-l from-cyan-500/5 to-transparent" />
          <div className="absolute -top-12 -left-12 w-48 h-48 rounded-full bg-cyan-500/10 blur-3xl" />
        </div>

        <div className="relative p-5 sm:p-6 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
          {/* Left: Identity */}
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
              <h2 className="text-xl font-black tracking-tight text-white">Manifexus</h2>

              <p className="text-xs text-slate-400 mt-1.5 max-w-xl leading-relaxed">
                Immutable core control plane managing host compose synthesis, automated AST migrations, and zero-loss container orchestration.
              </p>

              {/* Telemetry Pills */}
              <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-3 text-[11px] font-mono text-slate-400">
                <Pill
                  tip={
                    updateAvailable
                      ? 'The Manifexus version you are running. An update is available. Click to open Software Update.'
                      : 'The Manifexus version you are running. Click to open Software Update.'
                  }
                  onClick={onOpenUpdates}
                  className={
                    updateAvailable
                      ? 'bg-[#0A84FF]/15 border-[#0A84FF]/50 text-[#6CB6FF] hover:bg-[#0A84FF]/25'
                      : `${neutral} hover:border-cyan-500/50`
                  }
                >
                  <GitCommit className={`w-3.5 h-3.5 ${updateAvailable ? 'text-[#6CB6FF]' : 'text-cyan-400'}`} />
                  Build: <code className={`font-bold ${updateAvailable ? '' : 'text-cyan-300'}`}>{build || '…'}</code>
                  {updateAvailable && <span className="w-1.5 h-1.5 rounded-full bg-[#0A84FF]" />}
                </Pill>

                <Pill
                  tip={
                    socketOn
                      ? 'Manifexus is connected to Docker and can see and manage your containers.'
                      : 'Manifexus cannot reach Docker, so containers cannot be seen or managed.'
                  }
                  className={
                    socketOn
                      ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300 hover:border-emerald-400/60'
                      : 'bg-rose-950/40 border-rose-500/40 text-rose-300 hover:border-rose-400/60'
                  }
                >
                  <span className={`w-2 h-2 rounded-full ${socketOn ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                  Docker Socket: <code className="font-bold">{socketOn ? 'On' : 'Off'}</code>
                </Pill>

                <Pill tip="The port this Manifexus dashboard is served on." className={neutral}>
                  <Clock className="w-3.5 h-3.5 text-slate-400" />
                  Port: <code className="text-slate-200">:{port}</code>
                </Pill>

                <Pill tip="How many Docker Compose stacks your apps are grouped into." className={neutral}>
                  <Layers className="w-3.5 h-3.5 text-purple-400" />
                  Stacks: <code className="text-purple-300 font-bold">{stackCount ?? '…'}</code>
                </Pill>
              </div>
            </div>
          </div>

          {/* Right: Read-only inspection */}
          {container && onInspectContainer && (
            <button
              onClick={() => onInspectContainer(container)}
              className="flex-shrink-0 px-3.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-mono text-slate-300 hover:text-white transition-all flex items-center gap-1.5 shadow-sm"
              title="Inspect container health, mounts, environment, and logs"
            >
              <Search className="w-3.5 h-3.5 text-cyan-400" />
              Inspect
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
