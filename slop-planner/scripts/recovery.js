/**
 * Recovery — Restore planner state after a crash or restart.
 *
 * Reads .agent-state.json to determine if a previous iteration was interrupted.
 * If so, re-runs the interrupted phase(s) and posts ideas to the API.
 * Respects the orchestrator — waits for planner's turn before each Cline call.
 */
import logger from '../lib/logger.js';
import { loadState, saveState } from '../lib/agent-state.js';
import { runCline } from './agent.js';
import { buildPlanPrompt, buildAgentPrompt } from './prompt-builder.js';
import { postIdeasToApi } from './api-client.js';
import { reportProgress } from './orchestrator-client.js';

/**
 * Recover from a previous crash/restart by reading .agent-state.json.
 *
 * If the agent was mid-iteration, completes the interrupted work.
 * Returns the iteration number to resume from (0 if fresh start).
 *
 * @param {object} options — Configuration for recovery
 * @param {string} [options.statePath] — Override state file path (for testing)
 * @param {string} options.provider — Cline provider name
 * @param {string} options.apiBaseUrl — slop-api base URL
 * @param {string} options.apiKey — API key for authentication
 * @param {string} options.orchestratorUrl — Orchestrator URL
 * @param {Function} [options.checkCanRunFn] — Override orchestrator check function (for testing)
 * @returns {Promise<number>} Iteration to resume from
 */
export async function recoverPlannerState(options = {}) {
  const {
    statePath,
    provider,
    apiBaseUrl,
    apiKey,
    orchestratorUrl,
    checkCanRunFn
  } = options;

  const sp = statePath || undefined;
  const state = loadState(sp);

  if (!state) {
    logger.info('No previous state found — starting from iteration 0');
    return 0;
  }

  logger.info({ savedState: state }, 'Recovering from previous state');

  if (state.phase === 'complete') {
    // Previous iteration finished cleanly — resume from next
    logger.info({ resumeAt: state.iteration + 1 }, 'Resuming from next iteration');
    return state.iteration;
  }

  // Mid-iteration recovery — re-run from the interrupted phase
  logger.warn({ phase: state.phase, iteration: state.iteration }, 'Mid-iteration crash detected — recovering');

  const iter = state.iteration;

  try {
    if (state.phase === 'planning' || state.phase === 'execution') {
      // Re-run planning if interrupted during planning
      if (state.phase === 'planning') {
        logger.info({ phase: 'planning', iteration: iter }, 'Recovery: re-running planning phase');
        if (checkCanRunFn) await checkCanRunFn();
        runCline(buildPlanPrompt(), provider);
        saveState(sp, { iteration: iter, phase: 'execution', currentSlug: null });
      }

      // Re-run execution if interrupted during execution
      if (state.phase === 'planning' || state.phase === 'execution') {
        logger.info({ phase: 'execution', iteration: iter }, 'Recovery: re-running execution phase');
        if (checkCanRunFn) await checkCanRunFn();
        runCline(buildAgentPrompt(), provider);
      }

      // Post ideas to API (recovery from mid-iteration crash)
      try {
        await postIdeasToApi(apiBaseUrl, apiKey);
        logger.info('Recovery: posted ideas to API');
        saveState(sp, { iteration: iter, phase: 'complete', currentSlug: null });
        await reportProgress(orchestratorUrl);
        return iter;
      } catch (postErr) {
        logger.warn({ err: postErr }, 'Recovery: failed to post ideas to API');
        return iter;
      }
    }
  } catch (recoveryError) {
    logger.error({ err: recoveryError, iteration: iter, phase: state.phase }, 'Recovery failed — will restart iteration');
  }

  return iter;
}
