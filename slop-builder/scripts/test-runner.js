/**
 * Test Runner — Executes the project's test suite as defined in plan.md.
 *
 * Reads the "## Test Command" section from plan.md, strips chained commands,
 * and runs the primary test command via spawnSync. Returns pass/fail with reason.
 */
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import logger from '../lib/logger.js';

/**
 * Run the project's test suite as defined in plan.md.
 * Does NOT retry — retry logic belongs at the caller level.
 *
 * @param {string} projectDir — Absolute path to the project directory
 * @param {string} slug — Project slug (for logging)
 * @returns {{ passed: boolean, reason?: string }}
 */
export function runTests(projectDir, slug) {
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

  // Default to npm test if no explicit command found
  if (!testCmd) {
    testCmd = existsSync(path.join(projectDir, 'package.json')) ? 'npm test' : null;
  }

  if (!testCmd) {
    logger.warn({ projectDir, slug }, 'No test command in plan.md and no package.json');
    return { passed: false, reason: 'no test command defined' };
  }

  // Strip chained commands (Cline often writes "npm test && npm run lint && npx tsc ...").
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
