/**
 * Agent State Persistence — crash recovery state tracking.
 *
 * Writes a lightweight JSON file at /app/.agent-state.json that tracks
 * the agent's current iteration, phase, and active slug. On startup,
 * this file is read to resume from the last saved checkpoint.
 *
 * KEEP IN SYNC with slop-builder/lib/agent-state.js — identical logic.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

const DEFAULT_STATE_PATH = '/app/.agent-state.json';

/**
 * Valid phases for each agent. Planner uses the first four;
 * builder uses all eight.
 */
export const VALID_PHASES = [
  'complete',
  'planning',
  'execution',
  'git-sync',
  'fetch',
  'building',
  'testing',
  'git-push',
  'db-update',
];

/**
 * Load persisted state from disk.
 * Returns null if the file doesn't exist or is unreadable.
 *
 * @param {string} [statePath] - Override path (default: /app/.agent-state.json)
 * @returns {{ iteration: number, phase: string, currentSlug: string|null, lastUpdated: string }|null}
 */
export function loadState(statePath = DEFAULT_STATE_PATH) {
  try {
    if (!existsSync(statePath)) {
      return null;
    }

    const raw = readFileSync(statePath, 'utf-8');
    const state = JSON.parse(raw);

    // Basic validation
    if (typeof state.iteration !== 'number' || !VALID_PHASES.includes(state.phase)) {
      return null;
    }

    return state;
  } catch {
    // Corrupt file or read error — treat as no state
    return null;
  }
}

/**
 * Persist agent state to disk atomically.
 * Writes to a temp file then renames to avoid corruption on crash mid-write.
 *
 * @param {string} statePath
 * @param {{ iteration: number, phase: string, currentSlug: string|null }} state
 */
export function saveState(statePath = DEFAULT_STATE_PATH, { iteration, phase, currentSlug }) {
  const sp = statePath || DEFAULT_STATE_PATH;
  const tmpPath = sp + '.tmp';

  const payload = {
    iteration,
    phase,
    currentSlug: currentSlug || null,
    lastUpdated: new Date().toISOString(),
  };

  mkdirSync(dirname(sp), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
  renameSync(tmpPath, sp);
}
