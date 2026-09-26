import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export type LogEventType =
  | 'API_CALL'
  | 'DOCKER_EXEC'
  | 'STATE_CHANGE'
  | 'SYSTEM'
  | 'AUTH'
  | 'STACK_OP';

export interface LogExecutionDetails {
  command?: string;
  targetContainer?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface LogErrorDetails {
  message: string;
  stack?: string;
  code?: string | number;
}

export interface StructuredLogEntry {
  id: string;
  timestamp: string; // ISO 8601 with milliseconds
  level: LogLevel;
  eventType: LogEventType;
  message: string;
  source: string; // e.g. 'express-api', 'dockerService', 'automationService'
  payload?: Record<string, unknown> | unknown[];
  metadata?: {
    method?: string;
    route?: string;
    statusCode?: number;
    durationMs?: number;
    ip?: string;
    userAgent?: string;
    [key: string]: unknown;
  };
  executionDetails?: LogExecutionDetails;
  error?: LogErrorDetails;
}

export interface LogFilterOptions {
  startDate?: string; // ISO string or YYYY-MM-DD
  endDate?: string;   // ISO string or YYYY-MM-DD
  level?: LogLevel | 'ALL';
  eventType?: LogEventType | 'ALL';
  search?: string;
  limit?: number;
  offset?: number;
}

export interface LogQueryResult {
  logs: StructuredLogEntry[];
  total: number;
  filteredCount: number;
  logFilesCount: number;
  activeLogFile: string;
  storageDir: string;
}

class GlobalLogService extends EventEmitter {
  private static instance: GlobalLogService;
  private logDirectory: string;
  private memoryBuffer: StructuredLogEntry[] = [];
  private readonly maxMemoryBuffer = 5000;
  private writeQueue: string[] = [];
  private isWriting = false;

  private constructor() {
    super();
    this.logDirectory = this.resolveLogDirectory();
    this.ensureDirectoryExists(this.logDirectory);
    this.loadRecentLogsIntoMemory();

    // Log the service initialization
    this.log({
      level: 'INFO',
      eventType: 'SYSTEM',
      source: 'GlobalLogService',
      message: `Diagnostic logging engine initialized. Writing rolling JSON logs to ${this.logDirectory}`,
      payload: {
        directory: this.logDirectory,
        dailyRotation: true,
        bufferCapacity: this.maxMemoryBuffer,
      },
    });
  }

  public static getInstance(): GlobalLogService {
    if (!GlobalLogService.instance) {
      GlobalLogService.instance = new GlobalLogService();
    }
    return GlobalLogService.instance;
  }

  /**
   * Determine primary log path (/app/logs volume mount), with resilient fallback to local ./logs.
   */
  private resolveLogDirectory(): string {
    const configuredPath = process.env.LOG_DIR || '/app/logs';
    try {
      if (!fs.existsSync(configuredPath)) {
        fs.mkdirSync(configuredPath, { recursive: true });
      }
      // Test writability
      const testFile = path.join(configuredPath, `.test_write_${Date.now()}`);
      fs.writeFileSync(testFile, 'ok', 'utf8');
      fs.unlinkSync(testFile);
      return configuredPath;
    } catch {
      // Fallback to local logs directory in workspace
      const fallback = path.resolve(process.cwd(), 'logs');
      if (!fs.existsSync(fallback)) {
        fs.mkdirSync(fallback, { recursive: true });
      }
      return fallback;
    }
  }

  private ensureDirectoryExists(dir: string): void {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        console.error(`[GlobalLogService] Failed to create log directory ${dir}:`, err);
      }
    }
  }

  /**
   * Generate daily rolling log file name: system-YYYY-MM-DD.jsonl
   */
  public getDailyLogFileName(date: Date = new Date()): string {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `system-${yyyy}-${mm}-${dd}.jsonl`;
  }

  public getDailyLogFilePath(date: Date = new Date()): string {
    return path.join(this.logDirectory, this.getDailyLogFileName(date));
  }

  /**
   * Primary entry point to capture structured logs across the entire application.
   */
  public log(entryInput: Omit<StructuredLogEntry, 'id' | 'timestamp'> & { timestamp?: string; id?: string }): StructuredLogEntry {
    const entry: StructuredLogEntry = {
      id: entryInput.id || `log_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      timestamp: entryInput.timestamp || new Date().toISOString(),
      level: entryInput.level,
      eventType: entryInput.eventType,
      message: entryInput.message,
      source: entryInput.source,
      payload: entryInput.payload,
      metadata: entryInput.metadata,
      executionDetails: entryInput.executionDetails,
      error: entryInput.error,
    };

    // Keep in fast in-memory ring buffer
    this.memoryBuffer.unshift(entry);
    if (this.memoryBuffer.length > this.maxMemoryBuffer) {
      this.memoryBuffer.length = this.maxMemoryBuffer;
    }

    // Emit live event for real-time dashboard subscriptions / SSE
    this.emit('log', entry);

    // Queue for high-throughput persistent disk write
    this.queueLogWrite(entry);

    return entry;
  }

  /**
   * Specialized helper for logging API requests & responses (Express API Middleware).
   */
  public logApiCall(params: {
    method: string;
    route: string;
    statusCode: number;
    durationMs: number;
    requestBody?: unknown;
    responseBody?: unknown;
    ip?: string;
    userAgent?: string;
    error?: Error | unknown;
  }): StructuredLogEntry {
    const isError = params.statusCode >= 500;
    const isWarn = params.statusCode >= 400 && params.statusCode < 500;
    const level: LogLevel = isError ? 'ERROR' : isWarn ? 'WARN' : 'INFO';

    let errorDetails: LogErrorDetails | undefined;
    if (params.error) {
      if (params.error instanceof Error) {
        errorDetails = {
          message: params.error.message,
          stack: params.error.stack,
        };
      } else {
        errorDetails = {
          message: String(params.error),
        };
      }
    }

    return this.log({
      level,
      eventType: 'API_CALL',
      source: 'express-api',
      message: `${params.method} ${params.route} [${params.statusCode}] - ${params.durationMs.toFixed(1)}ms`,
      payload: {
        requestBody: params.requestBody,
        responseSummary: params.responseBody ? this.truncateLargePayload(params.responseBody) : undefined,
      },
      metadata: {
        method: params.method,
        route: params.route,
        statusCode: params.statusCode,
        durationMs: Math.round(params.durationMs * 100) / 100,
        ip: params.ip,
        userAgent: params.userAgent,
      },
      error: errorDetails,
    });
  }

  /**
   * Specialized helper for logging Docker actions & socket executions (Docker Execution Wrapper).
   */
  public logDockerExec(params: {
    command: string;
    targetContainer?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    durationMs?: number;
    level?: LogLevel;
    message?: string;
    payload?: Record<string, unknown>;
    error?: Error | unknown;
  }): StructuredLogEntry {
    const isFailure = (params.exitCode !== undefined && params.exitCode !== 0) || Boolean(params.error) || (params.stderr && params.stderr.length > 0 && params.exitCode !== 0);
    const level: LogLevel = params.level || (isFailure ? 'ERROR' : 'INFO');
    const containerTag = params.targetContainer ? ` on container [${params.targetContainer}]` : '';

    let errorDetails: LogErrorDetails | undefined;
    if (params.error) {
      if (params.error instanceof Error) {
        errorDetails = {
          message: params.error.message,
          stack: params.error.stack,
        };
      } else {
        errorDetails = {
          message: String(params.error),
        };
      }
    }

    return this.log({
      level,
      eventType: 'DOCKER_EXEC',
      source: 'dockerService',
      message: params.message || `Docker exec${containerTag}: ${params.command} (exit: ${params.exitCode ?? 0})`,
      payload: params.payload,
      executionDetails: {
        command: params.command,
        targetContainer: params.targetContainer,
        stdout: params.stdout,
        stderr: params.stderr,
        exitCode: params.exitCode ?? (isFailure ? 1 : 0),
        durationMs: params.durationMs,
      },
      error: errorDetails,
    });
  }

  /**
   * Specialized helper for state change events (container start/stop/reboot, config update, stack merge).
   */
  public logStateChange(params: {
    message: string;
    entityId?: string;
    previousState?: unknown;
    nextState?: unknown;
    source?: string;
    level?: LogLevel;
  }): StructuredLogEntry {
    return this.log({
      level: params.level || 'INFO',
      eventType: 'STATE_CHANGE',
      source: params.source || 'state-manager',
      message: params.message,
      payload: {
        entityId: params.entityId,
        previousState: params.previousState,
        nextState: params.nextState,
      },
    });
  }

  /**
   * Truncate huge payloads to prevent log bloat while keeping valuable debugging data.
   */
  private truncateLargePayload(payload: unknown): unknown {
    try {
      const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
      if (str.length > 50000) {
        return {
          truncated: true,
          originalSize: str.length,
          preview: str.substring(0, 5000) + '... [TRUNCATED FOR LOG ENGINE]',
        };
      }
      return payload;
    } catch {
      return '[Unserializable Payload]';
    }
  }

  /**
   * Non-blocking sequential disk writer for rolling JSONL files.
   */
  private queueLogWrite(entry: StructuredLogEntry): void {
    const serializedLine = JSON.stringify(entry) + '\n';
    this.writeQueue.push(serializedLine);
    this.processWriteQueue();
  }

  private processWriteQueue(): void {
    if (this.isWriting || this.writeQueue.length === 0) return;
    this.isWriting = true;

    const linesToWrite = this.writeQueue.splice(0, 50).join('');
    const targetFile = this.getDailyLogFilePath();

    fs.appendFile(targetFile, linesToWrite, 'utf8', (err) => {
      this.isWriting = false;
      if (err) {
        console.error(`[GlobalLogService] Error writing to log file ${targetFile}:`, err);
      }
      if (this.writeQueue.length > 0) {
        setImmediate(() => this.processWriteQueue());
      }
    });
  }

  /**
   * Read and parse logs from disk into the in-memory buffer on startup.
   */
  private loadRecentLogsIntoMemory(): void {
    try {
      const files = fs.readdirSync(this.logDirectory)
        .filter((f) => f.startsWith('system-') && f.endsWith('.jsonl'))
        .sort()
        .reverse();

      const loaded: StructuredLogEntry[] = [];
      const seenIds = new Set<string>();

      for (const file of files) {
        if (loaded.length >= this.maxMemoryBuffer) break;
        const filePath = path.join(this.logDirectory, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter((l) => l.trim().length > 0);

        for (let i = lines.length - 1; i >= 0; i--) {
          if (loaded.length >= this.maxMemoryBuffer) break;
          try {
            const parsed = JSON.parse(lines[i]) as StructuredLogEntry;
            if (parsed && parsed.id && !seenIds.has(parsed.id)) {
              seenIds.add(parsed.id);
              loaded.push(parsed);
            }
          } catch {
            // Ignore malformed line
          }
        }
      }

      this.memoryBuffer = loaded;
    } catch (err) {
      console.warn('[GlobalLogService] Unable to preload previous logs from disk:', err);
    }
  }

  /**
   * Query structured logs with date filtering, level filtering, event type filtering, and text search.
   */
  public queryLogs(options: LogFilterOptions = {}): LogQueryResult {
    const {
      startDate,
      endDate,
      level = 'ALL',
      eventType = 'ALL',
      search = '',
      limit = 500,
      offset = 0,
    } = options;

    let filtered = [...this.memoryBuffer];

    // Filter by Date Range
    if (startDate) {
      const startMs = new Date(startDate).getTime();
      if (!isNaN(startMs)) {
        filtered = filtered.filter((l) => new Date(l.timestamp).getTime() >= startMs);
      }
    }

    if (endDate) {
      const endMs = new Date(endDate).getTime();
      if (!isNaN(endMs)) {
        filtered = filtered.filter((l) => new Date(l.timestamp).getTime() <= endMs);
      }
    }

    // Filter by Severity Level
    if (level && level !== 'ALL') {
      filtered = filtered.filter((l) => l.level === level);
    }

    // Filter by Event Type
    if (eventType && eventType !== 'ALL') {
      filtered = filtered.filter((l) => l.eventType === eventType);
    }

    // Filter by Robust Text Search
    if (search && search.trim().length > 0) {
      const query = search.trim().toLowerCase();
      filtered = filtered.filter((l) => {
        if (l.message.toLowerCase().includes(query)) return true;
        if (l.source.toLowerCase().includes(query)) return true;
        if (l.eventType.toLowerCase().includes(query)) return true;
        if (l.level.toLowerCase().includes(query)) return true;
        if (l.metadata?.route && String(l.metadata.route).toLowerCase().includes(query)) return true;
        if (l.executionDetails?.command && l.executionDetails.command.toLowerCase().includes(query)) return true;
        if (l.executionDetails?.targetContainer && l.executionDetails.targetContainer.toLowerCase().includes(query)) return true;
        if (l.executionDetails?.stdout && l.executionDetails.stdout.toLowerCase().includes(query)) return true;
        if (l.executionDetails?.stderr && l.executionDetails.stderr.toLowerCase().includes(query)) return true;
        if (l.error?.message && l.error.message.toLowerCase().includes(query)) return true;
        if (l.error?.stack && l.error.stack.toLowerCase().includes(query)) return true;
        if (l.payload) {
          try {
            const payloadStr = JSON.stringify(l.payload).toLowerCase();
            if (payloadStr.includes(query)) return true;
          } catch {
            // Ignore stringify error
          }
        }
        return false;
      });
    }

    const totalCount = this.memoryBuffer.length;
    const filteredCount = filtered.length;

    // Defensively ensure returned slice is strictly unique by ID
    const seenSliceIds = new Set<string>();
    const paginated: StructuredLogEntry[] = [];
    for (const item of filtered.slice(offset, offset + limit)) {
      if (!seenSliceIds.has(item.id)) {
        seenSliceIds.add(item.id);
        paginated.push(item);
      }
    }

    const logFiles = this.getLogFilesList();

    return {
      logs: paginated,
      total: totalCount,
      filteredCount,
      logFilesCount: logFiles.length,
      activeLogFile: this.getDailyLogFileName(),
      storageDir: this.logDirectory,
    };
  }

  /**
   * List all rolling log files present in /app/logs.
   */
  public getLogFilesList(): { filename: string; sizeBytes: number; modifiedAt: string }[] {
    try {
      const files = fs.readdirSync(this.logDirectory)
        .filter((f) => f.startsWith('system-') && f.endsWith('.jsonl'))
        .map((f) => {
          const filePath = path.join(this.logDirectory, f);
          const stats = fs.statSync(filePath);
          return {
            filename: f,
            sizeBytes: stats.size,
            modifiedAt: stats.mtime.toISOString(),
          };
        })
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

      return files;
    } catch {
      return [];
    }
  }

  /**
   * Export logs matching criteria as a complete JSON dataset.
   */
  public exportLogs(options: LogFilterOptions = {}): StructuredLogEntry[] {
    const result = this.queryLogs({ ...options, limit: 100000, offset: 0 });
    return result.logs;
  }

  /**
   * Clear all log files and in-memory buffer with safety confirmation.
   */
  public clearAllLogs(): { success: boolean; clearedFilesCount: number; message: string } {
    let count = 0;
    try {
      const files = fs.readdirSync(this.logDirectory)
        .filter((f) => f.startsWith('system-') && f.endsWith('.jsonl'));

      for (const file of files) {
        fs.unlinkSync(path.join(this.logDirectory, file));
        count++;
      }

      this.memoryBuffer = [];
      this.writeQueue = [];

      this.log({
        level: 'WARN',
        eventType: 'SYSTEM',
        source: 'GlobalLogService',
        message: `Audit log repository cleared by user request. Removed ${count} archived log files.`,
        payload: { clearedFilesCount: count, directory: this.logDirectory },
      });

      return {
        success: true,
        clearedFilesCount: count,
        message: `Successfully cleared ${count} log file(s) from ${this.logDirectory}.`,
      };
    } catch (err) {
      return {
        success: false,
        clearedFilesCount: count,
        message: `Error clearing logs: ${(err as Error).message}`,
      };
    }
  }
}

export const globalLogService = GlobalLogService.getInstance();
