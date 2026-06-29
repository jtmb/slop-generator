#!/usr/bin/env node
/**
 * Agent Runner — Autopilot loop for App Idea Generator.
 *
 * Thin orchestrator: imports modules for agent management, prompt building,
 * API client interactions, database operations, orchestrator coordination,
 * and crash recovery. The main() loop sequences them and saves state
 * atomically between phases.
 */
import dotenv from 'dotenv';
import settings from '../config/settings.json' with { type: 'json' };
import logger from '../lib/logger.js';
import { loadState, saveState } from '../lib/agent-state.js';
import { configureProvider, runCline } from './agent.js';
import { buildPlanPrompt, buildAgentPrompt } from './prompt-builder.js';
import { loadPostedSlugs } from './database.js';
import { postIdeasToApi } from './api-client.js';
import { checkCanRun, reportProgress } from './orchestrator-client.js';
import { recoverPlannerState } from './recovery.js';

dotenv.config();

logger.level = settings.log_level || 'info';

// Orchestrator coordination URL — shared across all orchestrator client calls
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://slop-orchestrator:3444';

/**
 * Main autopilot loop.
 *
 * Each iteration: check orchestrator → plan → execute → post ideas → report progress.
 * State is saved atomically between phases for crash recovery.
 * Resets iteration counter when max_iterations is reached (orchestrator controls pacing).
 */
async function main() {
  logger.info({ maxIterations: settings.max_iterations }, 'App Idea Generator — Autopilot Mode');

  configureProvider();
  loadPostedSlugs();

  const recovered = await recoverPlannerState({
    statePath: undefined,
    provider: process.env.CLINE_PROVIDER || 'lmstudio',
    apiBaseUrl: process.env.API_BASE_URL || 'https://slop-api:3443',
    apiKey: process.env.API_KEY || '',
    orchestratorUrl: process.env.ORCHESTRATOR_URL || 'http://slop-orchestrator:3444',
  });
  let iteration = recovered;

  if (recovered > 0) {
    logger.info({ recovered }, 'Recovered from previous session — resuming from iteration');
  }

  while (true) {
    if (iteration >= settings.max_iterations) {
      logger.info({ previousIteration: iteration }, 'Resetting iteration counter for next batch');
      iteration = 0;
    }

    iteration++;

    try {
      await checkCanRun(ORCHESTRATOR_URL);

      saveState(null, { iteration, phase: 'planning', currentSlug: null });
      logger.info({ iteration, maxIterations: settings.max_iterations }, 'Iteration start');

      logger.info({ phase: 'planning', iteration }, 'Planning phase');
      runCline(buildPlanPrompt());
      logger.info({ phase: 'planning', iteration }, 'Planning complete');

      saveState(null, { iteration, phase: 'execution', currentSlug: null });

      logger.info({ phase: 'execution', iteration }, 'Execution phase');
      runCline(buildAgentPrompt());
      logger.info({ phase: 'execution', iteration }, 'Execution complete');

      await postIdeasToApi();

      saveState(null, { iteration, phase: 'complete', currentSlug: null });
      await reportProgress(ORCHESTRATOR_URL);

      logger.info({ iteration }, 'Iteration complete');
    } catch (error) {
      logger.error({ err: error, iteration }, 'Iteration failed');

      if (error.message.includes('ETIMEDOUT') || error.message.includes('ECONNREFUSED')) {
        logger.fatal({ err: error }, 'API unreachable — stopping agent');
        process.exit(1);
      }

      logger.warn('Continuing to next iteration');
    }
  }
}

// Graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// Only run when executed directly (not imported for tests)
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('agent-runner.js') ||
  process.argv[1].endsWith('agent-runner')
);

if (isMainModule) {
  main().catch(err => {
    logger.fatal({ err }, 'Fatal error');
    process.exit(1);
  });
}

export { configureProvider, runCline, buildPlanPrompt, buildAgentPrompt, checkCanRun, reportProgress, recoverPlannerState, loadState, saveState };
