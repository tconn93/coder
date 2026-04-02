# Coder

[![npm version](https://img.shields.io/npm/v/coder?color=blue)](https://www.npmjs.com/package/coder)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://www.typescriptlang.org/)
[![Vercel AI SDK](https://img.shields.io/badge/Vercel%20AI%20SDK-latest-black?logo=vercel)](https://sdk.vercel.ai)

**AI Coding Agent** powered by [Vercel AI SDK](https://sdk.vercel.ai/docs/introduction). 

Coder is a multi-provider terminal agent for software development tasks. Edit files, run shell commands, spawn subagents, and more—all from natural language prompts.

## ✨ Features

- **Multi-Provider LLM Support**: Anthropic (default), OpenAI, Google Generative AI, xAI
- **Rich Terminal UI**: Interactive REPL powered by [Ink](https://github.com/vadimdemedes/ink) + React
- **Web UI Mode**: Browser-based chat with WebSocket streaming
- **Powerful Tools**: File read/write/edit, bash execution, glob/grep, todo tracking, memory/notepad
- **Subagents**: Specialized agents (e.g., debugger, code-reviewer, test-runner)
- **Skills System**: Load modular workflows from `./skills/*.md`
- **Cost & Safety Controls**: Budget caps, permission modes, max turns
- **Session Persistence**: Resume chats, handoffs between stages

## 🚀 Quick Start

1. **Install**:
   ```bash
   git clone <your-repo>.git  # Or download zip
   cd coder
   npm install
   ```

2. **Setup API Keys** (`.env`):
   ```bash
   ANTHROPIC_API_KEY=sk-your-key-here
   # Alternatives: OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, XAI_API_KEY
   ```

3. **Run**:
   ```bash
   # Interactive REPL (recommended)
   npm run dev
   # Or one-shot prompt
   npx tsx src/cli.ts \"Implement a new feature in src/cli.ts\"
   # Web UI
   npx tsx src/cli.ts --web --port 3000
   ```

## 📋 Commands

```bash
# Development (no build needed)
npx tsx src/cli.ts \"your prompt\"     # One-shot
npx tsx src/cli.ts                    # REPL UI
npx tsx src/cli.ts --web --port 3000  # Web UI

# Production
npm run build    # tsc → dist/
npm start        # node dist/cli.js
```

**Global Install** (after `npm run build`):
```bash
npm install -g .
npx coder \"your prompt\"
```

## ⚙️ CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--provider <name>` | Provider: `anthropic` \| `openai` \| `google` \| `xai` | `anthropic` |
| `--model <model>` | Model override (e.g., `claude-3-5-sonnet-20240620`) | Provider default |
| `--max-turns <n>` | Max agent loop steps | 50 |
| `--budget <usd>` | Max spend (USD) | 5.00 |
| `--permission-mode <mode>` | `default` \| `acceptEdits` \| `bypassPermissions` \| `plan` | `default` |
| `--resume <sessionId>` | Replay session history | - |
| `--list-providers` | List providers/models | - |
| `-v, --verbose` | Show raw tool outputs | - |

Full help: `npx tsx src/cli.ts --help`

## 🌐 Web UI

Launch with `--web --port 3000` (or custom port). Open `http://localhost:3000` for a chat interface with streaming responses, todo lists, and session management.

## 🔑 Environment Variables

`.env` file:

```
ANTHROPIC_API_KEY=sk-...  # Required for default
OPENAI_API_KEY=sk-...
GOOGLE_GENERATIVE_AI_API_KEY=...
XAI_API_KEY=...
DEFAULT_PROVIDER=anthropic
DEFAULT_MODEL=claude-3-opus-20240229
```

## 🏗️ Architecture

```
cli.ts (Commander + Ink)
  ↓
AgentOrchestrator (src/agent/index.ts)
  ├── SkillsLoader (./skills/*.md)
  ├── System Prompt (workdir + git + metadata)
  └── runAgentLoop (src/agent/loop.ts)
      ├── Vercel AI LanguageModel
      ├── Tools: file ops, bash, subagents
      └── StreamEvents: text, tools, todos, tokens...
```

**Key Components**:

| Path | Role |
|------|------|
| `src/cli.ts` | Entry point, flags, UI rendering |
| `src/agent/*` | Core agent loop, tools, todos, skills |
| `src/providers/*` | LLM provider registry |
| `src/server/*` | Express/WS for web mode |
| `src/ui/App.tsx` | Terminal React UI |

ESM modules, TypeScript, no tests (yet).

## 🤖 Subagents

Agent can `spawn_subagent` for focused tasks (non-streaming, restricted tools):

- `code-reviewer`: Security, quality, perf
- `test-runner`: Run/fix tests
- `file-explorer`: Codebase mapping
- `security-scanner`: Vulns, secrets
- `doc-writer`: README, docs
- `executor`: Implement changes
- `debugger`: Bug isolation/fixes
- `designer`: UI components
- `planner`: Task breakdowns
- `architect`: Design advice
- `verifier`: Requirements check
- `test-engineer`: Test suites
- `writer`: Tech docs

## 📚 Skills

`./skills/*.md` files with YAML frontmatter (name, description, when_to_use). Summaries injected into every prompt; full content on-demand.

Examples: `debugging.md`, `refactoring.md`. Add your own!

## 🛠️ Development & Contributing

- **Build**: `npm run build`
- **Dev**: `npm run dev`
- **Skills**: Add `./skills/my-skill.md`

See `CLAUDE.md`, `PLAN.md`, `TODO.md` for internals. PRs welcome!

## 📄 License

MIT License © 2024
