/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { LiveConfig } from './config.js';
import {
  startCliApplication,
  type CliStartupDependencies,
} from './cli-startup.js';
import { LiveLogger } from './logger.js';
import { StartupError } from './startup.js';
import { liveText } from './i18n/messages.js';

const config = {
  dataDir: '/synthetic/config',
  discoveryDir: '/synthetic/discovery',
  defaultCwd: '/synthetic/project',
  language: 'en',
} as LiveConfig;

function fixture() {
  const events: string[] = [];
  const daemon = {
    start: vi.fn(async () => {
      events.push('daemon');
      return { port: 1, url: 'http://127.0.0.1:1' };
    }),
    stop: vi.fn(async () => {
      events.push('stop');
    }),
    stopForProcessExit: vi.fn(async () => {}),
    getInstanceIdentity: () => ({
      pid: 12345,
      instanceNonce: 'owned_cli_instance_12345',
    }),
  };
  const dependencies: CliStartupDependencies = {
    platform: 'darwin',
    version: '0.4.0',
    probe: vi.fn(async () => ({ kind: 'missing' as const })),
    register: vi.fn(async () => {
      events.push('register');
      return {
        schemaVersion: 1 as const,
        nodePath: '/node',
        cliPath: '/cli',
        version: '0.4.0',
        dataDir: config.dataDir,
        discoveryDir: config.discoveryDir,
        cwd: '/',
        path: '/bin',
      };
    }),
    lock: async (_path, callback) => {
      events.push('lock');
      try {
        return await callback();
      } finally {
        events.push('unlock');
      }
    },
    createDaemon: vi.fn(() => daemon),
    openHost: vi.fn(async () => {
      events.push('host');
      return { state: 'installed' as const, version: '0.4.0' };
    }),
  };
  const logger = new LiveLogger('error');
  const options = { daemonOnly: false, debug: true, logger };
  return { dependencies, daemon, options, events };
}

describe('one-command application startup', () => {
  it('serializes preflight and registration before opening Host with matching discovery', async () => {
    const f = fixture();
    await expect(
      startCliApplication(config, f.options, f.dependencies),
    ).resolves.toEqual({ reused: false });
    expect(f.events).toEqual(['lock', 'daemon', 'register', 'unlock', 'host']);
    expect(f.dependencies.openHost).toHaveBeenCalledWith(
      expect.objectContaining({
        debug: true,
        discoveryPath: '/synthetic/discovery/run/daemon.json',
        connectOnly: true,
        owner: f.daemon.getInstanceIdentity(),
        onStage: expect.any(Function),
      }),
    );
    expect(f.daemon.stop).not.toHaveBeenCalled();
  });

  it('reuses an authenticated existing daemon without preflighting or replacing its sessions', async () => {
    const f = fixture();
    f.dependencies.probe = vi.fn(async () => ({
      kind: 'ready' as const,
      version: '0.4.0',
      record: {
        pid: 100,
        protocolVersion: 9 as const,
        instanceNonce: 'abcdefghijklmnop',
        url: 'http://127.0.0.1:1234',
        configPath: '/synthetic/config/config.json',
      },
    }));
    await expect(
      startCliApplication(config, f.options, f.dependencies),
    ).resolves.toEqual({ reused: true });
    expect(f.dependencies.createDaemon).not.toHaveBeenCalled();
    expect(f.events).toEqual(['lock', 'register', 'unlock', 'host']);
  });

  it('refuses to reconfigure a daemon belonging to another profile', async () => {
    const f = fixture();
    f.dependencies.probe = vi.fn(async () => ({
      kind: 'ready' as const,
      version: '0.4.0',
      record: {
        pid: 100,
        protocolVersion: 9 as const,
        instanceNonce: 'abcdefghijklmnop',
        url: 'http://127.0.0.1:1234',
        configPath: '/different/config.json',
      },
    }));
    await expect(
      startCliApplication(config, f.options, f.dependencies),
    ).rejects.toMatchObject({ code: 'daemon_mismatch' });
    expect(f.dependencies.register).not.toHaveBeenCalled();
    expect(f.dependencies.openHost).not.toHaveBeenCalled();
  });

  it('keeps daemon-only startup locked without launching Host or rewriting registration', async () => {
    const f = fixture();
    await startCliApplication(
      config,
      { ...f.options, daemonOnly: true },
      f.dependencies,
    );
    expect(f.events).toEqual(['lock', 'daemon', 'unlock']);
  });

  it('does not create a daemon after cancellation while waiting for the lock', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.dependencies.lock = async (_path, callback) => {
      controller.abort();
      return callback();
    };
    await expect(
      startCliApplication(
        config,
        { ...f.options, signal: controller.signal },
        f.dependencies,
      ),
    ).rejects.toMatchObject({ code: 'startup_aborted' });
    expect(f.dependencies.createDaemon).not.toHaveBeenCalled();
    expect(f.dependencies.openHost).not.toHaveBeenCalled();
  });

  it('cleans up its own daemon if registration or Host opening fails', async () => {
    for (const failure of ['register', 'openHost'] as const) {
      const f = fixture();
      f.dependencies[failure] = vi.fn(async () => {
        throw new StartupError('runtime_unavailable');
      });
      await expect(
        startCliApplication(config, f.options, f.dependencies),
      ).rejects.toMatchObject({ code: 'runtime_unavailable' });
      expect(f.daemon.stopForProcessExit).toHaveBeenCalledOnce();
    }
  });

  it('cancels an in-flight backend preflight without waiting for it to initialize', async () => {
    const f = fixture();
    const controller = new AbortController();
    let rejectStart: (error: Error) => void = () => {};
    f.daemon.start.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    f.daemon.stopForProcessExit.mockImplementation(async () => {
      rejectStart(new Error('cancelled preflight'));
    });
    const operation = startCliApplication(
      config,
      { ...f.options, signal: controller.signal },
      f.dependencies,
    );
    const assertion = expect(operation).rejects.toThrow('cancelled preflight');
    await vi.waitFor(() => expect(f.daemon.start).toHaveBeenCalledOnce());
    controller.abort();
    await assertion;
    expect(f.daemon.stopForProcessExit).toHaveBeenCalledOnce();
    expect(f.dependencies.openHost).not.toHaveBeenCalled();
  });

  it('never stops a reused daemon when opening Host fails', async () => {
    const f = fixture();
    f.dependencies.probe = async () => ({
      kind: 'ready',
      version: '0.4.0',
      record: {
        pid: 100,
        protocolVersion: 9,
        instanceNonce: 'abcdefghijklmnop',
        url: 'http://127.0.0.1:1234',
        configPath: '/synthetic/config/config.json',
      },
    });
    f.dependencies.openHost = vi.fn(async () => ({
      state: 'error' as const,
      message: 'synthetic launch failure',
    }));
    await expect(
      startCliApplication(config, f.options, f.dependencies),
    ).rejects.toThrow('synthetic launch failure');
    expect(f.daemon.stop).not.toHaveBeenCalled();
    expect(f.daemon.stopForProcessExit).not.toHaveBeenCalled();
    expect(f.dependencies.createDaemon).not.toHaveBeenCalled();
  });

  it('forwards cancellation to a pending Host inspection and closes only its owned application', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.dependencies.openHost = vi.fn(async (options) => {
      options?.onStage?.('checking');
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
      });
      throw new Error('The cancelled inspection must not proceed');
    });
    const operation = startCliApplication(
      config,
      { ...f.options, signal: controller.signal },
      f.dependencies,
    );
    const rejected = expect(operation).rejects.toThrow();
    await vi.waitFor(() =>
      expect(f.dependencies.openHost).toHaveBeenCalledOnce(),
    );
    controller.abort();
    await rejected;
    expect(f.daemon.stopForProcessExit).toHaveBeenCalledOnce();
    expect(f.dependencies.openHost).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
        owner: f.daemon.getInstanceIdentity(),
      }),
    );
  });

  it('reports long Host phases in normal logs and timings only in diagnostic logs', async () => {
    const f = fixture();
    const info = vi.spyOn(f.options.logger, 'info');
    const debug = vi.spyOn(f.options.logger, 'debug');
    f.dependencies.openHost = async (options) => {
      options?.onStage?.('checking');
      options?.onStage?.('opening');
      return { state: 'installed', version: '0.4.0' };
    };
    await startCliApplication(config, f.options, f.dependencies);
    expect(info).toHaveBeenCalledWith(liveText('en', 'cli.checkingInstance'));
    expect(info).toHaveBeenCalledWith(liveText('en', 'cli.checkingHost'));
    expect(info).toHaveBeenCalledWith(liveText('en', 'cli.openingHost'));
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('startup.host_checked'),
    );
  });
});
