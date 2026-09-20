import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { displayLiveMessage, liveText } from 'qwen-live-harness/i18n';
import { LiveDaemonConnection } from '../daemon-connection.ts';
import {
  LIVE_PROTOCOL_VERSION,
  encodeHostControlMessage,
  parseDaemonControlMessage,
} from '../../shared/protocol.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const status = {
  v: 1,
  available: true,
  state: 'listening',
  shortcut: 'Command+E',
};
function receive(peer: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Missing permission mode action')),
      3000,
    );
    peer.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
  });
}
async function fixture(supports = true) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => {
    for (const socket of server.clients) socket.terminate();
    server.close();
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const directory = await mkdtemp(join(tmpdir(), 'live-permission-mode-host-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'daemon.json');
  await writeFile(
    path,
    JSON.stringify({
      url: `http://127.0.0.1:${address.port}`,
      token: 'fixture',
      pid: process.pid,
      instanceNonce: 'abcdefghijklmnop',
      protocolVersion: LIVE_PROTOCOL_VERSION,
    }),
    { mode: 0o600 },
  );
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const peerReady = new Promise<WebSocket>((resolve) =>
    server.once('connection', async (peer) => {
      await receive(peer);
      peer.send(
        JSON.stringify({
          type: 'host.welcome',
          protocolVersion: LIVE_PROTOCOL_VERSION,
          daemonInstanceNonce: 'abcdefghijklmnop',
          heartbeatIntervalMs: 10000,
          epoch: 3,
          status,
          ...(supports ? { permissionModeV1: { mode: 'ask' } } : {}),
        }),
      );
      resolve(peer);
    }),
  );
  const connection = new LiveDaemonConnection(
    '0.0.6',
    {
      getReadiness: () => ({
        permissions: {
          microphone: 'granted',
          camera: 'granted',
          accessibility: 'granted',
          screenRecording: 'granted',
        },
        selfChecks: {
          audioInput: true,
          audioOutput: true,
          appshot: true,
          globalShortcut: true,
        },
      }),
      onSnapshot: (snapshot) => {
        if (snapshot.phase === 'ready') ready();
      },
      onOutputAudio: () => {},
      onOutputAudioFinished: () => {},
      onClearOutput: () => {},
    },
    path,
  );
  cleanups.push(() => connection.stop());
  connection.start();
  const peer = await peerReady;
  await readiness;
  return { connection, peer };
}
const localized = (expression: RegExp) => (error: Error) =>
  expression.test(displayLiveMessage('en', error.message));

const nonce = 'abcdefghijklmnop';
const reply = (
  request: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  type: 'host.permission_mode_result',
  requestId: request['requestId'],
  epoch: 3,
  daemonInstanceNonce: nonce,
  ok: true,
  permissionModeV1: { mode: 'allow-all' },
  ...extra,
});
describe('Host permission mode protocol', () => {
  it('validates modes and complete request/result identities without coercion', () => {
    const valid = {
      type: 'host.state',
      epoch: 3,
      status,
      permissionModeV1: { mode: 'allow-all' },
    };
    assert.deepEqual(parseDaemonControlMessage(JSON.stringify(valid)), valid);
    for (const mode of [null, true, 1, 'always', 'allow_all', {}]) {
      assert.equal(
        parseDaemonControlMessage(
          JSON.stringify({ ...valid, permissionModeV1: { mode } }),
        ),
        undefined,
      );
      assert.throws(() =>
        encodeHostControlMessage({
          type: 'host.permission_mode_action',
          requestId: 'r',
          epoch: 3,
          daemonInstanceNonce: nonce,
          mode,
        } as never),
      );
    }
    const validResult = reply({ requestId: 'r' });
    assert.deepEqual(
      parseDaemonControlMessage(JSON.stringify(validResult)),
      validResult,
    );
    for (const patch of [
      { epoch: -1 },
      { epoch: undefined },
      { daemonInstanceNonce: '' },
      { requestId: '' },
      { permissionModeV1: undefined },
      { permissionModeV1: { mode: 'ALWAYS' } },
    ])
      assert.equal(
        parseDaemonControlMessage(JSON.stringify({ ...validResult, ...patch })),
        undefined,
      );
  });
  it('keeps ask selected until a matching successful save and prevents concurrent saves', async () => {
    const { connection, peer } = await fixture();
    const frame = receive(peer);
    const saved = connection.requestPermissionMode('allow-all');
    assert.equal(connection.getSnapshot().permissionModeV1?.mode, 'ask');
    await assert.rejects(
      connection.requestPermissionMode('ask'),
      localized(/still being saved/),
    );
    const request = await frame;
    assert.equal(request['type'], 'host.permission_mode_action');
    assert.equal(request['daemonInstanceNonce'], nonce);
    assert.equal(request['epoch'], 3);
    assert.equal(request['mode'], 'allow-all');
    peer.send(JSON.stringify(reply({ requestId: 'another-request' })));
    peer.send(JSON.stringify(reply(request)));
    assert.equal(await saved, 'allow-all');
    assert.equal(connection.getSnapshot().permissionModeV1?.mode, 'allow-all');
  });
  it('rejects wrong nonce, epoch or mode and retains the last confirmed value after save failure', async () => {
    for (const patch of [
      { daemonInstanceNonce: 'a-different-instance' },
      { epoch: 4 },
      { permissionModeV1: { mode: 'ask' } },
      {
        ok: false,
        error:
          'qwen-live-harness-ui:{"key":"permissionMode.saveFailed","params":{}}',
        permissionModeV1: { mode: 'ask' },
      },
    ]) {
      const { connection, peer } = await fixture();
      const frame = receive(peer);
      const saved = connection.requestPermissionMode('allow-all');
      const rejected = assert.rejects(saved);
      peer.send(JSON.stringify(reply(await frame, patch)));
      await rejected;
      assert.equal(connection.getSnapshot().permissionModeV1?.mode, 'ask');
    }
  });
  it('fences pending saves after an epoch change and rejects unsupported or disconnected connections', async () => {
    const legacy = await fixture(false);
    await assert.rejects(
      legacy.connection.requestPermissionMode('allow-all'),
      localized(/supports this setting/),
    );
    const { connection, peer } = await fixture();
    const frame = receive(peer);
    const saved = connection.requestPermissionMode('allow-all');
    const rejected = assert.rejects(
      saved,
      localized(/connection or call changed/i),
    );
    const request = await frame;
    peer.send(
      JSON.stringify({
        type: 'host.state',
        epoch: 4,
        status,
        permissionModeV1: { mode: 'ask' },
      }),
    );
    peer.send(JSON.stringify(reply(request)));
    await rejected;
    assert.equal(connection.getSnapshot().permissionModeV1?.mode, 'ask');
    const pending = connection.requestPermissionMode('allow-all');
    const disconnected = assert.rejects(
      pending,
      (error) =>
        displayLiveMessage('en', (error as Error).message) ===
        liveText('en', 'permissionMode.callChanged'),
    );
    peer.close();
    await disconnected;
  });
});
