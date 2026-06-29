/**
 * Tool definitions for the AI Coding Agent using Vercel AI SDK v6.
 * These implement the same tool surface as Claude Code's built-in tools.
 */
import { tool, generateText } from 'ai';
import { z } from 'zod';
import { promises as fs } from 'fs';
import { resolve, relative, dirname, join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import fg from 'fast-glob';
import { TodoTracker } from './todos.js';
import { getProvider, resolveModelTier } from '../providers/index.js';
import type { CustomAgentDef, PermissionMode } from '../types.js';
import type { MemoryManager } from './memory.js';
import type { NotepadManager } from './notepad.js';
import { HandoffManager } from './handoffs.js';
import { checkPermission } from './permissions.js';
import { chromium } from 'playwright';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Subagent definitions
// ---------------------------------------------------------------------------

interface SubagentDef {
  description: string;
  systemPrompt: string;
  tools: string[];
  /** Model tier key ('opus' | 'sonnet' | 'haiku') resolved per-provider at runtime */
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
    model: 'sonnet',
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
    model: 'sonnet',
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
    model: 'haiku',
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
    model: 'opus',
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
    model: 'sonnet',
  },
  executor: {
    description: 'Focused task executor — reads, writes, edits files and runs bash to implement changes',
    model: 'sonnet',
    tools: ['read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep', 'todo_write'],
    systemPrompt: `You are a focused executor agent. Your job is to implement tasks directly and efficiently. Read relevant files first, then make targeted changes. Run bash commands to verify your work. Mark todos as you complete steps. Be precise — do exactly what is asked, no more.`,
  },
  debugger: {
    description: 'Root-cause analysis — isolates bugs, analyzes stack traces, fixes regressions',
    model: 'sonnet',
    tools: ['read_file', 'edit_file', 'bash', 'glob', 'grep'],
    systemPrompt: `You are a debugging specialist. Analyze errors methodically: read the stack trace, find the root cause in code, identify the minimal fix. Check for regressions. Explain what caused the bug and what the fix does.`,
  },
  designer: {
    description: 'UI/UX implementation — builds React/HTML/CSS components with strong visual instincts',
    model: 'sonnet',
    tools: ['read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep'],
    systemPrompt: `You are a UI/UX designer-developer. Build visually polished, accessible components. Follow existing design patterns in the codebase. Prioritize user experience and clean code.`,
  },
  planner: {
    description: 'Strategic planning — analyzes requirements, produces actionable task breakdowns',
    model: 'opus',
    tools: ['read_file', 'glob', 'grep'],
    systemPrompt: `You are a strategic planning agent. Analyze the codebase and requirements thoroughly. Produce clear, actionable implementation plans with ordered steps, file-level specifics, and identified risks. Do not implement — only plan.`,
  },
  architect: {
    description: 'Architecture advisor — evaluates system design, identifies trade-offs',
    model: 'opus',
    tools: ['read_file', 'glob', 'grep'],
    systemPrompt: `You are a software architect. Evaluate designs for scalability, maintainability, and correctness. Identify architectural risks, propose alternatives, and verify that implementations match their intended design.`,
  },
  verifier: {
    description: 'Verification specialist — checks that work meets requirements, runs tests',
    model: 'sonnet',
    tools: ['read_file', 'bash', 'glob', 'grep'],
    systemPrompt: `You are a verification agent. Your job is to prove that work is complete and correct. Run tests, check outputs, verify file changes match requirements. Report pass/fail with evidence. Be skeptical — find gaps.`,
  },
  'test-engineer': {
    description: 'Test strategy and implementation — writes integration/e2e tests, fixes flaky tests',
    model: 'sonnet',
    tools: ['read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep'],
    systemPrompt: `You are a test engineering specialist. Write thorough tests that catch real bugs. Prefer integration tests over unit tests. Fix flaky tests by finding root causes. Ensure tests are readable and maintainable.`,
  },
  writer: {
    description: 'Technical documentation — writes README, API docs, inline comments',
    model: 'haiku',
    tools: ['read_file', 'write_file', 'edit_file', 'glob', 'grep'],
    systemPrompt: `You are a technical writer. Produce clear, accurate documentation. Read the code before writing about it. Use examples. Write for developers who need to use or maintain this code.`,
  },
  'browser-qa': {
    description: 'Visual QA and DOM inspection — opens pages, checks layout, validates text',
    systemPrompt: `You are an expert QA Engineer. Use the browser_inspect tool to load the local development server (usually http://localhost:3000) and verify that the UI renders correctly. Check for missing elements, layout issues (from visible text context), and errors. Return a detailed bug report or confirmation of success.`,
    tools: ['browser_inspect', 'bash', 'read_file'],
    model: 'gpt-4o',
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

/**
 * Normalizes double-encoded escape sequences that can occur when an LLM
 * emits double-escaped JSON in tool call arguments.
 *
 * Only activates when the string has no real newlines but contains literal
 * backslash-n/t/r sequences — the fingerprint of double encoding.
 *
 * Does NOT modify strings that already contain real newlines (i.e., where
 * JSON.parse already decoded correctly).
 */
function normalizeEscapeSequences(str: string): string {
  const hasRealNewline = str.includes('\n');
  const hasLiteralEscape = /\\[ntr]/.test(str);

  if (!hasRealNewline && hasLiteralEscape) {
    return str
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r');
  }
  return str;
}

// ---------------------------------------------------------------------------
// Base tools (no spawn_subagent — safe to use inside subagent contexts)
// ---------------------------------------------------------------------------

export function createBaseTools(
  workdir: string,
  todoTracker: TodoTracker,
  memoryManager?: MemoryManager,
  notepadManager?: NotepadManager,
  handoffManager?: HandoffManager,
  permissionMode: PermissionMode = 'acceptEdits',
) {
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
        const perm = checkPermission('write_file', permissionMode);
        if (!perm.allowed) return `Blocked: ${perm.reason}`;
        const { path } = input;
        const content = normalizeEscapeSequences(decodeHtmlEntities(input.content));
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
        const perm = checkPermission('edit_file', permissionMode);
        if (!perm.allowed) return `Blocked: ${perm.reason}`;
        const { path, replace_all } = input;
        const old_string = normalizeEscapeSequences(decodeHtmlEntities(input.old_string));
        const new_string = normalizeEscapeSequences(decodeHtmlEntities(input.new_string));
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
        const perm = checkPermission('bash', permissionMode);
        if (!perm.allowed) return `Blocked: ${perm.reason}`;
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

    get_skill: tool({
      description: 'Read the full content of a named skill. Use when you need detailed instructions for a specialized workflow.',
      inputSchema: z.object({ name: z.string().describe('Skill name to load') }),
      execute: async (input) => {
        const skillsDir = join(workdir, 'skills');
        try {
          const files = await fs.readdir(skillsDir);
          const match = files.find(f => f.replace('.md', '').toLowerCase() === input.name.toLowerCase());
          if (!match) return `Skill not found: ${input.name}. Available: ${files.filter(f => f.endsWith('.md')).map(f => f.replace('.md', '')).join(', ')}`;
          return await fs.readFile(join(skillsDir, match), 'utf-8');
        } catch { return 'Skills directory not found'; }
      },
    }),

    memory_write: tool({
      description: 'Save a memory entry (user, feedback, project, or reference) for future sessions.',
      inputSchema: z.object({
        name: z.string().describe('Short name/title for the memory'),
        description: z.string().describe('One-line description of what this memory contains'),
        type: z.enum(['user', 'feedback', 'project', 'reference']).describe('Memory type'),
        body: z.string().describe('Full memory content'),
      }),
      execute: async (input) => {
        if (!memoryManager) return 'Memory manager not available';
        await memoryManager.write(input);
        return `Memory saved: ${input.name}`;
      },
    }),

    memory_list: tool({
      description: 'List all saved memory entries.',
      inputSchema: z.object({}),
      execute: async () => {
        if (!memoryManager) return 'Memory manager not available';
        const entries = await memoryManager.list();
        if (entries.length === 0) return 'No memories saved yet.';
        return entries.map((e) => `[${e.type}] ${e.name}: ${e.description}`).join('\n');
      },
    }),

    memory_search: tool({
      description: 'Search memory entries by keyword.',
      inputSchema: z.object({
        query: z.string().describe('Search query (case-insensitive keyword match)'),
      }),
      execute: async (input) => {
        if (!memoryManager) return 'Memory manager not available';
        const results = await memoryManager.search(input.query);
        if (results.length === 0) return 'No matching memories found.';
        return results.map((e) => `[${e.type}] ${e.name}\n${e.body}`).join('\n\n');
      },
    }),

    notepad_read: tool({
      description: 'Read the current notepad content.',
      inputSchema: z.object({}),
      execute: async () => {
        if (!notepadManager) return 'Notepad manager not available';
        const content = await notepadManager.read();
        return content || '(notepad is empty)';
      },
    }),

    notepad_write: tool({
      description: 'Write to the notepad (replace or append).',
      inputSchema: z.object({
        content: z.string().describe('Content to write'),
        mode: z.enum(['replace', 'append']).describe('Whether to replace or append to existing content'),
      }),
      execute: async (input) => {
        if (!notepadManager) return 'Notepad manager not available';
        await notepadManager.write(input.content, input.mode);
        return `Notepad updated (${input.mode})`;
      },
    }),

    handoff_write: tool({
      description: 'Write a stage handoff document capturing decisions, rejections, risks, and remaining work.',
      inputSchema: z.object({
        from_stage: z.string(),
        to_stage: z.string(),
        decided: z.array(z.string()).describe('Key decisions made'),
        rejected: z.array(z.string()).describe('Alternatives rejected and why'),
        risks: z.array(z.string()).describe('Identified risks for next stage'),
        files: z.array(z.string()).describe('Key files created/modified'),
        remaining: z.array(z.string()).describe('Items left for next stage'),
      }),
      execute: async (input) => {
        if (!handoffManager) return 'Handoff manager not available';
        await handoffManager.write({
          fromStage: input.from_stage,
          toStage: input.to_stage,
          decided: input.decided,
          rejected: input.rejected,
          risks: input.risks,
          files: input.files,
          remaining: input.remaining,
        });
        return `Handoff written: ${input.from_stage} → ${input.to_stage}`;
      },
    }),

    handoff_read: tool({
      description: 'Read handoff documents from previous stages.',
      inputSchema: z.object({
        from_stage: z.string().optional().describe('Source stage (omit to read all)'),
        to_stage: z.string().optional().describe('Target stage (omit to read all)'),
      }),
      execute: async (input) => {
        if (!handoffManager) return 'Handoff manager not available';
        if (input.from_stage && input.to_stage) {
          return await handoffManager.read(input.from_stage, input.to_stage) ?? 'No handoff found';
        }
        return await handoffManager.readAll() || 'No handoffs found';
      },
    }),

    browser_inspect: tool({
      description: 'Navigates to a URL in a headless browser, evaluates the DOM, takes a screenshot (saved locally), and returns the visible text. Use to visually QA local development apps.',
      inputSchema: z.object({
        url: z.string().describe('URL to inspect (e.g. http://localhost:3000)'),
      }),
      execute: async (input) => {
        try {
          const browser = await chromium.launch({ headless: true });
          const page = await browser.newPage();
          await page.goto(input.url, { waitUntil: 'networkidle' });
          const text = await page.evaluate(() => document.body.innerText);
          const screenshotPath = resolve(workdir, '.coder', `screenshot-${Date.now()}.png`);
          await fs.mkdir(dirname(screenshotPath), { recursive: true });
          await page.screenshot({ path: screenshotPath });
          await browser.close();
          return `Browser successfully inspected ${input.url}.\nScreenshot saved to ${screenshotPath}.\n\nVisible Content:\n${text.slice(0, 5000)}`;
        } catch (err) {
          return `Browser inspection failed: ${(err as Error).message}`;
        }
      }
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
  memoryManager?: MemoryManager,
  notepadManager?: NotepadManager,
  handoffManager?: HandoffManager,
  permissionMode: PermissionMode = 'acceptEdits',
) {
  const base = createBaseTools(workdir, todoTracker, memoryManager, notepadManager, handoffManager, permissionMode);

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
      prompt: z.string().describe('Detailed task description including relevant file paths and context'),
      verifyPrompt: z.string().optional().describe('Optional criteria for the subagent to internally verify via Ralph loop before returning'),
    }),
    execute: async (input) => {
      const { name, prompt, verifyPrompt } = input;
      const def = allAgents[name];
      if (!def) return `Unknown subagent: ${name}. Available: ${Object.keys(allAgents).join(', ')}`;

      const subTodo = new TodoTracker();
      const allBase = createBaseTools(workdir, subTodo, undefined, undefined, undefined, permissionMode);
      type BaseKey = keyof typeof allBase;
      const subTools = Object.fromEntries(
        def.tools.filter((t): t is BaseKey => t in allBase).map((t) => [t, allBase[t]])
      ) as Partial<typeof allBase>;

      try {
        let resultText = '';
        const maxIters = verifyPrompt ? 3 : 1;
        let lastVerdict = '';
        for (let i = 0; i < maxIters; i++) {
          const runPrompt = i === 0 ? prompt : `${prompt}\n\n[Verification Failed]\n${lastVerdict}\nPlease fix the issues and try again.`;
          const { text } = await generateText({
            model: getProvider(provider, resolveModelTier(provider, def.model)),
            system: def.systemPrompt,
            messages: [{ role: 'user', content: runPrompt }],
            tools: subTools,
            stopWhen: stepCountIs(20),
          });
          resultText = text || '';

          if (!verifyPrompt) break;
          const { text: verdict } = await generateText({
            model: getProvider(provider, resolveModelTier(provider, 'haiku')), // fast verification model
            system: `You are a verification agent. Assess whether a task was completed successfully. Respond with exactly one of:\n- "PASS: <reason>"\n- "FAIL: <reason>"`,
            messages: [{ role: 'user', content: `Verification Criteria: ${verifyPrompt}\n\nAgent Output:\n${resultText}` }]
          });
          if (/^PASS/i.test(verdict.trim())) {
            resultText += `\n\n[Internal Ralph Verdict: ${verdict.trim()}]`;
            break;
          }
          lastVerdict = verdict;
        }
        return resultText || '(subagent produced no text output)';
      } catch (err) {
        return `Subagent error: ${(err as Error).message}`;
      }
    },
  });

  const spawn_swarm = tool({
    description: `Spawn multiple specialized subagents concurrently for parallel task execution. Use this when a task can be broken into independent subtasks (e.g. frontend and backend). The swarm will run in parallel and return all their results combined.\n\nAvailable subagents:\n${agentList}`,
    inputSchema: z.object({
      tasks: z.array(z.object({
        name: z.string().describe(`Subagent name. Available: ${Object.keys(allAgents).join(', ')}`),
        prompt: z.string().describe('Detailed task description including relevant file paths and context for this specific subagent'),
        verifyPrompt: z.string().optional().describe('Optional criteria for the subagent to internally verify via Ralph loop before returning'),
      })).describe('Array of tasks to execute in parallel'),
    }),
    execute: async (input) => {
      const results = await Promise.all(input.tasks.map(async (task) => {
        const def = allAgents[task.name];
        if (!def) return `[${task.name}]: Unknown subagent. Available: ${Object.keys(allAgents).join(', ')}`;

        const subTodo = new TodoTracker();
        const allBase = createBaseTools(workdir, subTodo, undefined, undefined, undefined, permissionMode);
        type BaseKey = keyof typeof allBase;
        const subTools = Object.fromEntries(
          def.tools.filter((t): t is BaseKey => t in allBase).map((t) => [t, allBase[t]])
        ) as Partial<typeof allBase>;

        try {
          let resultText = '';
          const maxIters = task.verifyPrompt ? 3 : 1;
          let lastVerdict = '';
          
          for (let i = 0; i < maxIters; i++) {
            const runPrompt = i === 0 ? task.prompt : `${task.prompt}\n\n[Verification Failed]\n${lastVerdict}\nPlease fix the issues and try again.`;
            const { text } = await generateText({
              model: getProvider(provider, resolveModelTier(provider, def.model)),
              system: def.systemPrompt,
              messages: [{ role: 'user', content: runPrompt }],
              tools: subTools,
              stopWhen: stepCountIs(20),
            });
            resultText = text || '';

            if (!task.verifyPrompt) break;
            const { text: verdict } = await generateText({
              model: getProvider(provider, resolveModelTier(provider, 'haiku')),
              system: `You are a verification agent. Assess whether a task was completed successfully. Respond with exactly one of:\n- "PASS: <reason>"\n- "FAIL: <reason>"`,
              messages: [{ role: 'user', content: `Verification Criteria: ${task.verifyPrompt}\n\nAgent Output:\n${resultText}` }]
            });
            if (/^PASS/i.test(verdict.trim())) {
              resultText += `\n\n[Internal Ralph Verdict: ${verdict.trim()}]`;
              break;
            }
            lastVerdict = verdict;
          }
          return `--- Result from [${task.name}] ---\n${resultText || '(subagent produced no text output)'}`;
        } catch (err) {
          return `--- Error in [${task.name}] ---\n${(err as Error).message}`;
        }
      }));
      
      return results.join('\n\n');
    },
  });

  return { ...base, spawn_subagent, spawn_swarm };
}

// Imported here to avoid a separate import in the execute closure above
import { stepCountIs } from 'ai';
