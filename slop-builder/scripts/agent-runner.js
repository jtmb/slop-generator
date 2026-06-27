#!/usr/bin/env node
/**
 * Agent Runner — Autopilot loop for App Builder.
 *
 * Fetches a random idea from slop-api, checks for duplicates,
 * runs the deep plan → build → test → git push pipeline.
 *
 * Uses cline CLI for the AI-driven planning and building phases.
 * The agent-runner handles API calls, dedup, test execution, and git.
 */

import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import https from 'https';
import http from 'http';
import dotenv from 'dotenv';
import settings from '../config/settings.json' with { type: 'json' };
import logger from '../lib/logger.js';
import { loadState, saveState } from '../lib/agent-state.js';
import axios from 'axios';

dotenv.config();

// Wire up log level from settings
logger.level = settings.log_level || 'info';

const PROVIDER = process.env.CLINE_PROVIDER || 'lmstudio';
const BASE_URL = process.env.CLINE_API_BASE_URL || 'http://host.docker.internal:1234/v1';
const MODEL = process.env.CLINE_MODEL || 'qwen/qwen3.5-9b';

// slop-api access
const API_BASE_URL = process.env.API_BASE_URL || 'https://slop-api:3443';
const API_KEY = process.env.API_KEY || '';

// slop-orchestrator coordination
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://slop-orchestrator:3444';

const orch = axios.create({
  baseURL: ORCHESTRATOR_URL,
  // keepAlive: false to avoid EPIPE on reused sockets
  httpAgent: new http.Agent({ keepAlive: false }),
  timeout: 10000,
});

// Self-signed cert on internal Docker network
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const PROJECTS_DIR = path.resolve('/app/projects');
const DB_PATH = '/app/db.md';

/** Shared axios instance for slop-api calls. */
const api = axios.create({
  baseURL: API_BASE_URL,
  httpsAgent,
  timeout: 30000,
});

let jwtToken = null;

/**
 * Configure cline provider by writing providers.json.
 * Same pattern as slop-planner.
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
 * Uses spawnSync with argument array to avoid shell quoting issues.
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
 * Authenticate with slop-api and cache the JWT token.
 */
async function authenticate() {
  if (jwtToken) return jwtToken;

  logger.info({ apiBaseUrl: API_BASE_URL }, 'Authenticating with slop-api');
  const { data } = await api.post('/api/v1/auth/token', { api_key: API_KEY });
  jwtToken = data.token;
  logger.info('Authenticated');
  return jwtToken;
}

/**
 * Fetch a random idea from slop-api.
 * Returns the full idea JSON or null on failure.
 */
async function fetchRandomIdea() {
  const token = await authenticate();
  const { data } = await api.get('/api/v1/ideas/random', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data;
}

/**
 * Check if a slug has already been completed by the builder.
 * Reads the builder's own db.md.
 */
function isAlreadyBuilt(slug) {
  if (!existsSync(DB_PATH)) return false;

  const content = readFileSync(DB_PATH, 'utf-8');

  // Match entries with this slug that have status "Complete" or "Tests Failed"
  const entryRegex = new RegExp(
    `## Project #\\d+: .+\\n- \\*\\*Slug\\*\\*: \`${slug}\`\\n- \\*\\*Status\\*\\*: (Complete|Tests Failed)`,
    'i'
  );

  return entryRegex.test(content);
}

/**
 * Build the deep planning prompt for cline.
 * Injects the idea JSON so cline can do framework research and write plan.md.
 */
function buildDeepPlanPrompt(idea) {
  const ideaJson = JSON.stringify(idea, null, 2);

  return `You are the **Planning Module** of the App Builder.

Read the file AGENTS.md from the current working directory to understand your role and workflow.

Then, execute ONLY the Deep Planning Phase (Phase 1) from AGENTS.md.

Here is the app idea to plan (as JSON):

\`\`\`json
${ideaJson}
\`\`\`

Follow these steps EXACTLY:
1. Read the idea carefully — note the category, features, audience, and tech suggestions.
2. Research and decide the BEST framework stack for this specific idea. Do NOT blindly copy the idea's suggestions. Think critically about what framework fits this domain, scale, and feature set.
3. Read the .clinerules/instructions/ files that match your chosen stack (at minimum: api-design.instructions.md, containers.instructions.md, and the language/framework specific ones).
4. Create the directory /app/projects/${idea.slug}/ (use your file system tools).
5. Write /app/projects/${idea.slug}/plan.md — use the EXACT template from AGENTS.md Phase 1.4. Fill in EVERY section: Framework Decision with rationale, Applicable .clinerules, and all 7 phases with specific tasks (not generic — match the idea's actual features).

IMPORTANT: Do NOT create any code yet. Do NOT modify db.md. Just research, plan, and write plan.md.`;
}

/**
 * Build the execution prompt for cline.
 * Instructs cline to read plan.md and execute the next unchecked phase.
 */
function buildExecutePrompt(projectDir, planPath) {
  return `You are the **Execution Module** of the App Builder.

Read the file AGENTS.md from the current working directory to understand your role and workflow.

Then, execute the NEXT UNCHECKED PHASE from the plan at ${planPath}.

Follow these steps EXACTLY:
1. Read ${planPath} to find the first phase with any unchecked \`- [ ]\` items.
2. Read the .clinerules/instructions/ files listed in the plan's "Applicable .clinerules" section.
3. Execute ALL unchecked items in that phase — write actual code, not stubs.
4. As you complete each item, update plan.md: change \`- [ ]\` to \`- [x]\`.
5. Follow all AGENTS.md conventions: comments, error handling, secure coding, naming, reusable code.

STOP after completing ONE phase. Do not start the next phase.

IMPORTANT: You MUST use your file system tools to create and edit files. Write real, production-quality code.`;
}

/**
 * Run the project's test suite as defined in plan.md.
 * Returns true if all tests pass.
 */
function runTests(projectDir, slug) {
  const planPath = path.join(projectDir, 'plan.md');

  if (!existsSync(planPath)) {
    logger.error({ projectDir, slug }, 'No plan.md found — cannot determine test command');
    return false;
  }

  const planContent = readFileSync(planPath, 'utf-8');

  // Extract the test command from plan.md: last line after "## Test Command" or "`npm test`" pattern
  let testCmd = null;
  const testCmdMatch = planContent.match(/## Test Command\s*\n`([^`]+)`/);
  if (testCmdMatch) {
    testCmd = testCmdMatch[1].trim();
  } else {
    // Fallback: try to find any backtick command near "test"
    const fallbackMatch = planContent.match(/`(npm test[^`]*|npm run test[^`]*|yarn test[^`]*|npx vitest[^`]*|pytest[^`]*|go test[^`]*|cargo test[^`]*)`/);
    if (fallbackMatch) testCmd = fallbackMatch[1].trim();
  }

  if (!testCmd) {
    logger.error({ projectDir, slug }, 'Could not determine test command from plan.md');
    return false;
  }

  logger.info({ testCmd, projectDir, slug }, 'Running tests');

  for (let attempt = 1; attempt <= settings.max_test_retries; attempt++) {
    logger.info({ attempt, maxAttempts: settings.max_test_retries, slug }, 'Test attempt');

    const result = spawnSync('bash', ['-c', testCmd], {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.status === 0) {
      logger.info({ slug, attempt }, 'All tests passed');
      return true;
    }

    const output = (result.stdout || '') + '\n' + (result.stderr || '');
    logger.error({ slug, attempt, output: output.substring(0, 500) }, 'Tests failed');

    if (attempt < settings.max_test_retries) {
      logger.info({ slug }, 'Retrying tests');
    }
  }

  // All retries exhausted — log failure details
  const failuresPath = path.join(projectDir, 'test-failures.txt');
  writeFileSync(failuresPath, `Tests failed after ${settings.max_test_retries} attempts.\n`);
  logger.error({ slug, maxAttempts: settings.max_test_retries, failuresPath }, 'Tests exhausted all retries');
  return false;
}

/**
 * Update the builder's db.md with a new (or updated) project entry.
 */
function updateDatabase(slug, ideaName, status) {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  let dbContent = '';
  if (existsSync(DB_PATH)) {
    dbContent = readFileSync(DB_PATH, 'utf-8');
  }

  // Check if entry already exists
  const entryRegex = new RegExp(`## Project #\\d+: .+\\n- \\*\\*Slug\\*\\*: \`${slug}\``);
  if (entryRegex.test(dbContent)) {
    // Update status line AFTER the slug line (not before — the old regex had them swapped and never matched)
    const lines = dbContent.split('\n');
    let inEntry = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`\`${slug}\``) && lines[i].startsWith('- **Slug**')) {
        inEntry = true;
        continue;
      }
      if (inEntry && lines[i].startsWith('- **Status**:')) {
        lines[i] = `- **Status**: ${status}`;
        break;
      }
      if (inEntry && lines[i].startsWith('## ')) {
        break; // Next entry — shouldn't happen, but safe
      }
    }
    dbContent = lines.join('\n');
  } else {
    // Count existing projects for next ID
    const countMatch = dbContent.match(/## Total Projects Built: (\d+)/);
    const nextId = countMatch ? parseInt(countMatch[1], 10) + 1 : 1;
    const date = new Date().toISOString().split('T')[0];

    const entry = [
      '',
      `## Project #${nextId}: ${ideaName}`,
      `- **Slug**: \`${slug}\``,
      `- **Status**: ${status}`,
      `- **Date Completed**: ${date}`,
      '',
    ].join('\n');

    if (countMatch) {
      dbContent = dbContent.replace(
        /## Total Projects Built: \d+/,
        `## Total Projects Built: ${nextId}`
      );
    } else {
      dbContent = `## Total Projects Built: ${nextId}\n\n`;
    }
    dbContent += entry;
  }

  writeFileSync(DB_PATH, dbContent);
}

/**
 * Look up a project's status from db.md.
 * Returns the status string or null if no entry found.
 *
 * @param {string} slug
 * @param {string} [dbPath] - Override database path (for testing)
 */
function getDbEntry(slug, dbPath = DB_PATH) {
  if (!existsSync(dbPath)) return null;

  const content = readFileSync(dbPath, 'utf-8');
  const lines = content.split('\n');
  let inEntry = false;

  for (const line of lines) {
    if (line.includes(`\`${slug}\``) && line.startsWith('- **Slug**')) {
      inEntry = true;
      continue;
    }
    if (inEntry && line.startsWith('- **Status**')) {
      return line.replace('- **Status**: ', '').trim();
    }
    if (inEntry && line.startsWith('## ')) {
      break;
    }
  }

  return null;
}

/**
 * Reconcile project directories on startup.
 * Scans /app/projects/ and handles interrupted builds:
 * - Dir with no plan.md: delete (orphan leftover)
 * - plan.md with unchecked items: resume build
 * - plan.md fully checked: run tests, push, update db if missing
 * - Dir with db entry already: skip
 *
 * Respects the orchestrator — waits for builder's turn before each cline call.
 *
 * @param {string} [projectsDir] - Override projects directory (for testing)
 * @param {string} [dbPath] - Override database path (for testing)
 * @param {Function} [checkCanRunFn] - Override orchestrator check function (for testing)
 */
async function reconcileProjectsDir(projectsDir = PROJECTS_DIR, dbPath = DB_PATH, checkCanRunFn = checkCanRun) {
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

      if (uncheckedCount > 0) {
        logger.info({ slug, uncheckedCount }, 'Reconciliation: resuming build phases');
        const maxBuildCalls = 10;
        let buildCalls = 0;

        while (buildCalls < maxBuildCalls) {
          buildCalls++;
          const currentPlan = readFileSync(planPath, 'utf-8');
          const remaining = (currentPlan.match(/- \[ \]/g) || []).length;
          if (remaining === 0) break;

          logger.info({ slug, remaining, buildCall: buildCalls }, 'Reconciliation: executing next phase');
          await checkCanRunFn();
          runCline(buildExecutePrompt(projectDir, planPath));
        }
      }

      // Run tests
      logger.info({ slug }, 'Reconciliation: running tests');
      const testsPassed = runTests(projectDir, slug);

      // Push to git
      let status = 'Complete';
      if (testsPassed) {
        logger.info({ slug }, 'Reconciliation: pushing to git');
        try {
          spawnSync('node', [
            'scripts/git-sync.js',
            '--once',
            '--slug', slug,
            '--message', `feat(build): complete ${slug} (recovered after restart)`,
          ], {
            encoding: 'utf-8',
            timeout: 120000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (gitError) {
          logger.warn({ err: gitError, slug }, 'Git sync error during reconciliation (non-fatal)');
          status = 'Built (push failed)';
        }
      } else {
        status = 'Tests Failed';
      }

      updateDatabase(slug, slug, status);
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
 * @param {string} [statePath] - Override state file path (for testing)
 * @param {Function} [checkCanRunFn] - Override orchestrator check function (for testing)
 */
async function recoverBuilderState(statePath, checkCanRunFn = checkCanRun) {
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


/**
 * Poll the orchestrator until it's our turn to run.
 * Does NOT fail open — if the orchestrator is unreachable,
 * retries with backoff until it responds. Never proceeds without coordination.
 */
const MAX_ORCHESTRATOR_RETRIES = 10;

async function checkCanRun() {
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
 */
async function reportProgress() {
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
 * Main autopilot loop.
 */
async function main() {
  logger.info({ apiBaseUrl: API_BASE_URL, maxIterations: settings.max_iterations }, 'App Builder — Autopilot Mode');

  configureProvider();

  // Recover from crash/restart — reconcile project dirs + resume iteration
  const recoveredIteration = await recoverBuilderState();
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

      // Save state: about to fetch
      saveState(null, { iteration, phase: 'fetch', currentSlug: null });

      logger.info({ iteration, maxIterations: settings.max_iterations }, 'Iteration start');

      // Step 1: Fetch random idea + dedup
      logger.info({ iteration }, 'Fetching random idea');
      let idea;
      let attempts = 0;
      const maxFetchAttempts = 10;

      while (attempts < maxFetchAttempts) {
        attempts++;
        idea = await fetchRandomIdea();
        logger.info({ name: idea.name, slug: idea.slug, attempt: attempts }, 'Got idea');

        if (!isAlreadyBuilt(idea.slug)) {
          break; // New project — proceed
        }

        logger.info({ attempt: attempts, slug: idea.slug }, 'Already built — fetching another');
        idea = null;
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
          if (uncheckedCount > 0) {
            let buildCalls = 0;
            while (buildCalls < 10) {
              buildCalls++;
              const plan = readFileSync(planPath, 'utf-8');
              if ((plan.match(/- \[ \]/g) || []).length === 0) break;
              runCline(buildExecutePrompt(projectDir, planPath));
            }
          }
          const testsPassed = runTests(projectDir, slug);
          const finalStatus = testsPassed ? 'Complete' : 'Tests Failed';
          updateDatabase(slug, idea.name, finalStatus);
        } catch (reconcileError) {
          logger.error({ err: reconcileError, slug }, 'Directory reconciliation failed');
        }
        continue;
      }

      mkdirSync(projectDir, { recursive: true });

      // Save state: about to plan
      saveState(null, { iteration, phase: 'planning', currentSlug: slug });

      // Step 2: Deep Planning Phase
      logger.info({ slug, iteration, phase: 'planning' }, 'Deep planning phase');
      runCline(buildDeepPlanPrompt(idea));
      logger.info({ slug, iteration, phase: 'planning' }, 'Planning complete');

      // Save state: about to build
      saveState(null, { iteration, phase: 'building', currentSlug: slug });

      // Step 3: Build Phase — execute one phase at a time
      logger.info({ slug, iteration, phase: 'build' }, 'Build phase');
      const maxBuildCalls = 10; // Safety limit
      let buildCalls = 0;

      while (buildCalls < maxBuildCalls) {
        buildCalls++;

        // Read plan.md to check if all items are done
        if (!existsSync(planPath)) {
          logger.error({ projectDir, slug }, 'plan.md not found — build cannot proceed');
          break;
        }

        const planContent = readFileSync(planPath, 'utf-8');
        const uncheckedCount = (planContent.match(/- \[ \]/g) || []).length;

        if (uncheckedCount === 0) {
          logger.info({ slug }, 'All plan items checked — build complete');
          break;
        }

        logger.info({ slug, uncheckedCount, buildCall: buildCalls }, 'Executing next phase');
        runCline(buildExecutePrompt(projectDir, planPath));
      }
      logger.info({ slug, iteration, phase: 'build' }, 'Build complete');

      // Save state: about to test
      saveState(null, { iteration, phase: 'testing', currentSlug: slug });

      // Step 4: Test Phase
      logger.info({ slug, iteration, phase: 'test' }, 'Test phase');
      const testsPassed = runTests(projectDir, slug);

      if (!testsPassed) {
        logger.warn({ slug }, 'Tests failed — skipping git push');
        updateDatabase(slug, idea.name, 'Tests Failed');

        // Mark iteration complete even for failed builds
        saveState(null, { iteration, phase: 'complete', currentSlug: slug });
        continue;
      }
      logger.info({ slug, iteration, phase: 'test' }, 'Tests complete');

      // Save state: about to git push
      saveState(null, { iteration, phase: 'git-push', currentSlug: slug });

      // Step 5: Git Push
      logger.info({ slug, iteration, phase: 'git-push' }, 'Git push phase');
      let status = 'Complete';
      try {
        const gitResult = spawnSync('node', [
          'scripts/git-sync.js',
          '--once',
          '--slug', slug,
          '--message', `feat(build): complete ${idea.name}`,
        ], {
          encoding: 'utf-8',
          timeout: 120000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (gitResult.stdout?.trim()) {
          logger.info({ output: gitResult.stdout.trim().slice(0, 500) }, 'Git push output');
        }
        if (gitResult.stderr?.trim()) {
          logger.warn({ stderr: gitResult.stderr.trim() }, 'Git push stderr');
        }
        if (gitResult.status !== 0) {
          logger.warn({ slug, exitCode: gitResult.status }, 'Git push non-zero exit (non-fatal)');
          status = 'Built (push failed)';
        }
      } catch (gitError) {
        logger.warn({ err: gitError, slug }, 'Git sync error (non-fatal)');
        status = 'Built (push failed)';
      }
      logger.info({ slug, iteration, phase: 'git-push' }, 'Git push complete');

      // Save state: about to update database
      saveState(null, { iteration, phase: 'db-update', currentSlug: slug });

      // Step 6: Update database
      updateDatabase(slug, idea.name, status);

      // Mark iteration complete
      saveState(null, { iteration, phase: 'complete', currentSlug: slug });

      // Report progress to orchestrator after each completed iteration
      await reportProgress();

      logger.info({ iteration, name: idea.name, slug, status }, 'Iteration complete');

    } catch (error) {
      logger.error({ err: error, iteration }, 'Iteration failed');

      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ERR_BAD_RESPONSE') {
        logger.warn({ err: error }, 'API unreachable — will retry next iteration');
      }

      if (error.message.includes('ETIMEDOUT') || error.message.includes('ECONNREFUSED')) {
        logger.fatal({ err: error }, 'Cannot reach services — stopping');
        process.exit(1);
      }

      logger.warn('Continuing to next iteration');
    }
  }

  logger.info({ totalIterations: iteration }, 'Builder loop completed');
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

export { configureProvider, runCline, isAlreadyBuilt, runTests, updateDatabase, buildDeepPlanPrompt, buildExecutePrompt, authenticate, fetchRandomIdea, checkCanRun, reportProgress, getDbEntry, reconcileProjectsDir, recoverBuilderState, loadState, saveState };
