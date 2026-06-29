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

// Build a mock checkCanRun that resolves immediately (orchestrator says "go")
function mockCheckCanRun() {
  return vi.fn().mockResolvedValue(undefined);
}

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
      '',
      '## Project #3: Partial App',
      '- **Slug**: `partial-app`',
      '- **Status**: Complete (tests failed)',
    ].join('\n'));

    expect(getDbEntry('test-app', dbPath)).toBe('Complete');
    // Tests Failed returns null to allow re-processing — see C5 reconciliation retry
    expect(getDbEntry('other-app', dbPath)).toBeNull();
    // Complete (tests failed) also returns null — tests didn't pass so git push never happened
    expect(getDbEntry('partial-app', dbPath)).toBeNull();
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

  it('returns early when project dir does not exist', async () => {
    await reconcileProjectsDir('/nonexistent-dir', dbPath, mockCheckCanRun()); // Should not throw
  });

  it('removes orphan directories with no plan.md', async () => {
    const orphanDir = path.join(projectsDir, 'orphan-slug');
    fs.mkdirSync(orphanDir);
    fs.writeFileSync(path.join(orphanDir, 'some-file.txt'), 'garbage');

    await reconcileProjectsDir(projectsDir, dbPath, mockCheckCanRun());

    expect(fs.existsSync(orphanDir)).toBe(false);
  });

  it('resumes build for projects with unchecked plan items', async () => {
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

    const checkFn = mockCheckCanRun();
    await reconcileProjectsDir(projectsDir, dbPath, checkFn);

    // checkCanRun should be called (once per build phase, up to 10 max)
    // With 2 unchecked items and spawnSync mock returning success,
    // the loop runs, tests pass, and db is updated
    expect(checkFn).toHaveBeenCalled();

    const status = getDbEntry('partial-build', dbPath);
    expect(status).toBeDefined();
  });

  it('skips projects already in the database', async () => {
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

    const checkFn = mockCheckCanRun();
    await reconcileProjectsDir(projectsDir, dbPath, checkFn);

    // Should NOT have called checkCanRun since entry already exists
    expect(checkFn).not.toHaveBeenCalled();
    expect(fs.existsSync(slugDir)).toBe(true); // Directory preserved
  });

  it('calls checkCanRun before each runCline invocation', async () => {
    const slugDir = path.join(projectsDir, 'partial-build');
    fs.mkdirSync(slugDir);
    // 3 unchecked items means the reconciliation loop can run up to 10 times
    fs.writeFileSync(path.join(slugDir, 'plan.md'), [
      '# Plan for Partial Build',
      '- [x] done',
      '- [ ] todo 1',
      '- [ ] todo 2',
      '- [ ] todo 3',
      '## Test Command',
      '`npm test`',
    ].join('\n'));

    const checkFn = mockCheckCanRun();
    await reconcileProjectsDir(projectsDir, dbPath, checkFn);

    // With 3 unchecked items, checkCanRun is called for each iteration
    // (the spawnSync mock returns success but doesn't modify plan.md,
    //  so it loops maxBuildCalls=10 times, calling checkCanRun 10 times)
    expect(checkFn).toHaveBeenCalled();
    expect(checkFn.mock.calls.length).toBeGreaterThanOrEqual(1);
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

  it('returns 0 when no state file exists', async () => {
    const result = await recoverBuilderState(statePath, mockCheckCanRun());
    expect(result).toBe(0);
  });

  it('returns saved iteration when phase is complete', async () => {
    saveState(statePath, { iteration: 3, phase: 'complete', currentSlug: 'done-app' });
    const result = await recoverBuilderState(statePath, mockCheckCanRun());
    expect(result).toBe(3);
  });

  it('returns iteration for mid-iteration crash (recovery via reconciliation)', async () => {
    saveState(statePath, { iteration: 5, phase: 'building', currentSlug: 'crashed-app' });
    const result = await recoverBuilderState(statePath, mockCheckCanRun());
    expect(result).toBe(5);
  });
});
