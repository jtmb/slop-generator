---
description: "Mandatory testing rules — tests for every feature, no matter how small. Defines test directory structure and naming conventions."
applyTo: "**"
---

# Testing — Mandatory

Every feature, no matter how small, requires tests. Tests are not optional.

## Core Principle

> If it ships without a test, it ships with a bug waiting to happen.

Tests protect against regressions, document expected behavior, and give confidence to refactor. Skipping tests is technical debt.

## Test Directory Structure

```
tests/
├── slop-api/           # API microservice tests
│   ├── fixtures/       # Static test data (db.md, idea.json, idea.md)
│   ├── parsers.test.js       # Markdown parser unit tests
│   ├── parseDatabase.test.js # Database parser tests
│   └── routes.test.js        # API route integration tests (supertest)
│
├── slop-planner/       # Planner agent tests
│   ├── fixtures/       # Sample plan.txt, prompts
│   ├── planner-prompt.test.js   # Prompt builder tests
│   ├── planner-runner.test.js   # Agent runner unit + mock tests
│   └── planner-gitsync.test.js  # Git sync tests
│
└── slop-builder/       # Builder agent tests
    ├── fixtures/       # Sample db.md, idea.json, plan.md
    ├── builder-database.test.js # Database read/write tests
    ├── builder-tests.test.js    # Test runner + retry logic tests
    ├── builder-prompt.test.js   # Prompt builder tests
    └── builder-gitsync.test.js  # Git sync orphan branch tests
```

## When to Write Tests

**Always.** For every:
- New function or method
- New API endpoint or route
- Bug fix (write a regression test that fails without the fix)
- Refactor (existing tests must pass; add tests for changed behavior)
- New configuration or environment variable handling
- Error handling path (test the error, not just the happy path)

## Test Framework

- **Runner**: [Vitest](https://vitest.dev/) (v3.x)
- **HTTP Integration**: [Supertest](https://github.com/ladjs/supertest) (slop-api only)
- **Environment**: Node.js (native, no jsdom needed)
- **Coverage**: v8 provider, enabled by default

Configuration files (`vitest.config.js`) live at each service root and point to `../tests/{service}/`.

## Test Types

### Unit Tests (always)
Test individual functions in isolation. Mock external dependencies (fs, child_process, axios, network).
- Test happy path, edge cases, error paths
- Files named `{feature}.test.js`

### Integration Tests (for APIs and I/O)
Test the full request/response cycle or filesystem interaction.
- Use supertest for Express routes
- Use real fixture files in temp directories for filesystem tests
- Files named `{routes|integration}.test.js`

### Smoke Tests (for startup-critical paths)
Verify the service starts, health check responds, and auth flow works.
- Run in CI on every push
- Keep fast (<5 seconds)

## Testing Patterns

### Mocking external dependencies
```javascript
import { vi } from 'vitest';

// Mock fs for a database function test
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => 'mock content'),
  existsSync: vi.fn(() => true),
  writeFileSync: vi.fn(),
}));

// Mock child_process for a CLI runner test
vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: 'ok', stderr: '' })),
}));
```

### Mocking axios for API client tests
```javascript
vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      post: vi.fn().mockResolvedValue({ data: { token: 'jwt' } }),
      get: vi.fn().mockResolvedValue({ data: { slug: 'test' } }),
    })),
  },
}));
```

### Testing Express routes with supertest
```javascript
import request from 'supertest';
import { app } from '../slop-api/scripts/api-server.js';

// The app must be exported and NOT auto-listen()
const res = await request(app)
  .post('/api/v1/auth/token')
  .send({ api_key: 'test-key' });
expect(res.status).toBe(200);
expect(res.body.token).toBeDefined();
```

## Test Quality Checklist

Before committing tests:
- [ ] Every new function has at least one test
- [ ] Happy path AND error path are both tested
- [ ] Edge cases: empty input, null/undefined, boundary values
- [ ] Tests are independent (no shared state between tests)
- [ ] Mocks are cleaned up (vi.clearAllMocks in beforeEach)
- [ ] Test descriptions are clear: `it('returns 401 when API key is invalid')`
- [ ] No skipped tests (`it.skip`) without a tracking issue

## Running Tests

```bash
# All services
npm test --workspaces

# Specific service
cd slop-api && npm test
cd slop-planner && npm test
cd slop-builder && npm test

# With coverage
cd slop-api && npx vitest run --coverage
```

## CI Enforcement

Tests run on every push. A test failure blocks merge. No exceptions.
