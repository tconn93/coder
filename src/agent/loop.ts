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
  'grok-2':            [2,     10],
  'grok-2-mini':       [0.2,   1],
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

  const tools = createTools(options.workdir, todoTracker, options.provider);

  // Build the conversation history
  const messages: ModelMessage[] = [
    ...(options.previousMessages as ModelMessage[] ?? []),
    { role: 'user', content: options.prompt },
  ];

  function* flushTodos(): Generator<StreamEvent> {
    while (pendingTodoEvents.length > 0) {
      yield { type: 'todo_update', data: pendingTodoEvents.shift()! };
    }
  }

  try {
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
      },
    });

    for await (const part of result.fullStream) {
      yield* flushTodos();

      switch (part.type) {
        case 'text-delta':
          yield { type: 'text', data: (part as { type: 'text-delta'; text: string }).text };
          break;

        case 'tool-call': {
          // In v6 tool-call parts can be static (with input) or dynamic
          const toolPart = part as { type: 'tool-call'; toolName: string; input?: unknown };
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
          if (options.verbose) {
            yield {
              type: 'tool_result',
              data: {
                toolName: resultPart.toolName,
                output: String(resultPart.output ?? '').slice(0, 500),
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

        case 'error':
          yield {
            type: 'error',
            data: { message: String((part as { error: unknown }).error), code: 'STREAM_ERROR' },
          };
          break;

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
    // result.response is PromiseLike — wrap in Promise to get .catch()
    const response = await Promise.resolve(result.response).catch(() => ({ messages: [] as ModelMessage[] }));
    const allMessages: ModelMessage[] = [
      ...messages,
      ...(response.messages as ModelMessage[]),
    ];

    const finalText = await result.text;
    const sessionId =
      options.sessionId ??
      `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

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
    yield {
      type: 'error',
      data: {
        message: (err as Error).message ?? 'Unknown error',
        code: 'AGENT_ERROR',
      },
    };
  }
}
