import {
  getStackDataFootprint,
  getBackupFreeBytes,
  provisionStackFolder,
  StackFolderExistsError,
} from './server/dataBackupService';
import express from 'express';
import http from 'http';
import path from 'path';
import {
  getContainersList,
  executeContainerAction,
  isDockerSocketAvailable,
  addDemoContainer,
  resolveAppIcon,
  mergeDemoContainersIntoStack,
  cleanupStoppedHelpers,
} from './server/dockerService';
import {
  getConfig,
  saveConfig,
  updateAppOverride,
} from './server/storageService';
import {
  generateStackMergePlan,
  collectSourceComposes,
  MergePlanRequest,
  isManifexusContainer,
  discoverHostComposeStacks,
  provisionEmptyStack,
  getDefaultHostStacksBaseDir,
  registerCreatedStack,
  deleteHostStack,
  EmptyComposeStack,
} from './server/stackService';
import {
  checkPrivilegeStatus,
  executeAutomatedStackMerge,
  generateElevateScript,
  executeStreamingPipeline,
  resolveHostPathToContainer,
} from './server/automationService';
import { readHostFile, createHostDirectory, writeHostFile, refreshSelfMounts } from './server/hostFsService';
import { globalLogService } from './server/globalLogService';
import {
  record,
  currentActivityId,
  setActivityTitle,
  finishActivity,
  pipelineRecorder,
  listActivities,
  getActivity,
  activityEvents,
  queryEvents,
  subscribe,
  getLogSettings,
  updateLogSettings,
  logStats,
  clearAllLogs,
  enforceRetention,
  closeStaleActivities,
  type Level,
  type Category,
  type ActivityStatus,
} from './server/activityLog';
import {
  requestTracker,
  activityBundle,
  activityMarkdown,
  eventsToCsv,
  environmentSnapshot,
  watchDockerEvents,
  recordStartup,
} from './server/observability';
import { setupTerminalWebSocket } from './server/terminalService';
import {
  listRestorePoints,
  getRestorePoint,
  planRestore,
  executeRestore,
  setPinned,
  deleteChanges,
  clearArchive,
  getRestoreSettings,
  updateRestoreSettings,
  enforceBackupRetention,
  listBackupFiles,
  streamBackupFile,
  streamBackupArchive,
  restoreToFolder,
  freshStartOnce,
} from './server/restoreService';
import { systemDiagnostics, systemReport, appDiagnostics, appLogs } from './server/diagnosticsService';
import { getSystemSpecs } from './server/systemSpecs';
import { aiStatus, saveAiSettings, installModel, installBundle as installAiBundle, cancelDownload, removeModel, warmUpEngine, catalogModel, stopEngine, installEngineNow } from './server/aiService';
import { chat as aiChat, runPlan, getPlan, warm as aiWarm, planFromActions } from './server/aiAgent';
import { describeFix, autoFixActions, FixContext } from './server/fixCatalog';
import type { Check } from './server/diagnosticsService';
import { learnActivity, recentCommands } from './server/commandLog';
import { seedAiExample } from './server/aiExample';
import { refreshIdentity, webInfo, projectInfo, iconUrl as appIconUrl, iconSource, iconFile, forgetIcon, setHostCandidates, friendlyName } from './server/appIdentity';
import {
  getSoftwareUpdateState,
  checkForUpdate,
  updateSettings,
  installUpdate,
  startUpdateScheduler,
  pendingUpdateActivityId,
  getSelf,
} from './server/updateService';
import fs from 'fs';
import { DeepContainerMetadata } from './src/types';

async function startServer() {
  const app = express();
  // In the production Docker container deployed on your host, it listens on PORT (3334),
  // binding strictly to 3334:3334 on your host and leaving host port 3000 100% free for apps like nzbdav.
  // In the AI Studio cloud sandbox dev preview, it binds to 3000 as required by the reverse proxy.
  const PORT = process.env.MANIFEXUS_DOCKER === 'true'
    ? parseInt(process.env.PORT || '3334', 10)
    : (process.env.NODE_ENV === 'production' && process.env.PORT && process.env.PORT !== '8080')
      ? parseInt(process.env.PORT, 10)
      : 3000;

  app.use(express.json({ limit: '5mb' }));
  // Every API request is recorded; user actions become Activities with everything underneath attached
  app.use(requestTracker);

  // Errors thrown by async route handlers go to the error handler at the end (a 500 with the message,
  // recorded in Activity) instead of leaving the request hanging
  for (const method of ['get', 'post', 'put', 'delete'] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const register = (app as any)[method].bind(app) as (...args: any[]) => unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any)[method] = (...args: any[]) => {
      if (args.length < 2) return register(...args); // app.get('setting')
      const [route, ...handlers] = args;
      return register(
        route,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...handlers.map((h: any) =>
          typeof h === 'function' && h.length < 4
            ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (req: any, res: any, next: any) => {
                try {
                  const out = h(req, res, next);
                  if (out && typeof out.catch === 'function') out.catch(next);
                } catch (err) {
                  next(err);
                }
              }
            : h
        )
      );
    };
  }

  // API Routes FIRST

  // ==========================================================================
  // Activity log API
  // ==========================================================================
  const csv = (v: unknown) => (typeof v === 'string' && v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  const eventQueryFrom = (q: Record<string, unknown>) => ({
    levels: csv(q.levels) as Level[] | undefined,
    categories: csv(q.categories) as Category[] | undefined,
    search: typeof q.search === 'string' ? q.search : undefined,
    activityId: typeof q.activity === 'string' ? q.activity : undefined,
    since: typeof q.since === 'string' ? q.since : undefined,
    until: typeof q.until === 'string' ? q.until : undefined,
    before: typeof q.before === 'string' ? q.before : undefined,
  });

  app.get('/api/logs/activities', (req, res) => {
    res.json(
      listActivities({
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        types: csv(req.query.types),
        statuses: csv(req.query.statuses) as ActivityStatus[] | undefined,
        before: typeof req.query.before === 'string' ? req.query.before : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      })
    );
  });

  // Learn how it was done: an activity's steps with the commands behind them, and every recent command
  app.get('/api/learn/activities/:id', async (req, res) => {
    const l = await learnActivity(req.params.id);
    if (!l) return res.status(404).json({ error: 'That activity isn’t in the log anymore.' });
    res.json(l);
  });
  app.get('/api/learn/commands', async (req, res) => res.json({ commands: await recentCommands(Math.min(400, Number(req.query.limit) || 150)) }));

  app.get('/api/logs/activities/:id', async (req, res) => {
    const a = getActivity(req.params.id);
    if (!a) return res.status(404).json({ error: 'Activity not found. It may have been removed by log retention.' });
    const bundle = await activityBundle(a.id);
    res.json(bundle);
  });

  app.get('/api/logs/activities/:id/export', async (req, res) => {
    const format = req.query.format === 'markdown' ? 'markdown' : 'json';
    const a = getActivity(req.params.id);
    if (!a) return res.status(404).json({ error: 'Activity not found.' });
    const stamp = a.startedAt.replace(/[:.]/g, '-').slice(0, 19);
    if (format === 'markdown') {
      const md = await activityMarkdown(a.id);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="manifexus-${a.type}-${stamp}.md"`);
      return res.send(md);
    }
    res.setHeader('Content-Disposition', `attachment; filename="manifexus-${a.type}-${stamp}.json"`);
    res.json(await activityBundle(a.id));
  });

  app.get('/api/logs/events', async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 300;
    res.json(await queryEvents({ ...eventQueryFrom(req.query as Record<string, unknown>), limit }));
  });

  app.get('/api/logs/events/export', async (req, res) => {
    const format = req.query.format === 'csv' ? 'csv' : 'jsonl';
    const { events } = await queryEvents({ ...eventQueryFrom(req.query as Record<string, unknown>), limit: 200000 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Disposition', `attachment; filename="manifexus-events-${stamp}.${format}"`);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send(eventsToCsv(events.reverse()));
    }
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.send(events.reverse().map((e) => JSON.stringify(e)).join('\n') + '\n');
  });

  // Live tail (Server-Sent Events): new events and activity changes as they happen
  app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // @ts-ignore
    if (res.flushHeaders) res.flushHeaders();
    // A client that stops reading gets disconnected (it reconnects by itself) rather than buffering forever
    let unsubscribe = () => {};
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    const close = () => {
      clearInterval(ping);
      unsubscribe();
    };
    unsubscribe = subscribe((msg) => {
      if (res.writableLength > 4 * 1024 * 1024) {
        close();
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    });
    req.on('close', close);
  });

  app.get('/api/logs/settings', (req, res) => res.json(getLogSettings()));
  app.post('/api/logs/settings', (req, res) => res.json(updateLogSettings(req.body || {})));

  app.get('/api/logs/stats', (req, res) => res.json(logStats()));

  app.get('/api/logs/environment', async (req, res) => res.json(await environmentSnapshot(true)));

  app.post('/api/logs/clear', (req, res) => {
    clearAllLogs();
    res.json({ ok: true });
  });

  // Errors from the dashboard itself (JavaScript errors, failed requests)
  app.post('/api/logs/client', (req, res) => {
    const b = req.body || {};
    record(b.level === 'warn' ? 'warn' : 'error', 'ui', String(b.message || 'Dashboard error').slice(0, 2000), {
      stack: b.stack,
      url: b.url,
      component: b.component,
      userAgent: req.get('user-agent'),
    }, { activityId: null });
    res.json({ ok: true });
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // System status
  app.get('/api/status', async (req, res) => {
    try {
      const socketPath = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
      const available = isDockerSocketAvailable();
      const { containers, isDemo, dockerVersion, os } = await getContainersList();
      const emptyStacks = await discoverHostComposeStacks(containers);

      // Count what the dashboard shows: not Manifexus itself, not apps hidden in Settings
      const config = getConfig();
      const apps = containers.filter((c) => {
        if (isManifexusContainer(c)) return false;
        const o = config.appOverrides[c.id] || config.appOverrides[c.cleanName] || {};
        return !o.isHidden;
      });
      const runningCount = apps.filter((c) => c.state === 'running').length;
      const stoppedCount = apps.length - runningCount;
      const stackNames = new Set(
        [
          ...apps.filter((c) => c.compose?.isCompose && c.compose.project).map((c) => c.compose.project as string),
          ...emptyStacks.map((s) => s.project),
        ].filter((p) => p.toLowerCase() !== 'manifexus')
      );
      const stacks = stackNames.size;

      res.json({
        dockerConnected: available && !isDemo,
        isDemoMode: isDemo,
        socketPath,
        dockerVersion: dockerVersion || 'Unknown',
        operatingSystem: os || 'Linux',
        serverTime: new Date().toISOString(),
        totalContainers: apps.length,
        runningContainers: runningCount,
        stoppedContainers: stoppedCount,
        composeStacksCount: stacks,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Addresses that reach published ports from inside Manifexus: its network gateways and the host address
  let hostsAt = 0;
  const identityHosts = async () => {
    if (Date.now() - hostsAt < 10 * 60 * 1000) return;
    hostsAt = Date.now();
    const self = await getSelf().catch(() => null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nets = Object.values((self?.inspect as any)?.NetworkSettings?.Networks || {}) as { Gateway?: string }[];
    const host = getConfig().hostAddress;
    setHostCandidates([...nets.map((n) => n.Gateway || ''), 'host.docker.internal', host && host !== 'localhost' ? host : '', '127.0.0.1']);
  };

  // App icons found by Manifexus (saved in /data/apps/icons)
  app.get('/api/apps/icons/:file', (req, res) => {
    const f = iconFile(req.params.file);
    if (!f) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    if (f.endsWith('.svg')) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.sendFile(f);
  });
  // Look for an app's icon again
  app.post('/api/apps/:id/icon/refresh', async (req, res) => {
    const { containers } = await getContainersList();
    const c = containers.find((x) => x.id === req.params.id || x.cleanName === req.params.id);
    if (!c) return res.status(404).json({ error: 'No such app.' });
    forgetIcon(c);
    refreshIdentity([c]);
    res.json({ ok: true });
  });

  // Get containers list enriched with user customizations and discovered empty compose stacks
  app.get('/api/containers', async (req, res) => {
    try {
      const { containers, isDemo, dockerVersion, os } = await getContainersList();
      const config = getConfig();
      const emptyStacks = await discoverHostComposeStacks(containers);

      // Merge user overrides (custom group, custom name, custom port, custom icon, custom URL, hidden status)
      const enriched: DeepContainerMetadata[] = containers.map((c) => {
        const key = c.id;
        const nameKey = c.cleanName;
        const override = config.appOverrides[key] || config.appOverrides[nameKey] || {};

        const web = webInfo(c);
        const chosen = override.customPort && c.ports.some((p) => p.publicPort === override.customPort) ? override.customPort : undefined;
        const webPort = chosen || web.port;
        const project = projectInfo(c);
        return {
          ...c,
          customName: override.customName || undefined,
          customGroup: override.customGroup || undefined,
          customUrl: override.customUrl || undefined,
          iconUrl: override.customIcon || appIconUrl(c) || c.iconUrl,
          iconSource: override.customIcon ? 'yours' : iconSource(c),
          primaryPort: webPort || override.customPort || c.primaryPort,
          friendlyName: friendlyName(c, web.title),
          webPort,
          otherWebPorts: [...(chosen && web.port && web.port !== chosen ? [web.port] : []), ...web.others].filter((p) => p !== webPort),
          hasWeb: chosen ? true : web.hasWeb,
          project: project ? { url: project.url, repo: project.repo, latest: project.latest, imageSource: project.imageSource } : undefined,
          notes: override.notes || undefined,
          isHidden: override.isHidden || false,
        };
      });

      // Look up web pages, project pages and icons in the background; they show on the next refresh
      void identityHosts().then(() => refreshIdentity(containers.filter((c) => !isManifexusContainer(c))));

      res.json({
        containers: enriched,
        emptyStacks,
        defaultStacksDir: getDefaultHostStacksBaseDir(containers),
        isDemo,
        dockerVersion,
        os,
        hostAddress: config.hostAddress || 'localhost',
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Container lifecycle actions (start, stop, restart)
  app.post('/api/containers/:id/action', async (req, res) => {
    const { id } = req.params;
    const { action } = req.body;

    if (!action || !['start', 'stop', 'restart'].includes(action)) {
      return res.status(400).json({ error: 'Valid action required: start, stop, restart' });
    }

    try {
      const target = (await getContainersList()).containers.find((c) => c.id === id || c.cleanName === id);
      if (target) setActivityTitle(`${action.charAt(0).toUpperCase()}${action.slice(1)} ${target.customName || target.cleanName}`);
      const result = await executeContainerAction(id, action);
      // A failed action is an error for the caller and for Activity, not a 200 with success: false
      if (!result.success) return res.status(502).json({ ...result, error: result.message });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Save app customization override (assign group, custom name, custom port, etc.)
  app.put('/api/containers/:id/override', (req, res) => {
    const { id } = req.params;
    const override = req.body;

    try {
      const updatedConfig = updateAppOverride(id, override);
      res.json({ success: true, config: updatedConfig });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get full user configuration (groups, overrides, host settings)
  app.get('/api/config', (req, res) => {
    try {
      const config = getConfig();
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Save/update user configuration
  app.post('/api/config', (req, res) => {
    try {
      if (typeof req.body?.stacksDir === 'string') {
        const dir = req.body.stacksDir.trim().replace(/\/+$/, '');
        if (dir && !dir.startsWith('/')) {
          return res.status(400).json({ error: 'The stack location must be a full path starting with /.' });
        }
        req.body.stacksDir = dir;
      }
      const updated = saveConfig(req.body);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Add / Edit Group
  app.post('/api/groups', (req, res) => {
    try {
      const config = getConfig();
      const newGroup = req.body;
      if (!newGroup.id || !newGroup.name) {
        return res.status(400).json({ error: 'Group id and name are required' });
      }

      const existingIndex = config.groups.findIndex((g) => g.id === newGroup.id);
      let updatedGroups = [...config.groups];

      if (existingIndex >= 0) {
        updatedGroups[existingIndex] = { ...updatedGroups[existingIndex], ...newGroup };
      } else {
        updatedGroups.push({
          ...newGroup,
          color: newGroup.color || '#06b6d4',
          icon: newGroup.icon || 'Folder',
          order: updatedGroups.length + 1,
        });
      }

      const saved = saveConfig({ groups: updatedGroups });
      res.json({ success: true, groups: saved.groups });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Delete Group
  app.delete('/api/groups/:id', (req, res) => {
    try {
      const config = getConfig();
      const { id } = req.params;
      const updatedGroups = config.groups.filter((g) => g.id !== id);

      // Clean up app overrides pointing to this group
      const appOverrides = { ...config.appOverrides };
      for (const [key, ov] of Object.entries(appOverrides)) {
        if (ov.customGroup === id) {
          delete ov.customGroup;
        }
      }

      const saved = saveConfig({ groups: updatedGroups, appOverrides });
      res.json({ success: true, groups: saved.groups });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Demo simulator helper: spawn a new simulated container in real-time
  app.post('/api/demo/simulate-new', (req, res) => {
    const { name, image, port, composeProject, serviceName } = req.body;
    const clean = (name || 'custom-app').toLowerCase().replace(/\s+/g, '-');
    const primaryPort = port ? parseInt(port, 10) : 8888;
    const randomHex = Math.random().toString(16).substring(2, 14);

    const isCompose = Boolean(composeProject);
    const mockContainer: DeepContainerMetadata = {
      id: randomHex,
      name: `/${clean}`,
      cleanName: clean,
      image: image || `${clean}:latest`,
      baseImage: image || `${clean}:latest`,
      state: 'running',
      status: 'Up Just now',
      created: Math.floor(Date.now() / 1000),
      ports: [
        {
          ip: '0.0.0.0',
          privatePort: primaryPort,
          publicPort: primaryPort,
          type: 'tcp',
        },
      ],
      primaryPort: primaryPort,
      mounts: [
        { type: 'bind', source: `/home/ubuntu/appdata/${clean}`, destination: '/data', rw: true },
      ],
      envVars: [
        { key: 'TZ', value: 'UTC', isSensitive: false },
        { key: 'PORT', value: String(primaryPort), isSensitive: false },
      ],
      labels: isCompose
        ? {
            'com.docker.compose.project': composeProject,
            'com.docker.compose.service': serviceName || clean,
            'com.docker.compose.project.working_dir': `/home/ubuntu/docker/${composeProject}`,
            'com.docker.compose.project.config_files': `/home/ubuntu/docker/${composeProject}/docker-compose.yml`,
          }
        : {},
      compose: {
        isCompose,
        project: composeProject,
        service: serviceName || clean,
        workingDir: isCompose ? `/home/ubuntu/docker/${composeProject}` : undefined,
        configFiles: isCompose ? `/home/ubuntu/docker/${composeProject}/docker-compose.yml` : undefined,
      },
      networks: isCompose ? [`${composeProject}_net`] : ['bridge'],
      ipAddress: `172.20.0.${Math.floor(Math.random() * 200) + 10}`,
      restartPolicy: 'unless-stopped',
      iconUrl: resolveAppIcon(clean, image || clean),
    };

    addDemoContainer(mockContainer);
    res.json({ success: true, container: mockContainer });
  });

  // Directive 1: Fix Physical Host Provisioning
  // Uses elevated createHostDirectory and writeHostFile to provision the physical host directory and baseline compose file
  app.post('/api/stacks/create', async (req, res) => {
    try {
      const { stackName, baseDir } = req.body;
      const sanitizedName = String(stackName || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/^-+|-+$/g, '');

      if (!sanitizedName || sanitizedName.length < 2) {
        return res.status(400).json({ error: 'A valid stackName is required (at least 2 alphanumeric characters, dashes, or underscores).' });
      }

      // A custom location must be a full path; otherwise we'd silently create it somewhere else
      if (baseDir !== undefined && baseDir !== null && String(baseDir).trim() !== '' && !String(baseDir).trim().startsWith('/')) {
        return res.status(400).json({ error: 'The location must be a full path starting with /, like /home/you/stacks.' });
      }
      const { containers } = await getContainersList();
      const resolvedBaseDir =
        baseDir && typeof baseDir === 'string' && baseDir.trim().startsWith('/')
          ? baseDir.trim().replace(/\/+$/, '') || '/'
          : getDefaultHostStacksBaseDir(containers);

      const targetHostDir = path.posix.join(resolvedBaseDir, sanitizedName);
      const composeFilePath = path.posix.join(targetHostDir, 'docker-compose.yml');

      // Create the folder and baseline compose file on the host, verified on disk
      try {
        await provisionStackFolder(targetHostDir, 'services: {}\n');
      } catch (provisionErr) {
        const status = provisionErr instanceof StackFolderExistsError ? 409 : 500;
        return res.status(status).json({ error: (provisionErr as Error).message });
      }
      const writeOk = true;

      const newStack: EmptyComposeStack = {
        project: sanitizedName,
        workingDir: targetHostDir,
        configFiles: composeFilePath,
        serviceCount: 0,
        source: 'provisioned',
      };

      // Register stack so discovery detects it immediately
      registerCreatedStack(newStack);

      globalLogService.log({
        eventType: 'STACK_OP',
        level: 'INFO',
        source: 'stackService',
        message: `Empty stack '${sanitizedName}' provisioned on physical host at ${targetHostDir} (write status: ${writeOk ? 'success' : 'fallback'})`,
        payload: {
          project: sanitizedName,
          workingDir: targetHostDir,
          configFiles: composeFilePath,
        },
      });

      res.status(201).json({
        success: true,
        message: `Stack '${sanitizedName}' successfully provisioned on host at ${targetHostDir}.`,
        stack: newStack,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Directive 4: Safe Delete Stack Feature
  // Archives compose file first, runs docker compose down -v --remove-orphans via Docker socket, deletes host directory, logs to ledger
  app.post('/api/stacks/delete', async (req, res) => {
    try {
      const { projectName, targetDirectory, skipDataBackup } = req.body;
      if (!projectName || typeof projectName !== 'string' || !projectName.trim()) {
        return res.status(400).json({ error: 'A valid projectName is required.' });
      }

      const result = await deleteHostStack({ projectName, targetDirectory, skipDataBackup: skipDataBackup === true });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Measure how much data backing up the given stacks would archive (folder + Compose-owned volumes),
  // plus free space in the backups location. Used by the delete and move-apps confirmations.
  app.post('/api/stacks/data-footprint', async (req, res) => {
    try {
      const stacks = Array.isArray(req.body?.stacks) ? req.body.stacks : [];
      const { containers, isDemo } = await getContainersList();
      const footprints = [];
      for (const st of stacks.slice(0, 20)) {
        const project = String(st?.project || '').trim();
        if (!project) continue;
        const stackContainers = containers.filter((c) => (c.compose?.project || '') === project);
        const workingDir =
          typeof st.workingDir === 'string' && st.workingDir.startsWith('/')
            ? st.workingDir
            : stackContainers[0]?.compose?.workingDir;
        if (isDemo) {
          footprints.push({ project, workingDir, directoryBytes: 0, volumes: [], externalMounts: [], totalBytes: 0 });
          continue;
        }
        footprints.push(
          await getStackDataFootprint({
            project,
            workingDir,
            bindMounts: stackContainers.flatMap((c) => c.mounts.filter((m) => m.type === 'bind').map((m) => m.source)),
          })
        );
      }
      res.json({ footprints, freeBytes: getBackupFreeBytes() });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Generate safe Docker Compose stack merge plan
  app.post('/api/stacks/plan-merge', async (req, res) => {
    try {
      const { sourceContainerIds, targetStackName, targetDirectory, mode, volumeHandling } = req.body as MergePlanRequest;

      if (!Array.isArray(sourceContainerIds) || sourceContainerIds.length === 0) {
        return res.status(400).json({ error: 'Please select at least one container or stack to merge.' });
      }

      const { containers } = await getContainersList();
      // Directive 1: Programmatically filter out Manifexus from all merge calculations
      const selectedContainers = containers
        .filter((c) => !isManifexusContainer(c))
        .filter((c) => sourceContainerIds.includes(c.id) || sourceContainerIds.includes(c.cleanName));

      if (selectedContainers.length === 0) {
        return res.status(404).json({ error: 'None of the selected containers were found (or Manifexus was excluded for system self-protection).' });
      }

      const targetDir =
        targetDirectory ||
        path.posix.join(getDefaultHostStacksBaseDir((await getContainersList()).containers), targetStackName || 'combined-stack');
      let existingComposeContent: string | undefined;

      // Directive 5: Check if target directory has existing docker-compose.yml for AST mutation
      const candidatePaths = [
        path.join(targetDir, 'docker-compose.yml'),
        path.join(targetDir, 'docker-compose.yaml'),
        path.join(targetDir, 'compose.yaml'),
      ];

      for (const cp of candidatePaths) {
        try {
          const content = await readHostFile(cp);
          if (content && content.trim().length > 0) {
            existingComposeContent = content;
            break;
          }
        } catch {
          // ignore
        }
      }

      const sourceComposes = await collectSourceComposes(selectedContainers);

      const plan = generateStackMergePlan(selectedContainers, {
        sourceComposes,
        allContainers: containers,
        sourceContainerIds,
        targetStackName: targetStackName || 'combined-stack',
        targetDirectory: targetDir,
        mode: existingComposeContent ? 'existing-stack' : (mode || 'new-stack'),
        volumeHandling: volumeHandling || 'preserve-absolute',
        existingComposeContent,
      });

      for (const b of plan.blockers || []) record('warn', 'step', `Blocked: ${b}`);
      for (const w of plan.warnings || []) record('info', 'step', `Heads up: ${w}`);
      record('info', 'step', `Planned compose for ${plan.targetStackName}`, {
        targetDirectory: plan.targetDirectory,
        mode: plan.mode,
        compose: plan.generatedComposeYaml,
        portConflicts: plan.portConflicts,
        volumes: plan.volumeSafetyAudit,
      });
      res.json(plan);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Directive 3: GitHub Actions-Style Live Streaming Pipeline Endpoint (SSE)
  app.post('/api/stacks/execute-merge-stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // @ts-ignore
    if (res.flushHeaders) res.flushHeaders();

    const recorder = pipelineRecorder(currentActivityId());
    const sendEvent = (data: any) => {
      recorder.onEvent(data);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const { sourceContainerIds, targetStackName, targetDirectory, yamlContent, backupData } = req.body;
      if (!Array.isArray(sourceContainerIds) || sourceContainerIds.length === 0) {
        sendEvent({ type: 'failed', log: 'Source container IDs required' });
        res.end();
        return;
      }

      // Execute the 7 sequential steps with real-time SSE streaming
      await executeStreamingPipeline(
        {
          targetStackName: targetStackName || 'combined-stack',
          targetDirectory:
            targetDirectory ||
            path.posix.join(getDefaultHostStacksBaseDir((await getContainersList()).containers), targetStackName || 'combined-stack'),
          yamlContent: yamlContent || '',
          sourceContainerIds,
          backupData: backupData !== false,
        },
        sendEvent
      );
    } catch (err) {
      sendEvent({ type: 'failed', log: (err as Error).message });
    } finally {
      recorder.finish();
      res.end();
    }
  });

  // Restore: every change keeps a backup and can be restored (with newer changes to the same stacks)
  app.get('/api/restore', (req, res) => {
    res.json(listRestorePoints());
  });

  app.get('/api/restore/settings', (req, res) => res.json(getRestoreSettings()));
  app.post('/api/restore/settings', (req, res) => {
    const s = updateRestoreSettings(req.body || {});
    enforceBackupRetention();
    res.json(s);
  });

  // Delete one or many changes with their backups (live stacks are never touched)
  app.post('/api/restore/delete', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: 'Nothing selected.' });
    res.json({ removed: deleteChanges(ids) });
  });

  app.post('/api/restore/archive/clear', (req, res) => {
    res.json({ removed: clearArchive(Array.isArray(req.body?.ids) ? req.body.ids : undefined) });
  });

  app.get('/api/restore/:id', (req, res) => {
    const p = getRestorePoint(req.params.id);
    if (!p) return res.status(404).json({ error: 'This change is no longer in Restore.' });
    res.json(p);
  });

  app.get('/api/restore/:id/plan', async (req, res) => {
    const plan = await planRestore(req.params.id);
    if (!plan) return res.status(404).json({ error: 'This change is no longer in Restore.' });
    res.json(plan);
  });

  // Runs the restore (Server-Sent Events, same format as moves)
  app.post('/api/restore/:id/run', async (req, res) => {
    const p = getRestorePoint(req.params.id);
    if (p) setActivityTitle(`Restore to before: ${p.title}`);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // @ts-ignore
    if (res.flushHeaders) res.flushHeaders();
    const recorder = pipelineRecorder(currentActivityId());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const send = (data: any) => {
      recorder.onEvent(data);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    try {
      await executeRestore(req.params.id, send, { filesOnly: req.body?.filesOnly === true });
    } catch (err) {
      send({ type: 'failed', log: (err as Error).message });
    } finally {
      recorder.finish();
      res.end();
    }
  });

  app.post('/api/restore/:id/pin', (req, res) => {
    const p = setPinned(req.params.id, req.body?.pinned !== false);
    if (!p) return res.status(404).json({ error: 'This change is no longer in Restore.' });
    res.json(p);
  });


  app.get('/api/restore/:id/files', async (req, res) => {
    const out = await listBackupFiles(req.params.id);
    if (!out) return res.status(404).json({ error: 'The backup for this change is no longer available.' });
    res.json(out);
  });

  app.get('/api/restore/:id/file', (req, res) => {
    const ok = streamBackupFile(req.params.id, Number(req.query.archive ?? -1), String(req.query.path || ''), res);
    if (!ok) res.status(404).json({ error: 'That file isn’t in the backup.' });
  });

  app.get('/api/restore/:id/download', (req, res) => {
    if (!streamBackupArchive(req.params.id, res)) res.status(404).json({ error: 'The backup for this change is no longer available.' });
  });

  app.post('/api/restore/:id/copy', async (req, res) => {
    const lines: string[] = [];
    const targets = await restoreToFolder(req.params.id, String(req.body?.destination || ''), (m) => lines.push(m)).catch((err: Error) => {
      res.status(400).json({ error: err.message });
      return null;
    });
    if (targets) res.json({ targets, log: lines });
  });

  // Diagnostics: health checks for Manifexus and for each app, resources and logs
  // ---------------------------------------------------------------- Server specs and the built-in AI
  app.get('/api/system/specs', async (_req, res) => res.json(await getSystemSpecs(true)));

  app.get('/api/ai/status', async (_req, res) => res.json(await aiStatus()));

  app.post('/api/ai/settings', (req, res) => {
    const b = req.body || {};
    const patch: Record<string, unknown> = {};
    for (const k of ['quickModel', 'fixerModel', 'freedom']) if (k in b) patch[k] = b[k] || undefined;
    if ('auto' in b) patch.auto = b.auto !== false;
    if (b.access && typeof b.access === 'object') patch.access = b.access;
    if ('setupAt' in b) patch.setupAt = b.setupAt ? new Date().toISOString() : undefined;
    res.json(saveAiSettings(patch));
  });

  app.post('/api/ai/models/install', (req, res) => {
    const model = String(req.body?.model || '');
    if (!catalogModel(model)) return res.status(400).json({ error: 'Unknown model.' });
    // Choosing a model for a role at install time
    if (req.body?.role === 'quick') saveAiSettings({ quickModel: model });
    if (req.body?.role === 'fixer') saveAiSettings({ fixerModel: model });
    if (req.body?.role === 'both') saveAiSettings({ quickModel: model, fixerModel: model });
    res.json(installModel(model));
  });

  // The recommended models, set up as one pipeline
  app.post('/api/ai/models/install-bundle', async (req, res) => {
    try {
      res.json(await installAiBundle(Array.isArray(req.body?.items) ? req.body.items : []));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post('/api/ai/engine/install', async (_req, res) => {
    await installEngineNow();
    res.json({ ok: true });
  });

  app.post('/api/ai/models/cancel', (req, res) => {
    cancelDownload(String(req.body?.model || ''));
    res.json({ ok: true });
  });

  app.post('/api/ai/models/remove', async (req, res) => {
    try {
      await removeModel(String(req.body?.model || ''));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Ask Manifexus: streams what the assistant looks at, its answer, and any plan to review
  app.post('/api/ai/chat', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // @ts-ignore
    if (res.flushHeaders) res.flushHeaders();
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    // The Activity for this question ends with the answer (streams aren't closed by the request tracker)
    const activityId = currentActivityId();
    let outcome: { status: 'succeeded' | 'failed'; error?: string } | undefined;
    const send = (data: { type?: string; message?: string; summary?: string }) => {
      if (data.type === 'done') outcome = { status: 'succeeded' };
      else if (data.type === 'error') outcome = { status: 'failed', error: data.message };
      if (data.type === 'done' && data.summary) record('info', 'system', `Answered in ${data.summary}`);
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    try {
      await aiChat(Array.isArray(req.body?.messages) ? req.body.messages : [], { focus: req.body?.focus, role: req.body?.role, mode: req.body?.mode === 'fix' ? 'fix' : undefined }, send, ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) send({ type: 'error', message: (e as Error).message });
    } finally {
      if (outcome?.status === 'succeeded') finishActivity(activityId, 'succeeded');
      else if (outcome?.status === 'failed') finishActivity(activityId, 'failed', { message: outcome.error || 'The AI couldn’t answer.' });
      else finishActivity(activityId, 'interrupted', { message: ac.signal.aborted ? 'Stopped before it finished (Stop was tapped or Ask was closed).' : 'Ended without an answer.' });
      res.end();
    }
  });

  // Opening Ask: load the everyday model and let it read its instructions while the person types
  app.post('/api/ai/warm', (_req, res) => {
    void aiWarm().catch(() => undefined);
    res.json({ ok: true });
  });

  app.get('/api/ai/plans/:id', (req, res) => {
    const p = getPlan(req.params.id);
    if (!p) return res.status(404).json({ error: 'This plan has expired.' });
    res.json(p);
  });

  app.post('/api/ai/plans/:id/run', async (req, res) => {
    const p = getPlan(req.params.id);
    if (p) setActivityTitle(p.title);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // @ts-ignore
    if (res.flushHeaders) res.flushHeaders();
    const recorder = pipelineRecorder(currentActivityId());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const send = (data: any) => {
      recorder.onEvent(data);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    try {
      await runPlan(req.params.id, send);
    } catch (err) {
      send({ type: 'failed', log: (err as Error).message });
    } finally {
      recorder.finish();
      res.end();
    }
  });

  // Each problem comes with how to fix it: automatically (when Manifexus knows how) and by hand
  const withFixes = (checks: Check[], ctx: FixContext) => checks.map((c) => ({ ...c, fix: describeFix(c, ctx) }));
  const selfDir = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env: any = await environmentSnapshot().catch(() => ({}));
    return env?.manifexus?.compose?.workingDir as string | undefined;
  };

  app.get('/api/diagnostics', async (req, res) => {
    const d = await systemDiagnostics();
    res.json({ ...d, checks: withFixes(d.checks, { selfDir: await selfDir() }) });
  });

  // Fix Automatically: the change for the chosen problems, from checks run just now, as a plan to review
  app.post('/api/diagnostics/autofix', async (req, res) => {
    try {
      const appId = typeof req.body?.appId === 'string' ? req.body.appId : undefined;
      const ids: string[] = Array.isArray(req.body?.checkIds) ? req.body.checkIds.map(String) : [];
      const d = appId ? await appDiagnostics(appId) : await systemDiagnostics();
      const ctx: FixContext = appId ? { app: (d as { name?: string }).name } : { selfDir: await selfDir() };
      const chosen = d.checks.filter((c: Check) => ids.includes(c.id) && describeFix(c, ctx)?.auto);
      if (!chosen.length) return res.status(400).json({ error: 'None of these can be fixed automatically any more. Check Again to see what’s left.' });
      const actions = [];
      for (const c of chosen) {
        const a = await autoFixActions(c, ctx);
        if ('problem' in a) return res.status(400).json({ error: a.problem });
        actions.push(...a);
      }
      const what = chosen.map((c: Check) => describeFix(c, ctx)!.auto!);
      const { plan, problem } = await planFromActions(
        chosen.length === 1 ? what[0] : `Fix ${chosen.length} problems`,
        `Manifexus knows how to fix ${chosen.length === 1 ? 'this' : 'these'}:\n\n${chosen.map((c: Check, i: number) => `- **${c.title}**: ${what[i]}`).join('\n')}`,
        actions
      );
      if (!plan) return res.status(400).json({ error: problem || 'Couldn’t prepare the fix.' });
      res.json(plan);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/diagnostics/report', async (req, res) => {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="manifexus-diagnostics-${new Date().toISOString().slice(0, 10)}.md"`);
    res.send(await systemReport());
  });

  app.get('/api/containers/:id/diagnostics', async (req, res) => {
    try {
      const d = await appDiagnostics(req.params.id);
      res.json({ ...d, checks: withFixes(d.checks, { app: d.name }) });
    } catch (err) {
      res.status(404).json({ error: `Couldn’t inspect this app: ${(err as Error).message}` });
    }
  });

  app.get('/api/containers/:id/logs', async (req, res) => {
    const tail = req.query.tail === 'all' ? 'all' : Math.min(Math.max(Number(req.query.tail) || 300, 10), 20000);
    const out = await appLogs(req.params.id, tail);
    if (req.query.download) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${String(req.query.name || req.params.id).replace(/[^a-zA-Z0-9_.-]/g, '_')}-logs.txt"`);
      return res.send(out.text);
    }
    res.json(out);
  });

  // Get host automation privileges (detects if sandboxed or elevated)
  app.get('/api/system/privileges', async (req, res) => {
    try {
      const status = await checkPrivilegeStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Serve the 1-line elevation script to upgrade to Full Host Automation
  app.get('/api/system/elevate.sh', (req, res) => {
    const hostHeader = req.get('host') || 'localhost:3334';
    const script = generateElevateScript(hostHeader);
    res.setHeader('Content-Type', 'text/x-shellscript');
    res.setHeader('Content-Disposition', 'inline; filename="elevate.sh"');
    res.send(script);
  });

  // Execute stack merge (either automated via elevated privileges or simulated in demo)
  app.post('/api/stacks/execute-merge', async (req, res) => {
    try {
      const { sourceContainerIds, targetStackName, targetDirectory, yamlContent } = req.body;

      if (!Array.isArray(sourceContainerIds) || sourceContainerIds.length === 0) {
        return res.status(400).json({ error: 'Source container IDs required' });
      }

      const targetDir =
        targetDirectory ||
        path.posix.join(getDefaultHostStacksBaseDir((await getContainersList()).containers), targetStackName || 'combined-stack');
      const stackName = targetStackName || 'combined-stack';
      const privs = await checkPrivilegeStatus();

      // If in Elevated Mode and we have yamlContent, execute full zero-touch host automation!
      if (privs.canAutoExecute && yamlContent) {
        const result = await executeAutomatedStackMerge({
          targetStackName: stackName,
          targetDirectory: targetDir,
          yamlContent,
          sourceContainerIds,
        });

        return res.json({
          ...result,
          isAutomated: true,
          mode: privs.mode,
          targetStackName: stackName,
          targetDirectory: targetDir,
        });
      }

      // If in demo mode
      if (!privs.isDockerConnected) {
        mergeDemoContainersIntoStack(sourceContainerIds, stackName, targetDir);
        return res.json({
          success: true,
          isAutomated: false,
          mode: 'demo',
          message: `[Demo] Services consolidated into '${stackName}' at ${targetDir}!`,
          targetStackName: stackName,
          targetDirectory: targetDir,
        });
      }

      // If connected to live Docker but in read-only sandboxed mode
      res.json({
        success: true,
        isAutomated: false,
        mode: 'sandboxed',
        message: `Plan generated. Because Manifexus is in Sandboxed Mode, run the quick 3-step commands or click "Elevate Automation Mode" to enable 1-click execution.`,
        targetStackName: stackName,
        targetDirectory: targetDir,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Software Update
  app.get('/api/system/update', async (req, res) => {
    try {
      res.json(await getSoftwareUpdateState());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/system/update/check', async (req, res) => {
    try {
      res.json(await checkForUpdate());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/system/update/settings', (req, res) => {
    res.json({ settings: updateSettings(req.body || {}) });
  });

  // Streams install progress (Server-Sent Events). The stream ends when Manifexus restarts.
  app.post('/api/system/update/install', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // @ts-ignore
    if (res.flushHeaders) res.flushHeaders();
    const recorder = pipelineRecorder(currentActivityId());
    const send = (p: unknown) => {
      recorder.onEvent(p);
      res.write(`data: ${JSON.stringify(p)}\n\n`);
    };
    let joined = false;
    try {
      joined = (await installUpdate(send)).joined;
      // This request only followed an install that was already running (that install has its own record)
      if (joined) setActivityTitle('Follow the update in progress');
    } finally {
      recorder.finish(joined ? 'succeeded' : undefined);
      res.end();
    }
  });

  // Mount Vite middleware in development or static files in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Last: anything a route threw
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((err: any, req: any, res: any, _next: any) => {
    record('error', 'api', `${req.method} ${req.originalUrl} failed: ${err?.message || err}`, { stack: err?.stack });
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        // already closed
      }
      return;
    }
    res.status(500).json({ error: err?.message || 'Something went wrong.' });
  });

  // Create HTTP server and attach Directive 1 Web Terminal WebSocket
  const server = http.createServer(app);
  setupTerminalWebSocket(server);

  // Learn which host folders are mounted into this container (refreshed in case mounts change)
  await refreshSelfMounts();
  setInterval(() => void refreshSelfMounts(), 60 * 1000);

  // Activities cut off by the last shutdown are closed as interrupted, except an update in progress,
  // which is closed below once its restart helper reports back
  const pendingUpdate = pendingUpdateActivityId();
  closeStaleActivities(pendingUpdate ? [pendingUpdate] : []);

  // Software Update: record the outcome of an update the previous instance started (reads the restart
  // helper's output before cleanup removes it), then check periodically
  await startUpdateScheduler();

  // Remove helper containers left behind by interrupted jobs (they used to show up as stopped apps)
  void cleanupStoppedHelpers();
  setInterval(() => void cleanupStoppedHelpers(), 10 * 60 * 1000);

  // Activity log: boot record, Docker container events, retention
  void recordStartup();
  watchDockerEvents();
  enforceRetention();
  setInterval(() => enforceRetention(), 60 * 60 * 1000);

  // Restore: one-time clean-up of old History entries, then the keep-for setting (hourly)
  freshStartOnce();
  warmUpEngine();
  // The example problem for the built-in AI (once, when Docker is reachable)
  setTimeout(() => seedAiExample().catch((e) => console.warn('[AI example]', (e as Error).message)), 5000);
  process.on('exit', () => stopEngine());
  enforceBackupRetention();
  setInterval(() => enforceBackupRetention(), 60 * 60 * 1000);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Manifexus Core Engine] Server and Web Terminal running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
