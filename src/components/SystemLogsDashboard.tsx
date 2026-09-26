import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  StructuredLogEntry,
  LogLevel,
  LogEventType,
  LogQueryResult,
} from '../types';
import {
  Terminal,
  Search,
  Filter,
  RefreshCw,
  Download,
  Trash2,
  Calendar,
  AlertTriangle,
  CheckCircle,
  Info,
  Clock,
  ExternalLink,
  Layers,
  ChevronDown,
  ChevronUp,
  X,
  Copy,
  Check,
  HardDrive,
  Cpu,
  ArrowUpRight,
  Database,
  Radio,
  FileText,
  Sliders,
} from 'lucide-react';

interface SystemLogsDashboardProps {
  onClose?: () => void;
}

export const SystemLogsDashboard: React.FC<SystemLogsDashboardProps> = ({ onClose }) => {
  // Filters & State
  const [logs, setLogs] = useState<StructuredLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState<number>(3000); // 3 seconds
  const [realtimeSseActive, setRealtimeSseActive] = useState(false);

  // Filter params
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLevel, setSelectedLevel] = useState<LogLevel | 'ALL'>('ALL');
  const [selectedEventType, setSelectedEventType] = useState<LogEventType | 'ALL'>('ALL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [limit, setLimit] = useState(250);

  // Metadata
  const [metadata, setMetadata] = useState<{
    total: number;
    filteredCount: number;
    activeLogFile: string;
    storageDir: string;
    logFilesCount: number;
  }>({
    total: 0,
    filteredCount: 0,
    activeLogFile: '',
    storageDir: '/app/logs',
    logFilesCount: 0,
  });

  // Modal inspection
  const [inspectLog, setInspectLog] = useState<StructuredLogEntry | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedRaw, setCopiedRaw] = useState(false);

  // Clear confirmation modal
  const [isClearModalOpen, setIsClearModalOpen] = useState(false);
  const [clearConfirmationInput, setClearConfirmationInput] = useState('');
  const [isClearing, setIsClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  // Auto-scroll anchor
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Fetch logs from API
  const fetchLogs = useCallback(async (isBackground = false) => {
    if (!isBackground) setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedLevel !== 'ALL') params.append('level', selectedLevel);
      if (selectedEventType !== 'ALL') params.append('eventType', selectedEventType);
      if (searchQuery.trim()) params.append('search', searchQuery.trim());
      if (startDate) params.append('startDate', startDate);
      if (endDate) params.append('endDate', endDate);
      params.append('limit', limit.toString());

      const res = await fetch(`/api/logs?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data: LogQueryResult & { success: boolean } = await res.json();

      if (data.success) {
        // Guarantee unique entries by ID
        const seenIds = new Set<string>();
        const dedupedLogs: StructuredLogEntry[] = [];
        for (const item of data.logs) {
          if (!seenIds.has(item.id)) {
            seenIds.add(item.id);
            dedupedLogs.push(item);
          }
        }
        setLogs(dedupedLogs);
        setMetadata({
          total: data.total,
          filteredCount: data.filteredCount,
          activeLogFile: data.activeLogFile,
          storageDir: data.storageDir,
          logFilesCount: data.logFilesCount,
        });
        setError(null);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (!isBackground) setLoading(false);
    }
  }, [selectedLevel, selectedEventType, searchQuery, startDate, endDate, limit]);

  // Real-time EventSource listener
  useEffect(() => {
    let sse: EventSource | null = null;
    try {
      sse = new EventSource('/api/logs/stream');
      sse.onopen = () => {
        setRealtimeSseActive(true);
      };
      sse.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed && parsed.id && parsed.timestamp) {
            const newEntry = parsed as StructuredLogEntry;
            setLogs((prev) => {
              // Deduplicate: If entry is already present in state, skip prepending
              if (prev.some((l) => l.id === newEntry.id)) {
                return prev;
              }
              return [newEntry, ...prev.slice(0, limit - 1)];
            });
            setMetadata((prev) => ({
              ...prev,
              total: prev.total + 1,
              filteredCount: prev.filteredCount + 1,
            }));
          }
        } catch {
          // heartbeat/ping
        }
      };
      sse.onerror = () => {
        setRealtimeSseActive(false);
      };
    } catch {
      setRealtimeSseActive(false);
    }

    return () => {
      if (sse) sse.close();
    };
  }, [limit]);

  // Polling fallback when SSE is idle or autoRefresh is toggled
  useEffect(() => {
    fetchLogs();
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      fetchLogs(true);
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [fetchLogs, autoRefresh, refreshInterval]);

  // Export filtered logs as JSON file
  const handleExportLogs = () => {
    const params = new URLSearchParams();
    if (selectedLevel !== 'ALL') params.append('level', selectedLevel);
    if (selectedEventType !== 'ALL') params.append('eventType', selectedEventType);
    if (searchQuery.trim()) params.append('search', searchQuery.trim());
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);

    window.location.href = `/api/logs/export?${params.toString()}`;
  };

  // Clear logs request
  const handleConfirmClearLogs = async () => {
    if (clearConfirmationInput.trim().toUpperCase() !== 'CONFIRM') {
      setClearError('Please type "CONFIRM" exactly to verify log destruction.');
      return;
    }

    setIsClearing(true);
    setClearError(null);
    try {
      const res = await fetch('/api/logs/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to clear logs');
      }

      setIsClearModalOpen(false);
      setClearConfirmationInput('');
      fetchLogs();
    } catch (err) {
      setClearError((err as Error).message);
    } finally {
      setIsClearing(false);
    }
  };

  const copyToClipboard = (text: string, isFullPayload = false) => {
    navigator.clipboard.writeText(text);
    if (isFullPayload) {
      setCopiedRaw(true);
      setTimeout(() => setCopiedRaw(false), 2000);
    } else {
      setCopiedId(text);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  // Severity styling
  const getLevelBadge = (level: LogLevel) => {
    switch (level) {
      case 'CRITICAL':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-bold bg-rose-950/80 text-rose-300 border border-rose-800/80">
            <AlertTriangle className="w-3 h-3 text-rose-400" />
            CRITICAL
          </span>
        );
      case 'ERROR':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-bold bg-red-950/80 text-red-300 border border-red-800/80">
            <AlertTriangle className="w-3 h-3 text-red-400" />
            ERROR
          </span>
        );
      case 'WARN':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-semibold bg-amber-950/80 text-amber-300 border border-amber-800/70">
            <AlertTriangle className="w-3 h-3 text-amber-400" />
            WARN
          </span>
        );
      case 'DEBUG':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono text-purple-300 bg-purple-950/70 border border-purple-800/60">
            <Radio className="w-3 h-3 text-purple-400" />
            DEBUG
          </span>
        );
      case 'INFO':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono text-sky-300 bg-sky-950/70 border border-sky-800/60">
            <Info className="w-3 h-3 text-sky-400" />
            INFO
          </span>
        );
    }
  };

  // Event Type badges
  const getEventTypeBadge = (type: LogEventType) => {
    switch (type) {
      case 'DOCKER_EXEC':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-cyan-950/60 text-cyan-300 border border-cyan-800/50">
            <Cpu className="w-3 h-3 text-cyan-400" />
            DOCKER_EXEC
          </span>
        );
      case 'API_CALL':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-emerald-950/60 text-emerald-300 border border-emerald-800/50">
            <ArrowUpRight className="w-3 h-3 text-emerald-400" />
            API_CALL
          </span>
        );
      case 'STATE_CHANGE':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-indigo-950/60 text-indigo-300 border border-indigo-800/50">
            <RefreshCw className="w-3 h-3 text-indigo-400" />
            STATE_CHANGE
          </span>
        );
      case 'STACK_OP':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-amber-950/60 text-amber-300 border border-amber-800/50">
            <Layers className="w-3 h-3 text-amber-400" />
            STACK_OP
          </span>
        );
      case 'SYSTEM':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-slate-800/90 text-slate-300 border border-slate-700/80">
            <Terminal className="w-3 h-3 text-slate-400" />
            {type}
          </span>
        );
    }
  };

  return (
    <div className="flex flex-col h-full w-full bg-slate-950 text-slate-100 select-text">
      {/* Top Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <Terminal className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight text-white">System Diagnostics & Global Logs</h2>
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-950/80 text-emerald-300 border border-emerald-800/60">
                <span className={`w-1.5 h-1.5 rounded-full ${realtimeSseActive ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
                {realtimeSseActive ? 'Live Stream Active' : 'Live Feed'}
              </span>
            </div>
            <p className="text-xs text-slate-400 flex items-center gap-2 mt-0.5">
              <span>Persistent Volume: <code className="text-slate-300 bg-slate-900 px-1 py-0.5 rounded border border-slate-800">{metadata.storageDir}</code></span>
              <span>•</span>
              <span>Active File: <code className="text-slate-300 bg-slate-900 px-1 py-0.5 rounded border border-slate-800">{metadata.activeLogFile || 'rolling daily'}</code></span>
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Auto Refresh Toggle */}
          <button
            type="button"
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              autoRefresh
                ? 'bg-emerald-950/40 border-emerald-700/60 text-emerald-300 hover:bg-emerald-900/40'
                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${autoRefresh ? 'animate-spin' : ''}`} style={{ animationDuration: '6s' }} />
            {autoRefresh ? 'Auto-Sync On (3s)' : 'Paused'}
          </button>

          {/* Manual Refresh */}
          <button
            type="button"
            onClick={() => fetchLogs()}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 border border-slate-700 hover:bg-slate-800 text-slate-200 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>

          {/* Export JSON Button */}
          <button
            type="button"
            onClick={handleExportLogs}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 border border-slate-700 hover:border-slate-600 hover:bg-slate-800 text-slate-200 transition-colors"
            title="Download the current filtered dataset as a JSON file"
          >
            <Download className="w-3.5 h-3.5 text-sky-400" />
            Export Logs (JSON)
          </button>

          {/* Clear Logs Button with Confirmation */}
          <button
            type="button"
            onClick={() => setIsClearModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-950/30 border border-rose-800/60 hover:bg-rose-900/40 text-rose-300 transition-colors"
            title="Clear all logs permanently from disk"
          >
            <Trash2 className="w-3.5 h-3.5 text-rose-400" />
            Clear Logs
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 ml-2"
              title="Close Logs Viewer"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Observability Filter Control Center */}
      <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex flex-wrap items-center gap-3">
        {/* Search Bar */}
        <div className="relative flex-1 min-w-[280px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search logs by message, path, container, command, exit code, payload..."
            className="w-full pl-9 pr-8 py-1.5 bg-slate-900/90 border border-slate-700/80 rounded-lg text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 transition-all font-mono"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Severity Level Filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-400 flex items-center gap-1">
            <Filter className="w-3 h-3" /> Level:
          </span>
          <select
            value={selectedLevel}
            onChange={(e) => setSelectedLevel(e.target.value as LogLevel | 'ALL')}
            className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          >
            <option value="ALL">All Levels</option>
            <option value="DEBUG">DEBUG</option>
            <option value="INFO">INFO</option>
            <option value="WARN">WARN</option>
            <option value="ERROR">ERROR</option>
            <option value="CRITICAL">CRITICAL</option>
          </select>
        </div>

        {/* Event Type Filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-400 flex items-center gap-1">
            <Layers className="w-3 h-3" /> Event:
          </span>
          <select
            value={selectedEventType}
            onChange={(e) => setSelectedEventType(e.target.value as LogEventType | 'ALL')}
            className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          >
            <option value="ALL">All Event Types</option>
            <option value="API_CALL">API_CALL (Express)</option>
            <option value="DOCKER_EXEC">DOCKER_EXEC (Docker)</option>
            <option value="STATE_CHANGE">STATE_CHANGE</option>
            <option value="SYSTEM">SYSTEM</option>
            <option value="STACK_OP">STACK_OP</option>
          </select>
        </div>

        {/* Date Range Selector */}
        <div className="flex items-center gap-1.5 text-xs text-slate-300">
          <Calendar className="w-3.5 h-3.5 text-slate-400" />
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            title="Start Date"
          />
          <span className="text-slate-500">to</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            title="End Date"
          />
          {(startDate || endDate) && (
            <button
              onClick={() => {
                setStartDate('');
                setEndDate('');
              }}
              className="text-xs text-slate-400 hover:text-slate-200 underline ml-1"
            >
              Reset
            </button>
          )}
        </div>

        {/* Counter Summary */}
        <div className="ml-auto text-xs text-slate-400 font-mono">
          Showing <strong className="text-slate-200">{logs.length}</strong> of{' '}
          <strong className="text-slate-200">{metadata.filteredCount}</strong> events (Buffer: {metadata.total})
        </div>
      </div>

      {/* Main Table / Stream View */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-h-0 font-mono text-xs">
        {loading && logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-slate-400">
            <RefreshCw className="w-7 h-7 animate-spin text-emerald-400 mb-3" />
            <p className="text-sm">Querying diagnostic event journal...</p>
          </div>
        ) : error ? (
          <div className="p-8 text-center text-rose-400">
            <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-rose-500" />
            <p className="font-semibold text-sm">Failed to retrieve logs</p>
            <p className="text-xs text-rose-300 mt-1">{error}</p>
            <button
              onClick={() => fetchLogs()}
              className="mt-4 px-4 py-1.5 rounded-lg bg-rose-950 border border-rose-700 text-rose-200 hover:bg-rose-900 text-xs"
            >
              Retry
            </button>
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-slate-500">
            <FileText className="w-8 h-8 mb-2 stroke-1" />
            <p className="text-sm font-medium">No logs match the selected filter criteria.</p>
            <p className="text-xs text-slate-600 mt-1">Try resetting filters or generating activity in the app.</p>
          </div>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 bg-slate-900 text-slate-400 font-semibold border-b border-slate-800 uppercase tracking-wider text-[11px] z-10">
              <tr>
                <th className="py-2.5 px-4 w-44">Timestamp</th>
                <th className="py-2.5 px-3 w-28">Severity</th>
                <th className="py-2.5 px-3 w-32">Event Type</th>
                <th className="py-2.5 px-3 w-32">Source</th>
                <th className="py-2.5 px-4">Message / Command / Payload</th>
                <th className="py-2.5 px-3 w-24 text-right">Duration</th>
                <th className="py-2.5 px-4 w-28 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {logs.map((entry, idx) => {
                const isError = entry.level === 'ERROR' || entry.level === 'CRITICAL';
                const isWarn = entry.level === 'WARN';

                return (
                  <tr
                    key={`${entry.id}-${idx}`}
                    className={`hover:bg-slate-900/70 transition-colors group ${
                      isError ? 'bg-red-950/15' : isWarn ? 'bg-amber-950/10' : ''
                    }`}
                  >
                    {/* Timestamp */}
                    <td className="py-2 px-4 whitespace-nowrap text-slate-400">
                      {new Date(entry.timestamp).toLocaleTimeString([], {
                        hour12: false,
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        fractionalSecondDigits: 3,
                      })}
                      <span className="block text-[10px] text-slate-500">
                        {new Date(entry.timestamp).toISOString().slice(0, 10)}
                      </span>
                    </td>

                    {/* Level */}
                    <td className="py-2 px-3 whitespace-nowrap">
                      {getLevelBadge(entry.level)}
                    </td>

                    {/* Event Type */}
                    <td className="py-2 px-3 whitespace-nowrap">
                      {getEventTypeBadge(entry.eventType)}
                    </td>

                    {/* Source */}
                    <td className="py-2 px-3 whitespace-nowrap text-slate-300">
                      <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-[11px]">
                        {entry.source}
                      </span>
                    </td>

                    {/* Message & Payload Preview */}
                    <td className="py-2 px-4 break-all">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-200">{entry.message}</span>
                      </div>

                      {/* Docker Execution specific preview */}
                      {entry.executionDetails?.command && (
                        <div className="mt-1 text-[11px] text-cyan-400/90 flex items-center gap-2">
                          <code className="bg-cyan-950/30 px-1 py-0.5 rounded border border-cyan-900/50">
                            $ {entry.executionDetails.command}
                          </code>
                          {entry.executionDetails.targetContainer && (
                            <span className="text-slate-400">
                              target: <strong className="text-slate-300">[{entry.executionDetails.targetContainer}]</strong>
                            </span>
                          )}
                          <span className={`px-1 py-0.2 rounded text-[10px] ${
                            entry.executionDetails.exitCode === 0 ? 'bg-emerald-950 text-emerald-400' : 'bg-rose-950 text-rose-400'
                          }`}>
                            exit: {entry.executionDetails.exitCode}
                          </span>
                        </div>
                      )}

                      {/* API Call specific preview */}
                      {entry.metadata?.route && (
                        <div className="mt-0.5 text-[11px] text-slate-400 flex items-center gap-2">
                          <span className="font-semibold text-slate-300">{entry.metadata.method}</span>
                          <span>{entry.metadata.route}</span>
                          <span className={`px-1 rounded text-[10px] ${
                            (entry.metadata.statusCode || 200) < 400
                              ? 'bg-emerald-950/70 text-emerald-400'
                              : 'bg-rose-950/70 text-rose-400'
                          }`}>
                            {entry.metadata.statusCode}
                          </span>
                        </div>
                      )}

                      {/* Error Preview */}
                      {entry.error && (
                        <div className="mt-1 text-[11px] text-rose-400 font-sans">
                          {entry.error.message}
                        </div>
                      )}
                    </td>

                    {/* Duration */}
                    <td className="py-2 px-3 whitespace-nowrap text-right text-slate-400">
                      {entry.metadata?.durationMs !== undefined ? (
                        <span className={entry.metadata.durationMs > 500 ? 'text-amber-400 font-semibold' : ''}>
                          {entry.metadata.durationMs.toFixed(1)}ms
                        </span>
                      ) : entry.executionDetails?.durationMs !== undefined ? (
                        <span>{entry.executionDetails.durationMs}ms</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>

                    {/* View Details Button */}
                    <td className="py-2 px-4 whitespace-nowrap text-center">
                      <button
                        type="button"
                        onClick={() => setInspectLog(entry)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-900 border border-slate-700/80 hover:border-slate-500 hover:bg-slate-800 text-slate-300 hover:text-white transition-colors"
                      >
                        <ExternalLink className="w-3 h-3 text-emerald-400" />
                        Details
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Modal 1: Granular Raw JSON Inspector */}
      {inspectLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="flex flex-col w-full max-w-4xl max-h-[88vh] bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden font-mono">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60">
              <div className="flex items-center gap-3">
                {getLevelBadge(inspectLog.level)}
                {getEventTypeBadge(inspectLog.eventType)}
                <span className="text-sm font-semibold text-slate-200">Log Entry #{inspectLog.id}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => copyToClipboard(JSON.stringify(inspectLog, null, 2), true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-sans font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
                >
                  {copiedRaw ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" /> Copied JSON
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" /> Copy JSON
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setInspectLog(null)}
                  className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-4">
              {/* Highlights bar */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-sans">
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <span className="text-slate-500 block text-[11px]">Timestamp</span>
                  <span className="font-mono text-slate-200">{inspectLog.timestamp}</span>
                </div>
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <span className="text-slate-500 block text-[11px]">Source Module</span>
                  <span className="font-mono text-slate-200">{inspectLog.source}</span>
                </div>
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <span className="text-slate-500 block text-[11px]">Duration</span>
                  <span className="font-mono text-emerald-400">
                    {inspectLog.metadata?.durationMs !== undefined
                      ? `${inspectLog.metadata.durationMs.toFixed(1)}ms`
                      : inspectLog.executionDetails?.durationMs !== undefined
                      ? `${inspectLog.executionDetails.durationMs}ms`
                      : 'N/A'}
                  </span>
                </div>
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <span className="text-slate-500 block text-[11px]">Exit / Status Code</span>
                  <span className="font-mono text-slate-200">
                    {inspectLog.metadata?.statusCode ?? inspectLog.executionDetails?.exitCode ?? 'OK (0)'}
                  </span>
                </div>
              </div>

              {/* Message */}
              <div>
                <span className="text-xs font-sans text-slate-400 block mb-1 font-semibold uppercase tracking-wider">
                  Event Message
                </span>
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200">
                  {inspectLog.message}
                </div>
              </div>

              {/* Stack Trace if present */}
              {inspectLog.error?.stack && (
                <div>
                  <span className="text-xs font-sans text-rose-400 block mb-1 font-semibold uppercase tracking-wider">
                    Error Stack Trace
                  </span>
                  <pre className="p-3 rounded-lg bg-rose-950/30 border border-rose-800/60 text-xs text-rose-300 overflow-x-auto whitespace-pre-wrap">
                    {inspectLog.error.stack}
                  </pre>
                </div>
              )}

              {/* Docker Exec stdout/stderr if present */}
              {inspectLog.executionDetails && (
                <div>
                  <span className="text-xs font-sans text-cyan-400 block mb-1 font-semibold uppercase tracking-wider">
                    Docker Socket Execution Telemetry
                  </span>
                  <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-2 text-xs">
                    <div>
                      <span className="text-slate-500">Command:</span>{' '}
                      <code className="text-cyan-300">{inspectLog.executionDetails.command}</code>
                    </div>
                    {inspectLog.executionDetails.targetContainer && (
                      <div>
                        <span className="text-slate-500">Container:</span>{' '}
                        <code className="text-slate-200">{inspectLog.executionDetails.targetContainer}</code>
                      </div>
                    )}
                    {inspectLog.executionDetails.stdout && (
                      <div>
                        <span className="text-slate-500 block">Stdout:</span>
                        <pre className="mt-1 p-2 rounded bg-slate-900 border border-slate-800 text-emerald-300 max-h-36 overflow-y-auto whitespace-pre-wrap">
                          {inspectLog.executionDetails.stdout}
                        </pre>
                      </div>
                    )}
                    {inspectLog.executionDetails.stderr && (
                      <div>
                        <span className="text-slate-500 block">Stderr:</span>
                        <pre className="mt-1 p-2 rounded bg-rose-950/50 border border-rose-800 text-rose-300 max-h-36 overflow-y-auto whitespace-pre-wrap">
                          {inspectLog.executionDetails.stderr}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Beautifully Formatted Raw JSON */}
              <div>
                <span className="text-xs font-sans text-slate-400 block mb-1 font-semibold uppercase tracking-wider">
                  Raw JSON Payload
                </span>
                <pre className="p-4 rounded-lg bg-slate-950 border border-slate-800 text-xs text-emerald-400 overflow-x-auto max-h-96">
                  {JSON.stringify(inspectLog, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal 2: Safety Confirmation Modal for Clear Logs */}
      {isClearModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md bg-slate-900 border border-rose-800/80 rounded-xl p-6 shadow-2xl text-slate-100">
            <div className="flex items-center gap-3 text-rose-400 mb-4">
              <div className="p-2.5 rounded-lg bg-rose-950 border border-rose-800">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Permanently Clear All Logs?</h3>
                <p className="text-xs text-slate-400">Volume location: {metadata.storageDir}</p>
              </div>
            </div>

            <p className="text-xs text-slate-300 mb-4 leading-relaxed">
              This action will permanently delete all rolling <code>.jsonl</code> diagnostic log files archived on disk
              and flush the in-memory telemetry buffer. This action <strong>cannot be undone</strong>.
            </p>

            <div className="mb-4">
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Type <strong className="text-rose-400 font-mono">CONFIRM</strong> to authorize purge:
              </label>
              <input
                type="text"
                value={clearConfirmationInput}
                onChange={(e) => setClearConfirmationInput(e.target.value)}
                placeholder="CONFIRM"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-rose-500 font-mono"
              />
              {clearError && <p className="text-xs text-rose-400 mt-1.5">{clearError}</p>}
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsClearModalOpen(false);
                  setClearConfirmationInput('');
                  setClearError(null);
                }}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmClearLogs}
                disabled={isClearing || clearConfirmationInput.trim().toUpperCase() !== 'CONFIRM'}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium bg-rose-600 hover:bg-rose-500 text-white disabled:opacity-40 transition-colors shadow-lg shadow-rose-900/30"
              >
                {isClearing ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Purging...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" /> Purge Logs Permanently
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
export default SystemLogsDashboard;
