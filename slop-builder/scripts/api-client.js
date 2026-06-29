/**
 * API Client — All HTTP interactions with slop-api.
 *
 * Handles JWT authentication, fetching ideas (random and by slug),
 * and multipart tar.gz project uploads. Maintains a cached JWT token
 * internally — callers don't need to manage auth state.
 */
import axios from 'axios';
import https from 'https';
import FormData from 'form-data';
import { createReadStream, existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import logger from '../lib/logger.js';

// Self-signed cert on internal Docker network — trusted only within bridge
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const API_BASE_URL = process.env.API_BASE_URL || 'https://slop-api:3443';
const API_KEY = process.env.API_KEY || '';

const api = axios.create({
  baseURL: API_BASE_URL,
  httpsAgent,
  timeout: 30000,
});

let jwtToken = null;

/**
 * Authenticate with slop-api and cache the JWT token.
 * Subsequent calls reuse the cached token.
 *
 * @returns {Promise<string>} JWT token
 */
export async function authenticate() {
  if (jwtToken) return jwtToken;

  logger.info({ apiBaseUrl: API_BASE_URL }, 'Authenticating with slop-api');
  const { data } = await api.post('/api/v1/auth/token', { api_key: API_KEY });
  jwtToken = data.token;
  logger.info('Authenticated');
  return jwtToken;
}

/**
 * Helper — make an authenticated GET request with automatic JWT refresh.
 *
 * @param {string} url — API path
 * @returns {Promise<object>} Response data
 */
async function authenticatedGet(url) {
  const token = await authenticate();
  try {
    const { data } = await api.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return data;
  } catch (err) {
    // JWT expired — clear cached token and retry once with fresh auth
    if (err.response?.status === 401 || err.response?.status === 403) {
      jwtToken = null;
      logger.warn('JWT expired, re-authenticating');
      const newToken = await authenticate();
      const { data } = await api.get(url, {
        headers: { Authorization: `Bearer ${newToken}` },
      });
      return data;
    }
    throw err;
  }
}

/**
 * Fetch a random idea from slop-api.
 *
 * @returns {Promise<object>} Full idea JSON (name, slug, category, overview, features, etc.)
 */
export async function fetchRandomIdea() {
  return authenticatedGet('/api/v1/ideas/random');
}

/**
 * Fetch a specific idea by slug from slop-api.
 *
 * @param {string} slug
 * @returns {Promise<object|null>} Full idea JSON, or null if not found (404)
 */
export async function fetchIdeaBySlug(slug) {
  try {
    return await authenticatedGet(`/api/v1/ideas/${slug}`);
  } catch (err) {
    if (err.response?.status === 404) {
      logger.warn({ slug }, 'Idea not found in API — may have been removed');
      return null;
    }
    throw err;
  }
}

/**
 * Upload a completed project to slop-api as a tar.gz archive.
 * Creates a tar of the project directory, POSTs via multipart to /api/v1/projects.
 *
 * @param {string} slug
 * @param {string} name — Project display name
 * @param {string} status — e.g., "Complete", "Complete (tests failed)"
 * @param {string} projectsDir — Base directory containing project folders
 * @returns {Promise<object>} API response data
 */
export async function uploadProject(slug, name, status, projectsDir) {
  const projectDir = path.join(projectsDir, slug);
  const tarPath = path.join(projectsDir, `${slug}.tar.gz`);

  if (!existsSync(projectDir)) {
    throw new Error(`Project directory not found: ${projectDir}`);
  }

  // Create tar.gz archive of the project directory
  logger.info({ slug, projectDir }, 'Creating project archive');
  const tarResult = spawnSync('tar', ['-czf', tarPath, '-C', projectsDir, slug], {
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
