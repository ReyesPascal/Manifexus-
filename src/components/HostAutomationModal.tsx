import React, { useState } from 'react';
import {
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Copy,
  Check,
  RefreshCw,
  AlertTriangle,
  X,
  Zap,
  CheckCircle2,
  FolderLock,
  Cpu,
} from 'lucide-react';
import { AutomationPrivileges } from '../types';

interface HostAutomationModalProps {
  isOpen: boolean;
  onClose: () => void;
  privileges: AutomationPrivileges | null;
  onRefreshPrivileges: () => Promise<void>;
}

export const HostAutomationModal: React.FC<HostAutomationModalProps> = ({
  isOpen,
  onClose,
  privileges,
  onRefreshPrivileges,
}) => {
  const [copied, setCopied] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [showManualCompose, setShowManualCompose] = useState(false);

  if (!isOpen) return null;

  const isElevated = privileges?.mode === 'elevated';
  const elevateCmd = `curl -fsSL http://localhost:3334/api/system/elevate.sh | bash`;

  const manualComposeYaml = `services:
  manifexus:
    image: ghcr.io/reyespascal/manifexus:latest
    container_name: manifexus
    restart: unless-stopped
    ports:
      - "3334:3334"
    environment:
      - NODE_ENV=production
      - PORT=3334
      - DOCKER_SOCKET_PATH=/var/run/docker.sock
      - HOST_ROOT=/host
    volumes:
      # Read-write Docker socket for automated container start/stop/restart
      - /var/run/docker.sock:/var/run/docker.sock
      # Host home mount: enables direct, automated docker-compose.yml editing & backups
      - /home:/host/home
      # Persistent host directory for custom groups and app overrides
      - ./data:/data`;

  const copyToClipboard = (text: string, type: string) => {
    navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2500);
  };

  const handleVerify = async () => {
    setIsVerifying(true);
    try {
      await onRefreshPrivileges();
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div
        className="w-full max-w-3xl max-h-[92vh] flex flex-col bg-[#0b0f19] border border-cyan-500/30 rounded-2xl shadow-2xl overflow-hidden font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-slate-900 via-slate-900/90 to-purple-950/40 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`p-2.5 rounded-xl border ${
                isElevated
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
                  : 'bg-amber-500/10 border-amber-500/40 text-amber-400'
              }`}
            >
              {isElevated ? <Zap className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white tracking-tight">
                  Host Automation & Elevation Manager
                </h2>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                    isElevated
                      ? 'bg-emerald-950 border-emerald-500/40 text-emerald-300'
                      : 'bg-amber-950 border-amber-500/40 text-amber-300'
                  }`}
                >
                  {isElevated ? '⚡ Elevated (Full Automation)' : '🛡️ Sandboxed (Read-Only)'}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Grant Manifexus permission to write compose files and orchestrate stacks on your Ubuntu host.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/80 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Content */}
        <div className="p-6 overflow-y-auto space-y-6 text-xs text-slate-300">
          {/* Status Overview Card */}
          <div
            className={`p-4 rounded-xl border ${
              isElevated
                ? 'bg-emerald-950/30 border-emerald-500/40'
                : 'bg-slate-900/80 border-slate-800'
            } space-y-3`}
          >
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm text-white flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-400" />
                <span>Current Privilege Status</span>
              </span>
              <button
                onClick={handleVerify}
                disabled={isVerifying}
                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs flex items-center gap-1.5 transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isVerifying ? 'animate-spin' : ''}`} />
                <span>{isVerifying ? 'Verifying...' : 'Re-check Privileges'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[11px]">
              <div className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800/80 flex items-center justify-between">
                <span className="text-slate-400">Docker Daemon Socket:</span>
                <span
                  className={`font-bold ${
                    privileges?.isSocketWritable ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  {privileges?.isSocketWritable ? 'Read-Write (rw)' : 'Read-Only (:ro)'}
                </span>
              </div>

              <div className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800/80 flex items-center justify-between">
                <span className="text-slate-400">Host Filesystem Mount:</span>
                <span
                  className={`font-bold ${
                    privileges?.isHostFsMounted ? 'text-emerald-400' : 'text-slate-400'
                  }`}
                >
                  {privileges?.isHostFsMounted ? 'Mounted (/host/home)' : 'Isolated (No /host)'}
                </span>
              </div>
            </div>

            <p className="text-[11px] text-slate-400 leading-relaxed">
              {privileges?.statusMessage}
            </p>
          </div>

          {/* WARNING POPUP: What will this do? */}
          <div className="p-4 rounded-xl bg-purple-950/20 border border-purple-500/40 space-y-3">
            <div className="flex items-center gap-2 text-sm font-bold text-purple-300">
              <AlertTriangle className="w-4 h-4 text-purple-400" />
              <span>Permission Notice & Security Review</span>
            </div>

            <div className="space-y-2 text-[11px] text-slate-300 leading-relaxed">
              <p>
                By default, Manifexus runs in <strong>Sandboxed Mode</strong> with a read-only Docker socket (<code className="text-purple-300">/var/run/docker.sock:ro</code>). In this mode, Manifexus can discover your containers but <strong>cannot write files</strong> to your host or execute <code className="text-purple-300">docker compose</code> commands on your host system.
              </p>
              <p className="font-semibold text-white">
                When you elevate to Full Automation Mode, here is exactly what is granted:
              </p>
              <ul className="list-disc list-inside space-y-1.5 text-slate-400 pl-1">
                <li>
                  <strong className="text-cyan-300">Read-Write Docker Socket:</strong> Allows Manifexus to stop individual containers and launch merged stacks automatically.
                </li>
                <li>
                  <strong className="text-cyan-300">Host /home Mount:</strong> Allows Manifexus to directly write <code className="text-purple-300">docker-compose.yml</code> files in your user directory without manual copy-pasting.
                </li>
                <li>
                  <strong className="text-emerald-400">Safety Guarantee:</strong> Before any compose file is modified, Manifexus creates a timestamped backup (<code className="text-cyan-300">docker-compose.backup.yml</code>) on your host disk. All named volumes and bind mounts are retained with zero data loss.
                </li>
              </ul>
            </div>
          </div>

          {/* Action Step: 1-Line Terminal Command */}
          <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-bold text-white flex items-center gap-2">
                <Terminal className="w-4 h-4 text-cyan-400" />
                <span>Option 1 (Fastest): Run 1-Line Elevation Command on Your Host</span>
              </div>
              <button
                onClick={() => copyToClipboard(elevateCmd, 'cmd')}
                className="px-2.5 py-1 rounded-lg bg-cyan-950 hover:bg-cyan-900 border border-cyan-500/40 text-cyan-300 text-xs font-bold flex items-center gap-1.5 transition-colors"
              >
                {copied === 'cmd' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied === 'cmd' ? 'Copied!' : 'Copy Command'}</span>
              </button>
            </div>

            <div className="p-3 rounded-lg bg-[#07090e] border border-slate-800 font-mono text-cyan-300 text-xs break-all">
              {elevateCmd}
            </div>

            <p className="text-[11px] text-slate-500">
              This automated script detects your Manifexus compose file, updates socket to read-write, mounts <code className="text-slate-400">/home:/host/home</code>, and restarts Manifexus in under 5 seconds.
            </p>
          </div>

          {/* Option 2: Manual docker-compose.yml */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white flex items-center gap-2">
                <FolderLock className="w-4 h-4 text-slate-400" />
                <span>Option 2: Update Your Manifexus docker-compose.yml Manually</span>
              </span>
              <button
                onClick={() => setShowManualCompose(!showManualCompose)}
                className="text-xs text-cyan-400 hover:text-cyan-300 underline"
              >
                {showManualCompose ? 'Hide YAML' : 'Show YAML'}
              </button>
            </div>

            {showManualCompose && (
              <div className="space-y-2">
                <div className="flex justify-end">
                  <button
                    onClick={() => copyToClipboard(manualComposeYaml, 'compose')}
                    className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs flex items-center gap-1.5"
                  >
                    {copied === 'compose' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copied === 'compose' ? 'Copied Compose!' : 'Copy Compose YAML'}</span>
                  </button>
                </div>
                <pre className="p-3 rounded-lg bg-[#07090e] border border-slate-800 text-[11px] text-cyan-300 overflow-x-auto max-h-52">
                  {manualComposeYaml}
                </pre>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-900/80 border-t border-slate-800 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-colors"
          >
            Cancel / Keep Sandboxed
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={handleVerify}
              disabled={isVerifying}
              className="px-4 py-2 rounded-xl bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500/40 text-purple-200 text-xs font-bold transition-all flex items-center gap-2"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isVerifying ? 'animate-spin' : ''}`} />
              <span>Verify Changes</span>
            </button>

            <button
              onClick={() => {
                copyToClipboard(elevateCmd, 'cmd');
                handleVerify();
              }}
              className="px-5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold transition-all flex items-center gap-2 shadow-lg shadow-cyan-500/20"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Copy 1-Line Command & Done</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
