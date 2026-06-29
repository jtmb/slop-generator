/**
 * Tests for slop-builder database functions — isAlreadyBuilt() and updateDatabase().
 * Uses vi.mock to stub filesystem calls.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
}));

describe('isAlreadyBuilt', () => {
  let isAlreadyBuilt;

  beforeEach(async () => {
    const mod = await import('../../slop-builder/scripts/agent-runner.js');
    isAlreadyBuilt = mod.isAlreadyBuilt;
  });

  it('returns false when db.md does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(isAlreadyBuilt('eco-track')).toBe(false);
  });

  it('returns true when slug has Complete status', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Project #1: EcoTrack\n- **Slug**: `eco-track`\n- **Status**: Complete\n- **Date Completed**: 2026-06-25\n'
    );
    expect(isAlreadyBuilt('eco-track')).toBe(true);
  });

  it('returns true when slug has Tests Failed status (prevents re-fetching)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Project #1: EcoTrack\n- **Slug**: `eco-track`\n- **Status**: Tests Failed\n- **Date Completed**: 2026-06-25\n'
    );
    expect(isAlreadyBuilt('eco-track')).toBe(true);
  });

  it('returns false when slug not found in any entry', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Project #1: EcoTrack\n- **Slug**: `eco-track`\n- **Status**: Complete\n'
    );
    expect(isAlreadyBuilt('skill-swap-connect')).toBe(false);
  });

  it('matches slug exactly (not partial)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Project #1: EcoTrack\n- **Slug**: `eco-track`\n- **Status**: Complete\n'
    );
    // 'eco' should not match 'eco-track'
    expect(isAlreadyBuilt('eco')).toBe(false);
  });
});

describe('updateDatabase', () => {
  let updateDatabase;

  beforeEach(async () => {
    const mod = await import('../../slop-builder/scripts/agent-runner.js');
    updateDatabase = mod.updateDatabase;
  });

  it('creates a new db.md when none exists', () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');

    updateDatabase('eco-track', 'EcoTrack', 'Complete', '/tmp/test-db.md');

    expect(mockMkdirSync).toHaveBeenCalled();
    const writeCall = mockWriteFileSync.mock.calls[0];
    const content = writeCall[1];

    expect(content).toContain('## Project #1: EcoTrack');
    expect(content).toContain('- **Slug**: `eco-track`');
    expect(content).toContain('- **Status**: Complete');
    expect(content).toContain('## Total Projects Built: 1');
  });

  it('updates status for existing project entry', () => {
    const existingDb =
      '## Total Projects Built: 2\n\n' +
      '## Project #1: EcoTrack\n- **Slug**: `eco-track`\n- **Status**: Tests Failed\n\n' +
      '## Project #2: BudgetBuddy\n- **Slug**: `budget-buddy-ai`\n- **Status**: Complete\n';

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(existingDb);

    updateDatabase('eco-track', 'EcoTrack', 'Complete', '/tmp/test-db.md');

    const writeCall = mockWriteFileSync.mock.calls[0];
    const content = writeCall[1];

    // Status should be updated to Complete
    expect(content).toContain('- **Status**: Complete');
    // Other entries should remain untouched
    expect(content).toContain('BudgetBuddy');
    // Total count should not change on update
    expect(content).toContain('## Total Projects Built: 2');
  });

  it('appends new entry to existing database', () => {
    const existingDb =
      '## Total Projects Built: 1\n\n' +
      '## Project #1: EcoTrack\n- **Slug**: `eco-track`\n- **Status**: Complete\n\n';

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(existingDb);

    updateDatabase('budget-buddy-ai', 'BudgetBuddy', 'Tests Failed', '/tmp/test-db.md');

    const writeCall = mockWriteFileSync.mock.calls[0];
    const content = writeCall[1];

    expect(content).toContain('## Project #2: BudgetBuddy');
    expect(content).toContain('## Total Projects Built: 2');
  });

  it('does not duplicate entries for same slug', () => {
    const existingDb =
      '## Total Projects Built: 1\n\n' +
      '## Project #1: EcoTrack\n- **Slug**: `eco-track`\n- **Status**: Tests Failed\n';

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(existingDb);

    updateDatabase('eco-track', 'EcoTrack', 'Complete', '/tmp/test-db.md');

    const writeCall = mockWriteFileSync.mock.calls[0];
    const content = writeCall[1];

    // Should only appear once
    const matches = content.match(/EcoTrack/g);
    expect(matches.length).toBe(1);
    // Total should remain 1
    expect(content).toContain('## Total Projects Built: 1');
  });
});

describe('getFailedProjects', () => {
  let getFailedProjects;

  beforeEach(async () => {
    const mod = await import('../../slop-builder/scripts/agent-runner.js');
    getFailedProjects = mod.getFailedProjects;
  });

  it('returns empty when db.md does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(getFailedProjects('/tmp/db.md')).toEqual([]);
  });

  it('returns Tests Failed projects', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Project #1: EcoTrack\n- **Slug**: `eco-track`\n- **Status**: Tests Failed\n\n' +
      '## Project #2: BudgetBuddy\n- **Slug**: `budget-buddy`\n- **Status**: Complete\n'
    );
    const result = getFailedProjects('/tmp/db.md');
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('eco-track');
  });

  it('returns Built (push failed) projects', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Project #1: EcoTrack\n- **Slug**: `eco-track`\n- **Status**: Built (push failed)\n'
    );
    const result = getFailedProjects('/tmp/db.md');
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('eco-track');
  });

  it('returns Complete (tests failed) projects for retry', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Project #1: EcoTrack\n- **Slug**: `eco-track`\n- **Status**: Complete (tests failed)\n\n' +
      '## Project #2: BudgetBuddy\n- **Slug**: `budget-buddy`\n- **Status**: Complete\n'
    );
    const result = getFailedProjects('/tmp/db.md');
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('eco-track');
  });

  it('does not return Complete projects', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Project #1: EcoTrack\n- **Slug**: `eco-track`\n- **Status**: Complete\n'
    );
    const result = getFailedProjects('/tmp/db.md');
    expect(result).toHaveLength(0);
  });

  it('returns projects sorted oldest-first', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '## Project #1: Alpha\n- **Slug**: `alpha`\n- **Status**: Tests Failed\n\n' +
      '## Project #2: Beta\n- **Slug**: `beta`\n- **Status**: Complete (tests failed)\n\n' +
      '## Project #3: Gamma\n- **Slug**: `gamma`\n- **Status**: Tests Failed\n'
    );
    const result = getFailedProjects('/tmp/db.md');
    expect(result).toHaveLength(3);
    expect(result.map(r => r.slug)).toEqual(['alpha', 'beta', 'gamma']);
  });
});
