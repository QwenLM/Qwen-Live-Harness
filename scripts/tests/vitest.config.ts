import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/tests/**/*.test.js'],
    maxWorkers: 2,
  },
});
