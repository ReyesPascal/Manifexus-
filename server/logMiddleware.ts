import { Request, Response, NextFunction } from 'express';
import { globalLogService } from './globalLogService';

/**
 * Express Middleware that intercepts incoming HTTP requests and outgoing responses,
 * capturing the route, HTTP method, client IP, user agent, request payload,
 * response status code, and precise execution time in milliseconds.
 */
export function expressLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Ignore noisy static asset requests or Vite HMR/internal pings if applicable
  if (
    req.path.startsWith('/@vite') ||
    req.path.startsWith('/@fs') ||
    req.path.startsWith('/node_modules') ||
    req.path.endsWith('.hot-update.json') ||
    req.path.endsWith('.map') ||
    req.path === '/favicon.ico'
  ) {
    return next();
  }

  const startTime = process.hrtime();
  const startIso = new Date().toISOString();

  // Capture a safe copy of the request payload
  let capturedReqBody: unknown = undefined;
  if (req.body && Object.keys(req.body).length > 0) {
    // Clone and sanitize sensitive credentials if present
    try {
      capturedReqBody = sanitizePayload(req.body);
    } catch {
      capturedReqBody = '[Body serialization error]';
    }
  }

  // Intercept response send/json to capture response summary if needed
  let capturedResBody: unknown = undefined;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = function (body: unknown): Response {
    capturedResBody = body;
    return originalJson(body);
  };

  res.send = function (body: unknown): Response {
    if (typeof body === 'string') {
      try {
        capturedResBody = JSON.parse(body);
      } catch {
        capturedResBody = body.length > 500 ? `${body.substring(0, 500)}...` : body;
      }
    } else {
      capturedResBody = body;
    }
    return originalSend(body);
  };

  // Intercept the 'finish' event to measure precise millisecond elapsed time
  res.on('finish', () => {
    const diff = process.hrtime(startTime);
    const durationMs = (diff[0] * 1e3) + (diff[1] * 1e-6);

    // Skip self-logging polling log fetches to prevent feedback loops, unless it's a mutation/clear
    const isLogPoll = req.path.startsWith('/api/logs') && req.method === 'GET' && !req.query.verbose;
    if (isLogPoll) {
      return;
    }

    const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    globalLogService.logApiCall({
      method: req.method,
      route: req.originalUrl || req.path,
      statusCode: res.statusCode,
      durationMs,
      requestBody: capturedReqBody,
      responseBody: sanitizePayload(capturedResBody),
      ip: clientIp,
      userAgent,
    });
  });

  next();
}

/**
 * Strips potential sensitive keys (passwords, tokens, secret keys) from logged payloads.
 */
function sanitizePayload(data: unknown): unknown {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.slice(0, 100).map(sanitizePayload);
  }

  const sensitiveKeys = new Set([
    'password',
    'secret',
    'token',
    'authorization',
    'apiKey',
    'privateKey',
    'credential',
    'cookie',
  ]);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (sensitiveKeys.has(key.toLowerCase())) {
      sanitized[key] = '***REDACTED***';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizePayload(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
