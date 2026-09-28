/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeDashScopeServer } from './fake-dashscope-server.js';
import {
  FakeHost,
  spawnQwenLiveHarness,
  startLiveCall,
} from './qwen-live-harness.js';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function boot(override?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'live-voice-e2e-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'data'),
    discoveryDir = join(directory, 'discovery');
  await mkdir(dataDir);
  await mkdir(discoveryDir);
  const fakeDash = await startFakeDashScopeServer();
  cleanups.push(() => fakeDash.close());
  const options = {
    dataDir,
    discoveryDir,
    cwd: directory,
    realtimeEndpoint: fakeDash.url,
    model: 'qwen3.8-omni-flash-realtime',
    backends: '[]',
    ...(override ? { env: { QWEN_LIVE_HARNESS_VOICE: override } } : {}),
    initialConfig: { voice: 'Tina', retained: { value: 'user setting' } },
  };
  const live = await spawnQwenLiveHarness(options);
  cleanups.push(() => live.dispose());
  const host = new FakeHost(discoveryDir);
  await host.connect();
  cleanups.push(async () => host.close());
  return { directory, dataDir, discoveryDir, fakeDash, live, host, options };
}
function initialSettings(conn: { inbox: Array<Record<string, unknown>> }) {
  return conn.inbox.find((m) => m['type'] === 'session.update')?.['session'];
}
describe('voice settings through the shipped daemon', () => {
  it('saves during a call, applies on the next call and daemon restart, and preserves custom IDs', async () => {
    const r = await boot();
    expect(
      r.host.messages.find((m) => m['type'] === 'host.welcome')?.[
        'voiceSettingsV1'
      ],
    ).toMatchObject({ voice: 'Tina', model: r.options.model });
    const first = await startLiveCall(r);
    expect(initialSettings(first.conn)).toHaveProperty(
      'audio.output.voice',
      'Tina',
    );
    expect(await r.host.setVoice('Liora Mira')).toMatchObject({
      ok: true,
      voiceSettingsV1: { voice: 'Liora Mira' },
    });
    expect(initialSettings(first.conn)).toHaveProperty(
      'audio.output.voice',
      'Tina',
    );
    expect(
      first.conn.inbox.filter((m) => m['type'] === 'session.update'),
    ).toHaveLength(1);
    const config = JSON.parse(
      await readFile(join(r.dataDir, 'config.json'), 'utf8'),
    );
    expect(config).toMatchObject({
      voice: 'Liora Mira',
      retained: { value: 'user setting' },
    });
    r.host.action('stop');
    await r.host.waitForState((s) => s.status['state'] === 'idle', {
      fromIndex: r.host.states.length,
    });
    await startLiveCall(r);
    const second = r.fakeDash.connections.at(-1)!;
    expect(second).not.toBe(first.conn);
    expect(initialSettings(second)).toHaveProperty(
      'audio.output.voice',
      'Liora Mira',
    );
    expect(await r.host.setVoice('opaque-existing-voice')).toMatchObject({
      ok: true,
      voiceSettingsV1: { availability: 'unverified' },
    });
    const saved = JSON.parse(
      await readFile(join(r.dataDir, 'config.json'), 'utf8'),
    );
    r.host.close();
    await r.live.dispose();
    const restarted = await spawnQwenLiveHarness({
      ...r.options,
      initialConfig: saved,
    });
    cleanups.push(() => restarted.dispose());
    const host = new FakeHost(r.discoveryDir);
    await host.connect();
    cleanups.push(async () => host.close());
    await startLiveCall({ host, fakeDash: r.fakeDash });
    expect(initialSettings(r.fakeDash.connections.at(-1)!)).toHaveProperty(
      'audio.output.voice',
      'opaque-existing-voice',
    );
  });
  it('rejects incompatible voices, stale identities and environment overrides without changing the file', async () => {
    const r = await boot();
    const path = join(r.dataDir, 'config.json');
    const before = await readFile(path, 'utf8');
    expect(await r.host.setVoice('Ethan')).toMatchObject({ ok: false });
    expect(
      await r.host.setVoice('Ryan', { nonce: 'wrong-daemon' }),
    ).toMatchObject({ ok: false });
    expect(await readFile(path, 'utf8')).toBe(before);
    const overridden = await boot('Ryan');
    expect(
      overridden.host.messages.find((m) => m['type'] === 'host.welcome')?.[
        'voiceSettingsV1'
      ],
    ).toMatchObject({ voice: 'Ryan', overridden: true });
    expect(await overridden.host.setVoice('Tina')).toMatchObject({ ok: false });
    const call = await startLiveCall(overridden);
    expect(initialSettings(call.conn)).toHaveProperty(
      'audio.output.voice',
      'Ryan',
    );
  });
});
