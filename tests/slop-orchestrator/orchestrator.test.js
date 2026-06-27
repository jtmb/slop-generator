/**
 * slop-orchestrator route tests.
 *
 * Tests the state machine: health, check-in, progress, batch completion, and error cases.
 * Uses Node built-in http module (no supertest dependency needed).
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { app, state, BATCH_SIZE, persistState, restoreState } from '../../slop-orchestrator/scripts/orchestrator.js';

let server;
let baseURL;

beforeAll(async () => {
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      baseURL = `http://localhost:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  state.turn = 'planner';
  state.plannerProgress = 0;
  state.builderProgress = 0;
});

// Helper: send HTTP request returning { status, body }
async function req(method, path, body) {
  const url = new URL(path, baseURL);
  const options = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) options.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));

  return new Promise((resolve, reject) => {
    const r = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns ok with current state', async () => {
    const res = await req('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.turn).toBe('planner');
    expect(res.body.batchSize).toBe(BATCH_SIZE);
    expect(res.body.plannerProgress).toBe(0);
    expect(res.body.builderProgress).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /state
// ---------------------------------------------------------------------------

describe('GET /state', () => {
  it('returns full state object', async () => {
    const res = await req('GET', '/state');
    expect(res.status).toBe(200);
    expect(res.body.turn).toBe('planner');
    expect(res.body.plannerProgress).toBe(0);
    expect(res.body.builderProgress).toBe(0);
    expect(res.body.batchSize).toBe(BATCH_SIZE);
  });
});

// ---------------------------------------------------------------------------
// POST /check-in
// ---------------------------------------------------------------------------

describe('POST /check-in', () => {
  it('returns can_run=true when role matches turn', async () => {
    const res = await req('POST', '/check-in', { role: 'planner' });
    expect(res.status).toBe(200);
    expect(res.body.can_run).toBe(true);
    expect(res.body.turn).toBe('planner');
  });

  it('returns can_run=false when role does not match turn', async () => {
    const res = await req('POST', '/check-in', { role: 'builder' });
    expect(res.status).toBe(200);
    expect(res.body.can_run).toBe(false);
    expect(res.body.turn).toBe('planner');
  });

  it('returns 400 for missing role', async () => {
    const res = await req('POST', '/check-in', {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ROLE');
  });

  it('returns 400 for invalid role', async () => {
    const res = await req('POST', '/check-in', { role: 'watcher' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ROLE');
  });

  it('returns current progress in response', async () => {
    state.plannerProgress = 3;
    const res = await req('POST', '/check-in', { role: 'planner' });
    expect(res.body.progress).toBe(3);
    expect(res.body.can_run).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /progress
// ---------------------------------------------------------------------------

describe('POST /progress', () => {
  it('increments progress for matching role', async () => {
    const res = await req('POST', '/progress', { role: 'planner' });
    expect(res.status).toBe(200);
    expect(res.body.batch_complete).toBe(false);
    expect(res.body.progress).toBe(1);
    expect(state.plannerProgress).toBe(1);
  });

  it('returns 409 when reporting out of turn', async () => {
    const res = await req('POST', '/progress', { role: 'builder' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WRONG_TURN');
  });

  it('returns 400 for missing role', async () => {
    const res = await req('POST', '/progress', {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ROLE');
  });

  it('returns 400 for invalid role', async () => {
    const res = await req('POST', '/progress', { role: 'spectator' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ROLE');
  });
});

// ---------------------------------------------------------------------------
// Full batch cycle
// ---------------------------------------------------------------------------

describe('Full batch cycle', () => {
  it('flips turn after BATCH_SIZE planner progress reports', async () => {
    expect(state.turn).toBe('planner');

    // Report BATCH_SIZE - 1 progress => no flip
    let res;
    for (let i = 0; i < BATCH_SIZE - 1; i++) {
      res = await req('POST', '/progress', { role: 'planner' });
      expect(res.status).toBe(200);
      expect(res.body.batch_complete).toBe(false);
    }

    // Last planner progress => batch complete, turn flips
    res = await req('POST', '/progress', { role: 'planner' });
    expect(res.status).toBe(200);
    expect(res.body.batch_complete).toBe(true);
    expect(res.body.turn).toBe('builder');
    expect(res.body.progress).toBe(0);
    expect(state.turn).toBe('builder');
    expect(state.plannerProgress).toBe(0);
    expect(state.builderProgress).toBe(0);

    // Builder can now run
    const checkIn = await req('POST', '/check-in', { role: 'builder' });
    expect(checkIn.body.can_run).toBe(true);

    // Planner blocked
    const blocked = await req('POST', '/check-in', { role: 'planner' });
    expect(blocked.body.can_run).toBe(false);
  });

  it('flips turn after BATCH_SIZE builder progress reports (full round trip)', async () => {
    // Complete planner batch first
    for (let i = 0; i < BATCH_SIZE; i++) {
      await req('POST', '/progress', { role: 'planner' });
    }
    expect(state.turn).toBe('builder');

    // Report BATCH_SIZE - 1 builder progress
    for (let i = 0; i < BATCH_SIZE - 1; i++) {
      const res = await req('POST', '/progress', { role: 'builder' });
      expect(res.body.batch_complete).toBe(false);
    }

    // Last builder progress => round trip complete, back to planner
    const res = await req('POST', '/progress', { role: 'builder' });
    expect(res.status).toBe(200);
    expect(res.body.batch_complete).toBe(true);
    expect(res.body.turn).toBe('planner');
    expect(state.turn).toBe('planner');
  });

  it('builder cannot report progress during planner turn', async () => {
    const res = await req('POST', '/progress', { role: 'builder' });
    expect(res.status).toBe(409);
    expect(state.builderProgress).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

describe('Orchestrator state persistence', () => {
  it('persistState writes a JSON file to /tmp', () => {
    state.turn = 'builder';
    state.plannerProgress = 4;
    state.builderProgress = 1;

    persistState();

    const fs = require('fs');
    expect(fs.existsSync('/tmp/orchestrator-state.json')).toBe(true);

    const saved = JSON.parse(fs.readFileSync('/tmp/orchestrator-state.json', 'utf-8'));
    expect(saved.turn).toBe('builder');
    expect(saved.plannerProgress).toBe(4);
    expect(saved.builderProgress).toBe(1);
    expect(saved.lastUpdated).toBeDefined();

    // Clean up
    state.turn = 'planner';
    state.plannerProgress = 0;
    state.builderProgress = 0;
  });

  it('restoreState reads persisted state back into memory', () => {
    // First persist some state
    state.turn = 'planner';
    state.plannerProgress = 3;
    state.builderProgress = 0;
    persistState();

    // Reset state
    state.turn = 'builder';
    state.plannerProgress = 0;
    state.builderProgress = 0;

    // Restore
    restoreState();

    expect(state.turn).toBe('planner');
    expect(state.plannerProgress).toBe(3);
    expect(state.builderProgress).toBe(0);

    // Clean up
    state.turn = 'planner';
    state.plannerProgress = 0;
  });

  it('restoreState is a no-op when no file exists', () => {
    const fs = require('fs');
    if (fs.existsSync('/tmp/orchestrator-state.json')) {
      fs.unlinkSync('/tmp/orchestrator-state.json');
    }

    state.turn = 'builder';
    state.plannerProgress = 5;

    restoreState();

    // State should be unchanged since there was no file to restore
    expect(state.turn).toBe('builder');
    expect(state.plannerProgress).toBe(5);
  });
});
