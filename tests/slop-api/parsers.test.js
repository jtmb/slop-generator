/**
 * Tests for the leaf-level markdown parsers exported from api-server.js.
 * These are pure functions — no filesystem dependencies.
 *
 * parseBulletList, parseKeyFeatures, parseStrategyList,
 * parseTechStack, parseProgressChecklist
 */
import { describe, it, expect } from 'vitest';
import {
  parseBulletList,
  parseKeyFeatures,
  parseStrategyList,
  parseTechStack,
  parseProgressChecklist,
} from '../../slop-api/scripts/api-server.js';

describe('parseBulletList', () => {
  it('extracts dash-prefixed lines into array', () => {
    const input = '- First item\n- Second item\n- Third item';
    expect(parseBulletList(input)).toEqual([
      'First item',
      'Second item',
      'Third item',
    ]);
  });

  it('handles asterisk bullets', () => {
    const input = '* Alpha\n* Beta';
    expect(parseBulletList(input)).toEqual(['Alpha', 'Beta']);
  });

  it('strips leading whitespace from bullet items', () => {
    const input = '  - Padded item\n  - Another one';
    expect(parseBulletList(input)).toEqual(['Padded item', 'Another one']);
  });

  it('returns raw text as single-element array when no bullets found', () => {
    const input = 'Just a plain paragraph with no bullet markers.';
    const result = parseBulletList(input);
    expect(result).toEqual([input]);
  });

  it('returns empty text as single-element array', () => {
    expect(parseBulletList('')).toEqual(['']);
  });

  it('ignores blank lines between bullets', () => {
    const input = '- Item A\n\n- Item B\n\n- Item C';
    expect(parseBulletList(input)).toEqual(['Item A', 'Item B', 'Item C']);
  });
});

describe('parseKeyFeatures', () => {
  it('parses numbered features with title and description', () => {
    const input = '1. **Activity Logging**: Easy-to-use interface for logging activities.\n2. **Dashboard**: Visual charts and graphs.';
    expect(parseKeyFeatures(input)).toEqual([
      { title: 'Activity Logging', description: 'Easy-to-use interface for logging activities.' },
      { title: 'Dashboard', description: 'Visual charts and graphs.' },
    ]);
  });

  it('parses feature with title only (no colon)', () => {
    const input = '1. **Offline Mode**\n2. **Dark Theme**';
    expect(parseKeyFeatures(input)).toEqual([
      { title: 'Offline Mode', description: '' },
      { title: 'Dark Theme', description: '' },
    ]);
  });

  it('returns raw text as single-element array when no numbered pattern', () => {
    const input = 'No numbered features here.';
    expect(parseKeyFeatures(input)).toEqual([input]);
  });

  it('handles mixed title-only and title+description', () => {
    const input = '1. **Auth**\n2. **Payments**: Stripe integration for subscriptions.';
    expect(parseKeyFeatures(input)).toEqual([
      { title: 'Auth', description: '' },
      { title: 'Payments', description: 'Stripe integration for subscriptions.' },
    ]);
  });

  it('handles colons within descriptions', () => {
    const input = '1. **Import**: Support for CSV, JSON, and XML: all major formats.';
    expect(parseKeyFeatures(input)).toEqual([
      { title: 'Import', description: 'Support for CSV, JSON, and XML: all major formats.' },
    ]);
  });
});

describe('parseStrategyList', () => {
  it('parses dash-prefixed strategy items', () => {
    const input = '- Freemium Model: Free basic; Premium $4.99/month\n- Corporate: B2B SaaS';
    expect(parseStrategyList(input)).toEqual([
      'Freemium Model: Free basic; Premium $4.99/month',
      'Corporate: B2B SaaS',
    ]);
  });

  it('parses numbered strategy items', () => {
    const input = '1. First strategy\n2. Second strategy';
    expect(parseStrategyList(input)).toEqual([
      'First strategy',
      'Second strategy',
    ]);
  });

  it('returns raw text when no list markers found', () => {
    const input = 'Plain text, no list format.';
    expect(parseStrategyList(input)).toEqual([input]);
  });
});

describe('parseTechStack', () => {
  it('parses bold-keyed tech stack into object', () => {
    const input = '- **Frontend**: React\n- **Backend**: Node.js\n- **Database**: PostgreSQL';
    expect(parseTechStack(input)).toEqual({
      frontend: 'React',
      backend: 'Node.js',
      database: 'PostgreSQL',
    });
  });

  it('lowercases and replaces spaces with underscores in keys', () => {
    const input = '- **Machine Learning**: TensorFlow';
    expect(parseTechStack(input)).toEqual({
      machine_learning: 'TensorFlow',
    });
  });

  it('returns raw text when no bold-key pattern found', () => {
    const input = 'Just some tech notes without bold keys.';
    expect(parseTechStack(input)).toEqual(input.trim());
  });
});

describe('parseProgressChecklist', () => {
  it('parses checked and unchecked items', () => {
    const input = '- [x] Idea Generated\n- [ ] Plan Created\n- [ ] Development Started\n- [ ] MVP Complete\n- [ ] Launched';
    expect(parseProgressChecklist(input)).toEqual({
      idea_generated: true,
      plan_created: false,
      development_started: false,
      mvp_complete: false,
      launched: false,
    });
  });

  it('handles all checked items', () => {
    const input = '- [x] Idea Generated\n- [x] Plan Created';
    expect(parseProgressChecklist(input)).toEqual({
      idea_generated: true,
      plan_created: true,
    });
  });

  it('handles all unchecked items', () => {
    const input = '- [ ] Idea Generated\n- [ ] Plan Created';
    expect(parseProgressChecklist(input)).toEqual({
      idea_generated: false,
      plan_created: false,
    });
  });

  it('strips punctuation from keys', () => {
    const input = '- [x] User Auth (OAuth 2.0)!';
    expect(parseProgressChecklist(input)).toEqual({
      user_auth_oauth_2_0: true,
    });
  });

  it('returns raw text when no checklist pattern found', () => {
    const input = 'Not a checklist.\nJust notes.';
    expect(parseProgressChecklist(input)).toEqual(input.trim());
  });
});
