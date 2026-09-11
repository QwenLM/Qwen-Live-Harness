import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['integration-tests/qwen-live-m*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
