import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import ts from 'typescript';
import type { HostAudioEngine } from '../../preload/audio-engine.ts';
import { HostAudioLifecycle } from '../../preload/audio-lifecycle.ts';
import * as audioOperation from '../../preload/audio-operation.ts';
import * as inputPolicy from '../../preload/audio-input-policy.ts';
import * as outputQueue from '../../preload/audio-output-queue.ts';
import * as outputResampler from '../../preload/audio-output-resampler.ts';

const engineSource = ts.transpileModule(
  readFileSync(
    new URL('../../preload/audio-engine.ts', import.meta.url),
    'utf8',
  ),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;

function fixture(contextSampleRate = 48_000) {
  class Track extends EventTarget {
    enabled = true;
    stopped = false;
    getSettings() {
      return { sampleRate: 48_000, channelCount: 1 };
    }
    stop() {
      this.stopped = true;
      this.dispatchEvent(new Event('ended'));
    }
  }
  class Stream {
    readonly track = new Track();
    getTracks() {
      return [this.track];
    }
    getAudioTracks() {
      return this.getTracks();
    }
  }
  class Node {
    connected: unknown;
    disconnects = 0;
    connect(target: unknown) {
      this.connected = target;
    }
    disconnect() {
      this.disconnects++;
    }
  }
  class BufferSource extends Node {
    buffer: AudioBuffer | undefined;
    onended?: () => void;
    startedAt?: number;
    stopped = false;
    start(at: number) {
      this.startedAt = at;
    }
    stop() {
      this.stopped = true;
      this.onended?.();
    }
  }
  const contexts: Context[] = [];
  const worklets: Worklet[] = [];
  const streams: Stream[] = [];
  const constraints: MediaStreamConstraints[] = [];
  const ipc: Array<{ channel: string; value: unknown }> = [];
  const levels: number[] = [];
  const diagnostics: Array<{
    event: string;
    details: Readonly<Record<string, string | number | boolean | undefined>>;
  }> = [];
  const started: Array<{ epoch: number; outputId: number }> = [];
  const completed: Array<{ epoch: number; outputId: number }> = [];
  const controls: {
    addModule?: () => Promise<void>;
    resume?: (context: Context) => Promise<void>;
    close?: (context: Context) => Promise<void>;
  } = {};
  class Context {
    state = 'suspended';
    readonly sampleRate = contextSampleRate;
    readonly destination = {};
    currentTime = 0;
    readonly buffers: Array<{
      channels: number;
      length: number;
      rate: number;
      data: Float32Array;
    }> = [];
    readonly sources: BufferSource[] = [];
    readonly audioWorklet = {
      addModule: async () => await controls.addModule?.(),
    };
    readonly virtualStreams: Stream[] = [];
    closeCalls = 0;
    constructor(readonly options: AudioContextOptions) {
      contexts.push(this);
    }
    async resume() {
      if (controls.resume) await controls.resume(this);
      this.state = 'running';
    }
    async close() {
      this.closeCalls += 1;
      if (controls.close) await controls.close(this);
      this.state = 'closed';
    }
    createBuffer(channels: number, length: number, rate: number) {
      const data = new Float32Array(length);
      this.buffers.push({ channels, length, rate, data });
      return { duration: length / rate, getChannelData: () => data };
    }
    createBufferSource() {
      const source = new BufferSource();
      this.sources.push(source);
      return source;
    }
    createMediaStreamSource() {
      return new Node();
    }
    createMediaStreamDestination() {
      const stream = new Stream();
      this.virtualStreams.push(stream);
      return { stream, channelCount: 2 };
    }
  }
  class Worklet extends Node {
    readonly port: {
      onmessage?: (event: {
        data: { level: number; pcm16: ArrayBuffer };
      }) => void;
    } = {};
    constructor() {
      super();
      worklets.push(this);
    }
    frame(level = 0.5) {
      this.port.onmessage?.({
        data: { level, pcm16: new ArrayBuffer(320) },
      });
    }
  }
  const mediaDevices = Object.assign(new EventTarget(), {
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Microphone' },
    ],
    getUserMedia: async (value: MediaStreamConstraints) => {
      constraints.push(value);
      const stream = new Stream();
      streams.push(stream);
      return stream;
    },
  });
  const storage = new Map<string, string>();
  const exports: { HostAudioEngine?: typeof HostAudioEngine } = {};
  const modules: Record<string, unknown> = {
    electron: {
      ipcRenderer: {
        send: (channel: string, value: unknown) => ipc.push({ channel, value }),
      },
    },
    'qwen-live-harness/i18n': { liveMessage: (key: string) => key },
    './audio-lifecycle.ts': { HostAudioLifecycle },
    './audio-operation.ts': audioOperation,
    './audio-input-policy.ts': inputPolicy,
    './audio-output-queue.ts': outputQueue,
    './audio-output-resampler.ts': outputResampler,
  };
  runInNewContext(engineSource, {
    exports,
    require: (name: string) => {
      assert(Object.hasOwn(modules, name), `Unexpected import: ${name}`);
      return modules[name];
    },
    AudioContext: Context,
    AudioWorkletNode: Worklet,
    navigator: { mediaDevices },
    window: { location: { href: 'file:///synthetic/preload/index.js' } },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    URL,
    DOMException,
    DataView,
    Uint8Array,
  });
  assert(exports.HostAudioEngine);
  const engine = new exports.HostAudioEngine(
    (level) => levels.push(level),
    (event, details) => diagnostics.push({ event, details }),
    (identity) => started.push(identity),
    (identity) => completed.push(identity),
  );
  return {
    engine,
    contexts,
    worklets,
    streams,
    constraints,
    mediaDevices,
    ipc,
    levels,
    diagnostics,
    started,
    completed,
    controls,
    Stream,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushAudioPromises(): Promise<void> {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

describe('Qwen Live Harness Host audio engine', () => {
  it('checks readiness without opening microphone or output devices', async () => {
    const h = fixture();
    try {
      await h.engine.initialize(true);
      assert.equal(h.constraints.length, 0);
      assert.equal(h.contexts.length, 0);
      const result = h.ipc.findLast(
        (entry) => entry.channel === 'live:audio:self-check',
      )?.value;
      assert.deepEqual(JSON.parse(JSON.stringify(result)), {
        audioInput: true,
        audioOutput: true,
      });
    } finally {
      await h.engine.dispose();
    }
  });

  for (const rate of [44_100, 48_000, 96_000]) {
    it(`preserves 24 kHz PCM timing on a ${rate} Hz output clock`, async () => {
      const h = fixture(rate);
      try {
        await h.engine.initialize(true);
        h.engine.setOutputEndMarkerMode(true);
        const identity = { epoch: 1, outputId: 1 };
        const frame = new Uint8Array(4800);
        new DataView(frame.buffer).setInt16(0, 16384, true);
        await h.engine.play(frame, identity);
        await h.engine.play(frame, identity);
        await h.engine.finishOutputAudio(identity);
        assert.equal(h.contexts.length, 1);
        const context = h.contexts[0];
        assert.equal(Object.hasOwn(context.options, 'sampleRate'), false);
        assert.equal(context.sampleRate, rate);
        assert.equal(context.buffers.length, 3);
        assert.ok(context.buffers.every((buffer) => buffer.rate === rate));
        assert.equal(
          context.buffers.reduce((length, buffer) => length + buffer.length, 0),
          rate / 5,
        );
        assert.equal(context.sources[0].connected, context.destination);
        assert.equal(context.sources[0].startedAt, 0.01);
        for (let index = 1; index < context.sources.length; index += 1) {
          assert.equal(
            context.sources[index].startedAt,
            Math.round(
              context.sources[index - 1].startedAt! * rate +
                context.buffers[index - 1].length,
            ) / rate,
          );
        }
        assert.equal(h.started.length, 1);
        assert.equal(h.completed.length, 0);
        context.sources[0].onended?.();
        assert.equal(h.completed.length, 0);
        context.sources[1].onended?.();
        assert.equal(h.completed.length, 0);
        context.sources[2].onended?.();
        assert.equal(h.completed.length, 1);
        assert.equal(h.completed[0].outputId, identity.outputId);
        const diagnostic = h.diagnostics.find(
          (entry) => entry.event === 'output_context_ready',
        );
        assert.equal(diagnostic?.details.sourceSampleRate, 24_000);
        assert.equal(diagnostic?.details.contextSampleRate, rate);
        assert.equal(diagnostic?.details.resampling, true);
        assert.equal(
          h.diagnostics.filter(
            (entry) => entry.event === 'output_context_ready',
          ).length,
          1,
        );
      } finally {
        await h.engine.dispose();
      }
    });
  }

  it('flushes a tiny output once and rejects late PCM and duplicate markers', async () => {
    const h = fixture();
    try {
      await h.engine.initialize(false);
      h.engine.setOutputEndMarkerMode(true);
      const identity = { epoch: 2, outputId: 10 };
      const bytes = new Uint8Array([0xff, 0, 64, 0xff]);
      await h.engine.play(bytes.subarray(1, 3), identity);
      const context = h.contexts[0];
      assert.equal(context.sources.length, 0);
      assert.equal(h.started.length, 1);
      assert.equal(h.completed.length, 0);
      await h.engine.finishOutputAudio(identity);
      assert.equal(context.sources.length, 1);
      assert.deepEqual(Array.from(context.buffers[0].data), [0.5, 0.5]);
      await h.engine.finishOutputAudio(identity);
      await h.engine.play(bytes.subarray(1, 3), identity);
      assert.equal(context.sources.length, 1);
      assert.equal(h.completed.length, 0);
      context.sources[0].onended?.();
      assert.equal(h.completed.length, 1);
      await h.engine.finishOutputAudio(identity);
      await h.engine.play(bytes.subarray(1, 3), identity);
      assert.equal(context.sources.length, 1);
      assert.equal(h.completed.length, 1);
    } finally {
      await h.engine.dispose();
    }
  });

  it('waits for a late marker and its retained tail after the sources drain', async () => {
    const h = fixture(16_000);
    try {
      await h.engine.initialize(false);
      h.engine.setOutputEndMarkerMode(true);
      const identity = { epoch: 3, outputId: 1 };
      await h.engine.play(new Uint8Array(960), identity);
      const context = h.contexts[0];
      context.sources[0].onended?.();
      assert.equal(h.completed.length, 0);
      await h.engine.finishOutputAudio(identity);
      assert.equal(context.sources.length, 2);
      assert.equal(h.completed.length, 0);
      assert.equal(
        context.buffers.reduce((length, buffer) => length + buffer.length, 0),
        320,
      );
      context.sources[1].onended?.();
      assert.equal(h.completed.length, 1);
    } finally {
      await h.engine.dispose();
    }
  });

  it('completes sub-device-sample PCM at its marker without leaving a pending output', async () => {
    const h = fixture(8_000);
    try {
      await h.engine.initialize(false);
      h.engine.setOutputEndMarkerMode(true);
      const identity = { epoch: 3, outputId: 2 };
      await h.engine.play(new Uint8Array([0, 0]), identity);
      assert.equal(h.contexts[0].sources.length, 0);
      await h.engine.finishOutputAudio(identity);
      assert.equal(h.contexts[0].sources.length, 0);
      assert.equal(h.started.length, 1);
      assert.equal(h.completed.length, 1);
    } finally {
      await h.engine.dispose();
    }
  });

  it('clears playback and retained state if scheduling the terminal tail fails', async () => {
    const h = fixture();
    try {
      await h.engine.initialize(false);
      h.engine.setOutputEndMarkerMode(true);
      const identity = { epoch: 3, outputId: 3 };
      await h.engine.play(new Uint8Array([0, 64]), identity);
      const context = h.contexts[0];
      context.createBuffer = () => {
        throw new Error('synthetic-buffer-failure');
      };
      await assert.rejects(
        h.engine.finishOutputAudio(identity),
        /synthetic-buffer-failure/,
      );
      assert.equal(context.state, 'closed');
      assert.equal(h.completed.length, 0);
      await h.engine.play(new Uint8Array([0, 0]), identity);
      await h.engine.finishOutputAudio(identity);
      assert.deepEqual(Array.from(h.contexts[1].buffers[0].data), [0, 0]);
      h.contexts[1].sources[0].onended?.();
      assert.equal(h.completed.length, 1);
    } finally {
      await h.engine.dispose();
    }
  });

  it('isolates retained audio by both epoch and output identity', async () => {
    const h = fixture();
    try {
      await h.engine.initialize(false);
      h.engine.setOutputEndMarkerMode(true);
      const first = { epoch: 3, outputId: 1 };
      const second = { epoch: 3, outputId: 2 };
      const nextEpoch = { epoch: 4, outputId: 1 };
      await h.engine.play(new Uint8Array([0, 64]), first);
      await h.engine.play(new Uint8Array([0, 224]), second);
      await h.engine.play(new Uint8Array([0, 0]), nextEpoch);
      const context = h.contexts[0];
      assert.equal(context.sources.length, 0);
      await h.engine.finishOutputAudio(second);
      await h.engine.finishOutputAudio(first);
      await h.engine.finishOutputAudio(nextEpoch);
      assert.deepEqual(
        context.buffers.map((buffer) => Array.from(buffer.data)),
        [
          [-0.25, -0.25],
          [0.5, 0.5],
          [0, 0],
        ],
      );
      for (const source of context.sources) source.onended?.();
      assert.deepEqual(JSON.parse(JSON.stringify(h.completed)), [
        second,
        first,
        nextEpoch,
      ]);
    } finally {
      await h.engine.dispose();
    }
  });

  it('discards retained audio and pending finish operations when muted', async () => {
    const h = fixture();
    try {
      await h.engine.initialize(false);
      h.engine.setOutputEndMarkerMode(true);
      const identity = { epoch: 5, outputId: 1 };
      await h.engine.play(new Uint8Array([0, 64]), identity);
      const staleContext = h.contexts[0];
      const staleFinish = h.engine.finishOutputAudio(identity);
      h.engine.setOutputMuted(true);
      await staleFinish;
      assert.equal(staleContext.sources.length, 0);
      assert.equal(staleContext.state, 'closed');
      assert.equal(h.completed.length, 0);
      h.engine.setOutputMuted(false);
      await h.engine.play(new Uint8Array([0, 0]), identity);
      await h.engine.finishOutputAudio(identity);
      assert.deepEqual(Array.from(h.contexts[1].buffers[0].data), [0, 0]);
      h.contexts[1].sources[0].onended?.();
      assert.equal(h.completed.length, 1);
    } finally {
      await h.engine.dispose();
    }
  });

  it('preserves the legacy no-marker drain without retaining any samples', async () => {
    const h = fixture(44_100);
    try {
      await h.engine.initialize(false);
      const identity = { epoch: 6, outputId: 1 };
      await h.engine.play(new Uint8Array([0, 64]), identity);
      const context = h.contexts[0];
      assert.equal(context.buffers.length, 1);
      assert.equal(context.buffers[0].rate, 24_000);
      assert.deepEqual(Array.from(context.buffers[0].data), [0.5]);
      context.sources[0].onended?.();
      assert.equal(h.completed.length, 1);
      await h.engine.finishOutputAudio(identity);
      assert.equal(context.buffers.length, 1);
    } finally {
      await h.engine.dispose();
    }
  });

  it('clears the new tail state when a mode switch interrupts playback', async () => {
    const h = fixture();
    try {
      await h.engine.initialize(false);
      h.engine.setOutputEndMarkerMode(true);
      const identity = { epoch: 7, outputId: 1 };
      await h.engine.play(new Uint8Array(960), identity);
      const context = h.contexts[0];
      h.engine.setOutputEndMarkerMode(false);
      assert.equal(context.sources[0].stopped, true);
      assert.equal(h.completed.length, 0);
      await h.engine.finishOutputAudio(identity);
      assert.equal(context.buffers.length, 1);
      await h.engine.play(new Uint8Array([0, 0]), identity);
      assert.equal(h.contexts[1].buffers[0].rate, 24_000);
      h.contexts[1].sources[0].onended?.();
      assert.equal(h.completed.length, 1);
    } finally {
      await h.engine.dispose();
    }
  });

  it('does not acquire a microphone when capture starts muted', async () => {
    const h = fixture();
    try {
      await h.engine.initialize(true);
      await h.engine.setCapture(true, true, 1);
      assert.equal(h.constraints.length, 0);
      assert.equal(h.contexts.length, 0);
      assert.equal(h.levels.at(-1), 0);
      const ready = h.diagnostics.findLast(
        (entry) => entry.event === 'capture_ready',
      );
      assert.equal(ready?.details.epoch, 1);
      assert.equal(ready?.details.muted, true);
      assert.equal(ready?.details.capturing, false);
    } finally {
      await h.engine.dispose();
    }
  });

  it('releases muted capture and rebuilds it on unmute without clearing playback', async () => {
    const h = fixture();
    try {
      await h.engine.initialize(true);
      await h.engine.setCapture(true, false, 1);
      await h.engine.play(new Uint8Array(4800), { epoch: 1, outputId: 1 });
      const captureContext = h.contexts[0];
      const outputContext = h.contexts[1];
      await h.engine.setCapture(true, true, 1);
      assert.equal(h.streams[0].track.stopped, true);
      assert.equal(captureContext.virtualStreams[0].track.stopped, true);
      assert.equal(captureContext.state, 'closed');
      assert.equal(outputContext.state, 'running');
      assert.equal(outputContext.sources[0].stopped, false);
      assert.equal(h.levels.at(-1), 0);
      await h.engine.setCapture(true, false, 1);
      assert.equal(h.streams.length, 2);
      assert.equal(h.streams[1].track.stopped, false);
      assert.equal(h.contexts.length, 3);
      h.worklets[1].frame();
      assert.equal(
        h.ipc.filter((entry) => entry.channel === 'live:audio:input').length,
        1,
      );
      const ready = h.diagnostics.findLast(
        (entry) => entry.event === 'capture_ready',
      );
      assert.equal(ready?.details.capturing, true);
      assert.equal(ready?.details.contextSampleRate, 48_000);
      assert.equal(ready?.details.inputSampleRate, 48_000);
      assert.doesNotMatch(JSON.stringify(h.diagnostics), /mic-1|Microphone/);
    } finally {
      await h.engine.dispose();
    }
  });

  it('ignores stale worklet messages after a same-epoch mute and unmute', async () => {
    const h = fixture();
    try {
      await h.engine.initialize(true);
      await h.engine.setCapture(true, false, 1);
      const oldWorklet = h.worklets[0];
      await h.engine.setCapture(true, true, 1);
      const mutedLevelCount = h.levels.length;
      oldWorklet.frame(0.9);
      assert.equal(h.levels.length, mutedLevelCount);
      assert.equal(
        h.ipc.filter((entry) => entry.channel === 'live:audio:input').length,
        0,
      );
      await h.engine.setCapture(true, false, 1);
      const levelCount = h.levels.length;
      const inputCount = h.ipc.filter(
        (entry) => entry.channel === 'live:audio:input',
      ).length;
      oldWorklet.frame(0.9);
      assert.equal(h.levels.length, levelCount);
      assert.equal(
        h.ipc.filter((entry) => entry.channel === 'live:audio:input').length,
        inputCount,
      );
      h.worklets.at(-1)?.frame(0.3);
      assert.equal(h.levels.at(-1), 0.3);
      assert.equal(
        h.ipc.filter((entry) => entry.channel === 'live:audio:input').length,
        inputCount + 1,
      );
    } finally {
      await h.engine.dispose();
    }
  });

  it('does not reacquire muted input on device changes or selection', async () => {
    const h = fixture();
    try {
      await h.engine.initialize(true);
      await h.engine.setCapture(true, true, 1);
      h.mediaDevices.dispatchEvent(new Event('devicechange'));
      await h.engine.setInputDevice('mic-2');
      await h.engine.setCapture(true, true, 1);
      assert.equal(h.constraints.length, 0);
      await h.engine.setCapture(true, false, 1);
      assert.equal(h.constraints.length, 1);
      assert.equal(
        (h.constraints[0].audio as MediaTrackConstraints).deviceId &&
          (
            (h.constraints[0].audio as MediaTrackConstraints)
              .deviceId as ConstrainDOMStringParameters
          ).exact,
        'mic-2',
      );
    } finally {
      await h.engine.dispose();
    }
  });

  it('preserves the worklet and output clock when replacing an active input', async () => {
    const h = fixture();
    try {
      await h.engine.initialize(true);
      await h.engine.setCapture(true, false, 1);
      await h.engine.play(new Uint8Array(4800), { epoch: 1, outputId: 1 });
      const worklet = h.worklets[0];
      const captureContext = h.contexts[0];
      const outputContext = h.contexts[1];
      h.mediaDevices.dispatchEvent(new Event('devicechange'));
      await h.engine.setCapture(true, false, 1);
      assert.equal(h.streams.length, 2);
      assert.equal(h.streams[0].track.stopped, true);
      assert.equal(h.streams[1].track.stopped, false);
      assert.equal(h.worklets.length, 1);
      assert.equal(h.contexts.length, 2);
      assert.equal(captureContext.state, 'running');
      assert.equal(outputContext.state, 'running');
      assert.equal(outputContext.sources[0].stopped, false);
      worklet.frame();
      assert.equal(
        h.ipc.filter((entry) => entry.channel === 'live:audio:input').length,
        1,
      );
    } finally {
      await h.engine.dispose();
    }
  });

  it('ignores capture callbacks after call end and disposal', async () => {
    const h = fixture();
    try {
      await h.engine.initialize(true);
      await h.engine.setCapture(true, false, 1);
      const worklet = h.worklets[0];
      await h.engine.setCapture(false, false, 1);
      const levelCount = h.levels.length;
      worklet.frame();
      assert.equal(h.levels.length, levelCount);
      await h.engine.dispose();
      worklet.frame();
      assert.equal(h.levels.length, levelCount);
      assert.equal(
        h.ipc.filter((entry) => entry.channel === 'live:audio:input').length,
        0,
      );
    } finally {
      await h.engine.dispose();
    }
  });

  it('bounds a stuck microphone request and stops its late stream before retrying', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = fixture();
    const microphone = deferred<InstanceType<typeof h.Stream>>();
    const open = h.mediaDevices.getUserMedia;
    h.mediaDevices.getUserMedia = () => microphone.promise;
    try {
      await h.engine.initialize(true);
      const starting = h.engine.setCapture(true, false, 1);
      const failed = assert.rejects(starting, {
        name: 'AudioOperationTimeoutError',
        code: 'audio_capture_start_timeout',
        stage: 'microphone',
      });
      await flushAudioPromises();
      t.mock.timers.tick(audioOperation.AUDIO_START_TIMEOUT_MS);
      await failed;
      assert.equal(h.contexts.length, 0);
      const late = new h.Stream();
      microphone.resolve(late);
      await flushAudioPromises();
      assert.equal(late.track.stopped, true);
      assert.equal(
        h.diagnostics.some(({ event }) => event === 'capture_ready'),
        false,
      );
      h.mediaDevices.getUserMedia = open;
      await h.engine.setCapture(true, false, 2);
      assert.equal(h.streams[0].track.stopped, false);
      assert.equal(h.contexts[0].state, 'running');
    } finally {
      await h.engine.dispose();
    }
  });

  for (const action of ['stop', 'mute', 'recheck', 'dispose'] as const) {
    it(`${action} interrupts a pending microphone acquisition and leaves late input stopped`, async () => {
      const h = fixture();
      const microphone = deferred<InstanceType<typeof h.Stream>>();
      h.mediaDevices.getUserMedia = () => microphone.promise;
      try {
        await h.engine.initialize(true);
        const starting = h.engine.setCapture(true, false, 1);
        const cancelled = assert.rejects(starting, { name: 'AbortError' });
        await flushAudioPromises();
        const stopping =
          action === 'dispose'
            ? h.engine.dispose()
            : action === 'recheck'
              ? h.engine.recheck('manual_retry')
              : h.engine.setCapture(action === 'mute', action === 'mute', 1);
        await Promise.all([stopping, cancelled]);
        const late = new h.Stream();
        microphone.resolve(late);
        await flushAudioPromises();
        assert.equal(late.track.stopped, true);
        assert.equal(h.contexts.length, 0);
        assert.equal(
          h.diagnostics.some(
            ({ event, details }) =>
              event === 'capture_ready' && details.capturing === true,
          ),
          false,
        );
      } finally {
        await h.engine.dispose();
      }
    });
  }

  for (const action of ['dispose', 'recheck'] as const) {
    it(`rejects a queued capture that ${action} skips before it can execute`, async () => {
      const h = fixture();
      const devices =
        deferred<Awaited<ReturnType<typeof h.mediaDevices.enumerateDevices>>>();
      const enumerate = h.mediaDevices.enumerateDevices;
      h.mediaDevices.enumerateDevices = () => devices.promise;
      const initializing = h.engine.initialize(true);
      await flushAudioPromises();
      const capture = h.engine.setCapture(true, false, 1);
      const cancelled = assert.rejects(capture, { name: 'AbortError' });
      h.mediaDevices.enumerateDevices = enumerate;
      const stopping =
        action === 'dispose'
          ? h.engine.dispose()
          : h.engine.recheck('manual_retry');
      await Promise.all([initializing, stopping, cancelled]);
      devices.resolve([]);
      await flushAudioPromises();
      assert.equal(h.constraints.length, 0);
      assert.equal(
        h.diagnostics.some(({ event }) => event === 'capture_ready'),
        false,
      );
      await h.engine.dispose();
    });
  }

  for (const stage of ['worklet', 'resume'] as const) {
    it(`times out a stuck ${stage}, releases both streams and closes a late context again`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const h = fixture();
      const pending = deferred<void>();
      if (stage === 'worklet') h.controls.addModule = () => pending.promise;
      else h.controls.resume = () => pending.promise;
      try {
        await h.engine.initialize(true);
        const failed = assert.rejects(h.engine.setCapture(true, false, 1), {
          name: 'AudioOperationTimeoutError',
          code: 'audio_capture_start_timeout',
          stage,
        });
        await flushAudioPromises();
        const staleContext = h.contexts[0];
        assert(staleContext);
        t.mock.timers.tick(audioOperation.AUDIO_START_TIMEOUT_MS);
        await failed;
        assert.equal(h.streams[0].track.stopped, true);
        assert.equal(staleContext.state, 'closed');
        assert(staleContext.virtualStreams.every(({ track }) => track.stopped));
        pending.resolve();
        await flushAudioPromises();
        assert.equal(staleContext.state, 'closed');
        assert(staleContext.closeCalls >= 2);
        h.worklets[0]?.frame();
        assert.equal(
          h.ipc.filter(({ channel }) => channel === 'live:audio:input').length,
          0,
        );
        h.controls.addModule = undefined;
        h.controls.resume = undefined;
        await h.engine.setCapture(true, false, 2);
        assert.equal(h.contexts[1].state, 'running');
        assert.equal(h.streams[1].track.stopped, false);
      } finally {
        await h.engine.dispose();
      }
    });
  }

  it('uses one startup deadline across microphone acquisition and worklet loading', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = fixture();
    const microphone = deferred<InstanceType<typeof h.Stream>>();
    const worklet = deferred<void>();
    h.mediaDevices.getUserMedia = () => microphone.promise;
    h.controls.addModule = () => worklet.promise;
    try {
      await h.engine.initialize(true);
      const failed = assert.rejects(h.engine.setCapture(true, false, 1), {
        code: 'audio_capture_start_timeout',
        stage: 'worklet',
      });
      await flushAudioPromises();
      t.mock.timers.tick(6_000);
      const stream = new h.Stream();
      microphone.resolve(stream);
      await flushAudioPromises();
      t.mock.timers.tick(4_000);
      await failed;
      assert.equal(stream.track.stopped, true);
      assert.equal(h.contexts[0].state, 'closed');
    } finally {
      await h.engine.dispose();
    }
  });

  it('finishes Stop when context.close hangs and isolates its eventual completion from retry', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = fixture();
    const closing = deferred<void>();
    try {
      await h.engine.initialize(true);
      await h.engine.setCapture(true, false, 1);
      const staleContext = h.contexts[0];
      h.controls.close = (context) =>
        context === staleContext ? closing.promise : Promise.resolve();
      const stopping = h.engine.setCapture(false, false, 1);
      await flushAudioPromises();
      assert.equal(h.streams[0].track.stopped, true);
      assert.equal(staleContext.virtualStreams[0].track.stopped, true);
      t.mock.timers.tick(audioOperation.AUDIO_CLOSE_TIMEOUT_MS);
      await stopping;
      await h.engine.setCapture(true, false, 2);
      closing.resolve();
      await flushAudioPromises();
      assert.equal(staleContext.state, 'closed');
      assert.equal(h.contexts[1].state, 'running');
      assert.equal(h.streams[1].track.stopped, false);
    } finally {
      await h.engine.dispose();
    }
  });

  it('can dispose and initialize again while a readiness enumeration is stuck', async () => {
    const h = fixture();
    const pending =
      deferred<Awaited<ReturnType<typeof h.mediaDevices.enumerateDevices>>>();
    const enumerate = h.mediaDevices.enumerateDevices;
    h.mediaDevices.enumerateDevices = () => pending.promise;
    const initializing = h.engine.initialize(true);
    await flushAudioPromises();
    await h.engine.dispose();
    await initializing;
    h.mediaDevices.enumerateDevices = enumerate;
    await h.engine.initialize(true);
    pending.resolve([]);
    await flushAudioPromises();
    const state = h.ipc.findLast(
      ({ channel }) => channel === 'live:audio:self-check',
    )?.value;
    assert.deepEqual(JSON.parse(JSON.stringify(state)), {
      audioInput: true,
      audioOutput: true,
    });
    await h.engine.dispose();
  });

  it('cancels a stuck output resume on clear and ignores its late completion', async () => {
    const h = fixture();
    const pending = deferred<void>();
    h.controls.resume = () => pending.promise;
    try {
      await h.engine.initialize(false);
      const stale = h.engine.play(new Uint8Array(960), {
        epoch: 1,
        outputId: 1,
      });
      await flushAudioPromises();
      const old = h.contexts[0];
      h.engine.clearOutput();
      await stale;
      h.controls.resume = undefined;
      await h.engine.play(new Uint8Array(960), { epoch: 2, outputId: 1 });
      pending.resolve();
      await flushAudioPromises();
      assert.equal(old.state, 'closed');
      assert.equal(old.sources.length, 0);
      assert.equal(h.contexts[1].sources.length, 1);
      assert.equal(h.contexts[1].state, 'running');
    } finally {
      await h.engine.dispose();
    }
  });
});
