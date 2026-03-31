export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
export interface AgentOptions {
    provider: string;
    model: string;
    maxTurns: number;
    budget: number;
    permissionMode: PermissionMode;
    workdir: string;
    verbose?: boolean;
    systemPromptExtra?: string;
}
export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export interface TodoItem {
    id: string;
    title: string;
    status: TodoStatus;
    createdAt: Date;
    completedAt?: Date;
}
export interface TodoState {
    items: Map<string, TodoItem>;
}
export type StreamEventType = 'text' | 'tool_call' | 'tool_result' | 'todo_update' | 'token_usage' | 'subagent' | 'done' | 'error';
export interface StreamEvent {
    type: StreamEventType;
    data: unknown;
}
export interface TextEvent extends StreamEvent {
    type: 'text';
    data: string;
}
export interface ToolCallEvent extends StreamEvent {
    type: 'tool_call';
    data: {
        name: string;
        input: unknown;
    };
}
export interface ToolResultEvent extends StreamEvent {
    type: 'tool_result';
    data: {
        toolName: string;
        output: string;
    };
}
export interface TodoUpdateEvent extends StreamEvent {
    type: 'todo_update';
    data: TodoItem[];
}
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
}
export interface TokenUsageEvent extends StreamEvent {
    type: 'token_usage';
    data: TokenUsage;
}
export interface SubagentEvent extends StreamEvent {
    type: 'subagent';
    data: {
        name: string;
        status: 'started' | 'completed' | 'failed';
    };
}
export interface DoneEvent extends StreamEvent {
    type: 'done';
    data: {
        result: string;
        sessionId: string;
        tokenUsage: TokenUsage;
        /** Full conversation history; pass as previousMessages to resume */
        messages?: unknown[];
    };
}
export interface ErrorEvent extends StreamEvent {
    type: 'error';
    data: {
        message: string;
        code?: string;
    };
}
export interface AgentSession {
    sessionId: string;
    prompt: string;
    options: AgentOptions;
    startedAt: Date;
    tokenUsage: TokenUsage;
    todos: TodoItem[];
}
export interface SkillFrontmatter {
    name: string;
    description: string;
    when_to_use: string;
}
export interface Skill {
    frontmatter: SkillFrontmatter;
    content: string;
    filename: string;
}
export interface AgentLoopOptions {
    prompt: string;
    systemPrompt?: string;
    provider: string;
    model: string;
    maxTurns?: number;
    permissionMode?: PermissionMode;
    workdir: string;
    verbose?: boolean;
    /** Previous conversation messages for session resume */
    previousMessages?: unknown[];
    /** Session ID to reuse (generated if omitted) */
    sessionId?: string;
}
//# sourceMappingURL=types.d.ts.map