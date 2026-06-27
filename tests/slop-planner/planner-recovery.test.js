/**
 * Tests for slop-planner recovery and state persistence.
 *
 * Covers: loadState, saveState, recoverPlannerState with all phase scenarios.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import path from 'path';
import fs from 'fs';

// Use real fs for state persistence tests (tmpfiles)
// but mock child_process for recovery tests
vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: 'ok', stderr: '', error: null })),
}));

import { spawnSync } from 'child_process';
import { loadState, saveState } from '../../slop-planner/lib/agent-state.js';
import { recoverPlannerState } from '../../slop-planner/scripts/agent-runner.js';

function tempStatePath() {
  return path.join(tmpdir(), `test-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe('loadState', () => {
  it('returns null when state file does not exist', () => {
    const result = loadState('/tmp/nonexistent-state-file-12345.json');
    expect(result).toBeNull();
  });

  it('returns parsed state when file exists with valid data', () => {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, JSON.stringify({ iteration: 5, phase: 'complete', currentSlug: null, lastUpdated: '2024-01-01T00:00:00Z' }));

    const result = loadState(statePath);
    expect(result).toEqual({
      iteration: 5,
      phase: 'complete',
      currentSlug: null,
      lastUpdated: '2024-01-01T00:00:00Z',
    });

    fs.unlinkSync(statePath);
  });

  it('returns null for corrupt JSON', () => {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, 'not valid json {{{');

    const result = loadState(statePath);
    expect(result).toBeNull();

    fs.unlinkSync(statePath);
  });

  it('returns null for invalid phase value', () => {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, JSON.stringify({ iteration: 3, phase: 'nonexistent-phase', currentSlug: null }));

    const result = loadState(statePath);
    expect(result).toBeNull();

    fs.unlinkSync(statePath);
  });

  it('returns null when iteration is not a number', () => {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, JSON.stringify({ iteration: 'abc', phase: 'complete', currentSlug: null }));

    const result = loadState(statePath);
    expect(result).toBeNull();

    fs.unlinkSync(statePath);
  });
});

describe('saveState', () => {
  it('writes a valid JSON file atomically', () => {
    const statePath = tempStatePath();

    saveState(statePath, { iteration: 7, phase: 'execution', currentSlug: 'test-app' });

    expect(fs.existsSync(statePath)).toBe(true);
    expect(fs.existsSync(statePath + '.tmp')).toBe(false); // Temp file cleaned up

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(saved.iteration).toBe(7);
    expect(saved.phase).toBe('execution');
    expect(saved.currentSlug).toBe('test-app');
    expect(saved.lastUpdated).toBeDefined();

    fs.unlinkSync(statePath);
  });

  it('handles null currentSlug gracefully', () => {
    const statePath = tempStatePath();

    saveState(statePath, { iteration: 1, phase: 'planning', currentSlug: null });

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(saved.currentSlug).toBeNull();

    fs.unlinkSync(statePath);
  });

  it('overwrites previous state', () => {
    const statePath = tempStatePath();

    saveState(statePath, { iteration: 1, phase: 'planning', currentSlug: null });
    saveState(statePath, { iteration: 2, phase: 'complete', currentSlug: 'my-slug' });

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(saved.iteration).toBe(2);
    expect(saved.phase).toBe('complete');

    fs.unlinkSync(statePath);
  });
});

describe('recoverPlannerState', () => {
  let statePath;

  beforeEach(() => {
    vi.clearAllMocks();
    statePath = tempStatePath();
    spawnSync.mockReturnValue({ status: 0, stdout: 'ok', stderr: '', error: null });
  });

  afterEach(() => {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    if (fs.existsSync(statePath + '.tmp')) fs.unlinkSync(statePath + '.tmp');
  });

  it('returns 0 when no state file exists', () => {
    const result = recoverPlannerState(statePath);
    expect(result).toBe(0);
  });

  it('returns saved iteration when phase is complete', () => {
    saveState(statePath, { iteration: 4, phase: 'complete', currentSlug: null });
    const result = recoverPlannerState(statePath);
    expect(result).toBe(4);
  });

  it('re-runs planning + execution + git-sync when interrupted during planning', () => {
    saveState(statePath, { iteration: 3, phase: 'planning', currentSlug: null });
    const result = recoverPlannerState(statePath);

    // Should have called cline twice (plan + execute) and git-sync once
    expect(spawnSync).toHaveBeenCalled();
    // Returns the iteration (now complete)
    expect(result).toBe(3);

    // State file should have been updated to 'complete'
    const saved = loadState(statePath);
    expect(saved.phase).toBe('complete');
    expect(saved.iteration).toBe(3);
  });

  it('re-runs execution + git-sync when interrupted during execution', () => {
    saveState(statePath, { iteration: 5, phase: 'execution', currentSlug: null });
    const result = recoverPlannerState(statePath);

    expect(result).toBe(5);
    const saved = loadState(statePath);
    expect(saved.phase).toBe('complete');
    expect(saved.iteration).toBe(5);
  });

  it('re-runs only git-sync when interrupted during git-sync', () => {
    saveState(statePath, { iteration: 2, phase: 'git-sync', currentSlug: null });
    const result = recoverPlannerState(statePath);

    expect(result).toBe(2);
    const saved = loadState(statePath);
    expect(saved.phase).toBe('complete');
  });

  it('returns iteration even when recovery spawn encounters errors', () => {
    saveState(statePath, { iteration: 6, phase: 'planning', currentSlug: null });
    spawnSync.mockImplementation(() => { throw new Error('spawn failed'); });

    // Should not throw — catches errors and returns the iteration
    const result = recoverPlannerState(statePath);
    expect(result).toBe(6);
  });
});
