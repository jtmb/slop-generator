# =============================================================================
# slop-orchestrator — Single-stage runtime image
# =============================================================================
FROM node:22-slim

# Install runtime dependencies: tini for PID 1 signal handling
RUN apt-get update && apt-get install -y ca-certificates tini && \
    rm -rf /var/lib/apt/lists/*

# Use the built-in node user (uid 1000)
USER node

WORKDIR /app

# Copy dependency files and install
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node config/ ./config/

# Environment defaults
ENV NODE_ENV=production
ENV ORCHESTRATOR_PORT=3444

# Health check — verifies HTTP server is responding
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=5s \
    CMD node -e "require('http').get('http://localhost:3444/health',r=>{process.exit(r.statusCode===200?0:1)}).end()"

ENTRYPOINT ["tini", "--"]
CMD ["node", "scripts/orchestrator.js"]
