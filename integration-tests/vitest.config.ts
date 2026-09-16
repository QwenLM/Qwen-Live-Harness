import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'integration-tests/standalone*.test.ts',
      'integration-tests/qwen-peer-setup.test.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
