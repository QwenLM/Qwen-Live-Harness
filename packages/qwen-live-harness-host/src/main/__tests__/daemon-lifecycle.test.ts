import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { DaemonIdentity } from 'qwen-live-harness/lifecycle';
import ts from 'typescript';
import { HostDaemonLifecycle, parseDaemonOwner } from '../daemon-lifecycle.ts';
import type { DiscoveryResult } from '../discovery.ts';
import { LIVE_PROTOCOL_VERSION } from '../../shared/protocol.ts';

const first: DaemonIdentity = {
  pid: 1234,
  instanceNonce: 'first_daemon_nonce_01',
};
const second: DaemonIdentity = {
  pid: 1234,
  instanceNonce: 'second_daemon_nonce_2',
};
const controllers: HostDaemonLifecycle[] = [];
afterEach(() =>
  controllers.splice(0).forEach((controller) => controller.stop()),
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function discovery(identity: DaemonIdentity): DiscoveryResult {
  return {
    kind: 'ready',
    signature: identity.instanceNonce,
    record: {
      ...identity,
      url: 'http://127.0.0.1:4321',
      token: 'fixture-token',
      protocolVersion: LIVE_PROTOCOL_VERSION,
    },
  };
}

function fixture(
  readStop: (path: string, identity: DaemonIdentity) => Promise<boolean>,
  readDiscovery: (path: string) => Promise<DiscoveryResult> = async () => ({
    kind: 'missing',
  }),
) {
  const stopped: DaemonIdentity[] = [];
  let errors = 0;
  const controller = new HostDaemonLifecycle(
    '/fixture/run/daemon.json',
    {
      onStopped: (identity) => stopped.push(identity),
      onError: () => {
        errors++;
      },
    },
    { readStop, readDiscovery },
  );
  controllers.push(controller);
  return { controller, stopped, errors: () => errors };
}

describe('Host daemon lifetime tracking', () => {
  it('parses one explicit daemon owner and rejects malformed or ambiguous arguments', () => {
    assert.equal(parseDaemonOwner(['Host']), undefined);
    const value = `--qwen-live-harness-owner=${first.pid}:${first.instanceNonce}`;
    assert.deepEqual(parseDaemonOwner(['Host', value]), first);
    for (const args of [
      [value, value],
      ['--qwen-live-harness-owner'],
      ['--qwen-live-harness-owner=0:first_daemon_nonce_01'],
      ['--qwen-live-harness-owner=-1:first_daemon_nonce_01'],
      ['--qwen-live-harness-owner=1:short'],
      ['--qwen-live-harness-owner=9007199254740992:first_daemon_nonce_01'],
      ['--qwen-live-harness-owner=1:../../marker.json'],
    ])
      assert.throws(() => parseDaemonOwner(args));
  });

  it('closes a CLI-launched Host when the daemon stopped before the first handshake', async () => {
    const value = fixture(async () => true);
    value.controller.follow(first);
    await value.controller.poll();
    assert.deepEqual(value.stopped, [first]);
    value.controller.follow(first);
    await value.controller.poll();
    assert.equal(value.stopped.length, 1);
  });

  it('keeps a ready or reconnecting Host open until an explicit stop marker appears', async () => {
    let marker = false;
    const value = fixture(async () => marker);
    value.controller.follow(first);
    await value.controller.poll();
    await value.controller.poll();
    assert.deepEqual(value.stopped, []);
    // Transport readiness is irrelevant: the same lifetime spans reconnects.
    marker = true;
    await value.controller.poll();
    assert.deepEqual(value.stopped, [first]);
  });

  it('does not close for ordinary disconnection or a crashed process without a stop marker', async () => {
    const value = fixture(async () => false);
    value.controller.follow(first);
    for (let check = 0; check < 4; check++) await value.controller.poll();
    assert.deepEqual(value.stopped, []);
    assert.equal(value.errors(), 0);
  });

  it('ignores an old nonce read completing after a new authenticated instance takes over', async () => {
    const previous = deferred<boolean>();
    const value = fixture(async (_path, identity) =>
      identity.instanceNonce === first.instanceNonce ? previous.promise : false,
    );
    value.controller.follow(first);
    const oldRead = value.controller.poll();
    value.controller.follow(second);
    await value.controller.poll();
    previous.resolve(true);
    await oldRead;
    assert.deepEqual(value.stopped, []);
  });

  it('does not interrupt an explicit local Quit whose acknowledgement is still pending', async () => {
    const pending = deferred<boolean>();
    const value = fixture(async () => pending.promise);
    value.controller.follow(first);
    const reading = value.controller.poll();
    value.controller.pause();
    pending.resolve(true);
    await reading;
    assert.deepEqual(value.stopped, []);
    value.controller.resume();
    await value.controller.poll();
    assert.deepEqual(value.stopped, [first]);
  });

  it('keeps the UI on invalid markers, reports once, and accepts a repaired marker', async () => {
    let broken = true;
    const value = fixture(async () => {
      if (broken) throw new Error('unsafe marker');
      return true;
    });
    value.controller.follow(first);
    await value.controller.poll();
    await value.controller.poll();
    assert.deepEqual(value.stopped, []);
    assert.equal(value.errors(), 1);
    broken = false;
    await value.controller.poll();
    assert.deepEqual(value.stopped, [first]);
  });

  it('rejects another second-instance owner unless the selected discovery record matches', async () => {
    let current = first;
    const value = fixture(
      async () => false,
      async () => discovery(current),
    );
    value.controller.follow(first);
    assert.equal(await value.controller.acceptActivation(second), false);
    assert.equal(await value.controller.acceptActivation(first), true);
    current = second;
    assert.equal(await value.controller.acceptActivation(second), true);
    assert.equal(await value.controller.acceptActivation(first), false);
  });

  it('never adopts an activation checked before a later authenticated identity arrived', async () => {
    const pending = deferred<DiscoveryResult>();
    const value = fixture(
      async () => false,
      async () => pending.promise,
    );
    value.controller.follow(first);
    const activation = value.controller.acceptActivation(second);
    value.controller.follow({ ...second, pid: 4321 });
    pending.resolve(discovery(second));
    assert.equal(await activation, false);
  });

  it('rejects a late authenticated old owner after another CLI owner has been accepted', async () => {
    let marker = false;
    const value = fixture(
      async (_path, identity) =>
        marker && identity.instanceNonce === first.instanceNonce,
      async () => discovery(second),
    );
    value.controller.follow(first);
    await value.controller.poll();
    assert.equal(await value.controller.acceptActivation(second), true);
    marker = true;
    assert.equal(await value.controller.acceptAuthenticated(first), false);
    await value.controller.poll();
    assert.deepEqual(value.stopped, []);
  });

  it('holds the old marker while validating a newly welcomed owner, including stale reads', async () => {
    const oldMarker = deferred<boolean>();
    const verifying = deferred<DiscoveryResult>();
    const value = fixture(
      async (_path, identity) =>
        identity.instanceNonce === first.instanceNonce
          ? oldMarker.promise
          : false,
      async () => verifying.promise,
    );
    value.controller.follow(first);
    const oldRead = value.controller.poll();
    const accepted = value.controller.acceptAuthenticated(second);
    oldMarker.resolve(true);
    await oldRead;
    assert.deepEqual(value.stopped, []);
    verifying.resolve(discovery(second));
    assert.equal(await accepted, true);
    await value.controller.poll();
    assert.deepEqual(value.stopped, []);
  });

  it('can retain the original authenticated Quit target after discovery disappears, but not a replaced one', async () => {
    const value = fixture(async () => false);
    value.controller.follow(first);
    value.controller.pause();
    assert.equal(
      await value.controller.acceptAuthenticated(first, { allowMissing: true }),
      true,
    );
    assert.equal(
      await value.controller.acceptAuthenticated(second, {
        allowMissing: true,
      }),
      false,
    );
    assert.deepEqual(value.stopped, []);
  });

  it('does not lose a validated target when local Quit pauses an in-flight authentication check', async () => {
    const pending = deferred<DiscoveryResult>();
    const value = fixture(
      async () => false,
      async () => pending.promise,
    );
    value.controller.follow(first);
    const validating = value.controller.acceptAuthenticated(first);
    value.controller.pause();
    pending.resolve(discovery(first));
    assert.equal(await validating, true);
    assert.deepEqual(value.stopped, []);
  });
});

function quitFixture() {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile(
    'index.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set([
    'quitHost',
    'quitFromDaemon',
    'rememberDaemonStartup',
  ]);
  const functions = tree.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text),
  );
  assert.equal(functions.length, names.size);
  const events: string[] = [];
  const context = {
    startupInteraction: { cancel: () => events.push('cancel interaction') },
    daemonLifecycle: {
      stop: () => events.push('stop marker polling'),
      pause: () => events.push('pause marker polling'),
      resume: () => events.push('resume marker polling'),
      acceptAuthenticated: async (
        _identity: DaemonIdentity,
        _options?: { allowMissing?: boolean },
      ) => true,
    },
    daemonBootstrap: {
      stop: async () => {
        events.push('cancel bootstrap');
      },
    },
    daemon: {
      stop: () => events.push('stop transport'),
      start: () => events.push('start discovery'),
      rememberStartupTarget: (identity: DaemonIdentity) =>
        events.push(`remember ${identity.instanceNonce}`),
      requestQuit: async () => {
        events.push('POST /quit');
      },
    },
    quitting: false,
    quitApproved: false,
    quitState: undefined as string | undefined,
    quitOperation: undefined as Promise<void> | undefined,
    deactivateNativeServices: () => events.push('stop devices'),
    publishState: () => {},
    writeLiveDiagnostic: () => {},
    resetOverlayInteraction: () => {},
    showOverlay: () => events.push('show error'),
    connection: { phase: 'ready' },
    liveMessage: (key: string) => key,
    app: { quit: () => events.push('quit app') },
  };
  const controls = runInNewContext(
    ts.transpileModule(
      `${functions.map((node) => node.getText(tree)).join('\n')}\n({ quitHost, quitFromDaemon, rememberDaemonStartup })`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  ) as {
    quitHost: () => Promise<void>;
    quitFromDaemon: () => Promise<void>;
    rememberDaemonStartup: (identity: DaemonIdentity) => Promise<boolean>;
  };
  return { context, controls, events };
}

describe('Host daemon-initiated exit', () => {
  it('waits for startup cancellation, stops transport/devices, and never sends reverse Quit', async () => {
    const value = quitFixture();
    const cleanup = deferred<void>();
    value.context.daemonBootstrap.stop = () => cleanup.promise;
    const exiting = value.controls.quitFromDaemon();
    assert.equal(value.context.quitting, true);
    assert(value.events.includes('stop transport'));
    assert(value.events.includes('stop devices'));
    assert(!value.events.includes('quit app'));
    cleanup.resolve();
    await exiting;
    assert.equal(value.context.quitApproved, true);
    assert(value.events.includes('quit app'));
    assert(!value.events.includes('POST /quit'));
  });

  it('retains the authenticated ACK path when local Quit won the race', async () => {
    const value = quitFixture();
    const ack = deferred<void>();
    value.context.daemon.requestQuit = () => ack.promise;
    const local = value.controls.quitHost();
    await Promise.resolve();
    assert.equal(value.controls.quitFromDaemon(), local);
    assert.equal(value.context.quitApproved, false);
    assert(!value.events.includes('quit app'));
    ack.resolve();
    await local;
    assert.equal(value.context.quitApproved, true);
    assert.equal(
      value.events.filter((event) => event === 'quit app').length,
      1,
    );
  });

  it('keeps failed startup cleanup visible and permits the existing Quit retry', async () => {
    const value = quitFixture();
    value.context.daemonBootstrap.stop = async () => {
      throw new Error('cleanup failed');
    };
    await value.controls.quitFromDaemon();
    assert.equal(value.context.quitState, 'failed');
    assert.equal(value.context.quitApproved, false);
    assert(value.events.includes('show error'));
    value.context.daemonBootstrap.stop = async () => {};
    await value.controls.quitHost();
    assert.equal(value.context.quitApproved, true);
  });

  it('resumes after a failed local Quit and accepts an explicit daemon exit without another POST', async () => {
    const value = quitFixture();
    let requests = 0;
    value.context.daemon.requestQuit = async () => {
      requests++;
      throw new Error('not acknowledged');
    };
    await assert.rejects(value.controls.quitHost());
    assert.equal(value.context.quitState, 'failed');
    assert(value.events.includes('resume marker polling'));
    await value.controls.quitFromDaemon();
    assert.equal(requests, 1);
    assert.equal(value.context.quitApproved, true);
    assert.equal(
      value.events.filter((event) => event === 'quit app').length,
      1,
    );
  });

  it('does not remember stale bootstrap authority and still starts discovery for the newer owner', async () => {
    const value = quitFixture();
    value.context.daemonLifecycle.acceptAuthenticated = async () => false;
    assert.equal(await value.controls.rememberDaemonStartup(first), false);
    assert(!value.events.includes(`remember ${first.instanceNonce}`));
    assert(value.events.includes('start discovery'));
  });

  it('awaits validated bootstrap authority during Quit without opening a new connection', async () => {
    const value = quitFixture();
    const pending = deferred<boolean>();
    value.context.quitting = true;
    value.context.daemonLifecycle.acceptAuthenticated = async (
      _identity,
      options,
    ) => {
      assert.equal(options?.allowMissing, true);
      return pending.promise;
    };
    const remembering = value.controls.rememberDaemonStartup(first);
    assert(!value.events.includes(`remember ${first.instanceNonce}`));
    pending.resolve(true);
    assert.equal(await remembering, true);
    assert(value.events.includes(`remember ${first.instanceNonce}`));
    assert(!value.events.includes('start discovery'));
  });
});
