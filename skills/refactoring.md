---
name: refactoring
description: Safe code refactoring workflow for improving code quality without changing behavior
when_to_use: When the user wants to improve code quality, reduce complexity, or modernize code
---

# Refactoring Skill

## Core Principles

1. **Never change behavior** — only improve structure
2. **Work in small steps** — one refactoring at a time
3. **Tests as a safety net** — run tests after each change
4. **Understand before changing** — read all affected code first

## Workflow

### 1. Understand Current Code
- Read the code to understand its purpose
- Identify what tests exist
- Note all callers and usages

### 2. Identify Refactoring Opportunities
- Code smells: long functions, duplication, deep nesting
- Poor naming: unclear variables, functions, classes
- Structural issues: violation of SRP, tight coupling
- Modern alternatives: outdated patterns, deprecated APIs

### 3. Plan the Refactoring
- List specific changes to make
- Identify risks and dependencies
- Determine order of operations

### 4. Execute Safely
- Make one logical change at a time
- Run tests after each change
- Commit frequently with descriptive messages

### 5. Verify
- All tests still pass
- Code coverage maintained or improved
- No performance regression

## Common Refactoring Patterns

### Extract Function
```typescript
// Before
function processData(data) {
  // 50 lines of validation
  // 50 lines of transformation
  // 50 lines of output
}

// After
function processData(data) {
  const validated = validateData(data);
  const transformed = transformData(validated);
  return formatOutput(transformed);
}
```

### Remove Duplication (DRY)
- Extract common logic into shared utilities
- Use configuration over code duplication
- Create base classes or shared hooks

### Simplify Conditionals
```typescript
// Before
if (user !== null && user !== undefined && user.active === true) {

// After
if (user?.active) {
```

### Modernize Async Code
```typescript
// Before (callbacks)
fs.readFile(path, (err, data) => {
  if (err) throw err;
  // ...
});

// After (async/await)
const data = await fs.promises.readFile(path);
```

### TypeScript Improvements
- Add explicit return types to public functions
- Replace `any` with proper types
- Use readonly where applicable
- Add proper generics
