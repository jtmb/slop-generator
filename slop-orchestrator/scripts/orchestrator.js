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
 *
 * Files:
 *   orchestrator.js   — Express app, routes, startup (this file)
 *   state-manager.js  — In-memory state, atomic disk persistence
 *   catch-up.js       — Ratio evaluation, catch-up mode activation/deactivation
 *   git-push.js       — Git repo operations (clone, commit, push)
 *   issue-tracker.js  — GitHub issue creation for failing projects
 */

import express from 'express';
import dotenv from 'dotenv';
import logger from '../lib/logger.js';
import { state, BATCH_SIZE, restoreState, persistState } from './state-manager.js';
import { api, evaluateCatchUpMode } from './catch-up.js';
import { ensureGitRepo, syncApps, syncAllProjects } from './git-push.js';
import { syncFailedProjectIssues, closeResolvedProjectIssues } from './issue-tracker.js';

dotenv.config();

const PORT = parseInt(process.env.ORCHESTRATOR_PORT || '3444', 10);
const GIT_REPO_URL = process.env.GIT_REPO_URL || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

/**
 * Retry issue sync with exponential backoff.
 * slop-api may still be starting when the orchestrator first comes up,
 * so we retry a few times before giving up.
 *
 * @param {object} apiClient - Axios instance for slop-api
 * @param {string} gitRepoUrl - GitHub repo URL
 * @param {number} maxRetries - Maximum retry attempts (default 5)
 * @returns {Promise<{created: number, skipped: number}>}
 */
async function retryIssueSync(apiClient, gitRepoUrl, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await syncFailedProjectIssues(apiClient, gitRepoUrl);

    // If we got a connection error (returned 0,0 with an internal error),
    // the function already logged it. Wait and retry.
    if (result.error) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      logger.info({ attempt: attempt + 1, maxRetries, delay },
        'Retrying issue sync after connection failure');
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }

    // Success or no failing projects — either is fine
    return result;
  }

  // All retries exhausted
  logger.error({ maxRetries }, 'Issue sync failed after all retries');
  return { created: 0, skipped: 0 };
}

/**
 * Run both issue creation and issue closing in a single fire-and-forget pass.
 * Creates issues for newly-failing projects and closes issues for projects
 * that have been fixed since their issue was created.
 *
 * @param {object} apiClient - Axios instance for slop-api
 * @param {string} gitRepoUrl - GitHub repo URL
 * @param {string} context - Label for log messages (e.g. "startup", "catch-up", "batch")
 */
function syncAllIssues(apiClient, gitRepoUrl, context) {
  // Create issues for newly-failing projects
  syncFailedProjectIssues(apiClient, gitRepoUrl).then(({ created, skipped, error }) => {
    if (error) {
      logger.error({ error, context }, 'Issue creation failed');
    } else if (created > 0) {
      logger.info({ created, skipped, context }, 'Issues created');
    }
  }).catch(err => logger.error({ err, context }, 'Issue creation threw'));

  // Close issues for projects that are now passing
  closeResolvedProjectIssues(apiClient, gitRepoUrl).then(({ closed, skipped, error }) => {
    if (error) {
      logger.error({ error, context }, 'Issue closing failed');
    } else if (closed > 0) {
      logger.info({ closed, skipped, context }, 'Issues closed');
    }
  }).catch(err => logger.error({ err, context }, 'Issue closing threw'));
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
    await evaluateCatchUpMode(state, persistState);

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
      const evalResult = await evaluateCatchUpMode(state, persistState);

      // Fire-and-forget issue sync for failing projects (create + close)
      if (GIT_REPO_URL && GITHUB_TOKEN) {
        syncAllIssues(api, GIT_REPO_URL, 'catch-up');
      }

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

          // Sync failing-project issues on builder batch completion (create + close)
          if (GIT_REPO_URL && GITHUB_TOKEN) {
            syncAllIssues(api, GIT_REPO_URL, 'batch');
          }
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

    // Sync failing-project issues after startup (retry up to 5 times with backoff)
    if (GIT_REPO_URL && GITHUB_TOKEN) {
      retryIssueSync(api, GIT_REPO_URL, 5).then(({ created, skipped }) => {
        logger.info({ created, skipped }, 'Initial issue sync complete');
      }).catch(err => {
        logger.error({ err }, 'Initial issue sync failed after retries');
      });
      // Also close issues for any projects that have already been fixed
      closeResolvedProjectIssues(api, GIT_REPO_URL).then(({ closed, skipped, error }) => {
        if (error) {
          logger.error({ error }, 'Initial issue close failed');
        } else if (closed > 0) {
          logger.info({ closed, skipped }, 'Initial issue close complete');
        }
      }).catch(err => logger.error({ err }, 'Initial issue close threw'));
    }
  }

  // Check initial ratio — may activate catch-up mode immediately if ideas >> projects
  evaluateCatchUpMode(state, persistState).then(result => {
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
  restoreState,
  persistState,
  GIT_REPO_URL,
  syncAllProjects,
  evaluateCatchUpMode,
};
