/**
 * Core agent loop using the Vercel AI SDK v6.
 *
 * Design mirrors the Anthropic agent loop:
 *   1. Receive prompt + messages
 *   2. Model evaluates → returns text and/or tool calls
 *   3. Execute tool calls (read-only tools run in parallel automatically)
 *   4. Feed results back to model
 *   5. Repeat until no more tool calls (one "step" = one round trip)
 *   6. Emit a done event with final text + token usage
 *
 * Uses streamText() with stopWhen: stepCountIs(n) for the multi-turn loop
 * and fullStream to stream text deltas, tool calls, and tool results.
 */
import { streamText, stepCountIs } from 'ai';
import type { ModelMessage } from 'ai';
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getProvider } from '../providers/index.js';
import { createTools } from './tools.js';
import { TodoTracker } from './todos.js';
import type { StreamEvent, AgentLoopOptions, TokenUsage, TodoItem } from '../types.js';

// ---------------------------------------------------------------------------
// Cost estimation (per 1M tokens, input / output)
// ---------------------------------------------------------------------------
const PRICING: Record<string, [number, number]> = {
  'claude-opus-4-6':   [15,    75],
  'claude-sonnet-4-6': [3,     15],
  'claude-haiku-4-5':  [0.25,  1.25],
  'gpt-4o':            [2.5,   10],
  'gpt-4o-mini':       [0.15,  0.6],
  'o1':                [15,    60],
  'o3-mini':           [1.1,   4.4],
  'gemini-2.0-flash':  [0.075, 0.3],
  'gemini-2.0-pro':    [1.25,  5],
  'gemini-1.5-flash':  [0.075, 0.3],
  'grok-4-1-fast-reasoning': [0.2, 0.5],
  'grok-4-1-fast-non-reasoning': [0.2, 0.5],
};

function estimateCost(model: string, input: number, output: number): number {
  const [inRate, outRate] = PRICING[model] ?? [3, 15];
  return (input * inRate + output * outRate) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export async function* runAgentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<StreamEvent> {
  // Resolve sessionId upfront — needed for the debug file name
  const sessionId =
    options.sessionId ??
    `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // ---------------------------------------------------------------------------
  // Debug writer — appends JSONL entries to .coder/convos/<sessionId>.jsonl
  // ---------------------------------------------------------------------------
  let debugLog: ((entry: Record<string, unknown>) => Promise<void>) | null = null;

  if (options.debugPrompt) {
    const convoDir = join(options.workdir, '.coder', 'convos');
    await mkdir(convoDir, { recursive: true });
    const debugPath = join(convoDir, `${sessionId}.jsonl`);

    debugLog = async (entry: Record<string, unknown>) => {
      const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
      await appendFile(debugPath, line, 'utf-8');
    };
  }

  const todoTracker = new TodoTracker();
  const tokenUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };

  // Buffer todo change events to interleave with stream output
  const pendingTodoEvents: TodoItem[][] = [];
  todoTracker.on('change', (todos: TodoItem[]) => {
    pendingTodoEvents.push([...todos]);
  });

  const tools = createTools(options.workdir, todoTracker, options.provider, options.customAgents, options.memoryManager, options.notepadManager);

  // Build the conversation history
  const messages: ModelMessage[] = [
    ...(options.previousMessages as ModelMessage[] ?? []),
    { role: 'user', content: options.prompt },
  ];

  // Log the outgoing request
  await debugLog?.({
    type: 'request',
    sessionId,
    provider: options.provider,
    model: options.model,
    systemPrompt: options.systemPrompt ?? null,
    messages: messages.filter((m)=> m.role==="user"||m.role==="assistant"||m.role==="system").map((m) => ({ role: m.role, content: m.content  })),
  });

  function* flushTodos(): Generator<StreamEvent> {
    while (pendingTodoEvents.length > 0) {
      yield { type: 'todo_update', data: pendingTodoEvents.shift()! };
    }
  }

  try {
    let budgetExceeded = false;

    const result = streamText({
      model: getProvider(options.provider, options.model),
      system: options.systemPrompt,
      messages,
      tools,
      // Stop after maxTurns tool-use steps (default 50)
      stopWhen: stepCountIs(options.maxTurns ?? 50),
      // Accumulate usage across all steps
      onStepFinish: ({ usage }) => {
        if (usage) {
          tokenUsage.inputTokens += usage.inputTokens ?? 0;
          tokenUsage.outputTokens += usage.outputTokens ?? 0;
          tokenUsage.totalTokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        }
        tokenUsage.costUsd = estimateCost(options.model, tokenUsage.inputTokens, tokenUsage.outputTokens);
        const budget = options.budget ?? 5.0;
        if (tokenUsage.costUsd > budget) {
          budgetExceeded = true;
        }
      },
    });

    for await (const part of result.fullStream) {
      yield* flushTodos();

      if (budgetExceeded) {
        yield {
          type: 'error',
          data: { message: `Budget limit of $${(options.budget ?? 5.0).toFixed(2)} exceeded (spent $${tokenUsage.costUsd.toFixed(4)})`, code: 'BUDGET_EXCEEDED' },
        };
        break;
      }

      switch (part.type) {
        case 'text-delta': {
          const text = (part as { type: 'text-delta'; text: string }).text;
          yield { type: 'text', data: text };
          break;
        }

        case 'tool-call': {
          const toolPart = part as { type: 'tool-call'; toolName: string; input?: unknown };
          await debugLog?.({ type: 'tool_call', toolName: toolPart.toolName, input: toolPart.input });
          yield {
            type: 'tool_call',
            data: { name: toolPart.toolName, input: toolPart.input },
          };
          if (toolPart.toolName === 'spawn_subagent') {
            const inp = toolPart.input as { name?: string } | undefined;
            yield {
              type: 'subagent',
              data: { name: inp?.name ?? 'subagent', status: 'started' },
            };
          }
          break;
        }

        case 'tool-result': {
          const resultPart = part as { type: 'tool-result'; toolName: string; output?: unknown };
          const outputStr = String(resultPart.output ?? '');
          await debugLog?.({ type: 'tool_result', toolName: resultPart.toolName, output: outputStr });
          if (options.verbose) {
            yield {
              type: 'tool_result',
              data: {
                toolName: resultPart.toolName,
                output: outputStr.slice(0, 500),
              },
            };
          }
          if (resultPart.toolName === 'spawn_subagent') {
            yield {
              type: 'subagent',
              data: { name: resultPart.toolName, status: 'completed' },
            };
          }
          break;
        }

        case 'error': {
          const errMsg = String((part as { error: unknown }).error);
          await debugLog?.({ type: 'error', message: errMsg });
          yield {
            type: 'error',
            data: { message: errMsg, code: 'STREAM_ERROR' },
          };
          break;
        }

        default:
          // step-start, step-finish, finish, reasoning — no consumer action needed
          break;
      }
    }

    // Final todo flush
    yield* flushTodos();
    const finalTodos = todoTracker.getAll();
    if (finalTodos.length > 0) {
      yield { type: 'todo_update', data: finalTodos };
    }

    tokenUsage.costUsd = estimateCost(
      options.model,
      tokenUsage.inputTokens,
      tokenUsage.outputTokens,
    );
    yield { type: 'token_usage', data: { ...tokenUsage } };

    // Collect response messages for session resume
    const response = await Promise.resolve(result.response).catch(() => ({ messages: [] as ModelMessage[] }));
    const allMessages: ModelMessage[] = [
      ...messages,
      ...(response.messages as ModelMessage[]),
    ];

    const finalText = await result.text;

    // Log the complete response before emitting done
    await debugLog?.({
      type: 'response',
      text: finalText,
      tokenUsage: { ...tokenUsage },
      messages: allMessages.filter((m)=> m.role==="user"||m.role==="assistant").map((m) => ({ role: m.role, content: m.role==="user"?m.content:m.content[0] })),
    });

    yield {
      type: 'done',
      data: {
        result: finalText,
        sessionId,
        tokenUsage: { ...tokenUsage },
        messages: allMessages,
      },
    };
  } catch (err) {
    const errMsg = (err as Error).message ?? 'Unknown error';
    await debugLog?.({ type: 'error', message: errMsg, code: 'AGENT_ERROR' });
    yield {
      type: 'error',
      data: { message: errMsg, code: 'AGENT_ERROR' },
    };
  }
}
