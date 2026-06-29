/**
 * API Client — HTTP interactions with slop-api.
 *
 * Handles JWT authentication and posting generated ideas to slop-api.
 * Uses self-signed TLS for internal Docker bridge communication.
 *
 * The posted-slugs tracker (in database.js) prevents redundant API calls
 * across restarts.
 */
import https from 'https';
import axios from 'axios';
import logger from '../lib/logger.js';
import { parsePlannerDb, parsePlannerAppFile, savePostedSlugs, getPostedSlugs } from './database.js';

/**
 * Authenticate with slop-api and return a cached JWT token.
 * Token is cached in module scope to avoid re-auth on every request.
 *
 * @param {string} apiBaseUrl — Base URL of slop-api (e.g., "https://slop-api:3443")
 * @param {string} apiKey — API key for authentication
 * @returns {Promise<string>} JWT token
 */
let jwtToken = null;

export async function authenticate(apiBaseUrl, apiKey) {
  if (jwtToken) return jwtToken;

  logger.info({ apiBaseUrl }, 'Authenticating with slop-api');
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });
  const api = axios.create({ baseURL: apiBaseUrl, httpsAgent, timeout: 30000 });
  const { data } = await api.post('/api/v1/auth/token', { api_key: apiKey });
  jwtToken = data.token;
  logger.info('Authenticated with slop-api');
  return jwtToken;
}

/**
 * Post any newly generated ideas from the planner's db.md to slop-api.
 *
 * Walks through the planner's db.md entries. For each unposted slug:
 *   1. Reads the app file from apps/
 *   2. Parses it into the API's POST shape
 *   3. POSTs to slop-api (idempotent — 409 Conflict = already exists)
 *   4. Tracks posted slugs to avoid redundant calls
 *
 * @param {string} apiBaseUrl — Base URL of slop-api
 * @param {string} apiKey — API key for authentication
 * @returns {Promise<void>}
 */
export async function postIdeasToApi(apiBaseUrl, apiKey) {
  if (!apiKey) {
    logger.warn('No API_KEY set — cannot post ideas to slop-api');
    return;
  }

  const token = await authenticate(apiBaseUrl, apiKey);

  const ideas = parsePlannerDb();
  if (ideas.length === 0) {
    logger.info('No ideas found in planner db.md to post');
    return;
  }

  const postedSlugs = getPostedSlugs();

  let posted = 0;
  let skipped = 0;

  const httpsAgent = new https.Agent({ rejectUnauthorized: false });
  const api = axios.create({ baseURL: apiBaseUrl, httpsAgent, timeout: 30000 });

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
      const freshToken = await authenticate(apiBaseUrl, apiKey);
      const res = await api.post('/api/v1/ideas', payload, {
        headers: { Authorization: `Bearer ${freshToken}` },
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
