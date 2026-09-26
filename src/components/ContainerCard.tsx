import React, { useState } from 'react';
import {
  ExternalLink,
  Play,
  Square,
  Trash2,
  Server,
  Layers,
  Globe,
  Radio,
  RotateCw,
} from 'lucide-react';
import { DeepContainerMetadata } from '../types';

export interface ContainerCardProps {
  container: DeepContainerMetadata;
  onStart?: (id: string) => Promise<void> | void;
  onStop?: (id: string) => Promise<void> | void;
  onRestart?: (id: string) => Promise<void> | void;
  onDelete?: (id: string) => Promise<void> | void;
  hostAddress?: string;
  onInspect?: (container: DeepContainerMetadata) => void;
}

export const ContainerCard: React.FC<ContainerCardProps> = ({
  container,
  onStart,
  onStop,
  onRestart,
  onDelete,
  hostAddress = window.location.hostname || 'localhost',
  onInspect,
}) => {
  const [isActing, setIsActing] = useState(false);

  const isRunning = container.state === 'running';
  const displayName = container.customName || container.cleanName || container.name.replace(/^\//, '');
  const primaryPort = container.primaryPort || (container.ports.find((p) => Boolean(p.publicPort))?.publicPort);
  const publishedPorts = container.ports.filter((p) => Boolean(p.publicPort));

  // Determine web UI URL
  const targetUrl = container.customUrl
    ? container.customUrl
    : primaryPort
    ? `http://${hostAddress}:${primaryPort}`
    : undefined;

  const handleStart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onStart) return;
    setIsActing(true);
    try {
      await onStart(container.id);
    } finally {
      setIsActing(false);
    }
  };

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onStop) return;
    setIsActing(true);
    try {
      await onStop(container.id);
    } finally {
      setIsActing(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onDelete) return;
    setIsActing(true);
    try {
      await onDelete(container.id);
    } finally {
      setIsActing(false);
    }
  };

  return (
    <div
      className={`group relative bg-[#0d121f] border rounded-2xl p-5 transition-all duration-200 flex flex-col justify-between overflow-hidden shadow-lg ${
        isRunning
          ? 'border-slate-800 hover:border-cyan-500/50 hover:shadow-[0_0_25px_rgba(6,182,212,0.12)]'
          : 'border-slate-850 opacity-80 hover:opacity-100 hover:border-slate-700'
      }`}
      onClick={() => onInspect?.(container)}
    >
      {/* Top glow bar on running containers */}
      {isRunning && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-cyan-500/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
      )}

      {/* Header Badges */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-2">
          {/* Status Badge */}
          <div
            className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-mono border ${
              isRunning
                ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-400'
                : 'bg-rose-950/60 border-rose-500/40 text-rose-400'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isRunning
                  ? 'bg-emerald-400 shadow-[0_0_8px_#10b981] animate-pulse'
                  : 'bg-rose-500'
              }`}
            ></span>
            <span className="capitalize">{isRunning ? 'Running' : container.state}</span>
          </div>

          {/* Docker Compose Badge */}
          {container.compose?.isCompose && container.compose?.project && (
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono bg-purple-950/40 border border-purple-500/30 text-purple-300">
              <Layers className="w-3 h-3 text-purple-400" />
              <span className="truncate max-w-[120px]">{container.compose.project}</span>
            </div>
          )}
        </div>

        {/* Delete Trigger */}
        {onDelete && (
          <button
            onClick={handleDelete}
            disabled={isActing}
            className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-950/40 border border-transparent hover:border-rose-500/30 transition-colors"
            title="Delete Container"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Main Info */}
      <div className="space-y-2 mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-cyan-400 flex-shrink-0 group-hover:border-cyan-500/40 transition-colors">
            {container.iconUrl ? (
              <img
                src={container.iconUrl}
                alt={displayName}
                className="w-6 h-6 object-contain"
                onError={(e) => {
                  (e.target as HTMLElement).style.display = 'none';
                }}
              />
            ) : (
              <Server className="w-5 h-5 text-cyan-400" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-bold text-white tracking-tight truncate text-base font-mono group-hover:text-cyan-300 transition-colors">
              {displayName}
            </h3>
            <p className="text-xs text-slate-500 font-mono truncate" title={container.image}>
              {container.image}
            </p>
          </div>
        </div>

        {/* Port Pills */}
        {publishedPorts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {publishedPorts.map((p, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-slate-900/80 border border-slate-800 text-slate-300"
              >
                <Radio className="w-2.5 h-2.5 text-cyan-400" />
                <span>
                  {p.publicPort}
                  <span className="text-slate-500">:{p.privatePort}</span>
                </span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Bottom Action Footer */}
      <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2 mt-auto">
        {/* Open Web UI Button */}
        {targetUrl && isRunning ? (
          <a
            href={targetUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-950/60 hover:bg-cyan-900/70 border border-cyan-500/40 text-cyan-300 hover:text-cyan-200 text-xs font-mono transition-colors shadow-sm"
          >
            <Globe className="w-3.5 h-3.5 text-cyan-400" />
            <span>Open UI</span>
            <ExternalLink className="w-3 h-3 text-cyan-400" />
          </a>
        ) : (
          <div className="text-[11px] font-mono text-slate-600">
            {isRunning ? 'No web port exposed' : 'Service stopped'}
          </div>
        )}

        {/* Action Controls */}
        <div className="flex items-center gap-1.5">
          {isRunning ? (
            <button
              onClick={handleStop}
              disabled={isActing}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 border border-rose-500/30 text-rose-300 text-xs font-mono transition-colors disabled:opacity-50"
              title="Stop container"
            >
              {isActing ? (
                <RotateCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Square className="w-3.5 h-3.5 fill-current" />
              )}
              <span>Stop</span>
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={isActing}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-950/40 hover:bg-emerald-900/60 border border-emerald-500/30 text-emerald-300 text-xs font-mono transition-colors disabled:opacity-50"
              title="Start container"
            >
              {isActing ? (
                <RotateCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5 fill-current" />
              )}
              <span>Start</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ContainerCard;
