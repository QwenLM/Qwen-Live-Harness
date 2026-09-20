/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import {
  ConfigurationError,
  configurationErrorMessage,
  readConfigurationValue,
} from './configuration-error.js';
import {
  displayLiveMessage,
  liveText,
  type LiveMessageKey,
} from './i18n/messages.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture(value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-config-copy-'));
  temporary.push(directory);
  await writeFile(join(directory, 'config.json'), JSON.stringify(value));
  return directory;
}
function failure(directory: string): unknown {
  try {
    loadConfig({ QWEN_LIVE_HARNESS_DATA_DIR: directory });
  } catch (error) {
    return error;
  }
  throw new Error('Expected a configuration error');
}
function expectDisplay(error: unknown, key: LiveMessageKey, params = {}) {
  expect(error).toBeInstanceOf(ConfigurationError);
  for (const language of ['en', 'zh-CN'] as const) {
    const text = displayLiveMessage(language, configurationErrorMessage(error));
    expect(text).toBe(liveText(language, key, params));
    expect(text).not.toContain('private-config-value');
    expect(text).not.toContain('qwen-live-harness-ui:');
  }
}

describe('localized configuration error presentation', () => {
  it('preserves the original diagnostic and cause without showing raw exception content', () => {
    const cause = new Error('private-config-value');
    let error: unknown;
    try {
      readConfigurationValue(
        'config.sectionInvalid',
        () => {
          throw cause;
        },
        { section: 'memory' },
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toBe(cause.message);
    expect((error as Error).cause).toBe(cause);
    expectDisplay(error, 'config.sectionInvalid', { section: 'memory' });
    expect(readConfigurationValue('config.invalid', () => 42)).toBe(42);
  });

  it('uses an explicit API key instruction for a missing credential', async () => {
    expectDisplay(failure(await fixture({})), 'config.apiKeyRequired');
  });

  it.each([
    [{ port: 'private-config-value' }, 'config.portInvalid', {}],
    [
      { visualInput: { source: 'private-config-value' } },
      'config.sectionInvalid',
      { section: 'visualInput' },
    ],
    [
      { proactive: { enabled: 'private-config-value' } },
      'config.sectionInvalid',
      { section: 'proactive' },
    ],
    [
      { memory: { defaultId: 'private-config-value!' } },
      'config.sectionInvalid',
      { section: 'memory' },
    ],
    [
      { backends: 'private-config-value' },
      'config.sectionInvalid',
      { section: 'backends' },
    ],
  ] as const)(
    'identifies the invalid settings section without exposing values',
    async (settings, key, params) => {
      const directory = await fixture({
        realtimeApiKey: 'fixture-key',
        ...settings,
      });
      expectDisplay(failure(directory), key, params);
    },
  );

  it('does not include JSON parser excerpts in the translated file error', async () => {
    const directory = await fixture({});
    const file = join(directory, 'config.json');
    await writeFile(file, '{"private-config-value":');
    const error = failure(directory);
    expect((error as Error).message).toContain('Invalid config file');
    expectDisplay(error, 'config.invalidJson', { path: file });
  });

  it('separates an unreadable config from a missing API key', async () => {
    const directory = await fixture({});
    const file = join(directory, 'config.json');
    await rm(file);
    await mkdir(file);
    const error = failure(directory);
    expect((error as Error).message).toContain('Could not read config file');
    expectDisplay(error, 'config.readFailed', { path: file });
  });

  it('falls back safely for an unclassified error', () => {
    const error = new Error('private-config-value');
    for (const language of ['en', 'zh-CN'] as const)
      expect(
        displayLiveMessage(language, configurationErrorMessage(error)),
      ).toBe(liveText(language, 'config.invalid'));
  });
});
