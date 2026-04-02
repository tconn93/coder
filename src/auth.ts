/**
 * Global auth config stored at $HOME/.coder/settings.json.
 * Manages API keys for LLM providers.
 *
 * Reads synchronously so getApiKey() can be called from the synchronous
 * getProvider() function in providers/index.ts without changing its signature.
 */
import { mkdirSync, readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

export interface AuthConfig {
  apiKeys: Record<string, string>;
  defaultProvider?: string;
  defaultModel?: string;
}

const AUTH_DIR = join(homedir(), '.coder');
const AUTH_FILE = join(AUTH_DIR, 'settings.json');

let _cache: AuthConfig | null = null;

function readConfig(): AuthConfig {
  if (_cache) return _cache;
  try {
    mkdirSync(AUTH_DIR, { recursive: true });
    const raw = readFileSync(AUTH_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AuthConfig>;
    _cache = {
      apiKeys: parsed.apiKeys ?? {},
      defaultProvider: parsed.defaultProvider,
      defaultModel: parsed.defaultModel,
    };
  } catch {
    _cache = { apiKeys: {} };
  }
  return _cache;
}

/** Returns the stored API key for a provider, or undefined if not configured. */
export function getApiKey(provider: string): string | undefined {
  return readConfig().apiKeys[provider.toLowerCase()];
}

/** Returns all provider names that have a key stored. */
export function getConfiguredProviders(): string[] {
  return Object.keys(readConfig().apiKeys);
}

/** Saves an API key for a provider and flushes to disk. */
export async function saveApiKey(provider: string, key: string): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  const config = readConfig();
  config.apiKeys[provider.toLowerCase()] = key;
  await writeFile(AUTH_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  _cache = config;
}

/** Removes a provider's API key. */
export async function removeApiKey(provider: string): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  const config = readConfig();
  delete config.apiKeys[provider.toLowerCase()];
  await writeFile(AUTH_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  _cache = config;
}

export function getAuthFilePath(): string {
  return AUTH_FILE;
}

export function getDefaultProviderSetting(): string | undefined {
  return readConfig().defaultProvider;
}

export function getDefaultModelSetting(): string | undefined {
  return readConfig().defaultModel;
}

export async function setDefaultProvider(provider: string): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  const config = readConfig();
  config.defaultProvider = provider.toLowerCase();
  await writeFile(AUTH_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  _cache = config;
}

export async function setDefaultModel(model: string): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  const config = readConfig();
  config.defaultModel = model;
  await writeFile(AUTH_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  _cache = config;
}
