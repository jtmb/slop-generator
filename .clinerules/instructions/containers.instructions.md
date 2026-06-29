# Container Conventions

## Multi-Stage Builds — Mandatory

Every container image MUST use multi-stage builds. Build dependencies stay in the builder stage; the final image contains only runtime artifacts.

```dockerfile
# Builder stage — compiles, bundles, generates
FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /app ./cmd/server

# Runtime stage — minimal, no build tools
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /app /app
USER appuser
ENTRYPOINT ["/app"]
```

- **Builder stage** has compilers, package managers, dev headers
- **Runtime stage** has only the binary and runtime deps (ca-certificates, tzdata)
- Use `--from=builder` to copy artifacts across stages
- `docker build --target builder` for debugging without bloating the final image

## Non-Root User — Mandatory

Never run containers as root in production. Create a dedicated user.

```dockerfile
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
```

- Use `-S` (system user, no login shell) — not a human account
- The `USER` directive must come AFTER any commands that need root (package installs, file copies to system dirs)
- Test with `docker run --rm --user nobody <image>` — if it works, you're root-free
- Kubernetes: set `securityContext.runAsNonRoot: true` and `runAsUser: 1000`

## Layer Ordering for Cache Hits

Order `COPY` and `RUN` commands from least-frequently-changing to most-frequently-changing.

```dockerfile
# 1. Dependencies first (changes rarely)
COPY package.json package-lock.json ./
RUN npm ci --production

# 2. Source code last (changes every commit)
COPY . .
```

- Package manager files (`package.json`, `go.mod`, `requirements.txt`, `Cargo.toml`) go BEFORE source
- Docker caches layers — if a layer changes, all subsequent layers rebuild
- Put expensive operations (compilation, downloads) early, trivial operations (file copies) late
- Combine shell commands with `&&` to avoid unnecessary layers:

```dockerfile
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*
```

## .dockerignore — Mandatory

Every project with containers MUST have a `.dockerignore`. It prevents leaking secrets, bloating context, and invalidating cache.

```dockerignore
# Secrets — never in the build context
.env
.env.*
*.key
*.pem
secrets/

# Version control
.git
.gitignore
.gitattributes

# Dependencies (installed inside the build)
node_modules/
vendor/
__pycache__/

# Build artifacts
dist/
build/
target/

# Docs & config (non-runtime)
*.md
```
