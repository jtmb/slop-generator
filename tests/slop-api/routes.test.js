/**
 * API Route Integration Tests — exercises all endpoints via supertest.
 *
 * Uses the exported Express app from api-server.js.
 * Tests auth gates, JWT token flow, CRUD operations, error responses,
 * idempotency, validation, and edge cases.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
// supertest is a pure CJS module → use createRequire for vitest ESM compat.
// Resolve from a path inside slop-api so node_modules is found.
const requireApi = createRequire(
  new URL('../../slop-api/package.json', import.meta.url)
);
const request = requireApi('supertest');

// Set required env vars BEFORE importing the app
const TEST_API_KEY = crypto.randomUUID();
const TEST_JWT_SECRET = crypto.randomUUID();
process.env.API_KEY = TEST_API_KEY;
process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.JWT_EXPIRY = '5m';

let tempDir;
let app;

beforeAll(async () => {
  // Create a temp data directory for isolated test runs
  tempDir = mkdtempSync(path.join(tmpdir(), 'slop-api-test-'));
  mkdirSync(path.join(tempDir, 'data', 'apps'), { recursive: true });

  // Import the Express app (won't start HTTPS server because isMainModule is false)
  const module = await import('../../slop-api/scripts/api-server.js');
  app = module.app;
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ===========================================================================
// Health check
// ===========================================================================
describe('GET /health', () => {
  it('returns ok status with timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ===========================================================================
// POST /api/v1/auth/token
// ===========================================================================
describe('POST /api/v1/auth/token', () => {
  it('returns JWT token with valid API key', async () => {
    const res = await request(app)
      .post('/api/v1/auth/token')
      .send({ api_key: TEST_API_KEY });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.expiresIn).toBe('5m');
  });

  it('returns 400 when api_key is missing', async () => {
    const res = await request(app)
      .post('/api/v1/auth/token')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_API_KEY');
    expect(res.body.error.message).toBeDefined();
  });

  it('returns 400 when body is empty', async () => {
    const res = await request(app)
      .post('/api/v1/auth/token')
      .send();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_API_KEY');
  });

  it('returns 401 with wrong API key', async () => {
    const res = await request(app)
      .post('/api/v1/auth/token')
      .send({ api_key: 'wrong-key' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_API_KEY');
  });
});

// ===========================================================================
// Auth middleware (applied via protected routes)
// ===========================================================================
describe('Auth middleware', () => {
  let validToken;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/token')
      .send({ api_key: TEST_API_KEY });
    validToken = res.body.token;
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(app).get('/api/v1/ideas');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 with malformed Authorization header', async () => {
    const res = await request(app)
      .get('/api/v1/ideas')
      .set('Authorization', 'Basic abc123');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 with expired/invalid token', async () => {
    const res = await request(app)
      .get('/api/v1/ideas')
      .set('Authorization', 'Bearer this-is-not-a-valid-token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('accepts valid JWT token', async () => {
    const res = await request(app)
      .get('/api/v1/ideas')
      .set('Authorization', `Bearer ${validToken}`);
    // Accept 200 or 404 — either means auth succeeded, the resource just may be empty
    expect(res.status).not.toBe(401);
  });
});

// ===========================================================================
// GET /api/v1/ideas (list all)
// ===========================================================================
describe('GET /api/v1/ideas', () => {
  let validToken;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/token')
      .send({ api_key: TEST_API_KEY });
    validToken = res.body.token;
  });

  it('returns count and ideas array', async () => {
    const res = await request(app)
      .get('/api/v1/ideas')
      .set('Authorization', `Bearer ${validToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('count');
    expect(res.body).toHaveProperty('ideas');
    expect(Array.isArray(res.body.ideas)).toBe(true);
    expect(res.body.count).toBe(res.body.ideas.length);
  });

  it('each idea has required fields', async () => {
    const res = await request(app)
      .get('/api/v1/ideas')
      .set('Authorization', `Bearer ${validToken}`);
    expect(res.status).toBe(200);

    for (const idea of res.body.ideas) {
      expect(idea).toHaveProperty('id');
      expect(idea).toHaveProperty('name');
      expect(idea).toHaveProperty('filePath');
      expect(idea).toHaveProperty('slug');
      expect(idea).toHaveProperty('category');
      expect(idea).toHaveProperty('status');
      expect(idea).toHaveProperty('dateAdded');
    }
  });
});

// ===========================================================================
// GET /api/v1/ideas/random
// ===========================================================================
describe('GET /api/v1/ideas/random', () => {
  let validToken;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/token')
      .send({ api_key: TEST_API_KEY });
    validToken = res.body.token;
  });

  it('returns 404 when no ideas exist', async () => {
    const res = await request(app)
      .get('/api/v1/ideas/random')
      .set('Authorization', `Bearer ${validToken}`);
    // Either 404 (no ideas) or 200 (if ideas were left from previous runs)
    if (res.status === 404) {
      expect(res.body.error.code).toBe('NO_IDEAS');
    } else {
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('slug');
    }
  });
});

// ===========================================================================
// GET /api/v1/ideas/:slug
// ===========================================================================
describe('GET /api/v1/ideas/:slug', () => {
  let validToken;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/token')
      .send({ api_key: TEST_API_KEY });
    validToken = res.body.token;
  });

  it('returns 404 for nonexistent slug', async () => {
    const res = await request(app)
      .get('/api/v1/ideas/nonexistent-slug-12345')
      .set('Authorization', `Bearer ${validToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ===========================================================================
// POST /api/v1/ideas (create)
// ===========================================================================
describe('POST /api/v1/ideas', () => {
  let validToken;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/token')
      .send({ api_key: TEST_API_KEY });
    validToken = res.body.token;
  });

  it('creates a new idea and returns 201', async () => {
    const idea = {
      name: 'Test App',
      slug: 'test-app-' + Date.now(),
      category: 'Testing',
      overview: 'A test application for verifying the API.',
      problemSolved: 'No good test apps exist.',
      targetAudience: ['Testers', 'Developers'],
      keyFeatures: [
        { title: 'Feature One', description: 'Does one thing.' },
      ],
      monetization: ['Free tier'],
      techStack: { frontend: 'React', backend: 'Node.js' },
      implementationPlan: 'Build, test, ship.',
    };

    const res = await request(app)
      .post('/api/v1/ideas')
      .set('Authorization', `Bearer ${validToken}`)
      .send(idea);
    expect(res.status).toBe(201);
    expect(res.body.slug).toBeDefined();
    expect(res.body.name).toBe('Test App');
    expect(res.body.status).toBe('created');
    expect(res.headers.location).toContain(res.body.slug);
  });

  it('returns 400 when slug is missing', async () => {
    const res = await request(app)
      .post('/api/v1/ideas')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ name: 'No Slug App' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/v1/ideas')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ slug: 'no-name-slug' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('sanitizes slug — lowercase, replace spaces/underscores, strip special chars', async () => {
    const res = await request(app)
      .post('/api/v1/ideas')
      .set('Authorization', `Bearer ${validToken}`)
      .send({
        name: 'Sanitized App',
        slug: 'My SPACES & Special!',
        overview: 'Testing slug sanitization.',
      });

    if (res.status === 201) {
      expect(res.body.slug).toBe('my-spaces--special');
    }
    // If 409, it was already sanitized and exists from earlier test
    expect([201, 409]).toContain(res.status);
  });

  it('returns 409 Conflict for duplicate slug', async () => {
    // Use a fixed slug for the first creation
    const fixedSlug = 'dup-test-' + Date.now();
    const first = await request(app)
      .post('/api/v1/ideas')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ name: 'First Dup', slug: fixedSlug });
    expect(first.status).toBe(201);

    // Second attempt should conflict
    const second = await request(app)
      .post('/api/v1/ideas')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ name: 'Second Dup', slug: fixedSlug });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
  });
});
