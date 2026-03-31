import { AgentOrchestrator } from '../agent/index.js';
const activeSessions = new Map();
function generateSessionId() {
    return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
function broadcastToSession(sessionId, event) {
    const activeSession = activeSessions.get(sessionId);
    if (!activeSession)
        return;
    const payload = JSON.stringify(event);
    // Broadcast to SSE clients
    for (const client of activeSession.sseClients) {
        try {
            client.write(`data: ${payload}\n\n`);
        }
        catch {
            activeSession.sseClients.delete(client);
        }
    }
    // Broadcast to WebSocket clients
    for (const ws of activeSession.wsClients) {
        try {
            if (ws.readyState === 1 /* OPEN */) {
                ws.send(payload);
            }
        }
        catch {
            activeSession.wsClients.delete(ws);
        }
    }
    // Store event for late-joining clients
    activeSession.events.push(event);
    // Keep only last 1000 events
    if (activeSession.events.length > 1000) {
        activeSession.events.shift();
    }
}
export async function handleChat(req, res) {
    const { prompt, options: userOptions } = req.body;
    if (!prompt) {
        res.status(400).json({ error: 'prompt is required' });
        return;
    }
    const sessionId = generateSessionId();
    const options = {
        provider: userOptions?.provider || 'anthropic',
        model: userOptions?.model || 'claude-sonnet-4-6',
        maxTurns: userOptions?.maxTurns || 50,
        budget: userOptions?.budget || 5.0,
        permissionMode: userOptions?.permissionMode || 'acceptEdits',
        workdir: userOptions?.workdir || process.cwd(),
        verbose: userOptions?.verbose || false,
    };
    const orchestrator = new AgentOrchestrator(options.workdir);
    const activeSession = {
        orchestrator,
        session: null,
        events: [],
        sseClients: new Set(),
        wsClients: new Set(),
        isRunning: true,
        sessionId,
    };
    activeSessions.set(sessionId, activeSession);
    res.json({ sessionId, status: 'started' });
    // Run the agent in background
    (async () => {
        try {
            for await (const event of orchestrator.run(prompt, options)) {
                broadcastToSession(sessionId, event);
                if (event.type === 'done' || event.type === 'error') {
                    activeSession.isRunning = false;
                    break;
                }
            }
        }
        catch (err) {
            const error = err;
            broadcastToSession(sessionId, {
                type: 'error',
                data: { message: error.message },
            });
        }
        finally {
            activeSession.isRunning = false;
        }
    })().catch(console.error);
}
export function handleStream(req, res) {
    const { sessionId } = req.params;
    const activeSession = activeSessions.get(sessionId);
    if (!activeSession) {
        res.status(404).json({ error: 'Session not found' });
        return;
    }
    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();
    // Send all past events to this new client
    for (const event of activeSession.events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    // Add to active clients
    activeSession.sseClients.add(res);
    // Clean up on disconnect
    req.on('close', () => {
        activeSession.sseClients.delete(res);
    });
}
export function handleTodos(req, res) {
    const { sessionId } = req.query;
    if (sessionId) {
        const activeSession = activeSessions.get(sessionId);
        if (!activeSession) {
            res.status(404).json({ error: 'Session not found' });
            return;
        }
        // Find todos from events
        const todoEvents = activeSession.events.filter((e) => e.type === 'todo_update');
        const latestTodos = todoEvents.length > 0 ? todoEvents[todoEvents.length - 1].data : [];
        res.json({ todos: latestTodos });
    }
    else {
        res.json({ todos: [] });
    }
}
export function handleStatus(req, res) {
    const sessions = Array.from(activeSessions.entries()).map(([id, s]) => ({
        sessionId: id,
        isRunning: s.isRunning,
        eventCount: s.events.length,
    }));
    res.json({
        status: 'ok',
        activeSessions: sessions.filter((s) => s.isRunning).length,
        totalSessions: sessions.length,
        sessions,
    });
}
export function handleResume(req, res) {
    const { sessionId, prompt, options: userOptions } = req.body;
    if (!sessionId || !prompt) {
        res.status(400).json({ error: 'sessionId and prompt are required' });
        return;
    }
    const newSessionId = generateSessionId();
    const options = {
        provider: userOptions?.provider || 'anthropic',
        model: userOptions?.model || 'claude-sonnet-4-6',
        maxTurns: userOptions?.maxTurns || 50,
        budget: userOptions?.budget || 5.0,
        permissionMode: userOptions?.permissionMode || 'acceptEdits',
        workdir: userOptions?.workdir || process.cwd(),
        verbose: userOptions?.verbose || false,
    };
    const orchestrator = new AgentOrchestrator(options.workdir);
    const activeSession = {
        orchestrator,
        session: null,
        events: [],
        sseClients: new Set(),
        wsClients: new Set(),
        isRunning: true,
        sessionId: newSessionId,
    };
    activeSessions.set(newSessionId, activeSession);
    res.json({ sessionId: newSessionId, status: 'resumed' });
    (async () => {
        try {
            for await (const event of orchestrator.resume(sessionId, prompt, options)) {
                broadcastToSession(newSessionId, event);
                if (event.type === 'done' || event.type === 'error') {
                    activeSession.isRunning = false;
                    break;
                }
            }
        }
        catch (err) {
            const error = err;
            broadcastToSession(newSessionId, {
                type: 'error',
                data: { message: error.message },
            });
        }
        finally {
            activeSession.isRunning = false;
        }
    })().catch(console.error);
}
export function attachWebSocket(ws, sessionId) {
    const activeSession = activeSessions.get(sessionId);
    if (!activeSession) {
        ws.send(JSON.stringify({ type: 'error', data: { message: 'Session not found' } }));
        ws.close();
        return;
    }
    activeSession.wsClients.add(ws);
    // Send past events
    for (const event of activeSession.events) {
        ws.send(JSON.stringify(event));
    }
    ws.on('close', () => {
        activeSession.wsClients.delete(ws);
    });
    ws.on('error', () => {
        activeSession.wsClients.delete(ws);
    });
}
//# sourceMappingURL=api.js.map