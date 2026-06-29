/**
 * Tests for slop-builder runTests() — test runner with retry logic.
 * Mocks plan.md parsing and child_process.spawnSync.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSpawnSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockWriteFileSync = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockSpawnSync.mockReset();
  mockReadFileSync.mockReset();
  mockExistsSync.mockReset();
  mockWriteFileSync.mockReset();
});

vi.mock('child_process', () => ({
  spawnSync: mockSpawnSync,
}));

vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: vi.fn(),
}));

describe('runTests', () => {
  let runTests;

  beforeEach(async () => {
    const mod = await import('../../slop-builder/scripts/agent-runner.js');
    runTests = mod.runTests;
  });

  it('returns false when plan.md is missing', () => {
    mockExistsSync.mockReturnValue(false);
    expect(runTests('/tmp/proj', 'test-slug').passed).toBe(false);
  });

  it('extracts test command from "## Test Command" section', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Test Command\n`npm test`\n\n## Something Else\n...'
    );
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'all passed', stderr: '' });

    const result = runTests('/tmp/proj', 'test-slug');

    expect(mockSpawnSync).toHaveBeenCalled();
    const callArgs = mockSpawnSync.mock.calls[0];
    expect(callArgs[0]).toBe('bash');
    expect(callArgs[1]).toContain('npm test');
    expect(result.passed).toBe(true);
  });

  it('returns true when tests pass on first attempt', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Test Command\n`pytest`\n'
    );
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '3 passed', stderr: '' });

    expect(runTests('/tmp/proj', 'test-slug').passed).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('returns false when tests fail (retry handled at caller level)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Test Command\n`go test ./...`\n'
    );

    // First call fails — no retry at this level
    mockSpawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'FAIL' })
      .mockReturnValueOnce({ status: 0, stdout: 'ok', stderr: '' });

    expect(runTests('/tmp/proj', 'test-slug').passed).toBe(false);
    // Only one call — retry is handled by caller
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('returns false with reason on test failure', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Test Command\n`npm test`\n'
    );

    // Test fails
    mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'FAIL' });

    const result = runTests('/tmp/proj', 'test-slug');
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('exit code 1');
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('falls back to finding any backtick command near "test"', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'Some plan\nRun `yarn test --coverage` to verify.\n'
    );
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'passed', stderr: '' });

    expect(runTests('/tmp/proj', 'test-slug').passed).toBe(true);
    const callArgs = mockSpawnSync.mock.calls[0];
    expect(callArgs[1]).toContain('yarn test --coverage');
  });

  it('returns false when no test command can be determined', () => {
    // Only return true for plan.md, not package.json — so no fallback test cmd
    mockExistsSync.mockImplementation((p) => !p.includes('package.json'));
    mockReadFileSync.mockReturnValue(
      'A plan with no test command anywhere.\nJust prose.\n'
    );

    const result = runTests('/tmp/proj', 'test-slug');
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('no test command defined');
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});
