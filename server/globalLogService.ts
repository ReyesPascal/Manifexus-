/**
 * Minimal internal logger.
 *
 * Manifexus no longer has a Logs screen or keeps log files. Warnings and errors are written to
 * stdout/stderr so they show up in `docker logs manifexus`; routine info is dropped unless
 * MANIFEXUS_DEBUG=1 is set. The method shapes are kept so existing call sites don't change.
 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
export type LogEventType = 'API_CALL' | 'DOCKER_EXEC' | 'STATE_CHANGE' | 'SYSTEM' | 'AUTH' | 'STACK_OP';

interface LogInput {
  level: LogLevel;
  eventType?: LogEventType;
  source?: string;
  message: string;
  payload?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

const DEBUG = process.env.MANIFEXUS_DEBUG === '1' || process.env.MANIFEXUS_DEBUG === 'true';

function write(level: LogLevel, source: string | undefined, message: string, error?: unknown): void {
  const important = level === 'WARN' || level === 'ERROR' || level === 'CRITICAL';
  if (!important && !DEBUG) return;
  const line = `[${new Date().toISOString()}] ${level}${source ? ` ${source}` : ''}: ${message}`;
  const detail = error instanceof Error ? ` (${error.message})` : error ? ` (${String((error as { message?: unknown }).message ?? error)})` : '';
  if (level === 'ERROR' || level === 'CRITICAL') console.error(line + detail);
  else console.log(line + detail);
}

export const globalLogService = {
  log(entry: LogInput): void {
    write(entry.level, entry.source, entry.message, entry.error);
  },
  logDockerExec(params: {
    command: string;
    targetContainer?: string;
    exitCode?: number;
    level?: LogLevel;
    message?: string;
    error?: unknown;
    [key: string]: unknown;
  }): void {
    const failed = (params.exitCode !== undefined && params.exitCode !== 0) || Boolean(params.error);
    write(params.level || (failed ? 'WARN' : 'DEBUG'), 'docker', params.message || params.command, params.error);
  },
  logStateChange(params: { message: string; source?: string; level?: LogLevel; [key: string]: unknown }): void {
    write(params.level || 'INFO', params.source, params.message);
  },
};
