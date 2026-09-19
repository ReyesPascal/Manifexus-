import React, { useState } from 'react';
import { X, Settings, Server, Globe, Save } from 'lucide-react';
import { ManifexusConfig } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: ManifexusConfig | null;
  onSaveConfig: (updated: Partial<ManifexusConfig>) => Promise<void>;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  config,
  onSaveConfig,
}) => {
  if (!isOpen) return null;

  const [hostAddress, setHostAddress] = useState(config?.hostAddress || 'localhost');
  const [refreshInterval, setRefreshInterval] = useState(config?.refreshIntervalSeconds || 10);
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await onSaveConfig({
        hostAddress: hostAddress.trim() || 'localhost',
        refreshIntervalSeconds: Number(refreshInterval) || 10,
      });
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="w-full max-w-md bg-[#0b0f19] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden font-mono text-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-cyan-400" />
            <h2 className="text-base font-bold text-white">Hub Configuration</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs">
          {/* Host IP / Domain */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-slate-300 font-bold">
              <Globe className="w-4 h-4 text-cyan-400" />
              <span>Host IP / Base Domain</span>
            </label>
            <input
              type="text"
              value={hostAddress}
              onChange={(e) => setHostAddress(e.target.value)}
              placeholder="localhost or 192.168.1.150 or homelab.local"
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
            />
            <p className="text-[11px] text-slate-400">
              When clicking port links on app cards, this address is used (e.g. <code className="text-cyan-300">http://{hostAddress || 'localhost'}:PORT</code>).
            </p>
          </div>

          {/* Auto Refresh Interval */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-slate-300 font-bold">
              <Server className="w-4 h-4 text-cyan-400" />
              <span>Telemetry Auto-Refresh (Seconds)</span>
            </label>
            <input
              type="number"
              min="3"
              max="120"
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
            />
            <p className="text-[11px] text-slate-400">
              Frequency for querying the Docker daemon socket for new containers and status changes.
            </p>
          </div>

          <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 text-[11px] text-slate-400 space-y-1">
            <div className="text-slate-300 font-semibold">Persistence Note</div>
            <div>
              Configurations are saved to <code className="text-cyan-300">/data/config.json</code> in your mapped host volume.
            </div>
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-4 py-2 rounded-xl bg-cyan-500 text-slate-950 font-bold hover:bg-cyan-400 transition-colors flex items-center gap-1.5 shadow-[0_0_12px_rgba(6,182,212,0.3)] disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{isSaving ? 'Saving...' : 'Save Settings'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
