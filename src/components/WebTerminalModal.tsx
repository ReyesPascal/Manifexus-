import React, { useEffect, useRef, useState, useId } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  X,
  Maximize2,
  Minimize2,
  Terminal as TerminalIcon,
  RefreshCw,
  Folder,
  FileCode,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';

interface WebTerminalModalProps {
  isOpen: boolean;
  onClose: () => void;
  filePath: string;
  stackName?: string;
}

export const WebTerminalModal: React.FC<WebTerminalModalProps> = ({
  isOpen,
  onClose,
  filePath,
  stackName,
}) => {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [connectionStatus, setConnectionStatus] = useState<
    'connecting' | 'connected' | 'closed' | 'error'
  >('connecting');
  const [isMaximized, setIsMaximized] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fileName = filePath ? filePath.split('/').pop() || 'docker-compose.yml' : 'docker-compose.yml';

  useEffect(() => {
    if (!isOpen || !filePath || !terminalContainerRef.current) return;

    // Reset state
    setConnectionStatus('connecting');
    setErrorMessage(null);

    // Initialize xterm
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      theme: {
        background: '#080c14',
        foreground: '#e2e8f0',
        cursor: '#38bdf8',
        cursorAccent: '#080c14',
        selectionBackground: 'rgba(56, 189, 248, 0.3)',
        black: '#0f172a',
        red: '#f43f5e',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#d946ef',
        cyan: '#06b6d4',
        white: '#f8fafc',
        brightBlack: '#475569',
        brightRed: '#fb7185',
        brightGreen: '#34d399',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#e879f9',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalContainerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.writeln('\x1b[36mConnecting to Host Web Terminal (nano)...\x1b[0m');

    // Build WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws/terminal?file=${encodeURIComponent(filePath)}&cols=${term.cols}&rows=${term.rows}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionStatus('connected');
      // Send initial dimensions
      ws.send(
        JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        })
      );
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        term.write(event.data);
      } else if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buffer) => {
          term.write(new Uint8Array(buffer));
        });
      }
    };

    ws.onerror = () => {
      setConnectionStatus('error');
      setErrorMessage('Failed to connect to host terminal socket.');
    };

    ws.onclose = () => {
      setConnectionStatus('closed');
      term.writeln('\r\n\x1b[33m[Connection closed by host]\x1b[0m');
    };

    // Forward user keystrokes from xterm to WebSocket
    const onDataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Handle viewport resize
    const handleResize = () => {
      if (fitAddonRef.current && termRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
        try {
          fitAddonRef.current.fit();
          wsRef.current.send(
            JSON.stringify({
              type: 'resize',
              cols: termRef.current.cols,
              rows: termRef.current.rows,
            })
          );
        } catch {
          // ignore
        }
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      onDataDisposable.dispose();
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        // ignore
      }
      try {
        term.dispose();
      } catch {
        // ignore
      }
    };
  }, [isOpen, filePath]);

  // Re-fit when toggle maximize
  useEffect(() => {
    const timer = setTimeout(() => {
      if (fitAddonRef.current && termRef.current) {
        fitAddonRef.current.fit();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: 'resize',
              cols: termRef.current.cols,
              rows: termRef.current.rows,
            })
          );
        }
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [isMaximized]);

  const handleReconnect = () => {
    if (!isOpen || !filePath) return;
    // Trigger re-mount of terminal effect by toggling
    setConnectionStatus('connecting');
    setErrorMessage(null);
    if (wsRef.current) {
      wsRef.current.close();
    }
    if (termRef.current) {
      termRef.current.reset();
      termRef.current.writeln('\x1b[36mReconnecting to Host Web Terminal (nano)...\x1b[0m');
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws/terminal?file=${encodeURIComponent(filePath)}&cols=90&rows=28`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionStatus('connected');
      if (termRef.current) {
        ws.send(
          JSON.stringify({
            type: 'resize',
            cols: termRef.current.cols,
            rows: termRef.current.rows,
          })
        );
      }
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string' && termRef.current) {
        termRef.current.write(event.data);
      }
    };

    ws.onerror = () => {
      setConnectionStatus('error');
      setErrorMessage('Failed to connect to host terminal socket.');
    };

    ws.onclose = () => {
      setConnectionStatus('closed');
      if (termRef.current) {
        termRef.current.writeln('\r\n\x1b[33m[Connection closed by host]\x1b[0m');
      }
    };
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-150">
      <div
        className={`flex flex-col bg-[#080c14] border border-cyan-500/40 rounded-2xl shadow-2xl overflow-hidden transition-all duration-200 ${
          isMaximized ? 'w-full h-full max-w-none' : 'w-full max-w-5xl h-[80vh] min-h-[480px]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Terminal Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#0d1322] border-b border-slate-800">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-1.5 rounded-lg bg-cyan-950/80 border border-cyan-500/40 text-cyan-400">
              <TerminalIcon className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-xs font-mono text-white tracking-wide">
                  Host Terminal: <code className="text-cyan-300">nano</code>
                </span>
                {stackName && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-purple-950/80 border border-purple-500/40 text-purple-300 hidden sm:inline">
                    {stackName}
                  </span>
                )}
                {/* Connection Status Indicator */}
                <div
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono border ${
                    connectionStatus === 'connected'
                      ? 'bg-emerald-950/80 border-emerald-500/40 text-emerald-300'
                      : connectionStatus === 'connecting'
                      ? 'bg-amber-950/80 border-amber-500/40 text-amber-300 animate-pulse'
                      : 'bg-rose-950/80 border-rose-500/40 text-rose-300'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      connectionStatus === 'connected'
                        ? 'bg-emerald-400'
                        : connectionStatus === 'connecting'
                        ? 'bg-amber-400'
                        : 'bg-rose-400'
                    }`}
                  />
                  <span className="capitalize">{connectionStatus}</span>
                </div>
              </div>

              <div className="flex items-center gap-1.5 text-[11px] font-mono text-slate-400 truncate max-w-lg mt-0.5">
                <Folder className="w-3 h-3 text-slate-500 flex-shrink-0" />
                <span className="truncate">{filePath}</span>
              </div>
            </div>
          </div>

          {/* Shortcuts & Action Controls */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Nano Shortcuts Legend */}
            <div className="hidden lg:flex items-center gap-2 text-[10px] font-mono text-slate-400 bg-slate-900/90 px-2.5 py-1 rounded-lg border border-slate-800">
              <span className="text-cyan-300 font-bold">Ctrl+O</span>: Save
              <span className="text-slate-600">|</span>
              <span className="text-cyan-300 font-bold">Ctrl+X</span>: Exit
            </div>

            {connectionStatus === 'closed' && (
              <button
                onClick={handleReconnect}
                className="px-2.5 py-1 rounded-lg bg-cyan-950 hover:bg-cyan-900 border border-cyan-500/40 text-cyan-300 text-xs font-mono transition-colors flex items-center gap-1.5"
                title="Restart terminal session"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Reconnect</span>
              </button>
            )}

            <button
              onClick={() => setIsMaximized(!isMaximized)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              title={isMaximized ? 'Restore normal size' : 'Maximize terminal'}
            >
              {isMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              title="Close terminal"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Terminal Viewport */}
        <div className="flex-1 p-2 bg-[#080c14] overflow-hidden relative">
          <div ref={terminalContainerRef} className="w-full h-full rounded-b-xl" />
        </div>

        {/* Terminal Footer Bar */}
        <div className="flex items-center justify-between px-4 py-2 bg-[#0d1322] border-t border-slate-800 text-[11px] font-mono text-slate-400">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5">
              <FileCode className="w-3.5 h-3.5 text-cyan-400" />
              <span>Editing: <code className="text-white font-bold">{fileName}</code></span>
            </span>
            <span className="hidden sm:inline text-slate-600">•</span>
            <span className="hidden sm:inline text-slate-500">
              Host File Binding (Real-Time Changes Synced to Host Disk)
            </span>
          </div>

          <div className="flex items-center gap-3">
            {errorMessage && (
              <span className="text-rose-400 text-xs flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                <span>{errorMessage}</span>
              </span>
            )}
            <button
              onClick={onClose}
              className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono transition-colors"
            >
              Close Terminal
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
