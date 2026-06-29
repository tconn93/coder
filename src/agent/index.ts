import { readFile, access } from 'fs/promises';
import { join } from 'path';
import type {
  AgentOptions,
  AgentSession,
  StreamEvent,
  TokenUsage,
} from '../types.js';
import { runAgentLoop } from './loop.js';
import { SkillsLoader } from './skills.js';
import { AgentLoader } from './agentLoader.js';
import { loadProjectConfig } from '../config.js';
import { MemoryManager } from './memory.js';
import { NotepadManager } from './notepad.js';
import { EventBus } from './eventBus.js';
import { HookRunner } from './hooks.js';

export class AgentOrchestrator {
  private sessions: Map<string, AgentSession> = new Map();
  // Stores message history per session for resume
  private sessionMessages: Map<string, unknown[]> = new Map();
  private skillsLoader: SkillsLoader;
  private agentLoader: AgentLoader;
  private memoryManager: MemoryManager;
  private notepadManager: NotepadManager;
  private eventBus: EventBus;
  private hookRunner?: HookRunner;

  constructor(workdir?: string) {
    const wd = workdir ?? process.cwd();
    this.skillsLoader = new SkillsLoader(
      workdir ? join(workdir, 'skills') : undefined,
    );
    this.agentLoader = new AgentLoader(
      workdir ? join(workdir, 'agents') : join(process.cwd(), 'agents'),
    );
    this.memoryManager = new MemoryManager(wd);
    this.notepadManager = new NotepadManager(wd);
    this.eventBus = new EventBus();
  }

  /** Access the shared EventBus (for external hook registration). */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Main entry point. Returns an async generator of StreamEvents.
   */
  async *run(
    prompt: string,
    options: AgentOptions,
  ): AsyncGenerator<StreamEvent> {
    await this.skillsLoader.loadAll();
    const skillsContext = this.skillsLoader.getSystemPromptAddition();
    const systemPrompt = await this.buildSystemPrompt(options, skillsContext);
    const customAgents = await this.agentLoader.loadAll();
    const projectConfig = await loadProjectConfig(options.workdir);

    // Wire up hooks from project config
    if (projectConfig.hooks) {
      if (this.hookRunner) this.hookRunner.unregister();
      this.hookRunner = new HookRunner(this.eventBus, projectConfig.hooks);
      this.hookRunner.register();
    }

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const tokenUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };

    const session: AgentSession = {
      sessionId,
      prompt,
      options,
      startedAt: new Date(),
      tokenUsage,
      todos: [],
    };
    this.sessions.set(sessionId, session);

    // Emit session.start
    await this.eventBus.emit('session.start', {
      event: 'session.start',
      sessionId,
      workdir: options.workdir,
      timestamp: new Date().toISOString(),
      prompt,
    });

    let sessionError = false;

    for await (const event of runAgentLoop({
      prompt,
      systemPrompt,
      provider: options.provider,
      model: options.model,
      maxTurns: options.maxTurns,
      permissionMode: options.permissionMode,
      workdir: options.workdir,
      verbose: options.verbose,
      sessionId,
      customAgents,
      debugPrompt: projectConfig.debugPrompt,
      budget: options.budget,
      memoryManager: this.memoryManager,
      notepadManager: this.notepadManager,
      eventBus: this.eventBus,
    })) {
      if (event.type === 'token_usage') {
        session.tokenUsage = event.data as TokenUsage;
      } else if (event.type === 'todo_update') {
        session.todos = event.data as AgentSession['todos'];
      } else if (event.type === 'error') {
        sessionError = true;
        await this.eventBus.emit('session.error', {
          event: 'session.error',
          sessionId,
          workdir: options.workdir,
          timestamp: new Date().toISOString(),
          error: String((event.data as { message: string }).message),
        });
      } else if (event.type === 'done') {
        // Persist message history so the session can be resumed
        const done = event.data as { messages?: unknown[] };
        if (done.messages) {
          this.sessionMessages.set(sessionId, done.messages);
        }
      }

      yield event;
    }

    // Emit session.end (unless already errored — error hook already fired above)
    if (!sessionError) {
      await this.eventBus.emit('session.end', {
        event: 'session.end',
        sessionId,
        workdir: options.workdir,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Resume a previous session by replaying the conversation history.
   * The new prompt is appended as the next user turn.
   */
  async *resume(
    sessionId: string,
    newPrompt: string,
    options: AgentOptions,
  ): AsyncGenerator<StreamEvent> {
    const previousMessages = this.sessionMessages.get(sessionId) ?? [];

    await this.skillsLoader.loadAll();
    const skillsContext = this.skillsLoader.getSystemPromptAddition();
    const systemPrompt = await this.buildSystemPrompt(options, skillsContext);
    const customAgents = await this.agentLoader.loadAll();
    const projectConfig = await loadProjectConfig(options.workdir);

    // Wire up hooks if not already registered
    if (projectConfig.hooks) {
      if (this.hookRunner) this.hookRunner.unregister();
      this.hookRunner = new HookRunner(this.eventBus, projectConfig.hooks);
      this.hookRunner.register();
    }

    await this.eventBus.emit('session.start', {
      event: 'session.start',
      sessionId,
      workdir: options.workdir,
      timestamp: new Date().toISOString(),
      prompt: newPrompt,
    });

    let sessionError = false;

    for await (const event of runAgentLoop({
      prompt: newPrompt,
      systemPrompt,
      provider: options.provider,
      model: options.model,
      maxTurns: options.maxTurns,
      permissionMode: options.permissionMode,
      workdir: options.workdir,
      verbose: options.verbose,
      previousMessages,
      sessionId,
      customAgents,
      debugPrompt: projectConfig.debugPrompt,
      budget: options.budget,
      memoryManager: this.memoryManager,
      notepadManager: this.notepadManager,
      eventBus: this.eventBus,
    })) {
      if (event.type === 'error') {
        sessionError = true;
        await this.eventBus.emit('session.error', {
          event: 'session.error',
          sessionId,
          workdir: options.workdir,
          timestamp: new Date().toISOString(),
          error: String((event.data as { message: string }).message),
        });
      } else if (event.type === 'done') {
        const done = event.data as { messages?: unknown[] };
        if (done.messages) {
          this.sessionMessages.set(sessionId, done.messages);
        }
      }
      yield event;
    }

    if (!sessionError) {
      await this.eventBus.emit('session.end', {
        event: 'session.end',
        sessionId,
        workdir: options.workdir,
        timestamp: new Date().toISOString(),
      });
    }
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  private async buildSystemPrompt(
    options: AgentOptions,
    skillsContext: string,
  ): Promise<string> {
    const lines: string[] = [
      'You are an expert AI coding agent. You help developers write, review, debug, and refactor code.',
      '',
      '## Context',
      `**Working directory:** ${options.workdir}`,
    ];

    // Git status
    try {
      const { execSync } = await import('child_process');
      const gitStatus = execSync('git status --short 2>/dev/null', {
        cwd: options.workdir,
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      if (gitStatus) {
        lines.push(`**Git status:**\n\`\`\`\n${gitStatus.slice(0, 500)}\n\`\`\``);
      }
    } catch {
      // Not a git repo
    }

    // Project name from package.json
    try {
      const pkgPath = join(options.workdir, 'package.json');
      await access(pkgPath);
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as Record<string, unknown>;
      if (pkg.name) lines.push(`**Project:** ${pkg.name} v${pkg.version ?? 'unknown'}`);
      if (pkg.description) lines.push(`**Description:** ${pkg.description}`);
    } catch {
      // No package.json
    }

    lines.push(
      '',
      '## Instructions',
      '1. Use available tools to read, write, and modify files as needed.',
      "2. Use todo_write to track complex multi-step tasks for the user's visibility.",
      '3. Run tests and verify changes before declaring success.',
      '4. Be concise in explanations but thorough in your work.',
      '5. When spawning subagents for specialized tasks, explain what they will do.',
      '6. Use spawn_swarm for parallel tasks. When the swarm returns, act as the Reviewer: aggregate their outputs, resolve conflicts, and apply resulting changes cleanly.',
    );

    if (skillsContext) {
      lines.push('', skillsContext);
    }

    // CLAUDE.md project instructions
    try {
      const claudeMd = await readFile(join(options.workdir, 'CLAUDE.md'), 'utf-8');
      lines.push('', '## Project Instructions', claudeMd.trim());
    } catch {
      // No CLAUDE.md
    }

    // AGENTS.md agent instructions
    try {
      const agentsMd = await readFile(join(options.workdir, 'AGENTS.md'), 'utf-8');
      lines.push('', '## Agent Instructions', agentsMd.trim());
    } catch {
      // No AGENTS.md
    }

    // Memory context
    try {
      await this.memoryManager.load();
      const memorySummary = this.memoryManager.getSummary();
      if (memorySummary) {
        lines.push('', '## Memory', memorySummary);
      }
    } catch {
      // Memory unavailable
    }

    if (options.systemPromptExtra) {
      lines.push('', options.systemPromptExtra);
    }

    return lines.join('\n');
  }
}
