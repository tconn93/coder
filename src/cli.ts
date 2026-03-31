import 'dotenv/config';
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'readline';
import { join, relative } from 'path';
import { generateText } from 'ai';
import { AgentOrchestrator } from './agent/index.js';
import { listProviders, getDefaultModel } from './providers/index.js';
import { getProvider } from './providers/index.js';
import { AgentLoader } from './agent/agentLoader.js';
import { BUILTIN_AGENTS } from './agent/tools.js';
import { App } from './ui/App.js';
import type {
  AgentOptions,
  StreamEvent,
  TokenUsage,
  TodoItem,
  PermissionMode,
  CustomAgentDef,
} from './types.js';

const VERSION = '1.0.0';

function formatTokenUsage(usage: TokenUsage): string {
  const tokens = usage.totalTokens.toLocaleString();
  const cost = `$${usage.costUsd.toFixed(4)}`;
  return chalk.gray(`[Usage] ${tokens} tokens | ${cost}`);
}

function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '';

  const lines: string[] = [chalk.bold('\n[Todos]')];
  for (const todo of todos) {
    let icon: string;
    let line: string;
    switch (todo.status) {
      case 'completed':
        icon = chalk.green('  ✓');
        line = chalk.green(` ${todo.title}`);
        break;
      case 'in_progress':
        icon = chalk.yellow('  ◉');
        line = chalk.yellow(` ${todo.title}`);
        break;
      default:
        icon = chalk.gray('  ○');
        line = chalk.gray(` ${todo.title}`);
    }
    lines.push(`${icon}${line}`);
  }
  return lines.join('\n');
}

/**
 * Stream agent events to stdout.
 * Returns the sessionId from the done event (or null on error).
 */
async function streamEvents(
  events: AsyncGenerator<StreamEvent>,
  opts: { verbose: boolean },
): Promise<{ sessionId: string | null; tokenUsage: TokenUsage | null; todos: TodoItem[] }> {
  const spinner = ora({ text: chalk.dim('Thinking...'), color: 'cyan', spinner: 'dots' });
  let spinnerActive = false;
  let isFirstText = true;
  let lastTodos: TodoItem[] = [];
  let resultSessionId: string | null = null;
  let resultUsage: TokenUsage | null = null;

  const stopSpinner = () => {
    if (spinnerActive) { spinner.stop(); spinnerActive = false; }
  };
  const startSpinner = (text?: string) => {
    if (!spinnerActive) {
      spinner.text = text ?? chalk.dim('Thinking...');
      spinner.start();
      spinnerActive = true;
    } else if (text) {
      spinner.text = text;
    }
  };

  startSpinner();

  for await (const event of events) {
    switch (event.type) {
      case 'text': {
        stopSpinner();
        if (isFirstText) { process.stdout.write('\n'); isFirstText = false; }
        process.stdout.write(event.data as string);
        break;
      }

      case 'tool_call': {
        const toolData = event.data as { name: string; input: Record<string, unknown> };
        stopSpinner();
        const inp = toolData.input ?? {};
        let detail = '';
        if (inp.path)    detail = ` ${chalk.gray(String(inp.path))}`;
        else if (inp.command) detail = ` ${chalk.gray(String(inp.command).slice(0, 70))}`;
        else if (inp.pattern) detail = ` ${chalk.gray(String(inp.pattern))}`;
        else if (inp.query)   detail = ` ${chalk.gray(String(inp.query).slice(0, 70))}`;
        console.log(chalk.yellow(`  → ${toolData.name}`) + detail);
        startSpinner();
        break;
      }

      case 'tool_result': {
        if (opts.verbose) {
          stopSpinner();
          const r = event.data as { toolName: string; output: string };
          console.log(chalk.dim(`    ${r.output.slice(0, 200)}`));
        }
        break;
      }

      case 'todo_update': {
        lastTodos = event.data as TodoItem[];
        const display = formatTodos(lastTodos);
        if (display) { stopSpinner(); console.log(display); startSpinner(); }
        break;
      }

      case 'subagent': {
        const sub = event.data as { name: string; status: string };
        startSpinner(chalk.dim(`Subagent [${sub.name}]: ${sub.status}...`));
        break;
      }

      case 'token_usage':
        resultUsage = event.data as TokenUsage;
        break;

      case 'done': {
        stopSpinner();
        const done = event.data as { result: string; sessionId: string; tokenUsage: TokenUsage };
        resultSessionId = done.sessionId;
        resultUsage = done.tokenUsage;
        if (!isFirstText) process.stdout.write('\n');
        if (lastTodos.length > 0) console.log(formatTodos(lastTodos));
        console.log('\n' + formatTokenUsage(done.tokenUsage));
        break;
      }

      case 'error': {
        stopSpinner();
        const err = event.data as { message: string };
        console.error(chalk.red(`\n[Error] ${err.message}\n`));
        break;
      }
    }
  }

  stopSpinner();
  return { sessionId: resultSessionId, tokenUsage: resultUsage, todos: lastTodos };
}

async function runAgentCLI(
  prompt: string,
  options: AgentOptions,
): Promise<void> {
  const orchestrator = new AgentOrchestrator(options.workdir);
  console.log(chalk.cyan(`\n[Agent] ${prompt.slice(0, 100)}\n`));
  const events = orchestrator.run(prompt, options) as AsyncGenerator<StreamEvent>;
  const { sessionId } = await streamEvents(events, { verbose: options.verbose ?? false });
  if (sessionId) console.log(chalk.dim(`[Session] ${sessionId}\n`));
}

function runREPL(options: AgentOptions): void {
  // Clear terminal before Ink takes over so the UI fills from the top
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  render(React.createElement(App, { options }));
}

// ---------------------------------------------------------------------------
// agents command helpers
// ---------------------------------------------------------------------------

async function listAgents(workdir: string): Promise<void> {
  console.log(chalk.bold('\nBuilt-in agents:\n'));
  for (const agent of BUILTIN_AGENTS) {
    console.log(`  ${chalk.cyan(agent.name.padEnd(20))} ${agent.description}`);
    console.log(`  ${''.padEnd(20)} ${chalk.gray(`model: ${agent.model}`)}`);
  }

  const loader = new AgentLoader(join(workdir, 'agents'));
  const custom = await loader.loadAll();

  const dir = join(workdir, 'agents');
  console.log(chalk.bold(`\nCustom agents`) + chalk.gray(` (${dir}):\n`));
  if (custom.length === 0) {
    console.log(chalk.gray(`  (none — run 'coder agents create' to add one)\n`));
  } else {
    for (const agent of custom) {
      console.log(`  ${chalk.cyan(agent.name.padEnd(20))} ${agent.description}`);
      console.log(`  ${''.padEnd(20)} ${chalk.gray(`model: ${agent.model}  tools: ${agent.tools.join(', ')}`)}`);
    }
    console.log('');
  }
}

async function createAgent(workdir: string, provider: string, model: string): Promise<void> {
  if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    console.error(chalk.red('\nError: ANTHROPIC_API_KEY environment variable is not set.\n'));
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

  console.log(chalk.cyan('\nCreate a custom subagent\n'));
  const description = (
    await ask(chalk.bold('What should this agent do? ') + chalk.gray('(describe its purpose)\n> '))
  ).trim();
  rl.close();

  if (!description) {
    console.log(chalk.gray('Cancelled.\n'));
    return;
  }

  const spinner = ora('Generating agent definition…').start();

  let agentDef: CustomAgentDef;
  try {
    const { text } = await generateText({
      model: getProvider(provider, model),
      messages: [
        {
          role: 'user',
          content: `Create a custom AI subagent definition for this purpose: "${description}"

Respond with ONLY a JSON object (no markdown fences, no explanation):
{
  "name": "kebab-case-slug",
  "description": "one concise sentence",
  "model": "claude-sonnet-4-6",
  "tools": ["read_file"],
  "systemPrompt": "detailed system prompt paragraphs..."
}

Rules:
- name: lowercase kebab-case, 2-4 words
- model: claude-opus-4-6 (complex reasoning), claude-sonnet-4-6 (general), claude-haiku-4-5 (simple/fast)
- tools: choose only what's needed from [read_file, write_file, edit_file, bash, glob, grep]
- systemPrompt: 2-4 paragraphs covering expertise, approach, and key behaviors`,
        },
      ],
    });

    spinner.stop();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in response');
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    agentDef = {
      name: String(parsed.name || 'custom-agent'),
      description: String(parsed.description || description),
      model: String(parsed.model || 'claude-sonnet-4-6'),
      tools: Array.isArray(parsed.tools)
        ? (parsed.tools as unknown[]).map(String)
        : ['read_file', 'grep', 'glob'],
      systemPrompt: String(parsed.systemPrompt || ''),
    };
  } catch (err) {
    spinner.stop();
    console.error(chalk.red(`\nFailed to generate agent: ${(err as Error).message}\n`));
    return;
  }

  // Display the generated definition
  console.log(chalk.bold('\nGenerated agent:\n'));
  console.log(`  ${chalk.cyan('Name:')}         ${agentDef.name}`);
  console.log(`  ${chalk.cyan('Description:')}  ${agentDef.description}`);
  console.log(`  ${chalk.cyan('Model:')}        ${agentDef.model}`);
  console.log(`  ${chalk.cyan('Tools:')}        ${agentDef.tools.join(', ')}`);
  console.log(`\n${chalk.cyan('System prompt:')}`);
  console.log(
    chalk.gray(
      agentDef.systemPrompt
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    ),
  );

  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  const confirm = await new Promise<string>((r) =>
    rl2.question(chalk.bold('\nSave this agent? ') + chalk.gray('[Y/n] '), r),
  );
  rl2.close();

  if (confirm.trim().toLowerCase() === 'n') {
    console.log(chalk.gray('Cancelled.\n'));
    return;
  }

  const loader = new AgentLoader(join(workdir, 'agents'));
  const filepath = await loader.save(agentDef);
  console.log(chalk.green(`\nSaved to ${relative(workdir, filepath)}\n`));
  console.log(chalk.gray(`The agent '${agentDef.name}' is now available via spawn_subagent.\n`));
}

// Main CLI program
const program = new Command();

program
  .name('coder')
  .description('AI Coding Agent powered by Claude Agent SDK')
  .version(VERSION)
  .argument('[prompt]', 'Prompt to run (if omitted, starts interactive REPL)')
  .option('--web', 'Start web UI server')
  .option('--port <number>', 'Web server port', '3000')
  .option('--provider <name>', 'LLM provider: anthropic|openai|google|xai', process.env.DEFAULT_PROVIDER ?? 'anthropic')
  .option('--model <model>', 'Model name (default: provider default, or DEFAULT_MODEL env var)')
  .option('--max-turns <n>', 'Maximum agent turns', '50')
  .option('--budget <usd>', 'Maximum budget in USD', '5.00')
  .option(
    '--permission-mode <mode>',
    'Permission mode: default|acceptEdits|bypassPermissions|plan',
    'acceptEdits',
  )
  .option('--workdir <path>', 'Working directory', process.cwd())
  .option('--working-dir <path>', 'Working directory (alias for --workdir)')
  .option('--resume <id>', 'Resume a previous session')
  .option('--list-providers', 'List available providers and models')
  .option('-v, --verbose', 'Verbose output (show all tool results)')
  .action(async (prompt: string | undefined, opts: Record<string, string | boolean>) => {
    // Handle --list-providers
    if (opts['listProviders']) {
      listProviders();
      process.exit(0);
    }

    const provider = String(opts['provider'] || process.env.DEFAULT_PROVIDER || 'anthropic');
    const model = String(opts['model'] || process.env.DEFAULT_MODEL || getDefaultModel(provider));
    const maxTurns = parseInt(String(opts['maxTurns'] || '50'));
    const budget = parseFloat(String(opts['budget'] || '5.00'));
    const permissionMode = String(opts['permissionMode'] || 'acceptEdits') as PermissionMode;
    const workdir = String(opts['workingDir'] || opts['workdir'] || process.cwd());
    const verbose = Boolean(opts['verbose']);
    const port = parseInt(String(opts['port'] || '3000'));

    const agentOptions: AgentOptions = {
      provider,
      model,
      maxTurns,
      budget,
      permissionMode,
      workdir,
      verbose,
    };

    // Validate API key for Anthropic
    if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
      console.error(chalk.red('\nError: ANTHROPIC_API_KEY environment variable is not set.'));
      console.error(chalk.gray('Set it in your .env file or environment:\n'));
      console.error(chalk.gray('  export ANTHROPIC_API_KEY=your_key_here\n'));
      process.exit(1);
    }

    // Handle --web flag
    if (opts['web']) {
      const { startWebServer } = await import('./server/index.js');
      console.log(chalk.cyan(`\nStarting web server on port ${port}...`));
      await startWebServer({ port, workdir });

      // Try to open browser
      try {
        const { execSync } = await import('child_process');
        const url = `http://localhost:${port}`;
        const platform = process.platform;
        if (platform === 'darwin') {
          execSync(`open ${url}`);
        } else if (platform === 'win32') {
          execSync(`start ${url}`);
        } else {
          execSync(`xdg-open ${url}`);
        }
      } catch {
        // Browser open failed, that's ok
      }

      // Keep process alive
      await new Promise(() => {});
      return;
    }

    // Handle --resume
    if (opts['resume']) {
      const resumeId = String(opts['resume']);
      if (!prompt) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(chalk.cyan('Resume prompt > '), async (resumePrompt) => {
          rl.close();
          const orchestrator = new AgentOrchestrator(workdir);
          for await (const event of orchestrator.resume(resumeId, resumePrompt, agentOptions) as AsyncGenerator<StreamEvent>) {
            // Simple output for resume
            if (event.type === 'text') process.stdout.write(event.data as string);
            if (event.type === 'done') break;
          }
        });
      } else {
        const orchestrator = new AgentOrchestrator(workdir);
        for await (const event of orchestrator.resume(resumeId, prompt, agentOptions) as AsyncGenerator<StreamEvent>) {
          if (event.type === 'text') process.stdout.write(event.data as string);
          if (event.type === 'done') break;
        }
      }
      return;
    }

    // Run with prompt or enter REPL
    if (prompt) {
      await runAgentCLI(prompt, agentOptions);
    } else {
      await runREPL(agentOptions);
    }
  });

// ---------------------------------------------------------------------------
// agents subcommand
// ---------------------------------------------------------------------------
program
  .command('agents [action]')
  .description("Manage subagents: 'list' (default) or 'create'")
  .option('--workdir <path>', 'Working directory', process.cwd())
  .option('--working-dir <path>', 'Working directory (alias for --workdir)')
  .option('--provider <name>', 'LLM provider for agent creation', process.env.DEFAULT_PROVIDER ?? 'anthropic')
  .option('--model <name>', 'Model for agent creation')
  .action(async (action: string | undefined, opts: Record<string, string>) => {
    const workdir = String(opts['workingDir'] || opts['workdir'] || process.cwd());
    const provider = String(opts['provider'] || 'anthropic');
    const model = String(opts['model'] || getDefaultModel(provider));

    if (!action || action === 'list') {
      await listAgents(workdir);
    } else if (action === 'create') {
      await createAgent(workdir, provider, model);
    } else {
      console.error(chalk.red(`\nUnknown action '${action}'. Use 'list' or 'create'.\n`));
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red(`\nError: ${err.message}\n`));
  process.exit(1);
});
