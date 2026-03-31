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
import { streamText } from 'ai';
import type { LanguageModel } from 'ai';

export interface ProviderConfig {
  models: string[];
  defaultModel: string;
}

export const SUPPORTED_PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    defaultModel: 'claude-sonnet-4-6',
  },
  openai: {
    models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],
    defaultModel: 'gpt-4o',
  },
  google: {
    models: ['gemini-2.0-flash', 'gemini-2.0-pro', 'gemini-1.5-flash'],
    defaultModel: 'gemini-2.0-flash',
  },
  xai: {
    models: ['grok-2', 'grok-2-mini'],
    defaultModel: 'grok-2',
  },
};

export function getProvider(provider: string, model: string): LanguageModel {
  const normalizedProvider = provider.toLowerCase();

  switch (normalizedProvider) {
    case 'anthropic': {
      const client = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
      return client(model);
    }

    case 'openai': {
      const client = createOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
      return client(model);
    }

    case 'google': {
      const client = createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      });
      return client(model);
    }

    case 'xai': {
      const client = createXai({
        apiKey: process.env.XAI_API_KEY,
      });
      return client(model);
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
