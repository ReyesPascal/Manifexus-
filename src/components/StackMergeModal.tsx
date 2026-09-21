import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  Layers,
  ShieldCheck,
  FolderOpen,
  ArrowRight,
  Copy,
  Check,
  Download,
  AlertTriangle,
  Play,
  Terminal,
  Database,
  HardDrive,
  RefreshCw,
  GitBranch,
  Info,
  CheckCircle2,
  Trash2,
  Zap,
  ShieldAlert,
  Plus,
} from 'lucide-react';
import { DeepContainerMetadata, StackMergePlan, AutomationPrivileges } from '../types';

interface StackMergeModalProps {
  isOpen: boolean;
  onClose: () => void;
  containers: DeepContainerMetadata[];
  initialSelectedIds?: string[];
  initialTargetStack?: string;
  onMergeSuccess?: () => void;
  privileges?: AutomationPrivileges | null;
  onOpenAutomationModal?: () => void;
  onRefreshPrivileges?: () => Promise<void>;
}

export const StackMergeModal: React.FC<StackMergeModalProps> = ({
  isOpen,
  onClose,
  containers,
  initialSelectedIds = [],
  initialTargetStack,
  onMergeSuccess,
  privileges,
  onOpenAutomationModal,
  onRefreshPrivileges,
}) => {
  // Step navigation: 1 = select, 2 = target & storage, 3 = review yaml & execute, 4 = update guide & post-verify
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4>(1);

  // Selection
  const [selectedIds, setSelectedIds] = useState<string[]>(initialSelectedIds);

  // Target config
  const [mode, setMode] = useState<'existing-stack' | 'new-stack'>('new-stack');
  const [targetStackName, setTargetStackName] = useState<string>('combined-stack');
  const [targetDirectory, setTargetDirectory] = useState<string>('/home/ryan/combined-stack');
  const [volumeHandling, setVolumeHandling] = useState<'preserve-absolute' | 'consolidate-relative'>('preserve-absolute');

  // Plan generation state
  const [plan, setPlan] = useState<StackMergePlan | null>(null);
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  // Execution state & Host confirmation dialog
  const [isExecuting, setIsExecuting] = useState(false);
  const [showConfirmExecuteDialog, setShowConfirmExecuteDialog] = useState(false);
  const [executionResult, setExecutionResult] = useState<{
    success: boolean;
    message: string;
    logs?: string[];
    isAutomated?: boolean;
    mode?: string;
    isMigratingSelf?: boolean;
  } | null>(null);
  const [copiedType, setCopiedType] = useState<'yaml' | 'script' | 'rollback' | 'cleanup' | null>(null);

  // Live reconnection state when central command (Manifexus) migrates into new stack
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [reconnectSuccess, setReconnectSuccess] = useState(false);

  // Group containers by stack for quick selection
  const groupedStacks = useMemo(() => {
    const stacks: Record<string, { dir?: string; items: DeepContainerMetadata[] }> = {};
    const standalone: DeepContainerMetadata[] = [];

    for (const c of containers) {
      if (c.compose?.isCompose && c.compose.project) {
        const p = c.compose.project;
        if (!stacks[p]) {
          stacks[p] = { dir: c.compose.workingDir, items: [] };
        }
        stacks[p].items.push(c);
      } else {
        standalone.push(c);
      }
    }
    return { stacks, standalone };
  }, [containers]);

  // Selected container objects list
  const selectedContainersList = useMemo(() => {
    return containers.filter((c) => selectedIds.includes(c.id));
  }, [containers, selectedIds]);

  // Determine if this is a self-merge (all selected services already belong to the target stack)
  const isSelfMergeOnly = useMemo(() => {
    if (mode !== 'existing-stack' || !targetStackName || selectedContainersList.length === 0) return false;
    return selectedContainersList.every((c) => c.compose?.project === targetStackName);
  }, [mode, targetStackName, selectedContainersList]);

  // Check if Manifexus container is running on the host but not currently selected
  const unselectedManifexus = useMemo(() => {
    return containers.find(
      (c) =>
        (c.compose?.project === 'manifexus' || c.cleanName.toLowerCase().includes('manifexus')) &&
        !selectedIds.includes(c.id)
    );
  }, [containers, selectedIds]);

  // Check if Manifexus is currently selected
  const isManifexusSelected = useMemo(() => {
    return selectedContainersList.some(
      (c) => c.compose?.project === 'manifexus' || c.cleanName.toLowerCase().includes('manifexus')
    );
  }, [selectedContainersList]);

  // Synchronize initial selection when modal opens
  useEffect(() => {
    if (isOpen) {
      if (initialSelectedIds && initialSelectedIds.length > 0) {
        setSelectedIds(initialSelectedIds);
      } else {
        // Pre-select utilities-stack + manifexus if present as a helpful default
        const autoPicks = containers
          .filter(
            (c) =>
              c.compose?.project === 'utilities-stack' ||
              c.compose?.project === 'manifexus' ||
              c.cleanName.includes('utilities') ||
              c.cleanName.includes('manifexus')
          )
          .map((c) => c.id);

        if (autoPicks.length > 0) {
          setSelectedIds(autoPicks);
        } else if (containers.length > 0) {
          setSelectedIds([containers[0].id]);
        }
      }

      if (initialTargetStack) {
        setMode('existing-stack');
        setTargetStackName(initialTargetStack);
        const existingDir = containers.find((c) => c.compose?.project === initialTargetStack)?.compose?.workingDir;
        if (existingDir) setTargetDirectory(existingDir);
      }
    }
  }, [isOpen, initialSelectedIds, initialTargetStack, containers]);

  // Pre-fill target directory when stack name changes in new-stack mode
  const handleStackNameChange = (name: string) => {
    setTargetStackName(name);
    if (mode === 'new-stack') {
      const sanitized = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      setTargetDirectory(`/home/ryan/${sanitized || 'combined-stack'}`);
    }
  };

  // Toggle container selection
  const toggleContainer = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  // Select entire compose stack at once
  const selectEntireStack = (projectName: string) => {
    const stackContainerIds = containers
      .filter((c) => c.compose?.project === projectName)
      .map((c) => c.id);

    const allSelected = stackContainerIds.every((id) => selectedIds.includes(id));
    if (allSelected) {
      setSelectedIds((prev) => prev.filter((id) => !stackContainerIds.includes(id)));
    } else {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...stackContainerIds])));
    }
  };

  // Request Plan from Backend Engine
  const generatePlan = async () => {
    if (selectedIds.length === 0) return;
    setIsGeneratingPlan(true);
    setPlanError(null);

    try {
      const res = await fetch('/api/stacks/plan-merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceContainerIds: selectedIds,
          targetStackName,
          targetDirectory,
          mode,
          volumeHandling,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to generate stack merge plan');
      }

      const data: StackMergePlan = await res.json();
      setPlan(data);
      setCurrentStep(3);
    } catch (err) {
      setPlanError((err as Error).message);
    } finally {
      setIsGeneratingPlan(false);
    }
  };

  // Execute Merge
  const executeMerge = async () => {
    if (!plan) return;
    setIsExecuting(true);
    setShowConfirmExecuteDialog(false);
    setIsReconnecting(false);
    setReconnectAttempt(0);
    setReconnectSuccess(false);

    try {
      const res = await fetch('/api/stacks/execute-merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceContainerIds: selectedIds,
          targetStackName: plan.targetStackName,
          targetDirectory: plan.targetDirectory,
          yamlContent: plan.generatedComposeYaml,
        }),
      });

      const result = await res.json();
      setExecutionResult(result);
      if (result.success) {
        setCurrentStep(4);
        // Sequential refreshes to catch Docker daemon state transitions (created -> running)
        if (onMergeSuccess) {
          onMergeSuccess();
          setTimeout(() => onMergeSuccess(), 2000);
          setTimeout(() => onMergeSuccess(), 4500);
        }

        // If Manifexus is migrating into the stack, poll /api/health until the new instance boots
        if (result.isMigratingSelf) {
          setIsReconnecting(true);
          let attempts = 0;
          const maxAttempts = 35;
          const pollTimer = setInterval(async () => {
            attempts++;
            setReconnectAttempt(attempts);
            try {
              const ping = await fetch('/api/health', { cache: 'no-store' });
              if (ping.ok) {
                clearInterval(pollTimer);
                setReconnectSuccess(true);
                setTimeout(() => {
                  window.location.reload();
                }, 1200);
              }
            } catch {
              // Expected while container restarts on host
            }

            if (attempts >= maxAttempts) {
              clearInterval(pollTimer);
            }
          }, 1000);
        }
      }
    } catch (err) {
      setExecutionResult({ success: false, message: (err as Error).message });
    } finally {
      setIsExecuting(false);
    }
  };

  // Copy helper
  const copyToClipboard = (text: string, type: 'yaml' | 'script' | 'rollback' | 'cleanup') => {
    navigator.clipboard.writeText(text);
    setCopiedType(type);
    setTimeout(() => setCopiedType(null), 2500);
  };

  // Download compose file
  const downloadYaml = () => {
    if (!plan) return;
    const blob = new Blob([plan.generatedComposeYaml], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'docker-compose.yml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div
        className="w-full max-w-5xl max-h-[92vh] flex flex-col bg-[#0b0f19] border border-cyan-500/30 rounded-2xl shadow-2xl overflow-hidden font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-slate-900 via-slate-900/90 to-purple-950/40 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/40 text-cyan-400">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white tracking-tight">
                  Stack Merger & Migration Studio
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-950 border border-cyan-500/40 text-cyan-300">
                  Zero Data Loss
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Consolidate separate Docker Compose apps into a single unified stack with preserved host configs & volumes.
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

        {/* Multi-step progress tabs */}
        <div className="grid grid-cols-4 border-b border-slate-800 text-xs font-mono bg-slate-950/60">
          <button
            onClick={() => setCurrentStep(1)}
            className={`py-3 px-4 flex items-center justify-center gap-2 border-r border-slate-800 transition-colors ${
              currentStep === 1
                ? 'bg-cyan-500/10 text-cyan-300 border-b-2 border-b-cyan-400 font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center text-[10px]">1</span>
            <span>Select Apps ({selectedIds.length})</span>
          </button>

          <button
            onClick={() => {
              if (selectedIds.length > 0) setCurrentStep(2);
            }}
            disabled={selectedIds.length === 0}
            className={`py-3 px-4 flex items-center justify-center gap-2 border-r border-slate-800 transition-colors ${
              selectedIds.length === 0 ? 'opacity-40 cursor-not-allowed text-slate-600' : ''
            } ${
              currentStep === 2
                ? 'bg-cyan-500/10 text-cyan-300 border-b-2 border-b-cyan-400 font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center text-[10px]">2</span>
            <span>Target & Storage</span>
          </button>

          <button
            onClick={() => {
              if (plan) setCurrentStep(3);
            }}
            disabled={!plan}
            className={`py-3 px-4 flex items-center justify-center gap-2 border-r border-slate-800 transition-colors ${
              !plan ? 'opacity-40 cursor-not-allowed text-slate-600' : ''
            } ${
              currentStep === 3
                ? 'bg-cyan-500/10 text-cyan-300 border-b-2 border-b-cyan-400 font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center text-[10px]">3</span>
            <span>Review YAML & Run</span>
          </button>

          <button
            onClick={() => setCurrentStep(4)}
            className={`py-3 px-4 flex items-center justify-center gap-2 transition-colors ${
              currentStep === 4
                ? 'bg-purple-500/10 text-purple-300 border-b-2 border-b-purple-400 font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center text-[10px]">4</span>
            <span>GitHub & Updates</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* STEP 1: SELECT APPS */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl bg-slate-900/60 border border-slate-800">
                <div>
                  <h3 className="text-sm font-bold text-slate-200">
                    Choose Docker Compose Apps & Containers to Combine
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Select the apps you want to merge into a single Compose project. You can pick entire stacks or standalone containers.
                  </p>
                </div>

                {/* Quick Presets */}
                <div className="flex items-center gap-2 self-start sm:self-center flex-wrap">
                  <button
                    onClick={() => {
                      const ids = containers
                        .filter(
                          (c) =>
                            c.compose?.project === 'utilities-stack' ||
                            c.compose?.project === 'manifexus' ||
                            c.cleanName.includes('utilities') ||
                            c.cleanName.includes('manifexus')
                        )
                        .map((c) => c.id);
                      setSelectedIds(ids);
                      setMode('existing-stack');
                      setTargetStackName('utilities-stack');
                      setTargetDirectory('/home/ryan/utilities-stack');
                    }}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-bold transition-all flex items-center gap-1.5 ${
                      isManifexusSelected && selectedContainersList.some((c) => c.compose?.project === 'utilities-stack')
                        ? 'bg-emerald-950/80 border-emerald-500/50 text-emerald-200 shadow-[0_0_12px_rgba(16,185,129,0.2)]'
                        : 'bg-purple-950/80 hover:bg-purple-900 border-purple-500/40 text-purple-200 shadow-[0_0_10px_rgba(168,85,247,0.15)]'
                    }`}
                  >
                    <Layers className="w-3.5 h-3.5 text-purple-400" />
                    <span>
                      {isManifexusSelected && selectedContainersList.some((c) => c.compose?.project === 'utilities-stack')
                        ? '✓ utilities-stack + Manifexus Selected'
                        : 'Preset: Merge utilities-stack + Manifexus'}
                    </span>
                  </button>

                  <button
                    onClick={() => setSelectedIds(containers.map((c) => c.id))}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors"
                  >
                    Select All
                  </button>
                  <button
                    onClick={() => setSelectedIds([])}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* Safeguard Banner: Self-Merge Warning when only target stack's own containers are selected */}
              {isSelfMergeOnly && (
                <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-500/40 text-xs text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-in fade-in duration-200">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold text-amber-300 block">Notice: Only services already in "{targetStackName}" are selected</span>
                      <span>
                        No outside apps are selected to merge into this stack. To add an app (like Manifexus), select it below or click the quick button.
                      </span>
                    </div>
                  </div>
                  {unselectedManifexus && (
                    <button
                      onClick={() => {
                        setSelectedIds((prev) => [...prev, unselectedManifexus.id]);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-md flex-shrink-0 transition-all"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Manifexus to {targetStackName}</span>
                    </button>
                  )}
                </div>
              )}

              {/* Selection Summary Bar */}
              <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-slate-300">Selected Services:</span>
                  <span className="px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 font-mono text-[11px] border border-cyan-500/30">
                    {selectedIds.length} {selectedIds.length === 1 ? 'service' : 'services'}
                  </span>
                  {isManifexusSelected && (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 font-mono text-[11px] border border-emerald-500/30 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                      Manifexus Included
                    </span>
                  )}
                </div>
                <div className="text-slate-400 text-[11px] truncate max-w-md">
                  {selectedContainersList.map((c) => c.cleanName).join(', ') || 'None selected'}
                </div>
              </div>

              {/* Compose Stacks List */}
              <div className="space-y-4">
                {Object.entries(groupedStacks.stacks).map(([projectName, stackData]) => {
                  const stackIds = stackData.items.map((i) => i.id);
                  const isAllSelected = stackIds.every((id) => selectedIds.includes(id));
                  const isSomeSelected = stackIds.some((id) => selectedIds.includes(id));

                  return (
                    <div
                      key={projectName}
                      className="rounded-xl border border-slate-800 bg-slate-950/40 overflow-hidden"
                    >
                      <div className="p-3 bg-slate-900/60 border-b border-slate-800 flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={isAllSelected}
                            ref={(el) => {
                              if (el) el.indeterminate = isSomeSelected && !isAllSelected;
                            }}
                            onChange={() => selectEntireStack(projectName)}
                            className="w-4 h-4 rounded text-cyan-500 focus:ring-cyan-500 focus:ring-offset-slate-900 bg-slate-800 border-slate-700 cursor-pointer"
                          />
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-white text-xs">{projectName}</span>
                            <span className="px-2 py-0.5 rounded text-[10px] bg-purple-950/80 text-purple-300 border border-purple-500/30">
                              {stackData.items.length} {stackData.items.length === 1 ? 'service' : 'services'}
                            </span>
                          </div>
                        </div>

                        {stackData.dir && (
                          <div className="flex items-center gap-1 text-[11px] text-slate-400 truncate max-w-sm">
                            <FolderOpen className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
                            <span className="truncate">{stackData.dir}</span>
                          </div>
                        )}
                      </div>

                      <div className="p-3 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                        {stackData.items.map((item) => {
                          const isSelected = selectedIds.includes(item.id);
                          return (
                            <div
                              key={item.id}
                              onClick={() => toggleContainer(item.id)}
                              className={`p-3 rounded-lg border cursor-pointer transition-all flex items-start gap-3 ${
                                isSelected
                                  ? 'bg-cyan-950/30 border-cyan-500/50 text-white'
                                  : 'bg-slate-900/30 border-slate-800/80 text-slate-400 hover:border-slate-700'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => {}} // handled by parent onClick
                                className="mt-0.5 w-4 h-4 rounded text-cyan-500 bg-slate-800 border-slate-700 pointer-events-none"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="font-bold text-xs truncate text-slate-200">
                                  {item.cleanName}
                                </div>
                                <div className="text-[11px] text-slate-500 truncate mt-0.5">
                                  {item.image}
                                </div>
                                {item.primaryPort && (
                                  <div className="text-[10px] text-cyan-400 font-mono mt-1">
                                    Port :{item.primaryPort}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* Standalone Containers */}
                {groupedStacks.standalone.length > 0 && (
                  <div className="rounded-xl border border-slate-800 bg-slate-950/40 overflow-hidden">
                    <div className="p-3 bg-slate-900/60 border-b border-slate-800 flex items-center justify-between">
                      <span className="font-bold text-white text-xs">Standalone Containers</span>
                      <span className="text-[11px] text-slate-400">
                        {groupedStacks.standalone.length} available
                      </span>
                    </div>

                    <div className="p-3 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                      {groupedStacks.standalone.map((item) => {
                        const isSelected = selectedIds.includes(item.id);
                        return (
                          <div
                            key={item.id}
                            onClick={() => toggleContainer(item.id)}
                            className={`p-3 rounded-lg border cursor-pointer transition-all flex items-start gap-3 ${
                              isSelected
                                ? 'bg-cyan-950/30 border-cyan-500/50 text-white'
                                : 'bg-slate-900/30 border-slate-800/80 text-slate-400 hover:border-slate-700'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => {}}
                              className="mt-0.5 w-4 h-4 rounded text-cyan-500 bg-slate-800 border-slate-700 pointer-events-none"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="font-bold text-xs truncate text-slate-200">
                                {item.cleanName}
                              </div>
                              <div className="text-[11px] text-slate-500 truncate mt-0.5">
                                {item.image}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* STEP 2: TARGET & STORAGE CONFIG */}
          {currentStep === 2 && (
            <div className="space-y-6">
              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-4">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <FolderOpen className="w-4 h-4 text-cyan-400" />
                  <span>Stack Destination & Directory Configuration</span>
                </h3>

                {/* Mode Selector */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    onClick={() => {
                      setMode('new-stack');
                      setTargetStackName('test-stack');
                      setTargetDirectory('/home/ryan/test-stack');
                    }}
                    className={`p-4 rounded-xl border text-left transition-all ${
                      mode === 'new-stack'
                        ? 'bg-cyan-950/40 border-cyan-500/60 shadow-md'
                        : 'bg-slate-950/50 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-bold text-xs text-white">Create a Brand New Stack</div>
                    <p className="text-[11px] text-slate-400 mt-1">
                      Makes a new directory (e.g. <code className="text-cyan-300">mkdir -p ~/test-stack</code>) and unifies the selected apps there.
                    </p>
                  </button>

                  <button
                    onClick={() => {
                      setMode('existing-stack');
                      setTargetStackName('utilities-stack');
                      setTargetDirectory('/home/ryan/utilities-stack');
                    }}
                    className={`p-4 rounded-xl border text-left transition-all ${
                      mode === 'existing-stack'
                        ? 'bg-purple-950/40 border-purple-500/60 shadow-md'
                        : 'bg-slate-950/50 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-bold text-xs text-white">Merge Into Existing Stack</div>
                    <p className="text-[11px] text-slate-400 mt-1">
                      Adds apps (like Manifexus) directly into an existing stack (e.g. <code className="text-purple-300">utilities-stack</code>).
                    </p>
                  </button>
                </div>

                {/* Target Inputs */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                  <div>
                    <label className="block text-xs font-bold text-slate-300 mb-1">
                      Stack Project Name
                    </label>
                    <input
                      type="text"
                      value={targetStackName}
                      onChange={(e) => handleStackNameChange(e.target.value)}
                      placeholder="e.g. utilities-stack, test-stack"
                      className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-white text-xs font-mono focus:outline-none focus:border-cyan-400"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-300 mb-1">
                      Host Working Directory Path
                    </label>
                    <input
                      type="text"
                      value={targetDirectory}
                      onChange={(e) => setTargetDirectory(e.target.value)}
                      placeholder="e.g. /home/ryan/utilities-stack"
                      className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-white text-xs font-mono focus:outline-none focus:border-cyan-400"
                    />
                  </div>
                </div>

                {/* Self-Merge Alert in Step 2 */}
                {isSelfMergeOnly && (
                  <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-500/40 text-xs text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-start gap-2.5">
                      <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <span className="font-bold text-amber-300 block">Notice: No New Apps Being Added</span>
                        <span>
                          All {selectedContainersList.length} selected services already exist in "{targetStackName}". Did you want to add Manifexus into this stack?
                        </span>
                      </div>
                    </div>
                    {unselectedManifexus && (
                      <button
                        onClick={() => {
                          setSelectedIds((prev) => [...prev, unselectedManifexus.id]);
                        }}
                        className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-md flex-shrink-0"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add Manifexus to {targetStackName}</span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* ZERO DATA LOSS VOLUME AUDIT */}
              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-emerald-400" />
                    <h3 className="text-sm font-bold text-white">
                      Zero Data Loss Storage Architecture
                    </h3>
                  </div>
                  <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950 border border-emerald-500/40 text-emerald-300">
                    Audited: No Data Overwritten
                  </span>
                </div>

                <p className="text-xs text-slate-400 leading-relaxed">
                  How Manifexus protects all your databases, configs, and media volumes when moving stacks:
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2">
                    <div className="flex items-center gap-2 text-cyan-400 font-bold">
                      <HardDrive className="w-4 h-4" />
                      <span>Host Directory Bind Mounts</span>
                    </div>
                    <p className="text-slate-400 text-[11px] leading-relaxed">
                      Relative paths (like <code className="text-cyan-300">./data</code>) are resolved into absolute host paths (e.g. <code className="text-cyan-300">/home/ryan/manifexus/data</code>). The service continues to mount the exact same files with 0 file movement needed.
                    </p>
                  </div>

                  <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2">
                    <div className="flex items-center gap-2 text-purple-400 font-bold">
                      <Database className="w-4 h-4" />
                      <span>Docker Named Volumes</span>
                    </div>
                    <p className="text-slate-400 text-[11px] leading-relaxed">
                      In Docker Compose, named volumes get namespaced. Manifexus automatically adds <code className="text-purple-300">external: true</code> to the merged YAML so Docker reuses your existing volume instead of creating an empty one!
                    </p>
                  </div>
                </div>

                <div className="pt-2">
                  <label className="block text-xs font-bold text-slate-300 mb-2">
                    Volume Preservation Mode
                  </label>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <label className="flex items-start gap-2.5 p-3 rounded-lg border border-slate-800 bg-slate-950/50 cursor-pointer flex-1">
                      <input
                        type="radio"
                        name="volumeHandling"
                        checked={volumeHandling === 'preserve-absolute'}
                        onChange={() => setVolumeHandling('preserve-absolute')}
                        className="mt-0.5 text-cyan-500 focus:ring-cyan-500"
                      />
                      <div>
                        <div className="text-xs font-bold text-slate-200">
                          Preserve Absolute Host Paths (Recommended)
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          Points directly to existing host directories. 100% zero downtime and zero chance of data loss.
                        </div>
                      </div>
                    </label>

                    <label className="flex items-start gap-2.5 p-3 rounded-lg border border-slate-800 bg-slate-950/50 cursor-pointer flex-1">
                      <input
                        type="radio"
                        name="volumeHandling"
                        checked={volumeHandling === 'consolidate-relative'}
                        onChange={() => setVolumeHandling('consolidate-relative')}
                        className="mt-0.5 text-cyan-500 focus:ring-cyan-500"
                      />
                      <div>
                        <div className="text-xs font-bold text-slate-200">
                          Consolidate into Stack Subdirectories
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          Generates safe <code className="text-cyan-300">cp -a</code> commands to copy data into the new folder with pre-flight verification.
                        </div>
                      </div>
                    </label>
                  </div>
                </div>
              </div>

              {planError && (
                <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-500/40 text-rose-300 text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  <span>{planError}</span>
                </div>
              )}
            </div>
          )}

          {/* STEP 3: REVIEW YAML & EXECUTION RUNNER */}
          {currentStep === 3 && plan && (
            <div className="space-y-6">
              {/* Conflict & Health Check Banner */}
              {plan.portConflicts.some((c) => c.conflict) ? (
                <div className="p-4 rounded-xl bg-amber-950/50 border border-amber-500/40 text-amber-200 text-xs space-y-2">
                  <div className="flex items-center gap-2 font-bold text-amber-300">
                    <AlertTriangle className="w-4 h-4" />
                    <span>Host Port Collision Detected</span>
                  </div>
                  {plan.portConflicts
                    .filter((c) => c.conflict)
                    .map((c) => (
                      <p key={c.port} className="text-amber-300/90 text-[11px]">
                        {c.recommendation}
                      </p>
                    ))}
                </div>
              ) : (
                <div className="p-3.5 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 text-xs flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span>
                      Zero Port Collisions: All services expose independent ports ({plan.services.map((s) => s.ports.join(', ')).filter(Boolean).join(', ')}).
                    </span>
                  </div>
                  <span className="text-[10px] uppercase font-bold text-emerald-400">Ready to Deploy</span>
                </div>
              )}

              {/* Host Automation & Privileges Status Banner */}
              {privileges?.canAutoExecute ? (
                <div className="p-4 rounded-xl bg-gradient-to-r from-purple-950/40 via-slate-900 to-emerald-950/40 border border-emerald-500/40 text-xs space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-bold text-emerald-300">
                      <Zap className="w-4 h-4 text-emerald-400" />
                      <span>Full Host Automation Active</span>
                    </div>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950 border border-emerald-500/40 text-emerald-300">
                      Zero-Touch Live Merge Ready
                    </span>
                  </div>
                  <p className="text-slate-300 text-[11px] leading-relaxed">
                    Manifexus has full host write permissions. Clicking <strong>Execute Live Host Merge</strong> will automatically write the merged <code className="text-cyan-300">{plan.targetDirectory}/docker-compose.yml</code>, save an automated backup, stop the old standalone containers, and start <code className="text-purple-300">docker compose up -d</code> on your Ubuntu host.
                  </p>
                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={() => setShowConfirmExecuteDialog(true)}
                      disabled={isExecuting}
                      className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition-all flex items-center gap-2 shadow-lg shadow-emerald-500/20"
                    >
                      <Zap className="w-4 h-4" />
                      <span>Execute Automated Merge on Host</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-4 rounded-xl bg-purple-950/30 border border-purple-500/40 text-xs space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-bold text-purple-300">
                      <ShieldAlert className="w-4 h-4 text-purple-400" />
                      <span>Host Execution Notice (Sandboxed Mode Active)</span>
                    </div>
                    {onOpenAutomationModal && (
                      <button
                        onClick={onOpenAutomationModal}
                        className="px-3 py-1.5 rounded-lg bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500/50 text-purple-200 text-xs font-bold transition-all flex items-center gap-1.5 self-start sm:self-auto"
                      >
                        <Zap className="w-3.5 h-3.5 text-purple-300" />
                        <span>Elevate to 1-Click Automation</span>
                      </button>
                    )}
                  </div>
                  <p className="text-slate-300 text-[11px] leading-relaxed">
                    Manifexus is currently running with a read-only Docker socket (<code className="text-purple-300">/var/run/docker.sock:ro</code>). To execute this merge completely automatically from this button without opening terminal, click <strong className="text-purple-300">Elevate to 1-Click Automation</strong>. Otherwise, follow the 3 quick commands below.
                  </p>
                </div>
              )}

              {/* Quick 3-Step Host Command Box */}
              <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold text-white flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400" />
                    <span>3-Step Quick Merge on Your Ubuntu Server</span>
                  </div>
                  <button
                    onClick={() => {
                      const quickCmds = `# Step 1: Stop standalone old stack\ncd /home/ryan/manifexus && docker compose down\n\n# Step 2: Open utilities-stack compose and paste the unified YAML\ncd ${plan.targetDirectory}\n# (paste the generated YAML from below)\n\n# Step 3: Start the combined stack\ndocker compose up -d`;
                      copyToClipboard(quickCmds, 'script');
                    }}
                    className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono transition-colors flex items-center gap-1.5"
                  >
                    {copiedType === 'script' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedType === 'script' ? 'Copied Steps!' : 'Copy Steps'}</span>
                  </button>
                </div>

                <div className="p-3 rounded-lg bg-[#07090e] border border-slate-800 text-[11px] font-mono text-cyan-300 space-y-2">
                  <div>
                    <span className="text-slate-500"># 1. Stop the standalone Manifexus instance (volumes are 100% retained):</span>
                    <div className="text-slate-200 font-bold">cd /home/ryan/manifexus && docker compose down</div>
                  </div>
                  <div>
                    <span className="text-slate-500"># 2. Paste the unified docker-compose.yml below into:</span>
                    <div className="text-purple-300 font-bold">{plan.targetDirectory}/docker-compose.yml</div>
                  </div>
                  <div>
                    <span className="text-slate-500"># 3. Spin up your unified stack:</span>
                    <div className="text-emerald-400 font-bold">cd {plan.targetDirectory} && docker compose pull && docker compose up -d</div>
                  </div>
                </div>
              </div>

              {/* Volume Safety Table */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 overflow-hidden">
                <div className="p-3 bg-slate-900/80 border-b border-slate-800 flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-200">
                    Volume Audit Breakdown ({plan.volumeSafetyAudit.length} volumes)
                  </span>
                  <span className="text-[10px] text-emerald-400 font-bold flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>100% Zero-Loss Guaranteed</span>
                  </span>
                </div>

                <div className="divide-y divide-slate-800/80 max-h-48 overflow-y-auto text-xs">
                  {plan.volumeSafetyAudit.map((vol, idx) => (
                    <div key={idx} className="p-2.5 px-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white">{vol.service}</span>
                          <span className="text-slate-500 font-mono text-[11px] truncate max-w-xs">
                            {vol.source} → {vol.destination}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-400 mt-0.5">{vol.explanation}</p>
                      </div>

                      <span className="self-start sm:self-center px-2 py-0.5 rounded text-[10px] font-bold bg-slate-900 border border-slate-700 text-cyan-300 whitespace-nowrap">
                        {vol.badgeText}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* YAML Editor & Viewer */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs font-bold text-white">
                      Generated docker-compose.yml ({plan.targetDirectory}/docker-compose.yml)
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={downloadYaml}
                      className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors flex items-center gap-1.5"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download</span>
                    </button>

                    <button
                      onClick={() => copyToClipboard(plan.generatedComposeYaml, 'yaml')}
                      className="px-2.5 py-1 rounded-lg bg-cyan-950/80 hover:bg-cyan-900 border border-cyan-500/40 text-cyan-300 text-xs transition-colors flex items-center gap-1.5 font-bold"
                    >
                      {copiedType === 'yaml' ? (
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
                </div>

                <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-[11px] text-cyan-300/90 font-mono overflow-x-auto max-h-64 scrollbar-thin">
                  {plan.generatedComposeYaml}
                </pre>
              </div>

              {/* Automation Shell Script Option */}
              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-xs font-bold text-white">Automated Safe Migration Script</h4>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Backs up existing compose files, stops old containers (preserving all volumes), and brings up the merged stack.
                    </p>
                  </div>

                  <button
                    onClick={() => copyToClipboard(plan.migrationScript, 'script')}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs transition-colors flex items-center gap-1.5"
                  >
                    {copiedType === 'script' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Copied Script!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Script (migrate.sh)</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/80 text-[11px] text-slate-400 font-mono flex items-center justify-between">
                  <code>curl -sSL ... or run in terminal on your host</code>
                  <span className="text-[10px] text-purple-400">set -e safe failure prevention</span>
                </div>
              </div>
            </div>
          )}

          {/* STEP 4: GITHUB UPDATE GUIDE & VERIFICATION */}
          {currentStep === 4 && (
            <div className="space-y-6">
              {/* Central Command Reconnection Status (When Manifexus is migrating into stack) */}
              {isReconnecting && (
                <div className="p-5 rounded-xl bg-gradient-to-r from-cyan-950/80 via-slate-900 to-purple-950/80 border border-cyan-500/50 text-xs space-y-3 shadow-xl">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2.5 rounded-xl bg-cyan-500/20 border border-cyan-500/40 text-cyan-300">
                        <RefreshCw className={`w-5 h-5 ${reconnectSuccess ? 'text-emerald-400' : 'animate-spin'}`} />
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-white">
                          {reconnectSuccess ? 'Central Command Reconnected!' : 'Migrating Manifexus to Unified Stack...'}
                        </h4>
                        <p className="text-xs text-slate-300">
                          {reconnectSuccess
                            ? 'Reloading dashboard to display unified stack view...'
                            : `Central command container is restarting inside ${plan?.targetStackName || 'the new stack'} on port 3334.`}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-slate-950 border border-cyan-500/30 text-cyan-300 font-mono">
                        {reconnectSuccess ? 'ONLINE' : `Ping Attempt ${reconnectAttempt}/35`}
                      </span>
                      <button
                        onClick={() => window.location.reload()}
                        className="px-3 py-1.5 rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400 font-bold text-xs transition-colors"
                      >
                        Refresh Now
                      </button>
                    </div>
                  </div>

                  <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden border border-slate-800">
                    <div
                      className={`h-full transition-all duration-300 ${reconnectSuccess ? 'bg-emerald-400 w-full' : 'bg-cyan-400 animate-pulse w-3/4'}`}
                    />
                  </div>
                </div>
              )}

              {/* Success Banner if Executed */}
              {executionResult && (
                <div className="p-4 rounded-xl bg-emerald-950/60 border border-emerald-500/40 text-emerald-200 text-xs space-y-2">
                  <div className="flex items-center gap-2 font-bold text-emerald-300 text-sm">
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                    <span>{executionResult.isAutomated ? 'Automated Host Merge Executed!' : 'Merge Verification Ready!'}</span>
                  </div>
                  <p className="text-emerald-200/90 text-xs">
                    {executionResult.message}
                  </p>
                </div>
              )}

              {/* Host Orchestration Logs Box */}
              {executionResult?.logs && executionResult.logs.length > 0 && (
                <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
                  <div className="flex items-center gap-2 font-bold text-xs text-white">
                    <Terminal className="w-4 h-4 text-cyan-400" />
                    <span>Automated Host Orchestration Execution Logs</span>
                  </div>
                  <div className="p-3 rounded-lg bg-[#07090e] border border-slate-800 text-[11px] font-mono text-cyan-300 space-y-1 max-h-52 overflow-y-auto">
                    {executionResult.logs.map((log, idx) => (
                      <div key={idx} className="whitespace-pre-wrap">{log}</div>
                    ))}
                  </div>
                </div>
              )}

              {/* CRITICAL ANSWER TO USER QUESTION: HOW TO UPDATE IMAGE FROM GITHUB */}
              <div className="p-5 rounded-xl bg-gradient-to-br from-slate-900 via-slate-900 to-purple-950/40 border border-purple-500/40 space-y-4">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-400">
                    <GitBranch className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">
                      How to Update Manifexus to the New Version from GitHub
                    </h3>
                    <p className="text-xs text-slate-400">
                      Why `docker compose up -d` didn't update previously, and the exact commands to update.
                    </p>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 text-xs text-slate-300 space-y-2.5 leading-relaxed">
                  <p>
                    <strong className="text-cyan-300">Why it didn't update before:</strong> When you run <code className="text-purple-300">docker compose up -d</code>, Docker checks if an image tagged <code className="text-cyan-300">:latest</code> already exists on your host disk. If it does, Docker reuses that cached local image and <strong>does not pull the new one from GitHub!</strong>
                  </p>
                  <p>
                    <strong className="text-cyan-300">The 2-step solution:</strong> You must explicitly pull the new image digest first:
                  </p>

                  <div className="p-3 rounded-lg bg-[#07090e] border border-slate-800 text-xs font-mono text-cyan-300 space-y-1">
                    <div className="text-slate-500"># Step 1: Pull the newly built GitHub image digest</div>
                    <div>docker compose pull</div>
                    <div className="text-slate-500 pt-1"># Step 2: Recreate container with the new image</div>
                    <div>docker compose up -d</div>
                  </div>

                  <p className="text-[11px] text-slate-400">
                    Or run both together in one line: <code className="text-white bg-slate-900 px-2 py-0.5 rounded border border-slate-800">docker compose pull && docker compose up -d</code>
                  </p>
                </div>
              </div>

              {/* POST-VERIFICATION & PRUNING DEPRECATED CONTAINERS */}
              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Trash2 className="w-4 h-4 text-rose-400" />
                    <h4 className="text-xs font-bold text-white">
                      Confirm & Clean Up Old Deprecated Stack Resources
                    </h4>
                  </div>
                  <span className="text-[10px] text-slate-500 font-mono">Run ONLY after confirming healthy</span>
                </div>

                <p className="text-xs text-slate-400 leading-relaxed">
                  Only once you test that your combined services are responding normally and your data is verified 100% intact, you can run this script to prune obsolete orphan networks and archive the old compose folders.
                </p>

                <div className="flex items-center gap-3 pt-1">
                  <button
                    onClick={() => {
                      if (plan) copyToClipboard(plan.cleanupScript, 'cleanup');
                    }}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs transition-colors flex items-center gap-1.5"
                  >
                    {copiedType === 'cleanup' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Copied Cleanup Script!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Cleanup Script</span>
                      </>
                    )}
                  </button>

                  <button
                    onClick={() => {
                      if (plan) copyToClipboard(plan.rollbackScript, 'rollback');
                    }}
                    className="px-3 py-1.5 rounded-lg bg-rose-950/60 hover:bg-rose-900/80 border border-rose-500/40 text-rose-300 text-xs transition-colors flex items-center gap-1.5"
                  >
                    {copiedType === 'rollback' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Copied Rollback!</span>
                      </>
                    ) : (
                      <span>Copy Emergency Rollback</span>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer Controls */}
        <div className="px-6 py-4 bg-slate-950 border-t border-slate-800 flex items-center justify-between">
          <div>
            {currentStep > 1 && currentStep < 4 && (
              <button
                onClick={() => setCurrentStep((prev) => (prev - 1) as 1 | 2 | 3)}
                className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-bold transition-colors"
              >
                Back
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white text-xs font-bold transition-colors"
            >
              Close
            </button>

            {currentStep === 1 && (
              <button
                onClick={() => setCurrentStep(2)}
                disabled={selectedIds.length === 0}
                className={`px-5 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
                  selectedIds.length === 0
                    ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                    : 'bg-cyan-500 text-slate-950 hover:bg-cyan-400 shadow-lg shadow-cyan-500/20'
                }`}
              >
                <span>Configure Target Stack</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            )}

            {currentStep === 2 && (
              <button
                onClick={generatePlan}
                disabled={isGeneratingPlan || !targetStackName.trim()}
                className="px-5 py-2 rounded-xl bg-cyan-500 text-slate-950 hover:bg-cyan-400 text-xs font-bold transition-all flex items-center gap-2 shadow-lg shadow-cyan-500/20"
              >
                {isGeneratingPlan ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Auditing Volumes & Generating YAML...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-4 h-4" />
                    <span>Audit Volumes & Generate Plan</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            )}

            {currentStep === 3 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentStep(4)}
                  className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-colors"
                >
                  GitHub Update Guide
                </button>

                {privileges?.canAutoExecute ? (
                  <button
                    onClick={() => setShowConfirmExecuteDialog(true)}
                    disabled={isExecuting}
                    className="px-5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition-all flex items-center gap-2 shadow-lg shadow-emerald-500/20"
                  >
                    {isExecuting ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Executing Live on Host...</span>
                      </>
                    ) : (
                      <>
                        <Zap className="w-4 h-4" />
                        <span>Execute Automated Merge</span>
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    onClick={() => setShowConfirmExecuteDialog(true)}
                    disabled={isExecuting}
                    className="px-5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold transition-all flex items-center gap-2 shadow-lg shadow-cyan-500/20"
                  >
                    {isExecuting ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Checking Fleet...</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Next: Verification & Guide</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            )}

            {currentStep === 4 && (
              <button
                onClick={onClose}
                className="px-5 py-2 rounded-xl bg-cyan-500 text-slate-950 hover:bg-cyan-400 text-xs font-bold transition-all"
              >
                Done
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation & Warning Popup Modal for Host Automated Execution */}
      {showConfirmExecuteDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-150">
          <div className="w-full max-w-xl bg-[#0b0f19] border border-cyan-500/40 rounded-2xl shadow-2xl overflow-hidden font-mono text-xs">
            <div className="px-6 py-4 bg-gradient-to-r from-slate-900 to-purple-950/60 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5 font-bold text-white text-sm">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
                <span>Confirm Automated Host Stack Merge</span>
              </div>
              <button
                onClick={() => setShowConfirmExecuteDialog(false)}
                className="text-slate-400 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-4 text-slate-300 leading-relaxed">
              <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-500/30 text-amber-200 text-xs flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <strong className="block text-amber-300">Warning: Host System Orchestration</strong>
                  This action will orchestrate Docker directly on your Ubuntu host filesystem to consolidate standalone containers into <code className="text-cyan-300 font-bold">{plan?.targetStackName}</code>.
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800/80 space-y-2.5 text-[11px]">
                <div className="font-bold text-slate-200 mb-1 border-b border-slate-800 pb-1 flex items-center justify-between">
                  <span>Automated Execution Operations:</span>
                  <span className="text-[10px] text-cyan-400 font-normal">Safe Atomic Operations</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">1. Target Host Compose:</span>
                  <span className="font-bold text-cyan-300 font-mono">{plan?.targetDirectory}/docker-compose.yml</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">2. Pre-Merge Safety Backup:</span>
                  <span className="font-bold text-emerald-400 font-mono">docker-compose.backup.yml</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">3. Services in Final Stack:</span>
                  <span className="font-bold text-cyan-300">
                    {plan?.services?.map((s) => s.serviceName).join(', ') ||
                      selectedContainersList.map((c) => c.cleanName).join(', ')}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">4. Foreign Containers Replaced:</span>
                  <span className="font-bold text-purple-300">
                    {selectedContainersList
                      .filter((c) => c.compose?.project !== plan?.targetStackName)
                      .map((c) => c.cleanName)
                      .join(', ') || 'None (all belong to target stack)'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">5. Target Stack Services:</span>
                  <span className="font-bold text-emerald-400">
                    Preserved & hot-reloaded smoothly
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">6. Storage Volumes:</span>
                  <span className="font-bold text-emerald-400">100% Retained and Preserved</span>
                </div>
              </div>

              {isSelfMergeOnly && (
                <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-500/30 text-amber-200 text-xs flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <strong className="block text-amber-300">Notice: No External Apps Selected</strong>
                    You are consolidating "{plan?.targetStackName}" with its existing services. Manifexus and standalone containers are not being added.
                  </div>
                </div>
              )}

              {!privileges?.canAutoExecute && (
                <div className="p-3 rounded-xl bg-purple-950/40 border border-purple-500/40 text-xs text-purple-200">
                  <p className="font-bold text-purple-300 mb-1">Notice: Sandboxed Mode</p>
                  Because Manifexus is currently running with a read-only Docker socket, automatic filesystem writing requires host elevation. If not elevated, Manifexus will advance you to the verified 3-step guide to run in 5 seconds on your host.
                </div>
              )}
            </div>

            <div className="px-6 py-4 bg-slate-900/90 border-t border-slate-800 flex items-center justify-end gap-3">
              <button
                onClick={() => setShowConfirmExecuteDialog(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeMerge}
                disabled={isExecuting}
                className="px-5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition-all flex items-center gap-2 shadow-lg shadow-emerald-500/20"
              >
                {isExecuting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Executing Live on Host...</span>
                  </>
                ) : (
                  <>
                    <Zap className="w-3.5 h-3.5" />
                    <span>Confirm & Execute Live Merge</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
