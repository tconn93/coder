#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Coder Agent — Docker Entrypoint
#
# Sets up the /workspace sandbox:
#   1. If CODER_REPO_URL is set, clones the repo into /workspace
#   2. If /workspace is empty and a volume is mounted, copies from CODER_REPO_PATH
#   3. Otherwise, uses /workspace as-is (presumed pre-populated by volume mount)
#
# After workspace setup, starts the agent server.
# ---------------------------------------------------------------------------

WORKSPACE="${CODER_WORKDIR:-/workspace}"
REPO_URL="${CODER_REPO_URL:-}"
REPO_BRANCH="${CODER_REPO_BRANCH:-main}"

echo "=== Coder Agent Sandbox ==="
echo "Workspace: $WORKSPACE"

# ---------------------------------------------------------------------------
# Workspace setup
# ---------------------------------------------------------------------------

if [ -n "$REPO_URL" ]; then
  echo "[entrypoint] Cloning repository: $REPO_URL (branch: $REPO_BRANCH)"
  if [ -d "$WORKSPACE/.git" ]; then
    echo "[entrypoint] Existing git repo found — pulling latest"
    cd "$WORKSPACE"
    git fetch origin "$REPO_BRANCH"
    git checkout "$REPO_BRANCH"
    git reset --hard "origin/$REPO_BRANCH"
  else
    rm -rf "$WORKSPACE"/*
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$WORKSPACE"
  fi
  echo "[entrypoint] Repository ready at $WORKSPACE"
elif [ -z "$(ls -A "$WORKSPACE" 2>/dev/null)" ]; then
  echo "[entrypoint] Workspace is empty — starting fresh"
else
  echo "[entrypoint] Using pre-populated workspace ($(find "$WORKSPACE" -maxdepth 1 -type f | wc -l) files)"
fi

# ---------------------------------------------------------------------------
# Show workspace info
# ---------------------------------------------------------------------------
echo "[entrypoint] Workspace contents:"
ls -la "$WORKSPACE" | head -20

if [ -f "$WORKSPACE/package.json" ]; then
  echo "[entrypoint] Found package.json — installing dependencies"
  cd "$WORKSPACE"
  npm install --no-audit --no-fund 2>&1 | tail -5 || echo "[entrypoint] npm install had warnings (non-fatal)"
  cd /app
fi

# ---------------------------------------------------------------------------
# Write agent config into workspace if not already present
# ---------------------------------------------------------------------------
if [ ! -f "$WORKSPACE/.coder/settings.json" ]; then
  mkdir -p "$WORKSPACE/.coder"
  cat > "$WORKSPACE/.coder/settings.json" << 'SETTINGS'
{
  "debugPrompt": false,
  "hooks": {}
}
SETTINGS
  echo "[entrypoint] Created default .coder/settings.json"
fi

# ---------------------------------------------------------------------------
# Validate required configuration
# ---------------------------------------------------------------------------
if [ -z "${CODER_API_KEY:-}" ]; then
  echo "[entrypoint] WARNING: CODER_API_KEY is not set — API will be unauthenticated!"
fi

PROVIDER="${DEFAULT_PROVIDER:-anthropic}"
case "$PROVIDER" in
  anthropic)      KEY_VAR="ANTHROPIC_API_KEY" ;;
  openai)         KEY_VAR="OPENAI_API_KEY" ;;
  google)         KEY_VAR="GOOGLE_GENERATIVE_AI_API_KEY" ;;
  xai)            KEY_VAR="XAI_API_KEY" ;;
  deepseek)       KEY_VAR="DEEPSEEK_API_KEY" ;;
  groq)           KEY_VAR="GROQ_API_KEY" ;;
  openrouter)     KEY_VAR="OPENROUTER_API_KEY" ;;
  azure-openai)   KEY_VAR="AZURE_OPENAI_API_KEY" ;;
  aws-bedrock)    KEY_VAR="AWS_ACCESS_KEY_ID" ;;
  *)              KEY_VAR="" ;;
esac

if [ -n "$KEY_VAR" ] && [ -z "${!KEY_VAR:-}" ]; then
  echo "[entrypoint] WARNING: $KEY_VAR is not set — default provider '$PROVIDER' may fail"
fi

echo "[entrypoint] Starting agent server on port ${PORT:-3000}"
echo "[entrypoint] Provider: $PROVIDER"
echo "[entrypoint] Auto-start: ${AUTO_START:-0}"
echo "========================================="

# ---------------------------------------------------------------------------
# Auto-start mode — if AUTO_START=1 and TASK is set, the agent server will
# pick these up and submit an initial chat request on startup.
# ---------------------------------------------------------------------------
export AUTO_START="${AUTO_START:-0}"
export TASK="${TASK:-}"

exec "$@"
