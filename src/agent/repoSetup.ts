/**
 * LLM-driven repository setup — asks the active provider's LLM how to
 * start the project, then executes the suggested command.
 *
 * Replaces the hardcoded "npm run dev" from the original agent with an
 * intelligent discovery process:
 *   1. Try common scripts first (dev, start, serve, preview)
 *   2. If none found, ask the LLM to suggest a command based on the repo
 *   3. Execute the suggested command in the background
 */
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { spawn } from 'child_process';
import { getProvider, getDefaultModel } from '../providers/index.js';
import { streamText } from 'ai';
import type { LanguageModel } from 'ai';

export interface DiscoveredCommand {
  command: string;
  source: 'auto-detect' | 'llm-suggestion';
}

/**
 * Try common npm scripts in priority order. Returns the first match.
 */
async function tryCommonScripts(workdir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(workdir, 'package.json'), 'utf-8'));
    const scripts = pkg.scripts || {};
    const priority = ['dev', 'start', 'serve', 'preview', 'develop', 'web'];
    for (const name of priority) {
      if (scripts[name]) {
        return `npm run ${name}`;
      }
    }
  } catch {
    // No package.json
  }
  return null;
}

/**
 * Ask the LLM what command to run to start the project's dev server.
 * Provides the repo's package.json and directory listing as context.
 * Returns the LLM's suggested command.
 */
async function askLLMForStartCommand(
  workdir: string,
  provider: string,
  model: string,
): Promise<string> {
  // Gather context about the repo
  let pkgJson = '';
  try { pkgJson = await readFile(join(workdir, 'package.json'), 'utf-8'); } catch {}

  let fileListing = '';
  try {
    const entries = await readdir(workdir, { withFileTypes: true });
    fileListing = entries
      .filter((e) => !e.name.startsWith('.') || e.name === '.env.example')
      .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
      .join('\n');
  } catch {}

  const systemPrompt = `You are a DevOps expert. Given the structure of a repository, output the single shell command to start the project's development server. Reply with ONLY the command on one line, nothing else. No markdown, no backticks, no explanation. The command must start a dev server that stays running (use & if needed in the background).`;

  const userPrompt = `Repository structure:\n${fileListing || '(unknown)'}\n\npackage.json:\n${pkgJson || '(none)'}\n\nWhat command starts the dev server for this project?`;

  const modelInstance = getProvider(provider, model);
  const messages: Array<{ role: 'user' | 'system' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const result = streamText({ model: modelInstance, messages, maxOutputTokens: 200 });
  let command = '';
  for await (const chunk of result.textStream) {
    command += chunk;
  }

  // Clean up the response — strip backticks, trim whitespace
  command = command
    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
    .replace(/`/g, '')               // Remove inline backticks
    .trim()
    .split('\n')[0];                 // Take only the first line

  console.log(`[repoSetup] LLM suggested: ${command}`);
  return command || 'npm run dev'; // fallback
}

/**
 * Discover how to start the dev server for the repo at `workdir`.
 * Returns the command to run.
 */
export async function discoverDevCommand(
  workdir: string,
  provider?: string,
  model?: string,
): Promise<DiscoveredCommand> {
  const effectiveProvider = provider || process.env.DEFAULT_PROVIDER || 'anthropic';
  const effectiveModel = model || process.env.DEFAULT_MODEL || getDefaultModel(effectiveProvider);

  // Phase 1: try common scripts
  const common = await tryCommonScripts(workdir);
  if (common) {
    console.log(`[repoSetup] Auto-detected script: ${common}`);
    return { command: common, source: 'auto-detect' };
  }

  // Phase 2: ask the LLM
  console.log('[repoSetup] No common script found — asking LLM for startup command...');
  try {
    const command = await askLLMForStartCommand(workdir, effectiveProvider, effectiveModel);
    return { command, source: 'llm-suggestion' };
  } catch (err) {
    console.error('[repoSetup] LLM discovery failed:', err);
    // Fallback: just try npm run dev as last resort
    return { command: 'npm run dev', source: 'auto-detect' };
  }
}

/**
 * Start the dev server in the background. Logs output and returns
 * the child process handle so it can be cleaned up later.
 */
export function startDevServer(workdir: string, command: string): ReturnType<typeof spawn> {
  console.log(`[repoSetup] Starting dev server: ${command}`);

  const [bin, ...args] = command.split(' ');
  const child = spawn(bin ?? 'npm', args ?? ['run', 'dev'], {
    cwd: workdir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true, // allows &, pipes, etc.
  });

  child.stdout?.on('data', (d: Buffer) => {
    process.stdout.write(`[dev-server] ${d.toString()}`);
  });
  child.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(`[dev-server:err] ${d.toString()}`);
  });
  child.on('close', (code) => {
    console.log(`[repoSetup] Dev server exited with code ${code}`);
  });
  child.on('error', (err) => {
    console.error(`[repoSetup] Dev server error: ${err.message}`);
  });

  return child;
}
