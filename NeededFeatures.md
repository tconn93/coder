# Needed Features for AI Coding Agent (Ordered by Priority)

## Priority 1: MVP Features (v1.0)
- **CLI Interface**: Interactive command-line interface for developers to issue coding tasks (e.g., `coder \"fix bug in src/cli.ts\"`).
- **AI Integration**: Use Vercel AI SDK to power responses with tool calling support for LLMs like GPT-4o or Claude.
- **File Operations**: 
  - Read files with line numbers (`read_file`).
  - Write/overwrite files (`write_file`).
  - Precise edits via search-and-replace (`edit_file`).
- **Shell Execution**: Run bash commands for git, npm install/test/build, etc. (`bash`).
- **File Search**: Glob patterns (`glob`) and regex search across files (`grep`).
- **Task Tracking**: Todo lists for multi-step tasks (`todo_write`).
- **Context Awareness**: Track working directory, git status, project metadata.
- **Tool Calling**: Strict XML format for function calls with validation.

## Priority 2: Post-MVP Features (v1.1+)
- **Verification Loop**: Run tests/build after changes, iterate until passing.
- **Testing Integration**: Automatic test running, coverage analysis, fix suggestions (`test-runner` subagent).
- **Subagents**: Spawn specialized agents:
  | Subagent | Purpose |
  |----------|---------|
  | code-reviewer | Security, quality, performance audits |
  | debugging | Systematic bug hunting |
  | refactoring | Safe code improvements |
  | file-explorer | Codebase mapping |
  | security-scanner | Vulnerability detection |
  | doc-writer | Generate docs/README |
  | test-runner | Test execution &amp; analysis |
- **Git Workflow**: Auto-commit changes, PR creation, changelog generation.
- **Memory/Context**: Persistent conversation history across sessions.
- **Configurability**: Model selection, API keys, custom tools via config file.
- **Streaming UI**: Real-time response streaming in CLI.
- **Web UI**: Optional browser-based interface.
- **Plugin System**: Extend with custom tools/skills.

## Priority 3: Non-Functional Requirements
- **Policy Compliance**: Enforce core policies (no criminal assistance, safe refusals).
- **Error Handling**: Graceful failures, detailed logs.
- **Performance**: Efficient tool usage, timeouts, parallel calls.
- **Documentation**: Inline JSDoc, comprehensive README.

**Progress Tracking**: Use `todo_write` for implementation status.
