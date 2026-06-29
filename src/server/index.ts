import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import v1Router from './v1.js';
import { connectToOrchestrator, disconnectFromOrchestrator } from './orchestrator-ws.js';
import {
  setDefaultWorkdir,
  authMiddleware,
  handleChat,
  handleStream,
  handleListSessions,
  handleGetSession,
  handleCancelSession,
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

  // -----------------------------------------------------------------------
  // Middleware
  // -----------------------------------------------------------------------
  app.use(express.json({ limit: '10mb' }));

  // CORS
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    if (_req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // Request logging
  app.use((req, _res, next) => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${req.method} ${req.path}`);
    next();
  });

  // Auth (skip for health check)
  app.use(authMiddleware);

  // -----------------------------------------------------------------------
  // Routes
  // -----------------------------------------------------------------------

  // Web UI
  app.get('/', async (_req, res) => {
    try {
      let htmlPath = join(__dirname, '..', 'ui', 'index.html');
      try {
        const html = await readFile(htmlPath, 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } catch {
        htmlPath = join(__dirname, '..', '..', 'src', 'ui', 'index.html');
        const html = await readFile(htmlPath, 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      }
    } catch {
      res.status(500).send('Could not load UI');
    }
  });

  // Health
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      workdir: process.env.CODER_WORKDIR || process.cwd(),
      version: '1.0.0',
    });
  });

  // API — session management
  app.post('/api/chat', handleChat);
  app.get('/api/stream/:sessionId', handleStream);
  app.get('/api/sessions', handleListSessions);
  app.get('/api/sessions/:id', handleGetSession);
  app.post('/api/sessions/:id/cancel', handleCancelSession);
  app.post('/api/resume', handleResume);

  // API — legacy / convenience
  app.get('/api/todos', handleTodos);
  app.get('/api/status', handleStatus);

  // Orchestrator v1 API (Docker/cloud mode)
  app.use('/api/v1', v1Router);

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  // -----------------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------------
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId') || '';

    if (sessionId) {
      attachWebSocket(ws, sessionId);
    } else {
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

  // -----------------------------------------------------------------------
  // Start — dual-port mode when AGENT_API_PORT is set (Docker/cloud)
  // -----------------------------------------------------------------------
  const port = options.port || parseInt(process.env.PORT || '3000', 10);

  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => resolve());
  });

  // Optionally start a second listener on AGENT_API_PORT for orchestrator v1 API
  const agentApiPort = parseInt(process.env.AGENT_API_PORT || '', 10);
  if (agentApiPort && agentApiPort !== port) {
    const v1App = (await import('express')).default();
    v1App.use((await import('express')).json({ limit: '10mb' }));
    v1App.use('/api/v1', v1Router);
    v1App.get('/health', (_req, res) => res.json({ status: 'ok' }));
    const v1Server = (await import('http')).createServer(v1App);
    await new Promise<void>((resolve) => v1Server.listen(agentApiPort, '0.0.0.0', () => resolve()));
    console.log(`  Orchestrator API: http://0.0.0.0:${agentApiPort}/api/v1`);
  }

  // Auto-start mode: if AUTO_START=1 and TASK is set, submit an initial chat
  if (process.env.AUTO_START === '1' && process.env.TASK) {
    console.log(`[server] Auto-starting agent task: ${process.env.TASK.slice(0, 100)}`);
    // Import dynamically to avoid circular deps
    const { handleChat } = await import('./api.js');
    // Create a synthetic request to trigger the agent
    const synthReq = {
      body: {
        prompt: process.env.TASK,
        options: {
          provider: process.env.DEFAULT_PROVIDER || 'anthropic',
          model: process.env.AGENT_MODEL || process.env.DEFAULT_MODEL || '',
          workdir: process.env.CODER_WORKDIR || '/workspace',
        },
      },
    } as any;
    const synthRes = {
      status: () => synthRes,
      json: (data: any) => {
        console.log(`[server] Auto-start session created: ${data.sessionId}`);
      },
    } as any;
    await handleChat(synthReq, synthRes);
  }

  // Connect back to orchestrator WebSocket (Docker/cloud mode)
  if (process.env.MAIN_WS_URL) {
    connectToOrchestrator();
  }

  const authStatus = process.env.CODER_API_KEY ? '🔒 authenticated' : '⚠️  open (no CODER_API_KEY set)';
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║   Coder Agent API Server                 ║`);
  console.log(`  ╠══════════════════════════════════════════╣`);
  console.log(`  ║  Web UI:  http://0.0.0.0:${port}              ║`);
  console.log(`  ║  API:     http://0.0.0.0:${port}/api          ║`);
  console.log(`  ║  WS:      ws://0.0.0.0:${port}/ws            ║`);
  console.log(`  ║  Health:  http://0.0.0.0:${port}/health       ║`);
  if (agentApiPort) {
    console.log(`  ║  Orch:    http://0.0.0.0:${agentApiPort}/api/v1     ║`);
  }
  console.log(`  ║  Auth:    ${authStatus.padEnd(33)}║`);
  console.log(`  ║  Workdir: ${((options.workdir ?? process.cwd()) || '/workspace').slice(0, 28).padEnd(28)}║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);

  // Graceful shutdown — disconnect from orchestrator
  process.on('SIGTERM', () => {
    console.log('[server] SIGTERM received — shutting down');
    disconnectFromOrchestrator();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    console.log('[server] SIGINT received — shutting down');
    disconnectFromOrchestrator();
    process.exit(0);
  });
}
