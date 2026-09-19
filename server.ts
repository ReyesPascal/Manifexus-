import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  getContainersList,
  executeContainerAction,
  isDockerSocketAvailable,
  addDemoContainer,
  resolveAppIcon,
} from './server/dockerService';
import {
  getConfig,
  saveConfig,
  updateAppOverride,
} from './server/storageService';
import { DeepContainerMetadata } from './src/types';

async function startServer() {
  const app = express();
  const PORT = process.env.NODE_ENV === 'production' ? Number(process.env.PORT || 3334) : 3000;

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

      const runningCount = containers.filter((c) => c.state === 'running').length;
      const stoppedCount = containers.length - runningCount;
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
