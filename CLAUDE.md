# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (run without building)
npx tsx src/cli.ts "your prompt here"   # one-shot
npx tsx src/cli.ts                      # interactive REPL (Ink UI)
npx tsx src/cli.ts --web --port 3000    # web UI

# Build
npm run build    # tsc → dist/

# After building
npm start        # node dist/cli.js
```

**Common CLI flags:**
- `--provider <name>` — `anthropic` (default) | `openai` | `google` | `xai`
- `--model <model>` — overrides provider default
- `--max-turns <n>` — agent loop steps (default 50)
- `--budget <usd>` — cost ceiling (default $5.00)
- `--permission-mode <mode>` — `default` | `acceptEdits` | `bypassPermissions` | `plan`
- `--resume <sessionId>` — replay a previous session's conversation history
- `--list-providers` — print all supported providers/models
- `-v` / `--verbose` — show tool result output

**Environment variables** (`.env` file):
- `ANTHROPIC_API_KEY` — required for default provider
- `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY`
- `DEFAULT_PROVIDER`, `DEFAULT_MODEL`

## Architecture

This is a multi-provider AI coding agent built on the **Vercel AI SDK** (`ai` package). There is no test suite.

### Request flow

```
cli.ts (Commander CLI)
  └── AgentOrchestrator (src/agent/index.ts)
        ├── SkillsLoader — loads ./skills/*.md, injects summaries into system prompt
        ├── buildSystemPrompt — includes workdir, git status, package.json metadata
        └── runAgentLoop (src/agent/loop.ts)
              ├── getProvider() → Vercel AI SDK LanguageModel
              ├── createTools() → tool definitions (read_file, write_file, edit_file, bash, glob, grep, todo_write, spawn_subagent)
              ├── streamText() with stopWhen: stepCountIs(maxTurns)
              └── yields StreamEvent async generator → back to CLI for display
```

### Key files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI entry point, Commander flags, Ink REPL render, stream event display |
| `src/agent/index.ts` | `AgentOrchestrator` — session management, system prompt construction, skills integration |
| `src/agent/loop.ts` | Core agent loop using `streamText` + `fullStream`; token usage accumulation |
| `src/agent/tools.ts` | All tool definitions; `createBaseTools` (safe subset) and `createTools` (adds `spawn_subagent`) |
| `src/agent/todos.ts` | `TodoTracker` — EventEmitter that tracks todo state; emits `change` events consumed by loop |
| `src/agent/skills.ts` | `SkillsLoader` — reads `./skills/*.md` with YAML frontmatter at startup |
| `src/providers/index.ts` | `getProvider()` maps provider+model → Vercel AI SDK `LanguageModel`; `SUPPORTED_PROVIDERS` registry |
| `src/server/index.ts` | Express + WebSocket server for the `--web` mode |
| `src/server/api.ts` | REST + WS handlers (`/api/chat`, `/api/stream/:id`, `/api/todos`, `/api/resume`) |
| `src/ui/App.tsx` | Ink-based interactive REPL (terminal React) |
| `src/types.ts` | All shared TypeScript types (`StreamEvent`, `AgentOptions`, `TodoItem`, etc.) |

### Subagents

`spawn_subagent` tool runs a focused sub-call via `generateText` (non-streaming) with a restricted tool set. Available subagents are defined in `SUBAGENT_DEFS` in `src/agent/tools.ts`: `code-reviewer`, `test-runner`, `file-explorer`, `security-scanner`, `doc-writer`. Each uses a fixed model (haiku/sonnet/opus).

### Skills

Skills are `.md` files in `./skills/` with YAML frontmatter (`name`, `description`, `when_to_use`). Only frontmatter is injected into every system prompt; full content is available via `SkillsLoader.getSkillContent()`. Add new skills by dropping `.md` files in `./skills/`.

### StreamEvent types

The agent loop yields typed events consumed by the CLI renderer:
`text` | `tool_call` | `tool_result` | `todo_update` | `token_usage` | `subagent` | `done` | `error`

### Module system

ESM (`"type": "module"`). All imports must use `.js` extensions (even for `.ts` source files). `tsconfig.json` uses `"moduleResolution": "bundler"`.
