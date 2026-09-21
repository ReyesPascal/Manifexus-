import React, { useState, useEffect } from 'react';
import {
  History,
  X,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  FileCode,
  Layers,
  Calendar,
  Folder,
  Shield,
  Loader2,
  Clock,
  Wrench,
} from 'lucide-react';
import { MergeHistoryRecord } from '../../server/historyService';

interface MergeHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTriggerRevert: (record: MergeHistoryRecord) => void;
}

export const MergeHistoryModal: React.FC<MergeHistoryModalProps> = ({
  isOpen,
  onClose,
  onTriggerRevert,
}) => {
  const [records, setRecords] = useState<MergeHistoryRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<MergeHistoryRecord | null>(null);
  const [repairingId, setRepairingId] = useState<string | null>(null);
  const [repairStatus, setRepairStatus] = useState<{ id: string; message: string; success: boolean } | null>(null);

  const handleRepairStack = async (record: MergeHistoryRecord) => {
    setRepairingId(record.id);
    setRepairStatus(null);
    try {
      const candidateForeignContainer = record.affectedServices?.find((s) => s.toLowerCase().includes('kavita')) || 'kavita';
      const res = await fetch('/api/stacks/repair-conflicts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDirectory: record.targetDirectory,
          removeConflictingContainer: candidateForeignContainer,
          stripService: candidateForeignContainer,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setRepairStatus({ id: record.id, message: data.message || 'Stack repaired successfully!', success: true });
        await fetchHistory();
      } else {
        setRepairStatus({ id: record.id, message: data.error || 'Repair failed', success: false });
      }
    } catch (err) {
      setRepairStatus({ id: record.id, message: (err as Error).message, success: false });
    } finally {
      setRepairingId(null);
    }
  };

  const fetchHistory = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/history');
      if (res.ok) {
        const data = await res.json();
        setRecords(data.history || []);
      }
    } catch (err) {
      console.error('Failed to load merge history:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchHistory();
      setSelectedRecord(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-200"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="w-full max-w-4xl max-h-[85vh] flex flex-col bg-[#090d16] border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden font-mono text-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 bg-[#07090e] border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-purple-950/60 border border-purple-500/40 text-purple-400">
              <History className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                Merge State Ledger & Backups
                <span className="text-xs px-2 py-0.5 rounded bg-purple-950 border border-purple-500/30 text-purple-300">
                  Zero Data Loss
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                Persistent snapshots and audit trail stored securely in <code className="text-slate-300">/app/backups</code>.
              </p>
            </div>
          </div>

          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 text-xs">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
              <span>Loading state ledger...</span>
            </div>
          ) : records.length === 0 ? (
            <div className="text-center py-16 text-slate-500">
              <History className="w-12 h-12 mx-auto mb-3 opacity-30 text-slate-400" />
              <p className="text-sm text-slate-300 font-bold">No merge operations recorded yet</p>
              <p className="text-xs text-slate-500 mt-1">
                Every stack merge automatically records an immutable snapshot with pre-merge backup files here.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {records.map((r) => {
                const isReverted = r.status === 'reverted';
                const isActive = r.status === 'active';

                return (
                  <div
                    key={r.id}
                    className={`p-4 rounded-xl border transition-all ${
                      isReverted
                        ? 'bg-slate-900/40 border-slate-800 opacity-75'
                        : 'bg-slate-900/80 border-slate-700/80 hover:border-purple-500/40 shadow-sm'
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white text-sm">
                            {r.targetStackName}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase ${
                              isReverted
                                ? 'bg-slate-800 text-slate-400 border border-slate-700'
                                : 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                            }`}
                          >
                            {r.status}
                          </span>
                          <span className="text-[10px] text-slate-500">ID: {r.id}</span>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-400">
                          <span className="flex items-center gap-1">
                            <Folder className="w-3.5 h-3.5 text-cyan-400" />
                            {r.targetDirectory}
                          </span>
                          <span className="flex items-center gap-1">
                            <Layers className="w-3.5 h-3.5 text-purple-400" />
                            {r.sourceConfigs.length} source service(s)
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5 text-slate-500" />
                            {new Date(r.timestamp).toLocaleString()}
                          </span>
                        </div>

                        {r.backupArchiveDir && (
                          <div className="mt-2 text-[10px] text-purple-400/80">
                            Archive: <code>{r.backupArchiveDir}</code>
                          </div>
                        )}
                      </div>

                      {/* Action */}
                      <div className="flex flex-col sm:flex-row items-end sm:items-center gap-2">
                        {repairStatus && repairStatus.id === r.id && (
                          <span className={`text-[10px] px-2 py-0.5 rounded ${repairStatus.success ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40' : 'bg-rose-950 text-rose-300 border border-rose-500/40'}`}>
                            {repairStatus.message}
                          </span>
                        )}

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRepairStack(r);
                          }}
                          disabled={repairingId === r.id}
                          className="px-3 py-1.5 rounded-lg border border-cyan-500/40 bg-cyan-950/40 hover:bg-cyan-900/60 text-cyan-300 text-xs font-mono font-bold flex items-center gap-1.5 transition-all hover:shadow-[0_0_12px_rgba(6,182,212,0.2)] disabled:opacity-50"
                          title="Cleans container name conflicts, strips misplaced services, and brings stack up"
                        >
                          {repairingId === r.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                          ) : (
                            <Wrench className="w-3.5 h-3.5 text-cyan-400" />
                          )}
                          Repair Stack
                        </button>

                        {!isReverted && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onTriggerRevert(r);
                            }}
                            className="px-3 py-1.5 rounded-lg border border-rose-500/40 bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 text-xs font-mono font-bold flex items-center gap-1.5 transition-all hover:shadow-[0_0_12px_rgba(244,63,94,0.2)]"
                          >
                            <RotateCcw className="w-3.5 h-3.5 text-rose-400" />
                            Revert Stack
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-[#07090e] border-t border-slate-800 flex items-center justify-between text-slate-400 text-xs">
          <span className="flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-purple-400" />
            Automatic snapshot integrity protected
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-mono"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
