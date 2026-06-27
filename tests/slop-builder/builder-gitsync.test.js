/**
 * Tests for slop-builder git-sync.js — orphan branch push workflow.
 * Verifies the slug-based branch naming and project isolation pattern.
 *
 * git-sync.js has module-level process.exit() calls for missing --once/--slug.
 * We set process.argv/env before import and override process.exit
 * to prevent the test runner from being killed.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const mockSpawnSync = vi.fn();
const mockWriteFileSync = vi.fn();

const originalArgv = [...process.argv];
const originalEnv = { ...process.env };
const originalExit = process.exit;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  // Set required CLI args so module-level checks pass
  process.argv = ['node', 'git-sync.js', '--once', '--slug', 'eco-track', '--message', 'feat: done'];
  process.env = { ...originalEnv, GIT_REPO_URL: 'https://token@github.com/owner/repo.git' };

  // Prevent process.exit from killing vitest
  process.exit = vi.fn();
});

afterAll(() => {
  process.argv = originalArgv;
  process.env = originalEnv;
  process.exit = originalExit;
  vi.restoreAllMocks();
});

vi.mock('child_process', () => ({
  spawnSync: mockSpawnSync,
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  writeFileSync: mockWriteFileSync,
}));

describe('builder git-sync — branch naming', () => {
  it('pushes to orphan branch build/{slug} with project-isolating .gitignore', async () => {
    // existsSync('.git') returns true → git init skipped
    // Call sequence: config user.name, config user.email, branch, checkout --orphan,
    //                rm, add, status --porcelain, commit, remote, push
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })       // 1: git config user.name
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })       // 2: git config user.email
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })       // 3: git branch ('' → no existing branch)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })       // 4: git checkout --orphan build/eco-track
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })       // 5: git rm -rf
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })       // 6: git add -A
      .mockReturnValueOnce({ status: 0, stdout: 'A  projects/eco-track/file.js\n', stderr: '' }) // 7: git status --porcelain
      .mockReturnValueOnce({ status: 0, stdout: '[build/eco-track abc123] feat: done', stderr: '' }) // 8: git commit
      .mockReturnValueOnce({ status: 0, stdout: 'origin\n', stderr: '' }) // 9: git remote
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: 'To github.com... build/eco-track' }); // 10: git push

    await import('../../slop-builder/scripts/git-sync.js');

    // Verify orphan branch checkout
    const checkoutCall = mockSpawnSync.mock.calls.find(
      call => call[0] === 'git' && call[1]?.includes('checkout') && call[1]?.includes('--orphan')
    );
    expect(checkoutCall).toBeDefined();

    // Verify push targets build/{slug}
    const pushCall = mockSpawnSync.mock.calls.find(
      call => call[0] === 'git' && call[1]?.includes('push')
    );
    expect(pushCall).toBeDefined();
    if (pushCall) {
      expect(pushCall[1]).toContain('build/eco-track');
    }

    // Verify .gitignore isolates the specific project
    expect(mockWriteFileSync).toHaveBeenCalled();
    const writeCall = mockWriteFileSync.mock.calls[0];
    expect(writeCall[1]).toContain('!/projects/eco-track/');
  });
});

