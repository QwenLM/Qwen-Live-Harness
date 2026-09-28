import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { mkdtemp, rm, writeFile, symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VoiceSampleCapture } from '../../preload/voice-sample.ts';
import { readVoiceAudioFile } from '../voice-audio-file.ts';
import { voiceSampleSeconds } from 'qwen-live-harness/voice-sample';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
function global(name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  cleanup.push(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  });
}
it('cancels a pending microphone request without leaving any live tracks', async () => {
  for (const cancel of ['clear', 'stopRecording'] as const) {
    let resolve!: (stream: unknown) => void;
    let stopped = 0;
    global('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
    });
    const capture = new VoiceSampleCapture();
    const recording = capture.record();
    const rejected = assert.rejects(recording, { name: 'AbortError' });
    capture[cancel]();
    resolve({
      getTracks: () => [
        {
          stop: () => {
            stopped++;
          },
        },
      ],
    });
    await rejected;
    assert.equal(stopped, 1);
    assert.throws(() => capture.bytes());
  }
});
it('normalizes decoded samples to bounded mono PCM WAV, and drops them on discard', async () => {
  let closed = 0;
  global(
    'AudioContext',
    class {
      async decodeAudioData() {
        return { duration: 4 };
      }
      async close() {
        closed++;
      }
    },
  );
  global(
    'OfflineAudioContext',
    class {
      destination = {};
      constructor(channels: number, frames: number, rate: number) {
        assert.equal(channels, 1);
        assert.equal(frames, 96000);
        assert.equal(rate, 24000);
      }
      createBufferSource() {
        return { connect() {}, start() {} };
      }
      async startRendering() {
        return { getChannelData: () => new Float32Array(96000).fill(0.2) };
      }
    },
  );
  const capture = new VoiceSampleCapture();
  cleanup.push(() => capture.clear());
  const sample = await capture.select(async () => ({
    name: 'sample.mp3',
    data: new Uint8Array([1]),
  }));
  assert.equal(sample?.seconds, 4);
  assert.match(sample!.previewUrl, /^blob:/);
  assert.equal(voiceSampleSeconds(capture.bytes()), 4);
  assert.equal(closed, 1);
  capture.clear();
  assert.throws(() => capture.bytes());
});
it('ignores a file selection completed after cancellation', async () => {
  let finish!: (value: { name: string; data: Uint8Array }) => void;
  const capture = new VoiceSampleCapture();
  const selecting = capture.select(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const rejected = assert.rejects(selecting, { name: 'AbortError' });
  capture.clear();
  finish({ name: 'sample.wav', data: new Uint8Array([1]) });
  await rejected;
  assert.throws(() => capture.bytes());
});
it('only reads a bounded regular audio file and returns its basename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-audio-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'sample.WAV');
  await writeFile(path, 'sample');
  assert.deepEqual(await readVoiceAudioFile(path), {
    name: 'sample.WAV',
    data: Buffer.from('sample'),
  });
  const link = join(dir, 'link.wav');
  await symlink(path, link);
  await assert.rejects(readVoiceAudioFile(link));
  await truncate(path, 10 * 1024 * 1024 + 1);
  await assert.rejects(readVoiceAudioFile(path));
  await assert.rejects(readVoiceAudioFile(join(dir, 'secret.txt')));
});

it('stops microphone tracks and clips timer overshoot to the 60 second sample limit', async () => {
  let stopped = 0;
  global('navigator', {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [
          {
            stop: () => {
              stopped++;
            },
          },
        ],
      }),
    },
  });
  global(
    'MediaRecorder',
    class {
      state = 'inactive';
      mimeType = 'audio/webm';
      ondataavailable?: (event: { data: Blob }) => void;
      onstop?: () => void;
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['recorded']) });
        this.onstop?.();
      }
    },
  );
  global(
    'AudioContext',
    class {
      async decodeAudioData() {
        return { duration: 60.04 };
      }
      async close() {}
    },
  );
  global(
    'OfflineAudioContext',
    class {
      destination = {};
      constructor(channels: number, frames: number, rate: number) {
        assert.equal(channels, 1);
        assert.equal(frames, 1440000);
        assert.equal(rate, 24000);
      }
      createBufferSource() {
        return { connect() {}, start() {} };
      }
      async startRendering() {
        return { getChannelData: () => new Float32Array(1440000) };
      }
    },
  );
  const capture = new VoiceSampleCapture();
  cleanup.push(() => capture.clear());
  const recording = capture.record();
  await new Promise<void>((resolve) => setImmediate(resolve));
  capture.stopRecording();
  assert.equal((await recording).seconds, 60);
  assert.equal(voiceSampleSeconds(capture.bytes()), 60);
  assert(stopped >= 1);
});
