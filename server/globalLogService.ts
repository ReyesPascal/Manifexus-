/**
 * Compatibility layer: older call sites log through this; everything is forwarded to the
 * activity log (server/activityLog.ts), so it lands in the right activity with full context.
 */
import { record, type Category, type Level } from './activityLog';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
export type LogEventType = 'API_CALL' | 'DOCKER_EXEC' | 'STATE_CHANGE' | 'SYSTEM' | 'AUTH' | 'STACK_OP';

const LEVEL: Record<string, Level> = { DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error', CRITICAL: 'error' };

function category(eventType?: string, source?: string): Category {
  if (source && /update/i.test(source)) return 'update';
  if (source && /backup/i.test(source)) return 'backup';
  switch (eventType) {
    case 'STACK_OP':
      return 'stack';
    case 'DOCKER_EXEC':
      return 'docker';
    case 'API_CALL':
      return 'api';
    case 'STATE_CHANGE':
      return 'container';
    default:
      return 'system';
  }
}

interface LogInput {
  level: LogLevel | Lowercase<LogLevel> | string;
  eventType?: LogEventType | string;
  source?: string;
  message: string;
  payload?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export const globalLogService = {
  log(entry: LogInput): void {
    const lvl = LEVEL[String(entry.level).toUpperCase()] || 'info';
    const data: Record<string, unknown> = {};
    if (entry.payload !== undefined) data.payload = entry.payload;
    if (entry.error !== undefined) data.error = entry.error instanceof Error ? { message: entry.error.message, stack: entry.error.stack } : entry.error;
    if (entry.source) data.source = entry.source;
    record(lvl, category(entry.eventType, entry.source), entry.message, Object.keys(data).length ? data : undefined);
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
    const lvl = params.level ? LEVEL[params.level] || 'info' : failed ? 'warn' : 'debug';
    const { error, ...rest } = params;
    record(lvl, 'docker', params.message || params.command, {
      ...rest,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
  },
  logStateChange(params: { message: string; source?: string; level?: LogLevel; [key: string]: unknown }): void {
    record(params.level ? LEVEL[params.level] || 'info' : 'info', 'container', params.message, params);
  },
};
