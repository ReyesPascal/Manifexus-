import React, { useState } from 'react';
import {
  X,
  BookOpen,
  Terminal,
  FolderKanban,
  Layers,
  Copy,
  Check,
  ShieldCheck,
  Database,
  GitBranch,
} from 'lucide-react';

interface HelpDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HelpDrawer: React.FC<HelpDrawerProps> = ({ isOpen, onClose }) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const composeSnippet = `services:
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
    volumes:
      # Read-only Docker socket for auto-discovery
      - /var/run/docker.sock:/var/run/docker.sock:ro
      # Persistent storage for custom groups & overrides
      - ./data:/data
`;

  const dockerRunSnippet = `docker run -d \\
  --name manifexus \\
  --restart unless-stopped \\
  -p 3334:3334 \\
  -e PORT=3334 \\
  -v /var/run/docker.sock:/var/run/docker.sock:ro \\
  -v $(pwd)/data:/data \\
  ghcr.io/reyespascal/manifexus:latest`;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="w-full max-w-xl h-full bg-[#080c14] border-l border-slate-800 shadow-2xl flex flex-col font-mono text-slate-300 overflow-hidden animate-in slide-in-from-right duration-300"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drawer Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-[#0c101a]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-cyan-950/60 border border-cyan-500/30 text-cyan-400">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white tracking-tight">
                Quick Start & Architecture Manual
              </h2>
              <p className="text-xs text-slate-400">
                Deployment, Auto-Discovery & Custom Groups Guide
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

        {/* Drawer Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs leading-relaxed">
          {/* 1. One-Line Compose Installation */}
          <section className="space-y-2">
            <h3 className="text-sm font-bold text-cyan-400 flex items-center gap-2">
              <Terminal className="w-4 h-4" />
              1. One-Line Deployment on Ubuntu
            </h3>
            <p className="text-slate-400">
              Save this <code className="text-slate-200">docker-compose.yml</code> file on your Ubuntu host and start the fleet command nexus:
            </p>

            <div className="relative rounded-xl bg-slate-950 border border-slate-800 p-3">
              <div className="flex items-center justify-between text-[11px] text-slate-500 mb-2 border-b border-slate-800 pb-1">
                <span>docker-compose.yml</span>
                <button
                  onClick={() => handleCopy(composeSnippet, 'compose')}
                  className="hover:text-cyan-300 flex items-center gap-1 text-slate-400"
                >
                  {copiedKey === 'compose' ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>{copiedKey === 'compose' ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <pre className="text-cyan-300 text-[11px] overflow-x-auto">
                {composeSnippet}
              </pre>
            </div>

            <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between">
              <span className="text-slate-200 font-bold">docker compose up -d</span>
              <button
                onClick={() => handleCopy('docker compose up -d', 'cmd')}
                className="hover:text-cyan-300 text-slate-400 flex items-center gap-1"
              >
                {copiedKey === 'cmd' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>Copy</span>
              </button>
            </div>
          </section>

          {/* 2. Automatic Discovery Logic */}
          <section className="space-y-2">
            <h3 className="text-sm font-bold text-cyan-400 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" />
              2. How Automatic Discovery Works
            </h3>
            <p className="text-slate-400">
              Manifexus connects directly to the local Docker daemon using the mounted Unix domain socket (<code className="text-cyan-300">/var/run/docker.sock:ro</code>).
            </p>
            <ul className="list-disc pl-5 space-y-1 text-slate-400">
              <li>
                <strong className="text-slate-200">Zero Configuration:</strong> When a new container is launched or stopped, Manifexus queries the Docker Engine API directly.
              </li>
              <li>
                <strong className="text-slate-200">Read-Only Safety:</strong> Mounting with <code className="text-slate-200">:ro</code> ensures the container cannot tamper with your host socket.
              </li>
              <li>
                <strong className="text-slate-200">Icon Matching:</strong> Resolves icons automatically from official self-hosted catalogs and CDNs.
              </li>
            </ul>
          </section>

          {/* 3. Deep Metadata Extraction */}
          <section className="space-y-2">
            <h3 className="text-sm font-bold text-purple-400 flex items-center gap-2">
              <Layers className="w-4 h-4" />
              3. Deep Metadata & Compose Stacks
            </h3>
            <p className="text-slate-400">
              For containers deployed with Docker Compose, Manifexus extracts:
            </p>
            <div className="p-3 rounded-xl bg-purple-950/20 border border-purple-500/20 space-y-1.5 text-[11px]">
              <div>
                <span className="text-purple-300 font-bold">com.docker.compose.project:</span> identifies the stack.
              </div>
              <div>
                <span className="text-purple-300 font-bold">com.docker.compose.project.working_dir:</span> exact host directory where the compose file resides.
              </div>
              <div>
                <span className="text-purple-300 font-bold">com.docker.compose.project.config_files:</span> exact compose file path.
              </div>
            </div>
            <p className="text-slate-400">
              Toggle between <strong className="text-slate-200">Custom User Groups</strong> and <strong className="text-slate-200">Compose Stacks</strong> anytime using the switch in the top navigation bar.
            </p>
          </section>

          {/* 4. Data Persistence */}
          <section className="space-y-2">
            <h3 className="text-sm font-bold text-emerald-400 flex items-center gap-2">
              <Database className="w-4 h-4" />
              4. Data Persistence Architecture
            </h3>
            <p className="text-slate-400">
              All custom categories, display names, custom URLs, and app-to-group assignments are saved to:
            </p>
            <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 text-emerald-300 text-[11px]">
              /data/config.json (mapped to ./data on your host)
            </div>
            <p className="text-slate-400">
              This guarantees that container updates, image pulls, or host restarts will never erase your configurations.
            </p>
          </section>

          {/* 5. GitHub & GHCR Pipeline */}
          <section className="space-y-2">
            <h3 className="text-sm font-bold text-cyan-400 flex items-center gap-2">
              <GitBranch className="w-4 h-4" />
              5. Automated CI/CD with GHCR
            </h3>
            <p className="text-slate-400">
              The included <code className="text-slate-200">.github/workflows/docker-publish.yml</code> automatically builds multi-arch (<code className="text-slate-300">amd64</code> and <code className="text-slate-300">arm64</code>) Docker images on every push to your repository and releases them to GitHub Container Registry.
            </p>
          </section>
        </div>

        {/* Drawer Footer */}
        <div className="p-4 border-t border-slate-800 bg-[#0c101a] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold transition-colors"
          >
            Got it, return to Dashboard
          </button>
        </div>
      </div>
    </div>
  );
};
