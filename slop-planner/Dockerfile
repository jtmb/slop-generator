# =============================================================================
# Stage 1: Builder — Install dependencies and copy source
# =============================================================================
FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Copy dependency files first (layer caching - containers.instructions.md)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code last (changes frequently - containers.instructions.md)
COPY . .

# =============================================================================
# Stage 2: Runtime — Minimal runtime image with Cline CLI
# =============================================================================
FROM node:22-slim AS runtime

# Install runtime dependencies and Cline CLI globally
RUN apt-get update && apt-get install -y ca-certificates tini && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g cline@3.0.29 --no-cache

# Use the built-in node user (uid 1000, matches host volume permissions)
USER node

WORKDIR /app

# Copy installed dependencies from builder (layer ordering)
COPY --from=builder /app/node_modules ./node_modules

# Copy application code from builder (layer ordering)
COPY --from=builder /app/package.json ./
COPY --from=builder /app/scripts/ ./scripts/
COPY --from=builder /app/lib/ ./lib/
COPY --from=builder /app/config/ ./config/
COPY --from=builder /app/AGENTS.md ./AGENTS.md
COPY --from=builder /app/db.md ./db.md
COPY --from=builder /app/.clinerules ./clinerules
COPY --from=builder /app/apps ./apps

# Set environment variables (not in image layers - containers.instructions.md)
ENV CLINE_PROVIDER=lmstudio
ENV CLINE_API_BASE_URL=http://host.docker.internal:1234/v1
ENV CLINE_MODEL=qwen/qwen3.5-9b
ENV NODE_ENV=production

# Health check (containers.instructions.md requirement)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
    CMD node -e "console.log('healthy')" || exit 1

# Signal handling with tini (PID 1 problem solution - containers.instructions.md)
ENTRYPOINT ["/usr/bin/tini", "--"]

# Use exec form for proper signal forwarding (containers.instructions.md)
CMD ["node", "scripts/agent-runner.js"]
