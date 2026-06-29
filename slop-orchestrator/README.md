# Slop Orchestrator — Load Controller

## Role

The Slop Orchestrator coordinates turn-based batch execution between slop-planner and slop-builder to prevent them from competing for the shared LM Studio backend. It implements a simple alternating batch controller:

```
planner generates N ideas → orchestrator flips to builder → builder builds N projects → orchestrator flips back
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check — returns status, current turn, and batch size |
| GET | /state | Full state object (turn, progress, batch size) |
| POST | /check-in | Worker polls for permission to run. Body: `{ "role": "planner"|"builder" }` |
| POST | /progress | Worker reports one completed iteration. Body: `{ "role": "planner"|"builder" }` |

## State Machine

```
                  ┌──────────────┐
                  │ PLANNER_TURN │ (initial state)
                  └──────┬───────┘
                         │ planner reports BATCH_SIZE progress
                         ▼
                  ┌──────────────┐
                  │ BUILDER_TURN │
                  └──────┬───────┘
                         │ builder reports BATCH_SIZE progress
                         ▼
                  ┌──────────────┐
                  │ PLANNER_TURN │ (cycle repeats)
                  └──────────────┘
```

## Worker Integration

### Planner (before each iteration)
```javascript
while (!(await checkCanRun())) {
  await sleep(30000); // Wait 30s, retry
}
// Proceed with idea generation
```

### Planner (after each iteration)
```javascript
const result = await reportProgress();
if (result.batch_complete) {
  logger.info('Batch complete — yielding to builder');
}
```

### Builder (same pattern, role: "builder")

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| ORCHESTRATOR_PORT | 3444 | HTTP listen port |
| BATCH_SIZE | 6 | Ideas/projects per batch |
| LOG_LEVEL | info | Pino log level |

## Container

- **Base Image**: node:22-slim
- **Runtime**: tini, Express 4.21
- **Port**: 3444 (internal only — not exposed to host)
- **User**: node (uid 1000, non-root)
- **Network**: slop-net (Docker bridge)
