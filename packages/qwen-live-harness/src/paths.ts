/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultLiveDataDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, '.qwen-live-harness');
}

/** Resolve only the Harness namespace; legacy data is never read or migrated. */
export function resolveLiveDataDirectory(
  env: Record<string, string | undefined> = process.env,
  homeDirectory = homedir(),
): string {
  const configured = env['QWEN_LIVE_HARNESS_DATA_DIR']?.trim();
  if (!configured) return defaultLiveDataDirectory(homeDirectory);
  if (configured === '~') return homeDirectory;
  if (/^~[/\\]/u.test(configured))
    return join(homeDirectory, configured.slice(2));
  return configured;
}
