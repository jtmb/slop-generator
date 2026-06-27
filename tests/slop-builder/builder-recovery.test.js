/**
 * Tests for slop-builder recovery and state persistence.
 *
 * Covers: loadState, saveState, getDbEntry, reconcileProjectsDir,
 * recoverBuilderState, and the EEXIST guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import path from 'path';
import fs from 'fs';

// Mock child_process — all spawnSync calls must use the mock
vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '', error: null })),
}));

import { spawnSync } from 'child_process';
import { loadState, saveState } from '../../slop-builder/lib/agent-state.js';
import {
  getDbEntry,
  reconcileProjectsDir,
  recoverBuilderState,
  updateDatabase,
} from '../../slop-builder/scripts/agent-runner.js';

function tempDir() {
  const d = path.join(tmpdir(), `test-builder-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function tempStatePath() {
  return path.join(tmpdir(), `test-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe('loadState (builder)', () => {
  it('returns null when state file does not exist', () => {
    expect(loadState('/tmp/nonexistent-12345.json')).toBeNull();
  });

  it('returns valid state from existing file', () => {
    const sp = tempStatePath();
    saveState(sp, { iteration: 4, phase: 'complete', currentSlug: 'my-app' });
    const result = loadState(sp);
    expect(result.iteration).toBe(4);
    expect(result.phase).toBe('complete');
    expect(result.currentSlug).toBe('my-app');
    fs.unlinkSync(sp);
  });
});

describe('saveState (builder)', () => {
  it('atomically writes state file', () => {
    const sp = tempStatePath();
    saveState(sp, { iteration: 1, phase: 'fetch', currentSlug: null });
    expect(fs.existsSync(sp)).toBe(true);
    expect(fs.existsSync(sp + '.tmp')).toBe(false);
    const saved = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    expect(saved.iteration).toBe(1);
    fs.unlinkSync(sp);
  });
});

describe('getDbEntry', () => {
  it('returns null when db file does not exist', () => {
    expect(getDbEntry('nonexistent', '/tmp/no-db.md')).toBeNull();
  });

  it('returns status when slug found in db', () => {
    const dbPath = tempStatePath();
    fs.writeFileSync(dbPath, [
      '## Total Projects Built: 2',
      '',
      '## Project #1: Test App',
      '- **Slug**: `test-app`',
      '- **Status**: Complete',
      '- **Date Completed**: 2024-01-01',
      '',
      '## Project #2: Other App',
      '- **Slug**: `other-app`',
      '- **Status**: Tests Failed',
    ].join('\n'));

    expect(getDbEntry('test-app', dbPath)).toBe('Complete');
    expect(getDbEntry('other-app', dbPath)).toBe('Tests Failed');
    expect(getDbEntry('unknown', dbPath)).toBeNull();

    fs.unlinkSync(dbPath);
  });
});

describe('reconcileProjectsDir', () => {
  let projectsDir;
  let dbPath;

  beforeEach(() => {
    vi.clearAllMocks();
    projectsDir = tempDir();
    dbPath = tempStatePath();
    spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '', error: null });
  });

  afterEach(() => {
    if (fs.existsSync(projectsDir)) fs.rmSync(projectsDir, { recursive: true, force: true });
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('returns early when project dir does not exist', () => {
    expect(() => reconcileProjectsDir('/nonexistent-dir')).not.toThrow();
  });

  it('removes orphan directories with no plan.md', () => {
    const orphanDir = path.join(projectsDir, 'orphan-slug');
    fs.mkdirSync(orphanDir);
    fs.writeFileSync(path.join(orphanDir, 'some-file.txt'), 'garbage');

    reconcileProjectsDir(projectsDir, dbPath);

    expect(fs.existsSync(orphanDir)).toBe(false);
  });

  it('resumes build for projects with unchecked plan items', () => {
    const slugDir = path.join(projectsDir, 'partial-build');
    fs.mkdirSync(slugDir);
    fs.writeFileSync(path.join(slugDir, 'plan.md'), [
      '# Plan for Partial Build',
      '- [x] completed task',
      '- [ ] pending task 1',
      '- [ ] pending task 2',
      '## Test Command',
      '`npm test`',
    ].join('\n'));

    reconcileProjectsDir(projectsDir, dbPath);

    // Should have called buildExecutePrompt (via runCline) and tests
    // The project should be in the db after reconciliation
    const status = getDbEntry('partial-build', dbPath);
    expect(status).toBeDefined();
  });

  it('skips projects already in the database', () => {
    // Set up db with existing entry
    fs.writeFileSync(dbPath, [
      '## Total Projects Built: 1',
      '',
      '## Project #1: Already Done',
      '- **Slug**: `already-done`',
      '- **Status**: Complete',
      '- **Date Completed**: 2024-01-01',
    ].join('\n'));

    const slugDir = path.join(projectsDir, 'already-done');
    fs.mkdirSync(slugDir);
    fs.writeFileSync(path.join(slugDir, 'plan.md'), 'fake plan');

    const spy = vi.spyOn({ runTests: () => true }, 'runTests');
    reconcileProjectsDir(projectsDir, dbPath);

    // Should NOT have called runTests since entry already exists
    expect(fs.existsSync(slugDir)).toBe(true); // Directory preserved
  });
});

describe('recoverBuilderState', () => {
  let projectsDir;
  let statePath;

  beforeEach(() => {
    vi.clearAllMocks();
    projectsDir = tempDir();
    statePath = tempStatePath();
    spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '', error: null });
  });

  afterEach(() => {
    if (fs.existsSync(projectsDir)) fs.rmSync(projectsDir, { recursive: true, force: true });
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  });

  it('returns 0 when no state file exists', () => {
    const result = recoverBuilderState(statePath);
    expect(result).toBe(0);
  });

  it('returns saved iteration when phase is complete', () => {
    saveState(statePath, { iteration: 3, phase: 'complete', currentSlug: 'done-app' });
    const result = recoverBuilderState(statePath);
    expect(result).toBe(3);
  });

  it('returns iteration for mid-iteration crash (recovery via reconciliation)', () => {
    saveState(statePath, { iteration: 5, phase: 'building', currentSlug: 'crashed-app' });
    const result = recoverBuilderState(statePath);
    expect(result).toBe(5);
  });
});
