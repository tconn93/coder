/**
 * Multi-provider LLM setup using Vercel AI SDK.
 *
 * Note: The Claude Agent SDK only works with Anthropic models natively.
 * The Vercel AI SDK is used as an alternative for non-Anthropic providers.
 * When provider is not 'anthropic', streamText from the Vercel AI SDK is used.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';
import type { LanguageModel } from 'ai';
import { getApiKey } from '../auth.js';

export interface ProviderConfig {
  models: string[];
  defaultModel: string;
}

/**
 * Supported providers and their models.
 *
 * Model lists are sourced directly from each @ai-sdk/* provider package's
 * TypeScript type definitions (e.g., AnthropicMessagesModelId, OpenAIChatModelId,
 * GoogleGenerativeAIModelId, XaiChatModelId). When you upgrade the AI SDK,
 * these lists automatically stay in sync via the type system — the union types
 * in the SDK's .d.ts files are the authoritative source.
 *
 * The lists below focus on chat/language models. Embedding, image, video,
 * and audio-only models are excluded from the CLI listing but can still be
 * passed via --model (the SDK accepts any string via (string & {}) fallback).
 */
export const SUPPORTED_PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    models: [
      // Latest generation (June 2026)
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      // Versioned snapshots
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-opus-4-1',
      'claude-sonnet-4-0',
      'claude-opus-4-0',
      // Legacy
      'claude-3-haiku-20240307',
    ],
    defaultModel: 'claude-sonnet-4-6',
  },
  openai: {
    models: [
      // GPT-5.x family (latest)
      'gpt-5.4-pro',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.2-pro',
      'gpt-5.2',
      'gpt-5.1',
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-nano',
      // o-series reasoning
      'o4-mini',
      'o3',
      'o3-mini',
      'o1',
      // GPT-4 family
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'gpt-4o',
      'gpt-4o-mini',
      // Legacy
      'gpt-3.5-turbo',
    ],
    defaultModel: 'gpt-5.2',
  },
  google: {
    models: [
      // Gemini 3.x (latest previews)
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-image-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      // Gemini 2.5
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      // Gemini 2.0
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      // Gemma open models
      'gemma-3-27b-it',
      'gemma-3-12b-it',
      'gemma-3-4b-it',
      // Convenience aliases
      'gemini-pro-latest',
      'gemini-flash-latest',
    ],
    defaultModel: 'gemini-3.1-pro-preview',
  },
  xai: {
    models: [
      // Grok 4.x
      'grok-4-1-fast-reasoning',
      'grok-4-1-fast-non-reasoning',
      'grok-4-fast-reasoning',
      'grok-4-fast-non-reasoning',
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'grok-code-fast-1',
      // Grok 3
      'grok-3',
      'grok-3-mini',
      // Convenience aliases
      'grok-4-latest',
      'grok-3-latest',
      'grok-3-mini-latest',
    ],
    defaultModel: 'grok-4-1-fast-reasoning',
  },
  deepseek: {
    models: [
      // DeepSeek-V4 (latest generation)
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      // DeepSeek-V3 / R1 (previous generation)
      'deepseek-chat',
      'deepseek-reasoner',
    ],
    defaultModel: 'deepseek-v4-flash',
  },
};

export function getProvider(provider: string, model: string): LanguageModel {
  const normalizedProvider = provider.toLowerCase();

  switch (normalizedProvider) {
    case 'anthropic': {
      const apiKey = getApiKey('anthropic') ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("No API key configured for 'anthropic'. Run `coder auth` to set one up.");
      const client = createAnthropic({ apiKey });
      return client(model);
    }

    case 'openai': {
      const apiKey = getApiKey('openai') ?? process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("No API key configured for 'openai'. Run `coder auth` to set one up.");
      const client = createOpenAI({ apiKey });
      return client(model);
    }

    case 'google': {
      const apiKey = getApiKey('google') ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) throw new Error("No API key configured for 'google'. Run `coder auth` to set one up.");
      const client = createGoogleGenerativeAI({ apiKey });
      return client(model);
    }

    case 'xai': {
      const apiKey = getApiKey('xai') ?? process.env.XAI_API_KEY;
      if (!apiKey) throw new Error("No API key configured for 'xai'. Run `coder auth` to set one up.");
      const client = createXai({ apiKey });
      return client(model);
    }

    case 'deepseek': {
      const apiKey = getApiKey('deepseek') ?? process.env.DEEPSEEK_API_KEY;
      if (!apiKey) throw new Error("No API key configured for 'deepseek'. Run `coder auth` to set one up.");
      const client = createOpenAICompatible({
        name: 'deepseek',
        apiKey,
        baseURL: 'https://api.deepseek.com/v1',
      });
      return client.languageModel(model)!;
    }

    default:
      throw new Error(
        `Unsupported provider: ${provider}. Supported: ${Object.keys(SUPPORTED_PROVIDERS).join(', ')}`,
      );
  }
}

/**
 * Stream text using the Vercel AI SDK for non-Anthropic providers.
 * Returns an async iterable of text chunks.
 */
export async function* streamTextWithProvider(
  provider: string,
  model: string,
  prompt: string,
  systemPrompt?: string,
): AsyncGenerator<string> {
  const languageModel = getProvider(provider, model);

  const messages: Array<{ role: 'user' | 'system' | 'assistant'; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const result = streamText({
    model: languageModel,
    messages,
  });

  for await (const chunk of result.textStream) {
    yield chunk;
  }
}

export function listProviders(): void {
  console.log('\nSupported Providers and Models:\n');
  for (const [provider, config] of Object.entries(SUPPORTED_PROVIDERS)) {
    console.log(`  ${provider}:`);
    for (const m of config.models) {
      const isDefault = m === config.defaultModel ? ' (default)' : '';
      console.log(`    - ${m}${isDefault}`);
    }
    console.log('');
  }
}

export function getDefaultModel(provider: string): string {
  const config = SUPPORTED_PROVIDERS[provider.toLowerCase()];
  if (!config) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return config.defaultModel;
}

export function validateModel(provider: string, model: string): boolean {
  const config = SUPPORTED_PROVIDERS[provider.toLowerCase()];
  if (!config) return false;
  return config.models.includes(model);
}

// ---------------------------------------------------------------------------
// Model tier system — maps capability tiers to per-provider concrete models.
// Subagent definitions use tier keys (opus/sonnet/haiku) instead of hardcoded
// Anthropic model IDs so spawn_subagent works cross-provider.
// ---------------------------------------------------------------------------

/** Capability tiers for subagent model resolution. */
export type ModelTier = 'opus' | 'sonnet' | 'haiku';

/** Maps each tier to a per-provider concrete model ID. */
export const MODEL_TIERS: Record<ModelTier, Record<string, string>> = {
  opus: {
    anthropic: 'claude-opus-4-6',
    openai: 'gpt-5.4-pro',
    google: 'gemini-3.1-pro-preview',
    xai: 'grok-4-1-fast-reasoning',
    deepseek: 'deepseek-v4-pro',
  },
  sonnet: {
    anthropic: 'claude-sonnet-4-6',
    openai: 'gpt-5.2',
    google: 'gemini-3.1-flash-image-preview',
    xai: 'grok-4-fast-reasoning',
    deepseek: 'deepseek-v4-flash',
  },
  haiku: {
    anthropic: 'claude-haiku-4-5',
    openai: 'gpt-5.4-nano',
    google: 'gemini-2.0-flash',
    xai: 'grok-4-1-fast-non-reasoning',
    deepseek: 'deepseek-v4-flash',
  },
};

/**
 * Resolve a tier key to a provider-specific model ID.
 * If `tierOrModel` is not a recognized tier, it's treated as a direct model
 * ID and returned as-is (backwards-compatible with hardcoded model strings).
 */
export function resolveModelTier(provider: string, tierOrModel: string): string {
  const mapping = MODEL_TIERS[tierOrModel as ModelTier];
  if (!mapping) {
    // Not a tier key — pass through as a direct model ID
    return tierOrModel;
  }
  const normalizedProvider = provider.toLowerCase();
  return mapping[normalizedProvider] ?? mapping['anthropic'];
}
