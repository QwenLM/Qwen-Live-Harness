/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emitRuntimeFailure,
  runtimeFailureRecord,
  RuntimeFailureLog,
  type RuntimeFailure,
} from './runtime-failure.js';

const directories: string[] = [];
const fixture: RuntimeFailure = {
  source: 'realtime',
  code: 'connection_closed',
  stage: 'websocket',
  impact: 'call',
  message: 'Connection closed.',
  epoch: 1,
  providerSessionId: 'sess_example',
  responseId: 'resp_example',
  closeCode: 1006,
};
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function directory() {
  const d = await mkdtemp(join(tmpdir(), 'qwen-live-failures-'));
  directories.push(d);
  return d;
}

describe('runtime failure diagnostics', () => {
  it('retains controlled correlation fields and omits unknown payloads', () => {
    expect(
      runtimeFailureRecord({
        ...fixture,
        headers: { Authorization: 'hidden' },
        audio: 'hidden',
        args: 'hidden',
      } as RuntimeFailure),
    ).toEqual(fixture);
  });
  it('redacts credentials and rejects sensitive or malformed identifiers', () => {
    const secret = 'diagnostic-key-value';
    const result = runtimeFailureRecord(
      {
        ...fixture,
        providerSessionId: 'sess_' + secret,
        responseId: 'bad\nresponse',
        message:
          secret +
          ' Bearer bearer-value api_key="query-value" https://user:pwd@example.test/path?token=url-value',
      },
      [secret],
    );
    const text = JSON.stringify(result);
    for (const value of [
      secret,
      'bearer-value',
      'query-value',
      'user:pwd',
      'url-value',
    ])
      expect(text).not.toContain(value);
    expect(result).not.toHaveProperty('providerSessionId');
    expect(result).not.toHaveProperty('responseId');
  });
  it('bounds messages and excludes raw stacks', () => {
    const result = runtimeFailureRecord({
      ...fixture,
      message: 'x'.repeat(5000),
      stack: 'private-stack',
    } as RuntimeFailure);
    expect(String(result['message'])).toHaveLength(1000);
    expect(result).not.toHaveProperty('stack');
  });
  it('isolates throwing observers', () => {
    expect(() =>
      emitRuntimeFailure(() => {
        throw new Error('sink failed');
      }, fixture),
    ).not.toThrow();
  });
  it('writes before startup and synchronously retains the final failure with private permissions', async () => {
    const root = await directory();
    const log = new RuntimeFailureLog(root);
    expect(await readdir(root)).toEqual([]);
    expect(log.write(fixture)).toBe(true);
    const row = JSON.parse((await readFile(log.filePath, 'utf8')).trim());
    expect(row).toMatchObject({ type: 'failure', seq: 1, payload: fixture });
    if (process.platform !== 'win32') {
      expect((await stat(log.filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, 'logs'))).mode & 0o777).toBe(0o700);
    }
  });
  it('rotates a bounded per-run file and never follows its symlink', async () => {
    const root = await directory();
    const log = new RuntimeFailureLog(root, () => [], 500);
    expect(log.write({ ...fixture, message: 'a'.repeat(300) })).toBe(true);
    expect(log.write({ ...fixture, message: 'b'.repeat(300) })).toBe(true);
    expect(await readFile(log.filePath + '.1', 'utf8')).toContain(
      'a'.repeat(300),
    );
    const target = join(root, 'must-not-write');
    const next = new RuntimeFailureLog(root);
    await symlink(target, next.filePath);
    expect(next.write(fixture)).toBe(false);
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
