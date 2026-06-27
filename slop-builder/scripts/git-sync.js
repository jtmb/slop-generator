#!/usr/bin/env node
/**
 * Git Sync — Pushes completed projects to per-project git branches.
 *
 * Unlike slop-planner's git-sync (which pushes everything to main),
 * this creates and pushes to isolated branches: build/{slug}.
 *
 * Designed to be called in one-shot mode by agent-runner.js:
 *   node git-sync.js --once --slug eco-track --message "feat(build): complete EcoTrack"
 *
 * Environment variables:
 *   GIT_REPO_URL    — Remote URL with auth (required for push)
 *   GIT_USER_NAME   — Committer name (default: Slop Builder)
 *   GIT_USER_EMAIL  — Committer email (default: slop-generator@localhost)
 */

import { spawnSync } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import logger from '../lib/logger.js';

// Inject GITHUB_TOKEN into repo URL if no credentials are embedded.
// This keeps the token out of .env URL strings and git logs.
const REPO_URL = (() => {
  const url = process.env.GIT_REPO_URL || '';
  const token = process.env.GITHUB_TOKEN || '';
  if (token && url && !url.includes('@')) {
    return url.replace('https://', `https://x-access-token:${token}@`);
  }
  return url;
})();

const USER_NAME = process.env.GIT_USER_NAME || 'Slop Builder';
const USER_EMAIL = process.env.GIT_USER_EMAIL || 'slop-generator@localhost';

const WORKDIR = '/app';
const PROJECTS_DIR = path.join(WORKDIR, 'projects');

// Parse CLI args
const args = process.argv.slice(2);
const onceMode = args.includes('--once');
const slugIndex = args.indexOf('--slug');
const messageIndex = args.indexOf('--message');
const slug = slugIndex !== -1 ? args[slugIndex + 1] : null;
const message = messageIndex !== -1 ? args[messageIndex + 1] : 'feat(build): complete project';

if (!onceMode) {
  logger.warn('Git sync requires --once mode — exiting');
  process.exit(0);
}

if (!slug) {
  logger.fatal('--slug is required');
  process.exit(1);
}

if (!REPO_URL) {
  logger.info('No GIT_REPO_URL configured — skipping push');
  process.exit(0);
}

/**
 * Run a git command. Returns trimmed stdout, or null on failure.
 */
function git(cmdArgs, options = {}) {
  const result = spawnSync('git', cmdArgs, {
    cwd: WORKDIR,
    encoding: 'utf-8',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * Ensure the working directory has git config and a fresh state for this project.
 */
function prepareRepo() {
  if (!existsSync(`${WORKDIR}/.git`)) {
    git(['init']);
  }

  git(['config', 'user.name', USER_NAME]);
  git(['config', 'user.email', USER_EMAIL]);
}

/**
 * Push the project to an orphan branch named build/{slug}.
 *
 * Uses an orphan branch so each project is completely independent —
 * no shared git history between projects. Clean isolation.
 */
function pushProject() {
  const branch = `build/${slug}`;
  const projectPath = path.join(PROJECTS_DIR, slug);

  if (!existsSync(projectPath)) {
    logger.fatal({ projectPath, slug }, 'Project directory does not exist');
    process.exit(1);
  }

  logger.info({ branch, projectPath, slug }, 'Pushing project');

  // .gitignore: only track this specific project
  const gitignoreContent = [
    '# Ignore everything at root',
    '/*',
    '',
    '# Unignore the projects directory so specific projects can be tracked',
    '!/projects',
    '',
    `# Track only this project`,
    `!/projects/${slug}`,
    `!/projects/${slug}/**`,
    '',
  ].join('\n');
  writeFileSync(`${WORKDIR}/.gitignore`, gitignoreContent);

  // Create orphan branch (no parent — clean project history)
  const existingBranches = git(['branch']);
  if (existingBranches && existingBranches.includes(branch)) {
    // Existing branch: clear stale files from previous project, then re-add
    git(['checkout', '-f', branch]);
    git(['rm', '-rf', '--ignore-unmatch', '.']);
  } else {
    // Orphan branch: starts with no history. Working tree already has
    // the project files from the mounted volume — no need to rm/clean.
    const orphanResult = spawnSync('git', ['checkout', '--orphan', branch], {
      cwd: WORKDIR,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (orphanResult.status !== 0) {
      logger.fatal({ stderr: orphanResult.stderr, branch }, 'Failed to create orphan branch');
      process.exit(1);
    }
  }

  // Stage the project files
  git(['add', '-A']);

  // Check if there's anything to commit
  const status = git(['status', '--porcelain']);
  if (!status) {
    logger.info({ slug, branch }, 'No changes — already up to date');
    return;
  }

  // Commit
  const commitResult = git(['commit', '-m', message]);
  if (commitResult === null) {
    logger.warn({ slug, branch }, 'Commit returned non-zero — may already be up to date');
  } else {
    logger.info({ slug, branch, message }, 'Committed');
  }

  // Ensure remote
  const remotes = git(['remote']);
  if (!remotes || !remotes.includes('origin')) {
    git(['remote', 'add', 'origin', REPO_URL]);
  }

  // Force push to the isolated branch
  const pushResult = spawnSync('git', ['push', '-f', 'origin', branch], {
    cwd: WORKDIR,
    encoding: 'utf-8',
    timeout: 60000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (pushResult.status !== 0) {
    logger.error({ stderr: pushResult.stderr?.trim(), branch, slug }, 'Push failed — check GITHUB_TOKEN has repo write scope — project saved locally');
    return;
  }

  logger.info({ branch, slug }, 'Pushed successfully');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
prepareRepo();
pushProject();
