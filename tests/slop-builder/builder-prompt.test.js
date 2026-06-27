/**
 * Tests for slop-builder prompt builders — buildDeepPlanPrompt() and buildExecutePrompt().
 * Pure functions — no mocks needed.
 */
import { describe, it, expect } from 'vitest';
import { buildDeepPlanPrompt, buildExecutePrompt } from '../../slop-builder/scripts/agent-runner.js';

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
