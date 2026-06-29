/**
 * Orchestrator State Manager
 *
 * In-memory state and atomic disk persistence for the orchestrator.
 * State survives container restarts via /tmp/orchestrator-state.json.
 *
 * State machine:
 *   PLANNER_TURN ──(BATCH_SIZE progress)──▶ BUILDER_TURN ──(BATCH_SIZE progress)──▶ PLANNER_TURN
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import logger from '../lib/logger.js';

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '6', 10);
const STATE_FILE = '/tmp/orchestrator-state.json';

/** In-memory state — resets to PLANNER_TURN on restart unless persisted */
const state = {
  turn: 'planner',
  plannerProgress: 0,
  builderProgress: 0,
  catchUpMode: false,
  ideasCount: 0,
  projectsCount: 0,
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
      state.catchUpMode = saved.catchUpMode === true;
      state.ideasCount = typeof saved.ideasCount === 'number' ? saved.ideasCount : 0;
      state.projectsCount = typeof saved.projectsCount === 'number' ? saved.projectsCount : 0;
      logger.info({ restored: saved }, 'Restored orchestrator state from disk');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to restore orchestrator state — starting fresh');
  }
}

/**
 * Persist the current state to disk atomically.
 * Called on every state mutation to survive orchestrator restarts.
 * Falls back to direct write if atomic rename fails (Docker bind mounts).
 */
function persistState() {
  try {
    const tmpPath = STATE_FILE + '.tmp';
    mkdirSync('/tmp', { recursive: true });
    writeFileSync(tmpPath, JSON.stringify({
      turn: state.turn,
      plannerProgress: state.plannerProgress,
      builderProgress: state.builderProgress,
      catchUpMode: state.catchUpMode,
      ideasCount: state.ideasCount,
      projectsCount: state.projectsCount,
      lastUpdated: new Date().toISOString(),
    }, null, 2), 'utf-8');
    try {
      renameSync(tmpPath, STATE_FILE);
    } catch (renameErr) {
      // Atomic rename can fail with EBUSY/EPERM on Docker volume bind mounts
      if (renameErr.code === 'EBUSY' || renameErr.code === 'EPERM') {
        writeFileSync(STATE_FILE, JSON.stringify({
          turn: state.turn,
          plannerProgress: state.plannerProgress,
          builderProgress: state.builderProgress,
          catchUpMode: state.catchUpMode,
          ideasCount: state.ideasCount,
          projectsCount: state.projectsCount,
          lastUpdated: new Date().toISOString(),
        }, null, 2), 'utf-8');
        try { unlinkSync(tmpPath); } catch (_) { /* ignore */ }
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to persist orchestrator state');
  }
}

export { state, BATCH_SIZE, STATE_FILE, restoreState, persistState };
