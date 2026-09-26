export interface AppSetupInput {
  key: string;
  label: string;
  type: 'text' | 'password';
  required: boolean;
}

export interface AppRegistryEntry {
  appName: string;
  matchImages: string[];
  webPath?: string;
  defaultUsername?: string;
  defaultPassword?: string;
  setupInstructions?: string;

  // Directive 4: Dynamic interactive setup script definitions
  requiresSetup?: boolean;
  setupInputs?: AppSetupInput[];
  /**
   * Command array to run inside the container. 
   * Use placeholders like {{username}} and {{password}} to inject user inputs.
   */
  setupCommandTemplate?: string[]; 
}

/**
 * The Local App Registry maps known Docker images to their default configurations,
 * web paths, and setup commands.
 */
export const AppRegistry: AppRegistryEntry[] = [
  {
    appName: 'uTorrent',
    matchImages: ['ekho/utorrent', 'linuxserver/utorrent', 'utorrent'],
    webPath: '/gui/',
    defaultUsername: 'admin',
    defaultPassword: '', // Blank password as requested
    setupInstructions: 'Access the web interface at /gui/. Use the default username "admin" with a blank password.',
  },
  {
    appName: 'qBittorrent',
    matchImages: ['linuxserver/qbittorrent', 'qbittorrent/qbittorrent', 'qbittorrent'],
    webPath: '/',
    defaultUsername: 'admin',
    defaultPassword: 'adminadmin',
    setupInstructions: 'Use the default credentials to log in. It is highly recommended to change them immediately in the Web UI settings.',
  },
  {
    // Example of an app that requires interactive setup via CLI (Directive 4 prep)
    appName: 'Custom Script App (Example)',
    matchImages: ['example/needs-setup'],
    requiresSetup: true,
    setupInstructions: 'This application requires you to set an admin password via the setup CLI before first use.',
    setupInputs: [
      { key: 'username', label: 'Admin Username', type: 'text', required: true },
      { key: 'password', label: 'Admin Password', type: 'password', required: true }
    ],
    // These commands will be executed inside the container using docker exec
    setupCommandTemplate: ['sh', '-c', 'app-cli set-auth {{username}} {{password}}']
  }
];

/**
 * Searches the AppRegistry for a matching configuration based on the Docker image name.
 * 
 * @param imageName The exact or partial image name (e.g., "linuxserver/qbittorrent:latest")
 * @returns The registry entry if found, or undefined
 */
export function getAppRegistryConfig(imageName: string): AppRegistryEntry | undefined {
  if (!imageName) return undefined;

  const normalizedImage = imageName.toLowerCase().trim();

  // Strip tags for matching (e.g., ":latest")
  const baseImage = normalizedImage.split(':')[0];

  return AppRegistry.find(app => 
    app.matchImages.some(match => baseImage.includes(match) || normalizedImage.includes(match))
  );
}
