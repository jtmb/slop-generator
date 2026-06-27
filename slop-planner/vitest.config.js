import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['../tests/slop-planner/**/*.test.js'],
    environment: 'node',
    globals: false,
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: '../tests/slop-planner/coverage',
    },
  },
});
