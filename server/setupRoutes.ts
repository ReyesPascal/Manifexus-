import { Router } from 'express';
import { AppRegistry, getAppRegistryConfig } from './appRegistryService';
import { queryDockerEngine } from './dockerService';

const router = Router();

/**
 * Directive 4: Dynamic Interactive Setup & Local App Registry
 * Exposes endpoints to retrieve app configurations, credentials,
 * and execute interactive setup scripts inside target containers.
 */

// GET all registered app templates
router.get('/api/setup/registry', (_req, res) => {
  res.json({ registry: AppRegistry });
});

// GET configuration for a specific Docker image
router.get('/api/setup/config/:imageName', (req, res) => {
  const { imageName } = req.params;
  const config = getAppRegistryConfig(decodeURIComponent(imageName));
  if (!config) {
    return res.status(404).json({ error: `No registry configuration found for image: ${imageName}` });
  }
  res.json({ config });
});

// POST execute setup command inside target container
router.post('/api/setup/execute', async (req, res) => {
  try {
    const { containerId, imageName, inputs = {} } = req.body;
    if (!containerId) {
      return res.status(400).json({ error: 'containerId is required' });
    }

    let targetImage = imageName;
    if (!targetImage) {
      // Query container details to find image
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const detail = await queryDockerEngine<any>(`/containers/${containerId}/json`, 'GET');
        targetImage = detail?.Config?.Image || detail?.Image;
      } catch (err) {
        return res.status(404).json({ error: `Container not found or inaccessible: ${(err as Error).message}` });
      }
    }

    const config = getAppRegistryConfig(targetImage);
    if (!config || !config.setupCommandTemplate) {
      return res.status(400).json({
        error: `No setup command template defined for image "${targetImage}"`,
      });
    }

    // Replace template tokens {{key}}
    const resolvedCmd = config.setupCommandTemplate.map((part) => {
      let resolved = part;
      for (const [k, v] of Object.entries(inputs)) {
        resolved = resolved.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
      }
      return resolved;
    });

    // Execute via Docker Engine API
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const execInstance = await queryDockerEngine<any>(`/containers/${containerId}/exec`, 'POST', {
      AttachStdout: true,
      AttachStderr: true,
      Cmd: resolvedCmd,
    });

    const execId = execInstance?.Id;
    if (!execId) {
      throw new Error('Failed to create exec instance in container');
    }

    const output = await queryDockerEngine<string>(`/exec/${execId}/start`, 'POST', {
      Detach: false,
      Tty: false,
    });

    res.json({
      success: true,
      output: typeof output === 'string' ? output : JSON.stringify(output),
      command: resolvedCmd,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
export { router as setupRoutes };
