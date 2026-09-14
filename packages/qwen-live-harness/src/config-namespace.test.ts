/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const synthetic = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof import('node:os')>('node:os')),
  homedir: () => synthetic.home,
}));

import { loadConfig } from './config.js';
import { readPreferredLiveLanguage } from './language-preferences.js';

beforeEach(async () => {
  synthetic.home = await mkdtemp(join(tmpdir(), 'harness-namespace-test-'));
});

afterEach(async () => {
  await rm(synthetic.home, { recursive: true, force: true });
});

describe('new-only configuration namespace', () => {
  it('neither loads nor modifies an existing legacy config and memory root', async () => {
    const legacy = join(synthetic.home, '.qwen-live');
    await mkdir(legacy);
    const legacyConfig = JSON.stringify({
      realtimeApiKey: 'legacy-key',
      language: 'zh-CN',
    });
    await writeFile(join(legacy, 'config.json'), legacyConfig);

    expect(() =>
      loadConfig({
        QWEN_LIVE_DATA_DIR: legacy,
        QWEN_LIVE_REALTIME_API_KEY: 'legacy-env-key',
      }),
    ).toThrow(join(synthetic.home, '.qwen-live-harness', 'config.json'));
    expect(readPreferredLiveLanguage({ QWEN_LIVE_DATA_DIR: legacy })).toBe(
      'en',
    );
    await expect(readFile(join(legacy, 'config.json'), 'utf8')).resolves.toBe(
      legacyConfig,
    );

    const data = join(synthetic.home, '.qwen-live-harness');
    await mkdir(data);
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({ realtimeApiKey: 'new-key', language: 'zh-CN' }),
    );
    const config = loadConfig({ QWEN_LIVE_DATA_DIR: legacy });
    expect(config.dataDir).toBe(data);
    expect(config.discoveryDir).toBe(data);
    expect(config.realtime.apiKey).toBe('new-key');
    expect(config.language).toBe('zh-CN');
    expect(readPreferredLiveLanguage({ QWEN_LIVE_DATA_DIR: legacy })).toBe(
      'zh-CN',
    );
  });

  it('uses the same new data override for help and config without requiring an API key for help', async () => {
    const custom = join(synthetic.home, 'custom-config');
    await mkdir(custom);
    await writeFile(
      join(custom, 'config.json'),
      '\uFEFF' + JSON.stringify({ language: 'zh-CN' }),
    );
    const environment = { QWEN_LIVE_HARNESS_DATA_DIR: ' ~/custom-config ' };
    expect(readPreferredLiveLanguage(environment)).toBe('zh-CN');
    expect(() => loadConfig(environment)).toThrow(join(custom, 'config.json'));
    await writeFile(join(custom, 'config.json'), 'invalid-json');
    expect(readPreferredLiveLanguage(environment)).toBe('en');
  });

  it('ignores every previous product-specific environment override', () => {
    const legacyEnvironment = {
      QWEN_LIVE_DATA_DIR: '/legacy',
      QWEN_LIVE_REALTIME_API_KEY: 'legacy-key',
      QWEN_LIVE_REALTIME_ENDPOINT: 'https://legacy.example.invalid',
      QWEN_LIVE_REALTIME_MODEL: 'legacy-model',
      QWEN_LIVE_VOICE: 'legacy-voice',
      QWEN_LIVE_CWD: '/legacy-project',
      QWEN_LIVE_SHORTCUT: 'legacy-shortcut',
      QWEN_LIVE_DISCOVERY_DIR: '/legacy-discovery',
      QWEN_LIVE_PORT: 'invalid',
      QWEN_LIVE_VISUAL_SOURCE: 'invalid',
      QWEN_LIVE_VISUAL_MODE: 'invalid',
      QWEN_LIVE_VISUAL_FPS: 'invalid',
      QWEN_LIVE_CAMERA_RESOLUTION: 'invalid',
      QWEN_LIVE_CAMERA_SNAPSHOT_RESOLUTION: 'invalid',
      QWEN_LIVE_VISUAL_LIVE_RESOLUTION: 'invalid',
      QWEN_LIVE_VISUAL_SNAPSHOT_RESOLUTION: 'invalid',
      QWEN_LIVE_PROACTIVE_ENABLED: 'invalid',
      QWEN_LIVE_BACKENDS: 'invalid',
      QWEN_LIVE_SERVE_URL: 'https://legacy.example.invalid',
    };
    const currentEnvironment = {
      QWEN_LIVE_HARNESS_REALTIME_API_KEY: 'new-key',
    };
    expect(loadConfig({ ...legacyEnvironment, ...currentEnvironment })).toEqual(
      loadConfig(currentEnvironment),
    );
  });
});
