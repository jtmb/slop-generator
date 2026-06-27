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
    expect(runTests('/tmp/proj', 'test-slug')).toBe(false);
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
    expect(result).toBe(true);
  });

  it('returns true when tests pass on first attempt', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Test Command\n`pytest`\n'
    );
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '3 passed', stderr: '' });

    expect(runTests('/tmp/proj', 'test-slug')).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds on retry', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Test Command\n`go test ./...`\n'
    );

    // First call fails, second succeeds
    mockSpawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'FAIL' })
      .mockReturnValueOnce({ status: 0, stdout: 'ok', stderr: '' });

    expect(runTests('/tmp/proj', 'test-slug')).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
  });

  it('returns false after exhausting all retries', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Test Command\n`npm test`\n'
    );

    // All retries fail
    mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'FAIL' });

    expect(runTests('/tmp/proj', 'test-slug')).toBe(false);
    // Default max_test_retries should be > 1
    expect(mockSpawnSync.mock.calls.length).toBeGreaterThan(1);
  });

  it('falls back to finding any backtick command near "test"', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'Some plan\nRun `yarn test --coverage` to verify.\n'
    );
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'passed', stderr: '' });

    expect(runTests('/tmp/proj', 'test-slug')).toBe(true);
    const callArgs = mockSpawnSync.mock.calls[0];
    expect(callArgs[1]).toContain('yarn test --coverage');
  });

  it('returns false when no test command can be determined', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'A plan with no test command anywhere.\nJust prose.\n'
    );

    expect(runTests('/tmp/proj', 'test-slug')).toBe(false);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});
