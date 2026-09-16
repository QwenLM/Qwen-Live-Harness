import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseDevelopmentArgs, runDevelopment } from '../start-dev.mjs';

function fixture() {
  const root = '/synthetic/Qwen-Live-Harness';
  const discoveryPath = '/synthetic/profile/run/daemon.json';
  const configPath = '/synthetic/profile/config.json';
  const electron = `${root}/packages/qwen-live-harness-host/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`;
  const records = [];
  const active = new Map();
  const signals = [];
  let pid = 10_000;
  const spawn = vi.fn((command, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      pid: ++pid,
      exitCode: null,
      signalCode: null,
    });
    const record = {
      command,
      args,
      options,
      child,
      kind: args.includes('--daemon-only')
        ? 'daemon'
        : args.includes('--source')
          ? 'init'
          : command === electron
            ? 'host'
            : 'build',
      finish(code = 0, signal = null) {
        if (!active.has(child.pid)) return;
        active.delete(child.pid);
        child.exitCode = code;
        child.signalCode = signal;
        child.emit('exit', code, signal);
      },
    };
    records.push(record);
    active.set(child.pid, record);
    if (record.kind === 'build') queueMicrotask(() => record.finish());
    return child;
  });
  const kill = vi.fn((pid, signal) => {
    const record = active.get(Math.abs(pid));
    if (!record) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    if (signal !== 0) {
      signals.push({ pid, signal });
      record.finish(null, signal);
    }
    return true;
  });
  const probe = vi.fn(async () => {
    const daemon = records.find((record) => record.kind === 'daemon');
    return daemon
      ? {
          kind: 'ready',
          record: {
            pid: daemon.child.pid,
            instanceNonce: 'abcdefghijklmnop',
            configPath,
            token: 'NEVER-LOG-THIS',
          },
          version: '0.4.2',
        }
      : { kind: 'missing' };
  });
  const deps = {
    platform: 'darwin',
    node: '/synthetic/node',
    env: { npm_execpath: '/synthetic/npm-cli.js', ELECTRON_RUN_AS_NODE: '1' },
    spawn,
    kill,
    findElectron: vi.fn(async () => electron),
    assertNoHost: vi.fn(async () => {}),
    loadRuntime: vi.fn(async () => ({
      discoveryPath,
      configPath,
      version: '0.4.2',
      probe,
    })),
    log: vi.fn(),
  };
  return {
    root,
    discoveryPath,
    configPath,
    electron,
    records,
    signals,
    active,
    probe,
    deps,
  };
}

describe('source development launcher', () => {
  it('accepts debug/help but not installed-CLI commands', () => {
    expect(parseDevelopmentArgs(['--debug'])).toEqual({
      command: 'start',
      debug: true,
      help: false,
    });
    expect(parseDevelopmentArgs(['-h'])).toEqual({
      command: 'start',
      debug: false,
      help: true,
    });
    expect(parseDevelopmentArgs(['init', '--debug'])).toEqual({
      command: 'init',
      debug: true,
      help: false,
    });
    expect(() => parseDevelopmentArgs(['--daemon-only'])).toThrow(
      'Unknown development option',
    );
  });

  it('initializes from source after only building the daemon, without loading config or requiring Electron', async () => {
    const f = fixture();
    f.deps.platform = 'linux';
    f.deps.findElectron.mockRejectedValue(new Error('Electron is absent'));
    f.deps.loadRuntime.mockRejectedValue(new Error('No configured API key'));
    const operation = runDevelopment({ root: f.root, command: 'init' }, f.deps);
    await vi.waitFor(() => expect(f.records).toHaveLength(2));
    const [build, wizard] = f.records;
    expect(build.args).toEqual(['/synthetic/npm-cli.js', 'run', 'build']);
    expect(wizard.args).toEqual([
      `${f.root}/packages/qwen-live-harness/dist/index.js`,
      'init',
      '--source',
    ]);
    expect(wizard.options).toMatchObject({
      detached: false,
      stdio: 'inherit',
      shell: false,
    });
    expect(f.deps.findElectron).not.toHaveBeenCalled();
    expect(f.deps.assertNoHost).not.toHaveBeenCalled();
    expect(f.deps.loadRuntime).not.toHaveBeenCalled();
    wizard.finish();
    await operation;
    expect(f.active.size).toBe(0);
    expect(f.signals).toEqual([]);
  });

  it('cancels only the foreground initialization child, never its shared terminal group', async () => {
    const f = fixture();
    const controller = new AbortController();
    const operation = runDevelopment(
      { root: f.root, command: 'init', signal: controller.signal },
      f.deps,
    );
    const cancelled = expect(operation).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.waitFor(() => expect(f.records).toHaveLength(2));
    const wizard = f.records[1];
    controller.abort();
    await cancelled;
    expect(f.signals).toEqual([{ pid: wizard.child.pid, signal: 'SIGTERM' }]);
    expect(f.active.size).toBe(0);
  });

  it('prints a short unknown-option error without an uncaught stack or starting a build', () => {
    const result = spawnSync(
      process.execPath,
      [resolve('scripts/start-dev.mjs'), '--unknown-option'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Unknown development option: --unknown-option',
    );
    expect(result.stderr).toContain('Usage: npm start');
    expect(result.stderr).not.toMatch(
      /\bat main|\bat parseDevelopmentArgs|Building daemon/u,
    );
  });

  it('builds both packages, opens checkout Electron and closes only its own children on Ctrl+C', async () => {
    const f = fixture();
    const controller = new AbortController();
    const operation = runDevelopment(
      { root: f.root, debug: true, signal: controller.signal },
      f.deps,
    );
    const cancelled = expect(operation).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.waitFor(() => expect(f.records).toHaveLength(4));
    const [daemonBuild, hostBuild, daemon, host] = f.records;
    expect(daemonBuild.args).toEqual(['/synthetic/npm-cli.js', 'run', 'build']);
    expect(hostBuild.args).toEqual([
      '/synthetic/npm-cli.js',
      'run',
      'build:host',
    ]);
    expect(daemon.args).toEqual([
      `${f.root}/packages/qwen-live-harness/dist/index.js`,
      '--daemon-only',
      '--debug',
    ]);
    expect(host.command).toBe(f.electron);
    expect(host.args).toEqual([
      `${f.root}/packages/qwen-live-harness-host`,
      '--qwen-live-harness-connect-only',
      `--qwen-live-harness-discovery-file=${f.discoveryPath}`,
      `--qwen-live-harness-owner=${daemon.child.pid}:abcdefghijklmnop`,
      '--live-harness-debug',
    ]);
    expect(host.options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(
      f.records.every(
        ({ options }) =>
          options.detached &&
          options.stdio === 'inherit' &&
          options.shell === false,
      ),
    ).toBe(true);
    expect(JSON.stringify(f.records.map(({ args }) => args))).not.toContain(
      'NEVER-LOG-THIS',
    );
    expect(JSON.stringify(f.deps.log.mock.calls)).not.toContain(
      'NEVER-LOG-THIS',
    );
    controller.abort();
    await cancelled;
    expect(f.signals).toEqual([
      { pid: -daemon.child.pid, signal: 'SIGTERM' },
      { pid: -host.child.pid, signal: 'SIGTERM' },
    ]);
    expect(f.active.size).toBe(0);
  });

  it('leaves an already-running daemon untouched and never launches Host', async () => {
    const f = fixture();
    f.probe.mockResolvedValue({ kind: 'ready', record: { pid: 42 } });
    await expect(runDevelopment({ root: f.root }, f.deps)).rejects.toThrow(
      'already running',
    );
    expect(f.records.map(({ kind }) => kind)).toEqual(['build', 'build']);
    expect(f.signals).toEqual([]);
  });

  it('refuses an existing Host before building or starting a daemon', async () => {
    const f = fixture();
    f.deps.assertNoHost.mockRejectedValue(new Error('Host already running'));
    await expect(runDevelopment({ root: f.root }, f.deps)).rejects.toThrow(
      'Host already running',
    );
    expect(f.records).toEqual([]);
    expect(f.signals).toEqual([]);
  });

  it('does not take ownership when another daemon wins the startup race', async () => {
    const f = fixture();
    f.probe.mockResolvedValueOnce({ kind: 'missing' }).mockResolvedValue({
      kind: 'ready',
      record: {
        pid: 42,
        configPath: f.configPath,
        instanceNonce: 'foreign-daemon-id',
      },
    });
    await expect(runDevelopment({ root: f.root }, f.deps)).rejects.toThrow(
      'Another daemon won startup',
    );
    const own = f.records.find(({ kind }) => kind === 'daemon');
    expect(f.signals).toEqual([{ pid: -own.child.pid, signal: 'SIGTERM' }]);
    expect(f.records.some(({ kind }) => kind === 'host')).toBe(false);
  });

  it('stops its daemon when the source Host quits', async () => {
    const f = fixture();
    const operation = runDevelopment({ root: f.root }, f.deps);
    await vi.waitFor(() => expect(f.records).toHaveLength(4));
    const daemon = f.records[2];
    f.records[3].finish();
    await operation;
    expect(f.signals).toEqual([{ pid: -daemon.child.pid, signal: 'SIGTERM' }]);
    expect(f.active.size).toBe(0);
  });

  it('stops its Host and reports a daemon crash', async () => {
    const f = fixture();
    const operation = runDevelopment({ root: f.root }, f.deps);
    const failed = expect(operation).rejects.toThrow(
      'daemon exited with code 3',
    );
    await vi.waitFor(() => expect(f.records).toHaveLength(4));
    const host = f.records[3];
    f.records[2].finish(3);
    await failed;
    expect(f.signals).toEqual([{ pid: -host.child.pid, signal: 'SIGTERM' }]);
  });

  it('can cancel a build without ever opening a source Host', async () => {
    const f = fixture();
    const originalSpawn = f.deps.spawn;
    const child = Object.assign(new EventEmitter(), { pid: 55 });
    f.deps.spawn = vi.fn(() => child);
    let alive = true;
    f.deps.kill = vi.fn((_pid, signal) => {
      if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      if (signal !== 0) {
        alive = false;
        child.emit('exit', null, signal);
      }
    });
    const controller = new AbortController();
    const operation = runDevelopment(
      { root: f.root, signal: controller.signal },
      f.deps,
    );
    const cancelled = expect(operation).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.waitFor(() => expect(f.deps.spawn).toHaveBeenCalledOnce());
    controller.abort();
    await cancelled;
    expect(f.deps.kill).toHaveBeenCalledWith(-55, 'SIGTERM');
    expect(originalSpawn).not.toHaveBeenCalled();
    expect(f.deps.loadRuntime).not.toHaveBeenCalled();
  });
});
