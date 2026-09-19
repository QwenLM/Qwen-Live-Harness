/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';

export async function readDebugBuildInfo(): Promise<Record<string, unknown>> {
  try {
    const info = JSON.parse(
      await readFile(new URL('../build-info.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    if (
      typeof info['sourceSha256'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(info['sourceSha256'])
    )
      return { status: 'unavailable' };
    return {
      status: 'available',
      version: info['version'],
      builtAt: info['builtAt'],
      sourceSha256: info['sourceSha256'],
    };
  } catch {
    return { status: 'unavailable' };
  }
}
