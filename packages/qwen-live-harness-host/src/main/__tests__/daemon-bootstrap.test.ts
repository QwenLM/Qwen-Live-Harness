import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { launchRegisteredDaemon } from 'qwen-live-harness/startup';
import { StartupError } from 'qwen-live-harness/startup';
import { HostDaemonBootstrap } from '../daemon-bootstrap.ts';
import { LIVE_PROTOCOL_VERSION } from '../../shared/protocol.ts';

type LaunchOptions = Parameters<typeof launchRegisteredDaemon>[0];
type LaunchResult = Awaited<ReturnType<typeof launchRegisteredDaemon>>;

const ready: LaunchResult = {
  kind: 'ready',
  started: true,
  version: '0.4.0',
  record: {
    url: 'http://127.0.0.1:4321',
    token: 'fixture-token',
    protocolVersion: LIVE_PROTOCOL_VERSION,
    pid: 1234,
    instanceNonce: 'fixture_daemon_nonce',
  },
};

function pendingLaunch() {
  let resolve!: (result: LaunchResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<LaunchResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('explicit Host daemon bootstrap', () => {
  it('coalesces app activation and second-instance launches into one operation', async () => {
    const pending = pendingLaunch();
    const calls: LaunchOptions[] = [];
    const targets: LaunchResult[] = [];
    const phases: string[] = [];
    const bootstrap = new HostDaemonBootstrap(
      {
        discoveryPath: '/fixture/run/daemon.json',
        expectedVersion: ready.version,
        debug: true,
      },
      {
        onReady: (result) => targets.push(result),
        onChange: () => phases.push(bootstrap.snapshot.phase),
      },
      async (options) => {
        calls.push(options);
        return pending.promise;
      },
    );
    const first = bootstrap.start();
    assert.equal(bootstrap.start(), first);
    await Promise.resolve();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.discoveryPath, '/fixture/run/daemon.json');
    assert.equal(calls[0]?.expectedVersion, ready.version);
    assert.equal(calls[0]?.debug, true);
    assert.equal(calls[0]?.signal?.aborted, false);
    pending.resolve(ready);
    await first;
    assert.deepEqual(targets, [ready]);
    assert.deepEqual(phases, ['starting', 'ready']);
  });

  it('keeps a startup failure visible until an explicit retry succeeds', async () => {
    const error = new Error('runtime_missing');
    let launches = 0;
    const bootstrap = new HostDaemonBootstrap(
      { discoveryPath: '/fixture/daemon.json', expectedVersion: ready.version },
      { onReady: () => {}, onChange: () => {} },
      async () => {
        if (++launches === 1) throw error;
        return { ...ready, started: false };
      },
    );
    await bootstrap.start();
    assert.deepEqual(bootstrap.snapshot, { phase: 'failed', error });
    await Promise.resolve();
    assert.equal(launches, 1);
    const retry = bootstrap.start();
    assert.equal(bootstrap.snapshot.phase, 'starting');
    await retry;
    assert.equal(launches, 2);
    assert.equal(bootstrap.snapshot.phase, 'ready');
  });

  it('never replaces a stopped CLI daemon during connect-only launch, and permits later user retry', async () => {
    const attempts: boolean[] = [];
    let spawned = 0;
    const bootstrap = new HostDaemonBootstrap(
      { discoveryPath: '/fixture/daemon.json', expectedVersion: ready.version },
      { onReady: () => {}, onChange: () => {} },
      async ({ startIfMissing }) => {
        attempts.push(startIfMissing === true);
        if (!startIfMissing) throw new StartupError('daemon_unresponsive');
        spawned++;
        return ready;
      },
    );
    const initial = bootstrap.start({ startIfMissing: false });
    assert.equal(bootstrap.start(), initial);
    await initial;
    assert.equal(spawned, 0);
    assert.equal(bootstrap.snapshot.phase, 'failed');
    await bootstrap.start();
    assert.equal(spawned, 1);
    assert.deepEqual(attempts, [false, true]);
  });

  it('waits for cancellation cleanup and never relaunches after Quit', async () => {
    const pending = pendingLaunch();
    let launchSignal: AbortSignal | undefined;
    let launches = 0;
    const bootstrap = new HostDaemonBootstrap(
      { discoveryPath: '/fixture/daemon.json', expectedVersion: ready.version },
      {
        onReady: () => assert.fail('An aborted launch did not become ready'),
        onChange: () => {},
      },
      async ({ signal }) => {
        launches++;
        launchSignal = signal;
        return pending.promise;
      },
    );
    void bootstrap.start();
    await Promise.resolve();
    let stopped = false;
    const stopping = bootstrap.stop().then(() => {
      stopped = true;
    });
    assert.equal(launchSignal?.aborted, true);
    await Promise.resolve();
    assert.equal(stopped, false);
    pending.reject(new Error('aborted after child exited'));
    await stopping;
    assert.equal(stopped, true);
    await bootstrap.start();
    assert.equal(launches, 1);
  });

  it('remembers a ready daemon when Quit races with successful launch completion', async () => {
    const pending = pendingLaunch();
    const targets: LaunchResult[] = [];
    const bootstrap = new HostDaemonBootstrap(
      { discoveryPath: '/fixture/daemon.json', expectedVersion: ready.version },
      { onReady: (result) => targets.push(result), onChange: () => {} },
      async () => pending.promise,
    );
    void bootstrap.start();
    await Promise.resolve();
    const stopping = bootstrap.stop();
    pending.resolve(ready);
    await stopping;
    assert.deepEqual(targets, [ready]);
  });

  it('retains failed child cleanup for an explicit Quit retry', async () => {
    const pending = pendingLaunch();
    let retries = 0;
    const cleanupError = new StartupError('startup_cleanup_failed', {
      retryCleanup: async () => {
        retries++;
      },
    });
    const bootstrap = new HostDaemonBootstrap(
      { discoveryPath: '/fixture/daemon.json', expectedVersion: ready.version },
      { onReady: () => assert.fail('No ready child'), onChange: () => {} },
      async () => pending.promise,
    );
    void bootstrap.start();
    await Promise.resolve();
    const stopping = bootstrap.stop();
    pending.reject(cleanupError);
    await assert.rejects(stopping, (error) => error === cleanupError);
    assert.equal(retries, 0);
    await bootstrap.stop();
    assert.equal(retries, 1);
    await bootstrap.stop();
    assert.equal(retries, 1);
  });

  it('clears a retained launch error when an existing connection becomes ready', async () => {
    const bootstrap = new HostDaemonBootstrap(
      { discoveryPath: '/fixture/daemon.json', expectedVersion: ready.version },
      { onReady: () => {}, onChange: () => {} },
      async () => {
        throw new Error('unresponsive');
      },
    );
    await bootstrap.start();
    assert.equal(bootstrap.snapshot.phase, 'failed');
    bootstrap.markConnected();
    assert.equal(bootstrap.snapshot.phase, 'ready');
  });
});
