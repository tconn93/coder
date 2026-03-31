import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  setDefaultWorkdir,
  handleChat,
  handleStream,
  handleTodos,
  handleStatus,
  handleResume,
  attachWebSocket,
} from './api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface WebServerOptions {
  port: number;
  workdir?: string;
}

export async function startWebServer(options: WebServerOptions): Promise<void> {
  if (options.workdir) {
    setDefaultWorkdir(options.workdir);
  }
  const app = express();
  const httpServer = createServer(app);

  // Middleware
  app.use(express.json({ limit: '10mb' }));

  // CORS
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // Request logging
  app.use((req, _res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
  });

  // Serve web UI
  app.get('/', async (_req, res) => {
    try {
      // Try dist first, then src
      let htmlPath = join(__dirname, '..', 'ui', 'index.html');
      try {
        const html = await readFile(htmlPath, 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } catch {
        // Try src path
        htmlPath = join(__dirname, '..', '..', 'src', 'ui', 'index.html');
        const html = await readFile(htmlPath, 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      }
    } catch (err) {
      res.status(500).send('Could not load UI');
    }
  });

  // API routes
  app.post('/api/chat', handleChat);
  app.get('/api/stream/:sessionId', handleStream);
  app.get('/api/todos', handleTodos);
  app.get('/api/status', handleStatus);
  app.post('/api/resume', handleResume);

  // WebSocket server
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', `http://localhost`);
    const sessionId = url.searchParams.get('sessionId') || '';

    if (sessionId) {
      attachWebSocket(ws, sessionId);
    } else {
      // Wait for the client to send a session ID
      ws.once('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as { type: string; sessionId: string };
          if (msg.type === 'connect' && msg.sessionId) {
            attachWebSocket(ws, msg.sessionId);
          }
        } catch {
          ws.close();
        }
      });
    }
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Start server
  await new Promise<void>((resolve) => {
    httpServer.listen(options.port, () => {
      resolve();
    });
  });

  console.log(`\n  Web UI:  http://localhost:${options.port}`);
  console.log(`  API:     http://localhost:${options.port}/api`);
  console.log(`  WS:      ws://localhost:${options.port}/ws`);
  console.log(`  Health:  http://localhost:${options.port}/health`);
  console.log(`  Workdir: ${options.workdir ?? process.cwd()}\n`);
}
