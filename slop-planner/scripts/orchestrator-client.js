/**
 * Orchestrator Client — Coordination with slop-orchestrator.
 *
 * The orchestrator controls turn-based batch execution to prevent
 * the planner and builder from running LLM inference concurrently.
 * Before each iteration, the planner must check in and wait for its turn.
 */
import http from 'http';
import axios from 'axios';
import logger from '../lib/logger.js';

export const MAX_ORCHESTRATOR_RETRIES = 10;

/**
 * Poll the orchestrator until it's our turn to run.
 * Does NOT fail open — if the orchestrator is unreachable,
 * retries with backoff until it responds. Never proceeds without coordination.
 *
 * @param {string} orchestratorUrl — URL of the orchestrator (e.g., "http://slop-orchestrator:3444")
 * @returns {Promise<void>}
 */
export async function checkCanRun(orchestratorUrl) {
  const orch = axios.create({
    baseURL: orchestratorUrl,
    httpAgent: new http.Agent({ keepAlive: false }),
    timeout: 10000,
  });

  let retries = 0;
  while (true) {
    try {
      const { data } = await orch.post('/check-in', { role: 'planner' });
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
      logger.warn({ err, retries, backoffMs: backoff, orchestratorUrl }, 'Orchestrator unreachable — retrying');
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
 * @param {string} orchestratorUrl — URL of the orchestrator
 * @returns {Promise<void>}
 */
export async function reportProgress(orchestratorUrl) {
  const orch = axios.create({
    baseURL: orchestratorUrl,
    httpAgent: new http.Agent({ keepAlive: false }),
    timeout: 10000,
  });

  try {
    const { data } = await orch.post('/progress', { role: 'planner' });
    if (data.batch_complete) {
      logger.info({ newTurn: data.turn, batchSize: data.batchSize }, 'Batch complete — yielding to builder');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to report progress to orchestrator');
  }
}
