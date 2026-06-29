/**
 * Crash Recovery — State reconciliation for interrupted builds.
 *
 * On startup, scans /app/projects/ for orphaned directories, resumes partial
 * builds, and picks up from the last saved iteration in .agent-state.json.
 *
 * These functions integrate nearly every other module — they're the glue
 * between database, prompts, Cline, tests, API upload, and orchestration.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import path from 'path';
import logger from '../lib/logger.js';
import { loadState } from '../lib/agent-state.js';
import { getDbEntry, updateDatabase } from './database.js';
import {
  parseNextUncheckedTask,
  markTaskDone,
  buildSimpleTaskPrompt,
  buildTaskRetryPrompt
} from './prompt-builder.js';
import { runCline } from './agent.js';
import { runTests } from './test-runner.js';
import { uploadProject } from './api-client.js';
import { checkCanRun, triggerGitSync } from './orchestrator-client.js';

const PROJECTS_DIR = '/app/projects';
const DB_PATH = '/app/db.md';

/**
 * Reconcile project directories on startup.
 * Scans /app/projects/ and handles interrupted builds:
 * - Dir with no plan.md: delete (orphan leftover)
 * - plan.md with unchecked items: resume build
 * - plan.md fully checked: run tests, upload, update db if missing
 * - Dir with db entry already: skip
 *
 * Respects the orchestrator — waits for builder's turn before each Cline call.
 *
 * @param {string} [projectsDir] — Override projects directory (for testing)
 * @param {string} [dbPath] — Override database path (for testing)
 * @param {Function} [checkCanRunFn] — Override orchestrator check function (for testing)
 */
export async function reconcileProjectsDir(
  projectsDir = PROJECTS_DIR,
  dbPath = DB_PATH,
  checkCanRunFn = checkCanRun
) {
  if (!existsSync(projectsDir)) return;

  const entries = readdirSync(projectsDir, { withFileTypes: true });
  const slugs = entries.filter(e => e.isDirectory()).map(e => e.name);

  for (const slug of slugs) {
    const projectDir = path.join(projectsDir, slug);
    const planPath = path.join(projectDir, 'plan.md');

    // Check db first — if already tracked, skip
    const existingStatus = getDbEntry(slug, dbPath);
    if (existingStatus) {
      logger.info({ slug, status: existingStatus }, 'Project already in database — skipping reconciliation');
      continue;
    }

    // Orphan: no plan.md, nothing to recover
    if (!existsSync(planPath)) {
      logger.warn({ slug, projectDir }, 'Orphan directory (no plan.md) — removing');
      rmSync(projectDir, { recursive: true, force: true });
      continue;
    }

    // Has a plan — needs reconciliation
    try {
      const planContent = readFileSync(planPath, 'utf-8');
      const uncheckedCount = (planContent.match(/- \[ \]/g) || []).length;
      let hadSkippedTasks = false;

      if (uncheckedCount > 0) {
        logger.info({ slug, uncheckedCount }, 'Reconciliation: resuming build phases');
        let buildCalls = 0;
        const maxReconcileBuildCalls = 20;
        const taskRetryCount = new Map();
        const MAX_TASK_RETRIES = 3;

        while (buildCalls < maxReconcileBuildCalls) {
          buildCalls++;
          const currentPlan = readFileSync(planPath, 'utf-8');
          const remaining = (currentPlan.match(/- \[ \]/g) || []).length;
          if (remaining === 0) break;

          const task = parseNextUncheckedTask(planPath);
          if (!task) break;

          const retryState = taskRetryCount.get(task.taskText);
          const prompt = retryState
            ? buildTaskRetryPrompt(slug, projectDir, planPath, task, retryState.count, retryState.lastError)
            : buildSimpleTaskPrompt(slug, projectDir, planPath, task);

          logger.info({ slug, task: task.taskText, phase: task.phaseHeading, buildCall: buildCalls }, 'Reconciliation: executing task');
          await checkCanRunFn();
          try {
            await runCline(prompt, process.env.CLINE_PROVIDER || 'lmstudio');
            markTaskDone(planPath, task.lineNumber);
            taskRetryCount.delete(task.taskText);
          } catch (clineErr) {
            const prev = taskRetryCount.get(task.taskText) || { count: 0, lastError: '' };
            const failures = prev.count + 1;
            taskRetryCount.set(task.taskText, { count: failures, lastError: clineErr.message });
            logger.warn({ err: clineErr, slug, buildCall: buildCalls, taskRetries: failures }, 'Reconciliation Cline call failed');

            if (failures >= MAX_TASK_RETRIES) {
              logger.warn({ slug, task: task.taskText, failures }, 'Task failed repeatedly — project may be incomplete');
              hadSkippedTasks = true;
              markTaskDone(planPath, task.lineNumber);
              taskRetryCount.delete(task.taskText);
            }
          }
        }

        if (buildCalls >= maxReconcileBuildCalls) {
          logger.warn({ slug, maxReconcileBuildCalls }, 'Reconciliation: hit max calls, marking incomplete');
        }
      }

      // Re-read plan to verify build completed
      if (existsSync(planPath)) {
        const finalPlan = readFileSync(planPath, 'utf-8');
        const remaining = (finalPlan.match(/- \[ \]/g) || []).length;
        if (remaining > 0) {
          logger.warn({ slug, remaining }, 'Reconciliation: build still incomplete — skipping');
          updateDatabase(slug, slug, 'Incomplete', dbPath);
          continue;
        }
      }

      // Run tests (informational — does not gate git push)
      logger.info({ slug }, 'Reconciliation: running tests');
      const testResult = runTests(projectDir, slug);

      // Upload to API instead of direct git push
      let status = hadSkippedTasks ? 'Incomplete'
        : testResult.passed ? 'Complete'
        : 'Complete (tests failed)';
      logger.info({ slug }, 'Reconciliation: uploading project to API');
      try {
        await uploadProject(slug, slug, status, projectsDir);
      } catch (uploadError) {
        logger.warn({ err: uploadError, slug }, 'API upload error during reconciliation (non-fatal)');
        status = testResult.passed ? 'Built (push failed)' : 'Built (push failed, tests failed)';
      }

      updateDatabase(slug, slug, status, dbPath);

      // Trigger git sync so the project appears on GitHub immediately
      await triggerGitSync();

      logger.info({ slug, status }, 'Reconciliation complete');
    } catch (reconcileError) {
      logger.error({ err: reconcileError, slug }, 'Reconciliation failed for project — leaving for next iteration');
    }
  }
}

/**
 * Recover builder state from a previous crash/restart.
 * 1. Runs reconcileProjectsDir() to handle interrupted builds.
 * 2. Reads .agent-state.json to determine iteration to resume from.
 *
 * Returns the iteration to resume from (0 if fresh start).
 *
 * @param {string} [statePath] — Override state file path (for testing)
 * @param {Function} [checkCanRunFn] — Override orchestrator check function (for testing)
 * @returns {Promise<number>} Iteration to resume from
 */
export async function recoverBuilderState(statePath, checkCanRunFn = checkCanRun) {
  // First, reconcile any interrupted project directories
  await reconcileProjectsDir(undefined, undefined, checkCanRunFn);

  // Then check the state file
  const sp = statePath || undefined;
  const state = loadState(sp);

  if (!state) {
    logger.info('No previous state found — starting from iteration 0');
    return 0;
  }

  logger.info({ savedState: state }, 'Recovering from previous state');

  if (state.phase === 'complete') {
    logger.info({ resumeAt: state.iteration + 1 }, 'Resuming from next iteration');
    return state.iteration;
  }

  // Mid-iteration crash — the iteration was counted but not finished.
  // The reconcileProjectsDir call above will have handled any partial project state.
  logger.warn({ phase: state.phase, iteration: state.iteration, slug: state.currentSlug }, 'Mid-iteration crash detected — recovery completed by reconciliation');
  return state.iteration;
}
