import { generateText } from 'ai';
import type { ModelMessage } from 'ai';
import { getProvider } from '../providers/index.js';
import type { MemoryManager } from './memory.js';

export interface TriageResponse {
  gist: string;
  context_selection: {
    strategy: 'full' | 'relevant_only' | 'none';
    required_message_indices: number[];
    reasoning?: string;
  };
  memory_search: {
    perform_search: boolean;
    search_queries: string[];
  };
  difficulty_level: number;
  requires_deep_thinking: boolean;
}

const TRIAGE_SYSTEM_PROMPT = `You are the Context Router and Memory Orchestrator for an advanced AI system.
Your job is to analyze the user's current request against the provided conversation history and output a strict JSON routing object.
DO NOT output any conversational text, pleasantries, or wrapping text outside the JSON block.

You must evaluate:
1. Gist: Summarize the user's intent in 1 succinct sentence.
2. Context Selection: Which previous messages in the conversation history are strictly necessary to fulfill the current request? If the request is an entirely new topic, set \`strategy\` to "none" and return an empty array [] for \`required_message_indices\`. Limit indices to only the absolutely essential messages to save tokens.
3. Memory Search: Does the request require recalling facts, user preferences, or external documentation not present in the history? If so, set \`perform_search\` to true and provide relevant ElasticSearch queries.
4. Routing Difficulty: Rate the complexity of the request from 1 to 10 (1 = simple greeting or direct fact retrieval; 10 = complex logic, deep architecture, or heavy code generation).
5. Deep Thinking: Does the request require multi-step reasoning or high cognitive effort? (Boolean)

OUTPUT EXACTLY THIS JSON FORMAT AND NOTHING ELSE:
{
  "gist": "A 1-sentence summary of the user's intent",
  "context_selection": {
    "strategy": "full | relevant_only | none",
    "required_message_indices": [0, 5, 6], 
    "reasoning": "Why these messages were chosen"
  },
  "memory_search": {
    "perform_search": true,
    "search_queries": ["query 1", "query 2"]
  },
  "difficulty_level": 1,
  "requires_deep_thinking": false
}`;

export function assembleContext(history: ModelMessage[], indices: number[]): string {
  const leanHistory: string[] = [];
  for (const idx of indices) {
    if (idx >= 0 && idx < history.length) {
      const msg = history[idx];
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      leanHistory.push(`[${idx}] ${msg.role.toUpperCase()}: ${content}`);
    }
  }
  return leanHistory.join('\n');
}

export async function performMemorySearch(queries: string[], memoryManager?: MemoryManager): Promise<string> {
  console.log(`[System] Executing memory search for: [${queries.join(', ')}]`);
  if (!queries.length || !memoryManager) return '';

  const results: string[] = [];
  try {
    await memoryManager.load();
    for (const q of queries) {
      const hits = await memoryManager.search(q);
      for (const h of hits) {
        results.push(`[${h.name}] (${h.type}): ${h.body}`);
      }
    }
  } catch (e) {
    console.error("[System] Memory search execution failed.", e);
  }

  const uniqueResults = [...new Set(results)];
  if (!uniqueResults.length) return "No relevant memories found.";

  return `Memory Search Results:\n${uniqueResults.join('\n\n')}`;
}

export function parseTriageResponse(text: string): TriageResponse {
  try {
    // Strip potential markdown blocks
    const cleanText = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleanText) as TriageResponse;
  } catch (e) {
    console.error('[System] Failed to parse Triage LLM JSON output. Falling back to defaults.', e);
    return {
      gist: 'Parse failed',
      context_selection: { strategy: 'full', required_message_indices: [] },
      memory_search: { perform_search: false, search_queries: [] },
      difficulty_level: 1,
      requires_deep_thinking: false
    };
  }
}

export async function triageRequest(
  userInput: string, 
  history: ModelMessage[],
  triageProvider: string = 'openai',
  triageModel: string = 'gpt-4o-mini'
): Promise<TriageResponse> {
  // Format history with index for triage
  const formattedHistory = history.map((msg, i) => {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    return `[${i}] ${msg.role.toUpperCase()}: ${content}`;
  }).join('\n');

  const prompt = `Latest User Input: ${userInput}\n\nConversation History:\n${formattedHistory}`;

  console.log('[System] Sending request to Triage LLM...');
  const { text } = await generateText({
    model: getProvider(triageProvider, triageModel),
    system: TRIAGE_SYSTEM_PROMPT,
    prompt,
  });

  return parseTriageResponse(text);
}

export interface OrchestrationResult {
  leanPrompt: string;
  targetProvider: string;
  targetModel: string;
  triageData: TriageResponse;
}

export async function routerMiddleware(
  userInput: string, 
  history: ModelMessage[],
  defaultProvider: string,
  defaultModel: string,
  memoryManager?: MemoryManager
): Promise<OrchestrationResult> {
  // Map to a fast triage model based on their default provider to save cost
  let triageModel = defaultModel;
  if (defaultProvider === 'openai') triageModel = 'gpt-4o-mini';
  else if (defaultProvider === 'anthropic') triageModel = 'claude-haiku-4-5';
  else if (defaultProvider === 'google' || defaultProvider === 'gcp') triageModel = 'gemini-1.5-flash';
  else if (defaultProvider === 'xai') triageModel = 'grok-4-1-fast-non-reasoning';

  const triageData = await triageRequest(userInput, history, defaultProvider, triageModel);

  const indices = triageData.context_selection?.required_message_indices || [];
  const selectedContext = assembleContext(history, indices);

  let memoryContext = '';
  if (triageData.memory_search?.perform_search) {
    memoryContext = await performMemorySearch(triageData.memory_search.search_queries || [], memoryManager);
  }

  const leanPrompt = `System Prompt: You are a helpful AI assistant. Answer the user's request using the optimal context provided below.

=== Relevant Conversation History ===
${selectedContext || 'None'}

=== Memory Search Results ===
${memoryContext || 'None'}

=== Latest User Request ===
${userInput}
`;

  let targetProvider = defaultProvider;
  let targetModel = defaultModel;

  // Route to the strongest reasoning model on their chosen provider if difficulty > 7
  if (triageData.difficulty_level > 7 || triageData.requires_deep_thinking) {
    if (defaultProvider === 'openai') targetModel = 'o1';
    else if (defaultProvider === 'anthropic') targetModel = 'claude-opus-4-6';
    else if (defaultProvider === 'xai') targetModel = 'grok-4-1-fast-reasoning';
    else if (defaultProvider === 'google' || defaultProvider === 'gcp') targetModel = 'gemini-2.0-pro';
  }

  console.log(`[System] Triage determined Difficulty=${triageData.difficulty_level}, Deep Thinking=${triageData.requires_deep_thinking}`);
  console.log(`[System] Selected indices for context: [${indices.join(', ')}]`);
  console.log(`[System] Routing request to: ${targetProvider}:${targetModel}`);

  return {
    leanPrompt,
    targetProvider,
    targetModel,
    triageData
  };
}
