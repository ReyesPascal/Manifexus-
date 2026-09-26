import fs from 'fs';
import path from 'path';
import { sysLog } from './systemLogService';

export interface DiagnosticMicroStep {
  stepIndex: number;
  stepId: string;
  stepName: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  timestamp: string;
  durationMs?: number;
  logs: string[];
  metadata?: Record<string, unknown>;
}

export interface DiagnosticBundle {
  installId: string;
  timestamp: string;
  completedAt?: string;
  deploymentType: 'new-stack' | 'existing-stack';
  targetStackName: string;
  targetPath: string;
  sourceUrl: string;
  initialAstSnapshot?: Record<string, unknown> | null;
  fetchedRemoteAst?: Record<string, unknown> | null;
  finalMergedAst?: Record<string, unknown> | null;
  fileWriteBytes?: number;
  targetComposePath?: string;
  dockerExecutionCommand?: string;
  cwd?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  success: boolean;
  errorStackTrace?: string | null;
  microSteps: DiagnosticMicroStep[];
  systemEnvironment: {
    nodeEnv: string;
    dockerSocket: string;
    hostRoot: string;
    logsDir: string;
    platform: string;
  };
}

// In-memory cache for fast lookups
const bundlesCache = new Map<string, DiagnosticBundle>();

/**
 * Resolve directory for storing diagnostic JSON bundles
 */
export function resolveDiagnosticsDir(): string {
  const baseLogsDir = process.env.LOGS_DIR || (fs.existsSync('/app/logs') ? '/app/logs' : path.resolve(process.cwd(), 'logs'));
  const diagDir = path.join(baseLogsDir, 'diagnostics');
  try {
    if (!fs.existsSync(diagDir)) {
      fs.mkdirSync(diagDir, { recursive: true });
    }
  } catch (err) {
    console.error('[Diagnostics] Failed to create diagnostics directory:', err);
  }
  return diagDir;
}

/**
 * Creates and initializes a new DiagnosticBundle
 */
export function createDiagnosticBundle(params: {
  installId: string;
  deploymentType: 'new-stack' | 'existing-stack';
  targetStackName: string;
  targetPath: string;
  sourceUrl: string;
}): DiagnosticBundle {
  const diagDir = resolveDiagnosticsDir();
  const bundle: DiagnosticBundle = {
    installId: params.installId,
    timestamp: new Date().toISOString(),
    deploymentType: params.deploymentType,
    targetStackName: params.targetStackName,
    targetPath: params.targetPath,
    sourceUrl: params.sourceUrl,
    initialAstSnapshot: null,
    fetchedRemoteAst: null,
    finalMergedAst: null,
    fileWriteBytes: 0,
    targetComposePath: path.join(params.targetPath, 'docker-compose.yml'),
    dockerExecutionCommand: '',
    cwd: params.targetPath,
    stdout: '',
    stderr: '',
    exitCode: undefined,
    success: false,
    errorStackTrace: null,
    microSteps: [],
    systemEnvironment: {
      nodeEnv: process.env.NODE_ENV || 'production',
      dockerSocket: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
      hostRoot: process.env.HOST_ROOT || '/host',
      logsDir: diagDir,
      platform: process.platform,
    },
  };

  bundlesCache.set(params.installId, bundle);
  return bundle;
}

/**
 * Record a micro-step update into the running diagnostic bundle
 */
export function recordMicroStep(
  bundle: DiagnosticBundle,
  step: {
    stepIndex: number;
    stepId: string;
    stepName: string;
    status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
    durationMs?: number;
    log?: string;
    metadata?: Record<string, unknown>;
  }
): void {
  let existing = bundle.microSteps.find((s) => s.stepIndex === step.stepIndex);
  if (!existing) {
    existing = {
      stepIndex: step.stepIndex,
      stepId: step.stepId,
      stepName: step.stepName,
      status: step.status,
      timestamp: new Date().toISOString(),
      durationMs: step.durationMs,
      logs: step.log ? [step.log] : [],
      metadata: step.metadata,
    };
    bundle.microSteps.push(existing);
  } else {
    existing.status = step.status;
    if (step.durationMs !== undefined) existing.durationMs = step.durationMs;
    if (step.log) existing.logs.push(step.log);
    if (step.metadata) {
      existing.metadata = { ...(existing.metadata || {}), ...step.metadata };
    }
  }

  // Update in-memory cache
  bundlesCache.set(bundle.installId, bundle);
}

/**
 * Write the complete DiagnosticBundle to disk in the Manifexus log directory
 */
export function saveDiagnosticBundleToDisk(bundle: DiagnosticBundle): string {
  try {
    const diagDir = resolveDiagnosticsDir();
    const filePath = path.join(diagDir, `diagnostic_${bundle.installId}.json`);
    const latestPath = path.join(diagDir, 'latest.json');

    const jsonString = JSON.stringify(bundle, null, 2);
    fs.writeFileSync(filePath, jsonString, 'utf-8');
    fs.writeFileSync(latestPath, jsonString, 'utf-8');

    sysLog.info('system', `Diagnostic bundle saved to disk for [${bundle.installId}]`, {
      path: filePath,
      deploymentType: bundle.deploymentType,
      success: bundle.success,
      fileWriteBytes: bundle.fileWriteBytes,
      microStepCount: bundle.microSteps.length,
    });

    return filePath;
  } catch (err) {
    console.error(`[Diagnostics] Failed to save bundle for ${bundle.installId}:`, err);
    return '';
  }
}

/**
 * Retrieve a DiagnosticBundle by installId
 */
export function getDiagnosticBundle(installId: string): DiagnosticBundle | null {
  if (bundlesCache.has(installId)) {
    return bundlesCache.get(installId)!;
  }

  const diagDir = resolveDiagnosticsDir();
  const filePath = path.join(diagDir, `diagnostic_${installId}.json`);

  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content) as DiagnosticBundle;
      bundlesCache.set(installId, parsed);
      return parsed;
    }
  } catch (err) {
    console.error(`[Diagnostics] Failed to read diagnostic file ${filePath}:`, err);
  }

  return null;
}

/**
 * List recent diagnostic bundles
 */
export function listRecentDiagnosticBundles(): {
  installId: string;
  timestamp: string;
  deploymentType: string;
  targetStackName: string;
  success: boolean;
}[] {
  const diagDir = resolveDiagnosticsDir();
  const results: {
    installId: string;
    timestamp: string;
    deploymentType: string;
    targetStackName: string;
    success: boolean;
  }[] = [];

  try {
    if (fs.existsSync(diagDir)) {
      const files = fs.readdirSync(diagDir);
      for (const file of files) {
        if (file.startsWith('diagnostic_') && file.endsWith('.json')) {
          try {
            const raw = fs.readFileSync(path.join(diagDir, file), 'utf-8');
            const data = JSON.parse(raw) as DiagnosticBundle;
            results.push({
              installId: data.installId,
              timestamp: data.timestamp,
              deploymentType: data.deploymentType,
              targetStackName: data.targetStackName,
              success: data.success,
            });
          } catch {
            // ignore corrupt file
          }
        }
      }
    }
  } catch {
    // ignore
  }

  return results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}
