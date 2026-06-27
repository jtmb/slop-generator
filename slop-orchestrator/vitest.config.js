import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['../tests/slop-orchestrator/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['scripts/**/*.js'],
      reportsDirectory: '../tests/slop-orchestrator/coverage',
    },
    testTimeout: 10000,
  },
});
