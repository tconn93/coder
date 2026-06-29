/**
 * Orchestrator WebSocket client — connects agent2.0 back to the cloud-agent
 * orchestrator API via Socket.io.
 *
 * When running in Docker/cloud mode, the orchestrator spawns this agent and
 * expects it to connect back via Socket.io for real-time events and commands.
 *
 * Environment variables (set by the orchestrator's spawner):
 *   MAIN_WS_URL    — Socket.io URL (e.g. http://api:3001/ws)
 *   AGENT_TOKEN    — JWT bearer token for authentication
 *   AGENT_ID       — Unique agent ID assigned by orchestrator
 *   DEPLOYMENT_ID  — Deployment this agent belongs to
 *   SESSION_ID     — Orchestrator session ID
 *   AGENT_HOST     — Hostname for the REST URL (default: localhost)
 *   AGENT_REST_URL — Explicit REST URL override for Docker NAT scenarios
 *   AGENT_API_PORT — Port this agent's v1 API listens on (default: computed)
 *   AGENT_TYPE     — Agent type slug (default: 'coder')
 *   AGENT_MODEL    — Default model (default: 'claude-sonnet-4-6')
 *   CODER_WORKDIR  — Workspace directory (default: /workspace)
 */
import { io as ioClient, type Socket } from 'socket.io-client';
import {
  startOrchestratorSession,
  interveneOrchestratorSession,
  cancelOrchestratorSession,
} from './api.js';
import type { StreamEvent, AgentOptions } from '../types.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const MAIN_WS = process.env.MAIN_WS_URL || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const AGENT_ID = process.env.AGENT_ID || `agent2.0-${Date.now()}`;
const SESSION_ID = process.env.SESSION_ID || '';
const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID || '';
const AGENT_TYPE = process.env.AGENT_TYPE || 'coder';
const AGENT_MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-6';
const AGENT_HOST = process.env.AGENT_HOST || 'localhost';
const WORKDIR = process.env.CODER_WORKDIR || process.env.WORKSPACE_DIR || '/workspace';

// REST URL the orchestrator uses to proxy HTTP calls to this agent
const AGENT_API_PORT = process.env.AGENT_API_PORT
  ? parseInt(process.env.AGENT_API_PORT, 10)
  : (parseInt(process.env.PORT || '3000', 10));
const AGENT_REST_URL =
  process.env.AGENT_REST_URL || `http://${AGENT_HOST}:${AGENT_API_PORT}`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let socket: Socket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30_000;
let eventSequence = 0;
let isShuttingDown = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAgentOptions(overrides?: Partial<AgentOptions>): AgentOptions {
  return {
    provider: overrides?.provider || process.env.DEFAULT_PROVIDER || 'anthropic',
    model: overrides?.model || process.env.DEFAULT_MODEL || AGENT_MODEL,
    maxTurns: overrides?.maxTurns || parseInt(process.env.CODER_MAX_TURNS || '50', 10),
    budget: overrides?.budget || parseFloat(process.env.CODER_BUDGET || '10.00'),
    permissionMode:
      overrides?.permissionMode ||
      (process.env.CODER_PERMISSION_MODE as AgentOptions['permissionMode']) ||
      'acceptEdits',
    workdir: overrides?.workdir || WORKDIR,
    verbose: overrides?.verbose || false,
  };
}

/**
 * Emit an event to the orchestrator in the format it expects:
 * { type, id, sessionId, agentId, timestamp, sequence, payload }
 */
function emitOrchestratorEvent(type: string, payload: Record<string, unknown>): void {
  if (!socket?.connected) return;
  eventSequence += 1;
  socket.emit(type, {
    type,
    id: `evt-${Date.now()}-${eventSequence}`,
    sessionId: SESSION_ID,
    agentId: AGENT_ID,
    timestamp: new Date().toISOString(),
    sequence: eventSequence,
    payload,
  });
}

/**
 * Bridge agent2.0's internal StreamEvent types to the orchestrator's
 * expected event protocol.
 */
function bridgeStreamEvent(event: StreamEvent): void {
  switch (event.type) {
    case 'text': {
      // Streaming text deltas → agent:thought
      emitOrchestratorEvent('agent:thought', {
        chunk: event.data as string,
        isDelta: true,
        thoughtId: `th-${Date.now()}`,
        category: 'reasoning',
      });
      break;
    }

    case 'tool_call': {
      const tc = event.data as { name: string; input: unknown };
      emitOrchestratorEvent('agent:log', {
        stream: 'stdout',
        lines: [`[${tc.name}] ${JSON.stringify(tc.input).slice(0, 200)}`],
        source: 'system',
      });
      break;
    }

    case 'tool_result': {
      const tr = event.data as { toolName: string; output: string };
      emitOrchestratorEvent('agent:log', {
        stream: 'stdout',
        lines: [`  → ${tr.output.slice(0, 300)}`],
        source: 'system',
      });
      break;
    }

    case 'todo_update': {
      // Not mapped to a standard orchestrator event — send as log
      const todos = event.data as Array<{ title: string; status: string }>;
      if (todos.length > 0) {
        emitOrchestratorEvent('agent:log', {
          stream: 'system',
          lines: todos.map((t) => `[${t.status}] ${t.title}`),
          source: 'todo',
        });
      }
      break;
    }

    case 'token_usage': {
      // Token usage is internal — skip for now (orchestrator tracks its own)
      break;
    }

    case 'subagent': {
      const sa = event.data as { name: string; status: string };
      emitOrchestratorEvent('agent:log', {
        stream: 'system',
        lines: [`Subagent ${sa.name}: ${sa.status}`],
        source: 'system',
      });
      break;
    }

    case 'done': {
      const done = event.data as { result: string; tokenUsage: unknown };
      emitOrchestratorEvent('agent:done', {
        outcome: 'completed',
        summary: done.result?.slice(0, 500) || 'Task completed',
        finalState: 'done',
      });

      // Also notify idle status so the orchestrator shows correct state
      emitOrchestratorEvent('agent:status', {
        state: 'idle',
        uptimeSeconds: Math.floor(process.uptime()),
        claudeActive: false,
        queueDepth: 0,
      });
      break;
    }

    case 'error': {
      const err = event.data as { message: string; code?: string };
      emitOrchestratorEvent('agent:done', {
        outcome: 'error',
        summary: err.message,
        finalState: 'error',
      });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleCommandStart(data: Record<string, unknown>): Promise<void> {
  const payload = (data.payload || data) as Record<string, unknown>;
  const task = (payload.task?.description as string) || (payload.taskDescription as string) || (payload.prompt as string);

  if (!task) {
    console.log('[orch-ws] command:start received without task — ignoring');
    return;
  }

  console.log(`[orch-ws] Starting orchestrator session: ${task.slice(0, 100)}`);

  emitOrchestratorEvent('agent:status', {
    state: 'running',
    uptimeSeconds: Math.floor(process.uptime()),
    claudeActive: true,
    queueDepth: 0,
  });

  const options = buildAgentOptions();

  await startOrchestratorSession(
    SESSION_ID,
    task,
    options,
    bridgeStreamEvent,
  );
}

async function handleCommandIntervene(data: Record<string, unknown>): Promise<void> {
  const payload = (data.payload || data) as Record<string, unknown>;
  const message = (payload.message as string) || '';

  if (!message) {
    console.log('[orch-ws] command:intervene received without message — ignoring');
    return;
  }

  console.log(`[orch-ws] Intervene: ${message.slice(0, 100)}`);

  emitOrchestratorEvent('agent:status', {
    state: 'running',
    uptimeSeconds: Math.floor(process.uptime()),
    claudeActive: true,
    queueDepth: 0,
  });

  const options = buildAgentOptions();

  await interveneOrchestratorSession(
    SESSION_ID,
    message,
    options,
    bridgeStreamEvent,
  );
}

function handleCommandStop(): void {
  console.log('[orch-ws] Stopping agent');
  const cancelled = cancelOrchestratorSession(SESSION_ID);

  emitOrchestratorEvent('agent:done', {
    outcome: cancelled ? 'stopped' : 'already_stopped',
    summary: 'Agent stopped by orchestrator command',
    finalState: 'done',
  });

  emitOrchestratorEvent('agent:status', {
    state: 'idle',
    uptimeSeconds: Math.floor(process.uptime()),
    claudeActive: false,
    queueDepth: 0,
  });
}

function handleCommandPause(): void {
  console.log('[orch-ws] Pause requested (not fully supported — cancelling current run)');
  // agent2.0 doesn't have a native pause — we cancel the current session
  cancelOrchestratorSession(SESSION_ID);

  emitOrchestratorEvent('agent:status', {
    state: 'paused',
    uptimeSeconds: Math.floor(process.uptime()),
    claudeActive: false,
    queueDepth: 0,
  });
}

function handleCommandResume(): void {
  console.log('[orch-ws] Resume requested');
  emitOrchestratorEvent('agent:status', {
    state: 'idle',
    uptimeSeconds: Math.floor(process.uptime()),
    claudeActive: false,
    queueDepth: 0,
  });
}

async function handleCommandPushBranch(): Promise<void> {
  console.log('[orch-ws] Push branch requested');

  try {
    const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: WORKDIR });
    const branchName = branchOut.trim();

    await execAsync('git add -A', { cwd: WORKDIR });
    await execAsync('git commit -m "agent: snapshot" --allow-empty', { cwd: WORKDIR });
    await execAsync(`git push origin ${branchName} --set-upstream`, { cwd: WORKDIR });

    emitOrchestratorEvent('agent:branch_pushed', {
      branchName,
      sessionId: SESSION_ID,
    });

    emitOrchestratorEvent('agent:log', {
      stream: 'system',
      lines: [`Branch ${branchName} pushed successfully`],
      source: 'git',
    });
  } catch (err) {
    emitOrchestratorEvent('agent:log', {
      stream: 'stderr',
      lines: [`Push failed: ${(err as Error).message}`],
      source: 'git',
    });
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

function scheduleReconnect(): void {
  if (isShuttingDown || reconnectTimer) return;

  reconnectAttempts++;
  const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY);
  console.log(`[orch-ws] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToOrchestrator();
  }, delay);
}

/**
 * Connect to the orchestrator WebSocket. Keeps retrying on failure.
 */
export function connectToOrchestrator(): void {
  if (!MAIN_WS) {
    console.log('[orch-ws] MAIN_WS_URL not set — skipping orchestrator connection');
    return;
  }
  if (!AGENT_TOKEN) {
    console.log('[orch-ws] AGENT_TOKEN not set — cannot authenticate with orchestrator');
    return;
  }

  console.log(`[orch-ws] Connecting to orchestrator: ${MAIN_WS}`);

  socket = ioClient(MAIN_WS, {
    path: '/ws',
    transports: ['websocket'],
    auth: { token: AGENT_TOKEN },
    query: {
      role: 'agent',
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      deploymentId: DEPLOYMENT_ID,
    },
    extraHeaders: {
      'X-Agent-Token': AGENT_TOKEN,
      'X-Agent-Id': AGENT_ID,
      'X-Agent-Rest-Url': AGENT_REST_URL,
      'X-Agent-Type': AGENT_TYPE,
    },
    reconnection: false, // We handle reconnection ourselves
  });

  socket.on('connect', () => {
    console.log('[orch-ws] Connected to orchestrator');
    reconnectAttempts = 0;

    // Announce readiness — send status so orchestrator knows we're alive
    emitOrchestratorEvent('agent:status', {
      state: 'idle',
      uptimeSeconds: Math.floor(process.uptime()),
      claudeActive: false,
      queueDepth: 0,
    });

    // Also send agent:log so UI sees the agent came online
    emitOrchestratorEvent('agent:log', {
      stream: 'system',
      lines: [`Agent ${AGENT_ID} connected (type: ${AGENT_TYPE}, model: ${AGENT_MODEL})`],
      source: 'system',
    });
  });

  // ── Inbound orchestrator commands ──
  socket.on('command:start', (data: Record<string, unknown>) => {
    void handleCommandStart(data);
  });

  socket.on('command:intervene', (data: Record<string, unknown>) => {
    void handleCommandIntervene(data);
  });

  socket.on('command:stop', () => {
    handleCommandStop();
  });

  socket.on('command:pause', () => {
    handleCommandPause();
  });

  socket.on('command:resume', () => {
    handleCommandResume();
  });

  socket.on('command:push_branch', () => {
    void handleCommandPushBranch();
  });

  // Also accept the command format used by the frontend:
  // { type: "command:intervene", payload: { message } }
  socket.on('agent:command', (data: Record<string, unknown>) => {
    const cmdType = (data.type as string) || '';
    if (cmdType === 'intervene') {
      void handleCommandIntervene(data);
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', (reason: string) => {
    console.log(`[orch-ws] Disconnected: ${reason}`);
    if (!isShuttingDown) {
      scheduleReconnect();
    }
  });

  socket.on('connect_error', (err: Error) => {
    console.error(`[orch-ws] Connection error: ${err.message}`);
    // Socket.io will auto-retry unless we stop it — our manual reconnection
    // kicks in on 'disconnect'. Don't double-schedule.
  });
}

/**
 * Send a message to the orchestrator. Public for use by other modules.
 */
export function sendToOrchestrator(type: string, payload: Record<string, unknown>): void {
  emitOrchestratorEvent(type, payload);
}

/**
 * Disconnect from the orchestrator (graceful shutdown).
 */
export function disconnectFromOrchestrator(): void {
  isShuttingDown = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (socket) {
    emitOrchestratorEvent('agent:done', {
      outcome: 'stopped',
      summary: 'Agent shutting down',
      finalState: 'done',
    });
    socket.disconnect();
    socket = null;
  }
}
