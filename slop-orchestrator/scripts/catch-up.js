/**
 * Catch-Up Mode Evaluator
 *
 * Fetches idea and project counts from slop-api and evaluates whether the
 * orchestrator should enter or exit catch-up mode.
 *
 * Catch-up mode activates when ideas/projects ratio exceeds a threshold,
 * forcing the builder to run exclusively until the ratio recovers.
 */

import https from 'https';
import axios from 'axios';
import logger from '../lib/logger.js';

// Catch-up mode thresholds — activates at ≥2:1, deactivates at ≤1.9:1
const CATCH_UP_RATIO_THRESHOLD = parseFloat(process.env.CATCH_UP_RATIO_THRESHOLD || '2');
const CATCH_UP_TARGET_RATIO = parseFloat(process.env.CATCH_UP_TARGET_RATIO || '1.9');

const API_BASE_URL = process.env.API_BASE_URL || 'https://slop-api:3443';
const API_KEY = process.env.API_KEY || '';

/** Cached JWT for slop-api — reused across calls until expired */
let jwtToken = null;

/** Shared axios instance for slop-api (self-signed cert, 15s timeout) */
const api = axios.create({
  baseURL: API_BASE_URL,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 15000,
});

/**
 * Authenticate with slop-api and cache the JWT.
 * Returns the cached token if still valid, otherwise requests a new one.
 */
async function authenticate() {
  if (jwtToken) return jwtToken;

  logger.info({ apiBaseUrl: API_BASE_URL }, 'Orchestrator authenticating with slop-api');
  const { data } = await api.post('/api/v1/auth/token', { api_key: API_KEY });
  jwtToken = data.token;
  return jwtToken;
}

/**
 * Fetch current ideas and projects counts from slop-api.
 * Only counts projects with status "Complete" — failed-test projects are excluded.
 *
 * @returns {Promise<{ideasCount: number, projectsCount: number, ideasToProjects: number} | null>}
 */
async function fetchRatios() {
  try {
    const token = await authenticate();
    const headers = { Authorization: `Bearer ${token}` };

    const [ideasRes, projectsRes] = await Promise.all([
      api.get('/api/v1/ideas', { headers }),
      api.get('/api/v1/projects', { headers }),
    ]);

    const ideasCount = ideasRes.data.count || 0;

    // Count all completed projects (including those with failed tests).
    // "Complete (tests failed)" projects still consumed builder effort and
    // represent real work done — they should count toward the ratio so
    // catch-up mode can deactivate and the planner gets a turn.
    const allProjects = projectsRes.data.projects || [];
    const projectsCount = allProjects.filter(
      p => p.status === 'Complete' || p.status === 'Complete (tests failed)'
    ).length;

    const ideasToProjects = projectsCount > 0 ? ideasCount / projectsCount : Infinity;

    logger.debug({
      ideasCount,
      projectsCount,
      totalProjects: allProjects.length,
      ideasToProjects,
    }, 'Fetched ratios from slop-api');
    return { ideasCount, projectsCount, ideasToProjects };
  } catch (err) {
    logger.warn({ err: err?.message }, 'Failed to fetch ratios from slop-api');
    return null;
  }
}

/**
 * Evaluate whether to enter or exit catch-up mode based on ideas-to-projects ratio.
 *
 * @param {object} state - In-memory orchestrator state (mutated in place)
 * @param {() => void} persistState - Function to persist state to disk
 * @returns {Promise<{changed: boolean, activated?: boolean, deactivated?: boolean, ratios?: object}>}
 */
async function evaluateCatchUpMode(state, persistState) {
  // Skip API calls during tests
  if (process.env.VITEST) return { changed: false, reason: 'test_mode' };

  const ratios = await fetchRatios();
  if (!ratios) return { changed: false, reason: 'unreachable' };

  state.ideasCount = ratios.ideasCount;
  state.projectsCount = ratios.projectsCount;

  // Activate catch-up mode when ratio exceeds threshold
  if (!state.catchUpMode && ratios.ideasToProjects >= CATCH_UP_RATIO_THRESHOLD) {
    state.catchUpMode = true;
    persistState();
    logger.warn({
      ideasCount: ratios.ideasCount,
      projectsCount: ratios.projectsCount,
      ratio: ratios.ideasToProjects.toFixed(2),
      threshold: CATCH_UP_RATIO_THRESHOLD,
    }, 'CATCH-UP MODE ACTIVATED — builder runs exclusively until ratio recovers');
    return { changed: true, activated: true, ratios };
  }

  // Deactivate catch-up mode when ratio recovers to target
  if (state.catchUpMode && ratios.ideasToProjects <= CATCH_UP_TARGET_RATIO) {
    state.catchUpMode = false;
    state.turn = 'planner';
    state.plannerProgress = 0;
    state.builderProgress = 0;
    persistState();
    logger.info({
      ideasCount: ratios.ideasCount,
      projectsCount: ratios.projectsCount,
      ratio: ratios.ideasToProjects.toFixed(2),
      target: CATCH_UP_TARGET_RATIO,
    }, 'Catch-up mode deactivated — ratio recovered, resuming normal turns');
    return { changed: true, deactivated: true, ratios };
  }

  return { changed: false, reason: 'no_action_needed' };
}

export {
  api,
  authenticate,
  fetchRatios,
  evaluateCatchUpMode,
  CATCH_UP_RATIO_THRESHOLD,
  CATCH_UP_TARGET_RATIO,
};
