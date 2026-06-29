---
description: "Module-per-responsibility file organization for all slop services. Enforces maximum file size and single-concern modules."
applyTo: "slop-{planner,builder,api,orchestrator}/**/*.js"
---

# File Organization — Module-Per-Responsibility

Every slop service MUST be split into single-concern modules. Monolithic "one big file" agents are forbidden. Each module handles exactly one responsibility and no module exceeds 250 lines.

## Core Principle

> A file should do one thing well. The main orchestrator script is thin — it imports modules, sequences them, and re-exports for tests.

## Module Naming Convention

Each module file lives in `scripts/` alongside the main orchestrator:

| Module | Responsibility | Naming Pattern |
|--------|---------------|----------------|
| Agent management | Provider config, Cline process spawning | `agent.js` |
| Prompt builder | Pure functions producing prompt strings | `prompt-builder.js` |
| Database / parsers | db.md parsing, file parsing, tracking sets | `database.js` |
| API client | HTTP calls to other services (auth, posting) | `api-client.js` |
| Orchestrator client | Coordination with slop-orchestrator | `orchestrator-client.js` |
| Recovery | Crash/restart state recovery logic | `recovery.js` |
| Main orchestrator | Imports all modules, main() loop, re-exports | `agent-runner.js` |

## File Size Limits

- **Module files**: Maximum 250 lines. If a module exceeds this, split further.
- **Main orchestrator (`agent-runner.js`)**: Maximum 150 lines. It should be readable in a single screen.
- **Library files (`lib/`)**: Maximum 200 lines. Pure utility functions.

## What Goes Where

### `agent.js` — Cline CLI lifecycle
- `configureProvider()` — writes `providers.json` to `~/.cline/data/settings/`
- `runCline()` — spawns Cline (sync or async depending on service)
- Reads config from environment variables (with sensible defaults)

### `prompt-builder.js` — Prompt string generation
- Pure functions that return prompt strings
- Each prompt phase gets its own function (e.g., `buildPlanPrompt()`, `buildAgentPrompt()`)
- No I/O, no state, no side effects

### `database.js` — Local data store operations
- `parseDb()` — read and parse the service's `db.md`
- File parsing for app/idea files
- Tracking sets (e.g., posted slugs, checked-out ideas)
- Persistence of tracking state to auxiliary files

### `api-client.js` — REST API interactions
- Authentication (JWT token management)
- Data posting (POST ideas, build results)
- Axios instance creation with TLS configuration
- Error handling for transient HTTP failures

### `orchestrator-client.js` — Orchestrator coordination
- `checkCanRun()` — poll orchestrator for turn
- `reportProgress()` — notify orchestrator of completed work
- Backoff/retry logic for orchestrator connectivity
- Constants like `MAX_ORCHESTRATOR_RETRIES`

### `recovery.js` — Crash recovery
- Read `.agent-state.json` to detect interrupted iterations
- Re-run interrupted phases
- Respect orchestrator coordination during recovery
- Returns iteration to resume from

### `agent-runner.js` — Thin orchestrator (main entry point)
- Import all modules
- `main()` loop: checkCanRun → plan → execute → post → reportProgress
- State persistence between phases via `lib/agent-state.js`
- Re-export all symbols for test compatibility
- Graceful shutdown handlers
- `isMainModule` guard for test imports

## Anti-Patterns

- **One big file**: Never put all logic in `agent-runner.js` or equivalent.
- **Circular imports**: Module A → Module B → Module A. Restructure — extract shared logic into `lib/`.
- **Module with 3+ responsibilities**: If a module handles agent spawning AND prompts AND parsing, split it.
- **Duplicated constants**: Config values live in `config/` or as module-level defaults — never copied between files.
- **Logic in re-export files**: The main orchestrator only imports and re-exports — no business logic except the `main()` loop.

## Test Compatibility

All symbols previously imported from `agent-runner.js` by tests MUST remain importable from `agent-runner.js` after the split. The main file re-exports everything:

```javascript
export { configureProvider, runCline } from './agent.js';
export { buildPlanPrompt, buildAgentPrompt } from './prompt-builder.js';
export { recoverPlannerState } from './recovery.js';
export { loadState, saveState } from '../lib/agent-state.js';
// ... etc
```

## When Adding a New Function

1. Determine which module it belongs to (or create a new module)
2. If no existing module fits, create a new one with a clear, self-explanatory name
3. Update the main orchestrator's re-exports
4. Write tests that import from the module directly OR from the main file (both must work)
5. If the module exceeds 250 lines, split it further
