/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultLiveDataDirectory,
  resolveLiveDataDirectory,
  resolveLiveDiscoveryDirectory,
} from './paths.js';

describe('Harness data directory', () => {
  const homeDirectory = join('/synthetic', 'home');

  it('shares discovery precedence and expansion between init registration and daemon startup', () => {
    expect(resolveLiveDiscoveryDirectory({}, undefined, homeDirectory)).toBe(
      join(homeDirectory, '.qwen-live-harness'),
    );
    expect(
      resolveLiveDiscoveryDirectory({}, ' ~/file-profile ', homeDirectory),
    ).toBe(join(homeDirectory, 'file-profile'));
    expect(
      resolveLiveDiscoveryDirectory(
        { QWEN_LIVE_HARNESS_DISCOVERY_DIR: ' ~/environment-profile ' },
        '/ignored',
        homeDirectory,
      ),
    ).toBe(join(homeDirectory, 'environment-profile'));
  });

  it('defaults only to the new namespace and ignores the legacy environment', () => {
    const expected = join(homeDirectory, '.qwen-live-harness');
    expect(defaultLiveDataDirectory(homeDirectory)).toBe(expected);
    expect(resolveLiveDataDirectory({}, homeDirectory)).toBe(expected);
    expect(
      resolveLiveDataDirectory(
        { QWEN_LIVE_DATA_DIR: '/legacy-config' },
        homeDirectory,
      ),
    ).toBe(expected);
    expect(
      resolveLiveDataDirectory(
        {
          QWEN_LIVE_HARNESS_DATA_DIR: '  ',
          QWEN_LIVE_DATA_DIR: '/legacy-config',
        },
        homeDirectory,
      ),
    ).toBe(expected);
  });

  it.each([
    [' /custom data ', '/custom data'],
    ['relative-directory', 'relative-directory'],
    ['~', homeDirectory],
    [' ~/custom ', join(homeDirectory, 'custom')],
    ['~\\custom', join(homeDirectory, 'custom')],
    ['~another-user', '~another-user'],
  ])('resolves %s consistently for init and runtime', (value, expected) => {
    expect(
      resolveLiveDataDirectory(
        {
          QWEN_LIVE_HARNESS_DATA_DIR: value,
          QWEN_LIVE_DATA_DIR: '/ignored-legacy-config',
        },
        homeDirectory,
      ),
    ).toBe(expected);
  });
});
