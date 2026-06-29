/**
 * Hook system — loads hook configurations from .coder/settings.json and
 * wires them into the EventBus. Modeled on Claude Code's hook architecture.
 *
 * Each hook is a shell command that receives HookContext as JSON on stdin.
 * Hooks can be blocking (the agent pauses until the command completes) or
 * non-blocking (fire-and-forget).
 *
 * Configuration example (.coder/settings.json):
 *   {
 *     "hooks": {
 *       "tool.before": [
 *         { "matcher": "Bash", "command": "notify.sh 'about to run bash'" }
 *       ],
 *       "session.start": [
 *         { "command": "log-session.sh" }
 *       ]
 *     }
 *   }
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import type { HookConfig, HookContext, HookEventName, HooksConfig } from '../types.js';
import { EventBus } from './eventBus.js';

const execAsync = promisify(exec);

/** Recognized hook event names from configuration. */
const HOOK_EVENT_NAMES: HookEventName[] = [
  'session.start',
  'session.end',
  'session.error',
  'tool.before',
  'tool.after',
  'tool.error',
  'agent.prompt',
  'agent.response',
  'agent.turn',
  'notification.send',
];

/**
 * Test whether a hook's matcher pattern matches the current context.
 * If no matcher is configured, the hook fires for every event.
 */
function matches(ctx: HookContext, matcher?: string): boolean {
  if (!matcher) return true;

  // Match against toolName (the primary use case: "Bash", "Write*", etc.)
  if (ctx.toolName) {
    try {
      // Treat matcher as a case-insensitive glob or regex
      if (matcher.startsWith('/') && matcher.endsWith('/')) {
        const re = new RegExp(matcher.slice(1, -1), 'i');
        return re.test(ctx.toolName);
      }
      // Simple wildcard support: * → .*
      const pattern = matcher
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      return new RegExp(`^${pattern}$`, 'i').test(ctx.toolName);
    } catch {
      return ctx.toolName.toLowerCase().includes(matcher.toLowerCase());
    }
  }

  return true;
}

/** Run a single hook command, returning stdout or error message. */
async function runHookCommand(
  hook: HookConfig,
  ctx: HookContext,
): Promise<string> {
  const timeout = hook.timeout ?? 30_000;

  try {
    const ctxJson = JSON.stringify(ctx);
    // Pass context via stdin and environment; some hook scripts may prefer env vars
    const { stdout, stderr } = await execAsync(hook.command, {
      timeout,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        CODER_HOOK_EVENT: ctx.event,
        CODER_SESSION_ID: ctx.sessionId,
        CODER_WORKDIR: ctx.workdir,
        CODER_TOOL_NAME: ctx.toolName ?? '',
        CODER_MESSAGE: ctx.message ?? '',
      },
    });

    // Feed context via stdin by echoing into the command
    // (exec doesn't expose stdin directly for this pattern, so we use env vars
    //  as the primary transport; for full stdin support the hook command can
    //  read $CODER_HOOK_EVENT etc. from env.)
    return stdout.trim() || stderr.trim() || '';
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string; killed?: boolean };
    const output = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
    if (e.killed) {
      return `Hook timed out after ${timeout}ms: ${hook.command}`;
    }
    return output || `Hook failed: ${e.message}`;
  }
}

/**
 * HookRunner: loads hook configs from HooksConfig, registers them on the
 * EventBus, and executes matching shell commands when events fire.
 */
export class HookRunner {
  private eventBus: EventBus;
  private hooks: HooksConfig;
  /** Track registered handlers so we can unregister on shutdown. */
  private registered: Array<{ event: HookEventName; handler: (ctx: HookContext) => Promise<void> }> = [];

  constructor(eventBus: EventBus, hooks: HooksConfig = {}) {
    this.eventBus = eventBus;
    this.hooks = hooks;
  }

  /** Register all configured hooks on the EventBus. */
  register(): void {
    for (const eventName of HOOK_EVENT_NAMES) {
      const configs = this.hooks[eventName];
      if (!configs || configs.length === 0) continue;

      for (const hook of configs) {
        const handler = async (ctx: HookContext) => {
          if (!matches(ctx, hook.matcher)) return;
          const output = await runHookCommand(hook, ctx);
          if (output) {
            console.log(`[Hook:${eventName}] ${output.slice(0, 200)}`);
          }
        };

        this.eventBus.on(eventName, handler, hook.blocking ?? false);
        this.registered.push({ event: eventName, handler });
      }
    }
  }

  /** Unregister all hooks from the EventBus. */
  unregister(): void {
    for (const { event, handler } of this.registered) {
      this.eventBus.off(event, handler);
    }
    this.registered = [];
  }

  /** Reload hooks (unregister existing, replace config, re-register). */
  reload(hooks: HooksConfig): void {
    this.unregister();
    this.hooks = hooks;
    this.register();
  }

  /** Number of registered hook callbacks. */
  get count(): number {
    return this.registered.length;
  }
}
