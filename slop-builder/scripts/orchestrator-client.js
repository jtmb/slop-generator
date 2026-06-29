/**
 * Orchestrator Client — Coordination with slop-orchestrator for turn-based execution.
 *
 * Handles check-in polling, progress reporting, and git sync triggering.
 * All communication is over HTTP on the internal Docker bridge network.
 */
import axios from 'axios';
import http from 'http';
import logger from '../lib/logger.js';

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://slop-orchestrator:3444';

const orch = axios.create({
  baseURL: ORCHESTRATOR_URL,
  // keepAlive: false to avoid EPIPE on reused sockets
  httpAgent: new http.Agent({ keepAlive: false }),
  timeout: 10000,
});

/** Maximum retries before giving up on orchestrator connectivity. */
export const MAX_ORCHESTRATOR_RETRIES = 10;

/**
 * Poll the orchestrator until it's our turn to run.
 * Does NOT fail open — retries with backoff until the orchestrator responds.
 *
 * @returns {Promise<void>} Resolves when it's our turn
 */
export async function checkCanRun() {
  let retries = 0;
  while (true) {
    try {
      const { data } = await orch.post('/check-in', { role: 'builder' });
      retries = 0; // Reset on success
      if (data.can_run) {
        logger.info({ turn: data.turn, progress: data.progress }, 'Orchestrator says go');
        return;
      }
      logger.info({ turn: data.turn, progress: data.progress }, 'Orchestrator says wait — sleeping 30s');
    } catch (err) {
      retries++;
      if (retries > MAX_ORCHESTRATOR_RETRIES) {
        throw new Error(`Orchestrator unreachable after ${MAX_ORCHESTRATOR_RETRIES} retries — giving up`);
      }
      const backoff = Math.min(retries * 5000, 30000);
      logger.warn({ err, retries, backoffMs: backoff, orchestratorUrl: ORCHESTRATOR_URL }, 'Orchestrator unreachable — retrying');
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
    await new Promise(r => setTimeout(r, 30000));
  }
}

/**
 * Report one completed iteration to the orchestrator.
 * Logs when a batch completes and the turn flips.
 *
 * @returns {Promise<void>}
 */
export async function reportProgress() {
  try {
    const { data } = await orch.post('/progress', { role: 'builder' });
    if (data.batch_complete) {
      logger.info({ newTurn: data.turn, batchSize: data.batchSize }, 'Batch complete — yielding to planner');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to report progress to orchestrator');
  }
}

/**
 * Trigger an immediate git sync of all projects to GitHub via the orchestrator.
 *
 * Calls the orchestrator's /git-sync-projects endpoint which pulls any projects
 * from slop-api that haven't yet been synced to the git repo. This is
 * turn-independent — it works regardless of whose turn it is in the batch cycle.
 *
 * Safe to call at any time. Errors are logged but not thrown (fire-and-forget).
 *
 * @returns {Promise<void>}
 */
export async function triggerGitSync() {
  try {
    const { data } = await orch.post('/git-sync-projects');
    if (data.synced > 0) {
      logger.info({ synced: data.synced }, 'Git sync triggered — projects synced to GitHub');
    }
  } catch (err) {
    // 400 = git not configured, 409 = not an error we care about, other = transient
    if (err.response?.status === 400) {
      logger.info('Git sync not configured — skipping');
    } else {
      logger.warn({ err }, 'Git sync trigger failed (non-fatal)');
    }
  }
}
