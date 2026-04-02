# Packaging the CLI

This document covers how to package, distribute, and install the `coder` CLI.

## How the CLI is exposed

`package.json` declares a `bin` entry:

```json
"bin": { "coder": "./dist/cli.js" }
```

This means any install method that processes `bin` (npm link, npm install -g, npx) will put `coder` on the user's PATH pointing to `dist/cli.js`.

The `dist/` directory is the compiled output of `npm run build` (TypeScript → ESNext via `tsc`).

---

## Option 1 — Local development link

Install the package globally from the local directory so `coder` is on your PATH without publishing:

```bash
npm run build
npm link
```

To unlink later:

```bash
npm unlink -g ai-coding-agent
```

---

## Option 2 — Publish to npm

### Prerequisites

- An npm account with publish rights
- The package name (`ai-coding-agent`) must be available, or update `name` in `package.json`

### Steps

1. Add a `files` field to `package.json` so only compiled output is included in the tarball:

   ```json
   "files": ["dist/", "src/ui/index.html"]
   ```

2. Bump the version:

   ```bash
   npm version patch   # or minor / major
   ```

3. Build and publish:

   ```bash
   npm run build
   npm publish
   ```

4. Users install it globally:

   ```bash
   npm install -g ai-coding-agent
   coder --help
   ```

### Scoped package (recommended)

To publish under an npm org scope:

```json
"name": "@your-org/coder"
```

```bash
npm publish --access public
npm install -g @your-org/coder
```

---

## Option 3 — Single-file executable with `pkg`

Bundle the app and its Node.js runtime into a standalone binary that requires no Node.js installation.

### Install pkg

```bash
npm install -g @yao-pkg/pkg   # actively maintained fork of vercel/pkg
```

### Add a pkg config to package.json

```json
"pkg": {
  "scripts": "dist/**/*.js",
  "assets": ["src/ui/index.html"],
  "targets": ["node22-linux-x64", "node22-macos-arm64", "node22-win-x64"],
  "outputPath": "release/"
}
```

### Build

```bash
npm run build
pkg .
```

Binaries will appear in `release/`:

```
release/coder-linux
release/coder-macos
release/coder-win.exe
```

### Limitations with pkg

- Native addons are not supported.
- The `ai` SDK and provider packages are pure JS, so they bundle cleanly.
- `dotenv` will still load a `.env` from the directory where the binary is run.
- Dynamic `import()` calls inside the code (e.g., the lazy `import('./server/index.js')`) need the `--public` flag or must be listed explicitly in `pkg.scripts`.

---

## Option 4 — Bundle with esbuild then ship

Use `esbuild` to produce a single-file `dist/bundle.js` (still requires Node.js but is a single file with no `node_modules`).

```bash
npm install -D esbuild
```

Add a build script:

```bash
esbuild src/cli.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --outfile=dist/bundle.js \
  --external:fsevents
```

Update `bin` in `package.json`:

```json
"bin": { "coder": "./dist/bundle.js" }
```

This is useful for distribution as a single file (e.g., via a GitHub release asset or a `curl | node` install script).

---

## Shebang and file permissions

`dist/cli.js` must start with the Node shebang so it is directly executable. Add this as the first line of `src/cli.ts`:

```typescript
#!/usr/bin/env node
```

After building, the shebang is preserved in `dist/cli.js`. `npm link` and `npm install -g` automatically set the executable bit. If you copy the file manually:

```bash
chmod +x dist/cli.js
```

---

## Environment variables

The CLI reads API keys from the environment or a `.env` file in the current working directory (loaded via `dotenv`). When distributing, document that users must set:

```
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...        # if using OpenAI provider
GOOGLE_GENERATIVE_AI_API_KEY=...  # if using Google provider
XAI_API_KEY=...           # if using xAI provider
```

These are never bundled — they must be set by the user at runtime.
