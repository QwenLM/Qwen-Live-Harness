/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect } from 'vitest';

it('persists a CLI configuration failure before any session or backend starts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-live-cli-failure-'));
  try {
    const secret = 'sk-failure-integration-secret';
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({
        realtimeApiKey: secret,
        backends: [],
        proactive: 'not-an-object',
      }),
      { mode: 0o600 },
    );
    const cli =
      process.env['TEST_LIVE_PATH'] ??
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../packages/qwen-live-harness/dist/index.js',
      );
    await expect(
      promisify(execFile)(process.execPath, [cli, '--daemon-only'], {
        env: {
          ...process.env,
          DASHSCOPE_API_KEY: secret,
          QWEN_LIVE_HARNESS_DATA_DIR: directory,
          QWEN_LIVE_HARNESS_DISCOVERY_DIR: directory,
        },
        timeout: 10000,
      }),
    ).rejects.toMatchObject({ code: 1 });
    const files = (await readdir(join(directory, 'logs'))).filter((name) =>
      /^runtime-errors-.*\.jsonl$/u.test(name),
    );
    expect(files).toHaveLength(1);
    const raw = await readFile(join(directory, 'logs', files[0]!), 'utf8');
    expect(raw).not.toContain(secret);
    expect(JSON.parse(raw.trim())).toMatchObject({
      type: 'failure',
      payload: {
        source: 'daemon',
        code: 'configuration_load_failed',
        stage: 'configuration',
        impact: 'daemon',
      },
    });
    await expect(readdir(join(directory, 'sessions'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
