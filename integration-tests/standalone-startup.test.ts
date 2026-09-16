import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli =
  process.env['TEST_LIVE_PATH'] ??
  join(root, 'packages/qwen-live-harness/dist/index.js');
const execute = promisify(execFile);
const startup = (await import(
  pathToFileURL(join(dirname(cli), 'startup.js')).href
)) as typeof import('../packages/qwen-live-harness/src/startup.js');
const lifecycle = (await import(
  pathToFileURL(join(dirname(cli), 'lifecycle.js')).href
)) as typeof import('../packages/qwen-live-harness/src/lifecycle.js');
const version = (
  JSON.parse(await readFile(join(dirname(cli), '../package.json'), 'utf8')) as {
    version: string;
  }
).version;
let directory: string | undefined;
let owner:
  Awaited<ReturnType<typeof startup.launchRegisteredDaemon>> | undefined;

async function quitOwner() {
  if (!owner) return;
  const response = await fetch(new URL('/live/quit', owner.record.url), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${owner.record.token}`,
      'x-qwen-live-harness-nonce': owner.record.instanceNonce,
    },
  });
  expect(response.status).toBe(200);
  await vi.waitFor(
    () => {
      expect(() => process.kill(owner!.record.pid, 0)).toThrow();
    },
    { timeout: 10_000 },
  );
  owner = undefined;
}

afterEach(async () => {
  await quitOwner();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('installed desktop bootstrap with the real daemon CLI', () => {
  it('serializes concurrent starts, reuses the same instance and shuts down its ACP backend', async () => {
    directory = await mkdtemp(join(tmpdir(), 'qwen-live-harness-startup-e2e-'));
    const discoveryDir = join(directory, 'discovery');
    const discoveryPath = join(discoveryDir, 'run/daemon.json');
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({
        realtimeApiKey: 'synthetic-test-key',
        realtimeEndpoint: 'https://model.example.invalid',
        memory: { enabled: false },
        backends: [
          {
            name: 'synthetic-acp',
            kind: 'acp',
            command: process.execPath,
            args: [
              join(
                root,
                'packages/qwen-live-harness/test-fixtures/fake-acp-agent.mjs',
              ),
            ],
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
    const options = {
      discoveryPath,
      expectedVersion: version,
      timeoutMs: 20_000,
    };
    const results = await Promise.allSettled([
      startup.launchRegisteredDaemon(options),
      startup.launchRegisteredDaemon(options),
    ]);
    const launches = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    owner = launches[0];
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    expect(launches).toHaveLength(2);
    if (!owner) throw new Error('No bootstrap result');
    expect(launches[1].record.instanceNonce).toBe(owner.record.instanceNonce);
    expect(launches[1].record.pid).toBe(owner.record.pid);
    const again = await startup.launchRegisteredDaemon(options);
    expect(again.started).toBe(false);
    expect(again.record.pid).toBe(owner.record.pid);
    const duplicate = await execute(process.execPath, [cli, '--daemon-only'], {
      env: {
        ...process.env,
        QWEN_LIVE_HARNESS_DATA_DIR: directory,
        QWEN_LIVE_HARNESS_DISCOVERY_DIR: discoveryDir,
      },
      timeout: 15_000,
    });
    expect(duplicate.stdout).not.toContain('listening on');
    expect((await startup.probeDaemon(discoveryPath)).kind).toBe('ready');
    expect(
      await lifecycle.readDaemonStopMarker(discoveryPath, owner.record),
    ).toBe(false);
    await quitOwner();
    expect(await startup.probeDaemon(discoveryPath)).toEqual({
      kind: 'missing',
    });

    // Exercise the real CLI signal handler after a fresh launch. A Host that
    // opens late or loses its WebSocket must still observe this exact exit.
    owner = await startup.launchRegisteredDaemon(options);
    const stoppedIdentity = {
      pid: owner.record.pid,
      instanceNonce: owner.record.instanceNonce,
    };
    process.kill(owner.record.pid, 'SIGINT');
    await vi.waitFor(
      () => expect(() => process.kill(stoppedIdentity.pid, 0)).toThrow(),
      { timeout: 10_000 },
    );
    owner = undefined;
    expect(
      await lifecycle.readDaemonStopMarker(discoveryPath, stoppedIdentity),
    ).toBe(true);
    expect(
      await lifecycle.readDaemonStopMarker(discoveryPath, {
        ...stoppedIdentity,
        instanceNonce: 'unrelated_instance_nonce',
      }),
    ).toBe(false);
    expect(await startup.probeDaemon(discoveryPath)).toEqual({
      kind: 'missing',
    });
  });
});
