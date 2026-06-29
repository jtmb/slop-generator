/**
 * GitHub Issue Tracker for Failing Projects
 *
 * Scans slop-api for projects with status "Complete (tests failed)" and creates
 * a single GitHub issue per project in the git repo. Issues are deduplicated
 * by title pattern so the same project never gets multiple open issues.
 *
 * Uses existing GITHUB_TOKEN env var + axios — no new dependencies.
 */

import axios from 'axios';
import logger from '../lib/logger.js';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const ISSUE_LABEL = 'failing-tests';
const ISSUE_TITLE_PREFIX = '[Failing]';

/**
 * Parse owner/repo from a GitHub URL.
 * Supports https://github.com/owner/repo and https://github.com/owner/repo.git
 */
function parseRepoFromUrl(url) {
  if (!url) return null;
  const match = url.match(/github\.com\/([^/]+)\/([^/\s.]+?)(?:\.git)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * Create a GitHub issue via the REST API.
 *
 * @param {string} owner - GitHub org or user
 * @param {string} repo - Repository name
 * @param {string} title - Issue title
 * @param {string} body - Issue body (markdown)
 * @returns {Promise<boolean>} true if created, false on error
 */
async function createIssue(owner, repo, title, body) {
  try {
    await axios.post(
      `https://api.github.com/repos/${owner}/${repo}/issues`,
      { title, body, labels: [ISSUE_LABEL] },
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        timeout: 15000,
      },
    );
    return true;
  } catch (err) {
    logger.warn({ err: err?.message, title }, 'Failed to create GitHub issue');
    return false;
  }
}

/**
 * Fetch existing open issues matching our label and prefix from a repo.
 * Used for deduplication — skip projects that already have an open issue.
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<Set<string>>} set of title strings for existing issues
 */
async function fetchExistingIssueTitles(owner, repo) {
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/issues`,
      {
        params: { state: 'open', labels: ISSUE_LABEL, per_page: 100 },
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        timeout: 15000,
      },
    );
    return new Set(data.map(issue => issue.title));
  } catch (err) {
    logger.warn({ err: err?.message }, 'Failed to fetch existing GitHub issues');
    return new Set(); // Safe fallback: try creating anyway (API dedup still works)
  }
}

/**
 * Sync GitHub issues for failing projects.
 *
 * Fetches all projects from slop-api, filters for those with status
 * "Complete (tests failed)", and creates one GitHub issue per project
 * that doesn't already have an open issue.
 *
 * @param {object} apiClient - Axios instance configured for slop-api
 * @param {string} gitRepoUrl - GitHub repo URL (to parse owner/repo)
 * @returns {Promise<{created: number, skipped: number}>}
 */
export async function syncFailedProjectIssues(apiClient, gitRepoUrl) {
  // Guard: skip if no GitHub token or VITEST mode
  if (!GITHUB_TOKEN) {
    logger.debug('No GITHUB_TOKEN configured — skipping issue sync');
    return { created: 0, skipped: 0 };
  }
  if (process.env.VITEST) {
    return { created: 0, skipped: 0, reason: 'test_mode' };
  }

  const repoInfo = parseRepoFromUrl(gitRepoUrl);
  if (!repoInfo) {
    logger.warn({ gitRepoUrl }, 'Cannot parse GitHub repo from GIT_REPO_URL — skipping issue sync');
    return { created: 0, skipped: 0 };
  }

  const { owner, repo } = repoInfo;

  try {
    // Fetch failing projects from slop-api
    const token = await authenticateForTracker(apiClient);
    const { data } = await apiClient.get('/api/v1/projects', {
      headers: { Authorization: `Bearer ${token}` },
    });

    const failingProjects = (data.projects || []).filter(
      p => p.status === 'Complete (tests failed)',
    );

    if (failingProjects.length === 0) {
      logger.debug('No failing projects found — nothing to create issues for');
      return { created: 0, skipped: 0 };
    }

    // Fetch existing issue titles for dedup
    const existingTitles = await fetchExistingIssueTitles(owner, repo);

    let created = 0;
    let skipped = 0;

    for (const project of failingProjects) {
      const title = `${ISSUE_TITLE_PREFIX} ${project.name || project.slug}`;

      if (existingTitles.has(title)) {
        skipped++;
        continue;
      }

      const body = [
        `## Failing Project: ${project.name || project.slug}`,
        '',
        `- **Slug**: \`${project.slug}\``,
        `- **Status**: ${project.status}`,
        `- **Date Completed**: ${project.dateCompleted || 'unknown'}`,
        '',
        'This project was built but its tests failed. It needs to be fixed so it passes all tests.',
        '',
        '### Action Required',
        '1. Download the project archive from slop-api: `GET /api/v1/projects/:slug/download`',
        '2. Fix the failing tests',
        '3. Re-upload the fixed project',
        '',
        '---',
        '*Auto-generated by slop-orchestrator issue tracker*',
      ].join('\n');

      const ok = await createIssue(owner, repo, title, body);
      if (ok) {
        created++;
        logger.info({ title, slug: project.slug }, 'Created GitHub issue for failing project');
      }
    }

    if (created > 0 || skipped > 0) {
      logger.info({ created, skipped, totalFailing: failingProjects.length },
        'GitHub issue sync complete');
    }

    return { created, skipped };
  } catch (err) {
    // Return error flag so callers can distinguish "no projects" from "connection failed"
    logger.warn({ err: err?.message }, 'Failed to sync failing project issues');
    return { created: 0, skipped: 0, error: err?.message };
  }
}

/**
 * Close GitHub issues for projects that have been fixed.
 *
 * Fetches open issues labeled "failing-tests", then checks if the
 * corresponding project's status is now "Complete" (not "Complete (tests failed)").
 * If a previously-failing project has been rebuilt and now passes tests,
 * closes its GitHub issue with a resolution comment.
 *
 * @param {object} apiClient - Axios instance configured for slop-api
 * @param {string} gitRepoUrl - GitHub repo URL (to parse owner/repo)
 * @returns {Promise<{closed: number, skipped: number}>}
 */
export async function closeResolvedProjectIssues(apiClient, gitRepoUrl) {
  if (!GITHUB_TOKEN) return { closed: 0, skipped: 0 };
  if (process.env.VITEST) return { closed: 0, skipped: 0, reason: 'test_mode' };

  const repoInfo = parseRepoFromUrl(gitRepoUrl);
  if (!repoInfo) return { closed: 0, skipped: 0 };

  const { owner, repo } = repoInfo;

  try {
    // Fetch resolved projects (status "Complete") from slop-api
    const token = await authenticateForTracker(apiClient);
    const { data } = await apiClient.get('/api/v1/projects', {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Build set of resolved project names for fast lookup
    const resolvedNames = new Set(
      (data.projects || [])
        .filter(p => p.status === 'Complete')
        .map(p => p.name || p.slug),
    );

    if (resolvedNames.size === 0) {
      return { closed: 0, skipped: 0 };
    }

    // Fetch all open failing-test issues
    const { data: issues } = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/issues`,
      {
        params: { state: 'open', labels: ISSUE_LABEL, per_page: 100 },
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        timeout: 15000,
      },
    );

    let closed = 0;
    let skipped = 0;

    for (const issue of issues) {
      // Extract project name from issue title "[Failing] Project Name"
      const titleMatch = issue.title.match(/^\[Failing\] (.+)$/);
      if (!titleMatch) {
        skipped++;
        continue;
      }

      const projectName = titleMatch[1].trim();

      if (!resolvedNames.has(projectName)) {
        skipped++;
        continue;
      }

      // Close the issue with a resolution comment
      await axios.patch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${issue.number}`,
        {
          state: 'closed',
          state_reason: 'completed',
        },
        {
          headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          timeout: 15000,
        },
      );

      // Add a closing comment explaining why
      await axios.post(
        `https://api.github.com/repos/${owner}/${repo}/issues/${issue.number}/comments`,
        {
          body: `✅ This project has been fixed and now passes all tests. Closing automatically.`,
        },
        {
          headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          timeout: 15000,
        },
      );

      closed++;
      logger.info({ issue: issue.number, title: issue.title }, 'Closed GitHub issue for resolved project');
    }

    if (closed > 0) {
      logger.info({ closed, skipped, totalIssues: issues.length }, 'GitHub issue resolution complete');
    }

    return { closed, skipped };
  } catch (err) {
    logger.warn({ err: err?.message }, 'Failed to close resolved project issues');
    return { closed: 0, skipped: 0, error: err?.message };
  }
}

// Cached JWT for slop-api access (shared via dependency injection)
let _jwtToken = null;

/**
 * Authenticate with slop-api using the provided axios instance.
 * Returns a cached JWT, refreshing if necessary.
 */
async function authenticateForTracker(apiClient) {
  if (_jwtToken) return _jwtToken;

  const apiKey = process.env.API_KEY || '';
  const { data } = await apiClient.post('/api/v1/auth/token', { api_key: apiKey });
  _jwtToken = data.token;
  return _jwtToken;
}

export default syncFailedProjectIssues;
