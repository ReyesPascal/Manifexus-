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
} from 'lucide-react';

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
      { index: 3, id: 'provision_directory', name: 'Directory / Snapshot Setup', status: 'pending', logs: [] },
      { index: 4, id: 'ast_synthesis', name: 'AST Synthesis & Compose Deployment', status: 'pending', logs: [] },
      { index: 5, id: 'deployment', name: 'Elevated Docker Compose Deployment', status: 'pending', logs: [] },
      { index: 6, id: 'completion', name: 'Completion & State Ledger Verification', status: 'pending', logs: [] },
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
  }) => {
    if (event.mergeId) {
      setCurrentMergeId(event.mergeId);
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
      // Directive 4: Instantly refresh fleet telemetry
      window.dispatchEvent(new CustomEvent('manifexus:refresh_fleet'));
      if (mode === 'merge' || mode === 'install') {
        // Trigger Directive 4 Post-Action Decision Prompt
        setShowDecisionPrompt(true);
      } else {
        // Revert completed
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

  // Directive 4: Decision actions
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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl max-h-[90vh] bg-[#090d16] border border-slate-700/80 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-slate-200 font-sans">
        
        {/* Console Header Bar */}
        <div className="px-6 py-4 border-b border-slate-800 bg-[#07090e] flex items-center justify-between gap-4 flex-shrink-0">
          <div className="flex items-center gap-4 min-w-0">
            <div className={`p-2.5 rounded-xl border flex-shrink-0 ${
              isFailed
                ? 'bg-rose-950/60 border-rose-500/40 text-rose-400'
                : isCompleted
                ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-400'
                : 'bg-cyan-950/60 border-cyan-500/40 text-cyan-400'
            }`}>
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
                  <span className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700/80 text-[11px] font-mono text-slate-300 font-medium tracking-wide shadow-sm flex-shrink-0">
                    ID: {currentMergeId}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 font-mono mt-1 truncate">
                {isAutoReverted
                  ? 'Pipeline failed. Automatic zero-loss rollback executed.'
                  : isFailed
                  ? 'Execution encountered a critical issue.'
                  : isCompleted
                  ? 'All sequential steps finished successfully.'
                  : 'Live GitHub Actions-style execution stream active...'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4 flex-shrink-0">
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
            <button
              onClick={onClose}
              disabled={!isCompleted && !isFailed}
              className={`px-4 py-1.5 rounded-lg text-xs font-mono font-medium border transition-all shadow-sm ${
                isCompleted || isFailed
                  ? 'bg-slate-800 hover:bg-slate-700 border-slate-600 text-white cursor-pointer hover:shadow-md'
                  : 'bg-slate-900/50 border-slate-800 text-slate-600 cursor-not-allowed'
              }`}
            >
              Close Console
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
                        <div className="text-slate-600 italic">No output logged for this step yet.</div>
                      ) : (
                        step.logs.map((logLine, idx) => (
                          <div key={idx} className="flex items-start gap-2 leading-relaxed break-all">
                            <span className="text-slate-600 select-none">$</span>
                            <span className="text-slate-300">{logLine}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Master Live Terminal Stream */}
          <div className="rounded-xl border border-slate-800 bg-[#05070a] overflow-hidden">
            <div className="px-4 py-2 bg-slate-900/80 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-400">
                <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                <span className="font-bold text-[11px] uppercase tracking-wider">Live System Stream</span>
              </div>
              <span className="text-[10px] text-slate-500">{globalLogs.length} lines logged</span>
            </div>
            <div className="p-4 max-h-56 overflow-y-auto space-y-1 text-[11px] font-mono select-text">
              {globalLogs.map((logLine, idx) => (
                <div key={idx} className="text-slate-300 leading-relaxed break-all">
                  <span className="text-cyan-600 mr-2">›</span>
                  {logLine}
                </div>
              ))}
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
                  Your services are now up and running in the target stack. You can either finalize the changes or trigger an immediate zero-loss rollback to the pre-merge snapshot.
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
  );
};
