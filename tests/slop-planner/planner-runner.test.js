/**
 * Tests for slop-planner configureProvider() and runCline().
 * Uses vi.mock to stub fs.writeFileSync, mkdirSync, and child_process.spawnSync.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs before importing the module
vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import { mkdirSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { configureProvider, runCline } from '../../slop-planner/scripts/agent-runner.js';

describe('configureProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates .cline directory on first run', () => {
    configureProvider();
    expect(mkdirSync).toHaveBeenCalled();
    const callArgs = mkdirSync.mock.calls[0];
    expect(callArgs[0]).toContain('.cline');
    expect(callArgs[1]).toEqual({ recursive: true });
  });

  it('writes providers.json with LM Studio config', () => {
    configureProvider();
    expect(writeFileSync).toHaveBeenCalled();
    const callArgs = writeFileSync.mock.calls[0];
    expect(callArgs[0]).toContain('providers.json');

    const config = JSON.parse(callArgs[1]);
    expect(config).toHaveProperty('version', 1);
    expect(config).toHaveProperty('lastUsedProvider', 'lmstudio');
    expect(config.providers.lmstudio.settings).toHaveProperty('provider', 'lmstudio');
    expect(config.providers.lmstudio.settings).toHaveProperty('model');
    expect(config.providers.lmstudio.settings).toHaveProperty('baseUrl');
  });
});

describe('runCline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls spawnSync with cline and provider args', () => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: 'output from cline',
      stderr: '',
      error: null,
    });

    const result = runCline('test prompt');
    expect(spawnSync).toHaveBeenCalledTimes(1);

    const callArgs = spawnSync.mock.calls[0];
    expect(callArgs[0]).toBe('cline');
    expect(callArgs[1]).toContain('-P');
    expect(callArgs[1]).toContain('test prompt');
  });

  it('returns stdout on success', () => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: 'generated output',
      stderr: '',
      error: null,
    });

    expect(runCline('prompt')).toBe('generated output');
  });

  it('throws on non-zero exit code', () => {
    spawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'something went wrong',
      error: null,
    });

    expect(() => runCline('bad prompt')).toThrow('something went wrong');
  });

  it('throws on spawn error (e.g. cline not found)', () => {
    spawnSync.mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('ENOENT: no such file or directory'),
    });

    expect(() => runCline('prompt')).toThrow('ENOENT');
  });

  it('uses configured timeout from settings', () => {
    spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '', error: null });
    runCline('prompt');

    const callArgs = spawnSync.mock.calls[0];
    // The third argument should be an options object with timeout
    const options = callArgs[2];
    expect(options).toHaveProperty('timeout');
    expect(options.timeout).toBeGreaterThan(0);
  });
});
