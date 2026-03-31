import type { AgentOptions, AgentSession, StreamEvent } from '../types.js';
export declare class AgentOrchestrator {
    private sessions;
    private sessionMessages;
    private skillsLoader;
    constructor(workdir?: string);
    /**
     * Main entry point. Returns an async generator of StreamEvents.
     */
    run(prompt: string, options: AgentOptions): AsyncGenerator<StreamEvent>;
    /**
     * Resume a previous session by replaying the conversation history.
     * The new prompt is appended as the next user turn.
     */
    resume(sessionId: string, newPrompt: string, options: AgentOptions): AsyncGenerator<StreamEvent>;
    getSession(sessionId: string): AgentSession | undefined;
    getAllSessions(): AgentSession[];
    private buildSystemPrompt;
}
//# sourceMappingURL=index.d.ts.map