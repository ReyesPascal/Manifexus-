import React, { useState, useEffect, useMemo } from 'react';
import {
  ScrollText,
  X,
  Search,
  RefreshCw,
  Trash2,
  Filter,
  Calendar,
  AlertCircle,
  AlertTriangle,
  Info,
  GitBranch,
  Layers,
  CheckCircle2,
  Copy,
  Download,
  ChevronDown,
  Terminal,
} from 'lucide-react';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'PIPELINE';
export type LogCategory = 'api' | 'ast' | 'pipeline' | 'docker' | 'system';

export interface SystemLogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  details?: Record<string, unknown> | string;
}

interface SystemLogsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SystemLogsModal: React.FC<SystemLogsModalProps> = ({ isOpen, onClose }) => {
  const [logs, setLogs] = useState<SystemLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logFilePath, setLogFilePath] = useState<string>('/app/logs/system-audit.jsonl');

  // Filter states
  const [activeFilter, setActiveFilter] = useState<'all' | 'errors' | 'pipelines' | 'docker'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dateRange, setDateRange] = useState<'today' | '7days' | 'all'>('all');
  const [showPruneMenu, setShowPruneMenu] = useState(false);
  const [pruneSuccess, setPruneSuccess] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (activeFilter !== 'all') params.append('category', activeFilter);
      if (searchQuery.trim()) params.append('search', searchQuery.trim());
      if (dateRange !== 'all') params.append('range', dateRange);
      params.append('limit', '500');

      const res = await fetch(`/api/system/logs?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch logs`);
      const data = await res.json();
      setLogs(data.logs || []);
      if (data.logFilePath) setLogFilePath(data.logFilePath);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchLogs();
    }
  }, [isOpen, activeFilter, dateRange]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchLogs();
  };

  const handlePrune = async (range: '24h' | '7d' | '30d' | 'all') => {
    setShowPruneMenu(false);
    try {
      const res = await fetch('/api/system/logs/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ range }),
      });
      if (!res.ok) throw new Error('Failed to prune logs');
      const data = await res.json();
      setPruneSuccess(`Pruned ${data.removedCount} entries (${range})`);
      setTimeout(() => setPruneSuccess(null), 4000);
      fetchLogs();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCopyLog = (entry: SystemLogEntry) => {
    navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
    setCopiedId(entry.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleExportJsonl = () => {
    const jsonlContent = logs.map((l) => JSON.stringify(l)).join('\n');
    const blob = new Blob([jsonlContent], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `system-audit-${new Date().toISOString().substring(0, 10)}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleDetails = (id: string) => {
    setExpandedDetails((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-5xl h-[90vh] bg-[#07090e] border border-slate-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/90 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-cyan-950/60 border border-cyan-500/40 text-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.25)]">
              <ScrollText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-base sm:text-lg font-bold text-white font-mono tracking-wide">
                  Centralized System Logs & Audit Trail
                </h2>
                <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-cyan-950/80 border border-cyan-500/40 text-cyan-300">
                  {logs.length} events
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs font-mono text-slate-400 mt-0.5">
                <span>Storage:</span>
                <code className="text-cyan-300 font-semibold">{logFilePath}</code>
                <span className="text-slate-600">•</span>
                <span className="text-emerald-400">30-day automated rotation</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleExportJsonl}
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs font-mono text-slate-300 hover:text-white hover:border-slate-600 transition-colors"
              title="Export as JSONL"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export</span>
            </button>

            <button
              onClick={fetchLogs}
              disabled={loading}
              className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-cyan-300 hover:border-cyan-500/40 transition-colors disabled:opacity-50"
              title="Refresh Logs"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-cyan-400' : ''}`} />
            </button>

            <button
              onClick={onClose}
              className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Toolbar: Filter Pills, Search Bar, Date Range, Pruning */}
        <div className="px-6 py-3 border-b border-slate-800/80 bg-slate-900/40 flex flex-wrap items-center justify-between gap-3 flex-shrink-0">
          {/* Left: Filter Pills */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setActiveFilter('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-all ${
                activeFilter === 'all'
                  ? 'bg-cyan-500 text-slate-950 font-bold shadow-[0_0_10px_rgba(6,182,212,0.4)]'
                  : 'bg-slate-900/80 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
              }`}
            >
              All Events
            </button>
            <button
              onClick={() => setActiveFilter('errors')}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-all flex items-center gap-1.5 ${
                activeFilter === 'errors'
                  ? 'bg-rose-500 text-white font-bold shadow-[0_0_10px_rgba(244,63,94,0.4)]'
                  : 'bg-slate-900/80 border border-slate-800 text-rose-400 hover:border-rose-500/40 hover:bg-rose-950/30'
              }`}
            >
              <AlertCircle className="w-3.5 h-3.5" />
              Errors
            </button>
            <button
              onClick={() => setActiveFilter('pipelines')}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-all flex items-center gap-1.5 ${
                activeFilter === 'pipelines'
                  ? 'bg-purple-500 text-white font-bold shadow-[0_0_10px_rgba(168,85,247,0.4)]'
                  : 'bg-slate-900/80 border border-slate-800 text-purple-400 hover:border-purple-500/40 hover:bg-purple-950/30'
              }`}
            >
              <GitBranch className="w-3.5 h-3.5" />
              Pipelines & AST
            </button>
            <button
              onClick={() => setActiveFilter('docker')}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-all flex items-center gap-1.5 ${
                activeFilter === 'docker'
                  ? 'bg-cyan-600 text-white font-bold shadow-[0_0_10px_rgba(8,145,178,0.4)]'
                  : 'bg-slate-900/80 border border-slate-800 text-cyan-400 hover:border-cyan-500/40 hover:bg-cyan-950/30'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              Docker Socket
            </button>
          </div>

          {/* Right: Search, Date Range, Clear Logs Menu */}
          <div className="flex items-center gap-2.5 flex-1 sm:flex-initial justify-end">
            {/* Live Search */}
            <form onSubmit={handleSearchSubmit} className="relative w-full sm:w-56">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search logs, actions..."
                className="w-full pl-8 pr-3 py-1.5 text-xs font-mono bg-slate-950 border border-slate-800 rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
              />
            </form>

            {/* Date Range Selector */}
            <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5 text-xs font-mono text-slate-400">
              <button
                onClick={() => setDateRange('today')}
                className={`px-2 py-1 rounded transition-colors ${
                  dateRange === 'today' ? 'bg-slate-800 text-cyan-300 font-semibold' : 'hover:text-slate-200'
                }`}
              >
                Today
              </button>
              <button
                onClick={() => setDateRange('7days')}
                className={`px-2 py-1 rounded transition-colors ${
                  dateRange === '7days' ? 'bg-slate-800 text-cyan-300 font-semibold' : 'hover:text-slate-200'
                }`}
              >
                7 Days
              </button>
              <button
                onClick={() => setDateRange('all')}
                className={`px-2 py-1 rounded transition-colors ${
                  dateRange === 'all' ? 'bg-slate-800 text-cyan-300 font-semibold' : 'hover:text-slate-200'
                }`}
              >
                All
              </button>
            </div>

            {/* Clear Logs / Maintenance Dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowPruneMenu(!showPruneMenu)}
                className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs font-mono text-rose-300 hover:border-rose-500/40 hover:bg-rose-950/30 transition-colors flex items-center gap-1.5"
                title="Log Storage Maintenance"
              >
                <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                <span className="hidden sm:inline">Clear Logs</span>
                <ChevronDown className="w-3 h-3 opacity-70" />
              </button>

              {showPruneMenu && (
                <div className="absolute right-0 mt-1 w-52 bg-[#0d121f] border border-slate-700 rounded-xl shadow-2xl py-1 z-30 animate-in fade-in slide-in-from-top-2">
                  <div className="px-3 py-1.5 text-[11px] font-mono text-slate-400 uppercase tracking-wider border-b border-slate-800">
                    Prune Audit Log
                  </div>
                  <button
                    onClick={() => handlePrune('24h')}
                    className="w-full px-3 py-2 text-left text-xs font-mono text-slate-300 hover:bg-slate-800/80 hover:text-white flex items-center justify-between"
                  >
                    <span>Older than 24 Hours</span>
                  </button>
                  <button
                    onClick={() => handlePrune('7d')}
                    className="w-full px-3 py-2 text-left text-xs font-mono text-slate-300 hover:bg-slate-800/80 hover:text-white flex items-center justify-between"
                  >
                    <span>Older than 7 Days</span>
                  </button>
                  <button
                    onClick={() => handlePrune('30d')}
                    className="w-full px-3 py-2 text-left text-xs font-mono text-slate-300 hover:bg-slate-800/80 hover:text-white flex items-center justify-between"
                  >
                    <span>Older than 30 Days</span>
                  </button>
                  <div className="border-t border-slate-800 my-1"></div>
                  <button
                    onClick={() => handlePrune('all')}
                    className="w-full px-3 py-2 text-left text-xs font-mono text-rose-400 hover:bg-rose-950/40 flex items-center justify-between font-bold"
                  >
                    <span>Clear All Logs</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Status Toast */}
        {pruneSuccess && (
          <div className="mx-6 mt-3 px-4 py-2 rounded-lg bg-emerald-950/60 border border-emerald-500/40 text-xs font-mono text-emerald-300 flex items-center gap-2 animate-in fade-in">
            <CheckCircle2 className="w-4 h-4" />
            {pruneSuccess}
          </div>
        )}

        {/* Timeline Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 font-mono">
          {error && (
            <div className="p-4 rounded-xl bg-rose-950/50 border border-rose-500/40 text-xs text-rose-300 flex items-center gap-3">
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {logs.length === 0 && !loading && (
            <div className="text-center py-16 text-slate-500">
              <ScrollText className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <div className="text-sm font-semibold text-slate-400">No log entries found</div>
              <div className="text-xs mt-1 text-slate-600">
                Try selecting &quot;All Events&quot; or resetting your search filter.
              </div>
            </div>
          )}

          <div className="relative border-l border-slate-800/80 ml-3 pl-6 space-y-4">
            {logs.map((entry) => {
              const date = new Date(entry.timestamp);
              const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
              const isExpanded = Boolean(expandedDetails[entry.id]);

              // Color-coded severity badge style
              let badgeColor = 'bg-cyan-950/60 border-cyan-500/40 text-cyan-300';
              let dotColor = 'bg-cyan-400';
              if (entry.level === 'ERROR') {
                badgeColor = 'bg-rose-950/60 border-rose-500/50 text-rose-300';
                dotColor = 'bg-rose-500';
              } else if (entry.level === 'WARN') {
                badgeColor = 'bg-amber-950/60 border-amber-500/40 text-amber-300';
                dotColor = 'bg-amber-400';
              } else if (entry.level === 'PIPELINE') {
                badgeColor = 'bg-purple-950/60 border-purple-500/40 text-purple-300';
                dotColor = 'bg-purple-400';
              }

              return (
                <div
                  key={entry.id}
                  className="relative group p-4 rounded-xl bg-slate-900/40 border border-slate-800 hover:border-slate-700 transition-all"
                >
                  {/* Glowing timeline node dot */}
                  <span
                    className={`absolute -left-[31px] top-5 w-2.5 h-2.5 rounded-full ${dotColor} ring-4 ring-[#07090e]`}
                  />

                  {/* Entry Header */}
                  <div className="flex items-center justify-between gap-2 flex-wrap mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${badgeColor}`}>
                        {entry.level}
                      </span>
                      <span className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider bg-slate-800/80 border border-slate-700 text-slate-300">
                        {entry.category}
                      </span>
                      <span className="text-[11px] text-slate-500">
                        {dateStr} {timeStr}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleCopyLog(entry)}
                        className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200"
                        title="Copy entry JSON"
                      >
                        {copiedId === entry.id ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Message */}
                  <div className="text-xs text-slate-200 leading-relaxed break-words font-mono">
                    {entry.message}
                  </div>

                  {/* Expandable Details */}
                  {entry.details && (
                    <div className="mt-2 pt-2 border-t border-slate-800/60">
                      <button
                        onClick={() => toggleDetails(entry.id)}
                        className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
                      >
                        <span>{isExpanded ? 'Hide Payload Details' : 'View Payload Details'}</span>
                        <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      </button>

                      {isExpanded && (
                        <pre className="mt-2 p-3 rounded-lg bg-black/70 border border-slate-800 text-[11px] text-slate-300 overflow-x-auto">
                          {typeof entry.details === 'string'
                            ? entry.details
                            : JSON.stringify(entry.details, null, 2)}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs font-mono text-slate-500 flex-shrink-0">
          <div>
            Showing <span className="text-slate-300 font-bold">{logs.length}</span> structured system events
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>Live Audit Active</span>
          </div>
        </div>
      </div>
    </div>
  );
};
