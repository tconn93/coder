import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'readline';
import { AgentOrchestrator } from './agent/index.js';
import { listProviders, getDefaultModel } from './providers/index.js';
import type {
  AgentOptions,
  StreamEvent,
  TokenUsage,
  TodoItem,
  PermissionMode,
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

async function runAgentCLI(
  prompt: string,
  options: AgentOptions,
  verbose: boolean,
): Promise<void> {
  const orchestrator = new AgentOrchestrator(options.workdir);
  const spinner = ora({
    text: chalk.dim('Agent thinking...'),
    color: 'cyan',
    spinner: 'dots',
  });

  let isFirstText = true;
  let lastTodos: TodoItem[] = [];
  let spinnerActive = false;

  console.log(chalk.cyan(`\n[Agent] Working on: ${prompt.slice(0, 80)}...\n`));

  spinner.start();
  spinnerActive = true;

  for await (const event of orchestrator.run(prompt, options) as AsyncGenerator<StreamEvent>) {
    switch (event.type) {
      case 'text': {
        if (spinnerActive) {
          spinner.stop();
          spinnerActive = false;
        }
        if (isFirstText) {
          process.stdout.write('\n');
          isFirstText = false;
        }
        process.stdout.write(event.data as string);
        break;
      }

      case 'tool_call': {
        const toolData = event.data as { name: string; input: Record<string, unknown> };
        if (!spinnerActive) {
          process.stdout.write('\n');
        } else {
          spinner.stop();
          spinnerActive = false;
        }

        let detail = '';
        const inp = toolData.input;
        if (inp?.file_path) detail = ` ${chalk.gray(String(inp.file_path))}`;
        else if (inp?.path) detail = ` ${chalk.gray(String(inp.path))}`;
        else if (inp?.command) detail = ` ${chalk.gray(String(inp.command).slice(0, 60))}`;
        else if (inp?.pattern) detail = ` ${chalk.gray(String(inp.pattern))}`;
        else if (inp?.query) detail = ` ${chalk.gray(String(inp.query).slice(0, 60))}`;

        console.log(
          chalk.yellow(`  → ${toolData.name}`) + detail,
        );

        if (!spinnerActive) {
          spinner.start();
          spinnerActive = true;
        }
        break;
      }

      case 'tool_result': {
        if (verbose) {
          const result = event.data as { toolName: string; output: string };
          if (spinnerActive) { spinner.stop(); spinnerActive = false; }
          console.log(chalk.dim(`    ${result.output.slice(0, 200)}`));
        }
        break;
      }

      case 'todo_update': {
        lastTodos = event.data as TodoItem[];
        const display = formatTodos(lastTodos);
        if (display) {
          if (spinnerActive) { spinner.stop(); spinnerActive = false; }
          console.log(display);
          spinner.start();
          spinnerActive = true;
        }
        break;
      }

      case 'subagent': {
        const sub = event.data as { name: string; status: string };
        if (!spinnerActive) {
          spinner.start();
          spinnerActive = true;
        }
        spinner.text = chalk.dim(`Subagent [${sub.name}]: ${sub.status}...`);
        break;
      }

      case 'token_usage': {
        // Will be shown at end
        break;
      }

      case 'done': {
        if (spinnerActive) { spinner.stop(); spinnerActive = false; }
        const done = event.data as { result: string; sessionId: string; tokenUsage: TokenUsage };

        process.stdout.write('\n');
        console.log(chalk.green('\n[Result]') + ' ' + (done.result ? done.result.slice(0, 200) : 'Done'));

        if (lastTodos.length > 0) {
          console.log(formatTodos(lastTodos));
        }

        console.log('\n' + formatTokenUsage(done.tokenUsage));
        console.log(chalk.dim(`[Session] ${done.sessionId}\n`));
        break;
      }

      case 'error': {
        if (spinnerActive) { spinner.stop(); spinnerActive = false; }
        const err = event.data as { message: string };
        console.error(chalk.red(`\n[Error] ${err.message}\n`));
        break;
      }
    }
  }

  if (spinnerActive) {
    spinner.stop();
  }
}

async function runREPL(options: AgentOptions): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(chalk.cyan('\n AI Coding Agent — Interactive Mode'));
  console.log(chalk.gray('Commands: /quit, /help, /todos, /clear, /providers'));
  console.log(chalk.gray('Press Ctrl+Enter for multiline input\n'));

  const askQuestion = (): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(chalk.cyan('> '), (answer) => {
        resolve(answer);
      });
    });
  };

  while (true) {
    let input: string;
    try {
      input = await askQuestion();
    } catch {
      break;
    }

    input = input.trim();
    if (!input) continue;

    // Handle special commands
    if (input === '/quit' || input === '/exit') {
      console.log(chalk.gray('\nGoodbye!\n'));
      rl.close();
      break;
    }

    if (input === '/help') {
      console.log(chalk.bold('\nCommands:'));
      console.log('  /quit, /exit    — Exit the REPL');
      console.log('  /help           — Show this help');
      console.log('  /todos          — Show current todo list');
      console.log('  /clear          — Clear the screen');
      console.log('  /providers      — List available providers');
      console.log('\nKeyboard shortcuts:');
      console.log('  Ctrl+C          — Cancel current run\n');
      continue;
    }

    if (input === '/clear') {
      console.clear();
      continue;
    }

    if (input === '/providers') {
      listProviders();
      continue;
    }

    if (input === '/todos') {
      // Just run a simple message
      console.log(chalk.gray('(Run a task first to see todos)\n'));
      continue;
    }

    if (input.startsWith('/resume ')) {
      const sessionId = input.slice(8).trim();
      console.log(chalk.dim(`Resuming session: ${sessionId}`));
      const nextPrompt = await askQuestion();
      if (nextPrompt.trim()) {
        await runAgentCLI(nextPrompt.trim(), options, options.verbose || false);
      }
      continue;
    }

    // Run the agent
    await runAgentCLI(input, options, options.verbose || false);
  }
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
    const workdir = String(opts['workdir'] || process.cwd());
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
      await startWebServer({ port });

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
      await runAgentCLI(prompt, agentOptions, verbose);
    } else {
      await runREPL(agentOptions);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red(`\nError: ${err.message}\n`));
  process.exit(1);
});
