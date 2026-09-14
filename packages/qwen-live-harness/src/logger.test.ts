/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveLogger } from './logger.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('LiveLogger debug recording gate', () => {
  it('enables recording only at the debug level', () => {
    for (const level of ['info', 'warn', 'error'] as const) {
      expect(new LiveLogger(level).debugEnabled).toBe(false);
    }
    expect(new LiveLogger('debug').debugEnabled).toBe(true);
  });

  it('respects the environment level without enabling recording for unknown values', () => {
    vi.stubEnv('QWEN_LIVE_HARNESS_LOG_LEVEL', 'debug');
    expect(new LiveLogger().debugEnabled).toBe(true);
    expect(new LiveLogger('info').debugEnabled).toBe(false);
    vi.stubEnv('QWEN_LIVE_HARNESS_LOG_LEVEL', 'unknown');
    expect(new LiveLogger().debugEnabled).toBe(false);
    vi.stubEnv('QWEN_LIVE_HARNESS_LOG_LEVEL', undefined);
    expect(new LiveLogger().debugEnabled).toBe(false);
  });

  it('does not enable sensitive recordings through the legacy environment', () => {
    vi.stubEnv('QWEN_LIVE_HARNESS_LOG_LEVEL', undefined);
    vi.stubEnv('QWEN_LIVE_LOG_LEVEL', 'debug');
    expect(new LiveLogger().debugEnabled).toBe(false);
  });

  it('identifies the Harness in operator-facing logs', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    new LiveLogger('info').info('synthetic-message');
    expect(write).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[qwen-live-harness\] .* INFO synthetic-message\n$/u,
      ),
    );
  });
});
