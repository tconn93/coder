# Coder Agent — sandboxed Docker container for the multi-LLM coding agent.
#
# Build:
#   docker build -t coder-agent .
#
# Run (local mount):
#   docker run -p 3000:3000 \
#     -v $(pwd):/workspace:rw \
#     -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
#     -e CODER_API_KEY=change-me \
#     coder-agent
#
# Run (git clone):
#   docker run -p 3000:3000 \
#     -e CODER_REPO_URL=https://github.com/user/repo.git \
#     -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
#     -e CODER_API_KEY=change-me \
#     coder-agent
#
# Orchestrator API (default port 3000):
#   POST /api/chat          — start a new session
#   GET  /api/stream/:id    — SSE event stream
#   GET  /api/sessions      — list all sessions
#   POST /api/sessions/:id/cancel — cancel a running session
#   GET  /api/health        — health check
#   WS   /ws                — WebSocket for real-time events

FROM node:22-alpine AS builder

WORKDIR /app

# Install build deps
RUN apk add --no-cache git

# Copy package files and install.  Using `npm install` (not `npm ci`) because
# this package lives in a monorepo where the authoritative lock file is at the
# workspace root — a local package-lock.json may not exist.
COPY package.json tsconfig.json ./
RUN npm install --ignore-scripts

# Copy source and build
COPY src/ ./src/
COPY skills/ ./skills/
RUN npm run build

# ---------------------------------------------------------------------------
# Production stage
# ---------------------------------------------------------------------------
FROM node:22-alpine

RUN apk add --no-cache git bash curl openssh-client

# Create non-root user for sandboxing
RUN addgroup -S coder && adduser -S coder -G coder
RUN mkdir -p /workspace && chown -R coder:coder /workspace

WORKDIR /app

# Copy built artifacts and production deps
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/package.json ./
COPY skills/ ./skills/

# Copy entrypoint
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Environment
ENV NODE_ENV=production
ENV PORT=3000
ENV CODER_WORKDIR=/workspace
# Runtime config — provider API keys are injected by the node daemon at
# container creation time (e.g. DEFAULT_PROVIDER, XAI_API_KEY).
# The entrypoint validates the required key for DEFAULT_PROVIDER at startup.
ENV CODER_API_KEY=

# Expose both ports: 3000 (web UI) and 9001 (orchestrator API)
EXPOSE 3000
EXPOSE 9001

# Run as coder user for sandbox safety
USER coder

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/cli.js", "--server"]
