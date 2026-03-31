---
name: debugging
description: Systematic debugging workflow for tracking down bugs and errors
when_to_use: When the user reports a bug, error, unexpected behavior, or failing tests
---

# Debugging Skill

## Workflow

### 1. Reproduce the Issue
- Get the exact error message and stack trace
- Identify the minimal steps to reproduce
- Note environment details (OS, Node version, etc.)

### 2. Identify the Failing Component
- Trace the error back to its source file and line number
- Understand what the code is supposed to do vs what it does
- Check recent changes with `git log` and `git diff`

### 3. Check Recent Changes
```bash
git log --oneline -20
git diff HEAD~1
git blame <file>
```

### 4. Add Targeted Logging
- Add strategic console.log/debug statements
- Log input values and intermediate states
- Check edge cases (null, undefined, empty arrays)

### 5. Isolate Root Cause
- Binary search through the code to narrow down the issue
- Check function inputs and outputs
- Verify assumptions about external dependencies

### 6. Fix and Verify
- Make the minimal change to fix the issue
- Run the test suite to confirm no regressions
- Add a test case that would have caught this bug

## Common Bug Patterns

### TypeScript/JavaScript
- `undefined` vs `null` confusion
- Async/await not properly awaited
- Off-by-one errors in loops
- Mutating arrays/objects passed by reference
- Missing error handling in promises

### Node.js
- Missing environment variables
- Port already in use
- File path issues (relative vs absolute)
- Circular dependencies

### API Issues
- Wrong HTTP method or endpoint
- Missing or malformed headers
- Request body encoding issues
- Rate limiting
