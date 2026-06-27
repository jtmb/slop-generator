#!/usr/bin/env node
/**
 * Slop Orchestrator — Load Controller
 *
 * Coordinates turn-based batch execution between slop-planner and slop-builder
 * to prevent them from competing for the shared LM Studio backend.
 *
 * State machine:
 *   PLANNER_TURN ──(BATCH_SIZE progress)──▶ BUILDER_TURN ──(BATCH_SIZE progress)──▶ PLANNER_TURN
 *
 * Workers poll /check-in before each iteration and report /progress after.
 * The orchestrator is purely internal — no auth, no host port exposure.
 */

import express from 'express';
import dotenv from 'dotenv';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import logger from '../lib/logger.js';

dotenv.config();

const PORT = parseInt(process.env.ORCHESTRATOR_PORT || '3444', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '6', 10);
const STATE_FILE = '/tmp/orchestrator-state.json';

// In-memory state — resets to PLANNER_TURN on restart unless persisted
const state = {
  turn: 'planner',
  plannerProgress: 0,
  builderProgress: 0,
};

/**
 * Restore orchestrator state from disk after a restart.
 * Reads the JSON state file written on the last state mutation.
 */
function restoreState() {
  try {
    if (!existsSync(STATE_FILE)) return;

    const raw = readFileSync(STATE_FILE, 'utf-8');
    const saved = JSON.parse(raw);

    if (saved.turn && ['planner', 'builder'].includes(saved.turn)) {
      state.turn = saved.turn;
      state.plannerProgress = typeof saved.plannerProgress === 'number' ? saved.plannerProgress : 0;
      state.builderProgress = typeof saved.builderProgress === 'number' ? saved.builderProgress : 0;
      logger.info({ restored: saved }, 'Restored orchestrator state from disk');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to restore orchestrator state — starting fresh');
  }
}

/**
 * Persist the current state to disk atomically.
 * Called on every state mutation to survive orchestrator restarts.
 */
function persistState() {
  try {
    const tmpPath = STATE_FILE + '.tmp';
    mkdirSync('/tmp', { recursive: true });
    writeFileSync(tmpPath, JSON.stringify({
      turn: state.turn,
      plannerProgress: state.plannerProgress,
      builderProgress: state.builderProgress,
      lastUpdated: new Date().toISOString(),
    }, null, 2), 'utf-8');
    renameSync(tmpPath, STATE_FILE);
  } catch (err) {
    logger.warn({ err }, 'Failed to persist orchestrator state');
  }
}

// ---------------------------------------------------------------------------
// Express app setup
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Request logging middleware — same pattern as slop-api
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
    }, 'request');
  });
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Health check — returns current state and batch size. */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    turn: state.turn,
    batchSize: BATCH_SIZE,
    plannerProgress: state.plannerProgress,
    builderProgress: state.builderProgress,
  });
});

/** Full state dump for debugging. */
app.get('/state', (_req, res) => {
  res.json({ ...state, batchSize: BATCH_SIZE });
});

/**
 * POST /check-in — Worker polls to see if it's their turn.
 *
 * Body: { "role": "planner" | "builder" }
 *
 * Returns { can_run: boolean, turn, progress, batchSize }.
 * can_run is true only when role matches the current turn.
 */
app.post('/check-in', (req, res) => {
  const { role } = req.body || {};

  if (!role || !['planner', 'builder'].includes(role)) {
    return res.status(400).json({
      error: { code: 'INVALID_ROLE', message: 'Body must include role: "planner" or "builder"' },
    });
  }

  const progress = role === 'planner' ? state.plannerProgress : state.builderProgress;

  res.json({
    can_run: role === state.turn,
    turn: state.turn,
    progress,
    batchSize: BATCH_SIZE,
  });
});

/**
 * POST /progress — Worker reports one completed iteration.
 *
 * Body: { "role": "planner" | "builder" }
 *
 * Increments the progress counter for the given role.
 * When it reaches BATCH_SIZE, resets progress and flips the turn.
 *
 * Returns 409 if the worker is reporting out of turn.
 */
app.post('/progress', (req, res) => {
  const { role } = req.body || {};

  if (!role || !['planner', 'builder'].includes(role)) {
    return res.status(400).json({
      error: { code: 'INVALID_ROLE', message: 'Body must include role: "planner" or "builder"' },
    });
  }

  // Reject out-of-turn progress reports
  if (role !== state.turn) {
    return res.status(409).json({
      error: {
        code: 'WRONG_TURN',
        message: `It is not ${role}'s turn — current turn is ${state.turn}`,
      },
    });
  }

  // Increment progress
  if (role === 'planner') {
    state.plannerProgress++;
  } else {
    state.builderProgress++;
  }

  const progress = role === 'planner' ? state.plannerProgress : state.builderProgress;
  const batchComplete = progress >= BATCH_SIZE;

  if (batchComplete) {
    // Flip turn and reset both progress counters
    const previousTurn = state.turn;
    state.turn = state.turn === 'planner' ? 'builder' : 'planner';
    state.plannerProgress = 0;
    state.builderProgress = 0;

    persistState();
    logger.info({ previousTurn, newTurn: state.turn, batchSize: BATCH_SIZE }, 'Batch complete — turn flipped');
  } else {
    persistState();
    logger.info({ role, progress, batchSize: BATCH_SIZE }, 'Progress reported');
  }

  res.json({
    batch_complete: batchComplete,
    turn: state.turn,
    progress: batchComplete ? 0 : progress,
    batchSize: BATCH_SIZE,
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Only start the server when executed directly (not imported for tests)
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('orchestrator.js') ||
  process.argv[1].endsWith('orchestrator')
);

if (isMainModule) {
  restoreState();
  logger.info({ port: PORT, batchSize: BATCH_SIZE, initialTurn: state.turn }, 'Orchestrator starting');

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Orchestrator listening');
  });

  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

// Export app and state for tests
export { app, state, BATCH_SIZE, restoreState, persistState };
