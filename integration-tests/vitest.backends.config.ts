import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'integration-tests/qwen-live-harness-m*.test.ts',
      'integration-tests/qwen-peer-instructions.test.ts',
    ],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
