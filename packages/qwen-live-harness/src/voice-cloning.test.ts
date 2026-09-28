/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createClonedVoice,
  voiceEnrollmentUrl,
  VoiceCloneRequests,
} from './voice-cloning.js';
import {
  encodeVoiceSample,
  voiceSampleSeconds,
  parseVoiceCloneOutcome,
  type VoiceCloneOutcome,
} from './voice-sample.js';
const audio = () => encodeVoiceSample(new Float32Array(72_000).fill(0.1));
const options = () => ({
  endpoint: 'wss://speech.example/api-ws/v1/realtime?model=old',
  apiKey: 'fixture-secret',
  model: 'qwen3.8-omni-flash-realtime',
  audio: audio(),
});

describe('voice creation', () => {
  it('keeps credentials on the configured secure origin and uploads canonical audio once', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        output: { voice: 'qwen-created', target_model: options().model },
      }),
    );
    expect(await createClonedVoice(options(), request)).toEqual({
      voice: 'qwen-created',
    });
    expect(request).toHaveBeenCalledOnce();
    const [url, settings] = request.mock.calls[0]!;
    expect(url).toBe(
      'https://speech.example/api/v1/services/audio/tts/customization',
    );
    expect(settings?.redirect).toBe('error');
    const body = JSON.parse(String(settings?.body));
    expect(body.input.target_model).toBe(options().model);
    expect(body.input.preferred_name).toMatch(/^[a-z0-9_]{1,16}$/);
    expect(body.input.audio.data).toBe(
      `data:audio/wav;base64,${Buffer.from(audio()).toString('base64')}`,
    );
    expect(
      voiceEnrollmentUrl('https://speech.example/api-ws/v1/realtime'),
    ).toMatch(/^https:/);
    expect(voiceEnrollmentUrl('http://127.0.0.1:1234/realtime')).toBe(
      'http://127.0.0.1:1234/api/v1/services/audio/tts/customization',
    );
    for (const endpoint of [
      'http://speech.example',
      'wss://user:pass@speech.example',
      'file:///tmp/audio',
    ])
      expect(() => voiceEnrollmentUrl(endpoint)).toThrow();
  });
  it('rejects malformed, too short and incorrectly described WAV before networking', async () => {
    const badHeader = audio();
    badHeader[22] = 2;
    for (const bytes of [
      new Uint8Array(),
      encodeVoiceSample(new Float32Array(24_000)),
      badHeader,
    ]) {
      const request = vi.fn<typeof fetch>();
      await expect(
        createClonedVoice({ ...options(), audio: bytes }, request),
      ).rejects.toThrow(/voice.sampleInvalid/);
      expect(request).not.toHaveBeenCalled();
    }
    expect(voiceSampleSeconds(audio())).toBe(3);
    expect(
      voiceSampleSeconds(encodeVoiceSample(new Float32Array(24_000 * 61))),
    ).toBeUndefined();
  });
  it('reports ambiguous transport outcomes without retrying or leaking service content', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('fixture-secret provider trace'));
    await expect(createClonedVoice(options(), request)).rejects.toThrow(
      /voice.cloneUncertain/,
    );
    expect(request).toHaveBeenCalledOnce();
    const wrongModel = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        output: { voice: 'valid', target_model: 'different-model' },
      }),
    );
    await expect(createClonedVoice(options(), wrongModel)).rejects.toThrow(
      /voice.cloneUncertain/,
    );
  });
  it.each([
    [403, {}, 'voice.cloneAccess'],
    [
      400,
      { code: 'InvalidParameter', message: 'target_model is not supported' },
      'voice.cloneUnsupported',
    ],
    [
      400,
      { code: 'Audio.PreprocessError', message: 'fixture-secret' },
      'voice.cloneAudioRejected',
    ],
    [500, { message: 'fixture-secret' }, 'voice.cloneFailed'],
  ])(
    'maps provider failure %s to a safe user message',
    async (status, body, expected) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(body, { status: status as number }));
      await expect(createClonedVoice(options(), request)).rejects.toThrow(
        expected as string,
      );
    },
  );
  it('reports degraded creation quality and validates recovery IDs', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ output: { voice: 'custom', fallback_mode: true } }),
      );
    expect(await createClonedVoice(options(), request)).toMatchObject({
      voice: 'custom',
      warning: expect.stringContaining('voice.cloneQuality'),
    });
    expect(
      parseVoiceCloneOutcome({
        ok: false,
        error: 'save failed',
        createdVoice: 'recoverable',
      }),
    ).toMatchObject({ createdVoice: 'recoverable' });
    expect(parseVoiceCloneOutcome({ ok: true, voice: '\n' })).toBeUndefined();
  });
  it('coalesces duplicate requests, fences ID reuse and never repeats a completed mutation', async () => {
    const requests = new VoiceCloneRequests();
    let finish!: (result: VoiceCloneOutcome) => void;
    const action = vi.fn(
      () =>
        new Promise<VoiceCloneOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const first = requests.run('one', 'epoch:model', audio(), action);
    const duplicate = requests.run('one', 'epoch:model', audio(), action);
    await Promise.resolve();
    expect(requests.busy).toBe(true);
    expect(
      await requests.run('other', 'epoch:model', audio(), action),
    ).toMatchObject({ ok: false });
    expect(
      await requests.run('one', 'another:model', audio(), action),
    ).toMatchObject({ ok: false });
    finish({ ok: true, voice: 'new-voice' });
    expect(await first).toEqual(await duplicate);
    expect(await requests.run('one', 'epoch:model', audio(), action)).toEqual({
      ok: true,
      voice: 'new-voice',
    });
    expect(action).toHaveBeenCalledOnce();
    expect(requests.busy).toBe(false);
  });
});
