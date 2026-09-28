/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { liveMessage } from './i18n/messages.js';
import { isVoiceId } from './voice-catalog.js';

/** Only an existing valid configuration may be changed by the settings UI. */
export function persistVoicePreference(
  dataDir: string,
  value: unknown,
): string {
  if (!isVoiceId(value)) throw new Error(liveMessage('voice.invalid'));
  const path = join(dataDir, 'config.json');
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(liveMessage('voice.configInvalid'));
  }
  let original: Buffer;
  let before;
  let config: Record<string, unknown>;
  try {
    before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > 4 * 1024 * 1024)
      throw new Error('Unsafe configuration');
    original = readFileSync(descriptor);
    const parsed: unknown = JSON.parse(
      original.toString('utf8').replace(/^\uFEFF/u, ''),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Invalid configuration');
    config = parsed as Record<string, unknown>;
  } catch {
    throw new Error(liveMessage('voice.configInvalid'));
  } finally {
    closeSync(descriptor);
  }
  const temporary = join(dataDir, `.voice-${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      writeFileSync(
        fd,
        JSON.stringify({ ...config, voice: value }, null, 2) + '\n',
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const current = lstatSync(path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      !readFileSync(path).equals(original)
    )
      throw new Error(liveMessage('voice.concurrentEdit'));
    renameSync(temporary, path);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('qwen-live-harness-ui:')
    )
      throw error;
    throw new Error(liveMessage('voice.saveFailed'));
  } finally {
    if (created)
      try {
        unlinkSync(temporary);
      } catch {
        /* Rename consumed the private file. */
      }
  }
  return value;
}
