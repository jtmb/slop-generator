#!/usr/bin/env node
/**
 * Agent Runner - Autopilot loop for App Idea Generator
 * 
 * Simple babysitter: calls `cline` CLI in a loop.
 * Cline reads AGENTS.md, handles ALL API calls, tool execution,
 * file creation, and db updates — we just nudge it to start again.
 */

import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import https from 'https';
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

// Self-signed cert on internal Docker network — skip verification
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/** Shared axios instance for slop-api calls. */
const api = axios.create({
  baseURL: API_BASE_URL,
  httpsAgent,
  timeout: 30000,
});

let jwtToken = null;

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
  // --json: ensures tool output is not truncated (non-json mode reports "ok"
  // instead of actual command output, causing Cline to count false errors)
  // --retries: prevents premature abort when model tool calls need retry
  const args = ['-P', PROVIDER, '--json', '--retries', '20', prompt];
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

Write your plan to /app/plan.txt using run_commands with node -e and fs.writeFileSync:

**App Name**: {proposed app name}
**Category**: {category}
**Problem It Solves**: {1-2 sentence summary}
**Why It's Unique**: {how it differs from existing ideas in db.md}
**Key Features**: {2-3 bullet points}
**Target Audience**: {who}

TOOL USAGE RULES:
- Use run_commands for ALL file operations. Split command and args: {"command":"node","args":["-e","require('fs').writeFileSync('/app/plan.txt','content')"]}
- NEVER use the editor tool — it is broken and will fail.
- For multi-line files, use \\n inside the string argument to writeFileSync.

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
3. Create the app idea markdown file in the apps/ directory using run_commands with node -e and fs.writeFileSync.
4. Update db.md to add the new idea to the database using node -e with fs.readFileSync + fs.appendFileSync.

TOOL USAGE RULES:
- Use run_commands for ALL file operations. Split command and args: {"command":"node","args":["-e","require('fs').writeFileSync('apps/idea.md','content')"]}
- NEVER use the editor tool — it is broken and will fail.
- For multi-line files, use \\n inside the string argument to writeFileSync.
- To append to db.md, use: node -e "require('fs').appendFileSync('db.md','\\n| ... |')"

IMPORTANT: Actually create and update the files — do not just describe what you would do.`;
}

/**
 * Authenticate with slop-api and cache the JWT token.
 */
async function authenticate() {
  if (jwtToken) return jwtToken;

  logger.info({ apiBaseUrl: API_BASE_URL }, 'Authenticating with slop-api');
  const { data } = await api.post('/api/v1/auth/token', { api_key: API_KEY });
  jwtToken = data.token;
  logger.info('Authenticated with slop-api');
  return jwtToken;
}

/**
 * Parse a planner app markdown file into the JSON shape expected by POST /api/v1/ideas.
 *
 * The planner's Cline agent writes files with sections:
 *   # Name, ## Overview, ## Problem Solved, ## Target Audience,
 *   ## Key Features, ## Monetization Strategy, ## Tech Stack Suggestions,
 *   ## Implementation Plan
 *
 * Returns null if the file can't be parsed into a valid idea.
 */
function parsePlannerAppFile(filePath) {
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Title is the first # heading
  const name = (lines.find(l => l.startsWith('# ')) || '').replace(/^# /, '').trim();
  if (!name) return null;

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // Extract sections between ## headings
  const getSection = (heading) => {
    const startIdx = lines.findIndex(l => l.toLowerCase().startsWith(`## ${heading.toLowerCase()}`));
    if (startIdx === -1) return '';
    let endIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith('## '));
    if (endIdx === -1) endIdx = lines.length;
    return lines.slice(startIdx + 1, endIdx).join('\n').trim();
  };

  const overview = getSection('Overview');
  const problemSolved = getSection('Problem Solved');
  const targetAudienceRaw = getSection('Target Audience');
  const keyFeaturesRaw = getSection('Key Features');
  const monetizationRaw = getSection('Monetization Strategy');
  const techStackRaw = getSection('Tech Stack Suggestions');
  const implementationPlanRaw = getSection('Implementation Plan');

  // Parse target audience as array of strings (comma-separated or newline-separated)
  const targetAudience = targetAudienceRaw
    ? targetAudienceRaw.split(/[,\n]/).map(s => s.replace(/^[-*\d.]+\s*/, '').trim()).filter(Boolean)
    : [];

  // Parse key features — numbered items or bullet points
  const keyFeatures = keyFeaturesRaw
    ? keyFeaturesRaw.split('\n')
        .filter(l => /^[\d]+\.|^[-*]/.test(l.trim()))
        .map(l => {
          const cleaned = l.replace(/^[\d]+\.\s*\*?\*?|^[-*]\s+/, '').trim();
          // Split bold title from description: **Title**: description
          const match = cleaned.match(/^\*{0,2}([^*:]+?)\*{0,2}:\s*(.*)/);
          if (match) {
            return { title: match[1].trim(), description: match[2].trim() };
          }
          return { title: cleaned, description: '' };
        })
    : [];

  // Parse monetization as array of strings
  const monetization = monetizationRaw
    ? monetizationRaw.split('\n')
        .filter(l => /^[\d]+\.|^[-*]/.test(l.trim()))
        .map(l => l.replace(/^[\d]+\.\s*|^[-*]\s+/, '').trim())
        .filter(Boolean)
    : [];

  // Parse tech stack into key-value pairs from bullet list (e.g. "- **Frontend**: React")
  const techStack = {};
  if (techStackRaw) {
    const techLines = techStackRaw.split('\n').filter(l => /^[-*]/.test(l.trim()));
    for (const line of techLines) {
      const match = line.match(/[-*]\s*\*{0,2}([^*:]+?)\*{0,2}:\s*(.*)/);
      if (match) {
        techStack[match[1].trim()] = match[2].trim();
      }
    }
  }

  return {
    slug,
    name,
    overview,
    problemSolved,
    targetAudience,
    keyFeatures,
    monetization,
    techStack,
    implementationPlan: implementationPlanRaw,
    dateAdded: new Date().toISOString().split('T')[0],
  };
}

/**
 * Parse the planner's db.md to extract all idea entries as slug objects.
 *
 * The planner db uses a custom format:
 *   ## Idea #N: Name
 *   - **File Path**: `apps/slug.md`
 *   - **Category**: ...
 *   - **Status**: Idea Generated
 *   - **Date Added**: YYYY-MM-DD
 *
 * Returns an array of { slug, name, filePath, category, status, dateAdded } objects.
 */
function parsePlannerDb() {
  const dbPath = '/app/db.md';
  if (!existsSync(dbPath)) return [];

  const content = readFileSync(dbPath, 'utf-8');
  const ideas = [];
  const blocks = content.split(/^## Idea #\d+:/m);

  for (const block of blocks) {
    const nameMatch = block.match(/^\s*(.+)/m);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim();
    const filePathMatch = block.match(/\*\*File Path\*\*:\s*`?([^`\n]+)`?/);
    const categoryMatch = block.match(/\*\*Category\*\*:\s*(.+)/);
    const statusMatch = block.match(/\*\*Status\*\*:\s*(.+)/);
    const dateMatch = block.match(/\*\*Date Added\*\*:\s*(.+)/);

    const fullPath = filePathMatch ? `/app/${filePathMatch[1].trim()}` : null;
    const slugFromPath = filePathMatch
      ? filePathMatch[1].replace(/^apps\//, '').replace(/\.md$/, '')
      : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    ideas.push({
      slug: slugFromPath,
      name,
      filePath: fullPath,
      category: (categoryMatch?.[1] || '').trim(),
      status: (statusMatch?.[1] || '').trim(),
      dateAdded: (dateMatch?.[1] || '').trim(),
    });
  }

  return ideas;
}

// Track which slugs have already been posted to avoid redundant API calls
let postedSlugs = new Set();
const POSTED_SLUGS_PATH = '/app/.posted-slugs.json';

function loadPostedSlugs() {
  try {
    if (existsSync(POSTED_SLUGS_PATH)) {
      const data = JSON.parse(readFileSync(POSTED_SLUGS_PATH, 'utf-8'));
      postedSlugs = new Set(data.slugs || []);
      logger.info({ count: postedSlugs.size }, 'Loaded posted-slugs tracker');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load posted-slugs tracker — starting fresh');
    postedSlugs = new Set();
  }
}

function savePostedSlugs() {
  try {
    writeFileSync(POSTED_SLUGS_PATH, JSON.stringify({ slugs: [...postedSlugs] }, null, 2));
  } catch (err) {
    logger.warn({ err }, 'Failed to save posted-slugs tracker');
  }
}

/**
 * Post any newly generated ideas from the planner's db.md to slop-api.
 *
 * Walks through the planner's db.md entries. For each unposted slug:
 *   1. Reads the app file from apps/
 *   2. Parses it into the API's POST shape
 *   3. POSTs to slop-api (idempotent — 409 Conflict = already exists)
 *   4. Tracks posted slugs to avoid redundant calls
 */
async function postIdeasToApi() {
  if (!API_KEY) {
    logger.warn('No API_KEY set — cannot post ideas to slop-api');
    return;
  }

  await authenticate();

  const ideas = parsePlannerDb();
  if (ideas.length === 0) {
    logger.info('No ideas found in planner db.md to post');
    return;
  }

  let posted = 0;
  let skipped = 0;

  for (const idea of ideas) {
    if (postedSlugs.has(idea.slug)) {
      skipped++;
      continue;
    }

    const appFilePath = idea.filePath || `/app/apps/${idea.slug}.md`;
    const payload = parsePlannerAppFile(appFilePath);

    if (!payload) {
      logger.warn({ slug: idea.slug, path: appFilePath }, 'Could not parse app file for posting');
      postedSlugs.add(idea.slug); // Don't retry forever
      continue;
    }

    try {
      const token = await authenticate();
      const res = await api.post('/api/v1/ideas', payload, {
        headers: { Authorization: `Bearer ${token}` },
      });
      logger.info({ slug: idea.slug, status: res.status }, 'Posted idea to slop-api');
      postedSlugs.add(idea.slug);
      posted++;
    } catch (err) {
      if (err.response?.status === 409) {
        // Idempotent — slug already exists, mark as posted
        logger.info({ slug: idea.slug }, 'Idea already exists on API (409) — marking as posted');
        postedSlugs.add(idea.slug);
        skipped++;
      } else if (err.response?.status === 401 || err.response?.status === 403) {
        // Auth failure — reset token and retry once
        jwtToken = null;
        logger.warn({ slug: idea.slug, status: err.response.status }, 'Auth failure posting idea — will retry next cycle');
        break; // Stop this batch, retry after re-auth next cycle
      } else {
        logger.warn({ slug: idea.slug, err: err.message }, 'Failed to post idea to slop-api');
        // Don't add to postedSlugs — will retry next cycle
      }
    }
  }

  savePostedSlugs();
  if (posted > 0 || skipped > 0) {
    logger.info({ posted, skipped, totalTracked: postedSlugs.size }, 'Idea posting cycle complete');
  }
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
 * Respects the orchestrator — waits for planner's turn before each cline call.
 * Returns the iteration number to resume from (0 if fresh start).
 *
 * @param {string} [statePath] - Override state file path (for testing)
 * @param {Function} [checkCanRunFn] - Override orchestrator check function (for testing)
 */
async function recoverPlannerState(statePath, checkCanRunFn = checkCanRun) {
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
        await checkCanRunFn();
        runCline(buildPlanPrompt());
        saveState(sp, { iteration: iter, phase: 'execution', currentSlug: null });
      }

      // Re-run execution if interrupted during execution
      if (state.phase === 'planning' || state.phase === 'execution') {
        logger.info({ phase: 'execution', iteration: iter }, 'Recovery: re-running execution phase');
        await checkCanRunFn();
        runCline(buildAgentPrompt());
      }

      // Post ideas to API (recovery from mid-iteration crash)
      try {
        await postIdeasToApi();
        logger.info('Recovery: posted ideas to API');
        saveState(sp, { iteration: iter, phase: 'complete', currentSlug: null });
        await reportProgress();
        return true;
      } catch (postErr) {
        logger.warn({ err: postErr }, 'Recovery: failed to post ideas to API');
        return false;
      }
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

  // Load the posted-slugs tracker so we don't re-post existing ideas
  loadPostedSlugs();

  // Recover from crash/restart — get the iteration to start from
  const recoveredIteration = await recoverPlannerState();
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

      // Post newly generated ideas to slop-api so the builder can consume them
      await postIdeasToApi();

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
