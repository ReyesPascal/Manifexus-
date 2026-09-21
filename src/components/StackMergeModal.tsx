import React, { useState, useEffect, useMemo, useRef } from 'react';
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
  PlusCircle,
  Clock,
  RotateCcw,
} from 'lucide-react';
import { DeepContainerMetadata, StackMergePlan, AutomationPrivileges } from '../types';
import { ExecutionPipelineConsole } from './ExecutionPipelineConsole';

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

// Directive 1: Helper to strictly filter out Manifexus from all merge calculations
export function isManifexusContainer(c: DeepContainerMetadata): boolean {
  const clean = (c.cleanName || c.name || '').toLowerCase();
  const proj = (c.compose?.project || '').toLowerCase();
  const img = (c.image || '').toLowerCase();
  return clean === 'manifexus' || clean === '/manifexus' || proj === 'manifexus' || img.includes('manifexus');
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
  // Step navigation: 1 = select, 2 = target & storage, 3 = review yaml & execute, 4 = updates
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4>(1);

  // Directive 1: Strictly filter out Manifexus from ALL mergeable containers
  const mergeableContainers = useMemo(() => {
    return containers.filter((c) => !isManifexusContainer(c));
  }, [containers]);

  // Selection
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Target config
  const [mode, setMode] = useState<'existing-stack' | 'new-stack'>('new-stack');
  const [targetStackName, setTargetStackName] = useState<string>('combined-stack');
  const [targetDirectory, setTargetDirectory] = useState<string>('/home/ryan/combined-stack');
  const [volumeHandling, setVolumeHandling] = useState<'preserve-absolute' | 'consolidate-relative'>('preserve-absolute');

  // Plan generation state
  const [plan, setPlan] = useState<StackMergePlan | null>(null);
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  // Execution state & Confirmation dialog
  const [showConfirmExecuteDialog, setShowConfirmExecuteDialog] = useState(false);
  const [copiedType, setCopiedType] = useState<'yaml' | 'script' | 'rollback' | 'cleanup' | null>(null);

  // Directive 3 & 4: Live Streaming Pipeline Console State
  const [isPipelineConsoleOpen, setIsPipelineConsoleOpen] = useState(false);
  const [pipelineMode, setPipelineMode] = useState<'merge' | 'revert'>('merge');
  const [pipelineMergeId, setPipelineMergeId] = useState<string | undefined>(undefined);
  const [pipelineStreamUrl, setPipelineStreamUrl] = useState<string>('/api/stacks/execute-merge-stream');
  const [pipelineStreamPayload, setPipelineStreamPayload] = useState<Record<string, unknown>>({});

  // Group containers by stack for selection
  const groupedStacks = useMemo(() => {
    const stacks: Record<string, { dir?: string; items: DeepContainerMetadata[] }> = {};
    const standalone: DeepContainerMetadata[] = [];

    for (const c of mergeableContainers) {
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
  }, [mergeableContainers]);

  // Selected container objects list
  const selectedContainersList = useMemo(() => {
    return mergeableContainers.filter((c) => selectedIds.includes(c.id));
  }, [mergeableContainers, selectedIds]);

  // Determine if this is a self-merge (all selected services already belong to the target stack)
  const isSelfMergeOnly = useMemo(() => {
    if (mode !== 'existing-stack' || !targetStackName || selectedContainersList.length === 0) return false;
    return selectedContainersList.every((c) => c.compose?.project === targetStackName);
  }, [mode, targetStackName, selectedContainersList]);

  // Directive 2: Decouple local modal state from global polling refreshes
  // Reset state ONLY when the modal transitions from closed to open
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setCurrentStep(1);
      setPlan(null);
      setPlanError(null);
      setShowConfirmExecuteDialog(false);
      setCopiedType(null);
      setIsPipelineConsoleOpen(false);

      // Clean out any Manifexus IDs that might have been passed
      const safeInitial = (initialSelectedIds || []).filter((id) => {
        const found = containers.find((c) => c.id === id || c.cleanName === id);
        return found ? !isManifexusContainer(found) : true;
      });

      if (safeInitial.length > 0) {
        setSelectedIds(safeInitial);
      } else if (mergeableContainers.length > 0) {
        // Pre-select first mergeable container or stack
        setSelectedIds([mergeableContainers[0].id]);
      } else {
        setSelectedIds([]);
      }

      if (initialTargetStack && initialTargetStack !== 'manifexus') {
        setMode('existing-stack');
        setTargetStackName(initialTargetStack);
        const existingDir = mergeableContainers.find((c) => c.compose?.project === initialTargetStack)?.compose?.workingDir;
        if (existingDir) setTargetDirectory(existingDir);
      } else {
        setMode('new-stack');
        setTargetStackName('combined-stack');
        setTargetDirectory('/home/ryan/combined-stack');
      }
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, initialSelectedIds, initialTargetStack, containers, mergeableContainers]);

  // Pre-fill target directory when stack name changes in new-stack mode
  const handleStackNameChange = (name: string) => {
    setTargetStackName(name);
    if (mode === 'new-stack') {
      const sanitized = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      setTargetDirectory(`/home/ryan/${sanitized || 'combined-stack'}`);
    }
  };

  // Toggle container selection with stopPropagation
  const toggleContainer = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  // Select entire compose stack at once
  const selectEntireStack = (projectName: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const stackContainerIds = mergeableContainers
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
        const data = await res.json();
        throw new Error(data.error || 'Failed to synthesize Docker Compose stack');
      }

      const planData = await res.json();
      setPlan(planData);
      setCurrentStep(3);
    } catch (err) {
      setPlanError((err as Error).message);
    } finally {
      setIsGeneratingPlan(false);
    }
  };

  // Directive 3: Launch Live Streaming Pipeline Execution
  const triggerStreamingExecution = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!plan) return;

    setShowConfirmExecuteDialog(false);
    setPipelineMode('merge');
    setPipelineMergeId(undefined);
    setPipelineStreamUrl('/api/stacks/execute-merge-stream');
    setPipelineStreamPayload({
      sourceContainerIds: selectedIds,
      targetStackName: plan.targetStackName,
      targetDirectory: plan.targetDirectory,
      yamlContent: plan.generatedComposeYaml,
    });
    setIsPipelineConsoleOpen(true);
  };

  // Directive 4: Launch Revert Streaming Execution
  const handleTriggerRevert = (mergeId: string) => {
    setPipelineMode('revert');
    setPipelineMergeId(mergeId);
    setPipelineStreamUrl(`/api/history/${mergeId}/revert-stream`);
    setPipelineStreamPayload({});
    setIsPipelineConsoleOpen(true);
  };

  // Directive 4: Keep Changes
  const handleKeepChanges = () => {
    setIsPipelineConsoleOpen(false);
    if (onMergeSuccess) {
      onMergeSuccess();
      setTimeout(() => onMergeSuccess(), 2000);
      setTimeout(() => onMergeSuccess(), 4500);
    }
    onClose();
  };

  // Copy helper
  const copyToClipboard = (text: string, type: 'yaml' | 'script' | 'rollback' | 'cleanup', e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopiedType(type);
    setTimeout(() => setCopiedType(null), 2500);
  };

  // Download compose file
  const downloadYaml = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/85 backdrop-blur-md animate-in fade-in duration-200"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="w-full max-w-5xl max-h-[92vh] flex flex-col bg-[#0b0f19] border border-cyan-500/30 rounded-2xl shadow-2xl overflow-hidden font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-slate-900 via-slate-900/90 to-purple-950/40 border-b border-slate-800 flex items-center justify-between flex-shrink-0">
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
                Consolidate separate Docker Compose apps into a single unified stack with AST synthesis and host data preservation.
              </p>
            </div>
          </div>

          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/80 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Multi-step Progress Tabs */}
        <div className="grid grid-cols-4 border-b border-slate-800 text-xs font-mono bg-slate-950/60 flex-shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setCurrentStep(1);
            }}
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
            onClick={(e) => {
              e.stopPropagation();
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
            onClick={(e) => {
              e.stopPropagation();
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
            onClick={(e) => {
              e.stopPropagation();
              setCurrentStep(4);
            }}
            className={`py-3 px-4 flex items-center justify-center gap-2 transition-colors ${
              currentStep === 4
                ? 'bg-purple-500/10 text-purple-300 border-b-2 border-b-purple-400 font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center text-[10px]">4</span>
            <span>Rollbacks & Ledger</span>
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
                    Select any services or standalone containers to consolidate into a unified stack.
                  </p>
                </div>

                {/* Quick Presets */}
                <div className="flex items-center gap-2 self-start sm:self-center flex-wrap">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedIds(mergeableContainers.map((c) => c.id));
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors"
                  >
                    Select All ({mergeableContainers.length})
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedIds([]);
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* Safeguard Notice: Guidance when only target stack's own containers are selected */}
              {isSelfMergeOnly && (
                <div className="p-3.5 rounded-xl bg-cyan-950/30 border border-cyan-500/30 text-xs text-cyan-200 flex items-start gap-2.5">
                  <Info className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-cyan-300 block">Adding Services to "{targetStackName}"</span>
                    <span>
                      You've selected services already in this stack. Check additional standalone apps or external services below to merge them into <code className="text-cyan-400 font-bold">{targetStackName}</code>.
                    </span>
                  </div>
                </div>
              )}

              {/* Quick Standalone Apps Shortcuts */}
              {groupedStacks.standalone.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                    <Zap className="w-3 h-3" />
                    <span>Quick Add Standalone Apps</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {groupedStacks.standalone.map((c) => (
                      <button
                        key={c.id}
                        onClick={(e) => toggleContainer(c.id, e)}
                        className={`px-3 py-1.5 rounded-lg border text-[11px] font-bold transition-all flex items-center gap-1.5 ${
                          selectedIds.includes(c.id)
                            ? 'bg-cyan-900/40 border-cyan-500/60 text-cyan-300 shadow-sm'
                            : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                        }`}
                      >
                        {selectedIds.includes(c.id) ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400" />
                        ) : (
                          <PlusCircle className="w-3.5 h-3.5" />
                        )}
                        <span>{c.cleanName}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Selection Summary Bar */}
              <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-slate-300">Selected Services:</span>
                  <span className="px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 font-mono text-[11px] border border-cyan-500/30">
                    {selectedIds.length} {selectedIds.length === 1 ? 'service' : 'services'}
                  </span>
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
                            onChange={(e) => selectEntireStack(projectName, e as unknown as React.MouseEvent)}
                            onClick={(e) => e.stopPropagation()}
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
                          <span className="text-[11px] text-slate-500 truncate max-w-xs">
                            {stackData.dir}
                          </span>
                        )}
                      </div>

                      <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {stackData.items.map((c) => {
                          const isSelected = selectedIds.includes(c.id);
                          return (
                            <div
                              key={c.id}
                              onClick={(e) => toggleContainer(c.id, e)}
                              className={`p-2.5 rounded-lg border text-xs cursor-pointer transition-all flex items-center justify-between ${
                                isSelected
                                  ? 'bg-cyan-950/40 border-cyan-500/50 text-white'
                                  : 'bg-slate-900/30 border-slate-800/80 text-slate-400 hover:border-slate-700'
                              }`}
                            >
                              <div className="flex items-center gap-2.5">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => {}}
                                  onClick={(e) => e.stopPropagation()}
                                  className="w-3.5 h-3.5 rounded text-cyan-500 bg-slate-800 border-slate-700"
                                />
                                <div>
                                  <div className="font-bold text-slate-200">{c.cleanName}</div>
                                  <div className="text-[10px] text-slate-500 truncate max-w-[200px]">
                                    {c.image}
                                  </div>
                                </div>
                              </div>

                              <div className="text-right text-[10px] text-slate-400">
                                {c.ports.length > 0 && (
                                  <span>
                                    :{c.ports.map((p) => p.publicPort).filter(Boolean).join(', :')}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* Standalone Containers List */}
                {groupedStacks.standalone.length > 0 && (
                  <div className="rounded-xl border border-slate-800 bg-slate-950/40 overflow-hidden">
                    <div className="p-3 bg-slate-900/60 border-b border-slate-800 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-xs">Standalone Containers</span>
                        <span className="px-2 py-0.5 rounded text-[10px] bg-slate-800 text-slate-400 border border-slate-700">
                          {groupedStacks.standalone.length}
                        </span>
                      </div>
                    </div>

                    <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {groupedStacks.standalone.map((c) => {
                        const isSelected = selectedIds.includes(c.id);
                        return (
                          <div
                            key={c.id}
                            onClick={(e) => toggleContainer(c.id, e)}
                            className={`p-2.5 rounded-lg border text-xs cursor-pointer transition-all flex items-center justify-between ${
                              isSelected
                                ? 'bg-cyan-950/40 border-cyan-500/50 text-white'
                                : 'bg-slate-900/30 border-slate-800/80 text-slate-400 hover:border-slate-700'
                            }`}
                          >
                            <div className="flex items-center gap-2.5">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => {}}
                                onClick={(e) => e.stopPropagation()}
                                className="w-3.5 h-3.5 rounded text-cyan-500 bg-slate-800 border-slate-700"
                              />
                              <div>
                                <div className="font-bold text-slate-200">{c.cleanName}</div>
                                <div className="text-[10px] text-slate-500 truncate max-w-[200px]">
                                  {c.image}
                                </div>
                              </div>
                            </div>

                            <div className="text-right text-[10px] text-slate-400">
                              {c.ports.length > 0 && (
                                <span>
                                  :{c.ports.map((p) => p.publicPort).filter(Boolean).join(', :')}
                                </span>
                              )}
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

          {/* STEP 2: TARGET & STORAGE */}
          {currentStep === 2 && (
            <div className="space-y-6">
              {/* Stack Mode Selection */}
              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-4">
                <h3 className="text-sm font-bold text-slate-200">
                  Target Stack Configuration
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      setMode('new-stack');
                    }}
                    className={`p-4 rounded-xl border cursor-pointer transition-all ${
                      mode === 'new-stack'
                        ? 'bg-cyan-950/40 border-cyan-500/60 text-white shadow-md'
                        : 'bg-slate-950/50 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center gap-2 text-cyan-400 font-bold text-xs mb-1">
                      <Layers className="w-4 h-4" />
                      <span>Create New Unified Stack</span>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Creates a brand new dedicated directory and unified docker-compose.yml file.
                    </p>
                  </div>

                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      setMode('existing-stack');
                    }}
                    className={`p-4 rounded-xl border cursor-pointer transition-all ${
                      mode === 'existing-stack'
                        ? 'bg-cyan-950/40 border-cyan-500/60 text-white shadow-md'
                        : 'bg-slate-950/50 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center gap-2 text-purple-400 font-bold text-xs mb-1">
                      <GitBranch className="w-4 h-4" />
                      <span>Merge into Existing Stack</span>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Appends services to an existing compose file via intelligent AST mutation.
                    </p>
                  </div>
                </div>

                {/* Form Fields */}
                <div className="space-y-4 pt-2">
                  <div>
                    <label className="block text-xs font-bold text-slate-300 mb-1.5">
                      Stack Name:
                    </label>
                    {mode === 'existing-stack' ? (
                      <select
                        value={targetStackName}
                        onChange={(e) => {
                          const val = e.target.value;
                          setTargetStackName(val);
                          const existingDir = mergeableContainers.find((c) => c.compose?.project === val)?.compose?.workingDir;
                          if (existingDir) setTargetDirectory(existingDir);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-white text-xs focus:border-cyan-500 focus:outline-none"
                      >
                        {Object.keys(groupedStacks.stacks).map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={targetStackName}
                        onChange={(e) => handleStackNameChange(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        placeholder="e.g. combined-stack"
                        className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-white text-xs focus:border-cyan-500 focus:outline-none"
                      />
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-300 mb-1.5">
                      Host Target Directory:
                    </label>
                    <input
                      type="text"
                      value={targetDirectory}
                      onChange={(e) => setTargetDirectory(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      placeholder="e.g. /home/ryan/combined-stack"
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-white text-xs focus:border-cyan-500 focus:outline-none"
                    />
                  </div>
                </div>
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
                    AST Preserved: No Data Overwritten
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2">
                    <div className="flex items-center gap-2 text-cyan-400 font-bold">
                      <HardDrive className="w-4 h-4" />
                      <span>Host Directory Bind Mounts</span>
                    </div>
                    <p className="text-slate-400 text-[11px] leading-relaxed">
                      Relative paths (like <code className="text-cyan-300">./data</code>) are resolved into absolute host paths. The service mounts the exact same files with zero file movement.
                    </p>
                  </div>

                  <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2">
                    <div className="flex items-center gap-2 text-purple-400 font-bold">
                      <Database className="w-4 h-4" />
                      <span>Docker Named Volumes</span>
                    </div>
                    <p className="text-slate-400 text-[11px] leading-relaxed">
                      Named volumes automatically receive <code className="text-purple-300">external: true</code> to bind to the existing volume data without wiping databases.
                    </p>
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

          {/* STEP 3: REVIEW YAML & RUN PIPELINE */}
          {currentStep === 3 && plan && (
            <div className="space-y-6">
              {/* Conflict Check Banner */}
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
                      Zero Port Collisions: All services expose independent ports.
                    </span>
                  </div>
                  <span className="text-[10px] uppercase font-bold text-emerald-400">Ready to Deploy</span>
                </div>
              )}

              {/* Host Automation & Streaming Execution Banner */}
              <div className="p-4 rounded-xl bg-gradient-to-r from-purple-950/40 via-slate-900 to-emerald-950/40 border border-emerald-500/40 text-xs space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-bold text-emerald-300">
                    <Zap className="w-4 h-4 text-emerald-400" />
                    <span>Directive 3: Live GitHub Actions-Style Execution Pipeline</span>
                  </div>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950 border border-emerald-500/40 text-emerald-300">
                    7-Step Stream Ready
                  </span>
                </div>
                <p className="text-slate-300 text-[11px] leading-relaxed">
                  Clicking <strong>Execute Live Host Merge</strong> initiates a live, step-by-step pipeline streaming real-time logs, automated <code className="text-cyan-300">/app/backups</code> snapshots, AST compose synthesis, and container handoff.
                </p>
                <div className="flex items-center gap-3 pt-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowConfirmExecuteDialog(true);
                    }}
                    className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition-all flex items-center gap-2 shadow-lg shadow-emerald-500/20"
                  >
                    <Zap className="w-4 h-4" />
                    <span>Execute Automated 7-Step Pipeline</span>
                  </button>
                </div>
              </div>

              {/* YAML Preview */}
              <div className="rounded-xl border border-slate-800 bg-[#07090e] overflow-hidden">
                <div className="p-3 bg-slate-900/80 border-b border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-300">
                    <Layers className="w-4 h-4 text-cyan-400" />
                    <span>Synthesized docker-compose.yml</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => copyToClipboard(plan.generatedComposeYaml, 'yaml', e)}
                      className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs flex items-center gap-1.5 transition-colors"
                    >
                      {copiedType === 'yaml' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedType === 'yaml' ? 'Copied' : 'Copy'}</span>
                    </button>
                    <button
                      onClick={(e) => downloadYaml(e)}
                      className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs flex items-center gap-1.5 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download</span>
                    </button>
                  </div>
                </div>

                <pre className="p-4 text-[11px] font-mono text-cyan-300/90 overflow-x-auto max-h-72 leading-relaxed selection:bg-cyan-500/30">
                  {plan.generatedComposeYaml}
                </pre>
              </div>
            </div>
          )}

          {/* STEP 4: ROLLBACKS & STATE LEDGER */}
          {currentStep === 4 && (
            <div className="space-y-6 text-xs">
              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-3">
                <div className="flex items-center gap-2 font-bold text-purple-300 text-sm">
                  <GitBranch className="w-4 h-4 text-purple-400" />
                  <span>State Ledger & Snapshot Storage</span>
                </div>
                <p className="text-slate-400 text-xs leading-relaxed">
                  All merges are recorded immutably in the state ledger (<code className="text-purple-300">/app/backups/history.json</code>).
                  You can trigger zero-loss rollbacks at any time from the Merge History viewer.
                </p>
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-slate-400 font-mono">
                  Volume Path: <code className="text-cyan-300">/app/backups</code> (Mount to host <code className="text-cyan-300">./backups:/app/backups</code> for persistent host retention).
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer Controls */}
        <div className="px-6 py-4 bg-[#07090e] border-t border-slate-800 flex items-center justify-between flex-shrink-0">
          <div>
            {currentStep > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setCurrentStep((prev) => (prev > 1 ? ((prev - 1) as 1 | 2 | 3 | 4) : 1));
                }}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono transition-colors"
              >
                Back
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white text-xs font-mono transition-colors border border-slate-800"
            >
              Cancel
            </button>

            {currentStep === 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setCurrentStep(2);
                }}
                disabled={selectedIds.length === 0}
                className={`px-5 py-2.5 rounded-xl font-bold text-xs font-mono transition-all flex items-center gap-2 ${
                  selectedIds.length > 0
                    ? 'bg-cyan-500 hover:bg-cyan-400 text-slate-950 shadow-lg shadow-cyan-500/20'
                    : 'bg-slate-800 text-slate-600 cursor-not-allowed'
                }`}
              >
                <span>Continue to Target</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            )}

            {currentStep === 2 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  generatePlan();
                }}
                disabled={isGeneratingPlan || selectedIds.length === 0}
                className="px-5 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs font-mono transition-all flex items-center gap-2 shadow-lg shadow-cyan-500/20"
              >
                {isGeneratingPlan ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Zap className="w-4 h-4" />
                )}
                <span>Generate Plan & Review</span>
              </button>
            )}

            {currentStep === 3 && plan && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowConfirmExecuteDialog(true);
                }}
                className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs font-mono transition-all flex items-center gap-2 shadow-lg shadow-emerald-500/20"
              >
                <Zap className="w-4 h-4" />
                <span>Execute Live Pipeline</span>
              </button>
            )}
          </div>
        </div>

        {/* Confirmation Modal Overlay */}
        {showConfirmExecuteDialog && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
            onClick={(e) => {
              e.stopPropagation();
              setShowConfirmExecuteDialog(false);
            }}
          >
            <div
              className="w-full max-w-md bg-[#0d121f] border border-cyan-500/40 rounded-2xl p-6 shadow-2xl space-y-4 font-mono text-slate-200"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start gap-3">
                <div className="p-3 rounded-xl bg-cyan-950 border border-cyan-500/40 text-cyan-400 flex-shrink-0">
                  <Zap className="w-6 h-6" />
                </div>
                <div>
                  <h4 className="text-base font-bold text-white">
                    Start Execution Pipeline?
                  </h4>
                  <p className="text-xs text-slate-400 mt-1">
                    This will run the live 7-step sequence to migrate {selectedContainersList.length} service(s) into <code className="text-cyan-300 font-bold">{targetDirectory}</code> with an automatic pre-merge backup in <code className="text-purple-300">/app/backups</code>.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowConfirmExecuteDialog(false);
                  }}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs"
                >
                  Cancel
                </button>
                <button
                  onClick={(e) => triggerStreamingExecution(e)}
                  className="px-5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-2 shadow-lg shadow-emerald-500/30"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Start Pipeline</span>
                </button>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Directive 3 & 4: GitHub Actions-Style Live Execution Pipeline Console */}
      <ExecutionPipelineConsole
        isOpen={isPipelineConsoleOpen}
        onClose={() => setIsPipelineConsoleOpen(false)}
        title={
          pipelineMode === 'merge'
            ? `Pipeline: Deploying Stack "${plan?.targetStackName || targetStackName}"`
            : `Rollback: Reverting Stack to Pre-Merge State`
        }
        mode={pipelineMode}
        mergeId={pipelineMergeId}
        streamUrl={pipelineStreamUrl}
        streamPayload={pipelineStreamPayload}
        onKeepChanges={handleKeepChanges}
        onTriggerRevert={handleTriggerRevert}
        onSuccessDone={() => {
          if (onMergeSuccess) onMergeSuccess();
        }}
      />
    </div>
  );
};
