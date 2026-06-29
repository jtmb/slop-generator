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

import { spawnSync, spawn } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, createReadStream } from 'fs';
import { homedir } from 'os';
import path from 'path';
import https from 'https';
import http from 'http';
import dotenv from 'dotenv';
import settings from '../config/settings.json' with { type: 'json' };
import logger from '../lib/logger.js';
import { loadState, saveState } from '../lib/agent-state.js';
import axios from 'axios';
import FormData from 'form-data';

dotenv.config();

// Wire up log level from settings
logger.level = settings.log_level || 'info';

const PROVIDER = process.env.CLINE_PROVIDER || 'lmstudio';
const BASE_URL = process.env.CLINE_API_BASE_URL || 'http://host.docker.internal:1234/v1';
const MODEL = process.env.CLINE_MODEL || 'qwen/qwen3.5-9b';

// slop-api access
const API_BASE_URL = process.env.API_BASE_URL || 'https://slop-api:3443';
const API_KEY = process.env.API_KEY || '';

// Failed project retry threshold.
// When the number of failed projects in db.md reaches this threshold,
// the builder stops building new projects and retries the oldest failed one instead.
// Set to 0 to disable (always build new projects regardless of failures).
const BUILDER_MAX_FAILED_RETRIES = parseInt(process.env.BUILDER_MAX_FAILED_RETRIES || '3', 10);

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
 * Kill any stale Cline hub daemon processes.
 * The hub daemon caches session state and rejects hooks from new Cline instances,
 * causing "hook dispatch failed" errors and 5-minute timeouts on every call.
 * Killing it before each run forces a fresh session each time.
 */
function killHubDaemons() {
  try {
    // List /proc, find processes whose cmdline contains "hub-daemon"
    const procDirs = readdirSync('/proc').filter(d => /^\d+$/.test(d));
    for (const pidStr of procDirs) {
      try {
        const cmdline = readFileSync(`/proc/${pidStr}/cmdline`, 'utf-8').replace(/\0/g, ' ');
        if (cmdline.includes('hub-daemon')) {
          process.kill(parseInt(pidStr, 10), 'SIGKILL');
          logger.info({ pid: parseInt(pidStr, 10) }, 'Killed stale Cline hub daemon');
        }
      } catch (_) {
        // Process exited between listing and reading — ignore
      }
    }
  } catch (_) {
    // /proc not available — ignore (Windows or locked-down container)
  }
}

/**
 * Run a single cline command with heartbeat logging during execution.
 * Uses async spawn so Node's event loop stays alive — Pino logs flush in
 * real time and the 60s heartbeat proves the process isn't stuck.
 *
 * Cline stdout/stderr is streamed to Pino at trace level so you can see
 * every tool call and model response as it happens.
 */
function runCline(prompt) {
  return new Promise((resolve, reject) => {
    killHubDaemons();

    // -t 900: 15-minute timeout — ample for complex tasks now that Cline can
    //          use write_to_file natively (no more node -e double-escaping).
    // --retries 8: modest Cline-level retries — JS wrapper has its own retry
    //              logic via buildTaskRetryPrompt().
    // --thinking high: better code quality than default medium.
    // -c /app: explicit working directory.
    const args = ['-P', PROVIDER, '--json', '--auto-approve', 'true', '--thinking', 'high', '-c', '/app', '-t', '900', '--retries', '8', prompt];
    logger.info({ promptPreview: prompt.substring(0, 80) }, 'Cline started');

    const child = spawn('cline', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let lastOutput = '';  // Last meaningful line for heartbeat context

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      // Log each line at trace level so we can see Cline's tool calls
      const lines = text.trim().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          lastOutput = line.length > 200 ? line.substring(0, 200) + '…' : line;
        }
      }
      logger.debug({ clineOut: text.substring(0, 500) }, 'Cline output');
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (text.trim()) {
        logger.warn({ clineErr: text.substring(0, 300) }, 'Cline stderr');
      }
    });

    const startTime = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const lineCount = stdout.split('\n').filter(l => l.trim()).length;
      logger.info({
        elapsedSec: elapsed,
        lineCount,
        lastOutput: lastOutput.substring(0, 200) || '(no output yet)'
      }, 'Cline still running');
    }, 60000);

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      clearInterval(heartbeat);
      reject(new Error('Cline timed out after 16 minutes'));
    }, 960000); // 1 min safety margin beyond Cline's 15-min timeout

    child.on('close', (code) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);

      if (code !== 0) {
        const msg = stderr.trim() || stdout.trim() || `Exit code ${code}`;
        reject(new Error(msg));
      } else {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const lineCount = stdout.split('\n').filter(l => l.trim()).length;
        logger.info({ elapsedSec: elapsed, lineCount }, 'Cline finished');
        resolve(stdout);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      reject(err);
    });
  });
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
 * Handles JWT expiry by clearing the cached token and re-authenticating once.
 */
async function fetchRandomIdea() {
  const token = await authenticate();
  try {
    const { data } = await api.get('/api/v1/ideas/random', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return data;
  } catch (err) {
    // JWT expired — clear cached token and retry once with fresh auth
    if (err.response?.status === 401 || err.response?.status === 403) {
      jwtToken = null;
      logger.warn('JWT expired, re-authenticating');
      const newToken = await authenticate();
      const { data } = await api.get('/api/v1/ideas/random', {
        headers: { Authorization: `Bearer ${newToken}` },
      });
      return data;
    }
    throw err;
  }
}

/**
 * Check if a slug has already been completed by the builder.
 * Reads the builder's own db.md.
 */
function isAlreadyBuilt(slug) {
  if (!existsSync(DB_PATH)) return false;

  const content = readFileSync(DB_PATH, 'utf-8');

  // Match entries with this slug that are already processed
  // "Complete", "Complete (tests failed)", "Tests Failed", "Built (push failed)" all count as done
  const entryRegex = new RegExp(
    `## Project #\\d+: .+\\n- \\*\\*Slug\\*\\*: \`${slug}\`\\n- \\*\\*Status\\*\\*: (Complete|Complete \\(tests failed\\)|Tests Failed|Built \\(push failed\\))`,
    'i'
  );

  return entryRegex.test(content);
}

/**
 * Count failed projects in db.md and return them sorted oldest-first.
 * A project is "failed" if its status indicates the build completed but
 * didn't result in a successful push (upload or tests failed).
 *
 * Failed statuses:
 *   - "Built (push failed, tests failed)"
 *   - "Built (push failed)"
 *   - "Complete (tests failed)"
 *
 * Returns an array of { slug, name } ordered by appearance in db.md
 * (oldest first). Empty array if none found or db.md doesn't exist.
 */
function getFailedProjects() {
  if (!existsSync(DB_PATH)) return [];

  const content = readFileSync(DB_PATH, 'utf-8');
  const lines = content.split('\n');
  const failed = [];
  let currentEntry = null;

  for (const line of lines) {
    // Start of a new project entry
    const entryMatch = line.match(/^## Project #(\d+): (.+)$/);
    if (entryMatch) {
      // If we were tracking a previous entry and it was failed, save it
      if (currentEntry && currentEntry.failed) {
        failed.push({ slug: currentEntry.slug, name: currentEntry.name });
      }
      currentEntry = { name: entryMatch[2].trim(), slug: null, failed: false };
      continue;
    }

    if (!currentEntry) continue;

    // Capture slug
    const slugMatch = line.match(/^- \*\*Slug\*\*: `(.+)`$/);
    if (slugMatch) {
      currentEntry.slug = slugMatch[1];
      continue;
    }

    // Capture status
    const statusMatch = line.match(/^- \*\*Status\*\*: (.+)$/);
    if (statusMatch) {
      const status = statusMatch[1].trim();
      currentEntry.failed =
        status.includes('push failed') ||
        status === 'Complete (tests failed)' ||
        status === 'Tests Failed';
      continue;
    }
  }

  // Don't forget last entry
  if (currentEntry && currentEntry.failed) {
    failed.push({ slug: currentEntry.slug, name: currentEntry.name });
  }

  return failed;
}

/**
 * Fetch a specific idea by slug from slop-api.
 * Returns the full idea JSON or null if not found.
 */
async function fetchIdeaBySlug(slug) {
  const token = await authenticate();
  try {
    const { data } = await api.get(`/api/v1/ideas/${slug}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return data;
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      jwtToken = null;
      const newToken = await authenticate();
      const { data } = await api.get(`/api/v1/ideas/${slug}`, {
        headers: { Authorization: `Bearer ${newToken}` },
      });
      return data;
    }
    if (err.response?.status === 404) {
      logger.warn({ slug }, 'Idea not found in API — may have been removed');
      return null;
    }
    throw err;
  }
}

/**
 * Build the deep planning prompt for cline.
 * Injects the idea JSON inline so Cline can write plan.md without reading any files.
 * Designed for Qwen 3.5 9B — single focused task, no multi-step navigation.
 */
function buildDeepPlanPrompt(idea) {
  const ideaJson = JSON.stringify(idea, null, 2);
  const slug = idea.slug;

  return `You are the Planning Module. Create a detailed plan for this app idea:

\`\`\`json
${ideaJson}
\`\`\`

STEPS:
1. Write the plan file at /app/projects/${slug}/plan.md using the template below.
   (The project directory /app/projects/${slug} already exists.)

PLAN TEMPLATE — fill in every section.
EACH TASK MUST BE ATOMIC — one file, one endpoint, or one small component.
NO COMPOUND TASKS like "Implement routes for X, Y, and Z" — split those into separate tasks.

\`\`\`markdown
# Plan: ${idea.name}

## Framework Decision
- **Language**: (e.g., TypeScript, Python, Go)
- **Runtime/Framework**: (e.g., Express, FastAPI, Gin)
- **Package Manager**: (e.g., npm, pip, go mod)
- **Database**: (if needed)
- **Rationale**: Why this stack fits this specific idea

## Applicable .clinerules
- [.clinerules/instructions/api-design.instructions.md](.clinerules/instructions/api-design.instructions.md)
- [.clinerules/instructions/containers.instructions.md](.clinerules/instructions/containers.instructions.md)
- (add language/framework-specific ones)

## Test Command
\`npm test\`

## Phase 1: Project Setup (3-4 tasks)
- [ ] Initialize project (package.json, tsconfig, dependencies)
- [ ] Create project structure (src/, tests/, config/)
- [ ] Create Dockerfile (multi-stage, non-root user)
- [ ] Create README.md with setup instructions

## Phase 2: Data Layer (2-4 tasks)
- [ ] Define data models/schemas for [one entity]
- [ ] Set up database connection and create migration for [one table]
- [ ] Define models/schemas for [another entity] (if needed)
- [ ] Set up database connection and create migration for [second table] (if needed)

## Phase 3: API Routes (3-5 tasks — ONE endpoint per task)
- [ ] Implement POST /api/v1/[resource] route with validation
- [ ] Implement GET /api/v1/[resource] and GET /api/v1/[resource]/:id routes
- [ ] Implement PUT /api/v1/[resource]/:id and DELETE /api/v1/[resource]/:id routes
- [ ] Implement [second resource] routes (same pattern)
- [ ] Add middleware (auth, cors, logging, error handling)

## Phase 4: Business Logic (2-3 tasks)
- [ ] Implement core service for [one feature]
- [ ] Implement core service for [another feature]
- [ ] Build React/Vue component for [one UI piece] (if frontend)

## Phase 5: Testing & Polish (2-3 tasks)
- [ ] Write unit tests for [one service/feature]
- [ ] Write integration test for [one endpoint]
- [ ] Add health check endpoint, final cleanup
\`\`\`

RULES:
- Each task MUST be a SINGLE atomic operation — one endpoint, one model, one component.
- BAD: "Implement REST API routes for projects CRUD, budget tracking, material inventory" (4+ endpoints)
- GOOD: "Implement POST /api/v1/projects route with validation"
- TOTAL tasks: 12-20. More granular tasks = higher success rate.
- Include a \`## Test Command\` section with the exact command to run tests (e.g., \`npm test\`).
- Do NOT read any files — all context is provided here.
- When the plan.md is written, say DONE.`;
}

/**
 * Build the execution prompt for cline.
 * Instructs cline to read plan.md and execute the next unchecked phase.
 *
 * @deprecated Use buildSimpleTaskPrompt() instead — complex multi-step prompts
 * cause Qwen 3.5 9B to hallucinate completion without making tool calls.
 */
function buildExecutePrompt(projectDir, planPath) {
  return `You are the **Execution Module** of the App Builder.

Read the file AGENTS.md from the current working directory to understand your role and workflow.

Then, execute the NEXT UNCHECKED PHASE from the plan at ${planPath}.

Follow these steps EXACTLY:
1. Read ${planPath} to find the first phase with any unchecked \`- [ ]\` items.
2. Read the .clinerules/instructions/ files listed in the plan's "Applicable .clinerules" section.
3. Execute ALL unchecked items in that phase — write actual code, not stubs.
4. As you complete each item, update plan.md: change \`- [ ]\` to \`- [x]\` using node -e with fs.readFileSync + String.replace + fs.writeFileSync.
5. Follow all AGENTS.md conventions: comments, error handling, secure coding, naming, reusable code.

STOP after completing ONE phase. Do not start the next phase.

Write real, production-quality code. Do NOT write stubs or TODOs. Every file must be a complete, working implementation.`;
}

/**
 * Parse plan.md and return the first unchecked task.
 * Returns { taskText, lineNumber, phaseHeading } or null if all items checked.
 */
function parseNextUncheckedTask(planPath) {
  if (!existsSync(planPath)) return null;

  const lines = readFileSync(planPath, 'utf-8').split('\n');
  let currentPhase = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track which phase we're in (## Phase N: ...)
    if (/^##\s+Phase\s+\d/.test(line)) {
      currentPhase = line.replace(/^##\s+/, '').trim();
      continue;
    }

    // Found an unchecked item
    if (/^\s*- \[ \]/.test(line)) {
      const taskText = line.replace(/^\s*- \[ \]\s*/, '').trim();
      return {
        taskText,
        lineNumber: i,
        phaseHeading: currentPhase || 'Unknown Phase'
      };
    }
  }

  return null;
}

/**
 * Mark a plan.md task as complete by changing - [ ] to - [x].
 * Operates on a specific line number.
 */
function markTaskDone(planPath, lineNumber) {
  const lines = readFileSync(planPath, 'utf-8').split('\n');
  if (lineNumber < 0 || lineNumber >= lines.length) {
    logger.warn({ planPath, lineNumber }, 'Invalid line number — cannot mark task done');
    return false;
  }

  const line = lines[lineNumber];
  if (!/^\s*- \[ \]/.test(line)) {
    logger.warn({ planPath, lineNumber, line }, 'Line is not an unchecked task');
    return false;
  }

  lines[lineNumber] = line.replace('- [ ]', '- [x]');
  writeFileSync(planPath, lines.join('\n'), 'utf-8');
  logger.info({ planPath, lineNumber, task: line.trim() }, 'Task marked complete');
  return true;
}

/**
 * Extract the key context from plan.md that Cline needs to generate code.
 * Returns the Framework Decision and .clinerules sections — much smaller
 * than the full plan, avoids timeouts on slow models reading 200+ lines.
 */
function extractPlanContext(planPath) {
  if (!existsSync(planPath)) return '';

  const content = readFileSync(planPath, 'utf-8');
  const lines = content.split('\n');
  let frameworkSection = '';
  let clinerulesSection = '';
  let inFramework = false;
  let inClinerules = false;

  for (const line of lines) {
    if (line.startsWith('## Framework Decision')) {
      inFramework = true;
      continue;
    }
    if (line.startsWith('## ')) {
      if (line.startsWith('## Applicable .clinerules')) {
        inClinerules = true;
        inFramework = false;
        continue;
      }
      if (inFramework || inClinerules) break; // Next section — done
      continue;
    }
    if (inFramework) frameworkSection += line + '\n';
    if (inClinerules) clinerulesSection += line + '\n';
  }

  let context = '';
  if (frameworkSection.trim()) {
    context += '## Framework Decision\n' + frameworkSection.trim() + '\n\n';
  }
  if (clinerulesSection.trim()) {
    context += '## Applicable .clinerules\n' + clinerulesSection.trim() + '\n\n';
  }
  return context;
}

/**
 * Build a retry prompt that tells Cline exactly what failed so it can adapt.
 * Never retry with the same prompt — that guarantees the same failure.
 */
function buildTaskRetryPrompt(slug, projectDir, planPath, taskInfo, attempt, errMsg) {
  const base = buildSimpleTaskPrompt(slug, projectDir, planPath, taskInfo);

  // Classify the failure and give targeted recovery instructions
  let diagnosis;
  const errLower = errMsg.toLowerCase();

  if (errLower.includes('timed out') || errLower.includes('timeout')) {
    diagnosis = `\n\n⚠️  PREVIOUS ATTEMPT #${attempt} TIMED OUT.
THE TASK IS TOO COMPLEX FOR ONE CALL. DO THIS INSTEAD:
- Pick a SMALLER piece of the task and implement only that.
- Write 1-3 files max. Skip anything non-essential.
- Leave complete implementations — no stubs — but narrow the scope.
- Say DONE when you've written at least ONE file.`;
  } else if (errLower.includes('peg-native') || errLower.includes('format')) {
    diagnosis = `\n\n⚠️  PREVIOUS ATTEMPT #${attempt} FAILED WITH MODEL FORMAT ERROR.
YOUR OUTPUT DID NOT MATCH THE EXPECTED FORMAT. DO THIS INSTEAD:
- Use SHORTER code blocks. Keep each file under 200 lines.
- Avoid deeply nested code, complex generics, or long template literals.
- Write simpler implementations that still work.
- Say DONE when you've created the files.`;
  } else {
    diagnosis = `\n\n⚠️  PREVIOUS ATTEMPT #${attempt} FAILED: ${errMsg.substring(0, 200)}
DO THIS INSTEAD:
- Try a DIFFERENT approach to the task.
- Write fewer, simpler files.
- Focus on the core functionality only.
- Say DONE when you've created the files.`;
  }

  return base + diagnosis;
}

/**
 * Build a simple, single-task prompt for Cline.
 * Designed for Qwen 3.5 9B — no multi-step navigation, no plan.md reading.
 * Just: given context → create files → DONE.
 */
function buildSimpleTaskPrompt(slug, projectDir, planPath, taskInfo) {
  const { taskText, phaseHeading } = taskInfo;

  // Extract plan context in JS so Cline doesn't need to read the full plan
  const planContext = extractPlanContext(planPath);

  // Determine file type from task description for guidance
  let fileHint = '';
  const taskLower = taskText.toLowerCase();
  if (taskLower.includes('dockerfile')) fileHint = '\nCreate Dockerfile at /app/projects/' + slug + '/Dockerfile';
  else if (taskLower.includes('package.json') || taskLower.includes('init')) fileHint = '\nCreate /app/projects/' + slug + '/package.json and config files';
  else if (taskLower.includes('readme')) fileHint = '\nCreate /app/projects/' + slug + '/README.md';
  else if (taskLower.includes('test') || taskLower.includes('spec')) fileHint = '\nCreate test files in /app/projects/' + slug + '/';
  else if (taskLower.includes('route') || taskLower.includes('endpoint') || taskLower.includes('api'))
    fileHint = '\nCreate route/API files in /app/projects/' + slug + '/';
  else if (taskLower.includes('component') || taskLower.includes('ui') || taskLower.includes('frontend'))
    fileHint = '\nCreate component files in /app/projects/' + slug + '/';
  else if (taskLower.includes('model') || taskLower.includes('schema') || taskLower.includes('database'))
    fileHint = '\nCreate model/schema files in /app/projects/' + slug + '/';
  else if (taskLower.includes('middleware'))
    fileHint = '\nCreate middleware files in /app/projects/' + slug + '/';
  else fileHint = '\nCreate the necessary files in /app/projects/' + slug + '/';

  return `PROJECT CONTEXT:
${planContext}

YOUR TASK (Phase "${phaseHeading}"):
${taskText}

${fileHint}

Write REAL code — complete implementations, no stubs.
Do NOT read any files — context is provided above.
Do NOT update plan.md — the JS runner handles checkmarks.
The project directory already exists — write files directly with write_to_file (it creates parent directories).
When finished, say DONE.`;
}

/**
 * Run the project's test suite as defined in plan.md.
 * Returns true if all tests pass.
 */
function runTests(projectDir, slug) {
  const planPath = path.join(projectDir, 'plan.md');

  if (!existsSync(planPath)) {
    logger.warn({ projectDir, slug }, 'No plan.md found — skipping tests');
    return { passed: false, reason: 'no plan.md' };
  }

  const planContent = readFileSync(planPath, 'utf-8');

  // Extract the test command from plan.md
  let testCmd = null;
  const testCmdMatch = planContent.match(/## Test Command\s*\n`([^`]+)`/);
  if (testCmdMatch) {
    testCmd = testCmdMatch[1].trim();
  } else {
    // Fallback: try to find any backtick command near "test"
    const fallbackMatch = planContent.match(/`(npm test[^`]*|npm run test[^`]*|yarn test[^`]*|npx vitest[^`]*|pytest[^`]*|go test[^`]*|cargo test[^`]*)`/);
    if (fallbackMatch) testCmd = fallbackMatch[1].trim();
  }

  // Default to npm test if no explicit command found — better than skipping entirely
  if (!testCmd) {
    testCmd = existsSync(path.join(projectDir, 'package.json')) ? 'npm test' : null;
  }

  if (!testCmd) {
    logger.warn({ projectDir, slug }, 'No test command in plan.md and no package.json');
    return { passed: false, reason: 'no test command defined' };
  }

  // Strip chained commands (cline often writes "npm test && npm run lint && npx tsc ...").
  // Only run the primary test command — lint/build/type-check are separate concerns.
  const primaryCmd = testCmd.split(/\s*&&\s*/)[0].trim();
  if (primaryCmd !== testCmd) {
    logger.info({ original: testCmd, primary: primaryCmd, slug }, 'Stripped chained commands');
  }

  logger.info({ testCmd: primaryCmd, projectDir, slug }, 'Running tests');

  const result = spawnSync('bash', ['-c', primaryCmd], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const output = (result.stdout || '') + '\n' + (result.stderr || '');

  if (result.status === 0) {
    logger.info({ slug, output: output.substring(0, 300) }, 'Tests passed');
    return { passed: true };
  }

  logger.warn({ slug, exitCode: result.status, output: output.substring(0, 500) }, 'Tests failed — project still pushable');
  return { passed: false, reason: `exit code ${result.status}` };
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
 * Upload a completed project to slop-api as a tar.gz archive.
 * Creates a tar of the project directory, POSTs via multipart to /api/v1/projects.
 *
 * Returns the API response data on success.
 * Throws on failure (caller handles non-fatal logging).
 */
async function uploadProject(slug, name, status) {
  const projectDir = path.join(PROJECTS_DIR, slug);
  const tarPath = path.join(PROJECTS_DIR, `${slug}.tar.gz`);

  if (!existsSync(projectDir)) {
    throw new Error(`Project directory not found: ${projectDir}`);
  }

  // Create tar.gz archive of the project directory
  logger.info({ slug, projectDir }, 'Creating project archive');
  const tarResult = spawnSync('tar', ['-czf', tarPath, '-C', PROJECTS_DIR, slug], {
    encoding: 'utf-8',
    timeout: 60000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (tarResult.status !== 0) {
    throw new Error(`Failed to create tar archive: ${tarResult.stderr}`);
  }

  const stat = { size: readFileSync(tarPath).length };

  // Upload via multipart form
  const form = new FormData();
  form.append('slug', slug);
  form.append('name', name);
  form.append('status', status);
  form.append('project', createReadStream(tarPath), { filename: `${slug}.tar.gz` });

  const token = await authenticate();
  logger.info({ slug, size: stat.size }, 'Uploading project to slop-api');

  const { data } = await api.post('/api/v1/projects', form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${token}`,
    },
    timeout: 300000, // 5 min for large uploads
  });

  logger.info({ slug, response: data }, 'Project uploaded successfully');
  return data;
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
      const status = line.replace('- **Status**: ', '').trim();
      // Any failed or incomplete status means the project never reached git push.
      // Return null so reconciliation can re-process and push it.
      // Known incomplete statuses: "Tests Failed", "Built (push failed)",
      // "Complete (tests failed)".
      if (/failed|incomplete/i.test(status)) {
        return null;
      }
      return status;
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
      let hadSkippedTasks = false;

      if (uncheckedCount > 0) {
        logger.info({ slug, uncheckedCount }, 'Reconciliation: resuming build phases');
        let buildCalls = 0;
        const maxReconcileBuildCalls = 20; // Safety cap — generous for large projects, prevents infinite loops
        const taskRetryCount = new Map(); // task text → {count, lastError}
        const MAX_TASK_RETRIES = 3;

        while (buildCalls < maxReconcileBuildCalls) {
          buildCalls++;
          const currentPlan = readFileSync(planPath, 'utf-8');
          const remaining = (currentPlan.match(/- \[ \]/g) || []).length;
          if (remaining === 0) break;

          // Parse the next unchecked task directly in JS (not Cline)
          const task = parseNextUncheckedTask(planPath);
          if (!task) break;

          // Use retry prompt on subsequent attempts so Cline knows what failed
          const retryState = taskRetryCount.get(task.taskText);
          const prompt = retryState
            ? buildTaskRetryPrompt(slug, projectDir, planPath, task, retryState.count, retryState.lastError)
            : buildSimpleTaskPrompt(slug, projectDir, planPath, task);

          logger.info({ slug, task: task.taskText, phase: task.phaseHeading, buildCall: buildCalls }, 'Reconciliation: executing task');
          await checkCanRunFn();
          try {
            await runCline(prompt);
            // Mark task done in JS — no Cline needed for checkmark updates
            markTaskDone(planPath, task.lineNumber);
            taskRetryCount.delete(task.taskText); // Reset on success
          } catch (clineErr) {
            const prev = taskRetryCount.get(task.taskText) || { count: 0, lastError: '' };
            const failures = prev.count + 1;
            taskRetryCount.set(task.taskText, { count: failures, lastError: clineErr.message });
            logger.warn({ err: clineErr, slug, buildCall: buildCalls, taskRetries: failures },
              'Reconciliation Cline call failed');

            if (failures >= MAX_TASK_RETRIES) {
              logger.warn({ slug, task: task.taskText, failures },
                'Task failed repeatedly — project may be incomplete');
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
          updateDatabase(slug, slug, 'Incomplete');
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
        await uploadProject(slug, slug, status);
      } catch (uploadError) {
        logger.warn({ err: uploadError, slug }, 'API upload error during reconciliation (non-fatal)');
        status = testResult.passed ? 'Built (push failed)' : 'Built (push failed, tests failed)';
      }

      updateDatabase(slug, slug, status);
      logger.info({ slug, status }, 'Reconciliation complete');
    } catch (reconcileError) {
      logger.error({ err: reconcileError, slug }, 'Reconciliation failed for project — leaving for next iteration');
      // C5: Collect failed slugs for retry on next reconciliation pass (agent state preserved)
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
      // When the number of failed projects reaches BUILDER_MAX_FAILED_RETRIES,
      // retry the oldest failed project instead of building something new.
      let idea = null;

      if (BUILDER_MAX_FAILED_RETRIES > 0) {
        const failedProjects = getFailedProjects();
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
            // Prevent infinite retry loop: mark as removed so getFailedProjects() won't pick it up again
            updateDatabase(target.slug, target.name, 'Removed (idea not found in API)');
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

          if (!isAlreadyBuilt(idea.slug)) {
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
          if (uncheckedCount > 0) {
            let buildCalls = 0;
            const maxReconcileBuildCalls = 20;
            const taskRetryCount = new Map(); // task text → {count, lastError}
            const MAX_TASK_RETRIES = 3;
            let hadSkippedTasks = false;
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

              await checkCanRun(); // Yield event loop so Pino can flush
              try {
                await runCline(prompt);
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
          updateDatabase(slug, idea.name, finalStatus);
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
        // Yield event loop so Pino can flush
        await checkCanRun();
        try {
          await runCline(buildDeepPlanPrompt(idea));
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
        updateDatabase(slug, idea.name, 'Incomplete');
        saveState(null, { iteration, phase: 'complete', currentSlug: slug });
        await reportProgress();
        continue;
      }

      // Save state: about to build
      saveState(null, { iteration, phase: 'building', currentSlug: slug });

      // Step 3: Build Phase — execute one phase at a time
      logger.info({ slug, iteration, phase: 'build' }, 'Build phase');
      let buildCalls = 0;
      const maxBuildCalls = 25; // Safety cap — generous for large projects, prevents infinite loops
      const taskRetryCount = new Map(); // task text → {count, lastError}
      const MAX_TASK_RETRIES = 3;
      let hadSkippedTasks = false; // Set true when any task exhausts all retries — project is incomplete

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
          logger.info({ slug, totalBuildCalls: buildCalls }, 'All plan items checked — build complete');
          break;
        }

        // Parse the next unchecked task directly in JS (not Cline)
        const task = parseNextUncheckedTask(planPath);
        if (!task) break;

        // Use retry prompt on subsequent attempts so Cline knows what failed
        const retryState = taskRetryCount.get(task.taskText);
        const prompt = retryState
          ? buildTaskRetryPrompt(slug, projectDir, planPath, task, retryState.count, retryState.lastError)
          : buildSimpleTaskPrompt(slug, projectDir, planPath, task);

        logger.info({ slug, task: task.taskText, phase: task.phaseHeading, buildCall: buildCalls }, 'Executing task');
        // Yield event loop so Pino can flush
        await checkCanRun();
        try {
          await runCline(prompt);
          // Mark task done in JS — no Cline needed for checkmark updates
          markTaskDone(planPath, task.lineNumber);
          taskRetryCount.delete(task.taskText); // Reset on success
        } catch (clineErr) {
          const prev = taskRetryCount.get(task.taskText) || { count: 0, lastError: '' };
          const failures = prev.count + 1;
          taskRetryCount.set(task.taskText, { count: failures, lastError: clineErr.message });
          logger.warn({ err: clineErr, slug, buildCall: buildCalls, taskRetries: failures },
            'Cline call failed');

          if (failures >= MAX_TASK_RETRIES) {
            logger.warn({ slug, task: task.taskText, failures },
              'Task failed repeatedly — project may be incomplete');
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

      // C4: Skip incomplete projects — don't test/push garbage
      if (!buildComplete) {
        updateDatabase(slug, idea.name, 'Incomplete');
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

      // Step 5: Upload project to slop-api (replaces direct git push)
      logger.info({ slug, iteration, phase: 'project-upload' }, 'Uploading project to API');
      let status = testResult.passed ? 'Complete' : 'Complete (tests failed)';
      try {
        await uploadProject(slug, idea.name, status);
      } catch (uploadError) {
        logger.warn({ err: uploadError, slug }, 'Project upload failed (non-fatal)');
        status = 'Built (push failed)';
      }
      logger.info({ slug, iteration, phase: 'project-upload', status }, 'Project upload complete');

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
        logger.warn({ err: error }, 'API or LM Studio unreachable — will retry next iteration');
      }

      // Save state mid-iteration so we can reconcile on restart
      if (slug) {
        saveState(null, { iteration, phase: 'failed', currentSlug: slug });
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

export { configureProvider, runCline, isAlreadyBuilt, runTests, updateDatabase, uploadProject, buildDeepPlanPrompt, buildExecutePrompt, buildSimpleTaskPrompt, buildTaskRetryPrompt, parseNextUncheckedTask, markTaskDone, extractPlanContext, killHubDaemons, authenticate, fetchRandomIdea, fetchIdeaBySlug, checkCanRun, reportProgress, getDbEntry, getFailedProjects, reconcileProjectsDir, recoverBuilderState, loadState, saveState };
