import React, { useState } from 'react';
import {
  ExternalLink,
  Info,
  Layers,
  Play,
  Square,
  RotateCw,
  FolderPlus,
  Radio,
  Server,
  Terminal,
} from 'lucide-react';
import { DeepContainerMetadata, UserGroup } from '../types';

interface AppCardProps {
  container: DeepContainerMetadata;
  hostAddress: string;
  groups: UserGroup[];
  onInspect: (container: DeepContainerMetadata) => void;
  onAssignGroup: (containerId: string, groupId: string) => void;
  onAction: (containerId: string, action: 'start' | 'stop' | 'restart') => Promise<void>;
}

export const AppCard: React.FC<AppCardProps> = ({
  container,
  hostAddress,
  groups,
  onInspect,
  onAssignGroup,
  onAction,
}) => {
  const [imgError, setImgError] = useState(false);
  const [isActing, setIsActing] = useState(false);
  const [showGroupSelect, setShowGroupSelect] = useState(false);

  const isRunning = container.state === 'running';
  const displayName = container.customName || container.cleanName;
  const primaryPort = container.primaryPort;

  // Build target URL
  const targetUrl = container.customUrl
    ? container.customUrl
    : primaryPort
    ? `http://${hostAddress || 'localhost'}:${primaryPort}`
    : undefined;

  const handleActionClick = async (
    e: React.MouseEvent,
    action: 'start' | 'stop' | 'restart'
  ) => {
    e.stopPropagation();
    e.preventDefault();
    setIsActing(true);
    try {
      await onAction(container.id, action);
    } finally {
      setIsActing(false);
    }
  };

  const handleGroupChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation();
    const newGroup = e.target.value;
    onAssignGroup(container.id, newGroup);
    setShowGroupSelect(false);
  };

  const currentGroup = groups.find((g) => g.id === container.customGroup);

  return (
    <div
      className={`group relative bg-[#0d121f] border rounded-2xl p-5 transition-all duration-200 flex flex-col justify-between overflow-hidden shadow-lg ${
        isRunning
          ? 'border-slate-800 hover:border-cyan-500/50 hover:shadow-[0_0_25px_rgba(6,182,212,0.12)]'
          : 'border-slate-850 opacity-75 hover:opacity-100 hover:border-slate-700'
      }`}
    >
      {/* Subtle top edge tech glow for running containers */}
      {isRunning && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-cyan-500/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
      )}

      {/* Top row: Status, Badges, and Action toolbar */}
      <div className="flex items-start justify-between gap-3 mb-4">
        {/* Status Indicator & Compose Pill */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Live Status Indicator */}
          <div
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-mono border ${
              isRunning
                ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-400'
                : 'bg-rose-950/60 border-rose-500/40 text-rose-400'
            }`}
            title={`Status: ${container.status}`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isRunning
                  ? 'bg-emerald-400 shadow-[0_0_8px_#10b981] animate-cyber-pulse'
                  : 'bg-rose-500'
              }`}
            ></span>
            <span className="capitalize">{isRunning ? 'Running' : container.state}</span>
          </div>

          {/* Docker Compose Stack Badge */}
          {container.compose.isCompose && container.compose.project && (
            <div
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono bg-purple-950/40 border border-purple-500/30 text-purple-300"
              title={`Compose Project: ${container.compose.project} (Service: ${container.compose.service || 'main'})`}
            >
              <Layers className="w-3 h-3 text-purple-400" />
              <span className="truncate max-w-[110px]">{container.compose.project}</span>
            </div>
          )}

          {/* User Group Badge */}
          {currentGroup && (
            <div
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono bg-slate-900 border text-slate-300"
              style={{ borderColor: `${currentGroup.color}40`, color: currentGroup.color }}
              title={`Custom Group: ${currentGroup.name}`}
            >
              <span>{currentGroup.name}</span>
            </div>
          )}
        </div>

        {/* Info & Inspect trigger */}
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onInspect(container);
            }}
            className="p-1.5 rounded-lg bg-slate-900/90 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 border border-slate-800 hover:border-cyan-500/40 transition-all"
            title="Inspect Deep Container Metadata"
          >
            <Info className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Tile Content: Big Icon + App Name + Image Tag */}
      <div className="flex items-center gap-4 my-2">
        {/* App Logo / Icon */}
        <div className="relative flex-shrink-0 w-14 h-14 rounded-xl bg-slate-900/90 border border-slate-800 p-2 flex items-center justify-center overflow-hidden shadow-inner group-hover:border-cyan-500/30 transition-colors">
          {!imgError && container.iconUrl ? (
            <img
              src={container.iconUrl}
              alt={displayName}
              onError={() => setImgError(true)}
              referrerPolicy="no-referrer"
              className="w-10 h-10 object-contain drop-shadow"
            />
          ) : (
            <div className="flex items-center justify-center w-full h-full text-cyan-400 font-mono font-bold text-lg bg-cyan-950/40 rounded-lg">
              {displayName.slice(0, 2).toUpperCase()}
            </div>
          )}
        </div>

        {/* Name and Image details */}
        <div className="flex-1 min-w-0">
          <h3
            className="text-base font-bold text-slate-100 font-mono tracking-tight truncate group-hover:text-cyan-300 transition-colors"
            title={displayName}
          >
            {displayName}
          </h3>
          <p
            className="text-xs text-slate-400 font-mono truncate mt-0.5"
            title={container.image}
          >
            {container.image}
          </p>
          <div className="text-[11px] text-slate-500 font-mono truncate mt-0.5">
            ID: <span className="text-slate-400">{container.id}</span>
          </div>
        </div>
      </div>

      {/* Technical Ports & Links Section */}
      <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-col gap-3">
        {/* Exposed / Mapped Ports */}
        <div className="flex flex-wrap items-center gap-1.5 min-h-[28px]">
          {container.ports.length > 0 ? (
            container.ports.map((p, idx) => (
              <span
                key={idx}
                className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono border ${
                  p.publicPort
                    ? 'bg-cyan-950/40 border-cyan-500/30 text-cyan-300'
                    : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                {p.publicPort ? (
                  <>
                    <span className="font-semibold text-cyan-300">:{p.publicPort}</span>
                    <span className="text-cyan-600/70 mx-1">→</span>
                    <span>{p.privatePort}/{p.type}</span>
                  </>
                ) : (
                  <span>{p.privatePort}/{p.type}</span>
                )}
              </span>
            ))
          ) : (
            <span className="text-xs text-slate-500 font-mono italic">
              No exposed host ports
            </span>
          )}
        </div>

        {/* Bottom Interactive Bar: Launch Button & Container Action Controls */}
        <div className="flex items-center justify-between gap-2 pt-1">
          {/* Direct Web Port Launcher (Opens in new tab) */}
          {targetUrl ? (
            <a
              href={targetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold font-mono bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 hover:border-cyan-400 hover:shadow-[0_0_15px_rgba(6,182,212,0.2)] transition-all text-center"
              title={`Open ${targetUrl} in a new tab`}
            >
              <span>Open Port {primaryPort}</span>
              <ExternalLink className="w-3.5 h-3.5 text-cyan-400" />
            </a>
          ) : (
            <button
              onClick={() => onInspect(container)}
              className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-mono bg-slate-900 text-slate-400 border border-slate-800 hover:border-slate-700 transition-colors"
            >
              <span>Inspect Container</span>
            </button>
          )}

          {/* Quick Group Assignment Toggle */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowGroupSelect(!showGroupSelect);
              }}
              className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-cyan-300 hover:border-slate-700 transition-colors"
              title="Assign to Custom Category"
            >
              <FolderPlus className="w-3.5 h-3.5" />
            </button>

            {showGroupSelect && (
              <div
                className="absolute right-0 bottom-full mb-2 w-48 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-2 z-30"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="text-[11px] font-mono text-slate-400 px-2 py-1 border-b border-slate-800 mb-1">
                  Assign Category
                </div>
                <select
                  value={container.customGroup || ''}
                  onChange={handleGroupChange}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 p-1.5 font-mono focus:outline-none focus:border-cyan-500"
                  size={5}
                >
                  <option value="">-- No Category --</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Container Lifecycle Actions (Start/Stop/Restart) */}
          <div className="flex items-center gap-1 bg-slate-900/80 border border-slate-800 p-1 rounded-xl">
            {isRunning ? (
              <button
                onClick={(e) => handleActionClick(e, 'stop')}
                disabled={isActing}
                className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-950/30 transition-colors disabled:opacity-50"
                title="Stop container"
              >
                <Square className="w-3 h-3" />
              </button>
            ) : (
              <button
                onClick={(e) => handleActionClick(e, 'start')}
                disabled={isActing}
                className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-emerald-950/30 transition-colors disabled:opacity-50"
                title="Start container"
              >
                <Play className="w-3 h-3" />
              </button>
            )}

            <button
              onClick={(e) => handleActionClick(e, 'restart')}
              disabled={isActing}
              className={`p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-cyan-950/30 transition-colors disabled:opacity-50 ${
                isActing ? 'animate-spin text-cyan-400' : ''
              }`}
              title="Restart container"
            >
              <RotateCw className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
