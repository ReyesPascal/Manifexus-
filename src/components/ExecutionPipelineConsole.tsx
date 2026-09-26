import React, { useState, useEffect, useRef } from 'react';
import {
  Terminal,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  ShieldCheck,
  AlertTriangle,
  FileCode,
  Check,
  Zap,
  Eye,
  Download,
  Copy,
  Code,
  Layers,
  Search,
  X,
  FileText,
  Activity,
  ArrowRight,
  Filter,
} from 'lucide-react';
import { DiagnosticBundle, DiagnosticMicroStep } from '../types';

export interface PipelineStep {
  index: number;
  id: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  durationMs?: number;
  logs: string[];
}

interface ExecutionPipelineConsoleProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  mode: 'merge' | 'revert' | 'install';
  mergeId?: string;
  streamUrl: string;
  streamPayload: Record<string, unknown>;
  onKeepChanges?: () => void;
  onTriggerRevert?: (mergeId: string) => void;
  onSuccessDone?: () => void;
}

export const ExecutionPipelineConsole: React.FC<ExecutionPipelineConsoleProps> = ({
  isOpen,
  onClose,
  title,
  mode,
  mergeId: initialMergeId,
  streamUrl,
  streamPayload,
  onKeepChanges,
  onTriggerRevert,
  onSuccessDone,
}) => {
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [globalLogs, setGlobalLogs] = useState<string[]>([]);
  const [activeStepIndex, setActiveStepIndex] = useState<number>(1);
  const [expandedSteps, setExpandedSteps] = useState<Record<number, boolean>>({});
  const [isCompleted, setIsCompleted] = useState(false);
  const [isFailed, setIsFailed] = useState(false);
  const [isAutoReverted, setIsAutoReverted] = useState(false);
  const [currentMergeId, setCurrentMergeId] = useState<string>(initialMergeId || '');
  const [showDecisionPrompt, setShowDecisionPrompt] = useState(false);
  const [isActionPending, setIsActionPending] = useState(false);

  // Part 2 & 3: Diagnostic Bundle and Modal state
  const [diagnosticBundle, setDiagnosticBundle] = useState<DiagnosticBundle | null>(null);
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const [logModalTab, setLogModalTab] = useState<'raw' | 'ast' | 'docker' | 'microsteps'>('raw');
  const [copiedLog, setCopiedLog] = useState(false);
  const [logFilterQuery, setLogFilterQuery] = useState('');
  const [logFilterType, setLogFilterType] = useState<'all' | 'micro' | 'docker' | 'error'>('all');
  const [isDownloading, setIsDownloading] = useState(false);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Initialize steps based on mode
  useEffect(() => {
    if (!isOpen) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      return;
    }

    const defaultMergeSteps: PipelineStep[] = [
      { index: 1, id: 'preflight', name: 'Pre-Flight & AST Validation', status: 'pending', logs: [] },
      { index: 2, id: 'data_migration', name: 'Directory & Volume Data Migration', status: 'pending', logs: [] },
      { index: 3, id: 'backup_archive', name: 'Backup Creation & Archiving', status: 'pending', logs: [] },
      { index: 4, id: 'rollback_verification', name: 'Rollback Capability Verification', status: 'pending', logs: [] },
      { index: 5, id: 'ast_deployment', name: 'AST Stack Synthesis & Deployment', status: 'pending', logs: [] },
      { index: 6, id: 'cleanup_pruning', name: 'Post-Merge Cleanup & Pruning', status: 'pending', logs: [] },
      { index: 7, id: 'completion', name: 'Pipeline Completion', status: 'pending', logs: [] },
    ];

    const defaultInstallSteps: PipelineStep[] = [
      { index: 1, id: 'preflight', name: 'Pre-Flight & Remote Fetch Validation', status: 'pending', logs: [] },
      { index: 2, id: 'port_collision', name: 'Intelligent Port Collision Resolution', status: 'pending', logs: [] },
      { index: 3, id: 'provision_directory', name: 'Directory Provisioning & Snapshot Setup', status: 'pending', logs: [] },
      { index: 4, id: 'ast_synthesis', name: 'Build Context & AST Synthesis Injection', status: 'pending', logs: [] },
      { index: 5, id: 'deployment', name: 'Elevated Docker Compose Deployment', status: 'pending', logs: [] },
      { index: 6, id: 'completion', name: 'Socket Health Audit & Ledger Verification', status: 'pending', logs: [] },
    ];

    const defaultRevertSteps: PipelineStep[] = [
      { index: 1, id: 'stop_merged', name: 'Halting Merged Services', status: 'pending', logs: [] },
      { index: 2, id: 'restore_compose', name: 'Restoring Target Compose Backup', status: 'pending', logs: [] },
      { index: 3, id: 'restart_standalone', name: 'Re-Activating Standalone Source Stacks', status: 'pending', logs: [] },
      { index: 4, id: 'cleanup_partial', name: 'Pruning Partial Merge State & Volumes', status: 'pending', logs: [] },
      { index: 5, id: 'revert_complete', name: 'Rollback Complete & Ledger Verified', status: 'pending', logs: [] },
    ];

    let initialSteps: PipelineStep[];
    if (mode === 'merge') initialSteps = defaultMergeSteps;
    else if (mode === 'install') initialSteps = defaultInstallSteps;
    else initialSteps = defaultRevertSteps;

    setSteps(initialSteps);
    setGlobalLogs([]);
    setIsCompleted(false);
    setIsFailed(false);
    setIsAutoReverted(false);
    setShowDecisionPrompt(false);
    setIsActionPending(false);
    setDiagnosticBundle(null);
    setIsLogModalOpen(false);

    // Expand step 1 by default
    setExpandedSteps({ 1: true });

    // Start SSE Stream
    const controller = new AbortController();
    abortControllerRef.current = controller;

    async function startStream() {
      try {
        const res = await fetch(streamUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(streamPayload),
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`Server returned HTTP ${res.status}`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error('Readable stream not supported');

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.replace(/^data: /, '').trim();
              if (!dataStr) continue;

              try {
                const event = JSON.parse(dataStr);
                handleStreamEvent(event);
              } catch (parseErr) {
                console.warn('[SSE Parse Error]', parseErr, dataStr);
              }
            }
          }
        }
      } catch (streamErr) {
        if ((streamErr as Error).name !== 'AbortError') {
          console.error('[Pipeline Stream Error]', streamErr);
          setIsFailed(true);
          setGlobalLogs((prev) => [...prev, `CRITICAL STREAM ERROR: ${(streamErr as Error).message}`]);
        }
      }
    }

    startStream();

    return () => {
      controller.abort();
    };
  }, [isOpen, streamUrl, mode]);

  // Handle individual SSE stream events
  const handleStreamEvent = (event: {
    type: string;
    mergeId?: string;
    stepIndex?: number;
    stepId?: string;
    stepName?: string;
    status?: PipelineStep['status'];
    durationMs?: number;
    log?: string;
    bundle?: DiagnosticBundle;
    payload?: Record<string, unknown>;
  }) => {
    if (event.mergeId) {
      setCurrentMergeId(event.mergeId);
    }

    if (event.bundle) {
      setDiagnosticBundle(event.bundle);
    } else if (event.payload?.diagnosticBundle) {
      setDiagnosticBundle(event.payload.diagnosticBundle as DiagnosticBundle);
    }

    if (event.type === 'log' && event.log) {
      setGlobalLogs((prev) => [...prev, event.log!]);
      if (event.stepIndex) {
        setSteps((prev) =>
          prev.map((s) => (s.index === event.stepIndex ? { ...s, logs: [...s.logs, event.log!] } : s))
        );
      }
    } else if (event.type === 'step_update' && event.stepIndex) {
      setActiveStepIndex(event.stepIndex);
      setSteps((prev) =>
        prev.map((s) => {
          if (s.index === event.stepIndex) {
            return {
              ...s,
              name: event.stepName || s.name,
              status: event.status || s.status,
              durationMs: event.durationMs !== undefined ? event.durationMs : s.durationMs,
            };
          }
          return s;
        })
      );

      // Auto-expand currently running step
      if (event.status === 'running') {
        setExpandedSteps((prev) => ({ ...prev, [event.stepIndex!]: true }));
      }
    } else if (event.type === 'completed' || event.type === 'done') {
      setIsCompleted(true);
      window.dispatchEvent(new CustomEvent('manifexus:refresh_fleet'));
      if (mode === 'merge' || mode === 'install') {
        setShowDecisionPrompt(true);
      } else {
        if (onSuccessDone) onSuccessDone();
      }
    } else if (event.type === 'auto_reverted') {
      setIsFailed(true);
      setIsAutoReverted(true);
      window.dispatchEvent(new CustomEvent('manifexus:refresh_fleet'));
      if (event.log) {
        setGlobalLogs((prev) => [...prev, `[Auto-Reverted] ${event.log}`]);
      }
    } else if (event.type === 'failed' || event.type === 'error') {
      setIsFailed(true);
      window.dispatchEvent(new CustomEvent('manifexus:refresh_fleet'));
      const errMsg = event.log || (event as any).error;
      if (errMsg) {
        setGlobalLogs((prev) => [...prev, `[Failed] ${errMsg}`]);
      }
      if (event.stepIndex) {
        setExpandedSteps((prev) => ({ ...prev, [event.stepIndex!]: true }));
      }
    }
  };

  // Scroll to bottom when logs update
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [globalLogs]);

  const toggleStepExpand = (index: number) => {
    setExpandedSteps((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  // Retrieve or compile the DiagnosticBundle for viewing or downloading
  const fetchOrCompileDiagnosticBundle = async (): Promise<DiagnosticBundle> => {
    if (diagnosticBundle) return diagnosticBundle;

    // Attempt to fetch from server if mergeId is present
    if (currentMergeId) {
      try {
        const res = await fetch(`/api/compose/diagnostics/${encodeURIComponent(currentMergeId)}`);
        if (res.ok) {
          const fetched = await res.json();
          setDiagnosticBundle(fetched);
          return fetched;
        }
      } catch {
        // Fallback to synthesizing bundle from current execution state
      }
    }

    // Synthesize bundle from client execution state
    const synthesized: DiagnosticBundle = {
      installId: currentMergeId || `bundle_${Date.now()}`,
      timestamp: new Date().toISOString(),
      deploymentType: (streamPayload.installMode as any) || 'new-stack',
      targetStackName: (streamPayload.targetStackName as string) || 'unknown',
      targetPath: (streamPayload.targetDirectory as string) || 'unknown',
      sourceUrl: (streamPayload.sourceUrl as string) || '',
      initialAstSnapshot: null,
      fetchedRemoteAst: null,
      finalMergedAst: null,
      fileWriteBytes: undefined,
      dockerExecutionCommand: undefined,
      cwd: (streamPayload.targetDirectory as string) || '',
      stdout: undefined,
      stderr: undefined,
      exitCode: isCompleted ? 0 : isFailed ? 1 : undefined,
      success: isCompleted && !isFailed,
      errorStackTrace: isFailed ? globalLogs.filter((l) => l.includes('FAIL') || l.includes('error')).join('\n') : null,
      microSteps: steps.map((s) => ({
        stepIndex: s.index,
        stepId: s.id,
        stepName: s.name,
        status: s.status,
        timestamp: new Date().toISOString(),
        durationMs: s.durationMs,
        logs: s.logs,
      })),
      systemEnvironment: {
        nodeEnv: 'production',
        dockerSocket: '/var/run/docker.sock',
        hostRoot: '/host',
        logsDir: '/app/logs',
        platform: 'linux',
      },
    };

    setDiagnosticBundle(synthesized);
    return synthesized;
  };

  // Part 3, Item 3: View Log Handler
  const handleOpenLogModal = async () => {
    await fetchOrCompileDiagnosticBundle();
    setIsLogModalOpen(true);
  };

  // Part 3, Item 4: Export Log Handler
  const handleExportLog = async () => {
    setIsDownloading(true);
    try {
      const bundle = await fetchOrCompileDiagnosticBundle();
      const jsonString = JSON.stringify(bundle, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `diagnostic-bundle-${bundle.installId || 'execution'}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[Export Log Error]', err);
    } finally {
      setIsDownloading(false);
    }
  };

  // Copy bundle JSON to clipboard
  const handleCopyBundleJson = () => {
    if (!diagnosticBundle) return;
    navigator.clipboard.writeText(JSON.stringify(diagnosticBundle, null, 2));
    setCopiedLog(true);
    setTimeout(() => setCopiedLog(false), 2000);
  };

  // Decision actions
  const handleKeepChangesClick = async () => {
    if (!currentMergeId) {
      if (onKeepChanges) onKeepChanges();
      onClose();
      return;
    }
    setIsActionPending(true);
    try {
      await fetch(`/api/history/${currentMergeId}/keep`, { method: 'POST' });
      if (onKeepChanges) onKeepChanges();
      onClose();
    } catch (err) {
      console.error(err);
      onClose();
    } finally {
      setIsActionPending(false);
    }
  };

  const handleRevertClick = () => {
    if (onTriggerRevert && currentMergeId) {
      onTriggerRevert(currentMergeId);
    }
  };

  // Granular log filtering
  const filteredLogs = globalLogs.filter((logLine) => {
    if (logFilterType === 'micro' && !logLine.includes('[Micro-Step')) return false;
    if (logFilterType === 'docker' && !logLine.toLowerCase().includes('docker')) return false;
    if (logFilterType === 'error' && !/(error|failed|fatal|critical|died|exit)/i.test(logLine)) return false;
    if (logFilterQuery.trim() && !logLine.toLowerCase().includes(logFilterQuery.toLowerCase())) return false;
    return true;
  });

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
        <div className="relative w-full max-w-4xl max-h-[90vh] bg-[#090d16] border border-slate-700/80 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-slate-200 font-sans">
          
          {/* Console Header Bar */}
          <div className="px-6 py-4 border-b border-slate-800 bg-[#07090e] flex items-center justify-between gap-4 flex-shrink-0">
            <div className="flex items-center gap-4 min-w-0">
              <div
                className={`p-2.5 rounded-xl border flex-shrink-0 ${
                  isFailed
                    ? 'bg-rose-950/60 border-rose-500/40 text-rose-400'
                    : isCompleted
                    ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-400'
                    : 'bg-cyan-950/60 border-cyan-500/40 text-cyan-400'
                }`}
              >
                {isFailed ? (
                  <XCircle className="w-5 h-5" />
                ) : isCompleted ? (
                  <CheckCircle2 className="w-5 h-5" />
                ) : (
                  <Loader2 className="w-5 h-5 animate-spin" />
                )}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-base font-bold font-mono tracking-tight text-white flex items-center gap-2 truncate">
                    {title}
                  </h3>
                  {currentMergeId && (
                    <span className="px-3 py-1 rounded-lg bg-slate-900 border border-slate-700/80 text-[11px] font-mono text-cyan-300 font-medium tracking-wide shadow-sm flex-shrink-0">
                      ID: {currentMergeId}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 font-mono mt-1 truncate">
                  {isAutoReverted
                    ? 'Pipeline failed. Automatic zero-loss rollback executed.'
                    : isFailed
                    ? 'Execution encountered a critical issue. Full diagnostics captured.'
                    : isCompleted
                    ? 'All sequential micro-steps finished with 100% verified success.'
                    : 'Granular execution stream active with micro-step tracking...'}
                </p>
              </div>
            </div>

            {/* Part 3, Item 2: Header action buttons immediately to the left of the Failed/Success status badge */}
            <div className="flex items-center gap-3 flex-shrink-0">
              {/* Button 1: View Log */}
              <button
                onClick={handleOpenLogModal}
                title="Open formatted JSON DiagnosticBundle inspection overlay"
                className="px-3 py-1.5 rounded-lg text-xs font-mono font-medium border border-cyan-500/40 bg-cyan-950/40 hover:bg-cyan-900/60 text-cyan-300 transition-all flex items-center gap-1.5 shadow-sm hover:shadow-[0_0_12px_rgba(6,182,212,0.25)] active:scale-95 cursor-pointer"
              >
                <Eye className="w-3.5 h-3.5" />
                <span>View Log</span>
              </button>

              {/* Button 2: Export Log */}
              <button
                onClick={handleExportLog}
                disabled={isDownloading}
                title="Download complete diagnostic bundle as JSON file"
                className="px-3 py-1.5 rounded-lg text-xs font-mono font-medium border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-200 transition-all flex items-center gap-1.5 shadow-sm hover:shadow-md active:scale-95 cursor-pointer disabled:opacity-50"
              >
                {isDownloading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                <span>Export Log</span>
              </button>

              {/* Status Badge */}
              {!isCompleted && !isFailed && (
                <span className="px-3 py-1.5 rounded-full text-xs font-mono font-medium tracking-wide bg-cyan-950/80 border border-cyan-500/40 text-cyan-300 flex items-center gap-2 shadow-sm animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
                  RUNNING
                </span>
              )}
              {isCompleted && (
                <span className="px-3 py-1.5 rounded-full text-xs font-mono font-medium tracking-wide bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 flex items-center gap-2 shadow-sm">
                  <Check className="w-3.5 h-3.5" />
                  FINISHED
                </span>
              )}
              {isFailed && (
                <span className="px-3 py-1.5 rounded-full text-xs font-mono font-medium tracking-wide bg-rose-950/80 border border-rose-500/40 text-rose-300 flex items-center gap-2 shadow-sm">
                  <XCircle className="w-3.5 h-3.5" />
                  FAILED
                </span>
              )}

              {/* Close Console Button */}
              <button
                onClick={onClose}
                disabled={!isCompleted && !isFailed}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium border transition-all shadow-sm ${
                  isCompleted || isFailed
                    ? 'bg-slate-800 hover:bg-slate-700 border-slate-600 text-white cursor-pointer hover:shadow-md'
                    : 'bg-slate-900/50 border-slate-800 text-slate-600 cursor-not-allowed'
                }`}
              >
                Close
              </button>
            </div>
          </div>

          {/* Pipeline Content Body */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4 font-mono text-xs">
            
            {/* Step Sequence List */}
            <div className="space-y-2">
              {steps.map((step) => {
                const isExpanded = expandedSteps[step.index];
                return (
                  <div
                    key={step.id}
                    className={`rounded-xl border transition-all overflow-hidden ${
                      step.status === 'running'
                        ? 'border-cyan-500/50 bg-cyan-950/20 shadow-md'
                        : step.status === 'success'
                        ? 'border-slate-800 bg-slate-900/40'
                        : step.status === 'failed'
                        ? 'border-rose-500/50 bg-rose-950/20'
                        : 'border-slate-800/60 bg-slate-950/30 text-slate-500'
                    }`}
                  >
                    {/* Step Header */}
                    <div
                      onClick={() => toggleStepExpand(step.index)}
                      className="px-4 py-3 flex items-center justify-between cursor-pointer select-none hover:bg-slate-800/30 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-slate-400" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-slate-400" />
                        )}

                        <div className="flex items-center gap-2">
                          {step.status === 'pending' && (
                            <span className="w-4 h-4 rounded-full border border-slate-600 text-[10px] flex items-center justify-center text-slate-500">
                              {step.index}
                            </span>
                          )}
                          {step.status === 'running' && (
                            <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />
                          )}
                          {step.status === 'success' && (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          )}
                          {step.status === 'failed' && (
                            <XCircle className="w-4 h-4 text-rose-400" />
                          )}

                          <span
                            className={`font-semibold ${
                              step.status === 'running'
                                ? 'text-cyan-300'
                                : step.status === 'success'
                                ? 'text-white'
                                : step.status === 'failed'
                                ? 'text-rose-300'
                                : 'text-slate-500'
                            }`}
                          >
                            Step {step.index}: {step.name}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        {step.durationMs !== undefined && (
                          <span className="text-[11px] text-slate-400 flex items-center gap-1 font-mono">
                            <Clock className="w-3 h-3 text-slate-500" />
                            {(step.durationMs / 1000).toFixed(2)}s
                          </span>
                        )}
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded font-mono uppercase ${
                            step.status === 'running'
                              ? 'bg-cyan-950 text-cyan-300 border border-cyan-500/40 animate-pulse'
                              : step.status === 'success'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30'
                              : step.status === 'failed'
                              ? 'bg-rose-950 text-rose-300 border border-rose-500/30'
                              : 'bg-slate-900 text-slate-600'
                          }`}
                        >
                          {step.status}
                        </span>
                      </div>
                    </div>

                    {/* Collapsible Step Terminal Logs */}
                    {isExpanded && (
                      <div className="px-4 py-3 bg-[#05070a] border-t border-slate-800 text-[11px] font-mono text-slate-300 space-y-1">
                        {step.logs.length === 0 ? (
                          <div className="text-slate-600 italic">No micro-step logs recorded for this stage yet.</div>
                        ) : (
                          step.logs.map((logLine, idx) => {
                            const isMicroStep = logLine.includes('[Micro-Step');
                            const isDocker = logLine.includes('[docker]');
                            const isError = /(error|failed|fatal|died|exit)/i.test(logLine);
                            return (
                              <div key={idx} className="flex items-start gap-2 leading-relaxed break-all">
                                <span className={`select-none ${isError ? 'text-rose-500' : isMicroStep ? 'text-cyan-400' : isDocker ? 'text-amber-400' : 'text-slate-600'}`}>
                                  {isMicroStep ? '✦' : '$'}
                                </span>
                                <span className={isError ? 'text-rose-300 font-bold' : isMicroStep ? 'text-cyan-200' : isDocker ? 'text-amber-200' : 'text-slate-300'}>
                                  {logLine}
                                </span>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Part 3, Item 1: Granular Live Stream Master Terminal */}
            <div className="rounded-xl border border-slate-800 bg-[#05070a] overflow-hidden shadow-inner">
              <div className="px-4 py-2.5 bg-slate-900/90 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 text-slate-300">
                    <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                    <span className="font-bold text-[11px] uppercase tracking-wider">Granular Execution Stream</span>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-slate-800 text-[10px] text-slate-400 font-mono">
                    {filteredLogs.length} / {globalLogs.length} events
                  </span>
                </div>

                {/* Stream Controls & Filter Chips */}
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="w-3 h-3 absolute left-2 top-2 text-slate-500" />
                    <input
                      type="text"
                      placeholder="Search live stream..."
                      value={logFilterQuery}
                      onChange={(e) => setLogFilterQuery(e.target.value)}
                      className="pl-7 pr-2 py-1 bg-slate-950 border border-slate-800 rounded text-[10px] text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan-500/50 w-36"
                    />
                    {logFilterQuery && (
                      <button
                        onClick={() => setLogFilterQuery('')}
                        className="absolute right-1.5 top-1.5 text-slate-500 hover:text-slate-300"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1 bg-slate-950 p-0.5 rounded border border-slate-800 text-[10px]">
                    <button
                      onClick={() => setLogFilterType('all')}
                      className={`px-2 py-0.5 rounded ${logFilterType === 'all' ? 'bg-cyan-900/80 text-cyan-200' : 'text-slate-400 hover:text-white'}`}
                    >
                      All
                    </button>
                    <button
                      onClick={() => setLogFilterType('micro')}
                      className={`px-2 py-0.5 rounded ${logFilterType === 'micro' ? 'bg-cyan-900/80 text-cyan-200' : 'text-slate-400 hover:text-white'}`}
                    >
                      Micro-Steps
                    </button>
                    <button
                      onClick={() => setLogFilterType('docker')}
                      className={`px-2 py-0.5 rounded ${logFilterType === 'docker' ? 'bg-amber-900/80 text-amber-200' : 'text-slate-400 hover:text-white'}`}
                    >
                      Docker CLI
                    </button>
                    <button
                      onClick={() => setLogFilterType('error')}
                      className={`px-2 py-0.5 rounded ${logFilterType === 'error' ? 'bg-rose-900/80 text-rose-200' : 'text-slate-400 hover:text-white'}`}
                    >
                      Errors
                    </button>
                  </div>
                </div>
              </div>

              {/* Master Terminal Stream Lines */}
              <div className="p-4 max-h-64 overflow-y-auto space-y-1.5 text-[11px] font-mono select-text bg-[#030508]">
                {filteredLogs.length === 0 ? (
                  <div className="text-slate-600 italic py-4 text-center">
                    {globalLogs.length === 0
                      ? 'Awaiting pipeline initialization stream...'
                      : 'No log lines matched the active filter criteria.'}
                  </div>
                ) : (
                  filteredLogs.map((logLine, idx) => {
                    const isMicro = logLine.includes('[Micro-Step');
                    const isDocker = logLine.includes('[docker');
                    const isErr = /(error|failed|fatal|critical|died|exit)/i.test(logLine);
                    const isSuccess = /(success|synchronized|verified|complete)/i.test(logLine);

                    return (
                      <div key={idx} className="flex items-start gap-2 leading-relaxed break-all hover:bg-slate-900/40 px-1 py-0.5 rounded transition-colors">
                        <span className="text-slate-600 text-[10px] w-6 text-right select-none font-sans">
                          {idx + 1}
                        </span>
                        <span
                          className={`select-none font-bold ${
                            isErr
                              ? 'text-rose-400'
                              : isMicro
                              ? 'text-cyan-400'
                              : isDocker
                              ? 'text-amber-400'
                              : isSuccess
                              ? 'text-emerald-400'
                              : 'text-slate-500'
                          }`}
                        >
                          ›
                        </span>
                        <span
                          className={
                            isErr
                              ? 'text-rose-300 font-semibold'
                              : isMicro
                              ? 'text-cyan-200 font-medium'
                              : isDocker
                              ? 'text-amber-200'
                              : isSuccess
                              ? 'text-emerald-200'
                              : 'text-slate-300'
                          }
                        >
                          {logLine}
                        </span>
                      </div>
                    );
                  })
                )}
                <div ref={logsEndRef} />
              </div>
            </div>
          </div>

          {/* Directive 4: Post-Merge Decision Prompt Overlay */}
          {showDecisionPrompt && mode === 'merge' && (
            <div className="p-5 border-t border-cyan-500/40 bg-gradient-to-b from-[#090f1d] to-[#060a14] flex flex-col sm:flex-row items-center justify-between gap-4 animate-in slide-in-from-bottom-3 duration-300">
              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-xl bg-cyan-950 border border-cyan-500/40 text-cyan-300 flex-shrink-0">
                  <ShieldCheck className="w-5 h-5 text-cyan-400" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-white flex items-center gap-2">
                    Pipeline Completed: Confirm Stack State
                    <span className="text-xs font-normal text-cyan-300 bg-cyan-950/80 px-2 py-0.5 rounded border border-cyan-500/30">
                      Awaiting Decision
                    </span>
                  </h4>
                  <p className="text-xs text-slate-400 mt-1">
                    Your services are now up and running in the target stack. You can finalize the changes or trigger an immediate zero-loss rollback to the pre-merge snapshot.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 flex-shrink-0 w-full sm:w-auto">
                <button
                  onClick={handleRevertClick}
                  disabled={isActionPending}
                  className="flex-1 sm:flex-initial px-4 py-2.5 rounded-xl border border-rose-500/40 bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 text-xs font-bold font-mono transition-all flex items-center justify-center gap-2 hover:shadow-[0_0_15px_rgba(244,63,94,0.2)]"
                >
                  <RotateCcw className="w-4 h-4 text-rose-400" />
                  Revert to Pre-Merge
                </button>

                <button
                  onClick={handleKeepChangesClick}
                  disabled={isActionPending}
                  className="flex-1 sm:flex-initial px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold font-mono transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:scale-[1.02] active:scale-95"
                >
                  {isActionPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4" />
                  )}
                  Keep Changes & Finish
                </button>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* Part 3, Item 3: View Log Modal - Wide, Dark-Mode Overlay Displaying raw formatted JSON DiagnosticBundle */}
      {isLogModalOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/90 backdrop-blur-lg animate-in fade-in duration-200">
          <div className="relative w-full max-w-6xl max-h-[92vh] bg-[#070b12] border border-cyan-500/40 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-slate-200 font-mono">
            
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-800 bg-[#04070d] flex items-center justify-between gap-4 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-cyan-950 border border-cyan-500/40 text-cyan-400">
                  <FileCode className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-3">
                    <h3 className="text-base font-bold text-white tracking-tight">
                      Enterprise Diagnostic Bundle
                    </h3>
                    <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase ${
                      diagnosticBundle?.success
                        ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                        : isFailed || diagnosticBundle?.success === false
                        ? 'bg-rose-950 text-rose-300 border border-rose-500/40'
                        : 'bg-cyan-950 text-cyan-300 border border-cyan-500/40'
                    }`}>
                      {diagnosticBundle?.success ? 'Success' : isFailed || diagnosticBundle?.success === false ? 'Failed' : 'In Progress'}
                    </span>
                    {diagnosticBundle?.deploymentType && (
                      <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-[11px] text-slate-400">
                        Mode: {diagnosticBundle.deploymentType}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Target: {diagnosticBundle?.targetPath || 'N/A'} • Timestamp: {diagnosticBundle?.timestamp || new Date().toISOString()}
                  </p>
                </div>
              </div>

              {/* Action Buttons inside Modal */}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCopyBundleJson}
                  className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs flex items-center gap-1.5 transition-colors"
                >
                  {copiedLog ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedLog ? 'Copied JSON!' : 'Copy JSON'}</span>
                </button>

                <button
                  onClick={handleExportLog}
                  className="px-3 py-1.5 rounded-lg border border-cyan-500/40 bg-cyan-950 hover:bg-cyan-900 text-cyan-300 text-xs flex items-center gap-1.5 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download .json</span>
                </button>

                <button
                  onClick={() => setIsLogModalOpen(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors ml-2"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Navigation Tabs */}
            <div className="px-6 py-2 bg-slate-900/60 border-b border-slate-800 flex items-center gap-2 flex-shrink-0 text-xs">
              <button
                onClick={() => setLogModalTab('raw')}
                className={`px-3 py-1.5 rounded-lg flex items-center gap-2 font-medium transition-colors ${
                  logModalTab === 'raw'
                    ? 'bg-cyan-950 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                }`}
              >
                <Code className="w-3.5 h-3.5" />
                <span>Raw Diagnostic JSON</span>
              </button>

              <button
                onClick={() => setLogModalTab('ast')}
                className={`px-3 py-1.5 rounded-lg flex items-center gap-2 font-medium transition-colors ${
                  logModalTab === 'ast'
                    ? 'bg-cyan-950 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>AST Snapshots (Before & After)</span>
              </button>

              <button
                onClick={() => setLogModalTab('docker')}
                className={`px-3 py-1.5 rounded-lg flex items-center gap-2 font-medium transition-colors ${
                  logModalTab === 'docker'
                    ? 'bg-cyan-950 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>Docker CLI Execution</span>
              </button>

              <button
                onClick={() => setLogModalTab('microsteps')}
                className={`px-3 py-1.5 rounded-lg flex items-center gap-2 font-medium transition-colors ${
                  logModalTab === 'microsteps'
                    ? 'bg-cyan-950 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                }`}
              >
                <Activity className="w-3.5 h-3.5" />
                <span>Micro-Steps Ledger ({diagnosticBundle?.microSteps?.length || 0})</span>
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6 bg-[#04060a]">
              {/* Tab 1: Raw Formatted JSON Viewer */}
              {logModalTab === 'raw' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Complete serialized DiagnosticBundle JSON representation:</span>
                    <span className="text-cyan-400">
                      Bytes: {Buffer.byteLength(JSON.stringify(diagnosticBundle || {}), 'utf-8')} B
                    </span>
                  </div>
                  <pre className="p-4 rounded-xl bg-[#020306] border border-slate-800 text-xs font-mono text-emerald-400 overflow-x-auto whitespace-pre leading-relaxed select-text shadow-inner">
                    {JSON.stringify(diagnosticBundle, null, 2)}
                  </pre>
                </div>
              )}

              {/* Tab 2: AST State Diff & Inspector */}
              {logModalTab === 'ast' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    {/* Initial AST */}
                    <div className="rounded-xl border border-slate-800 bg-[#080c14] overflow-hidden flex flex-col">
                      <div className="px-4 py-2.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
                        <span className="font-bold text-slate-300 text-xs flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-blue-400"></span>
                          Initial AST Snapshot
                        </span>
                        <span className="text-[10px] text-slate-500">Pre-Merge State</span>
                      </div>
                      <div className="p-3 flex-1 overflow-x-auto max-h-96">
                        <pre className="text-[11px] font-mono text-blue-300 whitespace-pre">
                          {diagnosticBundle?.initialAstSnapshot
                            ? JSON.stringify(diagnosticBundle.initialAstSnapshot, null, 2)
                            : '// No pre-merge AST (New Stack mode or Fallback applied)'}
                        </pre>
                      </div>
                    </div>

                    {/* Fetched Remote AST */}
                    <div className="rounded-xl border border-slate-800 bg-[#080c14] overflow-hidden flex flex-col">
                      <div className="px-4 py-2.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
                        <span className="font-bold text-slate-300 text-xs flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-purple-400"></span>
                          Fetched Remote AST
                        </span>
                        <span className="text-[10px] text-slate-500">Incoming Services</span>
                      </div>
                      <div className="p-3 flex-1 overflow-x-auto max-h-96">
                        <pre className="text-[11px] font-mono text-purple-300 whitespace-pre">
                          {diagnosticBundle?.fetchedRemoteAst
                            ? JSON.stringify(diagnosticBundle.fetchedRemoteAst, null, 2)
                            : '// Remote AST not captured'}
                        </pre>
                      </div>
                    </div>

                    {/* Final Merged AST */}
                    <div className="rounded-xl border border-slate-800 bg-[#080c14] overflow-hidden flex flex-col">
                      <div className="px-4 py-2.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
                        <span className="font-bold text-slate-300 text-xs flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                          Final Merged AST
                        </span>
                        <span className="text-[10px] text-emerald-400">
                          {diagnosticBundle?.fileWriteBytes ? `${diagnosticBundle.fileWriteBytes} bytes` : 'Target'}
                        </span>
                      </div>
                      <div className="p-3 flex-1 overflow-x-auto max-h-96">
                        <pre className="text-[11px] font-mono text-emerald-300 whitespace-pre">
                          {diagnosticBundle?.finalMergedAst
                            ? JSON.stringify(diagnosticBundle.finalMergedAst, null, 2)
                            : '// Final AST not generated'}
                        </pre>
                      </div>
                    </div>
                  </div>

                  {/* AST Mutation Summary */}
                  <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/40 text-xs space-y-2">
                    <h4 className="font-bold text-white flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      Zero-Byte Safety & AST Verification Details
                    </h4>
                    <p className="text-slate-400 leading-relaxed">
                      Written File: <code className="text-cyan-300">{diagnosticBundle?.targetComposePath || 'N/A'}</code>
                      {' • '}
                      Synchronized File Size: <span className="font-bold text-white">{diagnosticBundle?.fileWriteBytes || 0} bytes</span>.
                      Safe fallback guarantees baseline AST initialization if reading the original target file fails. Strict stringification verifies output length prior to host file writing.
                    </p>
                  </div>
                </div>
              )}

              {/* Tab 3: Docker Execution Command & Outputs */}
              {logModalTab === 'docker' && (
                <div className="space-y-4">
                  <div className="p-4 rounded-xl border border-slate-800 bg-[#060a12] space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-300">Docker Command Executed:</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                        diagnosticBundle?.exitCode === 0
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                          : 'bg-rose-950 text-rose-300 border border-rose-500/40'
                      }`}>
                        Exit Code: {diagnosticBundle?.exitCode ?? 'N/A'}
                      </span>
                    </div>
                    <div className="p-3 rounded-lg bg-black font-mono text-xs text-cyan-300 break-all border border-slate-800">
                      $ {diagnosticBundle?.dockerExecutionCommand || 'docker compose -f <target> up -d --build --remove-orphans'}
                    </div>
                    <div className="text-xs text-slate-400">
                      Working Directory (CWD): <code className="text-slate-300">{diagnosticBundle?.cwd || 'N/A'}</code>
                    </div>
                  </div>

                  {/* STDOUT */}
                  <div className="rounded-xl border border-slate-800 bg-[#060a12] overflow-hidden">
                    <div className="px-4 py-2 bg-slate-900 border-b border-slate-800 text-xs font-bold text-slate-300">
                      Standard Output (stdout)
                    </div>
                    <div className="p-3 max-h-52 overflow-y-auto">
                      <pre className="text-xs font-mono text-slate-300 whitespace-pre-wrap">
                        {diagnosticBundle?.stdout || '// No standard output recorded'}
                      </pre>
                    </div>
                  </div>

                  {/* STDERR */}
                  <div className="rounded-xl border border-slate-800 bg-[#060a12] overflow-hidden">
                    <div className="px-4 py-2 bg-slate-900 border-b border-slate-800 text-xs font-bold text-rose-400">
                      Standard Error (stderr)
                    </div>
                    <div className="p-3 max-h-52 overflow-y-auto">
                      <pre className="text-xs font-mono text-rose-300 whitespace-pre-wrap">
                        {diagnosticBundle?.stderr || '// Zero standard error output'}
                      </pre>
                    </div>
                  </div>

                  {/* Error Stack Trace if any */}
                  {diagnosticBundle?.errorStackTrace && (
                    <div className="rounded-xl border border-rose-500/40 bg-rose-950/20 overflow-hidden">
                      <div className="px-4 py-2 bg-rose-950/60 border-b border-rose-500/40 text-xs font-bold text-rose-300 flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-rose-400" />
                        Critical Failure Stack Trace
                      </div>
                      <div className="p-3 max-h-60 overflow-y-auto">
                        <pre className="text-xs font-mono text-rose-200 whitespace-pre-wrap leading-relaxed">
                          {diagnosticBundle.errorStackTrace}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 4: Micro-Steps Detailed Ledger */}
              {logModalTab === 'microsteps' && (
                <div className="space-y-3">
                  <div className="text-xs text-slate-400">
                    Granular execution chronicle ({diagnosticBundle?.microSteps?.length || 0} micro-steps logged):
                  </div>
                  <div className="space-y-2">
                    {diagnosticBundle?.microSteps?.map((ms, idx) => (
                      <div
                        key={idx}
                        className="p-3 rounded-xl border border-slate-800 bg-[#060a12] space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 rounded bg-slate-800 text-[10px] text-slate-400 font-mono">
                              Step {ms.stepIndex}
                            </span>
                            <span className="font-bold text-white text-xs">{ms.stepName}</span>
                          </div>
                          <div className="flex items-center gap-2 text-[10px]">
                            {ms.durationMs !== undefined && (
                              <span className="text-slate-400 font-mono">
                                {(ms.durationMs / 1000).toFixed(2)}s
                              </span>
                            )}
                            <span className={`px-2 py-0.5 rounded font-mono uppercase font-bold ${
                              ms.status === 'success'
                                ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                                : ms.status === 'failed'
                                ? 'bg-rose-950 text-rose-300 border border-rose-500/40'
                                : 'bg-cyan-950 text-cyan-300 border border-cyan-500/40'
                            }`}>
                              {ms.status}
                            </span>
                          </div>
                        </div>

                        {ms.logs && ms.logs.length > 0 && (
                          <div className="p-2.5 rounded-lg bg-black/60 font-mono text-[11px] text-slate-300 space-y-1">
                            {ms.logs.map((l, lIdx) => (
                              <div key={lIdx} className="leading-relaxed">
                                <span className="text-slate-600 mr-2">›</span>
                                {l}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 border-t border-slate-800 bg-[#04070d] flex items-center justify-between text-xs text-slate-500">
              <div>
                Diagnostic Log Directory: <code className="text-slate-400">/app/logs/diagnostics/</code>
              </div>
              <button
                onClick={() => setIsLogModalOpen(false)}
                className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-mono text-xs transition-colors"
              >
                Close Inspector
              </button>
            </div>

          </div>
        </div>
      )}
    </>
  );
};
