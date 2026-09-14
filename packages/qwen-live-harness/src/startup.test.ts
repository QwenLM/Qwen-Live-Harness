/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  removeLiveDiscoveryFile,
  writeLiveDiscoveryFile,
} from './host/discovery.js';
import {
  getRuntimeRegistrationPath,
  launchRegisteredDaemon,
  probeDaemon,
  registerRuntime,
  withDaemonStartupLock,
  type RuntimeRegistration,
} from './startup.js';

let directory: string;
let discoveryPath: string;
const servers: Server[] = [];
const childPids: number[] = [];

beforeEach(async () => {
  directory = await fs.mkdtemp(
    join(tmpdir(), 'qwen-live-harness-startup-test-'),
  );
  discoveryPath = join(directory, 'run', 'daemon.json');
  await fs.mkdir(dirname(discoveryPath), { mode: 0o700 });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error('Condition did not become true');
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const pid of childPids.splice(0)) {
    if (isAlive(pid)) process.kill(pid, 'SIGTERM');
    await until(() => !isAlive(pid));
  }
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolveClose) =>
            server.close(() => resolveClose()),
          ),
      ),
  );
  await fs.rm(directory, { recursive: true, force: true });
});

async function serveInstance(
  options: {
    nonce?: string;
    version?: string;
    status?: number;
    publish?: boolean;
  } = {},
) {
  const requests: Array<{ authorization?: string; nonce?: string }> = [];
  const record = {
    url: '',
    token: 'local-private-token',
    instanceNonce: 'startup_test_nonce_0001',
    protocolVersion: 9,
    pid: process.pid,
  };
  const server = createServer((req, res) => {
    requests.push({
      authorization: req.headers.authorization,
      nonce: req.headers['x-qwen-live-harness-nonce'] as string,
    });
    res.writeHead(options.status ?? 200, {
      'content-type': 'application/json',
    });
    res.end(
      JSON.stringify({
        pid: process.pid,
        instanceNonce: options.nonce ?? record.instanceNonce,
        protocolVersion: 9,
        version: options.version ?? '0.3.0',
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  record.url = `http://127.0.0.1:${address.port}`;
  const publish = () =>
    fs.writeFile(discoveryPath, JSON.stringify(record), { mode: 0o600 });
  if (options.publish !== false) await publish();
  return { record, requests, publish };
}

async function registerFixture(): Promise<RuntimeRegistration> {
  const packageDir = join(directory, 'package');
  const dataDir = join(directory, 'data');
  await fs.mkdir(join(packageDir, 'dist'), { recursive: true });
  await fs.mkdir(dataDir, { mode: 0o700 });
  await fs.writeFile(join(dataDir, 'config.json'), '{}', { mode: 0o600 });
  await fs.writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'qwen-live-harness',
      version: '0.3.0',
      type: 'module',
      bin: { 'qwen-live-harness': 'dist/index.js' },
    }),
  );
  await fs.copyFile(
    new URL('./test-fixtures/startup-child.mjs', import.meta.url),
    join(packageDir, 'dist', 'index.js'),
  );
  return registerRuntime({
    nodePath: process.execPath,
    cliPath: join(packageDir, 'dist', 'index.js'),
    version: '0.3.0',
    dataDir,
    discoveryDir: directory,
    cwd: packageDir,
    path: '/usr/bin:/bin',
  });
}

describe('private runtime registration', () => {
  it('atomically stores only launch fields with private permissions', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'a-secret-that-must-not-be-registered');
    const registration = await registerFixture();
    const filename = getRuntimeRegistrationPath(discoveryPath);
    const serialized = await fs.readFile(filename, 'utf8');
    expect(JSON.parse(serialized)).toEqual(registration);
    expect(serialized).not.toContain('a-secret');
    expect(Object.keys(registration).sort()).toEqual([
      'cliPath',
      'cwd',
      'dataDir',
      'discoveryDir',
      'nodePath',
      'path',
      'schemaVersion',
      'version',
    ]);
    if (process.platform !== 'win32')
      expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(dirname(filename))).toEqual(['runtime.json']);
    await registerRuntime({ ...registration, cwd: directory });
    expect(JSON.parse(await fs.readFile(filename, 'utf8')).cwd).toBe(directory);
  });

  it('rejects runtime registry symlinks without modifying their target', async () => {
    const registration = await registerFixture();
    const filename = getRuntimeRegistrationPath(discoveryPath);
    const target = join(directory, 'untouched');
    await fs.writeFile(target, 'original');
    await fs.unlink(filename);
    await fs.symlink(target, filename);
    await expect(registerRuntime(registration)).rejects.toMatchObject({
      code: 'runtime_invalid',
    });
    expect(await fs.readFile(target, 'utf8')).toBe('original');
  });

  it.each(['{interrupted json', ''])(
    'repairs an owned private damaged registration (%j)',
    async (contents) => {
      const registration = await registerFixture();
      const filename = getRuntimeRegistrationPath(discoveryPath);
      await fs.writeFile(filename, contents);
      await registerRuntime(registration);
      expect(JSON.parse(await fs.readFile(filename, 'utf8'))).toEqual(
        registration,
      );
      await fs.chmod(filename, 0o644);
      if (process.platform !== 'win32')
        await expect(registerRuntime(registration)).rejects.toMatchObject({
          code: 'runtime_invalid',
        });
    },
  );
});

describe('daemon probe', () => {
  it('authenticates and verifies the exact live instance', async () => {
    const fixture = await serveInstance();
    await expect(
      probeDaemon(discoveryPath, { expectedVersion: '0.3.0' }),
    ).resolves.toMatchObject({
      kind: 'ready',
      record: fixture.record,
      version: '0.3.0',
    });
    expect(fixture.requests).toEqual([
      {
        authorization: 'Bearer local-private-token',
        nonce: 'startup_test_nonce_0001',
      },
    ]);
  });

  it('reports an absent discovery file or dead PID as missing', async () => {
    await expect(probeDaemon(discoveryPath)).resolves.toEqual({
      kind: 'missing',
    });
    const fixture = await serveInstance();
    await fs.writeFile(
      discoveryPath,
      JSON.stringify({ ...fixture.record, pid: 2147483647 }),
    );
    await expect(probeDaemon(discoveryPath)).resolves.toEqual({
      kind: 'missing',
    });
    expect(fixture.requests).toHaveLength(0);
  });

  it.each([
    { nonce: 'some_other_nonce_0001' },
    { version: '0.2.0' },
    { status: 401 },
  ])('rejects a live owner with mismatched identity %j', async (options) => {
    await serveInstance(options);
    await expect(
      probeDaemon(discoveryPath, { expectedVersion: '0.3.0' }),
    ).rejects.toMatchObject({ code: 'daemon_mismatch' });
  });

  it('fails closed for an active PID whose HTTP server is gone', async () => {
    const fixture = await serveInstance();
    const server = servers.pop()!;
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
    await expect(probeDaemon(discoveryPath)).rejects.toMatchObject({
      code: 'daemon_unresponsive',
    });
    expect(JSON.parse(await fs.readFile(discoveryPath, 'utf8'))).toEqual(
      fixture.record,
    );
  });

  it('rejects a remote URL before sending a token', async () => {
    const fixture = await serveInstance();
    await fs.writeFile(
      discoveryPath,
      JSON.stringify({ ...fixture.record, url: 'http://example.com' }),
    );
    await expect(probeDaemon(discoveryPath)).rejects.toMatchObject({
      code: 'discovery_invalid',
    });
    expect(fixture.requests).toHaveLength(0);
  });

  it('rejects symlink and world-readable discovery records', async () => {
    await serveInstance();
    const moved = join(directory, 'real-discovery.json');
    await fs.rename(discoveryPath, moved);
    await fs.symlink(moved, discoveryPath);
    await expect(probeDaemon(discoveryPath)).rejects.toMatchObject({
      code: 'discovery_invalid',
    });
    await fs.unlink(discoveryPath);
    await fs.rename(moved, discoveryPath);
    await fs.chmod(discoveryPath, 0o644);
    if (process.platform !== 'win32')
      await expect(probeDaemon(discoveryPath)).rejects.toMatchObject({
        code: 'discovery_invalid',
      });
  });
});

describe('CLI startup lock', () => {
  it('keeps its owner while the real discovery writer acquires its separate lock', async () => {
    const record = {
      url: 'http://127.0.0.1:12345',
      token: 'test-token',
      pid: process.pid,
      instanceNonce: 'startup_nested_nonce_0001',
      protocolVersion: 9 as const,
    };
    await expect(
      withDaemonStartupLock(discoveryPath, async () => {
        await writeLiveDiscoveryFile(directory, record);
        expect(
          (
            await fs.stat(join(dirname(discoveryPath), '.startup.lock'))
          ).isDirectory(),
        ).toBe(true);
        await removeLiveDiscoveryFile(directory, record);
      }),
    ).resolves.toBeUndefined();
    await expect(
      fs.stat(join(dirname(discoveryPath), '.startup.lock')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lets independent discovery publication finish while a startup lock remains owned', async () => {
    let releaseOwner!: () => void;
    const owner = withDaemonStartupLock(
      discoveryPath,
      () =>
        new Promise<void>((resolveOwner) => {
          releaseOwner = resolveOwner;
        }),
    );
    await until(() => Boolean(releaseOwner));
    const record = {
      url: 'http://127.0.0.1:12345',
      token: 'test-token',
      pid: process.pid,
      instanceNonce: 'startup_parallel_nonce_0001',
      protocolVersion: 9 as const,
    };
    try {
      await writeLiveDiscoveryFile(directory, record);
      await expect(
        withDaemonStartupLock(discoveryPath, async () => undefined, {
          timeoutMs: 30,
        }),
      ).rejects.toMatchObject({ code: 'startup_busy' });
      await removeLiveDiscoveryFile(directory, record);
    } finally {
      releaseOwner();
    }
    await expect(owner).resolves.toBeUndefined();
  });
  it('serializes concurrent backend preflight and always releases on failure', async () => {
    let active = 0;
    let peak = 0;
    const start = () =>
      withDaemonStartupLock(discoveryPath, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolveWork) => setTimeout(resolveWork, 20));
        active -= 1;
      });
    await Promise.all([start(), start(), start()]);
    expect(peak).toBe(1);
    await expect(
      withDaemonStartupLock(discoveryPath, async () => {
        throw new Error('backend failed');
      }),
    ).rejects.toThrow('backend failed');
    await expect(start()).resolves.toBeUndefined();
  });

  it('supports cancelling a waiter without releasing another owner', async () => {
    let releaseOwner!: () => void;
    const owner = withDaemonStartupLock(
      discoveryPath,
      () =>
        new Promise<void>((resolveOwner) => {
          releaseOwner = resolveOwner;
        }),
    );
    await until(() => Boolean(releaseOwner));
    const abort = new AbortController();
    const waiter = withDaemonStartupLock(
      discoveryPath,
      async () => 'unexpected',
      { signal: abort.signal },
    );
    abort.abort();
    await expect(waiter).rejects.toMatchObject({ code: 'startup_aborted' });
    expect(
      (
        await fs.stat(join(dirname(discoveryPath), '.startup.lock'))
      ).isDirectory(),
    ).toBe(true);
    releaseOwner();
    await owner;
    await expect(
      fs.stat(join(dirname(discoveryPath), '.startup.lock')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('desktop daemon bootstrap', () => {
  it('reuses an authenticated daemon without requiring an installation registry', async () => {
    await serveInstance();
    await expect(
      launchRegisteredDaemon({ discoveryPath, expectedVersion: '0.3.0' }),
    ).resolves.toMatchObject({ started: false });
  });

  it('explains a missing first-time initialization', async () => {
    await expect(
      launchRegisteredDaemon({ discoveryPath, expectedVersion: '0.3.0' }),
    ).rejects.toMatchObject({ code: 'runtime_missing' });
  });

  it('connect-only fails before looking for a registry or starting a process', async () => {
    // A registry symlink would yield runtime_invalid if inspected.
    await fs.symlink(
      join(directory, 'absent-registry'),
      getRuntimeRegistrationPath(discoveryPath),
    );
    await expect(
      launchRegisteredDaemon({
        discoveryPath,
        expectedVersion: '0.3.0',
        startIfMissing: false,
      }),
    ).rejects.toMatchObject({ code: 'daemon_unresponsive' });
    expect(await fs.readdir(dirname(discoveryPath))).toEqual(['runtime.json']);
    await serveInstance();
    await expect(
      launchRegisteredDaemon({
        discoveryPath,
        expectedVersion: '0.3.0',
        startIfMissing: false,
      }),
    ).resolves.toMatchObject({ started: false });
  });

  it('rejects a removed config and a replaced CLI package before spawning', async () => {
    const registration = await registerFixture();
    await fs.unlink(join(registration.dataDir, 'config.json'));
    await expect(
      launchRegisteredDaemon({ discoveryPath, expectedVersion: '0.3.0' }),
    ).rejects.toMatchObject({ code: 'config_missing' });
    await fs.writeFile(join(registration.dataDir, 'config.json'), '{}');
    await fs.writeFile(
      join(dirname(dirname(registration.cliPath)), 'package.json'),
      JSON.stringify({ name: 'unrelated-cli', version: '0.3.0' }),
    );
    await expect(
      launchRegisteredDaemon({ discoveryPath, expectedVersion: '0.3.0' }),
    ).rejects.toMatchObject({ code: 'runtime_unavailable' });
    await expect(
      fs.stat(join(registration.dataDir, 'child-result.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('spawns absolute Node and daemon-only CLI with the registered environment', async () => {
    const registration = await registerFixture();
    vi.stubEnv('NODE_OPTIONS', '--require=/does/not/exist');
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    const result = await launchRegisteredDaemon({
      discoveryPath,
      expectedVersion: '0.3.0',
      debug: true,
    });
    childPids.push(result.record.pid);
    expect(result.started).toBe(true);
    const report = JSON.parse(
      await fs.readFile(
        join(registration.dataDir, 'child-result.json'),
        'utf8',
      ),
    );
    expect(report.argv).toEqual(['--daemon-only', '--debug']);
    expect(report.cwd).toBe(await fs.realpath(registration.cwd));
    expect(report.dataDir).toBe(registration.dataDir);
    expect(report.path).toContain('/usr/bin:/bin');
    expect(report.nodeOptions).toBeUndefined();
    expect(report.electron).toBeUndefined();
    expect(result.logPath).toMatch(/daemon-startup-.*\.log$/u);
    if (process.platform !== 'win32')
      expect((await fs.stat(result.logPath!)).mode & 0o777).toBe(0o600);
  });

  it('waits for a concurrent winner after the spawned CLI exits successfully', async () => {
    const registration = await registerFixture();
    vi.stubEnv('QWEN_STARTUP_TEST_BEHAVIOR', 'exit-zero');
    const fixture = await serveInstance({ publish: false });
    const launch = launchRegisteredDaemon({
      discoveryPath,
      expectedVersion: '0.3.0',
    });
    await until(async () => {
      try {
        await fs.stat(join(registration.dataDir, 'child-result.json'));
        return true;
      } catch {
        return false;
      }
    });
    const report = JSON.parse(
      await fs.readFile(
        join(registration.dataDir, 'child-result.json'),
        'utf8',
      ),
    );
    await until(() => !isAlive(report.pid));
    await fixture.publish();
    await expect(launch).resolves.toMatchObject({
      started: false,
      record: { pid: process.pid },
    });
  });

  it('reports child failure with a readable bounded log', async () => {
    await registerFixture();
    vi.stubEnv('QWEN_STARTUP_TEST_BEHAVIOR', 'exit-error');
    const error = (await launchRegisteredDaemon({
      discoveryPath,
      expectedVersion: '0.3.0',
    }).catch((failure: unknown) => failure)) as {
      code: string;
      logPath: string;
    };
    expect(error.code).toBe('daemon_start_failed');
    expect(await fs.readFile(error.logPath, 'utf8')).toContain(
      'fixture startup failed',
    );
  });

  it('cancels a hung startup and confirms only its owned child has exited', async () => {
    const registration = await registerFixture();
    vi.stubEnv('QWEN_STARTUP_TEST_BEHAVIOR', 'hang');
    const abort = new AbortController();
    const launch = launchRegisteredDaemon({
      discoveryPath,
      expectedVersion: '0.3.0',
      signal: abort.signal,
    });
    await until(async () => {
      try {
        await fs.stat(join(registration.dataDir, 'child-result.json'));
        return true;
      } catch {
        return false;
      }
    });
    const report = JSON.parse(
      await fs.readFile(
        join(registration.dataDir, 'child-result.json'),
        'utf8',
      ),
    );
    childPids.push(report.pid);
    abort.abort();
    await expect(launch).rejects.toMatchObject({
      code: 'startup_aborted',
      logPath: expect.any(String),
    });
    expect(isAlive(report.pid)).toBe(false);
    expect(isAlive(process.pid)).toBe(true);
  });

  it('caps continuing daemon output at one MiB', async () => {
    const registration = await registerFixture();
    vi.stubEnv('QWEN_STARTUP_TEST_BEHAVIOR', 'noisy');
    const result = await launchRegisteredDaemon({
      discoveryPath,
      expectedVersion: '0.3.0',
    });
    childPids.push(result.record.pid);
    await until(async () => {
      try {
        await fs.stat(join(registration.dataDir, 'log-complete'));
        return true;
      } catch {
        return false;
      }
    });
    expect((await fs.stat(result.logPath!)).size).toBeLessThanOrEqual(
      1024 * 1024,
    );
  });

  it('times out a hung startup and leaves no owned child running', async () => {
    const registration = await registerFixture();
    vi.stubEnv('QWEN_STARTUP_TEST_BEHAVIOR', 'hang');
    await expect(
      launchRegisteredDaemon({
        discoveryPath,
        expectedVersion: '0.3.0',
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({
      code: 'startup_timeout',
      logPath: expect.any(String),
    });
    const report = JSON.parse(
      await fs.readFile(
        join(registration.dataDir, 'child-result.json'),
        'utf8',
      ),
    );
    childPids.push(report.pid);
    expect(isAlive(report.pid)).toBe(false);
  });

  it
    .skipIf(process.platform === 'win32')
    .each(['cancel', 'timeout', 'parent-exit'] as const)(
    'cleans its detached backend process group after %s, including stubborn descendants',
    async (mode) => {
      const registration = await registerFixture();
      vi.stubEnv(
        'QWEN_STARTUP_TEST_BEHAVIOR',
        mode === 'parent-exit' ? 'exit-with-grandchild' : 'stubborn-grandchild',
      );
      const abort = new AbortController();
      const launch = launchRegisteredDaemon({
        discoveryPath,
        expectedVersion: '0.3.0',
        signal: abort.signal,
        timeoutMs: mode === 'timeout' ? 700 : 10_000,
      });
      await until(async () => {
        try {
          await fs.stat(join(registration.dataDir, 'grandchild-result.json'));
          return true;
        } catch {
          return false;
        }
      });
      const parent = JSON.parse(
        await fs.readFile(
          join(registration.dataDir, 'child-result.json'),
          'utf8',
        ),
      );
      const grandchild = JSON.parse(
        await fs.readFile(
          join(registration.dataDir, 'grandchild-result.json'),
          'utf8',
        ),
      );
      childPids.push(parent.pid, grandchild.pid);
      if (mode === 'cancel') abort.abort();
      const failure = (await launch.catch((error: unknown) => error)) as {
        code: string;
        cause?: Error;
      };
      expect({
        code: failure.code,
        cleanupFailure:
          failure.code === 'startup_cleanup_failed'
            ? { message: failure.cause?.message, cause: failure.cause?.cause }
            : undefined,
      }).toMatchObject({
        code:
          mode === 'cancel'
            ? 'startup_aborted'
            : mode === 'timeout'
              ? 'startup_timeout'
              : 'daemon_start_failed',
      });
      expect(isAlive(parent.pid)).toBe(false);
      expect(isAlive(grandchild.pid)).toBe(false);
      expect(isAlive(process.pid)).toBe(true);
    },
    12_000,
  );

  it('retains at most five startup logs and leaves unrelated files alone', async () => {
    await registerFixture();
    const logs = join(dirname(discoveryPath), 'logs');
    await fs.mkdir(logs, { mode: 0o700 });
    for (let index = 0; index < 7; index += 1) {
      const file = join(logs, `daemon-startup-${index}-old.log`);
      await fs.writeFile(file, 'previous log', { mode: 0o600 });
      await fs.utimes(file, index + 1, index + 1);
    }
    await fs.writeFile(join(logs, 'unrelated.log'), 'keep');
    vi.stubEnv('QWEN_STARTUP_TEST_BEHAVIOR', 'exit-error');
    await expect(
      launchRegisteredDaemon({ discoveryPath, expectedVersion: '0.3.0' }),
    ).rejects.toMatchObject({ code: 'daemon_start_failed' });
    const remaining = await fs.readdir(logs);
    expect(
      remaining.filter((file) => file.startsWith('daemon-startup-')),
    ).toHaveLength(5);
    expect(remaining).toContain('daemon-startup-6-old.log');
    expect(await fs.readFile(join(logs, 'unrelated.log'), 'utf8')).toBe('keep');
  });
});
