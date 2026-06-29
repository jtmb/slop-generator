#!/usr/bin/env node
/**
 * Git Push — Orchestrator-owned git sync module.
 *
 * The orchestrator owns the git working directory at /git-repo. It syncs
 * ideas and projects from slop-api, NOT from planner/builder directly.
 *
 * Flow:
 *   1. ensureGitRepo()     — init, config user, set remote with token injection
 *   2. syncApps()          — GET /api/v1/ideas → GET /api/v1/ideas/:slug/raw
 *                             → write apps/{slug}.md → git add apps/ → push
 *   3. syncProject()       — GET /api/v1/projects/:slug/download
 *                             → extract to projects/{slug}/ → git add → push
 *
 * Environment variables:
 *   GIT_REPO_URL    — Remote URL with auth embedded or injected via GITHUB_TOKEN
 *   GIT_USER_NAME   — Committer name
 *   GIT_USER_EMAIL  — Committer email
 *   GITHUB_TOKEN    — GitHub PAT (injected into URL if no credentials present)
 */

import { spawnSync } from 'child_process';
import { existsSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs';
import path from 'path';
import https from 'https';
import axios from 'axios';
import logger from '../lib/logger.js';

// Token injection: embed GITHUB_TOKEN into repo URL if no credentials present
const REPO_URL = (() => {
  const url = process.env.GIT_REPO_URL || '';
  const token = process.env.GITHUB_TOKEN || '';
  if (token && url && !url.includes('@')) {
    return url.replace('https://', `https://x-access-token:${token}@`);
  }
  return url;
})();

const USER_NAME = process.env.GIT_USER_NAME || 'Slop Generator';
const USER_EMAIL = process.env.GIT_USER_EMAIL || 'slop-generator@localhost';
const GIT_BRANCH = process.env.GIT_BRANCH || 'main';
const GIT_DIR = '/git-repo';
const APPS_DIR = path.join(GIT_DIR, 'apps');
const PROJECTS_DIR = path.join(GIT_DIR, 'projects');

// slop-api access
const API_BASE_URL = process.env.API_BASE_URL || 'https://slop-api:3443';
const API_KEY = process.env.API_KEY || '';

// Self-signed cert on internal Docker network
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const api = axios.create({
  baseURL: API_BASE_URL,
  httpsAgent,
  timeout: 30000,
});

let jwtToken = null;

/**
 * Run a git command in the git working directory.
 * Returns trimmed stdout on success, null on failure.
 */
function git(cmdArgs, options = {}) {
  const result = spawnSync('git', cmdArgs, {
    cwd: GIT_DIR,
    encoding: 'utf-8',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * Ensure the git working directory exists, has user config, and is connected
 * to the remote. Idempotent — safe to call on every startup.
 */
function ensureGitRepo() {
  mkdirSync(GIT_DIR, { recursive: true });
  mkdirSync(APPS_DIR, { recursive: true });
  mkdirSync(PROJECTS_DIR, { recursive: true });

  if (!existsSync(path.join(GIT_DIR, '.git'))) {
    git(['init', '--initial-branch', GIT_BRANCH]);
    logger.info({ gitDir: GIT_DIR, branch: GIT_BRANCH }, 'Initialized git repo');
  } else {
    // Ensure local branch matches GIT_BRANCH (git init may have created 'master')
    const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (currentBranch && currentBranch !== 'HEAD' && currentBranch !== GIT_BRANCH) {
      git(['branch', '-m', currentBranch, GIT_BRANCH]);
      logger.info({ from: currentBranch, to: GIT_BRANCH }, 'Renamed default branch');
    }
  }

  git(['config', 'user.name', USER_NAME]);
  git(['config', 'user.email', USER_EMAIL]);

  // Set remote — replace if it changed (e.g., token rotation)
  const remotes = git(['remote']);
  if (!remotes || !remotes.includes('origin')) {
    git(['remote', 'add', 'origin', REPO_URL]);
    logger.info('Added git remote origin');
  } else {
    const currentUrl = git(['remote', 'get-url', 'origin']);
    if (currentUrl !== REPO_URL) {
      git(['remote', 'set-url', 'origin', REPO_URL]);
      logger.info('Updated git remote URL');
    }
  }
}

/**
 * Authenticate with slop-api and cache the JWT.
 */
async function authenticate() {
  if (jwtToken) return jwtToken;

  logger.info({ apiBaseUrl: API_BASE_URL }, 'Orchestrator authenticating with slop-api');
  const { data } = await api.post('/api/v1/auth/token', { api_key: API_KEY });
  jwtToken = data.token;
  logger.info('Orchestrator authenticated');
  return jwtToken;
}

/**
 * Recursively remove nested .git directories from a project tree.
 * Cline sometimes runs `git init` inside subdirectories, which causes
 * the parent git to treat them as broken submodules.
 */
function removeNestedGitDirs(dir) {
  try {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git') {
          rmSync(fullPath, { recursive: true, force: true });
          logger.warn({ path: fullPath }, 'Removed nested .git directory');
        } else {
          removeNestedGitDirs(fullPath);
        }
      }
    }
  } catch (e) {
    logger.warn({ dir, err: e }, 'Error scanning for nested .git dirs');
  }
}

/**
 * Commit and push the current state of the git working tree.
 * The API is the authoritative source — we force-push to overwrite
 * any stale remote state. Uses --force-with-lease to avoid silently
 * overwriting concurrent pushes from other sources.
 *
 * @param {string} commitMessage - The commit message
 * @returns {boolean} true if pushed successfully, false if nothing to push
 */
function commitAndPush(commitMessage) {
  // Stage everything in apps/ and projects/
  git(['add', 'apps/', 'projects/']);

  const status = git(['status', '--porcelain']);
  if (!status) {
    logger.info('No git changes — skipping push');
    return false;
  }

  const commitResult = git(['commit', '-m', commitMessage]);
  if (commitResult === null) {
    logger.warn('Commit returned non-zero — may already be up to date');
  } else {
    logger.info({ message: commitMessage }, 'Committed');
  }

  // Fetch latest remote ref so --force-with-lease has an up-to-date lease
  git(['fetch', 'origin', GIT_BRANCH]);

  // Force-push because API state is authoritative over the git remote.
  // --force-with-lease is safer than --force: it won't overwrite
  // commits pushed by someone else since our last fetch.
  const pushResult = spawnSync('git', ['push', '--force-with-lease', 'origin', `${GIT_BRANCH}:${GIT_BRANCH}`], {
    cwd: GIT_DIR,
    encoding: 'utf-8',
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (pushResult.status !== 0) {
    logger.warn({ stderr: pushResult.stderr, stdout: pushResult.stdout }, 'Git push failed');
    return false;
  }

  logger.info('Git push successful');
  return true;
}

/**
 * Sync all ideas from slop-api to the git repo.
 * Fetches the full list, then downloads raw markdown for each, writes to apps/.
 *
 * @returns {number} Count of ideas written
 */
async function syncApps() {
  const token = await authenticate();

  logger.info('Syncing apps from slop-api');
  const { data } = await api.get('/api/v1/ideas', {
    headers: { Authorization: `Bearer ${token}` },
  });

  const ideas = data.ideas || [];
  let written = 0;

  for (const idea of ideas) {
    const slug = idea.slug;
    const filePath = path.join(APPS_DIR, `${slug}.md`);

    // Skip if file already exists and is non-empty (idempotent)
    if (existsSync(filePath)) {
      continue;
    }

    try {
      const rawRes = await api.get(`/api/v1/ideas/${slug}/raw`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      writeFileSync(filePath, rawRes.data, 'utf-8');
      written++;
      logger.info({ slug }, 'Synced idea to git apps/');
    } catch (err) {
      logger.warn({ err, slug }, 'Failed to sync idea — skipping');
    }
  }

  logger.info({ written, total: ideas.length }, 'Apps sync complete');

  if (written > 0) {
    commitAndPush(`feat(apps): sync ${written} idea(s)`);
  }

  return written;
}

/**
 * Sync a single completed project from slop-api to the git repo.
 * Downloads the tar.gz archive, extracts it to projects/{slug}/, then commits/pushes.
 *
 * @param {string} slug - The project slug
 * @returns {boolean} true if synced successfully
 */
async function syncProject(slug) {
  const token = await authenticate();
  const projectDir = path.join(PROJECTS_DIR, slug);

  // Skip if already synced (idempotent)
  if (existsSync(projectDir)) {
    logger.info({ slug }, 'Project already in git repo — skipping');
    return false;
  }

  logger.info({ slug }, 'Syncing project from slop-api');

  try {
    // Download the tar.gz archive
    const response = await api.get(`/api/v1/projects/${slug}/download`, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
    });

    const tarPath = path.join(GIT_DIR, `${slug}.tar.gz`);

    // Write archive to temp location
    writeFileSync(tarPath, Buffer.from(response.data));

    // Extract
    mkdirSync(projectDir, { recursive: true });
    const extractResult = spawnSync('tar', ['-xzf', tarPath, '-C', projectDir], {
      cwd: GIT_DIR,
      encoding: 'utf-8',
      timeout: 30000,
    });

    // Clean up tar file
    try { rmSync(tarPath); } catch (_) { /* ignore */ }

    if (extractResult.status !== 0) {
      logger.error({ stderr: extractResult.stderr, slug }, 'Failed to extract project archive');
      return false;
    }

    // Clean nested .git dirs before commit
    removeNestedGitDirs(projectDir);

    commitAndPush(`feat(build): complete ${slug}`);

    logger.info({ slug }, 'Project synced to git');
    return true;
  } catch (err) {
    logger.warn({ err, slug }, 'Failed to sync project from API — skipping');
    return false;
  }
}

/**
 * Sync all new projects from slop-api that haven't been pulled yet.
 * Compares the API's project list against projects already in the git tree.
 *
 * @returns {number} Count of projects synced
 */
async function syncAllProjects() {
  const token = await authenticate();

  try {
    const { data } = await api.get('/api/v1/projects', {
      headers: { Authorization: `Bearer ${token}` },
    });

    const projects = data.projects || [];
    let synced = 0;

    for (const project of projects) {
      const projectDir = path.join(PROJECTS_DIR, project.slug);
      if (existsSync(projectDir)) continue; // Already synced

      const success = await syncProject(project.slug);
      if (success) synced++;
    }

    logger.info({ synced, total: projects.length }, 'Projects sync complete');
    return synced;
  } catch (err) {
    logger.warn({ err }, 'Failed to list projects from API');
    return 0;
  }
}

export { ensureGitRepo, syncApps, syncProject, syncAllProjects, authenticate, commitAndPush };