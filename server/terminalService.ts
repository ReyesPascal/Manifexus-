import http from 'http';
import net from 'net';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import {
  isDockerSocketAvailable,
  queryDockerEngine,
  getBestAvailableImage,
} from './dockerService';
import { readHostFile, writeHostFile } from './hostFsService';
import { globalLogService } from './globalLogService';

const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';

/**
 * Directive 1: Web Terminal Backend
 * Attaches a WebSocket server on /ws/terminal. When a client connects with a compose file path,
 * it spawns an interactive container bound to the host filesystem, executing nano on the target file,
 * passing stdin, stdout, and stderr streams to the WebSocket.
 */
export function setupTerminalWebSocket(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/ws/terminal') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', async (ws: WebSocket, req: http.IncomingMessage) => {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    let targetFilePath = url.searchParams.get('file') || '';
    let cols = parseInt(url.searchParams.get('cols') || '90', 10);
    let rows = parseInt(url.searchParams.get('rows') || '28', 10);

    let isInitialized = false;
    let cleanupHandler: (() => Promise<void>) | null = null;

    const startSession = async (filePath: string, c: number, r: number) => {
      if (isInitialized) return;
      isInitialized = true;

      const normalizedPath = filePath.trim();
      globalLogService.log({
        eventType: 'STACK_OP',
        level: 'INFO',
        source: 'terminalService',
        message: `Web Terminal connection initiated for host file: ${normalizedPath}`,
        payload: { targetFilePath: normalizedPath, cols: c, rows: r },
      });

      if (isDockerSocketAvailable()) {
        try {
          cleanupHandler = await startDockerSocketNanoSession(ws, normalizedPath, c, r);
          return;
        } catch (err) {
          console.warn('[TerminalService] Failed to start Docker nano session, falling back to interactive session:', err);
          ws.send(`\r\n\x1b[33m[Notice] Direct Docker TTY attach failed (${(err as Error).message}). Loading fallback terminal...\x1b[0m\r\n`);
        }
      }

      // Simulated or Standby Interactive Terminal Session
      cleanupHandler = await startInteractiveFallbackSession(ws, normalizedPath, c, r);
    };

    // If target file was provided in query string, launch immediately
    if (targetFilePath) {
      startSession(targetFilePath, cols, rows);
    }

    // Handle messages (initialization, keystrokes, resize)
    ws.on('message', async (data: Buffer | string) => {
      const raw = data.toString();

      // Check if message is JSON control packet
      if (raw.startsWith('{') && raw.endsWith('}')) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.type === 'init' && parsed.file) {
            targetFilePath = parsed.file;
            cols = parsed.cols || cols;
            rows = parsed.rows || rows;
            startSession(targetFilePath, cols, rows);
            return;
          }
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            cols = parsed.cols;
            rows = parsed.rows;
            // Resize is handled in active session handler
            return;
          }
        } catch {
          // Pass through raw keystroke
        }
      }

      if (!isInitialized && targetFilePath) {
        startSession(targetFilePath, cols, rows);
      }
    });

    ws.on('close', async () => {
      if (cleanupHandler) {
        await cleanupHandler();
      }
    });

    ws.on('error', async (err) => {
      console.warn('[TerminalService] WebSocket error:', err);
      if (cleanupHandler) {
        await cleanupHandler();
      }
    });
  });

  return wss;
}

/**
 * Spawns an interactive helper container via Docker socket running nano on the target host file
 */
async function startDockerSocketNanoSession(
  ws: WebSocket,
  hostFilePath: string,
  initialCols: number,
  initialRows: number
): Promise<() => Promise<void>> {
  const parentDir = path.dirname(hostFilePath);
  const fileName = path.basename(hostFilePath);
  const helperImage = await getBestAvailableImage();

  // Create container with Tty: true and OpenStdin: true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const container = await queryDockerEngine<any>('/containers/create', 'POST', {
    Image: helperImage,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    WorkingDir: '/target_dir',
    Cmd: [
      'sh',
      '-c',
      `if command -v nano >/dev/null 2>&1; then ` +
      `  nano "/target_dir/${fileName}"; ` +
      `elif command -v apk >/dev/null 2>&1; then ` +
      `  apk add --no-cache nano >/dev/null 2>&1 && nano "/target_dir/${fileName}"; ` +
      `elif command -v apt-get >/dev/null 2>&1; then ` +
      `  apt-get update >/dev/null 2>&1 && apt-get install -y nano >/dev/null 2>&1 && nano "/target_dir/${fileName}"; ` +
      `else ` +
      `  vi "/target_dir/${fileName}"; ` +
      `fi`,
    ],
    Env: [
      'TERM=xterm-256color',
      'COLORTERM=truecolor',
      'LANG=en_US.UTF-8',
      'LC_ALL=en_US.UTF-8',
      `COLUMNS=${initialCols}`,
      `LINES=${initialRows}`,
    ],
    HostConfig: {
      Binds: [`${parentDir}:/target_dir:rw`],
      AutoRemove: false,
    },
  });

  if (!container || !container.Id) {
    throw new Error('Docker engine failed to create interactive nano container');
  }

  const containerId = container.Id;
  let isCleanedUp = false;

  // Establish raw TCP connection to the Docker Unix socket to attach stream
  const dockerSocket = net.connect({ path: DOCKER_SOCKET_PATH });

  await new Promise<void>((resolve, reject) => {
    dockerSocket.on('connect', () => {
      // Send raw HTTP Upgrade request to hijack container stdin/stdout/stderr
      dockerSocket.write(
        `POST /containers/${containerId}/attach?stream=1&stdin=1&stdout=1&stderr=1 HTTP/1.1\r\n` +
        `Host: docker.local\r\n` +
        `Upgrade: tcp\r\n` +
        `Connection: Upgrade\r\n\r\n`
      );
    });

    let headerParsed = false;
    let buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      if (!headerParsed) {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
          headerParsed = true;
          const remainder = buffer.slice(headerEnd + 4);
          if (remainder.length > 0 && ws.readyState === WebSocket.OPEN) {
            ws.send(remainder);
          }
          resolve();
        }
      } else {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      }
    };

    dockerSocket.on('data', onData);
    dockerSocket.on('error', (err) => {
      if (!headerParsed) reject(err);
    });
  });

  // Start the container once attached
  await queryDockerEngine(`/containers/${containerId}/start`, 'POST');

  // Set initial dimensions
  await queryDockerEngine(
    `/containers/${containerId}/resize?h=${initialRows}&w=${initialCols}`,
    'POST'
  ).catch(() => {});

  // Pipe WebSocket client input to Docker socket
  const onWsMessage = async (msg: Buffer | string) => {
    const raw = msg.toString();
    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          await queryDockerEngine(
            `/containers/${containerId}/resize?h=${parsed.rows}&w=${parsed.cols}`,
            'POST'
          ).catch(() => {});
          return;
        }
      } catch {
        // Not a JSON packet, pass raw
      }
    }

    if (!dockerSocket.destroyed) {
      dockerSocket.write(msg);
    }
  };

  ws.on('message', onWsMessage);

  const cleanup = async () => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    ws.removeListener('message', onWsMessage);

    try {
      if (!dockerSocket.destroyed) {
        dockerSocket.end();
        dockerSocket.destroy();
      }
    } catch {
      // ignore
    }

    try {
      await queryDockerEngine(`/containers/${containerId}?force=true`, 'DELETE');
    } catch {
      // ignore
    }
  };

  dockerSocket.on('close', async () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send('\r\n\x1b[32m[Terminal Session Ended: nano exited]\x1b[0m\r\n');
      ws.close();
    }
    await cleanup();
  });

  return cleanup;
}

/**
 * Fallback interactive terminal session for environments without direct Docker socket access
 */
async function startInteractiveFallbackSession(
  ws: WebSocket,
  hostFilePath: string,
  cols: number,
  rows: number
): Promise<() => Promise<void>> {
  let fileContent = (await readHostFile(hostFilePath)) || 'services: {}\n';
  let lines = fileContent.split('\n');
  let cursorRow = 0;
  let cursorCol = 0;
  let isDirty = false;
  let statusMessage = '';

  const render = () => {
    if (ws.readyState !== WebSocket.OPEN) return;

    let out = '\x1b[?25l\x1b[H'; // hide cursor, move home

    // Header bar
    const title = ` GNU nano 7.2 (Manifexus Host Terminal) `;
    const fileLabel = ` File: ${path.basename(hostFilePath)} ${isDirty ? '*' : ''}`;
    const fillLength = Math.max(0, cols - title.length - fileLabel.length);
    out += `\x1b[7m\x1b[1m${title}${' '.repeat(fillLength)}${fileLabel} \x1b[0m\r\n`;

    // Content lines
    const visibleLinesCount = Math.max(5, rows - 4);
    for (let i = 0; i < visibleLinesCount; i++) {
      const lineText = lines[i] !== undefined ? lines[i] : '~';
      const truncated = lineText.slice(0, cols);
      out += `\x1b[2K${truncated}\r\n`;
    }

    // Status bar
    const statusText = statusMessage || `[ Reading from ${hostFilePath} ]`;
    out += `\x1b[7m ${statusText.padEnd(cols - 2)} \x1b[0m\r\n`;

    // Shortcuts footer
    const row1 = '^G Help       ^O WriteOut   ^W Where Is   ^K Cut        ^T Execute';
    const row2 = '^X Exit       ^R ReadFile   ^\\ Replace    ^U Paste      ^J Justify';
    out += `\x1b[2K\x1b[36m${row1.slice(0, cols)}\x1b[0m\r\n`;
    out += `\x1b[2K\x1b[36m${row2.slice(0, cols)}\x1b[0m`;

    // Restore cursor position
    const targetY = Math.min(cursorRow + 2, rows - 3);
    const targetX = Math.min(cursorCol + 1, cols);
    out += `\x1b[${targetY};${targetX}H\x1b[?25h`;

    ws.send(out);
  };

  render();

  const onWsMessage = async (msg: Buffer | string) => {
    const raw = msg.toString();

    // Check resize
    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.type === 'resize') {
          cols = parsed.cols || cols;
          rows = parsed.rows || rows;
          render();
          return;
        }
      } catch {
        // Not a JSON packet
      }
    }

    // Handle nano shortcuts
    // Ctrl+O: WriteOut (Save file)
    if (raw === '\x0f' || raw === '\u000f') {
      const newContent = lines.join('\n');
      const saved = await writeHostFile(hostFilePath, newContent);
      fileContent = newContent;
      isDirty = false;
      statusMessage = saved
        ? `[ Wrote ${lines.length} lines to ${path.basename(hostFilePath)} ]`
        : `[ Error saving file ]`;
      render();
      setTimeout(() => {
        statusMessage = '';
        render();
      }, 3000);
      return;
    }

    // Ctrl+X: Exit
    if (raw === '\x18' || raw === '\u0018') {
      ws.send('\r\n\x1b[32m[Exited nano]\x1b[0m\r\n');
      ws.close();
      return;
    }

    // Arrow keys
    if (raw === '\x1b[A') {
      // Up
      if (cursorRow > 0) cursorRow--;
      cursorCol = Math.min(cursorCol, (lines[cursorRow] || '').length);
      render();
      return;
    }
    if (raw === '\x1b[B') {
      // Down
      if (cursorRow < lines.length - 1) cursorRow++;
      cursorCol = Math.min(cursorCol, (lines[cursorRow] || '').length);
      render();
      return;
    }
    if (raw === '\x1b[C') {
      // Right
      if (cursorCol < (lines[cursorRow] || '').length) cursorCol++;
      render();
      return;
    }
    if (raw === '\x1b[D') {
      // Left
      if (cursorCol > 0) cursorCol--;
      render();
      return;
    }

    // Enter / Return
    if (raw === '\r' || raw === '\n') {
      const current = lines[cursorRow] || '';
      const before = current.slice(0, cursorCol);
      const after = current.slice(cursorCol);
      lines[cursorRow] = before;
      lines.splice(cursorRow + 1, 0, after);
      cursorRow++;
      cursorCol = 0;
      isDirty = true;
      statusMessage = '';
      render();
      return;
    }

    // Backspace
    if (raw === '\x7f' || raw === '\b') {
      const current = lines[cursorRow] || '';
      if (cursorCol > 0) {
        lines[cursorRow] = current.slice(0, cursorCol - 1) + current.slice(cursorCol);
        cursorCol--;
        isDirty = true;
        statusMessage = '';
        render();
      } else if (cursorRow > 0) {
        const prev = lines[cursorRow - 1] || '';
        cursorCol = prev.length;
        lines[cursorRow - 1] = prev + current;
        lines.splice(cursorRow, 1);
        cursorRow--;
        isDirty = true;
        statusMessage = '';
        render();
      }
      return;
    }

    // Printable character input
    if (raw.length === 1 && raw.charCodeAt(0) >= 32) {
      const current = lines[cursorRow] || '';
      lines[cursorRow] = current.slice(0, cursorCol) + raw + current.slice(cursorCol);
      cursorCol++;
      isDirty = true;
      statusMessage = '';
      render();
    }
  };

  ws.on('message', onWsMessage);

  return async () => {
    ws.removeListener('message', onWsMessage);
  };
}
