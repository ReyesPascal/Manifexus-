import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  CloudDownload,
  FolderOpen,
  ArrowRight,
  Copy,
  Check,
  AlertTriangle,
  Play,
  Terminal,
  Database,
  Layers,
  CheckCircle2,
  Zap,
  Globe,
  GitBranch,
  ShieldCheck,
  RefreshCw,
  FolderPlus,
  Server,
  Code2,
} from 'lucide-react';
import { DeepContainerMetadata, AutomationPrivileges, RemoteComposeMetadata, RemappedPort } from '../types';
import { ExecutionPipelineConsole } from './ExecutionPipelineConsole';

interface ComposeInstallModalProps {
  isOpen: boolean;
  onClose: () => void;
  containers: DeepContainerMetadata[];
  privileges?: AutomationPrivileges | null;
  onInstallSuccess?: () => void;
}

export const ComposeInstallModal: React.FC<ComposeInstallModalProps> = ({
  isOpen,
  onClose,
  containers,
  privileges,
  onInstallSuccess,
}) => {
  // Wizard steps: 1 = Remote URL & Inspect, 2 = Target Routing, 3 = Port Collision & Review
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);

  // Step 1: Remote URL & metadata
  const [remoteUrl, setRemoteUrl] = useState<string>('https://github.com/ReyesPascal/Manifexus-');
  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [remoteMetadata, setRemoteMetadata] = useState<RemoteComposeMetadata | null>(null);
  const [showRawYaml, setShowRawYaml] = useState(false);

  // Step 2: Target Routing
  const [installMode, setInstallMode] = useState<'existing-stack' | 'new-stack'>('new-stack');
  const [targetStackName, setTargetStackName] = useState<string>('remote-app');
  const [targetDirectory, setTargetDirectory] = useState<string>('/home/ryan/remote-app');
  const [defaultHome, setDefaultHome] = useState<string>('/home/ryan');

  // Step 3: AST Port Collision Resolution & Final YAML
  const [isResolvingPorts, setIsResolvingPorts] = useState(false);
  const [resolvedYaml, setResolvedYaml] = useState<string>('');
  const [remappedPorts, setRemappedPorts] = useState<RemappedPort[]>([]);
  const [hasCollisions, setHasCollisions] = useState(false);
  const [copiedYaml, setCopiedYaml] = useState(false);

  // Step 4 / Execution Pipeline Console State
  const [isPipelineOpen, setIsPipelineOpen] = useState(false);
  const [activeInstallId, setActiveInstallId] = useState<string>('');

  // Extract existing stacks from containers
  const existingStacks = useMemo(() => {
    const map = new Map<string, { name: string; workingDir: string; containerCount: number }>();
    for (const c of containers) {
      const proj = c.compose?.project;
      const dir = c.compose?.workingDir;
      if (proj && dir && !proj.toLowerCase().includes('manifexus')) {
        const existing = map.get(proj);
        if (existing) {
          existing.containerCount++;
        } else {
          map.set(proj, { name: proj, workingDir: dir, containerCount: 1 });
        }
      }
    }
    return Array.from(map.values());
  }, [containers]);

  // Fetch host environment (default home dir) on open
  useEffect(() => {
    if (!isOpen) return;

    fetch('/api/compose/host-environment')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.defaultHomeDir) {
          setDefaultHome(data.defaultHomeDir);
          if (installMode === 'new-stack') {
            setTargetDirectory(`${data.defaultHomeDir}/${targetStackName}`);
          }
        }
      })
      .catch(() => {
        // fallback
      });
  }, [isOpen]);

  // Sync target directory when stack name changes in new-stack mode
  const handleStackNameChange = (name: string) => {
    const clean = name.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    setTargetStackName(clean);
    if (installMode === 'new-stack') {
      setTargetDirectory(`${defaultHome}/${clean}`);
    }
  };

  // Handle Fetch Remote Compose
  const handleFetchRemote = async (urlToFetch?: string) => {
    const targetUrl = urlToFetch || remoteUrl;
    if (!targetUrl.trim()) {
      setFetchError('Please provide a valid remote GitHub or Docker Compose URL.');
      return;
    }

    setIsFetching(true);
    setFetchError(null);
    setRemoteMetadata(null);

    try {
      const res = await fetch('/api/compose/fetch-remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl.trim() }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to fetch remote compose configuration');
      }

      setRemoteMetadata(data);
      // Auto-set default stack name based on repo or first service
      if (data.repoName) {
        handleStackNameChange(data.repoName);
      } else if (data.serviceNames && data.serviceNames[0]) {
        handleStackNameChange(data.serviceNames[0]);
      }
    } catch (err) {
      setFetchError((err as Error).message);
    } finally {
      setIsFetching(false);
    }
  };

  // Run AST Port Collision Engine before entering Step 3
  const handleProceedToReview = async () => {
    if (!remoteMetadata?.rawYaml) return;

    setIsResolvingPorts(true);
    try {
      const res = await fetch('/api/compose/resolve-ports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: remoteMetadata.rawYaml }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Port collision engine analysis failed');
      }

      setResolvedYaml(data.resolvedYaml);
      setRemappedPorts(data.remappedPorts || []);
      setHasCollisions(Boolean(data.hasCollisions));
      setCurrentStep(3);
    } catch (err) {
      setFetchError((err as Error).message);
    } finally {
      setIsResolvingPorts(false);
    }
  };

  // Trigger Live Execution Pipeline
  const handleStartDeployment = () => {
    const installId = `install_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
    setActiveInstallId(installId);
    setIsPipelineOpen(true);
  };

  const handleCopyYaml = () => {
    navigator.clipboard.writeText(resolvedYaml || remoteMetadata?.rawYaml || '');
    setCopiedYaml(true);
    setTimeout(() => setCopiedYaml(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
        <div className="max-w-5xl w-full bg-[#0d1117] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden font-sans max-h-[92vh] flex flex-col">
          {/* Header */}
          <div className="px-6 py-4 border-b border-slate-800/80 bg-slate-900/60 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-cyan-950/80 border border-cyan-500/40 text-cyan-400 shadow-[0_0_15px_rgba(6,182,212,0.2)]">
                <CloudDownload className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-white tracking-wide">
                    Remote Compose Installation Studio
                  </h2>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-cyan-950/80 text-cyan-300 border border-cyan-500/40">
                    CI/CD AUTO-DEPLOY
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  Deploy remote Docker Compose files with zero-touch port collision resolution & elevated host execution.
                </p>
              </div>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/80 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Stepper Bar */}
          <div className="px-6 py-3 bg-slate-950 border-b border-slate-800/80 flex items-center justify-between">
            <div className="flex items-center gap-2 sm:gap-4 text-xs font-mono">
              <button
                onClick={() => setCurrentStep(1)}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all ${
                  currentStep === 1
                    ? 'bg-cyan-950/80 border border-cyan-500/40 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <span className="w-4 h-4 rounded-full bg-cyan-500/20 text-cyan-300 flex items-center justify-center text-[10px] font-bold">
                  1
                </span>
                <span>Source & Fetch</span>
              </button>

              <div className="h-px w-6 bg-slate-800 hidden sm:block" />

              <button
                disabled={!remoteMetadata}
                onClick={() => setCurrentStep(2)}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all ${
                  currentStep === 2
                    ? 'bg-cyan-950/80 border border-cyan-500/40 text-cyan-300'
                    : remoteMetadata
                    ? 'text-slate-400 hover:text-slate-200'
                    : 'text-slate-600 cursor-not-allowed'
                }`}
              >
                <span className="w-4 h-4 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center text-[10px] font-bold">
                  2
                </span>
                <span>Target & Routing</span>
              </button>

              <div className="h-px w-6 bg-slate-800 hidden sm:block" />

              <button
                disabled={!remoteMetadata}
                onClick={handleProceedToReview}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all ${
                  currentStep === 3
                    ? 'bg-cyan-950/80 border border-cyan-500/40 text-cyan-300'
                    : remoteMetadata
                    ? 'text-slate-400 hover:text-slate-200'
                    : 'text-slate-600 cursor-not-allowed'
                }`}
              >
                <span className="w-4 h-4 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center text-[10px] font-bold">
                  3
                </span>
                <span>Port De-Confliction & Review</span>
              </button>
            </div>

            {/* Privilege status indicator */}
            <div className="hidden md:flex items-center gap-1.5 text-xs font-mono">
              <Zap className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-slate-400">Execution:</span>
              <span className="text-emerald-400 font-bold">Root Socket / Non-Blocking</span>
            </div>
          </div>

          {/* Modal Body */}
          <div className="p-6 overflow-y-auto flex-1 space-y-6">
            {/* ========================================================================= */}
            {/* STEP 1: Remote URL Input & Inspection */}
            {/* ========================================================================= */}
            {currentStep === 1 && (
              <div className="space-y-6">
                <div>
                  <label className="block text-xs font-mono text-slate-300 uppercase tracking-wider mb-2">
                    Remote Docker Compose or GitHub Repository URL
                  </label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                      <input
                        type="text"
                        value={remoteUrl}
                        onChange={(e) => setRemoteUrl(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleFetchRemote()}
                        placeholder="e.g. https://github.com/ReyesPascal/Manifexus- or raw docker-compose.yml link"
                        className="w-full pl-9 pr-3 py-2.5 text-xs rounded-xl bg-slate-900 border border-slate-700 text-slate-200 placeholder-slate-500 font-mono focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all"
                      />
                    </div>
                    <button
                      onClick={() => handleFetchRemote()}
                      disabled={isFetching}
                      className="px-5 py-2.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-mono text-xs font-semibold flex items-center gap-2 transition-colors disabled:opacity-50 shadow-[0_0_15px_rgba(6,182,212,0.3)]"
                    >
                      {isFetching ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          <span>Fetching...</span>
                        </>
                      ) : (
                        <>
                          <CloudDownload className="w-4 h-4" />
                          <span>Fetch & Inspect</span>
                        </>
                      )}
                    </button>
                  </div>

                  {/* Preset Quick Links */}
                  <div className="flex flex-wrap items-center gap-2 mt-3 text-xs font-mono">
                    <span className="text-slate-500 text-[11px]">Quick presets:</span>
                    <button
                      onClick={() => {
                        setRemoteUrl('https://github.com/ReyesPascal/Manifexus-');
                        handleFetchRemote('https://github.com/ReyesPascal/Manifexus-');
                      }}
                      className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-cyan-400 hover:border-cyan-500/40 transition-colors"
                    >
                      ReyesPascal/Manifexus-
                    </button>
                    <button
                      onClick={() => {
                        setRemoteUrl('https://raw.githubusercontent.com/louislam/uptime-kuma/1/docker-compose.yml');
                        handleFetchRemote('https://raw.githubusercontent.com/louislam/uptime-kuma/1/docker-compose.yml');
                      }}
                      className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
                    >
                      Uptime Kuma
                    </button>
                    <button
                      onClick={() => {
                        setRemoteUrl('https://raw.githubusercontent.com/portainer/portainer-compose/master/docker-compose.yml');
                        handleFetchRemote('https://raw.githubusercontent.com/portainer/portainer-compose/master/docker-compose.yml');
                      }}
                      className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
                    >
                      Portainer CE
                    </button>
                  </div>
                </div>

                {/* Error Banner */}
                {fetchError && (
                  <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-500/40 text-xs text-rose-300 flex items-start gap-3 font-mono">
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold">Fetch Failed: </span>
                      {fetchError}
                    </div>
                  </div>
                )}

                {/* Inspection Result Preview */}
                {remoteMetadata && (
                  <div className="space-y-4 rounded-xl bg-slate-900/60 border border-slate-800 p-5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span className="text-xs font-mono font-bold text-white">
                          Verified Compose Configuration
                        </span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-950 text-emerald-300 border border-emerald-500/30">
                          {remoteMetadata.serviceNames.length} Service(s) Detected
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-slate-500 truncate max-w-md" title={remoteMetadata.resolvedSourceUrl}>
                        Source: {remoteMetadata.resolvedSourceUrl}
                      </span>
                    </div>

                    {/* Service Cards */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {remoteMetadata.serviceDetails.map((s) => (
                        <div
                          key={s.name}
                          className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 transition-colors"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-mono font-bold text-cyan-300 flex items-center gap-1.5">
                              <Server className="w-3.5 h-3.5 text-cyan-400" />
                              {s.name}
                            </span>
                            {s.ports.length > 0 && (
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                                {s.ports.length} Port{s.ports.length > 1 ? 's' : ''}
                              </span>
                            )}
                          </div>

                          <p className="text-[11px] font-mono text-slate-400 truncate mb-2" title={s.image || 'build'}>
                            Image: <span className="text-slate-200">{s.image || '(local build)'}</span>
                          </p>

                          <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono text-slate-500">
                            {s.ports.map((p, idx) => (
                              <span
                                key={idx}
                                className="px-1.5 py-0.5 rounded bg-cyan-950/40 text-cyan-400 border border-cyan-500/20"
                              >
                                {p.hostPort ? `${p.hostPort}:${p.containerPort}` : p.containerPort}/{p.protocol}
                              </span>
                            ))}
                            {s.volumeCount > 0 && (
                              <span className="px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-800">
                                {s.volumeCount} Volume(s)
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Raw YAML Inspector Toggle */}
                    <div className="pt-2 border-t border-slate-800">
                      <button
                        onClick={() => setShowRawYaml(!showRawYaml)}
                        className="text-xs font-mono text-cyan-400 hover:underline flex items-center gap-1"
                      >
                        <Code2 className="w-3.5 h-3.5" />
                        <span>{showRawYaml ? 'Hide Raw YAML Specification' : 'Inspect Raw YAML Specification'}</span>
                      </button>

                      {showRawYaml && (
                        <div className="mt-3 relative">
                          <pre className="p-4 rounded-xl bg-black border border-slate-800 text-[11px] font-mono text-slate-300 max-h-60 overflow-y-auto leading-relaxed">
                            {remoteMetadata.rawYaml}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ========================================================================= */}
            {/* STEP 2: Target & Routing Stage */}
            {/* ========================================================================= */}
            {currentStep === 2 && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-xs font-mono uppercase tracking-wider text-slate-300 mb-2">
                    Select Installation Workflow
                  </h3>
                  <p className="text-xs text-slate-400 mb-4">
                    Choose whether to inject the remote services into an existing running stack or provision a new isolated stack directory.
                  </p>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Workflow A: Install to Existing Stack */}
                    <div
                      onClick={() => setInstallMode('existing-stack')}
                      className={`p-4 rounded-xl border cursor-pointer transition-all ${
                        installMode === 'existing-stack'
                          ? 'bg-cyan-950/40 border-cyan-500/60 shadow-[0_0_15px_rgba(6,182,212,0.15)]'
                          : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Layers className="w-4 h-4 text-cyan-400" />
                          <span className="text-xs font-mono font-bold text-white">
                            Install to Existing Stack
                          </span>
                        </div>
                        <input
                          type="radio"
                          name="install_mode"
                          checked={installMode === 'existing-stack'}
                          onChange={() => setInstallMode('existing-stack')}
                          className="accent-cyan-400"
                        />
                      </div>
                      <p className="text-xs text-slate-400 leading-relaxed">
                        Merges services into an existing stack's <code className="text-cyan-300">docker-compose.yml</code> via AST synthesis without overwriting existing services.
                      </p>
                    </div>

                    {/* Workflow B: Create New Stack */}
                    <div
                      onClick={() => setInstallMode('new-stack')}
                      className={`p-4 rounded-xl border cursor-pointer transition-all ${
                        installMode === 'new-stack'
                          ? 'bg-cyan-950/40 border-cyan-500/60 shadow-[0_0_15px_rgba(6,182,212,0.15)]'
                          : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <FolderPlus className="w-4 h-4 text-cyan-400" />
                          <span className="text-xs font-mono font-bold text-white">
                            Create New Stack Directory
                          </span>
                        </div>
                        <input
                          type="radio"
                          name="install_mode"
                          checked={installMode === 'new-stack'}
                          onChange={() => setInstallMode('new-stack')}
                          className="accent-cyan-400"
                        />
                      </div>
                      <p className="text-xs text-slate-400 leading-relaxed">
                        Provisions a dedicated host directory (e.g. <code className="text-cyan-300">~/app-name</code>) with full permissions and deploys an isolated compose stack.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Workflow A Configuration */}
                {installMode === 'existing-stack' && (
                  <div className="p-5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-4">
                    <h4 className="text-xs font-mono font-bold text-slate-200 flex items-center gap-2">
                      <Layers className="w-4 h-4 text-cyan-400" />
                      <span>Select Target Existing Stack</span>
                    </h4>

                    {existingStacks.length === 0 ? (
                      <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-500/30 text-xs text-amber-300 font-mono">
                        No existing Docker Compose stacks detected. Please select "Create New Stack".
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {existingStacks.map((st) => (
                          <div
                            key={st.name}
                            onClick={() => {
                              setTargetStackName(st.name);
                              setTargetDirectory(st.workingDir);
                            }}
                            className={`p-3 rounded-xl border cursor-pointer flex items-center justify-between transition-all ${
                              targetStackName === st.name
                                ? 'bg-cyan-950/60 border-cyan-500 text-white'
                                : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                            }`}
                          >
                            <div>
                              <div className="font-mono text-xs font-bold text-cyan-300">{st.name}</div>
                              <div className="font-mono text-[11px] text-slate-500">{st.workingDir}</div>
                            </div>
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-800">
                              {st.containerCount} service(s) running
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Workflow B Configuration */}
                {installMode === 'new-stack' && (
                  <div className="p-5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-4">
                    <h4 className="text-xs font-mono font-bold text-slate-200 flex items-center gap-2">
                      <FolderOpen className="w-4 h-4 text-cyan-400" />
                      <span>Configure New Stack Directory</span>
                    </h4>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-mono text-slate-400 mb-1">
                          Stack Name (Docker Compose Project)
                        </label>
                        <input
                          type="text"
                          value={targetStackName}
                          onChange={(e) => handleStackNameChange(e.target.value)}
                          placeholder="e.g. kavita-stack"
                          className="w-full px-3 py-2 text-xs rounded-xl bg-slate-950 border border-slate-700 text-white font-mono focus:border-cyan-500 focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-mono text-slate-400 mb-1">
                          Resolved Host Filesystem Path
                        </label>
                        <div className="relative">
                          <input
                            type="text"
                            value={targetDirectory}
                            onChange={(e) => setTargetDirectory(e.target.value)}
                            placeholder="/home/ryan/kavita-stack"
                            className="w-full px-3 py-2 text-xs rounded-xl bg-slate-950 border border-slate-700 text-cyan-300 font-mono focus:border-cyan-500 focus:outline-none"
                          />
                        </div>
                      </div>
                    </div>

                    <p className="text-[11px] font-mono text-slate-500">
                      Standard home directory execution context: Manifexus will provision <code className="text-slate-300">{targetDirectory}</code> with elevated root permissions.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ========================================================================= */}
            {/* STEP 3: Port Collision & Synthesized YAML Review */}
            {/* ========================================================================= */}
            {currentStep === 3 && (
              <div className="space-y-6">
                {/* Collision Analysis Banner */}
                {hasCollisions ? (
                  <div className="p-4 rounded-xl bg-amber-950/40 border border-amber-500/40 space-y-3">
                    <div className="flex items-center gap-2 text-amber-300 text-xs font-mono font-bold">
                      <AlertTriangle className="w-4 h-4 text-amber-400" />
                      <span>Intelligent Port Collision Engine: Re-mapping Detected Collisions</span>
                    </div>
                    <p className="text-xs text-slate-300 font-mono">
                      One or more requested host ports are currently occupied on your system. To prevent deployment failure, Manifexus programmatically mutated the AST to allocate the next free host ports:
                    </p>

                    <div className="space-y-2">
                      {remappedPorts.map((r, idx) => (
                        <div
                          key={idx}
                          className="px-3 py-2 rounded-lg bg-slate-950 border border-amber-500/30 flex items-center justify-between text-xs font-mono"
                        >
                          <span className="text-white font-bold">{r.service}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-rose-400 line-through">Port {r.originalHostPort} (Occupied)</span>
                            <ArrowRight className="w-3.5 h-3.5 text-amber-400" />
                            <span className="text-emerald-400 font-bold bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-500/40">
                              Port {r.allocatedHostPort} (Allocated)
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="p-4 rounded-xl bg-emerald-950/40 border border-emerald-500/30 flex items-center gap-3">
                    <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                    <div>
                      <div className="text-xs font-mono font-bold text-emerald-300">
                        Zero Port Collisions Detected
                      </div>
                      <p className="text-xs text-slate-400 font-mono">
                        All requested ports in the remote Compose file are available on the host.
                      </p>
                    </div>
                  </div>
                )}

                {/* Synthesized YAML Output */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-slate-300 uppercase tracking-wider flex items-center gap-2">
                      <Code2 className="w-4 h-4 text-cyan-400" />
                      <span>Final Synthesized Compose YAML</span>
                    </span>
                    <button
                      onClick={handleCopyYaml}
                      className="px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300 hover:text-white flex items-center gap-1.5 transition-colors"
                    >
                      {copiedYaml ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Copied!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy YAML</span>
                        </>
                      )}
                    </button>
                  </div>

                  <pre className="p-4 rounded-xl bg-black border border-slate-800 text-xs font-mono text-slate-200 max-h-72 overflow-y-auto leading-relaxed">
                    {resolvedYaml || remoteMetadata?.rawYaml}
                  </pre>
                </div>

                {/* Deployment Parameters Summary */}
                <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-wrap items-center justify-between gap-4 text-xs font-mono">
                  <div>
                    <span className="text-slate-500">Destination Directory: </span>
                    <span className="text-cyan-300 font-bold">{targetDirectory}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Target Stack: </span>
                    <span className="text-white font-bold">{targetStackName}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Execution Mode: </span>
                    <span className="text-emerald-400 font-bold">Privileged Non-Blocking</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Modal Footer Controls */}
          <div className="px-6 py-4 border-t border-slate-800 bg-slate-900/60 flex items-center justify-between">
            <div>
              {currentStep > 1 && (
                <button
                  onClick={() => setCurrentStep((prev) => (prev > 1 ? ((prev - 1) as any) : prev))}
                  className="px-4 py-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:text-white text-xs font-mono transition-colors"
                >
                  Back
                </button>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-slate-400 hover:text-white text-xs font-mono transition-colors"
              >
                Cancel
              </button>

              {currentStep === 1 && (
                <button
                  onClick={() => setCurrentStep(2)}
                  disabled={!remoteMetadata}
                  className="px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-mono font-semibold flex items-center gap-2 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_0_15px_rgba(6,182,212,0.2)]"
                >
                  <span>Continue to Target Routing</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}

              {currentStep === 2 && (
                <button
                  onClick={handleProceedToReview}
                  disabled={isResolvingPorts}
                  className="px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-mono font-semibold flex items-center gap-2 transition-all disabled:opacity-40 shadow-[0_0_15px_rgba(6,182,212,0.2)]"
                >
                  {isResolvingPorts ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Resolving Ports...</span>
                    </>
                  ) : (
                    <>
                      <span>Analyze Ports & Review</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              )}

              {currentStep === 3 && (
                <button
                  onClick={handleStartDeployment}
                  className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-mono font-bold flex items-center gap-2 transition-all shadow-[0_0_20px_rgba(16,185,129,0.3)]"
                >
                  <Play className="w-4 h-4 fill-white" />
                  <span>Execute Live Pipeline</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* GitHub Actions-Style Live Streaming Pipeline Console */}
      {isPipelineOpen && (
        <ExecutionPipelineConsole
          isOpen={isPipelineOpen}
          onClose={() => {
            setIsPipelineOpen(false);
            onClose();
            if (onInstallSuccess) onInstallSuccess();
          }}
          title={`Deploying ${targetStackName} from Remote Compose`}
          mode="install"
          mergeId={activeInstallId}
          streamUrl="/api/compose/install-stream"
          streamPayload={{
            installId: activeInstallId,
            sourceUrl: remoteUrl,
            targetStackName,
            targetDirectory,
            installMode,
            composeYaml: resolvedYaml || remoteMetadata?.rawYaml,
          }}
          onKeepChanges={() => {
            fetch(`/api/history/${activeInstallId}/keep`, { method: 'POST' }).catch(() => {});
            setIsPipelineOpen(false);
            onClose();
            if (onInstallSuccess) onInstallSuccess();
          }}
          onTriggerRevert={(id) => {
            // Revert pipeline will trigger if needed
            if (onInstallSuccess) onInstallSuccess();
          }}
          onSuccessDone={() => {
            if (onInstallSuccess) onInstallSuccess();
          }}
        />
      )}
    </>
  );
};
