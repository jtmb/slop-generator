# Slop Planner — App Idea Generator

## Overview

The Slop Planner is an autonomous agent that generates unique app ideas using Cline CLI with LM Studio as the AI backend. It runs as a loop, each iteration producing one new app idea. Generated ideas are pushed to slop-api for centralized storage and consumption by slop-builder.

## Agent Loop (scripts/agent-runner.js)

```mermaid
flowchart TB
    S[Start Iteration] --> P1[Phase 1: Planning]
    P1 -->|cline reads AGENTS.md + db.md| W[Writes /app/plan.txt]
    W --> P2[Phase 2: Execution]
    P2 -->|cline reads plan.txt + db.md| C[Creates apps/name.md<br/>Updates db.md]
    C --> P3[Phase 3: API Push + Git Sync]
    P3 -->|POST /api/v1/ideas| A[slop-api]
    P3 -->|git-sync.js --once| G[Git Remote]
    A --> S
    G --> S
```

Each iteration has three phases:

**Phase 1: Planning**
- Calls `cline -P lmstudio` with the planning prompt
- cline reads AGENTS.md (its role instructions) and db.md (existing ideas)
- cline formulates a plan and writes it to /app/plan.txt
- Plan format: App Name, Category, Problem, Uniqueness, Features, Target Audience

**Phase 2: Execution**
- Calls `cline -P lmstudio` with the execution prompt
- cline reads /app/plan.txt and db.md
- cline creates the app idea file in apps/{name}.md
- cline updates db.md with the new entry

**Phase 3: API Push + Git Sync**
- `agent-runner.js` pushes the new idea to slop-api at POST /api/v1/ideas
- `agent-runner.js` spawns `git-sync.js --once` for git commit/push
- Initializes git repo on first run (`.gitignore` tracks only `apps/`)
- Commits any new or changed files
- Pushes to remote if `GIT_REPO_URL` is configured

## API Integration

The planner authenticates with slop-api using a shared `API_KEY`:
1. POST /api/v1/auth/token with the API_KEY to get a JWT
2. POST /api/v1/ideas with the JWT to push each new idea
3. API push is best-effort — git sync succeeds independently

## Configuration

- **config/settings.json**: max_iterations (default 50), timeout_ms (default 300000)
- **config/.env**: CLINE_API_BASE_URL, CLINE_MODEL, API_KEY, GIT_REPO_URL
- Environment variables override settings.json values

### Git Sync Variables

| Variable | Default | Purpose |
|---|---|---|
| `GIT_REPO_URL` | — | Remote URL with auth (e.g. `https://user:token@github.com/owner/repo.git`) |
| `GIT_BRANCH` | `main` | Branch to push to |
| `GIT_USER_NAME` | `Slop Generator` | Commit author name |
| `GIT_USER_EMAIL` | `slop-generator@localhost` | Commit author email |
| `GIT_SYNC_DB` | `false` | Set `true` to also track `db.md` |

## Generated Ideas

Each idea is a markdown file in apps/ following the template in slop-planner/AGENTS.md. The db.md file tracks all ideas with categories, status, and dates.

## Container

- **Base Image**: node:22-slim → multi-stage build
- **Runtime Dependencies**: tini, git, ca-certificates, cline@3.0.31
- **User**: node (uid 1000, non-root)
- **Health Check**: node -e "console.log('healthy')"
- **Entrypoint**: tini → node scripts/agent-runner.js
- **Ports**: None — planner is a worker, not a server
- **Network**: Internal Docker bridge (slop-net), calls slop-api over HTTPS

## Running

From the repo root (where `docker-compose.yml` lives):

```bash
docker compose up -d --build    # Build and start all services
docker compose ps               # Check status
docker logs slop-planner -f     # Watch planner progress
```
