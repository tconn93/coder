import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { runAgentLoop } from './loop.js';
import { SkillsLoader } from './skills.js';
export class AgentOrchestrator {
    sessions = new Map();
    // Stores message history per session for resume
    sessionMessages = new Map();
    skillsLoader;
    constructor(workdir) {
        this.skillsLoader = new SkillsLoader(workdir ? join(workdir, 'skills') : undefined);
    }
    /**
     * Main entry point. Returns an async generator of StreamEvents.
     */
    async *run(prompt, options) {
        await this.skillsLoader.loadAll();
        const skillsContext = this.skillsLoader.getSystemPromptAddition();
        const systemPrompt = await this.buildSystemPrompt(options, skillsContext);
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const tokenUsage = {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
        };
        const session = {
            sessionId,
            prompt,
            options,
            startedAt: new Date(),
            tokenUsage,
            todos: [],
        };
        this.sessions.set(sessionId, session);
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
        })) {
            if (event.type === 'token_usage') {
                session.tokenUsage = event.data;
            }
            else if (event.type === 'todo_update') {
                session.todos = event.data;
            }
            else if (event.type === 'done') {
                // Persist message history so the session can be resumed
                const done = event.data;
                if (done.messages) {
                    this.sessionMessages.set(sessionId, done.messages);
                }
            }
            yield event;
        }
    }
    /**
     * Resume a previous session by replaying the conversation history.
     * The new prompt is appended as the next user turn.
     */
    async *resume(sessionId, newPrompt, options) {
        const previousMessages = this.sessionMessages.get(sessionId) ?? [];
        await this.skillsLoader.loadAll();
        const skillsContext = this.skillsLoader.getSystemPromptAddition();
        const systemPrompt = await this.buildSystemPrompt(options, skillsContext);
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
        })) {
            if (event.type === 'done') {
                const done = event.data;
                if (done.messages) {
                    this.sessionMessages.set(sessionId, done.messages);
                }
            }
            yield event;
        }
    }
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    getAllSessions() {
        return Array.from(this.sessions.values());
    }
    async buildSystemPrompt(options, skillsContext) {
        const lines = [
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
        }
        catch {
            // Not a git repo
        }
        // Project name from package.json
        try {
            const pkgPath = join(options.workdir, 'package.json');
            await access(pkgPath);
            const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
            if (pkg.name)
                lines.push(`**Project:** ${pkg.name} v${pkg.version ?? 'unknown'}`);
            if (pkg.description)
                lines.push(`**Description:** ${pkg.description}`);
        }
        catch {
            // No package.json
        }
        lines.push('', '## Instructions', '1. Use available tools to read, write, and modify files as needed.', "2. Use todo_write to track complex multi-step tasks for the user's visibility.", '3. Run tests and verify changes before declaring success.', '4. Be concise in explanations but thorough in your work.', '5. When spawning subagents for specialized tasks, explain what they will do.');
        if (skillsContext) {
            lines.push('', skillsContext);
        }
        if (options.systemPromptExtra) {
            lines.push('', options.systemPromptExtra);
        }
        return lines.join('\n');
    }
}
//# sourceMappingURL=index.js.map