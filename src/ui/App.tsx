import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Box, Text, Static, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { join } from 'path';
import type { AgentOptions, StreamEvent, TokenUsage, TodoItem } from '../types.js';
import { AgentOrchestrator } from '../agent/index.js';
import { AgentLoader } from '../agent/agentLoader.js';
import { BUILTIN_AGENTS } from '../agent/tools.js';

const APP_NAME = "Tyler's AI Company's Coder";

// ---------------------------------------------------------------------------
// Slash command registry
// ---------------------------------------------------------------------------

interface SlashCommand { value: string; label: string; }

const SLASH_COMMANDS: SlashCommand[] = [
  { value: '/new',    label: 'Start a fresh conversation' },
  { value: '/agents', label: 'List available subagents'   },
  { value: '/todos',  label: 'Show current todos'         },
  { value: '/usage',  label: 'Show token usage'           },
  { value: '/help',   label: 'Show help'                  },
  { value: '/quit',   label: 'Exit'                       },
];

// ---------------------------------------------------------------------------
// Message type
// ---------------------------------------------------------------------------

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls: string[];
  /** 'header' = the branded banner rendered once at startup */
  kind?: 'header';
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
    if (this.waiters.length > 0) { this.waiters.shift()!(item); }
    else { this.items.push(item); }
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

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Rendered once as the very first Static item. Content encodes "provider|model". */
const HeaderBanner: React.FC<{ content: string }> = ({ content }) => {
  const [provider, model] = content.split('|');
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">✦  </Text>
        <Text bold>{APP_NAME}</Text>
        <Text>{'  '}</Text>
        <Text dimColor>{provider} / </Text>
        <Text color="cyan">{model}</Text>
      </Box>
    </Box>
  );
};

const UserMsg: React.FC<{ msg: Message }> = ({ msg }) => (
  <Box flexDirection="column" marginTop={1}>
    <Box paddingLeft={1}>
      <Text color="cyan" bold>│ </Text>
      <Text bold color="white">You</Text>
    </Box>
    <Box paddingLeft={3}>
      <Text>{msg.content}</Text>
    </Box>
  </Box>
);

const AssistantMsg: React.FC<{ msg: Message }> = ({ msg }) => (
  <Box flexDirection="column" marginTop={1} paddingLeft={1}>
    <Box>
      <Text color="magenta">◆ </Text>
      <Text bold>Assistant</Text>
      {msg.toolCalls.length > 0 && (
        <Text color="yellow" dimColor>
          {'  '}{msg.toolCalls.map((t) => `→ ${t}`).join('  ')}
        </Text>
      )}
    </Box>
    {msg.content && (
      <Box paddingLeft={2}>
        <Text>{msg.content}</Text>
      </Box>
    )}
  </Box>
);

const SystemMsg: React.FC<{ msg: Message }> = ({ msg }) => (
  <Box marginTop={1} paddingLeft={2}>
    <Text dimColor>{msg.content}</Text>
  </Box>
);

const CompletedMessage: React.FC<{ msg: Message }> = ({ msg }) => {
  if (msg.kind === 'header') return <HeaderBanner content={msg.content} />;
  if (msg.role === 'user')      return <UserMsg msg={msg} />;
  if (msg.role === 'assistant') return <AssistantMsg msg={msg} />;
  return <SystemMsg msg={msg} />;
};

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export const App: React.FC<{ options: AgentOptions }> = ({ options }) => {
  const { exit } = useApp();

  useEffect(() => {
    // Set terminal tab/window title
    process.stdout.write(`\x1b]0;${APP_NAME}\x07`);
  }, []);

  // Header is injected as the first Static message so it sticks to the top
  const [completedMessages, setCompletedMessages] = useState<Message[]>([{
    id: '__header__',
    role: 'system',
    // Encode provider + model so HeaderBanner can render them without extra props
    content: `${options.provider}|${options.model}`,
    toolCalls: [],
    kind: 'header',
  }]);

  // Live streaming area
  const [streamingContent, setStreamingContent]   = useState('');
  const [streamingTools,   setStreamingTools]     = useState<string[]>([]);
  const [isThinking,       setIsThinking]         = useState(false);
  const [currentTool,      setCurrentTool]        = useState<string | null>(null);

  // Input
  const [inputValue, setInputValue] = useState('');
  const [queueSize,  setQueueSize]  = useState(0);

  // Slash command picker
  const [pickerFilter, setPickerFilter] = useState('');
  const [pickerIndex,  setPickerIndex]  = useState(0);
  /**
   * Raised by useInput's Enter handler so that TextInput's own onSubmit
   * (which fires in the same tick) knows to skip re-processing the command.
   */
  const pickerSubmitRef = useRef(false);

  const filteredCommands = useMemo(() => {
    if (!pickerFilter.startsWith('/')) return [];
    return SLASH_COMMANDS.filter((c) => c.value.startsWith(pickerFilter.toLowerCase()));
  }, [pickerFilter]);

  const showPicker = filteredCommands.length > 0;

  // Token counters
  const [totalTokens, setTotalTokens] = useState(0);
  const [totalCost,   setTotalCost]   = useState(0);

  // Todos (for /todos command)
  const [todos, setTodos] = useState<TodoItem[]>([]);

  // Stable refs — safe to read inside async callbacks
  const orchestratorRef = useRef(new AgentOrchestrator(options.workdir));
  const sessionIdRef    = useRef<string | null>(null);
  const queue           = useRef(new AsyncQueue<string>());
  const usageRef        = useRef({ tokens: 0, cost: 0 });

  useEffect(() => {
    usageRef.current = { tokens: totalTokens, cost: totalCost };
  }, [totalTokens, totalCost]);

  // ---------------------------------------------------------------------------
  // Agent run loop
  // ---------------------------------------------------------------------------

  const runTurn = useCallback(async (userInput: string) => {
    setIsThinking(true);
    setCurrentTool(null);
    setStreamingContent('');
    setStreamingTools([]);

    setCompletedMessages((prev) => [...prev, {
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
            setTotalTokens((n) => n + u.totalTokens);
            setTotalCost((c) => c + u.costUsd);
            break;
          }

          case 'done': {
            const done = event.data as { sessionId: string };
            sessionIdRef.current = done.sessionId;
            break;
          }

          case 'error': {
            const err = event.data as { message: string };
            text = `Error: ${err.message}`;
            setStreamingContent(text);
            break;
          }
        }
      }
    } catch (err) {
      text = `Error: ${(err as Error).message}`;
      setStreamingContent(text);
    }

    setStreamingContent('');
    setStreamingTools([]);
    setCurrentTool(null);
    setIsThinking(false);

    setCompletedMessages((prev) => [...prev, {
      id: genId(), role: 'assistant',
      content: text || '(no response)',
      toolCalls: tools,
    }]);
  }, [options]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Command execution
  // ---------------------------------------------------------------------------
  //
  // IMPORTANT: runCommand is called directly by both handleSubmit (typed Enter)
  // and by the picker's useInput handler (arrow-selected Enter).
  // handleSubmit has a ref-guard to skip re-processing when the picker fires.
  // runCommand must never check that ref — it always executes.

  const runCommand = useCallback((trimmed: string) => {
    if (!trimmed) return;

    if (trimmed === '/quit' || trimmed === '/exit') {
      exit();
      return;
    }

    if (trimmed === '/new') {
      sessionIdRef.current = null;
      setTodos([]);
      setTotalTokens(0);
      setTotalCost(0);
      setCompletedMessages((prev) => [...prev, {
        id: genId(), role: 'system',
        content: '─────────────────── new conversation ───────────────────',
        toolCalls: [],
      }]);
      return;
    }

    if (trimmed === '/usage') {
      const { tokens, cost } = usageRef.current;
      setCompletedMessages((prev) => [...prev, {
        id: genId(), role: 'system',
        content: `${tokens.toLocaleString()} tokens · $${cost.toFixed(4)}`,
        toolCalls: [],
      }]);
      return;
    }

    if (trimmed === '/todos') {
      const lines = todos.length === 0
        ? '(no todos)'
        : todos.map((t) => {
          const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◉' : '○';
          return `${icon} ${t.title}`;
        }).join('\n');
      setCompletedMessages((prev) => [...prev, {
        id: genId(), role: 'system', content: lines, toolCalls: [],
      }]);
      return;
    }

    if (trimmed === '/agents') {
      const loader = new AgentLoader(join(options.workdir, 'agents'));
      loader.loadAll().then((custom) => {
        const lines: string[] = ['Built-in agents:'];
        for (const a of BUILTIN_AGENTS) {
          lines.push(`  ${a.name.padEnd(20)} ${a.description}`);
        }
        if (custom.length > 0) {
          lines.push('\nCustom agents:');
          for (const a of custom) {
            lines.push(`  ${a.name.padEnd(20)} ${a.description}`);
          }
        } else {
          lines.push("\nCustom agents: (none — run 'coder agents create' to add one)");
        }
        setCompletedMessages((prev) => [...prev, {
          id: genId(), role: 'system', content: lines.join('\n'), toolCalls: [],
        }]);
      });
      return;
    }

    if (trimmed === '/help') {
      setCompletedMessages((prev) => [...prev, {
        id: genId(), role: 'system',
        content: [
          '/new     — start a fresh conversation',
          '/agents  — list available subagents',
          '/todos   — show current todos',
          '/usage   — show token usage',
          '/quit    — exit',
          '',
          'Tip: type / to browse commands with ↑↓ arrow keys, Enter to select.',
          'Messages sent while the agent is thinking are queued automatically.',
        ].join('\n'),
        toolCalls: [],
      }]);
      return;
    }

    // Default: send to agent
    queue.current.push(trimmed);
    setQueueSize(queue.current.size);
  }, [exit, todos, options.workdir]);

  // TextInput's onSubmit — checks the picker-guard ref then delegates to runCommand
  const handleSubmit = useCallback((value: string) => {
    if (pickerSubmitRef.current) {
      // The picker's useInput handler already called runCommand for this Enter
      pickerSubmitRef.current = false;
      return;
    }
    setInputValue('');
    setPickerFilter('');
    setPickerIndex(0);
    runCommand(value.trim());
  }, [runCommand]);

  // Keyboard handler — placed after handleSubmit/runCommand to avoid TS "used before declaration"
  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') { exit(); return; }

    if (showPicker) {
      if (key.downArrow) {
        setPickerIndex((i) => (i + 1) % filteredCommands.length);
      } else if (key.upArrow) {
        setPickerIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
      } else if (key.escape) {
        setPickerFilter('');
        setInputValue('');
        setPickerIndex(0);
      } else if (key.return) {
        const cmd = filteredCommands[pickerIndex];
        if (cmd) {
          // Raise the guard so TextInput's onSubmit (firing in the same tick) skips processing
          pickerSubmitRef.current = true;
          setInputValue('');
          setPickerFilter('');
          setPickerIndex(0);
          // Call runCommand directly — NOT handleSubmit, which would see the guard and bail
          runCommand(cmd.value);
        }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const toolLine = currentTool
    ? `  ⟳ ${currentTool}…`
    : streamingTools.length > 0
    ? `  ✓ ${streamingTools[streamingTools.length - 1]}`
    : '';

  const inputBorderColor = isThinking ? 'yellow' : 'cyan';
  const promptColor      = isThinking ? 'yellow' : 'cyan';

  const usageStr = totalTokens > 0
    ? `${totalTokens.toLocaleString()} tokens · $${totalCost.toFixed(4)}${sessionIdRef.current ? '  · session active' : ''}`
    : '';

  return (
    <Box flexDirection="column">

      {/* ── Completed messages — rendered once, accumulate above the live area ── */}
      <Static items={completedMessages}>
        {(msg) => <CompletedMessage key={msg.id} msg={msg} />}
      </Static>

      {/* ── Live: streaming assistant response ── */}
      {isThinking && (
        <Box flexDirection="column" marginTop={1} paddingLeft={1}>
          <Box>
            <Text color="magenta">◆ </Text>
            <Text bold>Assistant</Text>
            {streamingTools.length > 0 ? (
              <Text color="yellow" dimColor>{toolLine}</Text>
            ) : (
              <Text dimColor>  thinking…</Text>
            )}
          </Box>
          {streamingContent !== '' && (
            <Box paddingLeft={2}>
              <Text>{streamingContent}</Text>
            </Box>
          )}
        </Box>
      )}

      {/* ── Slash command picker ── */}
      {showPicker && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          marginX={1}
          marginTop={1}
        >
          {filteredCommands.map((cmd, i) => (
            <Box key={cmd.value} paddingX={1}>
              <Text color={i === pickerIndex ? 'cyan' : undefined} bold={i === pickerIndex}>
                {i === pickerIndex ? '▶ ' : '  '}
              </Text>
              <Text bold={i === pickerIndex} color={i === pickerIndex ? 'cyan' : undefined}>
                {cmd.value.padEnd(10)}
              </Text>
              <Text dimColor>  {cmd.label}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* ── Input box ── */}
      <Box
        borderStyle="round"
        borderColor={inputBorderColor}
        marginX={1}
        marginTop={1}
        paddingX={1}
      >
        <Text color={promptColor} bold>{'> '}</Text>
        <TextInput
          value={inputValue}
          onChange={(val) => {
            setInputValue(val);
            setPickerFilter(val.startsWith('/') ? val : '');
            setPickerIndex(0);
          }}
          onSubmit={handleSubmit}
          placeholder={
            isThinking
              ? `agent thinking${queueSize > 0 ? ` · ${queueSize} queued` : ''}…`
              : 'message the agent… (type / for commands)'
          }
        />
        {queueSize > 0 && !isThinking && (
          <Text color="yellow">  +{queueSize} queued</Text>
        )}
      </Box>

      {/* ── Status line ── */}
      {usageStr !== '' && (
        <Box paddingLeft={3}>
          <Text dimColor>{usageStr}</Text>
        </Box>
      )}

    </Box>
  );
};
