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
import { appendFile, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { getProvider } from '../providers/index.js';
import { createTools } from './tools.js';
import { TodoTracker } from './todos.js';
import { routerMiddleware } from './router.js';
import type { StreamEvent, AgentLoopOptions, TokenUsage, TodoItem } from '../types.js';

// ---------------------------------------------------------------------------
// Cost estimation (per 1M tokens, input / output).
// Sourced from provider pricing pages; snapshot identifiers (e.g. claude-sonnet-4-6
// vs claude-sonnet-4-5) share the same tier pricing.
// Uses prefix matching so claude-opus-4-5 and claude-opus-4-6 both match.
// ---------------------------------------------------------------------------
const PRICING: Record<string, [number, number]> = {
  // Anthropic
  'claude-opus':    [15,    75],
  'claude-sonnet':  [3,     15],
  'claude-haiku':   [0.25,  1.25],
  // OpenAI o-series
  'o4-mini':        [1.1,   4.4],
  'o3':             [10,    40],
  'o3-mini':        [1.1,   4.4],
  'o1':             [15,    60],
  // OpenAI GPT-5.x
  'gpt-5.4-pro':    [15,    150],
  'gpt-5.4':        [2.5,   10],
  'gpt-5.4-mini':   [0.5,   2],
  'gpt-5.4-nano':   [0.1,   0.4],
  'gpt-5.2-pro':    [15,    150],
  'gpt-5.2':        [2.5,   10],
  'gpt-5.1':        [2.5,   10],
  'gpt-5':          [2.5,   10],
  'gpt-5-mini':     [0.5,   2],
  'gpt-5-nano':     [0.1,   0.4],
  // OpenAI GPT-4
  'gpt-4.1':        [2,     8],
  'gpt-4.1-mini':   [0.4,   1.6],
  'gpt-4.1-nano':   [0.1,   0.4],
  'gpt-4o':         [2.5,   10],
  'gpt-4o-mini':    [0.15,  0.6],
  'gpt-3.5-turbo':  [0.5,   1.5],
  // Google
  'gemini-2.5-pro':       [1.25,  5],
  'gemini-2.5-flash':     [0.075, 0.3],
  'gemini-2.5-flash-lite': [0.075, 0.3],
  'gemini-2.0-flash':     [0.075, 0.3],
  'gemini-2.0-flash-lite': [0.075, 0.3],
  'gemini-3':             [1.25,  5],
  'gemini-3.1':           [1.25,  5],
  'gemma-3-27b-it':       [0.075, 0.3],
  'gemma-3-12b-it':       [0.075, 0.3],
  'gemma-3-4b-it':        [0.075, 0.3],
  'gemini-pro':           [1.25,  5],
  'gemini-flash':         [0.075, 0.3],
  // xAI
  'grok-4-1-fast':    [0.2, 0.5],
  'grok-4-fast':       [0.2, 0.5],
  'grok-4.20':         [0.5, 1.5],
  'grok-code-fast-1':  [0.2, 0.5],
  'grok-3':            [0.5, 1.5],
  'grok-3-mini':       [0.3, 1],
  // DeepSeek (passed through to API — any model string works)
  'deepseek-v4-pro':   [0.55, 2.19],
  'deepseek-v4-flash': [0.27, 1.10],
  'deepseek-chat':     [0.27, 1.10],
  'deepseek-reasoner': [0.55, 2.19],
};

function estimateCost(model: string, input: number, output: number): number {
  // Exact match first
  if (PRICING[model]) {
    const [inRate, outRate] = PRICING[model];
    return (input * inRate + output * outRate) / 1_000_000;
  }
  // Prefix match (e.g., 'claude-opus-4-5' matches 'claude-opus')
  for (const [prefix, [inRate, outRate]] of Object.entries(PRICING)) {
    if (model.startsWith(prefix)) {
      return (input * inRate + output * outRate) / 1_000_000;
    }
  }
  // Fallback
  const [inRate, outRate] = PRICING['claude-sonnet']!;
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
    const debugPath = join(convoDir, `${sessionId}.json`);

    const logArray: Record<string, unknown>[] = [];

    debugLog = async (entry: Record<string, unknown>) => {
      logArray.push({ ...entry, ts: new Date().toISOString() });
      await writeFile(debugPath, JSON.stringify(logArray, null, 2), 'utf-8');
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

  const tools = createTools(options.workdir, todoTracker, options.provider, options.customAgents, options.memoryManager, options.notepadManager, undefined, options.permissionMode);

  // Build the raw conversation history (to save for full session transcript)
  const rawMessages: ModelMessage[] = [
    ...(options.previousMessages as ModelMessage[] ?? []),
    { role: 'user', content: options.prompt },
  ];

  // Pass history through the Intelligent Context Router to save tokens
  const previousMessagesArray = options.previousMessages as ModelMessage[] ?? [];
  const { triageContext, selectedMessageIndices, targetProvider, targetModel, triageData } = await routerMiddleware(
    options.prompt,
    previousMessagesArray,
    options.provider,
    options.model,
    options.memoryManager
  );

  // Filter previous messages to only triage-selected indices, then append the current prompt
  const filteredHistory: ModelMessage[] = selectedMessageIndices.length > 0
    ? selectedMessageIndices.map(i => previousMessagesArray[i]).filter(Boolean)
    : previousMessagesArray;
  const routedMessages: ModelMessage[] = [
    ...filteredHistory,
    { role: 'user', content: options.prompt },
  ];

  // Inject triage context into the system prompt (augments, does not replace)
  const augmentedSystemPrompt = triageContext
    ? `${options.systemPrompt ?? ''}\n\n${triageContext}`
    : options.systemPrompt;

  // Use the routed overriding provider/model, or fallback to user options
  const activeProvider = targetProvider || options.provider;
  const activeModel = targetModel || options.model;

  // EventBus ref (may be undefined if no hooks configured)
  const bus = options.eventBus;

  // Log the outgoing request
  await debugLog?.({
    type: 'request',
    sessionId,
    provider: activeProvider,
    model: activeModel,
    systemPrompt: options.systemPrompt ?? null,
    userRequest: options.prompt,
    triageData,
  });

  // Emit agent.prompt
  await bus?.emit('agent.prompt', {
    event: 'agent.prompt',
    sessionId,
    workdir: options.workdir,
    timestamp: new Date().toISOString(),
    prompt: options.prompt,
  });

  let turnCount = 0;

  function* flushTodos(): Generator<StreamEvent> {
    while (pendingTodoEvents.length > 0) {
      yield { type: 'todo_update', data: pendingTodoEvents.shift()! };
    }
  }

  try {
    let budgetExceeded = false;

    const result = streamText({
      model: getProvider(activeProvider, activeModel),
      system: augmentedSystemPrompt,
      messages: routedMessages,
      tools,
      // Stop after maxTurns tool-use steps (default 50)
      stopWhen: stepCountIs(options.maxTurns ?? 50),
      // Accumulate usage across all steps and emit turn events
      onStepFinish: ({ usage }) => {
        turnCount++;
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
        // Fire-and-forget turn event (non-blocking to avoid slowing the loop)
        bus?.emit('agent.turn', {
          event: 'agent.turn',
          sessionId,
          workdir: options.workdir,
          timestamp: new Date().toISOString(),
          turn: turnCount,
        });
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
          // Emit tool.before
          await bus?.emit('tool.before', {
            event: 'tool.before',
            sessionId,
            workdir: options.workdir,
            timestamp: new Date().toISOString(),
            toolName: toolPart.toolName,
            toolInput: toolPart.input as Record<string, unknown> | undefined,
          });
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
          // Emit tool.after or tool.error based on output
          if (outputStr.startsWith('Error:')) {
            await bus?.emit('tool.error', {
              event: 'tool.error',
              sessionId,
              workdir: options.workdir,
              timestamp: new Date().toISOString(),
              toolName: resultPart.toolName,
              error: outputStr,
            });
          } else {
            await bus?.emit('tool.after', {
              event: 'tool.after',
              sessionId,
              workdir: options.workdir,
              timestamp: new Date().toISOString(),
              toolName: resultPart.toolName,
              toolOutput: outputStr.slice(0, 2000),
            });
          }
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
          await bus?.emit('tool.error', {
            event: 'tool.error',
            sessionId,
            workdir: options.workdir,
            timestamp: new Date().toISOString(),
            error: errMsg,
          });
          yield {
            type: 'error',
            data: { message: errMsg, code: 'STREAM_ERROR' },
          };
          break;
        }

        default:
          // step-start, finish, reasoning — no consumer action needed
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
      ...rawMessages,
      ...(response.messages as ModelMessage[]),
    ];

    const finalText = await result.text;

    // Emit agent.response
    await bus?.emit('agent.response', {
      event: 'agent.response',
      sessionId,
      workdir: options.workdir,
      timestamp: new Date().toISOString(),
      response: finalText.slice(0, 5000),
    });

    // Log the complete response before emitting done
    await debugLog?.({
      type: 'response',
      text: finalText,
      tokenUsage: { ...tokenUsage },
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
