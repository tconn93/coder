// Shared TypeScript types for the AI Coding Agent

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

export type StreamEventType =
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'todo_update'
  | 'token_usage'
  | 'subagent'
  | 'status'
  | 'done'
  | 'error';

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
  keywords?: string;
}

export interface Skill {
  frontmatter: SkillFrontmatter;
  content: string;
  filename: string;
}

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  file: string;
}

export interface CustomAgentDef {
  name: string;
  description: string;
  model: string;
  tools: string[];
  systemPrompt: string;
}

// ---------------------------------------------------------------------------
// Hook / Event Bus types (modeled on Claude Code's hook system)
// ---------------------------------------------------------------------------

/** Event names that fire throughout the agent lifecycle. */
export type HookEventName =
  | 'session.start'
  | 'session.end'
  | 'session.error'
  | 'tool.before'
  | 'tool.after'
  | 'tool.error'
  | 'agent.prompt'
  | 'agent.response'
  | 'agent.turn'
  | 'notification.send';

/** Context payload passed to hook commands via stdin (JSON). */
export interface HookContext {
  event: HookEventName;
  sessionId: string;
  workdir: string;
  timestamp: string;
  /** Tool name (for tool.* events) */
  toolName?: string;
  /** Tool input arguments (for tool.before) */
  toolInput?: Record<string, unknown>;
  /** Tool output or error (for tool.after / tool.error) */
  toolOutput?: string;
  /** The user prompt (for agent.prompt) */
  prompt?: string;
  /** The agent response text (for agent.response) */
  response?: string;
  /** Current turn number (for agent.turn) */
  turn?: number;
  /** Notification message (for notification.send) */
  message?: string;
  /** Error details (for session.error / tool.error) */
  error?: string;
}

/** A single hook definition as configured in .coder/settings.json. */
export interface HookConfig {
  /** Regex or glob pattern matching tool names / event subtypes */
  matcher?: string;
  /** Shell command to execute when the hook fires */
  command: string;
  /** Max execution time in ms (default: 30000) */
  timeout?: number;
  /** Whether the agent should wait for this hook to complete (default: false) */
  blocking?: boolean;
}

/** Top-level hooks configuration in .coder/settings.json. */
export interface HooksConfig {
  'session.start'?: HookConfig[];
  'session.end'?: HookConfig[];
  'session.error'?: HookConfig[];
  'tool.before'?: HookConfig[];
  'tool.after'?: HookConfig[];
  'tool.error'?: HookConfig[];
  'agent.prompt'?: HookConfig[];
  'agent.response'?: HookConfig[];
  'agent.turn'?: HookConfig[];
  'notification.send'?: HookConfig[];
}

// ---------------------------------------------------------------------------

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
  /** Custom agents loaded from <workdir>/agents/ */
  customAgents?: CustomAgentDef[];
  /** When true, write full LLM conversation to <workdir>/.coder/convos/<sessionId>.jsonl */
  debugPrompt?: boolean;
  /** Cost ceiling in USD (default 5.0) */
  budget?: number;
  /** Memory manager instance for persistent memory tools */
  memoryManager?: import('./agent/memory.js').MemoryManager;
  /** Notepad manager instance for notepad tools */
  notepadManager?: import('./agent/notepad.js').NotepadManager;
  /** EventBus for hook emissions throughout the agent lifecycle */
  eventBus?: import('./agent/eventBus.js').EventBus;
}
