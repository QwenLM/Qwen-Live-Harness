/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  StartupError,
  startupInternals,
  type StartupOptions,
} from './startup.js';

const { assertNotAborted, prepareRunDirectory, errorCode, isOwned, delay } =
  startupInternals;

/** Only a CLI daemon owner takes this lock; the Host never holds it over spawn. */
export async function withDaemonStartupLock<T>(
  discoveryPath: string,
  callback: () => Promise<T>,
  options: StartupOptions = {},
): Promise<T> {
  assertNotAborted(options.signal);
  const directory = await prepareRunDirectory(discoveryPath);
  const lockPath = join(directory, '.startup.lock');
  const lockfile = (await import('proper-lockfile')).default;
  const deadline =
    Date.now() + (options.timeoutMs ?? startupInternals.timeoutMs);
  let release: (() => Promise<void>) | undefined;
  let compromised: unknown;
  while (!release) {
    assertNotAborted(options.signal);
    try {
      const existing = await lstat(lockPath).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      });
      if (
        existing &&
        (!existing.isDirectory() ||
          existing.isSymbolicLink() ||
          !isOwned(existing))
      )
        throw new StartupError('discovery_invalid');
      // proper-lockfile indexes ownership by target, not lockfilePath. The
      // discovery writer independently locks `directory`; sharing its target
      // would overwrite this in-process owner and break release after publish.
      release = await lockfile.lock(join(directory, '.startup-owner'), {
        realpath: false,
        lockfilePath: lockPath,
        stale: 30_000,
        update: 5_000,
        retries: 0,
        onCompromised: (error) => {
          compromised = error;
        },
      });
    } catch (error) {
      if (errorCode(error) !== 'ELOCKED') throw error;
      if (Date.now() >= deadline) throw new StartupError('startup_busy');
      await delay(
        Math.min(100, Math.max(1, deadline - Date.now())),
        options.signal,
      );
    }
  }
  try {
    assertNotAborted(options.signal);
    const result = await callback();
    if (compromised)
      throw new StartupError('startup_busy', { cause: compromised });
    return result;
  } finally {
    await release();
  }
}
