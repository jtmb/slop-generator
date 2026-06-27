# =============================================================================
# Slop API — Standalone microservice with its own data store
# Single-stage: only needs Node.js, openssl (TLS certs), and express
# =============================================================================
FROM node:22-slim

# Install runtime dependencies: openssl for self-signed TLS certs, tini for PID 1
RUN apt-get update && apt-get install -y ca-certificates tini openssl && \
    rm -rf /var/lib/apt/lists/*

# Use the built-in node user (uid 1000, matches host volume permissions)
USER node

WORKDIR /app

# Copy dependency files first (layer caching - containers.instructions.md)
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code (changes frequently)
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node config/ ./config/
COPY --chown=node:node data/ ./data/

ENV NODE_ENV=production

# API server port (HTTPS, self-signed cert via openssl at startup)
EXPOSE 3443

# Health check (containers.instructions.md requirement)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
    CMD node -e "require('https').request({host:'localhost',port:3443,path:'/health',rejectUnauthorized:false},r=>{process.exit(r.statusCode===200?0:1)}).end()"

# Signal handling with tini (PID 1 problem solution - containers.instructions.md)
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["node", "scripts/api-server.js"]
