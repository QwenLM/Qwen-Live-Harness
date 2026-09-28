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
      () => reject(new Error('Missing voice action')),
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
  const directory = await mkdtemp(join(tmpdir(), 'live-voice-host-'));
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
          ...(supports ? { voiceSettingsV1: voiceState('Tina') } : {}),
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

function voiceState(voice: string) {
  return {
    model: 'qwen3.8-omni-flash-realtime',
    voice,
    presets: ['Tina', 'Ryan'],
    custom: 'unverified',
    availability: 'supported',
    overridden: false,
  };
}
const nonce = 'abcdefghijklmnop';
const reply = (
  request: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  type: 'host.voice_result',
  requestId: request['requestId'],
  epoch: 3,
  daemonInstanceNonce: nonce,
  ok: true,
  voiceSettingsV1: voiceState('Ryan'),
  ...extra,
});
describe('Host voice protocol', () => {
  it('validates IDs and complete request/result identities without coercion', () => {
    const valid = {
      type: 'host.state',
      epoch: 3,
      status,
      voiceSettingsV1: voiceState('Ryan'),
    };
    assert.deepEqual(parseDaemonControlMessage(JSON.stringify(valid)), valid);
    for (const voice of [
      null,
      true,
      1,
      '',
      'bad\nvoice',
      'x'.repeat(257),
      {},
    ]) {
      assert.equal(
        parseDaemonControlMessage(
          JSON.stringify({
            ...valid,
            voiceSettingsV1: voiceState(voice as string),
          }),
        ),
        undefined,
      );
      assert.throws(() =>
        encodeHostControlMessage({
          type: 'host.voice_action',
          requestId: 'r',
          epoch: 3,
          daemonInstanceNonce: nonce,
          voice,
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
      { voiceSettingsV1: undefined },
      { voiceSettingsV1: voiceState('bad\nvoice') },
    ])
      assert.equal(
        parseDaemonControlMessage(JSON.stringify({ ...validResult, ...patch })),
        undefined,
      );
  });
  it('keeps Tina selected until a matching successful save and prevents concurrent saves', async () => {
    const { connection, peer } = await fixture();
    const frame = receive(peer);
    const saved = connection.requestVoice('Ryan');
    assert.equal(connection.getSnapshot().voiceSettingsV1?.voice, 'Tina');
    await assert.rejects(
      connection.requestVoice('Tina'),
      localized(/still being saved/),
    );
    const request = await frame;
    assert.equal(request['type'], 'host.voice_action');
    assert.equal(request['daemonInstanceNonce'], nonce);
    assert.equal(request['epoch'], 3);
    assert.equal(request['voice'], 'Ryan');
    peer.send(JSON.stringify(reply({ requestId: 'another-request' })));
    peer.send(JSON.stringify(reply(request)));
    assert.equal(await saved, 'Ryan');
    assert.equal(connection.getSnapshot().voiceSettingsV1?.voice, 'Ryan');
  });
  it('rejects wrong nonce, epoch or voice and retains the last confirmed value after save failure', async () => {
    for (const patch of [
      { daemonInstanceNonce: 'a-different-instance' },
      { epoch: 4 },
      { voiceSettingsV1: voiceState('Tina') },
      {
        ok: false,
        error: 'qwen-live-harness-ui:{"key":"voice.saveFailed","params":{}}',
        voiceSettingsV1: voiceState('Tina'),
      },
    ]) {
      const { connection, peer } = await fixture();
      const frame = receive(peer);
      const saved = connection.requestVoice('Ryan');
      const rejected = assert.rejects(saved);
      peer.send(JSON.stringify(reply(await frame, patch)));
      await rejected;
      assert.equal(connection.getSnapshot().voiceSettingsV1?.voice, 'Tina');
    }
  });
  it('fences pending saves after an epoch change and rejects unsupported or disconnected connections', async () => {
    const legacy = await fixture(false);
    await assert.rejects(
      legacy.connection.requestVoice('Ryan'),
      localized(/supports this setting/),
    );
    const { connection, peer } = await fixture();
    const frame = receive(peer);
    const saved = connection.requestVoice('Ryan');
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
        voiceSettingsV1: voiceState('Tina'),
      }),
    );
    peer.send(JSON.stringify(reply(request)));
    await rejected;
    assert.equal(connection.getSnapshot().voiceSettingsV1?.voice, 'Tina');
    const pending = connection.requestVoice('Ryan');
    const disconnected = assert.rejects(
      pending,
      (error) =>
        displayLiveMessage('en', (error as Error).message) ===
        liveText('en', 'voice.callChanged'),
    );
    peer.close();
    await disconnected;
  });
});
