# TODO

## Feature/Fix: AI Coding Agent - Full Implementation

### Project Setup
- [x] Create package.json
- [x] Create tsconfig.json
- [x] Create .env.example

### Core Types
- [x] Create src/types.ts with all shared types

### Agent Layer
- [x] Create src/agent/todos.ts - TodoTracker class
- [x] Create src/agent/skills.ts - SkillsLoader class
- [x] Create src/agent/subagents.ts - Subagent definitions
- [x] Create src/agent/loop.ts - Core agent loop using Claude Agent SDK
- [x] Create src/agent/index.ts - AgentOrchestrator class

### Providers Layer
- [x] Create src/providers/index.ts - Multi-provider Vercel AI SDK setup

### Server Layer
- [x] Create src/server/api.ts - API route handlers
- [x] Create src/server/index.ts - Express + WebSocket server

### UI
- [x] Create src/ui/index.html - Self-contained web UI

### CLI Entry Point
- [x] Create src/cli.ts - Commander.js CLI

### Configuration Files
- [x] Create .claude/settings.json
- [x] Create .claude/agents/code-reviewer.md
- [x] Create .claude/agents/test-runner.md
- [x] Create .claude/agents/file-explorer.md
- [x] Create skills/debugging.md
- [x] Create skills/refactoring.md

### Verification
- [x] Run npm install
- [x] Run npx tsc --noEmit and fix any TypeScript errors

## Review Fixes
- [x] Fix: Remove unused TodoTracker import in agent/index.ts
- [x] Fix: Remove duplicate if/else in loop.ts tool_call handling
- [x] Fix: Remove duplicate done event in server/api.ts finally block
- [x] Fix: Pass resumeSessionId properly to SDK in loop.ts
- [x] Fix: Add resumeSessionId to AgentLoopOptions type
