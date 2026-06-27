#!/usr/bin/env node
/**
 * Agent Runner - Autopilot loop for App Idea Generator
 * 
 * Simple babysitter: calls `cline` CLI in a loop.
 * Cline reads AGENTS.md, handles ALL API calls, tool execution,
 * file creation, and db updates — we just nudge it to start again.
 */

import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import http from 'http';
import dotenv from 'dotenv';
import axios from 'axios';
import settings from '../config/settings.json' with { type: 'json' };
import logger from '../lib/logger.js';
import { loadState, saveState } from '../lib/agent-state.js';

dotenv.config();

// Wire up log level from settings (previously dead config)
logger.level = settings.log_level || 'info';

const PROVIDER = process.env.CLINE_PROVIDER || 'lmstudio';
const BASE_URL = process.env.CLINE_API_BASE_URL || 'http://host.docker.internal:1234/v1';
const MODEL = process.env.CLINE_MODEL || 'qwen/qwen3.5-9b';

// slop-orchestrator coordination
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://slop-orchestrator:3444';
const httpAgent = new http.Agent({ keepAlive: true });

const orch = axios.create({
  baseURL: ORCHESTRATOR_URL,
  httpAgent,
  timeout: 10000,
});

/**
 * Configure cline provider by writing providers.json
 */
function configureProvider() {
  const clineDir = path.join(homedir(), '.cline', 'data', 'settings');
  mkdirSync(clineDir, { recursive: true });

  const providersConfig = {
    version: 1,
    lastUsedProvider: 'lmstudio',
    providers: {
      lmstudio: {
        settings: {
          provider: 'lmstudio',
          model: MODEL,
          baseUrl: BASE_URL
        },
        updatedAt: new Date().toISOString(),
        tokenSource: 'manual'
      }
    }
  };

  writeFileSync(
    path.join(clineDir, 'providers.json'),
    JSON.stringify(providersConfig, null, 2)
  );

  logger.info({ provider: PROVIDER, endpoint: BASE_URL, model: MODEL }, 'Provider configured');
}

/**
 * Run a single cline command and wait for completion.
 * Uses spawnSync with argument array to avoid shell quoting issues entirely.
 */
function runCline(prompt) {
  const args = ['-P', PROVIDER, prompt];
  logger.info({ promptPreview: prompt.substring(0, 80) }, 'Cline started');

  const result = spawnSync('cline', args, {
    encoding: 'utf-8',
    timeout: settings.timeout_ms || 600000,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const msg = result.stderr?.trim() || result.stdout?.trim() || `Exit code ${result.status}`;
    throw new Error(msg);
  }

  logger.info('Cline finished');
  return result.stdout;
}

/**
 * Build the planning prompt — instructs cline to research and formulate a plan
 * without executing anything yet. The plan is saved to a file for handoff.
 */
function buildPlanPrompt() {
  return `You are the **Planning Module** of the App Idea Generator.

Your job is ONLY to research and plan. DO NOT create any files in apps/ and DO NOT modify db.md.

Follow these steps:
1. Read the file AGENTS.md from the current working directory to understand the full workflow.
2. Read the file db.md from the current working directory to see all existing ideas.
3. Analyze what categories and ideas already exist to avoid duplicates.
4. Formulate a detailed plan for ONE new, unique app idea.

Write your plan to /app/plan.txt using the file system tool. Use EXACTLY this format:

**App Name**: {proposed app name}
**Category**: {category}
**Problem It Solves**: {1-2 sentence summary}
**Why It's Unique**: {how it differs from existing ideas in db.md}
**Key Features**: {2-3 bullet points}
**Target Audience**: {who}

IMPORTANT: Do NOT create any files in apps/. Do NOT modify db.md. Just research, plan, and write /app/plan.txt.`;
}

/**
 * Build the execution prompt — instructs cline to read the plan and execute it.
 */
function buildAgentPrompt() {
  return `You are the **Execution Module** of the App Idea Generator.

The Planning Module has written its plan to /app/plan.txt. Read that file first.

Your job is to execute this plan. Follow these steps:
1. Read the file /app/plan.txt to get the plan.
2. Read the file db.md to confirm current state.
3. Create the app idea markdown file in the apps/ directory.
4. Update db.md to add the new idea to the database.

IMPORTANT: You MUST use your file system tools to create and update files. Do not just describe what you would do — actually do it.`;
}

/**
 * Poll the orchestrator until it's our turn to run.
 * Fails open — if the orchestrator is unreachable, proceed anyway.
 */
async function checkCanRun() {
  while (true) {
    try {
      const { data } = await orch.post('/check-in', { role: 'planner' });
      if (data.can_run) {
        logger.info({ turn: data.turn, progress: data.progress }, 'Orchestrator says go');
        return;
      }
      logger.info({ turn: data.turn, progress: data.progress }, 'Orchestrator says wait — sleeping 30s');
    } catch (err) {
      logger.warn({ err, orchestratorUrl: ORCHESTRATOR_URL }, 'Orchestrator unreachable — proceeding anyway');
      return;
    }
    await new Promise(r => setTimeout(r, 30000));
  }
}

/**
 * Report one completed iteration to the orchestrator.
 * Logs when a batch completes and the turn flips.
 */
async function reportProgress() {
  try {
    const { data } = await orch.post('/progress', { role: 'planner' });
    if (data.batch_complete) {
      logger.info({ newTurn: data.turn, batchSize: data.batchSize }, 'Batch complete — yielding to builder');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to report progress to orchestrator');
  }
}

/**
 * Recover from a previous crash/restart by reading .agent-state.json.
 *
 * If the agent was mid-iteration, completes the interrupted work.
 * Returns the iteration number to resume from (0 if fresh start).
 *
 * @param {string} [statePath] - Override state file path (for testing)
 */
function recoverPlannerState(statePath) {
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
    if (state.phase === 'planning' || state.phase === 'execution' || state.phase === 'git-sync') {
      // Re-run planning if interrupted during planning
      if (state.phase === 'planning') {
        logger.info({ phase: 'planning', iteration: iter }, 'Recovery: re-running planning phase');
        runCline(buildPlanPrompt());
        saveState(sp, { iteration: iter, phase: 'execution', currentSlug: null });
      }

      // Re-run execution if interrupted during execution
      if (state.phase === 'planning' || state.phase === 'execution') {
        logger.info({ phase: 'execution', iteration: iter }, 'Recovery: re-running execution phase');
        runCline(buildAgentPrompt());
        saveState(sp, { iteration: iter, phase: 'git-sync', currentSlug: null });
      }

      // Re-run git sync if interrupted during git-sync
      logger.info({ phase: 'git-sync', iteration: iter }, 'Recovery: re-running git sync phase');
      try {
        const gitResult = spawnSync('node', ['scripts/git-sync.js', '--once'], {
          encoding: 'utf-8',
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (gitResult.stdout?.trim()) {
          logger.info({ output: gitResult.stdout.trim().slice(0, 500) }, 'Git sync output (recovery)');
        }
      } catch (gitError) {
        logger.warn({ err: gitError }, 'Git sync error during recovery (non-fatal)');
      }

      // Mark complete and report progress
      saveState(sp, { iteration: iter, phase: 'complete', currentSlug: null });
    }
  } catch (recoveryError) {
    logger.error({ err: recoveryError, iteration: iter, phase: state.phase }, 'Recovery failed — will restart iteration');
  }

  return iter; // This iteration is now complete
}

/**
 * Main autopilot loop
 */
async function main() {
  logger.info({ maxIterations: settings.max_iterations }, 'App Idea Generator — Autopilot Mode');

  configureProvider();

  // Recover from crash/restart — get the iteration to start from
  const recoveredIteration = recoverPlannerState();
  let iteration = recoveredIteration;

  // If recovered from a mid-iteration crash, report progress for that iteration
  if (recoveredIteration > 0) {
    await reportProgress();
  }

  while (iteration < settings.max_iterations) {
    iteration++;

    try {
      // Check with orchestrator before each iteration
      await checkCanRun();

      // Save state: about to start planning
      saveState(null, { iteration, phase: 'planning', currentSlug: null });

      logger.info({ iteration, maxIterations: settings.max_iterations }, 'Iteration start');

      // Phase 1: Planning — research and formulate a plan, saved to /app/plan.txt
      logger.info({ phase: 'planning', iteration }, 'Planning phase');
      runCline(buildPlanPrompt());
      logger.info({ phase: 'planning', iteration }, 'Planning complete');

      // Save state: about to start execution
      saveState(null, { iteration, phase: 'execution', currentSlug: null });

      // Phase 2: Execution — read the plan and carry it out
      logger.info({ phase: 'execution', iteration }, 'Execution phase');
      runCline(buildAgentPrompt());
      logger.info({ phase: 'execution', iteration }, 'Execution complete');

      // Save state: about to start git sync
      saveState(null, { iteration, phase: 'git-sync', currentSlug: null });

      // Phase 3: Git sync — commit and push any new/changed files
      logger.info({ phase: 'git-sync', iteration }, 'Git sync phase');
      try {
        const gitResult = spawnSync('node', ['scripts/git-sync.js', '--once'], {
          encoding: 'utf-8',
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (gitResult.stdout?.trim()) {
          logger.info({ output: gitResult.stdout.trim().slice(0, 500) }, 'Git sync output');
        }
        if (gitResult.stderr?.trim()) {
          logger.warn({ stderr: gitResult.stderr.trim() }, 'Git sync stderr');
        }
      } catch (gitError) {
        logger.warn({ err: gitError }, 'Git sync error (non-fatal)');
      }
      logger.info({ phase: 'git-sync', iteration }, 'Git sync complete');

      // Mark iteration complete before reporting progress
      saveState(null, { iteration, phase: 'complete', currentSlug: null });

      // Report progress to orchestrator after each completed iteration
      await reportProgress();

      logger.info({ iteration }, 'Iteration complete');

    } catch (error) {
      logger.error({ err: error, iteration }, 'Iteration failed');

      if (error.message.includes('ETIMEDOUT') || error.message.includes('ECONNREFUSED')) {
        logger.fatal({ err: error, endpoint: BASE_URL }, 'API unreachable — stopping agent');
        process.exit(1);
      }

      logger.warn('Continuing to next iteration');
    }
  }

  logger.info({ totalIterations: iteration }, 'Agent loop completed');
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
