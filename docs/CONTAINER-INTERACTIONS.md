# Container Interactions

> High-level overview of how the four containers communicate, coordinate, and recover from failures.

## Service Topology

```mermaid
graph TB
    subgraph slop-net["slop-net (Docker bridge)"]
        P["slop-planner<br/>Worker<br/>━━━━━━━━━━<br/>Ports: none<br/>State: .agent-state.json<br/>Data: apps/, db.md"]
        B["slop-builder<br/>Worker<br/>━━━━━━━━━━<br/>Ports: none<br/>State: .agent-state.json<br/>Data: projects/, db.md"]
        A["slop-api<br/>HTTPS Server<br/>━━━━━━━━━━<br/>Port: 3443 (HTTPS)<br/>Auth: JWT (HS256)<br/>Data: data/apps/, data/db.md"]
        O["slop-orchestrator<br/>Load Controller<br/>━━━━━━━━━━<br/>Port: 3444 (HTTP)<br/>State: /tmp/orchestrator-state.json"]
    end

    LM["LM Studio<br/>192.168.0.13:1234"]
    GH["GitHub<br/>git push"]

    P -->|"POST /api/v1/ideas<br/>(HTTPS + JWT)"| A
    B -->|"GET /api/v1/ideas/random<br/>(HTTPS + JWT)"| A
    P <-->|"/check-in, /progress<br/>(HTTP, internal)"| O
    B <-->|"/check-in, /progress<br/>(HTTP, internal)"| O
    P -->|"cline CLI → /v1/chat/completions"| LM
    B -->|"cline CLI → /v1/chat/completions"| LM
    P -->|"git push (branch: planner)"| GH
    B -->|"git push (branch: build/slug)"| GH
```

**Key**: Solid arrows = HTTP requests. Dotted = coordination. No shared volumes. Each service owns its data.

---

## Planner Lifecycle

The planner runs a 3-phase autopilot loop with state checkpoints at every boundary:

```mermaid
flowchart TD
    START([Container Start]) --> RECOVER{".agent-state.json<br/>exists?"}
    RECOVER -->|Yes| CHK_PHASE{Phase?}
    RECOVER -->|No| ITER[iteration = 0]

    CHK_PHASE -->|complete| RESUME[Resume from iteration+1]
    CHK_PHASE -->|planning| R_PLAN[Re-run: Planning → Execution → Git Sync]
    CHK_PHASE -->|execution| R_EXEC[Re-run: Execution → Git Sync]
    CHK_PHASE -->|git-sync| R_GIT[Re-run: Git Sync]

    R_PLAN --> DONE
    R_EXEC --> DONE
    R_GIT --> DONE
    RESUME --> LOOP

    ITER --> LOOP
    DONE[Mark complete<br/>Save state] --> LOOP

    LOOP{iteration < max?}
    LOOP -->|Yes| ORCH_CHECK["POST /check-in<br/>role: planner"]
    ORCH_CHECK -->|can_run| SAVE_PLAN["Save state: planning"]
    SAVE_PLAN --> PLAN["Phase 1: Planning<br/>cline buildPlanPrompt()"]
    PLAN --> SAVE_EXEC["Save state: execution"]
    SAVE_EXEC --> EXEC["Phase 2: Execution<br/>cline buildAgentPrompt()"]
    EXEC --> SAVE_GIT["Save state: git-sync"]
    SAVE_GIT --> GIT["Phase 3: Git Sync<br/>git-sync.js --once"]
    GIT --> SAVE_DONE["Save state: complete"]
    SAVE_DONE --> ORCH_PROG["POST /progress<br/>role: planner"]
    ORCH_PROG -->|batch_complete| YIELD[Yield to builder]
    ORCH_PROG -->|not yet| LOOP
    YIELD --> LOOP

    ORCH_CHECK -->|blocked| SLEEP["Sleep 30s"]
    SLEEP --> ORCH_CHECK
    LOOP -->|No| END([Loop Complete])

    style RECOVER fill:#4a9,stroke:#333
    style ORCH_CHECK fill:#49a,stroke:#333
    style SAVE_PLAN fill:#94a,stroke:#333
    style SAVE_EXEC fill:#94a,stroke:#333
    style SAVE_GIT fill:#94a,stroke:#333
    style SAVE_DONE fill:#94a,stroke:#333
```

**State save points** (blue nodes): Atomic write-then-rename to `.agent-state.json`. On crash, the next startup reads the last saved phase and resumes from there.

---

## Builder Lifecycle

The builder runs a 6-phase pipeline with full project directory reconciliation on startup:

```mermaid
flowchart TD
    START([Container Start]) --> RECONCILE["reconcileProjectsDir()<br/>Scan /app/projects/"]
    RECONCILE --> RECOVER{".agent-state.json<br/>exists?"}
    RECOVER -->|Yes| CHK_PHASE{Phase?}
    RECOVER -->|No| ITER[iteration = 0]

    CHK_PHASE -->|complete| RESUME[Resume from iteration+1]
    CHK_PHASE -->|other| RETURN[Return iteration<br/>Reconciliation covers recovery]

    RESUME --> LOOP
    RETURN --> LOOP
    ITER --> LOOP

    LOOP{iteration < max?}
    LOOP -->|Yes| ORCH_CHECK["POST /check-in<br/>role: builder"]
    ORCH_CHECK -->|can_run| SAVE_FETCH["Save state: fetch"]

    SAVE_FETCH --> FETCH["Phase 1: Fetch Idea<br/>GET /api/v1/ideas/random"]
    FETCH --> DEDUP{"isAlreadyBuilt()?<br/>Matches Complete OR Tests Failed"}
    DEDUP -->|Yes, skip| FETCH
    DEDUP -->|No| EEXIST{"Dir exists?"}
    EEXIST -->|Yes| RECONCILE_EXIST[Reconcile existing dir]
    EEXIST -->|No| MKDIR[mkdirSync]

    RECONCILE_EXIST --> LOOP

    MKDIR --> SAVE_PLAN["Save state: planning"]
    SAVE_PLAN --> DEEP_PLAN["Phase 2: Deep Planning<br/>cline buildDeepPlanPrompt()"]
    DEEP_PLAN --> SAVE_BUILD["Save state: building"]

    SAVE_BUILD --> BUILD["Phase 3: Build<br/>Execute unchecked phases"]
    BUILD --> CHECK_PLAN{"All items<br/>checked?"}
    CHECK_PLAN -->|No, ≤10| BUILD
    CHECK_PLAN -->|Yes| SAVE_TEST["Save state: testing"]

    SAVE_TEST --> TEST["Phase 4: Test<br/>runTests()"]
    TEST -->|fail| DB_FAIL["updateDatabase(Tests Failed)"]
    DB_FAIL --> SAVE_DONE["Save state: complete"]
    SAVE_DONE --> ORCH_PROG["POST /progress"]
    
    TEST -->|pass| SAVE_PUSH["Save state: git-push"]
    SAVE_PUSH --> PUSH["Phase 5: Git Push<br/>git-sync.js --slug"]
    PUSH --> SAVE_DB["Save state: db-update"]

    SAVE_DB --> DB["Phase 6: Update DB<br/>updateDatabase(Complete)"]
    DB --> SAVE_DONE2["Save state: complete"]
    SAVE_DONE2 --> ORCH_PROG

    ORCH_PROG --> LOOP

    ORCH_CHECK -->|blocked| SLEEP["Sleep 30s"]
    SLEEP --> ORCH_CHECK
    LOOP -->|No| END([Loop Complete])

    style RECONCILE fill:#f96,stroke:#333
    style RECOVER fill:#4a9,stroke:#333
    style DEDUP fill:#f96,stroke:#333
    style EEXIST fill:#f96,stroke:#333
    style SAVE_FETCH fill:#94a,stroke:#333
    style SAVE_PLAN fill:#94a,stroke:#333
    style SAVE_BUILD fill:#94a,stroke:#333
    style SAVE_TEST fill:#94a,stroke:#333
    style SAVE_PUSH fill:#94a,stroke:#333
    style SAVE_DB fill:#94a,stroke:#333
    style SAVE_DONE fill:#94a,stroke:#333
    style SAVE_DONE2 fill:#94a,stroke:#333
```

**Reconciliation** (orange nodes): On startup, scans `/app/projects/` for interrupted builds. See [Project Reconciliation](#project-directory-reconciliation) below.

---

## Orchestrator State Machine

```mermaid
stateDiagram-v2
    [*] --> PLANNER_TURN

    state PLANNER_TURN {
        [*] --> P0: progress=0
        P0 --> P1: /progress (planner)
        P1 --> P2: /progress (planner)
        P2 --> P3: /progress (planner)
        P3 --> P4: /progress (planner)
        P4 --> P5: /progress (planner)
        P5 --> P_DONE: /progress (planner)
    }

    state BUILDER_TURN {
        [*] --> B0: progress=0
        B0 --> B1: /progress (builder)
        B1 --> B2: /progress (builder)
        B2 --> B3: /progress (builder)
        B3 --> B4: /progress (builder)
        B4 --> B5: /progress (builder)
        B5 --> B_DONE: /progress (builder)
    }

    PLANNER_TURN --> BUILDER_TURN: BATCH_SIZE reached
    BUILDER_TURN --> PLANNER_TURN: BATCH_SIZE reached

    note right of PLANNER_TURN
        /check-in?role=planner → can_run=true
        /check-in?role=builder → can_run=false
        State persisted to /tmp/orchestrator-state.json
    end note

    note right of BUILDER_TURN
        /check-in?role=builder → can_run=true
        /check-in?role=planner → can_run=false
        State persisted to /tmp/orchestrator-state.json
    end note
```

**Persistence**: Every `/progress` call writes to `/tmp/orchestrator-state.json` (atomic tmp+rename). On restart, `restoreState()` reads it — survives orchestrator crashes.

---

## Self-Healing Sequence

What happens when containers crash and restart:

```mermaid
sequenceDiagram
    participant P as slop-planner
    participant O as slop-orchestrator
    participant B as slop-builder
    participant FS as File System

    Note over P,FS: === Scenario 1: Planner crashes mid-execution ===
    P->>FS: Save state: { iteration:5, phase:execution }
    P--xP: CRASH
    Note over P: Restart
    P->>FS: loadState() → { iteration:5, phase:execution }
    P->>P: Re-run: Execution phase
    P->>P: Re-run: Git Sync phase
    P->>FS: Save state: { iteration:5, phase:complete }
    P->>O: POST /progress (iteration 5)

    Note over P,FS: === Scenario 2: Builder crashes during build ===
    B->>FS: Save state: { iteration:3, phase:building, slug:"my-app" }
    B->>FS: Write plan.md with 2 unchecked items
    B--xB: CRASH
    Note over B: Restart
    B->>B: reconcileProjectsDir()
    B->>FS: Scan /app/projects/my-app/
    B->>FS: Read plan.md → 2 unchecked items
    B->>B: Resume build: execute phases 2×
    B->>B: Run tests → pass
    B->>B: Git push
    B->>FS: updateDatabase(my-app, Complete)
    B->>FS: loadState() → { iteration:3, phase:building }
    B->>O: POST /progress (iteration 3)

    Note over P,FS: === Scenario 3: Orchestrator restarts ===
    O->>FS: /tmp/orchestrator-state.json: { turn:builder, plannerProgress:0, builderProgress:3 }
    O--xO: Restart
    Note over O: Restart
    O->>FS: restoreState() → turn=builder, builderProgress=3
    Note over O: Continues where it left off — no turn reset

    Note over P,FS: === Scenario 4: Builder gets slug with existing dir ===
    B->>O: /check-in → can_run=true
    B->>B: Fetch idea: slug "my-app"
    B->>FS: existsSync(/app/projects/my-app) → true
    Note over B: EEXIST guard triggers
    B->>B: Reconcile existing directory
    B->>B: Run pending phases, tests, push, db update
    B->>O: POST /progress
```

---

## Auth Flow

```mermaid
sequenceDiagram
    participant P as slop-planner
    participant B as slop-builder
    participant A as slop-api (HTTPS 3443)
    participant J as JWT Engine

    Note over P,A: Planner: Push new ideas
    P->>A: POST /api/v1/auth/token { api_key }
    A->>J: Verify API_KEY (HS256)
    J-->>A: jwtToken (24h expiry)
    A-->>P: { token }
    P->>A: POST /api/v1/ideas { ... }<br/>Authorization: Bearer TOKEN
    A->>J: Verify JWT signature
    J-->>A: Valid
    A-->>P: 201 Created

    Note over B,A: Builder: Fetch random ideas
    B->>A: POST /api/v1/auth/token { api_key }
    A->>J: Verify API_KEY (HS256)
    J-->>A: jwtToken (24h expiry)
    A-->>B: { token }
    B->>A: GET /api/v1/ideas/random<br/>Authorization: Bearer TOKEN
    A->>J: Verify JWT signature
    J-->>A: Valid
    A-->>B: { name, slug, description, ... }
```

**Key points**:
- `API_KEY` is a pre-shared secret in each worker's `.env` file
- JWT tokens are cached in memory per worker process — exchanged once on startup
- All API traffic uses HTTPS (self-signed cert, internal Docker network)
- No auth on orchestrator — internal-only, no host port exposure

---

## Failure Modes

```mermaid
graph TB
    subgraph Errors["Failure Modes & Recovery"]
        E1["LM Studio unreachable<br/>(ECONNREFUSED/ETIMEDOUT)"]
        E2["Orchestrator unreachable"]
        E3["Duplicate slug fetched<br/>(dir already exists)"]
        E4["Tests fail<br/>(all retries exhausted)"]
        E5["Git push fails<br/>(network/auth)"]
        E6["Mid-phase crash<br/>(container restart)"]
        E7["Orchestrator crash<br/>(state loss)"]
    end

    E1 --> R1["Agent exits with code 1<br/>Docker restart: unless-stopped"]
    E2 --> R2["Fail-open: proceed without<br/>coordination. Both workers run."]
    E3 --> R3["Reconcile existing dir<br/>Resume build or skip if done."]
    E4 --> R4["updateDatabase(Tests Failed)<br/>isAlreadyBuilt matches → won't re-fetch."]
    E5 --> R5["updateDatabase(Built push failed)<br/>Non-fatal — continue loop."]
    E6 --> R6["Startup recovery:<br/>Read .agent-state.json<br/>Re-run interrupted phase(s)."]
    E7 --> R7["restoreState() from<br/>/tmp/orchestrator-state.json<br/>Turn + progress preserved."]

    style E1 fill:#e44,stroke:#333
    style E2 fill:#e94,stroke:#333
    style E3 fill:#e94,stroke:#333
    style E4 fill:#e94,stroke:#333
    style E5 fill:#e94,stroke:#333
    style E6 fill:#4a9,stroke:#333
    style E7 fill:#4a9,stroke:#333
    style R1 fill:#fdd,stroke:#333
    style R2 fill:#ffd,stroke:#333
    style R3 fill:#ffd,stroke:#333
    style R4 fill:#ffd,stroke:#333
    style R5 fill:#ffd,stroke:#333
    style R6 fill:#dfd,stroke:#333
    style R7 fill:#dfd,stroke:#333
```

---

## Project Directory Reconciliation

On every startup, `slop-builder` scans `/app/projects/` and handles each directory:

| State | Action |
|-------|--------|
| Dir with no `plan.md` | **Delete** — orphan leftover from crash before planning |
| `plan.md` has unchecked `- [ ]` items | **Resume build** — execute remaining phases (up to 10 iterations) |
| `plan.md` fully checked, no db entry | **Run tests** → **Git push** → **updateDatabase** |
| Dir with db entry already | **Skip** — already tracked |

This guarantees no project is left in a half-built state across restarts.

---

## State File Locations

| Container | File | Content |
|-----------|------|---------|
| slop-planner | `/app/.agent-state.json` | `{ iteration, phase (planning\|execution\|git-sync\|complete), currentSlug, lastUpdated }` |
| slop-builder | `/app/.agent-state.json` | `{ iteration, phase (fetch\|planning\|building\|testing\|git-push\|db-update\|complete), currentSlug, lastUpdated }` |
| slop-orchestrator | `/tmp/orchestrator-state.json` | `{ turn, plannerProgress, builderProgress, lastUpdated }` |

All files use atomic write (tmp + rename) to prevent corruption on crash mid-write.
