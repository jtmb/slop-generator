#!/usr/bin/env node
/**
 * Agent Runner — Autopilot loop for App Builder.
 *
 * Fetches a random idea from slop-api, checks for duplicates,
 * runs the deep plan → build → test → git push pipeline.
 *
 * Uses Cline CLI for the AI-driven planning and building phases.
 * The agent-runner handles API calls, dedup, test execution, and git.
 *
 * Organized as a thin orchestrator importing from specialized modules:
 *   database.js       — db.md read/write (isAlreadyBuilt, getFailedProjects, etc.)
 *   prompt-builder.js — All Cline prompt generation functions
 *   agent.js          — Cline provider config, hub daemon cleanup, runCline
 *   test-runner.js    — Test suite execution via plan.md
 *   api-client.js     — slop-api HTTP calls (auth, fetch, upload)
 *   orchestrator-client.js — slop-orchestrator coordination
 *   recovery.js       — Crash recovery & project directory reconciliation
 */

import { mkdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import settings from '../config/settings.json' with { type: 'json' };
import logger from '../lib/logger.js';
import { loadState, saveState } from '../lib/agent-state.js';

// Database operations
import {
  isAlreadyBuilt,
  getFailedProjects,
  updateDatabase,
  getDbEntry
} from './database.js';

// Prompt builders (all pure functions)
import {
  buildDeepPlanPrompt,
  buildExecutePrompt,
  parseNextUncheckedTask,
  markTaskDone,
  extractPlanContext,
  buildSimpleTaskPrompt,
  buildTaskRetryPrompt
} from './prompt-builder.js';

// Cline agent management
import { configureProvider, killHubDaemons, runCline } from './agent.js';

// Test execution
import { runTests } from './test-runner.js';

// slop-api client
import { authenticate, fetchRandomIdea, fetchIdeaBySlug, uploadProject } from './api-client.js';

// slop-orchestrator coordination
import { checkCanRun, reportProgress, triggerGitSync, MAX_ORCHESTRATOR_RETRIES } from './orchestrator-client.js';

// Crash recovery
import { reconcileProjectsDir, recoverBuilderState } from './recovery.js';

dotenv.config();

// Wire up log level from settings
logger.level = settings.log_level || 'info';

const PROVIDER = process.env.CLINE_PROVIDER || 'lmstudio';
const BASE_URL = process.env.CLINE_API_BASE_URL || 'http://host.docker.internal:1234/v1';
const MODEL = process.env.CLINE_MODEL || 'qwen/qwen3.5-9b';

// Failed project retry threshold.
// When the number of failed projects in db.md reaches this threshold,
// the builder stops building new projects and retries the oldest failed one instead.
// Set to 0 to disable (always build new projects regardless of failures).
const BUILDER_MAX_FAILED_RETRIES = parseInt(process.env.BUILDER_MAX_FAILED_RETRIES || '3', 10);

const PROJECTS_DIR = path.resolve('/app/projects');
const DB_PATH = '/app/db.md';

/**
 * Main autopilot loop — fetches ideas, builds projects, uploads results.
 */
async function main() {
  logger.info({
    apiBaseUrl: process.env.API_BASE_URL || 'https://slop-api:3443',
    maxIterations: settings.max_iterations
  }, 'App Builder — Autopilot Mode');

  configureProvider(PROVIDER, BASE_URL, MODEL);

  // Recover from crash/restart — reconcile project dirs + resume iteration
  const recoveredIteration = await recoverBuilderState();
  let iteration = recoveredIteration;

  // If recovered from a mid-iteration crash, report progress for that iteration
  if (recoveredIteration > 0) {
    await reportProgress();
  }

  while (true) {
    // Reset iteration counter for new batches — the orchestrator controls pacing
    if (iteration >= settings.max_iterations) {
      logger.info({ previousIteration: iteration }, 'Resetting iteration counter for next batch');
      iteration = 0;
    }

    iteration++;

    try {
      // Check with orchestrator before each iteration
      await checkCanRun();

      // Save state: about to fetch
      saveState(null, { iteration, phase: 'fetch', currentSlug: null });

      logger.info({ iteration, maxIterations: settings.max_iterations }, 'Iteration start');

      // Step 0: Check for failed projects that need retrying
      let idea = null;

      if (BUILDER_MAX_FAILED_RETRIES > 0) {
        const failedProjects = getFailedProjects(DB_PATH);
        if (failedProjects.length >= BUILDER_MAX_FAILED_RETRIES) {
          const target = failedProjects[0]; // oldest first
          logger.info({
            failedCount: failedProjects.length,
            threshold: BUILDER_MAX_FAILED_RETRIES,
            retrySlug: target.slug,
            retryName: target.name
          }, 'Failed project threshold reached — retrying oldest failed project');
          idea = await fetchIdeaBySlug(target.slug);
          if (idea) {
            logger.info({ slug: target.slug, name: idea.name }, 'Retrying failed project');
          } else {
            logger.warn({ slug: target.slug }, 'Failed project not found in API — removing from retry consideration');
            updateDatabase(target.slug, target.name, 'Removed (idea not found in API)', DB_PATH);
          }
        }
      }

      // Step 1: Fetch random idea + dedup (only if not retrying)
      if (!idea) {
        logger.info({ iteration }, 'Fetching random idea');
        let attempts = 0;
        const maxFetchAttempts = 10;

        while (attempts < maxFetchAttempts) {
          attempts++;
          idea = await fetchRandomIdea();
          logger.info({ name: idea.name, slug: idea.slug, attempt: attempts }, 'Got idea');

          if (!isAlreadyBuilt(idea.slug, DB_PATH)) {
            break; // New project — proceed
          }

          logger.info({ attempt: attempts, slug: idea.slug }, 'Already built — fetching another');
          idea = null;
        }
      }

      if (!idea) {
        logger.info('No new ideas available — sleeping 60s before retry');
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }

      const slug = idea.slug;
      const projectDir = path.join(PROJECTS_DIR, slug);
      const planPath = path.join(projectDir, 'plan.md');

      // Guard against EEXIST — if dir already exists, reconcile instead of crashing
      if (existsSync(projectDir)) {
        logger.warn({ slug, projectDir }, 'Project directory already exists — running reconciliation');
        try {
          const existingPlan = existsSync(planPath) ? readFileSync(planPath, 'utf-8') : '';
          const uncheckedCount = (existingPlan.match(/- \[ \]/g) || []).length;
          let hadSkippedTasks = false;
          if (uncheckedCount > 0) {
            let buildCalls = 0;
            const maxReconcileBuildCalls = 20;
            const taskRetryCount = new Map();
            const MAX_TASK_RETRIES = 3;
            while (buildCalls < maxReconcileBuildCalls) {
              buildCalls++;
              const plan = readFileSync(planPath, 'utf-8');
              if ((plan.match(/- \[ \]/g) || []).length === 0) break;

              const task = parseNextUncheckedTask(planPath);
              if (!task) break;

              const retryState = taskRetryCount.get(task.taskText);
              const prompt = retryState
                ? buildTaskRetryPrompt(slug, projectDir, planPath, task, retryState.count, retryState.lastError)
                : buildSimpleTaskPrompt(slug, projectDir, planPath, task);

              await checkCanRun();
              try {
                await runCline(prompt, PROVIDER);
                markTaskDone(planPath, task.lineNumber);
                taskRetryCount.delete(task.taskText);
              } catch (clineErr) {
                const prev = taskRetryCount.get(task.taskText) || { count: 0, lastError: '' };
                const failures = prev.count + 1;
                taskRetryCount.set(task.taskText, { count: failures, lastError: clineErr.message });
                logger.warn({ err: clineErr, slug, buildCall: buildCalls, taskRetries: failures },
                  'Directory reconciliation Cline call failed');
                if (failures >= MAX_TASK_RETRIES) {
                  logger.warn({ slug, task: task.taskText, failures }, 'Task failed repeatedly — project may be incomplete');
                  hadSkippedTasks = true;
                  markTaskDone(planPath, task.lineNumber);
                  taskRetryCount.delete(task.taskText);
                }
              }
            }
          }
          const testResult = runTests(projectDir, slug);
          const finalStatus = hadSkippedTasks ? 'Incomplete'
            : testResult.passed ? 'Complete'
            : 'Complete (tests failed)';
          updateDatabase(slug, idea.name, finalStatus, DB_PATH);
        } catch (reconcileError) {
          logger.error({ err: reconcileError, slug }, 'Directory reconciliation failed');
        }
        continue;
      }

      mkdirSync(projectDir, { recursive: true });

      // Save state: about to plan
      saveState(null, { iteration, phase: 'planning', currentSlug: slug });

      // Step 2: Deep Planning Phase — retry if plan.md is not created
      logger.info({ slug, iteration, phase: 'planning' }, 'Deep planning phase');
      const MAX_PLAN_RETRIES = 3;
      let planCreated = false;
      for (let planAttempt = 0; planAttempt < MAX_PLAN_RETRIES; planAttempt++) {
        await checkCanRun();
        try {
          await runCline(buildDeepPlanPrompt(idea), PROVIDER);
        } catch (planErr) {
          logger.warn({ err: planErr, slug, planAttempt }, 'Planning Cline call failed');
        }
        if (existsSync(planPath)) {
          planCreated = true;
          logger.info({ slug, iteration, phase: 'planning' }, 'Planning complete — plan.md created');
          break;
        }
        logger.warn({ slug, planAttempt: planAttempt + 1, maxRetries: MAX_PLAN_RETRIES }, 'plan.md not created — retrying planning');
      }

      if (!planCreated) {
        logger.error({ slug, iteration }, 'Planning failed after retries — skipping project');
        updateDatabase(slug, idea.name, 'Incomplete', DB_PATH);
        saveState(null, { iteration, phase: 'complete', currentSlug: slug });
        await reportProgress();
        continue;
      }

      // Save state: about to build
      saveState(null, { iteration, phase: 'building', currentSlug: slug });

      // Step 3: Build Phase — execute one phase at a time
      logger.info({ slug, iteration, phase: 'build' }, 'Build phase');
      let buildCalls = 0;
      const maxBuildCalls = 25;
      const taskRetryCount = new Map();
      const MAX_TASK_RETRIES = 3;
      let hadSkippedTasks = false;

      while (buildCalls < maxBuildCalls) {
        buildCalls++;

        if (!existsSync(planPath)) {
          logger.error({ projectDir, slug }, 'plan.md not found — build cannot proceed');
          break;
        }

        const planContent = readFileSync(planPath, 'utf-8');
        const uncheckedCount = (planContent.match(/- \[ \]/g) || []).length;

        if (uncheckedCount === 0) {
          logger.info({ slug, totalBuildCalls: buildCalls }, 'All plan items checked — build complete');
          break;
        }

        const task = parseNextUncheckedTask(planPath);
        if (!task) break;

        const retryState = taskRetryCount.get(task.taskText);
        const prompt = retryState
          ? buildTaskRetryPrompt(slug, projectDir, planPath, task, retryState.count, retryState.lastError)
          : buildSimpleTaskPrompt(slug, projectDir, planPath, task);

        logger.info({ slug, task: task.taskText, phase: task.phaseHeading, buildCall: buildCalls }, 'Executing task');
        await checkCanRun();
        try {
          await runCline(prompt, PROVIDER);
          markTaskDone(planPath, task.lineNumber);
          taskRetryCount.delete(task.taskText);
        } catch (clineErr) {
          const prev = taskRetryCount.get(task.taskText) || { count: 0, lastError: '' };
          const failures = prev.count + 1;
          taskRetryCount.set(task.taskText, { count: failures, lastError: clineErr.message });
          logger.warn({ err: clineErr, slug, buildCall: buildCalls, taskRetries: failures }, 'Cline call failed');

          if (failures >= MAX_TASK_RETRIES) {
            logger.warn({ slug, task: task.taskText, failures }, 'Task failed repeatedly — project may be incomplete');
            hadSkippedTasks = true;
            markTaskDone(planPath, task.lineNumber);
            taskRetryCount.delete(task.taskText);
          }
        }
      }

      if (buildCalls >= maxBuildCalls) {
        logger.warn({ slug, maxBuildCalls }, 'Build hit max call cap — stopping');
      }

      // Re-read plan to check if build actually finished all phases
      let buildComplete = false;
      if (existsSync(planPath)) {
        const finalPlan = readFileSync(planPath, 'utf-8');
        const remaining = (finalPlan.match(/- \[ \]/g) || []).length;
        if (remaining === 0 && !hadSkippedTasks) {
          buildComplete = true;
          logger.info({ slug, iteration, phase: 'build', totalBuildCalls: buildCalls }, 'Build complete');
        } else if (remaining === 0 && hadSkippedTasks) {
          logger.warn({ slug, totalBuildCalls: buildCalls }, 'Build finished but tasks were skipped — marking Incomplete');
        } else {
          logger.warn({ slug, remaining, totalBuildCalls: buildCalls }, 'Build incomplete — skipping tests and git push');
        }
      }

      // Skip incomplete projects — don't test/push garbage
      if (!buildComplete) {
        updateDatabase(slug, idea.name, 'Incomplete', DB_PATH);
        saveState(null, { iteration, phase: 'complete', currentSlug: slug });
        await reportProgress();
        logger.info({ slug, iteration, status: 'Incomplete' }, 'Iteration complete (incomplete build)');
        continue;
      }

      // Save state: about to test
      saveState(null, { iteration, phase: 'testing', currentSlug: slug });

      // Step 4: Test Phase (informational — does not gate git push)
      logger.info({ slug, iteration, phase: 'test' }, 'Test phase');
      const testResult = runTests(projectDir, slug);
      logger.info({ slug, iteration, phase: 'test', passed: testResult.passed }, 'Test phase complete');

      // Save state: about to upload project
      saveState(null, { iteration, phase: 'project-upload', currentSlug: slug });

      // Step 5: Upload project to slop-api
      logger.info({ slug, iteration, phase: 'project-upload' }, 'Uploading project to API');
      let status = testResult.passed ? 'Complete' : 'Complete (tests failed)';
      try {
        await uploadProject(slug, idea.name, status, PROJECTS_DIR);
        await triggerGitSync();
      } catch (uploadError) {
        logger.warn({ err: uploadError, slug }, 'Project upload failed (non-fatal)');
        status = 'Built (push failed)';
      }
      logger.info({ slug, iteration, phase: 'project-upload', status }, 'Project upload complete');

      // Save state: about to update database
      saveState(null, { iteration, phase: 'db-update', currentSlug: slug });

      // Step 6: Update database
      updateDatabase(slug, idea.name, status, DB_PATH);

      // Mark iteration complete
      saveState(null, { iteration, phase: 'complete', currentSlug: slug });

      await reportProgress();

      logger.info({ iteration, name: idea.name, slug, status }, 'Iteration complete');

    } catch (error) {
      logger.error({ err: error, iteration }, 'Iteration failed');

      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ERR_BAD_RESPONSE') {
        logger.warn({ err: error }, 'API or LM Studio unreachable — will retry next iteration');
      }

      logger.warn('Continuing to next iteration');
      continue;
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

// Re-export everything for backward compat with tests that import from agent-runner.js
export {
  // From database.js
  isAlreadyBuilt,
  getFailedProjects,
  updateDatabase,
  getDbEntry,

  // From prompt-builder.js
  buildDeepPlanPrompt,
  buildExecutePrompt,
  parseNextUncheckedTask,
  markTaskDone,
  extractPlanContext,
  buildSimpleTaskPrompt,
  buildTaskRetryPrompt,

  // From agent.js
  configureProvider,
  killHubDaemons,
  runCline,

  // From test-runner.js
  runTests,

  // From api-client.js
  authenticate,
  fetchRandomIdea,
  fetchIdeaBySlug,
  uploadProject,

  // From orchestrator-client.js
  checkCanRun,
  reportProgress,
  triggerGitSync,
  MAX_ORCHESTRATOR_RETRIES,

  // From recovery.js
  reconcileProjectsDir,
  recoverBuilderState,

  // From lib/agent-state.js
  loadState,
  saveState,
};
