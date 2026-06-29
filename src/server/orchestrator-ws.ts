/**
 * Orchestrator WebSocket client.
 *
 * When running in Docker/cloud mode, the agent connects BACK to the
 * orchestrator API via WebSocket. This is how the orchestrator receives
 * real-time events from spawned agent containers.
 *
 * Env vars expected (set by the orchestrator's Docker spawner):
 *   MAIN_WS_URL    — WebSocket URL of the orchestrator (e.g. ws://api:3001/ws/agent)
 *   AGENT_TOKEN    — Bearer token for authentication
 *   AGENT_ID       — Unique agent ID assigned by the orchestrator
 *   DEPLOYMENT_ID  — Deployment this agent belongs to
 *   SESSION_ID     — Session ID
 */
import WebSocket from 'ws';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30_000;

/** Event listeners that receive parsed messages from the orchestrator. */
type MessageHandler = (msg: Record<string, unknown>) => void;
const handlers: MessageHandler[] = [];

export function onMessage(handler: MessageHandler): void {
  handlers.push(handler);
}

/**
 * Send a message to the orchestrator.
 */
export function sendToOrchestrator(msg: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Connect to the orchestrator WebSocket. Keeps retrying on failure.
 */
export function connectToOrchestrator(): void {
  const url = process.env.MAIN_WS_URL;
  const token = process.env.AGENT_TOKEN;

  if (!url) {
    console.log('[orch-ws] MAIN_WS_URL not set — skipping orchestrator connection');
    return;
  }
  if (!token) {
    console.log('[orch-ws] AGENT_TOKEN not set — cannot authenticate with orchestrator');
    return;
  }

  console.log(`[orch-ws] Connecting to orchestrator: ${url}`);

  ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-agent-id': process.env.AGENT_ID || '',
      'x-deployment-id': process.env.DEPLOYMENT_ID || '',
      'x-session-id': process.env.SESSION_ID || '',
    },
  });

  ws.on('open', () => {
    console.log('[orch-ws] Connected to orchestrator');
    reconnectAttempts = 0;

    // Send handshake
    sendToOrchestrator({
      type: 'agent:ready',
      agentId: process.env.AGENT_ID || 'unknown',
      deploymentId: process.env.DEPLOYMENT_ID || '',
      sessionId: process.env.SESSION_ID || '',
      model: process.env.AGENT_MODEL || 'unknown',
      workdir: process.env.CODER_WORKDIR || '/workspace',
      timestamp: new Date().toISOString(),
    });
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      for (const handler of handlers) {
        try { handler(msg); } catch { /* ignore handler errors */ }
      }
    } catch {
      // Ignore non-JSON messages
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[orch-ws] Disconnected (code=${code}, reason=${reason?.toString() || 'none'})`);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error(`[orch-ws] Error: ${err.message}`);
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY);
  console.log(`[orch-ws] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToOrchestrator();
  }, delay);
}

/**
 * Disconnect from the orchestrator (graceful shutdown).
 */
export function disconnectFromOrchestrator(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    sendToOrchestrator({ type: 'agent:shutdown', agentId: process.env.AGENT_ID || 'unknown' });
    ws.close(1000, 'Agent shutting down');
    ws = null;
  }
}
