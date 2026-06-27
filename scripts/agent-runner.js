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
import dotenv from 'dotenv';
import settings from '../config/settings.json' with { type: 'json' };

dotenv.config();

const PROVIDER = process.env.CLINE_PROVIDER || 'lmstudio';
const BASE_URL = process.env.CLINE_API_BASE_URL || 'http://host.docker.internal:1234/v1';
const MODEL = process.env.CLINE_MODEL || 'qwen/qwen3.5-9b';

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

  console.log(`Provider configured: ${PROVIDER}`);
  console.log(`  Endpoint: ${BASE_URL}`);
  console.log(`  Model:    ${MODEL}`);
}

/**
 * Run a single cline command and wait for completion.
 * Uses spawnSync with argument array to avoid shell quoting issues entirely.
 */
function runCline(prompt) {
  const args = ['-P', PROVIDER, prompt];
  console.log(`\n--- Cline START ---`);
  console.log(`Prompt: ${prompt.substring(0, 80)}...`);

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

  console.log(`--- Cline END ---`);
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
 * Main autopilot loop
 */
function main() {
  console.log('========================================');
  console.log('  App Idea Generator — Autopilot Mode');
  console.log('========================================');

  configureProvider();

  let iteration = 0;

  while (iteration < settings.max_iterations) {
    iteration++;

    try {
      console.log('\n══════════════════════════════════════');
      console.log(`  Iteration ${iteration}/${settings.max_iterations}`);
      console.log('══════════════════════════════════════');

      // Phase 1: Planning — research and formulate a plan, saved to /app/plan.txt
      console.log('\n── Planning Phase ──');
      runCline(buildPlanPrompt());
      console.log('\n── Planning Complete ──');

      // Phase 2: Execution — read the plan and carry it out
      console.log('\n── Agent Execution Phase ──');
      runCline(buildAgentPrompt());
      console.log('\n── Execution Complete ──');

      console.log(`\n✅ Iteration ${iteration} complete`);

    } catch (error) {
      console.error(`\n❌ Iteration ${iteration} error:`, error.message);

      if (error.message.includes('ETIMEDOUT') || error.message.includes('ECONNREFUSED')) {
        console.error('API unreachable. Stopping agent.');
        process.exit(1);
      }

      console.log('Continuing to next iteration...');
    }
  }

  console.log(`\n✅ Agent loop completed: ${iteration} ideas generated`);
}

// Graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main();
