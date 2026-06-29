/**
 * Coder Agent — /api/v1/* endpoints
 *
 * These match the contract expected by the cloud-agent orchestrator
 * (see cloud-agent/packages/api/src/routes/agent.routes.ts).
 *
 * All endpoints require AGENT_TOKEN auth (set via env in Docker).
 * File paths are resolved relative to CODER_WORKDIR (/workspace).
 */
import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'fs';
import { resolve, relative, join } from 'path';
import { exec, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function v1Auth(req: Request, res: Response, next: () => void): void {
  const token = process.env.AGENT_TOKEN;
  if (!token) { next(); return; } // Not required if AGENT_TOKEN not set

  const auth = req.headers.authorization?.replace('Bearer ', '') || '';
  if (auth === token) { next(); return; }

  res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
}

// ---------------------------------------------------------------------------
// Sandbox path resolution
// ---------------------------------------------------------------------------

function sandboxPath(inputPath: string): string {
  const workspace = process.env.CODER_WORKDIR || process.env.WORKSPACE_DIR || '/workspace';
  // Prevent path traversal
  const cleaned = inputPath.replace(/\.\./g, '').replace(/\/+/g, '/');
  return resolve(workspace, cleaned.startsWith('/') ? cleaned.slice(1) : cleaned);
}

// ---------------------------------------------------------------------------
// Command tracking (for cancellation)
// ---------------------------------------------------------------------------

const runningCommands = new Map<string, ChildProcess>();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const router = Router();
router.use(v1Auth);

/** GET /api/v1/status — agent health and config */
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    agentId: process.env.AGENT_ID || 'unknown',
    deploymentId: process.env.DEPLOYMENT_ID || '',
    sessionId: process.env.SESSION_ID || '',
    model: process.env.AGENT_MODEL || 'unknown',
    workdir: process.env.CODER_WORKDIR || process.env.WORKSPACE_DIR || '/workspace',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/** GET /api/v1/files?path=<dir> — list directory */
router.get('/files', async (req: Request, res: Response) => {
  try {
    const queryPath = (req.query.path as string) || '.';
    const dirPath = sandboxPath(queryPath);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((e) => !e.name.startsWith('.'))
        .map(async (e) => {
          const fullPath = join(dirPath, e.name);
          let stat;
          try { stat = await fs.stat(fullPath); } catch { stat = null; }
          return {
            name: e.name,
            type: e.isDirectory() ? 'directory' : 'file',
            size: stat?.size ?? 0,
            modifiedAt: stat?.mtime.toISOString() ?? null,
          };
        }),
    );
    files.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, path: queryPath, files });
  } catch (err) {
    res.status(404).json({ success: false, error: (err as Error).message });
  }
});

/** GET /api/v1/files/* — read file content */
router.get('/files/*', async (req: Request, res: Response) => {
  try {
    const filePath = (req.params as any)[0] || '';
    const absPath = sandboxPath(filePath);
    const content = await fs.readFile(absPath, 'utf-8');
    const stat = await fs.stat(absPath);
    res.json({
      success: true,
      path: filePath,
      content,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch (err) {
    res.status(404).json({ success: false, error: (err as Error).message });
  }
});

/** POST /api/v1/files/* — write file content */
router.post('/files/*', async (req: Request, res: Response) => {
  try {
    const filePath = (req.params as any)[0] || '';
    const { content } = req.body as { content?: string };
    if (typeof content !== 'string') {
      res.status(400).json({ success: false, error: 'content is required' });
      return;
    }
    const absPath = sandboxPath(filePath);
    await fs.mkdir(require('path').dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');
    res.json({ success: true, path: filePath, bytesWritten: Buffer.byteLength(content, 'utf-8') });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /api/v1/execute — run a shell command (non-interactive) */
router.post('/execute', async (req: Request, res: Response) => {
  try {
    const { command, timeout = 60_000 } = req.body as { command?: string; timeout?: number };
    if (!command) {
      res.status(400).json({ success: false, error: 'command is required' });
      return;
    }

    const workspace = process.env.CODER_WORKDIR || process.env.WORKSPACE_DIR || '/workspace';
    const commandId = randomUUID();
    const child = exec(command, {
      cwd: workspace,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, HOME: '/home/coder' },
    });

    runningCommands.set(commandId, child);

    // Return immediately with commandId; callers poll or use WS for output
    res.json({ success: true, commandId, status: 'started' });

    // Stream output via callback — stored for retrieval
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });

    child.on('exit', (code) => {
      runningCommands.delete(commandId);
      const result = {
        commandId,
        exitCode: code,
        stdout: stdout.slice(0, 100_000),
        stderr: stderr.slice(0, 100_000),
        status: code === 0 ? 'completed' : 'failed',
      };
      // Store for retrieval
      commandResults.set(commandId, result);
    });

    child.on('error', (err) => {
      runningCommands.delete(commandId);
      commandResults.set(commandId, {
        commandId,
        exitCode: -1,
        stdout: '',
        stderr: err.message,
        status: 'error',
      });
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** Command result cache (keep last 1000) */
const commandResults = new Map<string, { commandId: string; exitCode: number | null; stdout: string; stderr: string; status: string }>();

/** GET /api/v1/execute/:commandId — poll for command result */
router.get('/execute/:commandId', (req: Request, res: Response) => {
  const result = commandResults.get(req.params.commandId);
  if (!result) {
    // Check if still running
    if (runningCommands.has(req.params.commandId)) {
      res.json({ success: true, commandId: req.params.commandId, status: 'running' });
      return;
    }
    res.status(404).json({ success: false, error: 'Command not found' });
    return;
  }
  res.json({ success: true, ...result });
});

/** DELETE /api/v1/execute/:commandId — cancel a running command */
router.delete('/execute/:commandId', (req: Request, res: Response) => {
  const child = runningCommands.get(req.params.commandId);
  if (!child) {
    res.status(404).json({ success: false, error: 'Command not found or already completed' });
    return;
  }
  child.kill('SIGTERM');
  runningCommands.delete(req.params.commandId);
  res.json({ success: true, commandId: req.params.commandId, status: 'cancelled' });
});

// Cleanup old results periodically
setInterval(() => {
  if (commandResults.size > 1000) {
    const keys = Array.from(commandResults.keys());
    for (let i = 0; i < keys.length - 500; i++) commandResults.delete(keys[i]);
  }
}, 60_000);

export default router;
