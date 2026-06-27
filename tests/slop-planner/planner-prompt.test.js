/**
 * Tests for slop-planner buildPlanPrompt() and buildAgentPrompt().
 * Pure functions — no mocks needed.
 */
import { describe, it, expect } from 'vitest';
import { buildPlanPrompt, buildAgentPrompt } from '../../slop-planner/scripts/agent-runner.js';

describe('buildPlanPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildPlanPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('includes key planning instructions', () => {
    const prompt = buildPlanPrompt();
    expect(prompt).toContain('Planning Module');
    expect(prompt).toContain('AGENTS.md');
    expect(prompt).toContain('db.md');
    expect(prompt).toContain('plan.txt');
  });

  it('tells cline to NOT create files in apps/', () => {
    const prompt = buildPlanPrompt();
    expect(prompt).toContain('Do NOT create any files in apps/');
    expect(prompt).toContain('Do NOT modify db.md');
  });

  it('specifies the plan format template', () => {
    const prompt = buildPlanPrompt();
    expect(prompt).toContain('**App Name**');
    expect(prompt).toContain('**Category**');
    expect(prompt).toContain('**Problem It Solves**');
    expect(prompt).toContain('**Why It\'s Unique**');
    expect(prompt).toContain('**Key Features**');
    expect(prompt).toContain('**Target Audience**');
  });

  it('mentions the file system tool', () => {
    const prompt = buildPlanPrompt();
    expect(prompt).toContain('file system tool');
  });
});

describe('buildAgentPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildAgentPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('includes execution instructions', () => {
    const prompt = buildAgentPrompt();
    expect(prompt).toContain('Execution Module');
    expect(prompt).toContain('plan.txt');
    expect(prompt).toContain('db.md');
    expect(prompt).toContain('apps/');
  });

  it('tells cline to actually create files', () => {
    const prompt = buildAgentPrompt();
    expect(prompt).toContain('actually do it');
    expect(prompt).toContain('create and update files');
  });
});
