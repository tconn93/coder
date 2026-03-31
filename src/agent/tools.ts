/**
 * Tool definitions for the AI Coding Agent using Vercel AI SDK v6.
 * These implement the same tool surface as Claude Code's built-in tools.
 */
import { tool, generateText } from 'ai';
import { z } from 'zod';
import { promises as fs } from 'fs';
import { resolve, relative, dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import fg from 'fast-glob';
import { TodoTracker } from './todos.js';
import { getProvider } from '../providers/index.js';
import type { CustomAgentDef } from '../types.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Subagent definitions
// ---------------------------------------------------------------------------

interface SubagentDef {
  description: string;
  systemPrompt: string;
  tools: string[];
  model: string;
}

const SUBAGENT_DEFS: Record<string, SubagentDef> = {
  'code-reviewer': {
    description: 'Security audits, code quality, performance analysis',
    systemPrompt: `You are an expert code reviewer with deep knowledge of security vulnerabilities, performance optimization, and software engineering best practices.

When reviewing code:
1. Identify security vulnerabilities (OWASP Top 10, injection attacks, auth issues)
2. Check for performance bottlenecks and inefficiencies
3. Verify adherence to coding standards and patterns
4. Assess test coverage and quality
5. Suggest specific, actionable improvements with code examples

Be thorough, specific, and constructive. Always cite specific line numbers and file paths.`,
    tools: ['read_file', 'grep', 'glob'],
    model: 'claude-sonnet-4-6',
  },
  'test-runner': {
    description: 'Execute tests, analyze failures, improve coverage',
    systemPrompt: `You are an expert test engineer who specializes in running tests and analyzing results.

When working with tests:
1. Run the test suite and capture all output
2. Identify failing tests and their root causes
3. Look for patterns in test failures
4. Check test coverage and identify gaps
5. Suggest fixes for failing tests with specific code changes`,
    tools: ['bash', 'read_file', 'grep'],
    model: 'claude-sonnet-4-6',
  },
  'file-explorer': {
    description: 'Map codebase structure, find files, understand architecture',
    systemPrompt: `You are an expert at exploring and understanding codebases.

When exploring:
1. Map out the overall project structure
2. Identify key files, entry points, and important modules
3. Understand dependencies and relationships between components
4. Find relevant files for specific functionality
5. Summarize the architecture and patterns used`,
    tools: ['read_file', 'glob', 'grep'],
    model: 'claude-haiku-4-5',
  },
  'security-scanner': {
    description: 'Find vulnerabilities, secrets, injection risks',
    systemPrompt: `You are a security expert specializing in identifying vulnerabilities in code.

When scanning:
1. Look for injection vulnerabilities: SQL, XSS, command injection
2. Identify hardcoded secrets, API keys, and sensitive data
3. Check authentication and authorization logic
4. Review input validation and sanitization
5. Look for insecure dependencies

Report findings with severity levels (Critical/High/Medium/Low) and remediation steps.`,
    tools: ['read_file', 'grep', 'glob'],
    model: 'claude-opus-4-6',
  },
  'doc-writer': {
    description: 'Write README, API docs, inline documentation',
    systemPrompt: `You are a technical writer who creates clear, comprehensive documentation.

When writing docs:
1. Understand the code before writing about it
2. Write for the target audience (developers, users, etc.)
3. Include examples and code snippets
4. Cover common use cases and edge cases
5. Keep documentation accurate and up-to-date`,
    tools: ['read_file', 'write_file', 'glob', 'grep'],
    model: 'claude-sonnet-4-6',
  },
};

/** Exported for use in CLI listing and REPL /agents command. */
export const BUILTIN_AGENTS = Object.entries(SUBAGENT_DEFS).map(([name, def]) => ({
  name,
  description: def.description,
  model: def.model,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode HTML entities in a string before writing to disk. */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g,       (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

// ---------------------------------------------------------------------------
// Base tools (no spawn_subagent — safe to use inside subagent contexts)
// ---------------------------------------------------------------------------

export function createBaseTools(workdir: string, todoTracker: TodoTracker) {
  return {
    read_file: tool({
      description: 'Read the contents of a file. Returns content with line numbers.',
      inputSchema: z.object({
        path: z.string().describe('File path (relative to workdir or absolute)'),
        offset: z.number().optional().describe('Start line number (1-indexed)'),
        limit: z.number().optional().describe('Maximum lines to return'),
      }),
      execute: async (input) => {
        const { path, offset, limit } = input;
        const filePath = resolve(workdir, path);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const lines = content.split('\n');
          const start = offset ? offset - 1 : 0;
          const end = limit ? start + limit : lines.length;
          return lines
            .slice(start, end)
            .map((line, i) => `${String(start + i + 1).padStart(4)}\t${line}`)
            .join('\n');
        } catch (err) {
          return `Error: ${(err as NodeJS.ErrnoException).message}`;
        }
      },
    }),

    write_file: tool({
      description: 'Write content to a file (creates or overwrites).',
      inputSchema: z.object({
        path: z.string().describe('File path to write'),
        content: z.string().describe('Content to write'),
      }),
      execute: async (input) => {
        const { path } = input;
        const content = decodeHtmlEntities(input.content);
        const filePath = resolve(workdir, path);
        try {
          await fs.mkdir(dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, content, 'utf-8');
          return `Wrote ${content.length} chars to ${relative(workdir, filePath)}`;
        } catch (err) {
          return `Error: ${(err as NodeJS.ErrnoException).message}`;
        }
      },
    }),

    edit_file: tool({
      description:
        'Edit a file by replacing exact text. old_string must match exactly including whitespace.',
      inputSchema: z.object({
        path: z.string().describe('File path to edit'),
        old_string: z.string().describe('Exact text to find and replace'),
        new_string: z.string().describe('Replacement text'),
        replace_all: z
          .boolean()
          .optional()
          .describe('Replace all occurrences (default: replace first only)'),
      }),
      execute: async (input) => {
        const { path, replace_all } = input;
        const old_string = decodeHtmlEntities(input.old_string);
        const new_string = decodeHtmlEntities(input.new_string);
        const filePath = resolve(workdir, path);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          if (!content.includes(old_string)) {
            return `Error: old_string not found in ${path}. Verify the text matches exactly (including whitespace).`;
          }
          const updated = replace_all
            ? content.split(old_string).join(new_string)
            : content.replace(old_string, new_string);
          await fs.writeFile(filePath, updated, 'utf-8');
          const count = replace_all ? content.split(old_string).length - 1 : 1;
          return `Edited ${relative(workdir, filePath)}: replaced ${count} occurrence(s)`;
        } catch (err) {
          return `Error: ${(err as NodeJS.ErrnoException).message}`;
        }
      },
    }),

    bash: tool({
      description:
        'Execute a shell command in the working directory. Use for git, npm, running tests, build commands, etc.',
      inputSchema: z.object({
        command: z.string().describe('Shell command to execute'),
        timeout: z
          .number()
          .optional()
          .describe('Timeout in milliseconds (default: 30000)'),
      }),
      execute: async (input) => {
        const { command, timeout = 30_000 } = input;
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: workdir,
            timeout,
            maxBuffer: 10 * 1024 * 1024,
          });
          const out = [stdout, stderr].filter(Boolean).join('\n').trim();
          return out || '(no output)';
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message: string };
          const out = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim();
          return `Error:\n${out}`;
        }
      },
    }),

    glob: tool({
      description: 'Find files matching a glob pattern.',
      inputSchema: z.object({
        pattern: z
          .string()
          .describe('Glob pattern (e.g., "**/*.ts", "src/**/*.{js,ts}")'),
        cwd: z
          .string()
          .optional()
          .describe('Directory to search in (default: workdir)'),
      }),
      execute: async (input) => {
        const { pattern, cwd } = input;
        try {
          const searchDir = cwd ? resolve(workdir, cwd) : workdir;
          const files = await fg(pattern, {
            cwd: searchDir,
            dot: false,
            ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
          });
          files.sort();
          if (files.length === 0) return 'No files found';
          return files.slice(0, 250).join('\n');
        } catch (err) {
          return `Error: ${(err as Error).message}`;
        }
      },
    }),

    grep: tool({
      description:
        'Search for a regex pattern across files. Returns matching lines with file paths and line numbers.',
      inputSchema: z.object({
        pattern: z.string().describe('Regular expression pattern'),
        path: z
          .string()
          .optional()
          .describe('File or directory to search (default: workdir)'),
        glob: z.string().optional().describe('File filter pattern (e.g., "*.ts")'),
        case_insensitive: z.boolean().optional().describe('Case insensitive'),
        context: z
          .number()
          .optional()
          .describe('Lines of context around each match'),
      }),
      execute: async (input) => {
        const { pattern, path: searchPath, glob: globFilter, case_insensitive, context } = input;
        const target = searchPath ? resolve(workdir, searchPath) : workdir;
        const flags = `-r${case_insensitive ? 'i' : ''}n`;
        const ctxFlag = context ? ` -C ${context}` : '';
        const includeFlag = globFilter ? ` --include="${globFilter}"` : '';
        const safePattern = pattern.replace(/"/g, '\\"');
        const cmd = `grep ${flags}${ctxFlag}${includeFlag} -E "${safePattern}" "${target}" 2>/dev/null`;

        try {
          const { stdout } = await execAsync(cmd, { cwd: workdir, timeout: 15_000 });
          const lines = stdout.trim().split('\n').filter(Boolean);
          if (lines.length === 0) return 'No matches found';
          return lines.slice(0, 200).join('\n');
        } catch (err) {
          const e = err as { code?: number; message: string };
          if (e.code === 1) return 'No matches found'; // grep exits 1 on no match
          return `Error: ${e.message}`;
        }
      },
    }),

    todo_write: tool({
      description:
        'Create or update a todo list to track multi-step task progress. Use for tasks with 3+ distinct steps.',
      inputSchema: z.object({
        todos: z.array(
          z.object({
            id: z.string().describe('Unique todo identifier'),
            title: z.string().describe('Task description'),
            status: z
              .enum(['pending', 'in_progress', 'completed'])
              .describe('Current status'),
          }),
        ),
      }),
      execute: async (input) => {
        todoTracker.parseTodoWrite({ todos: input.todos });
        return `Updated ${input.todos.length} todo(s)`;
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Full tool set including spawn_subagent
// ---------------------------------------------------------------------------

export function createTools(
  workdir: string,
  todoTracker: TodoTracker,
  provider: string,
  customAgents: CustomAgentDef[] = [],
) {
  const base = createBaseTools(workdir, todoTracker);

  // Merge built-in and custom agent definitions
  const allAgents: Record<string, SubagentDef> = { ...SUBAGENT_DEFS };
  for (const ca of customAgents) {
    allAgents[ca.name] = {
      description: ca.description,
      systemPrompt: ca.systemPrompt,
      tools: ca.tools,
      model: ca.model,
    };
  }
  const agentList = Object.entries(allAgents)
    .map(([n, d]) => `- ${n}: ${d.description}`)
    .join('\n');

  const spawn_subagent = tool({
    description: `Spawn a specialized subagent for a focused subtask. The subagent runs in isolation and returns its final answer.\n\nAvailable subagents:\n${agentList}`,
    inputSchema: z.object({
      name: z.string().describe(`Subagent name. Available: ${Object.keys(allAgents).join(', ')}`),
      prompt: z
        .string()
        .describe(
          'Detailed task description including relevant file paths and context',
        ),
    }),
    execute: async (input) => {
      const { name, prompt } = input;
      const def = allAgents[name];
      if (!def) return `Unknown subagent: ${name}. Available: ${Object.keys(allAgents).join(', ')}`;

      const subTodo = new TodoTracker();
      const allBase = createBaseTools(workdir, subTodo);
      // Build restricted tool set for subagent
      type BaseKey = keyof typeof allBase;
      const subTools = Object.fromEntries(
        def.tools
          .filter((t): t is BaseKey => t in allBase)
          .map((t) => [t, allBase[t]]),
      ) as Partial<typeof allBase>;

      try {
        const { text } = await generateText({
          model: getProvider(provider, def.model),
          system: def.systemPrompt,
          messages: [{ role: 'user', content: prompt }],
          tools: subTools,
          stopWhen: stepCountIs(20),
        });
        return text || '(subagent produced no text output)';
      } catch (err) {
        return `Subagent error: ${(err as Error).message}`;
      }
    },
  });

  return { ...base, spawn_subagent };
}

// Imported here to avoid a separate import in the execute closure above
import { stepCountIs } from 'ai';
