import type { LanguageModel } from 'ai';
export interface ProviderConfig {
    models: string[];
    defaultModel: string;
}
export declare const SUPPORTED_PROVIDERS: Record<string, ProviderConfig>;
export declare function getProvider(provider: string, model: string): LanguageModel;
/**
 * Stream text using the Vercel AI SDK for non-Anthropic providers.
 * Returns an async iterable of text chunks.
 */
export declare function streamTextWithProvider(provider: string, model: string, prompt: string, systemPrompt?: string): AsyncGenerator<string>;
export declare function listProviders(): void;
export declare function getDefaultModel(provider: string): string;
export declare function validateModel(provider: string, model: string): boolean;
//# sourceMappingURL=index.d.ts.map