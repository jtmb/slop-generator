/**
 * Tests for slop-builder prompt builders — buildDeepPlanPrompt(), buildExecutePrompt(),
 * buildSimpleTaskPrompt(), parseNextUncheckedTask(), and markTaskDone().
 * Pure functions — no mocks needed for prompt builders.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildDeepPlanPrompt,
  buildExecutePrompt,
  buildSimpleTaskPrompt,
  parseNextUncheckedTask,
  markTaskDone,
} from '../../slop-builder/scripts/agent-runner.js';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

const sampleIdea = {
  name: 'EcoTrack',
  slug: 'eco-track',
  category: 'Sustainability',
  overview: 'Track your carbon footprint.',
  features: ['Logging', 'Dashboard'],
  targetAudience: ['Individuals', 'Families'],
};

describe('buildDeepPlanPrompt', () => {
  it('returns a prompt containing the slug for project directory', () => {
    const prompt = buildDeepPlanPrompt(sampleIdea);
    expect(prompt).toContain('eco-track');
  });

  it('embeds the idea JSON', () => {
    const prompt = buildDeepPlanPrompt(sampleIdea);
    expect(prompt).toContain('"name": "EcoTrack"');
    expect(prompt).toContain('"slug": "eco-track"');
  });

  it('instructs to read AGENTS.md', () => {
    const prompt = buildDeepPlanPrompt(sampleIdea);
    expect(prompt).toContain('AGENTS.md');
  });

  it('instructs to write plan.md', () => {
    const prompt = buildDeepPlanPrompt(sampleIdea);
    expect(prompt).toContain('plan.md');
  });

  it('mentions .clinerules/instructions/', () => {
    const prompt = buildDeepPlanPrompt(sampleIdea);
    expect(prompt).toContain('.clinerules/instructions/');
  });

  it('tells cline NOT to create code yet', () => {
    const prompt = buildDeepPlanPrompt(sampleIdea);
    expect(prompt).toContain('Do NOT create any code yet');
  });

  it('tells cline NOT to modify db.md', () => {
    const prompt = buildDeepPlanPrompt(sampleIdea);
    expect(prompt).toContain('Do NOT modify db.md');
  });
});

describe('buildExecutePrompt', () => {
  it('includes the plan path', () => {
    const prompt = buildExecutePrompt('/app/projects/eco-track', '/app/projects/eco-track/plan.md');
    expect(prompt).toContain('/app/projects/eco-track/plan.md');
  });

  it('instructs to read AGENTS.md', () => {
    const prompt = buildExecutePrompt('/proj', '/proj/plan.md');
    expect(prompt).toContain('AGENTS.md');
  });

  it('instructs to find the next unchecked phase', () => {
    const prompt = buildExecutePrompt('/proj', '/proj/plan.md');
    expect(prompt).toContain('- [ ]');
  });

  it('instructs to update plan.md checkboxes', () => {
    const prompt = buildExecutePrompt('/proj', '/proj/plan.md');
    expect(prompt).toContain('- [x]');
  });

  it('instructs STOP after one phase', () => {
    const prompt = buildExecutePrompt('/proj', '/proj/plan.md');
    expect(prompt).toContain('STOP after completing ONE phase');
  });
});

describe('buildSimpleTaskPrompt', () => {
  const taskInfo = {
    taskText: 'Set up Express server with middleware stack',
    phaseHeading: 'Phase 3: Core Backend',
    lineNumber: 42,
  };

  it('includes the slug in the prompt', () => {
    const prompt = buildSimpleTaskPrompt('test-app', '/app/projects/test-app', '/app/projects/test-app/plan.md', taskInfo);
    expect(prompt).toContain('test-app');
  });

  it('includes the task text', () => {
    const prompt = buildSimpleTaskPrompt('test-app', '/app/projects/test-app', '/app/projects/test-app/plan.md', taskInfo);
    expect(prompt).toContain('Set up Express server with middleware stack');
  });

  it('includes the phase heading', () => {
    const prompt = buildSimpleTaskPrompt('test-app', '/app/projects/test-app', '/app/projects/test-app/plan.md', taskInfo);
    expect(prompt).toContain('Phase 3: Core Backend');
  });

  it('says to use ONLY run_commands', () => {
    const prompt = buildSimpleTaskPrompt('test-app', '/app/projects/test-app', '/app/projects/test-app/plan.md', taskInfo);
    expect(prompt).toContain('Use ONLY the run_commands tool');
  });

  it('tells NOT to use the editor tool', () => {
    const prompt = buildSimpleTaskPrompt('test-app', '/app/projects/test-app', '/app/projects/test-app/plan.md', taskInfo);
    expect(prompt).toContain('editor tool');
    expect(prompt).toContain('BROKEN');
  });

  it('tells NOT to update plan.md', () => {
    const prompt = buildSimpleTaskPrompt('test-app', '/app/projects/test-app', '/app/projects/test-app/plan.md', taskInfo);
    expect(prompt).toContain('Do NOT try to update plan.md');
  });

  it('gives file hint based on task type', () => {
    const prompt = buildSimpleTaskPrompt('test-app', '/app/projects/test-app', '/app/projects/test-app/plan.md', taskInfo);
    expect(prompt).toContain('Create');
  });
});

describe('parseNextUncheckedTask', () => {
  const testDir = path.join(tmpdir(), 'builder-prompt-test-' + Date.now());

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('returns null when file does not exist', () => {
    const result = parseNextUncheckedTask(path.join(testDir, 'nonexistent.md'));
    expect(result).toBeNull();
  });

  it('returns null when all items are checked', () => {
    const planPath = path.join(testDir, 'plan.md');
    writeFileSync(planPath, '## Phase 1: Setup\n- [x] Done task\n## Phase 2: Build\n- [x] Also done\n');
    const result = parseNextUncheckedTask(planPath);
    expect(result).toBeNull();
  });

  it('returns first unchecked item', () => {
    const planPath = path.join(testDir, 'plan.md');
    writeFileSync(planPath, '## Phase 1: Setup\n- [x] Done task\n- [ ] First unchecked\n- [ ] Second unchecked\n');
    const result = parseNextUncheckedTask(planPath);
    expect(result).not.toBeNull();
    expect(result.taskText).toBe('First unchecked');
    expect(result.lineNumber).toBe(2); // 0-indexed: line 2 is the third line
    expect(result.phaseHeading).toBe('Phase 1: Setup');
  });

  it('tracks phase heading changes', () => {
    const planPath = path.join(testDir, 'plan.md');
    writeFileSync(planPath, '## Phase 1: Setup\n- [x] Done\n## Phase 2: Build\n- [ ] Build task\n');
    const result = parseNextUncheckedTask(planPath);
    expect(result).not.toBeNull();
    expect(result.phaseHeading).toBe('Phase 2: Build');
    expect(result.taskText).toBe('Build task');
  });

  it('handles no phase heading before first task', () => {
    const planPath = path.join(testDir, 'plan.md');
    writeFileSync(planPath, '- [ ] No phase task\n');
    const result = parseNextUncheckedTask(planPath);
    expect(result).not.toBeNull();
    expect(result.phaseHeading).toBe('Unknown Phase');
  });
});

describe('markTaskDone', () => {
  const testDir = path.join(tmpdir(), 'builder-marktest-' + Date.now());

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('returns false for invalid line number', () => {
    const planPath = path.join(testDir, 'plan.md');
    writeFileSync(planPath, '- [ ] Task\n');
    const result = markTaskDone(planPath, 99);
    expect(result).toBe(false);
  });

  it('returns false for non-task line', () => {
    const planPath = path.join(testDir, 'plan.md');
    writeFileSync(planPath, 'Not a task\n');
    const result = markTaskDone(planPath, 0);
    expect(result).toBe(false);
  });

  it('marks a task as done and returns true', () => {
    const planPath = path.join(testDir, 'plan.md');
    writeFileSync(planPath, '- [ ] Test task\n- [ ] Another task\n');
    const result = markTaskDone(planPath, 0);
    expect(result).toBe(true);
    const content = readFileSync(planPath, 'utf-8');
    expect(content).toContain('- [x] Test task');
    expect(content).toContain('- [ ] Another task');
  });

  it('handles indented checkboxes', () => {
    const planPath = path.join(testDir, 'plan.md');
    writeFileSync(planPath, '  - [ ] Indented task\n');
    const result = markTaskDone(planPath, 0);
    expect(result).toBe(true);
    const content = readFileSync(planPath, 'utf-8');
    expect(content).toBe('  - [x] Indented task\n');
  });
});
