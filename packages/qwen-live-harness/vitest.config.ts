/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Discovery tests exercise real file locking; orchestrator tests use fake
    // timers but spawn no processes. Keep generous ceilings for slow CI hosts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
