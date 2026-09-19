/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startFakeDashScopeServer } from './fake-dashscope-server.js';
import {
  FakeHost,
  spawnQwenLiveHarness,
  startLiveCall,
} from './qwen-live-harness.js';

it('requests 24 kHz PCM and forwards it unchanged to the Host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-live-output-audio-'));
  const dataDir = join(directory, 'data');
  const discoveryDir = join(directory, 'discovery');
  await mkdir(dataDir);
  await mkdir(discoveryDir);
  const fakeDash = await startFakeDashScopeServer();
  const live = await spawnQwenLiveHarness({
    dataDir,
    discoveryDir,
    cwd: directory,
    realtimeEndpoint: fakeDash.url,
    initialConfig: {
      backends: [],
      memory: { enabled: false },
      proactive: { enabled: false },
    },
  });
  const host = new FakeHost(discoveryDir);
  try {
    await host.connect();
    const welcome = host.messages.find(
      (message) => message['type'] === 'host.welcome',
    );
    expect(welcome?.['capabilities']).toEqual({
      outputAudioEndMarkerV1: true,
    });
    const { conn, epoch } = await startLiveCall({ host, fakeDash });
    const sampleRate = 24_000;
    const update = fakeDash.inbox.find(
      (message) => message['type'] === 'session.update',
    );
    expect(update).toMatchObject({
      session: {
        audio: {
          input: { format: { type: 'pcm', sample_rate: 16_000 } },
          output: { format: { type: 'pcm', sample_rate: sampleRate } },
        },
      },
    });
    const input = Buffer.alloc(3200, 1);
    const fromIndex = fakeDash.inbox.length;
    host.sendAudio(epoch, input);
    const append = await fakeDash.waitForMessage(
      (message) => message['type'] === 'input_audio_buffer.append',
      { fromIndex },
    );
    expect(Buffer.from(String(append['audio']), 'base64')).toEqual(input);
    const output = Buffer.alloc(sampleRate / 5, 2); // 100 ms PCM16 mono
    conn.respondWithAudio(output);
    expect(await host.waitForAudioFrame()).toEqual(output);
  } finally {
    host.close();
    await live.dispose();
    await fakeDash.close();
    await rm(directory, { recursive: true, force: true });
  }
});
