import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  getContainersList,
  executeContainerAction,
  isDockerSocketAvailable,
  addDemoContainer,
  resolveAppIcon,
  mergeDemoContainersIntoStack,
} from './server/dockerService';
import {
  getConfig,
  saveConfig,
  updateAppOverride,
} from './server/storageService';
import { generateStackMergePlan, MergePlanRequest, isManifexusContainer } from './server/stackService';
import {
  checkPrivilegeStatus,
  executeAutomatedStackMerge,
  generateElevateScript,
  executeStreamingPipeline,
  executeStreamingRevert,
  executeStreamingComposeInstall,
  resolveHostPathToContainer,
  repairTargetStack,
} from './server/automationService';
import { readHostFile, resolveDefaultHostHome } from './server/hostFsService';
import { fetchRemoteCompose } from './server/remoteComposeService';
import { resolvePortCollisions } from './server/portCollisionService';
import {
  getMergeHistory,
  finalizeMergeRecord,
  getHistoryRecordById,
} from './server/historyService';
import fs from 'fs';
import { DeepContainerMetadata } from './src/types';
import {
  getSystemLogs,
  pruneSystemLogs,
  logEvent,
  sysLog,
} from './server/systemLogService';

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

  app.use(express.json());

  // API Routes FIRST
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // System status
  app.get('/api/status', async (req, res) => {
    try {
      const socketPath = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
      const available = isDockerSocketAvailable();
      const { containers, isDemo, dockerVersion, os } = await getContainersList();

      // Module 4: Metric Calculation Audit
      // FLEET RUNNING strictly counts 'running' state
      const runningCount = containers.filter((c) => c.state === 'running').length;
      // EXITED / STOPPED strictly counts 'exited', 'stopped', or 'dead' states across all stacks
      const stoppedCount = containers.filter((c) => {
        const s = (c.state || '').toLowerCase();
        const st = (c.status || '').toLowerCase();
        return (
          s === 'exited' ||
          s === 'stopped' ||
          s === 'dead' ||
          st.startsWith('exited') ||
          st.includes('dead') ||
          st.includes('stopped')
        );
      }).length;
      const stacks = new Set(containers.filter((c) => c.compose?.isCompose && c.compose.project).map((c) => c.compose.project)).size;

      res.json({
        dockerConnected: available && !isDemo,
        isDemoMode: isDemo,
        socketPath,
        dockerVersion: dockerVersion || 'Unknown',
        operatingSystem: os || 'Linux',
        serverTime: new Date().toISOString(),
        totalContainers: containers.length,
        runningContainers: runningCount,
        stoppedContainers: stoppedCount,
        composeStacksCount: stacks,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get containers list enriched with user customizations
  app.get('/api/containers', async (req, res) => {
    try {
      const { containers, isDemo, dockerVersion, os } = await getContainersList();
      const config = getConfig();

      // Merge user overrides (custom group, custom name, custom port, custom icon, custom URL, hidden status)
      const enriched: DeepContainerMetadata[] = containers.map((c) => {
        const key = c.id;
        const nameKey = c.cleanName;
        const override = config.appOverrides[key] || config.appOverrides[nameKey] || {};

        return {
          ...c,
          customName: override.customName || undefined,
          customGroup: override.customGroup || undefined,
          customUrl: override.customUrl || undefined,
          iconUrl: override.customIcon || c.iconUrl,
          primaryPort: override.customPort || c.primaryPort,
          notes: override.notes || undefined,
          isHidden: override.isHidden || false,
        };
      });

      res.json({
        containers: enriched,
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
      const result = await executeContainerAction(id, action);
      sysLog.info('docker', `Container action executed: "${action}" on container ${id}`, {
        containerId: id,
        action,
        success: result.success,
      });
      res.json(result);
    } catch (err) {
      sysLog.error('docker', `Container action failed: "${action}" on container ${id}: ${(err as Error).message}`, {
        containerId: id,
        action,
        error: (err as Error).message,
      });
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

      const targetDir = targetDirectory || `/home/ryan/${targetStackName || 'combined-stack'}`;
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

      const plan = generateStackMergePlan(selectedContainers, {
        sourceContainerIds,
        targetStackName: targetStackName || 'combined-stack',
        targetDirectory: targetDir,
        mode: existingComposeContent ? 'existing-stack' : (mode || 'new-stack'),
        volumeHandling: volumeHandling || 'preserve-absolute',
        existingComposeContent,
      });

      res.json(plan);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Repair / De-Conflict Stack Endpoint
  app.post('/api/stacks/repair-conflicts', async (req, res) => {
    try {
      const { targetDirectory, removeConflictingContainer, stripService } = req.body;
      if (!targetDirectory) {
        return res.status(400).json({ error: 'Target directory is required' });
      }
      const result = await repairTargetStack(targetDirectory, {
        removeConflictingContainer,
        stripService,
      });
      res.json(result);
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

    const sendEvent = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const { sourceContainerIds, targetStackName, targetDirectory, yamlContent } = req.body;
      if (!Array.isArray(sourceContainerIds) || sourceContainerIds.length === 0) {
        sendEvent({ type: 'failed', log: 'Source container IDs required' });
        res.end();
        return;
      }

      // Execute the 7 sequential steps with real-time SSE streaming
      await executeStreamingPipeline(
        {
          targetStackName: targetStackName || 'combined-stack',
          targetDirectory: targetDirectory || `/home/ryan/${targetStackName || 'combined-stack'}`,
          yamlContent: yamlContent || '',
          sourceContainerIds,
        },
        sendEvent
      );
    } catch (err) {
      sendEvent({ type: 'failed', log: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // Directive 6: Merge History and State Ledger Endpoints
  app.get('/api/history', (req, res) => {
    try {
      const history = getMergeHistory();
      res.json({ history });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/history/:id', (req, res) => {
    try {
      const record = getHistoryRecordById(req.params.id);
      if (!record) {
        return res.status(404).json({ error: 'Merge record not found' });
      }
      res.json(record);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Directive 4: Keep Changes
  app.post('/api/history/:id/keep', (req, res) => {
    try {
      const success = finalizeMergeRecord(req.params.id);
      res.json({ success });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Directive 4 & 6: Automated Rollback Pipeline Streamer (SSE)
  app.post('/api/history/:id/revert-stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // @ts-ignore
    if (res.flushHeaders) res.flushHeaders();

    const sendEvent = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await executeStreamingRevert(req.params.id, sendEvent);
    } catch (err) {
      sendEvent({ type: 'failed', log: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // Directive 2: Fetch and inspect remote Compose URL
  app.post('/api/compose/fetch-remote', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url || typeof url !== 'string' || url.trim().length === 0) {
        return res
          .status(400)
          .json({ error: 'A remote URL (e.g. GitHub repository link or raw compose file URL) is required.' });
      }

      const metadata = await fetchRemoteCompose(url);

      // Get current occupied host ports across fleet
      const { containers } = await getContainersList();
      const occupiedPorts: number[] = [];
      for (const c of containers) {
        for (const p of c.ports) {
          if (p.publicPort && !occupiedPorts.includes(p.publicPort)) {
            occupiedPorts.push(p.publicPort);
          }
        }
      }

      res.json({
        ...metadata,
        occupiedPorts,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Directive 3: AST Port Collision Analysis & Resolution
  app.post('/api/compose/resolve-ports', async (req, res) => {
    try {
      const { yaml: yamlContent } = req.body;
      if (!yamlContent) {
        return res.status(400).json({ error: 'YAML content is required' });
      }

      const { containers } = await getContainersList();
      const occupiedPorts = new Set<number>();
      for (const c of containers) {
        for (const p of c.ports) {
          if (p.publicPort) occupiedPorts.add(p.publicPort);
        }
      }

      const result = resolvePortCollisions(yamlContent, occupiedPorts);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Directives 4 & 5: Live Streaming Remote Compose Installation (SSE)
  app.post('/api/compose/install-stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // @ts-ignore
    if (res.flushHeaders) res.flushHeaders();

    const sendEvent = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const { installId, sourceUrl, targetStackName, targetDirectory, installMode, composeYaml } = req.body;
      if (!composeYaml || !targetDirectory || !targetStackName) {
        sendEvent({
          type: 'error',
          error: 'Missing required install parameters (composeYaml, targetDirectory, targetStackName).',
        });
        res.end();
        return;
      }

      await executeStreamingComposeInstall(
        {
          installId,
          sourceUrl: sourceUrl || 'remote-compose',
          targetStackName,
          targetDirectory,
          installMode: installMode || 'new-stack',
          composeYaml,
        },
        sendEvent
      );
    } catch (err) {
      sendEvent({ type: 'error', error: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // Host environment detection (default home directory, existing stack directories)
  app.get('/api/compose/host-environment', async (req, res) => {
    try {
      const { containers } = await getContainersList();
      const existingWorkingDirs: string[] = [];
      for (const c of containers) {
        if (c.compose?.workingDir && !existingWorkingDirs.includes(c.compose.workingDir)) {
          existingWorkingDirs.push(c.compose.workingDir);
        }
      }
      const defaultHomeDir = resolveDefaultHostHome(existingWorkingDirs);
      res.json({
        defaultHomeDir,
        existingWorkingDirs,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
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

      const targetDir = targetDirectory || `/home/ryan/${targetStackName || 'combined-stack'}`;
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

  // =========================================================================
  // Module 3: Centralized System Logs API (Query, Filter, Prune, Audit)
  // =========================================================================
  app.get('/api/system/logs', (req, res) => {
    try {
      const { level, category, search, range, limit } = req.query;
      const result = getSystemLogs({
        level: level ? String(level) : undefined,
        category: category ? String(category) : undefined,
        search: search ? String(search) : undefined,
        range: range ? String(range) : undefined,
        limit: limit ? parseInt(String(limit), 10) : 500,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/system/logs/prune', (req, res) => {
    try {
      const { range } = req.body;
      if (!range || !['24h', '7d', '30d', 'all'].includes(range)) {
        return res.status(400).json({ error: 'Valid range required: 24h, 7d, 30d, all' });
      }
      const result = pruneSystemLogs(range);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/system/logs', (req, res) => {
    try {
      const { level, category, message, details } = req.body;
      if (!level || !category || !message) {
        return res.status(400).json({ error: 'level, category, and message are required' });
      }
      const entry = logEvent(level, category, message, details);
      res.json({ success: true, entry });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Mount Vite middleware in development or static files in production
  if (process.env.NODE_ENV !== 'production') {
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Manifexus] Command hub running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
