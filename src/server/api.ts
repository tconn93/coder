/**
 * Coder Agent — HTTP + WebSocket API for external orchestrators.
 *
 * Endpoints:
 *   POST   /api/chat              Start a new agent session (SSE-compatible)
 *   GET    /api/stream/:id         SSE event stream for a session
 *   GET    /api/sessions           List all sessions with status
 *   GET    /api/sessions/:id       Get session details
 *   POST   /api/sessions/:id/cancel  Cancel a running session
 *   POST   /api/resume             Resume a previous session
 *   GET    /api/health             Health check (no auth)
 *   WS     /ws                    WebSocket for real-time events
 *
 * Authentication: Set CODER_API_KEY env var. Pass it as:
 *   - Header:  Authorization: Bearer <key>
 *   - Header:  x-api-key: <key>
 *   - Query:   ?api_key=<key>
 */
import type { Request, Response, NextFunction } from 'express';
import type { WebSocket } from 'ws';
import { AgentOrchestrator } from '../agent/index.js';
import type { AgentOptions, StreamEvent, TokenUsage } from '../types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

let serverWorkdir = process.cwd();
const API_KEY = process.env.CODER_API_KEY || '';

export function setDefaultWorkdir(workdir: string): void {
  serverWorkdir = workdir;
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
  if (apiKeyHeader) return apiKeyHeader;
  const queryKey = req.query.api_key as string | undefined;
  if (queryKey) return queryKey;
  return null;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Health check is public
  if (req.path === '/health') {
    next();
    return;
  }
  // If no API key is configured, allow all (dev mode)
  if (!API_KEY) {
    next();
    return;
  }
  const token = getBearerToken(req);
  if (token === API_KEY) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized — valid API key required', code: 'UNAUTHORIZED' });
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface SessionState {
  sessionId: string;
  orchestrator: AgentOrchestrator;
  events: StreamEvent[];
  sseClients: Set<Response>;
  wsClients: Set<WebSocket>;
  isRunning: boolean;
  startedAt: string;
  prompt: string;
  tokenUsage?: TokenUsage;
  abortController?: AbortController;
}

const sessions = new Map<string, SessionState>();

function generateId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function broadcast(sessionId: string, event: StreamEvent): void {
  const s = sessions.get(sessionId);
  if (!s) return;

  const payload = JSON.stringify(event);

  for (const client of s.sseClients) {
    try { client.write(`data: ${payload}\n\n`); } catch { s.sseClients.delete(client); }
  }
  for (const ws of s.wsClients) {
    try { if (ws.readyState === 1) ws.send(payload); } catch { s.wsClients.delete(ws); }
  }

  s.events.push(event);
  if (s.events.length > 2000) s.events.shift();
}

function buildOptions(overrides?: Partial<AgentOptions>): AgentOptions {
  return {
    provider: overrides?.provider || process.env.DEFAULT_PROVIDER || 'anthropic',
    model: overrides?.model || process.env.DEFAULT_MODEL || '',
    maxTurns: overrides?.maxTurns || parseInt(process.env.CODER_MAX_TURNS || '50', 10),
    budget: overrides?.budget || parseFloat(process.env.CODER_BUDGET || '10.00'),
    permissionMode: overrides?.permissionMode || (process.env.CODER_PERMISSION_MODE as AgentOptions['permissionMode']) || 'acceptEdits',
    workdir: overrides?.workdir || serverWorkdir,
    verbose: overrides?.verbose || false,
  };
}

function sessionSummary(s: SessionState) {
  return {
    sessionId: s.sessionId,
    isRunning: s.isRunning,
    startedAt: s.startedAt,
    prompt: s.prompt.slice(0, 200),
    eventCount: s.events.length,
    tokenUsage: s.tokenUsage ?? null,
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** POST /api/chat — start a new agent session. */
export async function handleChat(req: Request, res: Response): Promise<void> {
  const { prompt, options: userOptions } = req.body as {
    prompt: string;
    options?: Partial<AgentOptions>;
  };

  if (!prompt) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }

  const options = buildOptions(userOptions);
  const sessionId = generateId();
  const orchestrator = new AgentOrchestrator(options.workdir);
  const abortController = new AbortController();

  const state: SessionState = {
    sessionId,
    orchestrator,
    events: [],
    sseClients: new Set(),
    wsClients: new Set(),
    isRunning: true,
    startedAt: new Date().toISOString(),
    prompt,
    abortController,
  };
  sessions.set(sessionId, state);

  // Return immediately with session ID
  res.json({
    sessionId,
    status: 'started',
    workdir: options.workdir,
    provider: options.provider,
    model: options.model || '(default)',
  });

  // Run agent in background
  (async () => {
    try {
      for await (const event of orchestrator.run(prompt, options)) {
        broadcast(sessionId, event);

        if (event.type === 'token_usage') {
          state.tokenUsage = event.data as TokenUsage;
        }

        if (event.type === 'done' || event.type === 'error') {
          state.isRunning = false;
          break;
        }
      }
    } catch (err) {
      broadcast(sessionId, {
        type: 'error',
        data: { message: (err as Error).message, code: 'AGENT_ERROR' },
      });
    } finally {
      state.isRunning = false;
      // Keep session for 1 hour then auto-cleanup
      setTimeout(() => {
        sessions.delete(sessionId);
      }, 3_600_000);
    }
  })().catch((err) => {
    console.error(`[api] Session ${sessionId} error:`, err);
    state.isRunning = false;
  });
}

/** GET /api/stream/:sessionId — SSE event stream. */
export function handleStream(req: Request, res: Response): void {
  const { sessionId } = req.params;
  const s = sessions.get(sessionId);

  if (!s) {
    res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Replay past events
  for (const event of s.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  // Send keepalive to signal the stream is alive even if no events yet
  res.write(`: keepalive\n\n`);

  s.sseClients.add(res);
  req.on('close', () => s.sseClients.delete(res));
}

/** GET /api/sessions — list all sessions. */
export function handleListSessions(_req: Request, res: Response): void {
  const list = Array.from(sessions.values()).map(sessionSummary);
  res.json({
    total: list.length,
    running: list.filter((s) => s.isRunning).length,
    sessions: list,
  });
}

/** GET /api/sessions/:id — session details. */
export function handleGetSession(req: Request, res: Response): void {
  const s = sessions.get(req.params.id);
  if (!s) {
    res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
    return;
  }
  res.json(sessionSummary(s));
}

/** POST /api/sessions/:id/cancel — cancel a running session. */
export function handleCancelSession(req: Request, res: Response): void {
  const s = sessions.get(req.params.id);
  if (!s) {
    res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
    return;
  }
  if (!s.isRunning) {
    res.status(400).json({ error: 'Session is not running', code: 'NOT_RUNNING' });
    return;
  }

  s.isRunning = false;
  s.abortController?.abort();

  broadcast(req.params.id, {
    type: 'error',
    data: { message: 'Session cancelled by orchestrator', code: 'CANCELLED' },
  });

  res.json({ sessionId: req.params.id, status: 'cancelled' });
}

/** POST /api/resume — resume a previous session. */
export async function handleResume(req: Request, res: Response): Promise<void> {
  const { sessionId, prompt, options: userOptions } = req.body as {
    sessionId: string;
    prompt: string;
    options?: Partial<AgentOptions>;
  };

  if (!sessionId || !prompt) {
    res.status(400).json({ error: 'sessionId and prompt are required' });
    return;
  }

  const options = buildOptions(userOptions);
  const newSessionId = generateId();
  const orchestrator = new AgentOrchestrator(options.workdir);

  const state: SessionState = {
    sessionId: newSessionId,
    orchestrator,
    events: [],
    sseClients: new Set(),
    wsClients: new Set(),
    isRunning: true,
    startedAt: new Date().toISOString(),
    prompt,
  };
  sessions.set(newSessionId, state);

  res.json({
    sessionId: newSessionId,
    status: 'resumed',
    originalSessionId: sessionId,
  });

  (async () => {
    try {
      for await (const event of orchestrator.resume(sessionId, prompt, options)) {
        broadcast(newSessionId, event);
        if (event.type === 'token_usage') state.tokenUsage = event.data as TokenUsage;
        if (event.type === 'done' || event.type === 'error') {
          state.isRunning = false;
          break;
        }
      }
    } catch (err) {
      broadcast(newSessionId, {
        type: 'error',
        data: { message: (err as Error).message, code: 'AGENT_ERROR' },
      });
    } finally {
      state.isRunning = false;
      setTimeout(() => sessions.delete(newSessionId), 3_600_000);
    }
  })().catch(console.error);
}

/** GET /api/todos — get todos for a session (or all). */
export function handleTodos(req: Request, res: Response): void {
  const { sessionId } = req.query as { sessionId?: string };

  if (sessionId) {
    const s = sessions.get(sessionId);
    if (!s) {
      res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
      return;
    }
    const todoEvents = s.events.filter((e) => e.type === 'todo_update');
    const latest = todoEvents.length > 0 ? todoEvents[todoEvents.length - 1].data : [];
    res.json({ sessionId, todos: latest });
  } else {
    const all: Record<string, unknown> = {};
    for (const [id, s] of sessions) {
      const todoEvents = s.events.filter((e) => e.type === 'todo_update');
      all[id] = todoEvents.length > 0 ? todoEvents[todoEvents.length - 1].data : [];
    }
    res.json({ todos: all });
  }
}

/** GET /api/status — deprecated, use /api/sessions instead. */
export function handleStatus(_req: Request, res: Response): void {
  const list = Array.from(sessions.values()).map(sessionSummary);
  res.json({
    status: 'ok',
    activeSessions: list.filter((s) => s.isRunning).length,
    totalSessions: list.length,
    sessions: list,
  });
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

export function attachWebSocket(ws: WebSocket, sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) {
    ws.send(JSON.stringify({ type: 'error', data: { message: 'Session not found', code: 'NOT_FOUND' } }));
    ws.close();
    return;
  }

  s.wsClients.add(ws);

  // Replay past events
  for (const event of s.events) {
    try { ws.send(JSON.stringify(event)); } catch { break; }
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as { type: string; sessionId?: string };
      if (msg.type === 'cancel' && msg.sessionId) {
        s.isRunning = false;
        s.abortController?.abort();
        broadcast(sessionId, {
          type: 'error',
          data: { message: 'Session cancelled via WebSocket', code: 'CANCELLED' },
        });
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on('close', () => s.wsClients.delete(ws));
  ws.on('error', () => s.wsClients.delete(ws));
}
