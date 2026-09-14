/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerRuntime, type RuntimeRegistration } from './startup.js';

/** CLI-only package location discovery; kept out of the Host's CommonJS bundle. */
export async function registerCurrentRuntime(options: {
  dataDir: string;
  discoveryDir: string;
  cwd?: string;
}): Promise<RuntimeRegistration> {
  const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifest = JSON.parse(
    await readFile(join(packageDirectory, 'package.json'), 'utf8'),
  ) as { version: string };
  return registerRuntime({
    ...options,
    nodePath: process.execPath,
    cliPath: join(packageDirectory, 'dist', 'index.js'),
    version: manifest.version,
  });
}
