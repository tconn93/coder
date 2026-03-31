import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Box, Text, Static, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { AgentOptions, StreamEvent, TokenUsage, TodoItem } from '../types.js';
import { AgentOrchestrator } from '../agent/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls: string[];
}

// ---------------------------------------------------------------------------
// AsyncQueue — drives the sequential agent run loop
// ---------------------------------------------------------------------------

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(item: T | null) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiters.length > 0) {
      this.waiters.shift()!(item);
    } else {
      this.items.push(item);
    }
  }

  async pop(): Promise<T | null> {
    if (this.items.length > 0) return this.items.shift()!;
    if (this.closed) return null;
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }

  close(): void {
    this.closed = true;
    for (const w of [...this.waiters]) w(null);
    this.waiters = [];
  }

  get size(): number { return this.items.length; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const UserMsg: React.FC<{ msg: Message }> = ({ msg }) => (
  <Box flexDirection="column" marginTop={1} paddingLeft={2}>
    <Text bold color="cyan">You</Text>
    <Text>{msg.content}</Text>
  </Box>
);

const AssistantMsg: React.FC<{ msg: Message }> = ({ msg }) => (
  <Box flexDirection="column" marginTop={1} paddingLeft={2}>
    <Text bold color="green">Assistant</Text>
    {msg.toolCalls.length > 0 && (
      <Text dimColor>{'  '}{msg.toolCalls.map(t => `→ ${t}`).join('  ')}</Text>
    )}
    <Text>{msg.content}</Text>
  </Box>
);

const SystemMsg: React.FC<{ msg: Message }> = ({ msg }) => (
  <Box marginTop={1} paddingLeft={2}>
    <Text dimColor>{msg.content}</Text>
  </Box>
);

const CompletedMessage: React.FC<{ msg: Message }> = ({ msg }) => {
  if (msg.role === 'user') return <UserMsg msg={msg} />;
  if (msg.role === 'assistant') return <AssistantMsg msg={msg} />;
  return <SystemMsg msg={msg} />;
};

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export const App: React.FC<{ options: AgentOptions }> = ({ options }) => {
  const { exit } = useApp();

  // Completed messages — rendered via <Static>, persist above the live area
  const [completedMessages, setCompletedMessages] = useState<Message[]>([]);

  // Live streaming area
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingTools, setStreamingTools] = useState<string[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [currentTool, setCurrentTool] = useState<string | null>(null);

  // Input
  const [inputValue, setInputValue] = useState('');
  const [queueSize, setQueueSize] = useState(0);

  // Usage
  const [totalTokens, setTotalTokens] = useState(0);
  const [totalCost, setTotalCost] = useState(0);

  // Todos (for /todos command)
  const [todos, setTodos] = useState<TodoItem[]>([]);

  // Stable refs used inside async callbacks
  const orchestratorRef = useRef(new AgentOrchestrator(options.workdir));
  const sessionIdRef = useRef<string | null>(null);
  const queue = useRef(new AsyncQueue<string>());
  // Keep a snapshot of totals for /usage (avoids stale closure in handleSubmit)
  const usageRef = useRef({ tokens: 0, cost: 0 });

  // Sync ref whenever state updates
  useEffect(() => { usageRef.current = { tokens: totalTokens, cost: totalCost }; },
    [totalTokens, totalCost]);

  // Ctrl+C → exit
  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') exit();
  });

  // ---------------------------------------------------------------------------
  // Agent run loop — runs one message at a time, sequentially
  // ---------------------------------------------------------------------------
  const runTurn = useCallback(async (userInput: string) => {
    setIsThinking(true);
    setCurrentTool(null);
    setStreamingContent('');
    setStreamingTools([]);

    // Show the user's message in the static area immediately
    setCompletedMessages(prev => [...prev, {
      id: genId(), role: 'user', content: userInput, toolCalls: [],
    }]);

    let text = '';
    const tools: string[] = [];

    const events = (
      sessionIdRef.current
        ? orchestratorRef.current.resume(sessionIdRef.current, userInput, options)
        : orchestratorRef.current.run(userInput, options)
    ) as AsyncGenerator<StreamEvent>;

    try {
      for await (const event of events) {
        switch (event.type) {
          case 'text':
            text += event.data as string;
            setStreamingContent(text);
            break;

          case 'tool_call': {
            const name = (event.data as { name: string }).name;
            tools.push(name);
            setCurrentTool(name);
            setStreamingTools([...tools]);
            break;
          }

          case 'todo_update':
            setTodos(event.data as TodoItem[]);
            break;

          case 'token_usage': {
            const u = event.data as TokenUsage;
            setTotalTokens(n => n + u.totalTokens);
            setTotalCost(c => c + u.costUsd);
            break;
          }

          case 'done': {
            const done = event.data as { sessionId: string };
            sessionIdRef.current = done.sessionId;
            break;
          }

          case 'error': {
            const err = event.data as { message: string };
            text = `[Error] ${err.message}`;
            setStreamingContent(text);
            break;
          }
        }
      }
    } catch (err) {
      text = `[Error] ${(err as Error).message}`;
      setStreamingContent(text);
    }

    // Finalize: move streamed content into the static completed area
    setStreamingContent('');
    setStreamingTools([]);
    setCurrentTool(null);
    setIsThinking(false);

    setCompletedMessages(prev => [...prev, {
      id: genId(),
      role: 'assistant',
      content: text || '(no response)',
      toolCalls: tools,
    }]);
  }, [options]);

  // Start the sequential run loop once on mount
  useEffect(() => {
    const loop = async () => {
      for (;;) {
        const msg = await queue.current.pop();
        if (msg === null) break;
        setQueueSize(queue.current.size);
        await runTurn(msg);
        setQueueSize(queue.current.size);
      }
    };
    loop().catch(() => {});
    return () => { queue.current.close(); };
  // runTurn is stable (useCallback with stable options ref)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Input handler
  // ---------------------------------------------------------------------------
  const handleSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    setInputValue('');
    if (!trimmed) return;

    // Slash commands — handled immediately, never queued
    if (trimmed === '/quit' || trimmed === '/exit') {
      exit();
      return;
    }
    if (trimmed === '/new') {
      sessionIdRef.current = null;
      setTodos([]);
      setTotalTokens(0);
      setTotalCost(0);
      setCompletedMessages(prev => [...prev, {
        id: genId(), role: 'system',
        content: '─────────── new conversation ───────────',
        toolCalls: [],
      }]);
      return;
    }
    if (trimmed === '/usage') {
      const { tokens, cost } = usageRef.current;
      setCompletedMessages(prev => [...prev, {
        id: genId(), role: 'system',
        content: `${tokens.toLocaleString()} tokens · $${cost.toFixed(4)}`,
        toolCalls: [],
      }]);
      return;
    }
    if (trimmed === '/todos') {
      const lines = todos.length === 0
        ? '(no todos)'
        : todos.map(t => {
          const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◉' : '○';
          return `${icon} ${t.title}`;
        }).join('\n');
      setCompletedMessages(prev => [...prev, {
        id: genId(), role: 'system', content: lines, toolCalls: [],
      }]);
      return;
    }
    if (trimmed === '/help') {
      setCompletedMessages(prev => [...prev, {
        id: genId(), role: 'system',
        content: [
          '/new    — start a fresh conversation',
          '/todos  — show current todos',
          '/usage  — show token usage',
          '/quit   — exit',
          '',
          'Messages sent while the agent is thinking are queued automatically.',
        ].join('\n'),
        toolCalls: [],
      }]);
      return;
    }

    // Enqueue for the agent run loop
    queue.current.push(trimmed);
    setQueueSize(queue.current.size);
  }, [exit, todos]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const dot = isThinking ? '●' : '○';
  const dotColor = isThinking ? 'yellow' : 'green';

  return (
    <Box flexDirection="column">
      {/* ── Completed messages (rendered once, persist above) ── */}
      <Static items={completedMessages}>
        {(msg) => <CompletedMessage key={msg.id} msg={msg} />}
      </Static>

      {/* ── Live streaming assistant response ── */}
      {isThinking && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          <Box>
            <Text bold color="green">Assistant </Text>
            {streamingTools.length > 0 && (
              <Text color="yellow" dimColor>
                {streamingTools.map(t => `→ ${t}`).join('  ')}
                {currentTool ? ' ⟳' : ' ✓'}
              </Text>
            )}
            {streamingTools.length === 0 && (
              <Text color="cyan" dimColor>thinking…</Text>
            )}
          </Box>
          {streamingContent !== '' && <Text>{streamingContent}</Text>}
        </Box>
      )}

      {/* ── Input bar ── */}
      <Box marginTop={1} paddingLeft={1}>
        <Text color={dotColor}>{dot} </Text>
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          placeholder={
            isThinking
              ? `(agent thinking${queueSize > 0 ? `, ${queueSize} queued` : ''} — press Enter to queue)`
              : 'Message the agent…'
          }
        />
        {queueSize > 0 && !isThinking && (
          <Text color="yellow"> +{queueSize} queued</Text>
        )}
      </Box>

      {/* ── Subtle usage line ── */}
      {totalTokens > 0 && (
        <Text dimColor>
          {'  '}{totalTokens.toLocaleString()} tokens · ${totalCost.toFixed(4)}
          {sessionIdRef.current ? `  · session active` : ''}
        </Text>
      )}
    </Box>
  );
};
