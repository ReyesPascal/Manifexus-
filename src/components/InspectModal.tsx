import React, { useState } from 'react';
import {
  X,
  FileCode,
  Folder,
  HardDrive,
  Network,
  Cpu,
  Eye,
  EyeOff,
  Copy,
  Check,
  Edit3,
  Save,
  Layers,
  Terminal,
  ExternalLink,
} from 'lucide-react';
import { DeepContainerMetadata, UserGroup, AppOverride } from '../types';

interface InspectModalProps {
  container: DeepContainerMetadata | null;
  groups: UserGroup[];
  hostAddress: string;
  onClose: () => void;
  onSaveOverride: (containerId: string, override: AppOverride) => Promise<void>;
}

export const InspectModal: React.FC<InspectModalProps> = ({
  container,
  groups,
  hostAddress,
  onClose,
  onSaveOverride,
}) => {
  if (!container) return null;

  const [activeTab, setActiveTab] = useState<'compose' | 'mounts' | 'env' | 'network' | 'settings'>('compose');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [revealedEnvs, setRevealedEnvs] = useState<Record<string, boolean>>({});

  // Form state for customization tab
  const [customName, setCustomName] = useState(container.customName || '');
  const [customGroup, setCustomGroup] = useState(container.customGroup || '');
  const [customPort, setCustomPort] = useState(container.primaryPort ? String(container.primaryPort) : '');
  const [customUrl, setCustomUrl] = useState(container.customUrl || '');
  const [customIcon, setCustomIcon] = useState(container.iconUrl || '');
  const [notes, setNotes] = useState(container.notes || '');
  const [isSaving, setIsSaving] = useState(false);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const toggleReveal = (key: string) => {
    setRevealedEnvs((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await onSaveOverride(container.id, {
        customName: customName.trim() || undefined,
        customGroup: customGroup || undefined,
        customPort: customPort ? parseInt(customPort, 10) : undefined,
        customUrl: customUrl.trim() || undefined,
        customIcon: customIcon.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  const isRunning = container.state === 'running';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-3xl max-h-[90vh] flex flex-col bg-[#0b0f19] border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden font-mono text-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-slate-800/80 border border-slate-700 flex items-center justify-center p-1.5 overflow-hidden">
              {container.iconUrl ? (
                <img
                  src={container.iconUrl}
                  alt={container.cleanName}
                  className="w-7 h-7 object-contain"
                />
              ) : (
                <Layers className="w-5 h-5 text-cyan-400" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white tracking-tight">
                  {container.customName || container.cleanName}
                </h2>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase ${
                    isRunning
                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                      : 'bg-rose-950 text-rose-300 border border-rose-500/40'
                  }`}
                >
                  {container.state}
                </span>
              </div>
              <p className="text-xs text-slate-400 truncate max-w-md">
                {container.image}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 bg-slate-950/60 px-6 gap-2 text-xs overflow-x-auto">
          <button
            onClick={() => setActiveTab('compose')}
            className={`py-3 px-3 border-b-2 font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${
              activeTab === 'compose'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileCode className="w-4 h-4" />
            <span>Compose & Specs</span>
          </button>

          <button
            onClick={() => setActiveTab('mounts')}
            className={`py-3 px-3 border-b-2 font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${
              activeTab === 'mounts'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <HardDrive className="w-4 h-4" />
            <span>Volumes & Mounts ({container.mounts.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('env')}
            className={`py-3 px-3 border-b-2 font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${
              activeTab === 'env'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu className="w-4 h-4" />
            <span>Environment ({container.envVars.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('network')}
            className={`py-3 px-3 border-b-2 font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${
              activeTab === 'network'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Network className="w-4 h-4" />
            <span>Ports & Networks</span>
          </button>

          <button
            onClick={() => setActiveTab('settings')}
            className={`py-3 px-3 border-b-2 font-medium flex items-center gap-2 transition-colors whitespace-nowrap ${
              activeTab === 'settings'
                ? 'border-purple-400 text-purple-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Edit3 className="w-4 h-4" />
            <span>Custom Overrides</span>
          </button>
        </div>

        {/* Tab Content Container */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* TAB 1: COMPOSE & SPECS */}
          {activeTab === 'compose' && (
            <div className="space-y-4">
              {container.compose.isCompose ? (
                <div className="p-4 rounded-xl bg-purple-950/20 border border-purple-500/30 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-purple-300 uppercase tracking-wider flex items-center gap-2">
                      <Layers className="w-4 h-4" />
                      Docker Compose Project Detected
                    </span>
                    <span className="px-2 py-0.5 rounded text-[10px] bg-purple-900/60 text-purple-200 font-mono">
                      Service: {container.compose.service || 'app'}
                    </span>
                  </div>

                  {/* Project Name */}
                  <div>
                    <label className="text-[11px] text-slate-400">Compose Project Name</label>
                    <div className="text-sm font-bold text-white">{container.compose.project}</div>
                  </div>

                  {/* Host Working Directory (Strict requirement) */}
                  <div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                      <span>Working Directory (com.docker.compose.project.working_dir)</span>
                      {container.compose.workingDir && (
                        <button
                          onClick={() => handleCopy(container.compose.workingDir!, 'working_dir')}
                          className="hover:text-cyan-300 flex items-center gap-1"
                        >
                          {copiedKey === 'working_dir' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                          <span>Copy Path</span>
                        </button>
                      )}
                    </div>
                    <div className="p-2 rounded-lg bg-slate-950 border border-slate-800 text-cyan-300 text-xs break-all">
                      {container.compose.workingDir || 'Not specified in labels'}
                    </div>
                  </div>

                  {/* Config Files Path (Strict requirement) */}
                  <div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                      <span>Compose Config File (com.docker.compose.project.config_files)</span>
                      {container.compose.configFiles && (
                        <button
                          onClick={() => handleCopy(container.compose.configFiles!, 'config_files')}
                          className="hover:text-cyan-300 flex items-center gap-1"
                        >
                          {copiedKey === 'config_files' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                          <span>Copy Path</span>
                        </button>
                      )}
                    </div>
                    <div className="p-2 rounded-lg bg-slate-950 border border-slate-800 text-cyan-300 text-xs break-all">
                      {container.compose.configFiles || 'Not specified in labels'}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-2">
                  <div className="text-xs font-semibold text-slate-300 flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-cyan-400" />
                    Standard Container (Non-Compose)
                  </div>
                  <p className="text-xs text-slate-400">
                    This container was started via standard <code className="text-cyan-300 font-mono">docker run</code> or direct Docker API without Compose project labels.
                  </p>
                </div>
              )}

              {/* General Technical Specs */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-slate-900/50 border border-slate-800 space-y-1">
                  <span className="text-slate-400 text-[11px]">Base Image</span>
                  <div className="text-slate-200 font-bold break-all">{container.baseImage}</div>
                </div>

                <div className="p-3 rounded-lg bg-slate-900/50 border border-slate-800 space-y-1">
                  <span className="text-slate-400 text-[11px]">Full Container ID</span>
                  <div className="text-slate-200 font-mono break-all">{container.id}</div>
                </div>

                <div className="p-3 rounded-lg bg-slate-900/50 border border-slate-800 space-y-1">
                  <span className="text-slate-400 text-[11px]">Status & Uptime</span>
                  <div className="text-slate-200">{container.status}</div>
                </div>

                <div className="p-3 rounded-lg bg-slate-900/50 border border-slate-800 space-y-1">
                  <span className="text-slate-400 text-[11px]">Restart Policy</span>
                  <div className="text-slate-200 uppercase">{container.restartPolicy || 'no'}</div>
                </div>

                {container.command && (
                  <div className="col-span-1 md:col-span-2 p-3 rounded-lg bg-slate-900/50 border border-slate-800 space-y-1">
                    <span className="text-slate-400 text-[11px]">Startup Command</span>
                    <div className="text-cyan-300 font-mono text-xs break-all">{container.command}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: VOLUMES & MOUNTS */}
          {activeTab === 'mounts' && (
            <div className="space-y-3">
              <div className="text-xs text-slate-400">
                Mapped storage volumes, bind mounts, and persistent state directories on host:
              </div>

              {container.mounts.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-500 bg-slate-900/40 rounded-xl border border-slate-800">
                  No storage mounts configured for this container.
                </div>
              ) : (
                container.mounts.map((mount, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-xl bg-slate-900/70 border border-slate-800 space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-slate-800 text-slate-300">
                        {mount.type}
                      </span>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded ${
                          mount.rw ? 'bg-cyan-950 text-cyan-300' : 'bg-amber-950 text-amber-300'
                        }`}
                      >
                        {mount.rw ? 'Read/Write (rw)' : 'Read-Only (ro)'}
                      </span>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[11px] text-slate-400 w-24 flex-shrink-0">Host Source:</span>
                        <span className="text-cyan-300 font-mono break-all">{mount.source}</span>
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-[11px] text-slate-400 w-24 flex-shrink-0">Destination:</span>
                        <span className="text-slate-200 font-mono break-all">{mount.destination}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* TAB 3: ENVIRONMENT VARIABLES */}
          {activeTab === 'env' && (
            <div className="space-y-3">
              <div className="text-xs text-slate-400">
                Configured runtime environment variables. Sensitive tokens are masked for security:
              </div>

              {container.envVars.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-500 bg-slate-900/40 rounded-xl border border-slate-800">
                  No custom environment variables recorded.
                </div>
              ) : (
                <div className="space-y-2">
                  {container.envVars.map((env, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-xs font-mono"
                    >
                      <span className="text-slate-300 font-semibold">{env.key}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-400 truncate max-w-xs">
                          {env.value}
                        </span>
                        {env.isSensitive && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800">
                            Masked
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: PORTS & NETWORKS */}
          {activeTab === 'network' && (
            <div className="space-y-4 text-xs">
              <div>
                <h4 className="text-slate-300 font-bold mb-2">Exposed & Published Ports</h4>
                {container.ports.length === 0 ? (
                  <div className="p-3 bg-slate-900/50 rounded-lg text-slate-500 italic">
                    No ports exposed to host.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {container.ports.map((p, idx) => (
                      <div
                        key={idx}
                        className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between"
                      >
                        <span className="text-slate-400 font-mono">
                          {p.publicPort ? (
                            <>
                              Host <span className="text-cyan-300 font-bold">:{p.publicPort}</span>
                            </>
                          ) : (
                            'Private container port'
                          )}
                        </span>
                        <span className="text-slate-300 font-mono">
                          → {p.privatePort}/{p.type}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h4 className="text-slate-300 font-bold mb-2">Network Configuration</h4>
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Assigned Networks:</span>
                    <span className="text-slate-200 font-bold">
                      {container.networks.join(', ') || 'bridge'}
                    </span>
                  </div>
                  {container.ipAddress && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Internal IP:</span>
                      <span className="text-cyan-300">{container.ipAddress}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: CUSTOM OVERRIDES & SETTINGS */}
          {activeTab === 'settings' && (
            <form onSubmit={handleSaveSettings} className="space-y-4 text-xs">
              <p className="text-slate-400">
                Customize how this app appears in the Manifexus hub. Changes are persistently stored in the persistent volume (<code className="text-cyan-300">/data/config.json</code>).
              </p>

              <div>
                <label className="block text-slate-300 font-bold mb-1">Friendly Display Name</label>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder={container.cleanName}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-bold mb-1">Custom Category / Group</label>
                  <select
                    value={customGroup}
                    onChange={(e) => setCustomGroup(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                  >
                    <option value="">-- No Category --</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 font-bold mb-1">Primary Launch Port</label>
                  <input
                    type="number"
                    value={customPort}
                    onChange={(e) => setCustomPort(e.target.value)}
                    placeholder="e.g. 8080"
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-300 font-bold mb-1">Custom Launch URL (Overrides Host:Port)</label>
                <input
                  type="text"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="https://plex.myhomelab.net"
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-bold mb-1">Custom Icon URL</label>
                <input
                  type="text"
                  value={customIcon}
                  onChange={(e) => setCustomIcon(e.target.value)}
                  placeholder="https://cdn.jsdelivr.net/... or custom image URL"
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-bold mb-1">Maintenance Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Deployment notes, credentials reference, or backup reminders..."
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-4 py-2 rounded-xl bg-cyan-500 text-slate-950 font-bold font-mono flex items-center gap-2 hover:bg-cyan-400 transition-colors shadow-[0_0_15px_rgba(6,182,212,0.3)] disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  <span>{isSaving ? 'Saving...' : 'Save Configuration'}</span>
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-slate-800 bg-slate-950/80 text-xs text-slate-500">
          <div>
            Created: {new Date(container.created * 1000).toLocaleString()}
          </div>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
