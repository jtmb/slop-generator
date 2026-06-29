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
import https from 'https';
import axios from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import logger from '../lib/logger.js';
import { ensureGitRepo, syncApps, syncAllProjects } from './git-push.js';

dotenv.config();

const PORT = parseInt(process.env.ORCHESTRATOR_PORT || '3444', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '6', 10);
const STATE_FILE = '/tmp/orchestrator-state.json';
const GIT_REPO_URL = process.env.GIT_REPO_URL || '';

// Catch-up mode thresholds — activates when ideas/projects >= threshold (2:1 target)
// and deactivates when ratio recovers to target or below
const CATCH_UP_RATIO_THRESHOLD = parseFloat(process.env.CATCH_UP_RATIO_THRESHOLD || '2');
const CATCH_UP_TARGET_RATIO = parseFloat(process.env.CATCH_UP_TARGET_RATIO || '1.9');

// slop-api access for fetching ideas/projects counts
const API_BASE_URL = process.env.API_BASE_URL || 'https://slop-api:3443';
const API_KEY = process.env.API_KEY || '';

// In-memory state — resets to PLANNER_TURN on restart unless persisted
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
      // Atomic rename can fail with EBUSY/EPERM on Docker volume bind mounts.
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

// ---------------------------------------------------------------------------
// slop-api access — authenticate and fetch ideas/projects counts for catch-up mode
// ---------------------------------------------------------------------------

let jwtToken = null;

const api = axios.create({
  baseURL: API_BASE_URL,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 15000,
});

/**
 * Authenticate with slop-api and cache the JWT.
 */
async function authenticate() {
  if (jwtToken) return jwtToken;

  logger.info({ apiBaseUrl: API_BASE_URL }, 'Orchestrator authenticating with slop-api');
  const { data } = await api.post('/api/v1/auth/token', { api_key: API_KEY });
  jwtToken = data.token;
  return jwtToken;
}

/**
 * Fetch current ideas and projects counts from slop-api.
 * Returns { ideasCount, projectsCount, ideasToProjects } or null on failure.
 */
async function fetchRatios() {
  try {
    const token = await authenticate();
    const headers = { Authorization: `Bearer ${token}` };

    const [ideasRes, projectsRes] = await Promise.all([
      api.get('/api/v1/ideas', { headers }),
      api.get('/api/v1/projects', { headers }),
    ]);

    const ideasCount = ideasRes.data.count || 0;

    // Only count genuinely completed projects (status === "Complete").
    // "Complete (tests failed)" projects aren't truly functional and
    // shouldn't count toward the ratio.
    const allProjects = projectsRes.data.projects || [];
    const projectsCount = allProjects.filter(p => p.status === 'Complete').length;

    const ideasToProjects = projectsCount > 0 ? ideasCount / projectsCount : Infinity;

    logger.debug({
      ideasCount,
      projectsCount,
      totalProjects: allProjects.length,
      ideasToProjects,
    }, 'Fetched ratios from slop-api');
    return { ideasCount, projectsCount, ideasToProjects };
  } catch (err) {
    logger.warn({ err: err?.message }, 'Failed to fetch ratios from slop-api');
    return null;
  }
}

/**
 * Evaluate whether to enter or exit catch-up mode based on ideas-to-projects ratio.
 *
 * Catch-up mode activates when ideas / projects >= CATCH_UP_RATIO_THRESHOLD (default 2,
 * meaning 2:1 ratio — e.g., 12 ideas for 6 projects).
 * It deactivates when ideas / projects <= CATCH_UP_TARGET_RATIO (default 1.9).
 *
 * During catch-up mode, the builder runs exclusively to close the idea gap.
 * Only the planner is blocked — the builder continues as normal.
 *
 * Returns { changed: boolean, activated?: boolean, deactivated?: boolean, ratios?: object }
 */
async function evaluateCatchUpMode() {
  // Skip API calls during tests — Vitest sets VITEST env var automatically.
  // Without this guard, evaluateCatchUpMode hangs waiting for slop-api which
  // doesn't exist in the test environment.
  if (process.env.VITEST) return { changed: false, reason: 'test_mode' };

  const ratios = await fetchRatios();
  if (!ratios) return { changed: false, reason: 'unreachable' };

  state.ideasCount = ratios.ideasCount;
  state.projectsCount = ratios.projectsCount;

  // Activate catch-up mode when ratio exceeds threshold
  if (!state.catchUpMode && ratios.ideasToProjects >= CATCH_UP_RATIO_THRESHOLD) {
    state.catchUpMode = true;
    persistState();
    logger.warn({
      ideasCount: ratios.ideasCount,
      projectsCount: ratios.projectsCount,
      ratio: ratios.ideasToProjects.toFixed(2),
      threshold: CATCH_UP_RATIO_THRESHOLD,
    }, 'CATCH-UP MODE ACTIVATED — builder runs exclusively until ratio recovers');
    return { changed: true, activated: true, ratios };
  }

  // Deactivate catch-up mode when ratio recovers to target
  if (state.catchUpMode && ratios.ideasToProjects <= CATCH_UP_TARGET_RATIO) {
    state.catchUpMode = false;
    state.turn = 'planner';
    state.plannerProgress = 0;
    state.builderProgress = 0;
    persistState();
    logger.info({
      ideasCount: ratios.ideasCount,
      projectsCount: ratios.projectsCount,
      ratio: ratios.ideasToProjects.toFixed(2),
      target: CATCH_UP_TARGET_RATIO,
    }, 'Catch-up mode deactivated — ratio recovered, resuming normal turns');
    return { changed: true, deactivated: true, ratios };
  }

  return { changed: false, reason: 'no_action_needed' };
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
    catchUpMode: state.catchUpMode,
    ideasCount: state.ideasCount,
    projectsCount: state.projectsCount,
    completionRatio: state.projectsCount > 0
      ? Number((state.ideasCount / state.projectsCount).toFixed(2))
      : null,
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
 * Returns { can_run, turn, progress, batchSize, catch_up_mode }.
 * can_run is false when:
 *   - role does not match current turn (normal mode), OR
 *   - catch-up mode is active and role is 'planner'
 * In catch-up mode, builder always gets can_run: true regardless of turn.
 */
app.post('/check-in', async (req, res) => {
  try {
    const { role } = req.body || {};

    if (!role || !['planner', 'builder'].includes(role)) {
      return res.status(400).json({
        error: { code: 'INVALID_ROLE', message: 'Body must include role: "planner" or "builder"' },
      });
    }

    // Re-check ratio on every check-in to catch ratio recovery ASAP
    await evaluateCatchUpMode();

    const progress = role === 'planner' ? state.plannerProgress : state.builderProgress;
    const completionRatio = state.projectsCount > 0
      ? Number((state.ideasCount / state.projectsCount).toFixed(2))
      : null;

    // Catch-up mode: planner blocked, builder always runs
    if (state.catchUpMode) {
      return res.json({
        can_run: role === 'builder',
        turn: state.turn,
        progress,
        batchSize: BATCH_SIZE,
        catch_up_mode: true,
        ideas_count: state.ideasCount,
        projects_count: state.projectsCount,
        completion_ratio: completionRatio,
      });
    }

    // Normal mode: only the current turn can run
    res.json({
      can_run: role === state.turn,
      turn: state.turn,
      progress,
      batchSize: BATCH_SIZE,
      catch_up_mode: false,
    });
  } catch (err) {
    logger.warn({ err: err?.message }, 'Error in /check-in');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Check-in processing failed' },
    });
  }
});

/**
 * POST /progress — Worker reports one completed iteration.
 *
 * Body: { "role": "planner" | "builder" }
 *
 * Increments the progress counter for the given role.
 * When it reaches BATCH_SIZE, resets progress and flips the turn.
 *
 * In catch-up mode:
 *   - Only builder can report progress
 *   - After every builder progress report, re-evaluates the ratio
 *   - If ratio recovered, exits catch-up mode and resets turn to planner
 *   - At batch boundaries, triggers git sync for new projects
 *
 * Returns 409 if the worker is reporting out of turn.
 */
app.post('/progress', async (req, res) => {
  try {
    const { role } = req.body || {};

    if (!role || !['planner', 'builder'].includes(role)) {
      return res.status(400).json({
        error: { code: 'INVALID_ROLE', message: 'Body must include role: "planner" or "builder"' },
      });
    }

    // Reject out-of-turn progress reports
    // In catch-up mode, skip this check for builder (builder runs exclusively)
    if (role !== state.turn && !(state.catchUpMode && role === 'builder')) {
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

    // -----------------------------------------------------------------------
    // CATCH-UP MODE PATH — builder runs exclusively until ratio recovers
    // -----------------------------------------------------------------------
    if (state.catchUpMode) {
      // Re-evaluate ratio after every builder iteration
      const evalResult = await evaluateCatchUpMode();

      if (evalResult.changed && evalResult.deactivated) {
        // Ratio recovered — exit catch-up mode, turn already reset to planner
        res.json({
          batch_complete: true,
          turn: state.turn,
          progress: 0,
          batchSize: BATCH_SIZE,
          catch_up_mode: false,
          ideas_count: state.ideasCount,
          projects_count: state.projectsCount,
        });
        return;
      }

      // Still in catch-up mode — use normal batch boundaries for git sync
      if (batchComplete) {
        state.turn = 'planner'; // Will be overridden by catch-up on next check-in
        state.plannerProgress = 0;
        state.builderProgress = 0;
        persistState();
        logger.info({ progress, batchSize: BATCH_SIZE }, 'Catch-up mode batch complete — builder continues');

        if (GIT_REPO_URL) {
          syncAllProjects().catch(err => logger.warn({ err }, 'Catch-up git sync failed'));
        }
      } else {
        persistState();
      }

      res.json({
        batch_complete: batchComplete,
        turn: state.turn,
        progress: batchComplete ? 0 : progress,
        batchSize: BATCH_SIZE,
        catch_up_mode: true,
      });
      return;
    }

    // -----------------------------------------------------------------------
    // NORMAL MODE PATH — standard turn-based batch alternation
    // -----------------------------------------------------------------------
    if (batchComplete) {
      // Flip turn and reset both progress counters
      const previousTurn = state.turn;
      state.turn = state.turn === 'planner' ? 'builder' : 'planner';
      state.plannerProgress = 0;
      state.builderProgress = 0;

      persistState();
      logger.info({ previousTurn, newTurn: state.turn, batchSize: BATCH_SIZE }, 'Batch complete — turn flipped');

      // Fire-and-forget git sync — don't block the HTTP response
      if (GIT_REPO_URL) {
        if (previousTurn === 'planner') {
          // Planner batch done — sync new ideas to git
          syncApps().catch(err => logger.warn({ err }, 'Post-planner git sync failed'));
        } else {
          // Builder batch done — sync new projects to git
          syncAllProjects().catch(err => logger.warn({ err }, 'Post-builder git sync failed'));
        }
      }
    } else {
      persistState();
      logger.info({ role, progress, batchSize: BATCH_SIZE }, 'Progress reported');
    }

    res.json({
      batch_complete: batchComplete,
      turn: state.turn,
      progress: batchComplete ? 0 : progress,
      batchSize: BATCH_SIZE,
      catch_up_mode: false,
    });
  } catch (err) {
    logger.warn({ err: err?.message }, 'Error in /progress');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Progress report processing failed' },
    });
  }
});

/**
 * POST /git-sync-projects — Directly sync all new projects from slop-api to git.
 *
 * Unlike /progress, this endpoint does NOT interact with the turn-based state machine.
 * It directly calls syncAllProjects() to pull any projects from slop-api that
 * haven't yet been synced to the git repo.
 *
 * This is used by the builder's reconciliation flow to immediately sync projects
 * completed during startup recovery, bypassing the batch-turn cycle.
 *
 * Body: none (ignored if present)
 *
 * Returns { synced: number, error?: string }.
 */
app.post('/git-sync-projects', async (_req, res) => {
  if (!GIT_REPO_URL) {
    return res.status(400).json({
      synced: 0,
      error: 'Git sync not configured — GIT_REPO_URL is not set',
    });
  }

  try {
    const count = await syncAllProjects();
    res.json({ synced: count });
  } catch (err) {
    logger.warn({ err }, 'Manual git sync failed');
    res.status(500).json({ synced: 0, error: err.message });
  }
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

  // Initialize git repo for push (only if GIT_REPO_URL is configured)
  if (GIT_REPO_URL) {
    ensureGitRepo();
    // Initial sync of existing apps (fire-and-forget)
    syncApps().then(count => {
      logger.info({ count }, 'Initial git sync complete');
    }).catch(err => {
      logger.warn({ err }, 'Initial git sync failed');
    });
  }

  // Check initial ratio — may activate catch-up mode immediately if ideas >> projects
  evaluateCatchUpMode().then(result => {
    if (result.changed && result.activated) {
      logger.warn({ ideasCount: state.ideasCount, projectsCount: state.projectsCount },
        'Started in catch-up mode — builder will run exclusively');
    } else if (state.catchUpMode) {
      logger.info({ catchUpMode: true, reason: result.reason },
        'Catch-up mode persisted from previous session');
    } else {
      logger.debug({ ideasCount: state.ideasCount, projectsCount: state.projectsCount },
        'Initial ratio check — normal mode');
    }
  }).catch(err => {
    logger.warn({ err }, 'Initial ratio check failed (non-fatal)');
  });

  logger.info({ port: PORT, batchSize: BATCH_SIZE, initialTurn: state.turn, catchUpMode: state.catchUpMode }, 'Orchestrator starting');

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Orchestrator listening');
  });

  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

// Export app and state for tests
export {
  app,
  state,
  BATCH_SIZE,
  CATCH_UP_RATIO_THRESHOLD,
  CATCH_UP_TARGET_RATIO,
  restoreState,
  persistState,
  GIT_REPO_URL,
  syncAllProjects,
  fetchRatios,
  evaluateCatchUpMode,
};
