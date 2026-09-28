/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeDashScopeServer } from './fake-dashscope-server.js';
import {
  FakeHost,
  readLiveDiscovery,
  spawnQwenLiveHarness,
  startLiveCall,
} from './qwen-live-harness.js';
import { encodeVoiceSample } from '../packages/qwen-live-harness/src/voice-sample.js';
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function boot(failSave = false, waitForRelease?: Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'live-clone-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'data'),
    discoveryDir = join(dir, 'discovery');
  await mkdir(dataDir);
  await mkdir(discoveryDir);
  const requests: Record<string, unknown>[] = [];
  const fakeDash = await startFakeDashScopeServer({
    httpHandler: (req, res) => {
      void (async () => {
        expect(req.url).toBe('/api/v1/services/audio/tts/customization');
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (waitForRelease) await waitForRelease;
        if (failSave)
          await writeFile(join(dataDir, 'config.json'), '{broken-user-edit');
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            output: {
              voice: 'qwen-created-fixture',
              target_model: 'qwen3.8-omni-flash-realtime',
            },
          }),
        );
      })().catch(() => res.writeHead(500).end());
    },
  });
  cleanups.push(() => fakeDash.close());
  const live = await spawnQwenLiveHarness({
    dataDir,
    discoveryDir,
    cwd: dir,
    realtimeEndpoint: fakeDash.url,
    model: 'qwen3.8-omni-flash-realtime',
    backends: '[]',
    initialConfig: { voice: 'Tina', retained: true },
  });
  cleanups.push(() => live.dispose());
  const host = new FakeHost(discoveryDir);
  await host.connect();
  cleanups.push(() => host.close());
  const record = await readLiveDiscovery(discoveryDir);
  const audio = Buffer.from(
    encodeVoiceSample(new Float32Array(72_000).fill(0.1)),
  ).toString('base64');
  const clone = async (
    id: string,
    override: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${record.url}/live/voice-clone`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${record.token}`,
        'x-qwen-live-harness-nonce': record.instanceNonce,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        requestId: id.repeat(32),
        epoch: host.states.at(-1)?.epoch ?? 0,
        audio,
        ...override,
      }),
    });
    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : undefined,
    };
  };
  return { dataDir, host, fakeDash, requests, clone };
}
describe('voice cloning through the shipped daemon', () => {
  it('creates once, persists/selects the returned ID and applies it to the next call', async () => {
    const r = await boot();
    const result = await r.clone('a');
    expect(result.body).toEqual({ ok: true, voice: 'qwen-created-fixture' });
    expect((await r.clone('a')).body).toEqual(result.body);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]).toMatchObject({
      model: 'qwen-voice-enrollment',
      input: { target_model: 'qwen3.8-omni-flash-realtime', action: 'create' },
    });
    expect(
      JSON.parse(await readFile(join(r.dataDir, 'config.json'), 'utf8')),
    ).toMatchObject({ voice: 'qwen-created-fixture', retained: true });
    const call = await startLiveCall(r);
    expect(
      call.conn.inbox.find((m) => m['type'] === 'session.update')?.['session'],
    ).toHaveProperty('audio.output.voice', 'qwen-created-fixture');
    expect((await r.clone('b')).body).toMatchObject({ ok: false });
    expect(r.requests).toHaveLength(1);
  });
  it('blocks new calls while uploading and retains the created ID if the Host disconnects', async () => {
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = await boot(false, delayed);
    const creating = r.clone('a');
    try {
      await expect.poll(() => r.requests.length).toBe(1);
      r.host.action('toggle');
      await expect
        .poll(() => r.host.states.some((s) => s.status['state'] === 'error'))
        .toBe(true);
      expect(r.fakeDash.connections).toHaveLength(0);
      await r.host.close();
      release();
      expect((await creating).body).toMatchObject({
        ok: false,
        createdVoice: 'qwen-created-fixture',
      });
      expect(
        JSON.parse(await readFile(join(r.dataDir, 'config.json'), 'utf8'))
          .voice,
      ).toBe('Tina');
    } finally {
      release();
      await creating;
    }
  });
  it('rejects missing identity, browser origins, stale calls and invalid audio before contacting the provider', async () => {
    const r = await boot();
    expect(
      (await r.clone('a', {}, { authorization: 'Bearer wrong' })).status,
    ).toBe(401);
    expect(
      (await r.clone('b', {}, { 'x-qwen-live-harness-nonce': 'wrong' })).status,
    ).toBe(409);
    expect(
      (await r.clone('c', {}, { origin: 'https://example.com' })).status,
    ).toBe(401);
    expect((await r.clone('d', { epoch: 999 })).body).toMatchObject({
      ok: false,
    });
    expect((await r.clone('e', { audio: 'bad-data' })).status).toBe(400);
    expect(r.requests).toHaveLength(0);
  });
  it('returns the created ID for recovery when a config edit prevents saving; retry does not create another voice', async () => {
    const r = await boot(true);
    const result = await r.clone('a');
    expect(result.body).toMatchObject({
      ok: false,
      createdVoice: 'qwen-created-fixture',
    });
    expect(await readFile(join(r.dataDir, 'config.json'), 'utf8')).toBe(
      '{broken-user-edit',
    );
    expect((await r.clone('a')).body).toEqual(result.body);
    expect(r.requests).toHaveLength(1);
  });
});
