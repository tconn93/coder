# AI Coding Agent

## UI
cli
also have options/flags that spins up a server on the localhost to access a web base UI to interact with the agent. 


## Agent Loop

Use the below site to determin how the agent loop will work.
https://platform.claude.com/docs/en/agent-sdk/agent-loop

## Models/LLM provider

Use Vercel AI SDK setup to use OpenAI, Google, Anthropic, and XAI models. 

## Task
Todo Lists

Copy page

Track and display todos using the Claude Agent SDK for organized task management
Todo tracking provides a structured way to manage tasks and display progress to users. The Claude Agent SDK includes built-in todo functionality that helps organize complex workflows and keep users informed about task progression.

Todo Lifecycle
Todos follow a predictable lifecycle:

Created as pending when tasks are identified
Activated to in_progress when work begins
Completed when the task finishes successfully
Removed when all tasks in a group are completed
When Todos Are Used
The SDK automatically creates todos for:

Complex multi-step tasks requiring 3 or more distinct actions
User-provided task lists when multiple items are mentioned
Non-trivial operations that benefit from progress tracking
Explicit requests when users ask for todo organization

## Tools

All filesystem tools needed to read and write code effectivly and execute commands in a sandbox env per below. Tools need to be ran in parallel. 

- permissions
    - https://platform.claude.com/docs/en/agent-sdk/permissions

## Context Engineering

https://docs.langchain.com/oss/python/deepagents/context-engineering


## Async subagents

Async subagents let a supervisor agent launch background tasks that return immediately, so the supervisor can continue interacting with the user while subagents work concurrently. The supervisor can check progress, send follow-up instructions, or cancel tasks at any point.
This builds on subagents, which run synchronously and block the supervisor until completion. Use async subagents when tasks are long-running, parallelizable, or need mid-flight steering.

https://platform.claude.com/docs/en/agent-sdk/subagents

## Skills
Skills provide on-demand capabilities. The agent reads frontmatter from each SKILL.md at startup, then loads full skill content only when it determines the skill is relevant. This reduces token usage while still providing specialized workflows:

## Sandboxes

Agents generate code, interact with filesystems, and run shell commands. Because we can’t predict what an agent might do, it’s important that its environment is isolated so it can’t access credentials, files, or the network. Sandboxes provide this isolation by creating a boundary between the agent’s execution environment and your host system.
In Deep Agents, sandboxes are backends that define the environment where the agent operates. Unlike other backends (State, Filesystem, Store) which only expose file operations, sandbox backends also give the agent an execute tool for running shell commands. When you configure a sandbox backend, the agent gets:
All standard filesystem tools (ls, read_file, write_file, edit_file, glob, grep)
The execute tool for running arbitrary shell commands in the sandbox
A secure boundary that protects your host system

## Stream 
- main agent
- tool calls
- subagents


## Tracking Token Usage

Track total token usage. 


 # Set your API key first
  cp .env.example .env
  # Edit .env with your ANTHROPIC_API_KEY

  # One-shot prompt (CLI)
  npx tsx src/cli.ts "Fix the failing tests in auth.ts"

  # Interactive REPL
  npx tsx src/cli.ts

  # Web UI (spins up server + opens browser)
  npx tsx src/cli.ts --web --port 3000

  # Different model/provider
  npx tsx src/cli.ts --provider openai --model gpt-4o "Review this code"

  # List all providers/models
  npx tsx src/cli.ts --list-providers

  # Resume a previous session
  npx tsx src/cli.ts --resume <sessionId>