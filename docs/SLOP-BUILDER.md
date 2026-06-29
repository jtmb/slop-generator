# Slop Builder — App Builder Agent

## Overview

The Slop Builder is an autonomous agent that consumes random app ideas from slop-api and builds full production applications. It uses Cline CLI with LM Studio as the AI backend, with a **JavaScript-side task manager** that orchestrates Cline calls one task at a time. Completed projects are uploaded to slop-api as tar.gz archives, then **immediately synced to GitHub** via the orchestrator's `/git-sync-projects` endpoint — turn-independent, no need to wait for batch boundaries.

---

## Agent Loop (scripts/agent-runner.js)

```mermaid
flowchart TB
    S[Start Iteration] --> R{Retry Check<br/>Failed >= threshold?}
    R -->|yes| RF[Fetch failed idea<br/>by slug]
    R -->|no| F[Phase 1: Fetch Random Idea]
    RF -->|idea fetched| RP{Project dir exists?}
    F -->|authenticate| A[slop-api]
    A -->|GET /random| D{Deduplicate<br/>via db.md}
    D -->|already built| F
    D -->|new idea| P[Phase 2: Deep Planning]
    RP -->|yes, with plan.md| RB[Resume Build<br/>from unchecked tasks]
    RP -->|no| P
    RB --> T[Phase 4: Test]
    P -->|cline writes plan.md| B[Phase 3: Build<br/>JS task loop]
    B -->|parseNextUncheckedTask| T1[Single-task Cline call]
    T1 -->|killHubDaemons, runCline| T2{Task done?}
    T2 -->|more unchecked| B
    T2 -->|all phases done| T
    T -->|pass| U[Phase 5: Upload<br/>tar.gz to /api/v1/projects]
    T -->|fail, retry < 3| T
    T -->|fail, exhausted| X[Write test-failures.txt]
    U --> GS[Phase 5b: Git Sync<br/>POST /git-sync-projects<br/>to orchestrator]
    GS -->|immediate, turn-independent| GH[(GitHub<br/>jtmb/app-ideas)]
    U --> D2[Phase 6: Update db.md]
    X --> D2
    D2 --> S
```

### Phase 0: Failed Project Retry
Before any fetch or planning, the builder checks `db.md` for failed projects. A project is "failed" if its status is `Built (push failed)`, `Built (push failed, tests failed)`, `Complete (tests failed)`, or `Tests Failed`.

When the number of failed projects reaches `BUILDER_MAX_FAILED_RETRIES` (default: 3), the builder stops fetching new ideas and instead retries the oldest failed project:

1. **Fetch idea by slug** from slop-api (`GET /api/v1/ideas/:slug`)
2. **If idea found**: Check if project directory exists. If `plan.md` still exists, resume from the first unchecked task. Re-build any incomplete phases, re-run tests, re-attempt upload.
3. **If idea NOT found in API**: The project's idea was deleted. `db.md` is updated with status `Removed (idea not found in API)` to prevent infinite retry loops — the failed count decreases and the builder can proceed with normal new-project builds.
4. **Update db.md** entry with the new status (existing entry is updated, not duplicated)

This creates a self-healing loop: when failures accumulate, the builder automatically focuses on fixing them instead of making more unfinished projects. When a failed project's idea no longer exists in the API, it's cleaned up gracefully.

Set `BUILDER_MAX_FAILED_RETRIES=0` in the environment to disable this behavior entirely.

Each iteration has six phases (after the retry check):

### Phase 1: Fetch Idea
- Authenticates with slop-api (JWT via API_KEY)
- GETs `/api/v1/ideas/random`
- **JWT re-auth on expiry**: `fetchRandomIdea()` catches 401/403 responses, clears the cached `jwtToken`, re-authenticates, and retries once.
- Checks own `db.md` for duplicates — skips already-built projects
- Retries up to 10 times if all fetched ideas are duplicates

### Phase 2: Deep Planning
- Calls `runCline(prompt)` with a planning prompt that includes inline context
- Cline researches and selects the best framework stack for the idea
- Cline creates `/app/projects/{slug}/plan.md` with all phases and checkboxes
- Plan includes: Framework Decision, project structure, and phased checklists

### Phase 3: Build (JS Task Loop)
The agent-runner manages build progress in JavaScript, not inside Cline:

1. **`parseNextUncheckedTask(planPath)`** — reads `plan.md`, finds the first `- [ ]` item, returns the task text and its phase heading
2. **`buildSimpleTaskPrompt(slug, projectDir, planPath, taskInfo)`** — builds a single-task prompt with inline context (~15 lines of plan context, framework choice, file type hints)
3. **`runCline(prompt)`** — calls `killHubDaemons()` then `spawnSync('cline', args)` with 960s timeout
4. **`markTaskDone(planPath, lineNumber)`** — changes `- [ ]` to `- [x]` in plan.md

**Build limits**: `maxBuildCalls = 25` (main loop), `maxReconcileBuildCalls = 20` (recovery loop).

### Phase 4: Test
- Extracts test command from plan.md (looks for `## Test Command` section)
- Runs tests via `spawnSync`, retries up to 3 times on failure
- If all retries fail, writes `test-failures.txt` and moves to next iteration

### Phase 5: Upload → Git Sync
- `uploadProject(slug)` creates a tar.gz of the project directory
- POSTs it as multipart form data to `/api/v1/projects` on slop-api
- **Immediately after successful upload**, calls `triggerGitSync()` which POSTs to the orchestrator's `/git-sync-projects` endpoint
- The orchestrator downloads the archive from slop-api, extracts to `/git-repo/projects/{slug}/`, removes nested `.git` dirs, and **commits + pushes to GitHub** via `git push --force-with-lease`
- Git sync is **turn-independent** — works regardless of whose turn it is in the batch cycle
- **Cline does NOT perform git operations** — the agent-runner handles git sync after the build is complete

### Phase 6: Database Update
- Updates builder's own `db.md` with project entry and status
- Statuses: "Complete", "Tests Failed"

---

## Cline Interaction Patterns

### Cline CLI Version Compatibility — CRITICAL

| Version | `run_commands` status | Notes |
|---------|----------------------|-------|
| **v3.0.29** ✅ | Working | Full shell: `mkdir -p`, `ls`, `cat > file << 'EOF'`, `npm install`, heredocs — all functional |
| **v3.0.31** ❌ | Broken | `posix_spawn` ENOENT on every command — treats entire command string as binary name |

**Pinned at v3.0.29** in Dockerfile (`npm install -g cline@3.0.29`). Do not bump without verifying `run_commands` still works.

### Actual Cline Tool Behavior (v3.0.29)

| Tool | Works? | Notes |
|------|--------|-------|
| `write_to_file` | ✅ | Creates files with parent dirs |
| `editor` | ⚠️ | Works but has 6000-char limit — model self-corrects by falling back to shell |
| `read_file` | ✅ | Reads files normally |
| `run_commands` | ✅ | Full bash available: `mkdir -p`, `ls`, `cat > file << 'EOF'`, heredocs, `npm install`, `npm test` |

### Prompt Design — Proven Patterns

**DO NOT add ENVIRONMENT hints** telling the model what tools work or don't work. The model discovers tool capabilities through normal trial-and-error. Adding defensive instructions like "run_commands does NOT work" creates worse behavior than letting the model figure it out.

**DO NOT handle npm/tests in JavaScript.** The model runs `npm install`, `npm test`, and shell commands naturally through `run_commands`. The JS runner should stay out of the build loop beyond task orchestration (parsing plan.md, spawning Cline, marking checkboxes).

**Keep prompts simple.** Inline JSON idea context + plan template. No tool micromanagement, no environment warnings, no "don't read files" instructions.

### `NODE_ENV=production` — CRITICAL Pitfall

The Dockerfile **must NOT set `ENV NODE_ENV=production`**. When `NODE_ENV=production` is set:

1. **`npm install` silently skips all `devDependencies`**
2. The model runs `npm install`, sees exit code 0, and believes everything installed
3. `typescript`, `vite`, `vitest`, `@testing-library/*`, and all other build/test tools are missing
4. Next `npm run build` fails with `tsc: not found` — model has no explanation why

The builder container is a **build worker**, not a production server. Projects must install their full dependency tree including devDependencies for compilation and testing.

**Fix:** Remove `ENV NODE_ENV=production` from the Dockerfile runtime stage entirely. The `node` user (uid 1000) already has permission to write to `/app/projects/` and can run `npm install` normally.

### Hub Daemon Cleanup

Before every Cline call, `killHubDaemons()` scans `/proc/*/cmdline` for `hub-daemon` processes and SIGKILLs them. Without this, stale daemons reject hooks from new Cline instances after ~4 calls, causing 5-minute timeouts.

### Single-Task Prompts

Send ONE simple task per Cline call. The JS agent-runner manages progress — Cline doesn't need to read files or track state:

```
Create the project scaffolding for {app}. Initialize a React app with Vite,
set up TypeScript strict mode, and create the directory structure.

Project directory: /app/projects/{slug}
The project uses React + Vite + TypeScript.

Write these files:
1. package.json with dependencies
2. tsconfig.json with strict mode
3. vite.config.ts
```

### Inline Context

All context is embedded directly in the prompt. Cline is NOT asked to read files (files >100 lines cause timeouts):

- Framework choice (e.g., "Next.js 14 + TypeScript + Prisma + SQLite")
- File type hints ("Create TypeScript files" / "Write JSX components")
- Project structure ("Files go in `/app/projects/{slug}/` with `src/` and `tests/` directories")
- ~15 lines of relevant plan context from the current phase

**Never include**: "Read AGENTS.md", "Read plan.md", "Read .clinerules/instructions/", or "Open the editor tool".

---

## Plan.md Format

Each project gets a plan.md in `/app/projects/{slug}/plan.md`:

```markdown
# Build Plan: {App Name}
- **Slug**: {slug}
- **Framework**: {framework + rationale}
- **Created**: {timestamp}

## Phase 1: Project Scaffolding
- [ ] Initialize project with {framework} CLI
- [ ] Set up TypeScript configuration
- [ ] Configure ESLint and Prettier

## Phase 2: Data Layer
- [ ] Design database schema
- [ ] Set up ORM and initial migration
- [ ] Create seed data

## Phase 3: API Routes
- [ ] Set up API router structure
- [ ] Implement CRUD endpoints
- [ ] Add input validation and error handling

## Phase 4: Frontend
- [ ] Create layout and routing
- [ ] Implement feature pages per idea spec
- [ ] Wire up API calls from frontend

## Phase 5: Auth & Security
- [ ] Implement authentication flow
- [ ] Add protected routes and CORS

## Phase 6: Polish
- [ ] Add responsive design
- [ ] Write README with setup instructions
- [ ] Optimize production build

## Test Command
`npm test`
```

The `- [ ]` → `- [x]` checkbox format is critical — `parseNextUncheckedTask()` and `markTaskDone()` rely on it.

---

## File Structure (Module-Per-Responsibility)

The builder's `scripts/` directory is split into single-concern modules. The main `agent-runner.js` is a thin orchestrator — it imports all modules, runs the `main()` loop, and re-exports symbols for test compatibility.

```
slop-builder/scripts/
├── agent-runner.js        # Thin orchestrator: main() loop + re-exports (~180 lines)
├── agent.js               # configureProvider() + runCline() (async spawn + heartbeat)
├── prompt-builder.js      # buildDeepPlanPrompt() + buildSimpleTaskPrompt() + buildExecutePrompt()
├── database.js            # parseDatabase() + updateDatabase() + initializeDatabase() + checkoutIdea()
├── api-client.js          # authenticate() + fetchRandomIdea() + uploadProject()
├── orchestrator-client.js # checkCanRun() + reportProgress() + triggerGitSync()
├── tests-runner.js        # runTests() (extract command from plan.md + spawnSync)
└── recovery.js            # recoverBuilderState()
```

All symbols are re-exported from `agent-runner.js` so existing test imports work unchanged.

---

## Configuration

- **config/settings.json**: max_iterations (50), max_test_retries (3), timeout_ms (600000)
- **config/.env**: API_BASE_URL, API_KEY, CLINE_PROVIDER, CLINE_API_BASE_URL, CLINE_MODEL
- **Environment variables**:
  - `BUILDER_MAX_FAILED_RETRIES` (default: `3`) — when this many projects have failed status, retry the oldest one instead of building something new. Set to `0` to disable.
  - `API_BASE_URL`, `API_KEY` — slop-api access
  - `CLINE_PROVIDER`, `CLINE_API_BASE_URL`, `CLINE_MODEL` — Cline/AI backend
  - `ORCHESTRATOR_URL` — orchestrator coordination endpoint
- Environment variables override settings.json values
- **No GIT_REPO_URL** — builder doesn't push to git

---

## Container

### Base Image & Build
- **Base Image**: node:22-slim → multi-stage build (builder + runtime)
- **User**: node (uid 1000, non-root)

### Runtime Dependencies

| Package | Purpose |
|---------|---------|
| `tini` | PID 1 signal handling |
| `git` | Project version control (`git init`, `git add`, `git commit`) |
| `curl` | HTTP requests from shell (API health checks, downloads) |
| `procps` | `pgrep`/`pkill` for process management patterns |
| `ca-certificates` | TLS certificate validation |
| `cline@3.0.29` | AI agent CLI (pinned — see version compatibility above) |

### Available Shell Tools

| Category | Tools |
|----------|-------|
| Core | `bash`, `cat`, `echo`, `env`, `rm`, `cp`, `mv`, `chmod`, `chown`, `diff`, `printf` |
| Text processing | `find`, `xargs`, `grep`, `sed`, `awk`, `sort`, `uniq`, `mktemp` |
| Archiving | `tar`, `gzip` |
| Networking | `curl`, `openssl` |
| Runtime | `node`, `npm`, `npx`, `cline` |

### Health & Lifecycle
- **Health Check**: `node -e "console.log('healthy')"`
- **Entrypoint**: tini → node scripts/agent-runner.js
- **Network**: Internal Docker bridge (slop-net), accepts self-signed API certs
