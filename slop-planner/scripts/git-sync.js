#!/usr/bin/env node
/**
 * Git Sync — Commits and pushes generated app ideas to a remote repo.
 *
 * Called by agent-runner.js in one-shot mode after each completed iteration.
 * Each push is independent — planner pushes to its configured branch (default: main),
 * builder pushes to isolated build/{slug} branches.
 *
 * Usage:
 *   node git-sync.js --once
 *
 * Environment variables (all optional with sensible defaults):
 *   GIT_REPO_URL       — Remote URL (e.g. https://user:token@github.com/owner/repo.git)
 *   GIT_BRANCH         — Branch to push to (default: main)
 *   GIT_USER_NAME      — Git committer name (default: Slop Generator)
 *   GIT_USER_EMAIL     — Git committer email (default: slop-generator@localhost)
 *   GIT_SYNC_DB        — If "true", also track db.md (default: false)
 */

import { spawnSync } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
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

const BRANCH = process.env.GIT_BRANCH || 'main';
const USER_NAME = process.env.GIT_USER_NAME || 'Slop Generator';
const USER_EMAIL = process.env.GIT_USER_EMAIL || 'slop-generator@localhost';
const SYNC_DB = process.env.GIT_SYNC_DB === 'true';

const WORKDIR = '/app';

/**
 * Run a git command. Returns trimmed stdout, or null on failure.
 */
function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: WORKDIR,
    encoding: 'utf-8',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * Ensure the working directory is a git repo with proper config and .gitignore.
 * Safe to call repeatedly — skips if already initialized.
 */
function ensureGitRepo() {
  if (existsSync(`${WORKDIR}/.git`)) {
    return; // Already a repo
  }

  logger.info('Initializing git repository');
  const initResult = git(['init', '-b', BRANCH]);
  if (initResult === null) {
    throw new Error('Failed to initialize git repo — is git installed?');
  }

  git(['config', 'user.name', USER_NAME]);
  git(['config', 'user.email', USER_EMAIL]);

  // .gitignore: ignore everything except apps/ (and optionally db.md)
  const gitignoreLines = [
    '# Ignore everything by default',
    '*',
    '',
    '# Except generated app ideas',
    '!/apps/',
  ];
  if (SYNC_DB) {
    gitignoreLines.push('', '# Optionally track the idea database', '!/db.md');
  }
  gitignoreLines.push('');
  writeFileSync(`${WORKDIR}/.gitignore`, gitignoreLines.join('\n'));

  // Stage and create the initial commit
  git(['add', '-A']);
  const commitResult = git(['commit', '-m', 'Initial commit: app ideas repository']);
  if (commitResult === null) {
    logger.warn('Initial commit failed (no files to commit?)');
  } else {
    logger.info('Repository initialized');
  }
}

/**
 * Configure the git remote. Returns true if remote is ready to push.
 */
function ensureRemote() {
  if (!REPO_URL) return false;

  const remotes = git(['remote']);
  if (remotes && remotes.includes('origin')) {
    const existingUrl = git(['remote', 'get-url', 'origin']);
    if (existingUrl === REPO_URL) return true;
    git(['remote', 'set-url', 'origin', REPO_URL]);
  } else {
    git(['remote', 'add', 'origin', REPO_URL]);
  }
  return true;
}

/**
 * One sync cycle: check for changes, commit, and push.
 */
function sync() {
  try {
    // Check for any changes in tracked files
    const status = git(['status', '--porcelain']);
    if (!status || status.length === 0) {
      logger.info('No changes to sync');
      return;
    }

    logger.info({ changes: status }, 'Changes detected');

    // Stage everything (gitignore controls what's tracked)
    const addResult = git(['add', '-A']);
    if (addResult === null) {
      logger.error('Stage failed — skipping this cycle');
      return;
    }

    const dateStr = new Date().toISOString().split('T')[0];
    const commitResult = git(['commit', '-m', `Sync app ideas — ${dateStr}`]);
    if (commitResult === null) {
      // Nothing to commit after all
      logger.info('Nothing new to commit');
      return;
    }
    logger.info({ commitMessage: commitResult }, 'Committed');

    // Push if a remote is configured
    if (!ensureRemote()) {
      logger.info('No remote configured (set GIT_REPO_URL to enable pushes) — commit saved locally');
      return;
    }

    logger.info('Pushing to remote');
    const pushResult = git(['push', '-u', 'origin', BRANCH]);
    if (pushResult === null) {
      logger.error('Push failed — check GITHUB_TOKEN has repo write scope and GIT_REPO_URL is correct — commit saved locally for retry');
      return;
    }
    logger.info('Push successful');
  } catch (err) {
    logger.error({ err }, 'Sync error');
  }
}

/**
 * Main entry point.
 * Supports --once flag for single-shot sync (e.g. called from agent-runner.js).
 * Without --once, runs in a loop at the configured interval.
 */
function main() {
  if (!process.argv.includes('--once')) {
    logger.warn('Git sync requires --once mode — exiting');
    process.exit(0);
  }

  logger.info({
    branch: BRANCH,
    hasRemote: !!REPO_URL,
    trackDb: SYNC_DB,
  }, 'Git Sync — per-iteration push');

  ensureGitRepo();
  sync();
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main();
