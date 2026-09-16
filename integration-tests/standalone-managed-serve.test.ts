/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli =
  process.env['TEST_LIVE_PATH'] ??
  join(root, 'packages/qwen-live-harness/dist/index.js');
const startup = (await import(
  pathToFileURL(join(dirname(cli), 'startup.js')).href
)) as typeof import('../packages/qwen-live-harness/src/startup.js');
const version = (
  JSON.parse(await readFile(join(dirname(cli), '../package.json'), 'utf8')) as {
    version: string;
  }
).version;
let directory: string | undefined;
let owner:
  Awaited<ReturnType<typeof startup.launchRegisteredDaemon>> | undefined;

async function quit() {
  if (!owner) return;
  const record = owner.record;
  const response = await fetch(new URL('/live/quit', record.url), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${record.token}`,
      'x-qwen-live-harness-nonce': record.instanceNonce,
    },
  });
  expect(response.status).toBe(200);
  await vi.waitFor(() => expect(() => process.kill(record.pid, 0)).toThrow(), {
    timeout: 10_000,
  });
  owner = undefined;
}

afterEach(async () => {
  await quit();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe.skipIf(process.platform === 'win32')(
  'saved managed Serve configuration through the public daemon CLI',
  () => {
    it('starts and authenticates an owned service, then stops it on authenticated daemon quit', async () => {
      directory = await mkdtemp(join(tmpdir(), 'live-managed-serve-cli-'));
      const command = join(directory, 'qwen');
      const observation = join(directory, 'service.json');
      await writeFile(
        command,
        `#!${process.execPath}
const fs = require('node:fs');
const features = ['session_create', 'session_prompt', 'session_events', 'session_cancel', 'session_permission_vote', 'session_mid_turn_message_mutation'];
let authenticated = false;
const server = require('node:http').createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + process.env.QWEN_SERVER_TOKEN) {
    res.writeHead(401); return res.end('{}');
  }
  if (req.url === '/capabilities') {
    authenticated = true;
    fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ pid: process.pid, port: server.address().port, authenticated, tokenLength: process.env.QWEN_SERVER_TOKEN.length, args: process.argv.slice(2) }));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ v: 1, features, workspaceCwd: process.cwd() }));
  }
  res.writeHead(404); res.end('{}');
});
server.listen(0, '127.0.0.1', () => console.log('qwen serve listening on http://127.0.0.1:' + server.address().port + ' (mode=test, workspace=test)'));
`,
        { mode: 0o700 },
      );
      const discoveryDir = join(directory, 'discovery');
      await writeFile(
        join(directory, 'config.json'),
        JSON.stringify({
          realtimeApiKey: 'synthetic-test-key',
          realtimeEndpoint: 'https://model.example.invalid',
          memory: { enabled: false },
          proactive: { enabled: false },
          defaultCwd: directory,
          backends: [
            {
              name: 'managed-qwen',
              kind: 'qwen-code',
              managedServe: { command },
              default: true,
            },
          ],
        }),
        { mode: 0o600 },
      );
      await startup.registerRuntime({
        nodePath: process.execPath,
        cliPath: cli,
        version,
        dataDir: directory,
        discoveryDir,
        cwd: directory,
      });
      owner = await startup.launchRegisteredDaemon({
        discoveryPath: join(discoveryDir, 'run/daemon.json'),
        expectedVersion: version,
        timeoutMs: 20_000,
      });
      expect(owner.started).toBe(true);
      const observed = JSON.parse(await readFile(observation, 'utf8')) as {
        pid: number;
        port: number;
        authenticated: boolean;
        tokenLength: number;
        args: string[];
      };
      expect(observed.authenticated).toBe(true);
      expect(observed.tokenLength).toBe(64);
      expect(observed.args).toEqual([
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        '0',
        '--workspace',
        directory,
      ]);
      // The owned service is protected even on loopback; no token is persisted.
      const serviceUrl = `http://127.0.0.1:${observed.port}`;
      expect((await fetch(`${serviceUrl}/capabilities`)).status).toBe(401);
      expect(
        await readFile(join(directory, 'config.json'), 'utf8'),
      ).not.toContain('token');
      await quit();
      await vi.waitFor(
        () => expect(() => process.kill(observed.pid, 0)).toThrow(),
        { timeout: 5_000 },
      );
      await expect(fetch(serviceUrl)).rejects.toThrow();
    });
  },
);
