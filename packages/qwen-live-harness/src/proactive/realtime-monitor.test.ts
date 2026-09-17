/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QWEN_REALTIME_LIMITS } from '../realtime/realtime-session.js';
import { MonitorDebugStore } from './monitor-debug-store.js';
import { PROACTIVE_MONITOR_SYSTEM_PROMPT } from './monitor-protocol.js';
import {
  DashScopeRealtimeMonitor,
  type DashScopeRealtimeMonitorDeps,
  type DashScopeRealtimeMonitorOptions,
} from './realtime-monitor.js';

class FakeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly failingTypes = new Set<string>();
  pauseAfterAudio = false;
  closeCalls = 0;
  private readonly handlers = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();

  send(data: string | Uint8Array): void {
    const body = JSON.parse(String(data)) as Record<string, unknown>;
    if (this.failingTypes.has(String(body['type'])))
      throw new Error('synthetic send failure');
    this.sent.push(body);
    if (this.pauseAfterAudio && body['type'] === 'input_audio_buffer.append') {
      this.bufferedAmount = QWEN_REALTIME_LIMITS.maxBufferedSocketBytes + 1;
    }
  }
  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }
  on(event: string, callback: (...args: unknown[]) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const callback of this.handlers.get(event) ?? []) callback(...args);
  }
  message(body: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(body), false);
  }
}

const DEFAULT_OPTIONS: DashScopeRealtimeMonitorOptions = {
  endpoint: 'https://dashscope.example/compatible-mode/v1',
  apiKey: 'sk-test',
  model: 'qwen3.8-omni-flash-realtime',
  taskId: 'task-1',
  taskGeneration: 7,
  instruction: 'Tell me when the kettle boils.',
  monitorMode: 'event',
  modalities: ['audio'],
  contextWindowSec: { audio: 60, vision: 60 },
  sessionRecycleEvals: 100,
  representationCompact: 'normal',
  chunkDurationSec: 1,
  visionFps: 2,
};
const monitors: DashScopeRealtimeMonitor[] = [];
const archiveCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const monitor of monitors.splice(0)) monitor.close();
  for (const cleanup of archiveCleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

function jpeg(marker: number): string {
  return Buffer.from([0xff, 0xd8, marker, 0xff, 0xd9]).toString('base64');
}
function types(socket: FakeSocket): string[] {
  return socket.sent.map((body) => String(body['type']));
}
function wireAudio(events: Array<Record<string, unknown>>): Buffer {
  return Buffer.concat(
    events
      .filter((event) => event['type'] === 'input_audio_buffer.append')
      .map((event) => Buffer.from(String(event['audio']), 'base64')),
  );
}
function wireImages(events: Array<Record<string, unknown>>): unknown[] {
  return events
    .filter((event) => event['type'] === 'input_image_buffer.append')
    .map((event) => event['image']);
}
function ready(socket: FakeSocket): void {
  socket.message({
    type: 'session.created',
    session: { id: 'session-fixture' },
  });
  socket.message({ type: 'session.updated' });
}
function complete(
  socket: FakeSocket,
  id = 'response-1',
  text = 'wait',
  status = 'completed',
): void {
  socket.message({ type: 'input_audio_buffer.committed' });
  socket.message({ type: 'response.created', response: { id } });
  socket.message({ type: 'response.text.done', response_id: id, text });
  socket.message({ type: 'response.done', response: { id, status } });
}
async function settleReady(
  h: ReturnType<typeof harness>,
  count: number,
): Promise<void> {
  await vi.waitFor(() =>
    expect(h.callbacks.onReady).toHaveBeenCalledTimes(count),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
}
function harness(
  overrides: Partial<DashScopeRealtimeMonitorOptions> = {},
  deps: Omit<DashScopeRealtimeMonitorDeps, 'createWebSocket'> = {},
) {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const sockets: FakeSocket[] = [];
  const clock = { now: 100_000 };
  const callbacks = {
    onReady: vi.fn(),
    onResult: vi.fn(),
    onLifecycleError: vi.fn(),
    onDebug: vi.fn(),
  };
  const connectionAttempts = vi.fn();
  const monitor = new DashScopeRealtimeMonitor(options, callbacks, {
    now: () => clock.now,
    ...deps,
    createWebSocket: (url, socketOptions) => {
      connectionAttempts(url, socketOptions);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  monitors.push(monitor);
  const feedChunk = (marker = 1): void => {
    for (let frame = 0; frame < 2; frame += 1) {
      clock.now += 500;
      if (options.modalities.includes('audio'))
        monitor.feedAudio(Buffer.alloc(16_000, marker));
      if (options.modalities.includes('vision'))
        monitor.feedImage(jpeg(marker * 2 + frame));
    }
  };
  const start = async (): Promise<FakeSocket> => {
    const opening = monitor.start();
    const socket = sockets.at(-1)!;
    ready(socket);
    await opening;
    return socket;
  };
  return {
    monitor,
    sockets,
    options,
    callbacks,
    clock,
    feedChunk,
    start,
    connectionAttempts,
  };
}

describe('interleaved monitor media clips', () => {
  it.each([['audio'], ['vision'], ['audio', 'vision']] as const)(
    'configures %j as text-only manual inference without tools or priming silence',
    async (...modalities) => {
      const h = harness({ modalities });
      const socket = await h.start();
      expect(types(socket)).toEqual([
        'session.update',
        'conversation.item.create',
      ]);
      expect(socket.sent[0]).toMatchObject({
        session: {
          modalities: ['text'],
          voice: 'Tina',
          smooth_output: false,
          turn_detection: null,
          tools: [],
          tool_choice: 'none',
          instructions: PROACTIVE_MONITOR_SYSTEM_PROMPT,
          audio: {
            input: { format: { type: 'pcm', sample_rate: 16_000 } },
            output: { format: { type: 'pcm', sample_rate: 24_000 } },
          },
        },
      });
      expect(socket.sent[1]).toMatchObject({
        item: {
          role: 'user',
          content: [{ type: 'input_text', text: DEFAULT_OPTIONS.instruction }],
        },
      });
      expect(h.monitor.requestEvaluation()).toBe(false);
      h.feedChunk();
      expect(h.monitor.requestEvaluation()).toBe(true);
      expect(types(socket).at(-1)).toBe('input_audio_buffer.commit');
      expect(types(socket)).not.toContain('response.create');
      socket.message({ type: 'input_audio_buffer.committed' });
      expect(types(socket).at(-1)).toBe('response.create');
    },
  );

  it('aggregates fifty 20ms microphone frames into exactly one second without padding', async () => {
    const h = harness();
    const socket = await h.start();
    for (let frame = 0; frame < 49; frame += 1) {
      h.clock.now += 20;
      h.monitor.feedAudio(Buffer.alloc(640, frame));
    }
    expect(h.monitor.requestEvaluation()).toBe(false);
    expect(socket.sent).toHaveLength(2);
    h.clock.now += 20;
    h.monitor.feedAudio(Buffer.alloc(640, 49));
    expect(h.monitor.requestEvaluation()).toBe(true);
    expect(types(socket).slice(2)).toEqual([
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
    ]);
    expect(wireAudio(socket.sent)).toEqual(
      Buffer.concat(Array.from({ length: 50 }, (_, i) => Buffer.alloc(640, i))),
    );
    complete(socket);
    expect(h.monitor.requestEvaluation()).toBe(false);
  });

  it('retains partial microphone frames for the next clip without changing sample order', async () => {
    const h = harness();
    const socket = await h.start();
    h.clock.now += 2_000;
    h.monitor.feedAudio(
      Buffer.concat([Buffer.alloc(32_000, 1), Buffer.alloc(32_000, 2)]),
    );
    expect(h.monitor.requestEvaluation()).toBe(true);
    expect(wireAudio(socket.sent)).toEqual(Buffer.alloc(32_000, 1));
    complete(socket);
    const index = socket.sent.length;
    expect(h.monitor.requestEvaluation()).toBe(true);
    expect(wireAudio(socket.sent.slice(index))).toEqual(
      Buffer.alloc(32_000, 2),
    );
    complete(socket, 'response-2');
    expect(h.monitor.requestEvaluation()).toBe(false);
  });

  it('queues subsequent clips locally until the preceding assistant response.done', async () => {
    const h = harness();
    const socket = await h.start();
    h.feedChunk(1);
    expect(h.monitor.requestEvaluation()).toBe(true);
    const pending = socket.sent.length;
    h.feedChunk(2);
    h.feedChunk(3);
    expect(h.monitor.requestEvaluation()).toBe(false);
    expect(socket.sent).toHaveLength(pending);
    socket.message({ type: 'input_audio_buffer.committed' });
    socket.message({ type: 'response.created', response: { id: 'first' } });
    socket.message({
      type: 'response.text.done',
      response_id: 'first',
      text: 'wait',
    });
    expect(h.monitor.requestEvaluation()).toBe(false);
    socket.message({
      type: 'response.done',
      response: { id: 'first', status: 'completed' },
    });
    const second = socket.sent.length;
    expect(h.monitor.requestEvaluation()).toBe(true);
    expect(wireAudio(socket.sent.slice(second))).toEqual(
      Buffer.alloc(32_000, 2),
    );
    complete(socket, 'second');
    const third = socket.sent.length;
    expect(h.monitor.requestEvaluation()).toBe(true);
    expect(wireAudio(socket.sent.slice(third))).toEqual(
      Buffer.alloc(32_000, 3),
    );
    expect(
      types(socket).filter((type) => type === 'conversation.item.create'),
    ).toHaveLength(1);
    expect(types(socket)).not.toContain('conversation.item.delete');
  });

  it('pairs one second of real microphone audio with its two contemporaneous frames', async () => {
    const h = harness({ modalities: ['audio', 'vision'] });
    const socket = await h.start();
    h.feedChunk(4);
    expect(h.monitor.requestEvaluation()).toBe(true);
    expect(types(socket).slice(2)).toEqual([
      'input_audio_buffer.append',
      'input_image_buffer.append',
      'input_audio_buffer.append',
      'input_image_buffer.append',
      'input_audio_buffer.commit',
    ]);
    expect(wireAudio(socket.sent)).toEqual(Buffer.alloc(32_000, 4));
    expect(wireImages(socket.sent)).toEqual([jpeg(8), jpeg(9)]);
    expect(h.callbacks.onDebug).toHaveBeenCalledWith(
      'proactive.monitor_chunk_prepared',
      expect.objectContaining({
        chunkStartAt: 100_000,
        chunkEndAt: 101_000,
        audioBytes: 32_000,
        audioOrigin: 'microphone',
        imageFrames: 2,
      }),
    );
  });

  it('never fills a missing multimodal grid with images from an older or later second', async () => {
    const h = harness({ modalities: ['audio', 'vision'] });
    const socket = await h.start();
    h.clock.now -= 1_000;
    h.monitor.feedImage(jpeg(1));
    h.clock.now += 1_500;
    h.monitor.feedAudio(Buffer.alloc(16_000));
    h.monitor.feedImage(jpeg(2));
    h.clock.now += 500;
    h.monitor.feedAudio(Buffer.alloc(16_000));
    expect(h.monitor.requestEvaluation()).toBe(false);
    h.clock.now += 600;
    h.monitor.feedImage(jpeg(3));
    expect(h.monitor.requestEvaluation()).toBe(false);
    expect(socket.sent).toHaveLength(2);
    expect(h.callbacks.onDebug).toHaveBeenCalledWith(
      'proactive.monitor_chunk_dropped',
      expect.objectContaining({
        reason: 'incomplete_visual_grid',
        imageFrames: 1,
        requiredImageFrames: 2,
      }),
    );
    h.feedChunk(5);
    expect(h.monitor.requestEvaluation()).toBe(true);
    expect(wireImages(socket.sent)).toEqual([jpeg(10), jpeg(11)]);
    expect(wireAudio(socket.sent)).toEqual(Buffer.alloc(32_000, 5));
  });

  it('requires two actual visual frames and uses one second of protocol carrier silence', async () => {
    const h = harness({ modalities: ['vision'] });
    const socket = await h.start();
    h.monitor.feedImage(jpeg(1));
    expect(h.monitor.requestEvaluation()).toBe(false);
    h.clock.now += 500;
    h.monitor.feedImage(jpeg(2));
    expect(h.monitor.requestEvaluation()).toBe(true);
    expect(wireAudio(socket.sent)).toEqual(Buffer.alloc(32_000));
    expect(wireImages(socket.sent)).toEqual([jpeg(1), jpeg(2)]);
    complete(socket);
    expect(h.monitor.requestEvaluation()).toBe(false);
  });

  it('preserves FIFO under socket backpressure without sending media or committing early', async () => {
    const h = harness();
    const socket = await h.start();
    socket.bufferedAmount = QWEN_REALTIME_LIMITS.maxBufferedSocketBytes + 1;
    h.feedChunk(1);
    h.feedChunk(2);
    expect(h.monitor.requestEvaluation()).toBe(false);
    expect(socket.sent).toHaveLength(2);
    socket.bufferedAmount = 0;
    expect(h.monitor.requestEvaluation()).toBe(true);
    expect(wireAudio(socket.sent)).toEqual(Buffer.alloc(32_000, 1));
    complete(socket);
    const index = socket.sent.length;
    expect(h.monitor.requestEvaluation()).toBe(true);
    expect(wireAudio(socket.sent.slice(index))).toEqual(
      Buffer.alloc(32_000, 2),
    );
  });

  it('bounds local capture while a response is slow and reports dropped capture identity', async () => {
    const h = harness({}, { maxQueuedInputs: 2 });
    const socket = await h.start();
    h.feedChunk(1);
    h.monitor.requestEvaluation();
    h.feedChunk(2);
    h.feedChunk(3);
    h.monitor.requestEvaluation();
    expect(h.callbacks.onDebug).toHaveBeenCalledWith(
      'proactive.monitor_input_dropped',
      expect.objectContaining({
        reason: 'capture_queue_full',
        audioBytes: 32_000,
        count: 2,
        firstSequence: expect.any(Number),
        firstCapturedAt: expect.any(Number),
      }),
    );
    complete(socket);
    const index = socket.sent.length;
    h.monitor.requestEvaluation();
    expect(wireAudio(socket.sent.slice(index))).toEqual(
      Buffer.alloc(32_000, 3),
    );
  });

  it.each(['audio', 'vision'] as const)(
    'expires pending %s capture instead of treating old evidence as a new clip',
    async (modality) => {
      const h = harness({
        modalities: [modality],
        contextWindowSec: { audio: 1, vision: 1 },
      });
      const socket = await h.start();
      h.feedChunk();
      h.clock.now += 2_000;
      expect(h.monitor.requestEvaluation()).toBe(false);
      h.monitor.requestEvaluation();
      expect(socket.sent).toHaveLength(2);
      expect(h.callbacks.onDebug).toHaveBeenCalledWith(
        'proactive.monitor_input_dropped',
        expect.objectContaining({
          reason: 'capture_window_expired',
          ...(modality === 'audio'
            ? { audioBytes: 32_000 }
            : { imageFrames: 2 }),
        }),
      );
    },
  );

  it('rejects invalid microphone frames without padding them into a clip', async () => {
    const h = harness();
    const socket = await h.start();
    for (const audio of [
      Buffer.alloc(0),
      Buffer.alloc(3),
      Buffer.alloc(QWEN_REALTIME_LIMITS.maxInputAudioFrameBytes + 2),
    ]) {
      expect(h.monitor.feedAudio(audio)).toBe(false);
    }
    expect(h.monitor.requestEvaluation()).toBe(false);
    expect(socket.sent).toHaveLength(2);
  });

  it('clears only pending capture while retaining the resident assistant conversation', async () => {
    const h = harness();
    const socket = await h.start();
    h.feedChunk(1);
    h.monitor.requestEvaluation();
    complete(socket);
    h.feedChunk(2);
    h.monitor.resetPendingCapture();
    expect(types(socket).at(-1)).toBe('input_audio_buffer.clear');
    expect(h.monitor.requestEvaluation()).toBe(false);
    h.feedChunk(3);
    const index = socket.sent.length;
    expect(h.monitor.requestEvaluation()).toBe(true);
    expect(wireAudio(socket.sent.slice(index))).toEqual(
      Buffer.alloc(32_000, 3),
    );
    expect(h.sockets).toHaveLength(1);
    expect(
      types(socket).filter((type) => type === 'conversation.item.create'),
    ).toHaveLength(1);
  });

  it('does not splice audio recorded across a long mute gap into one clip', async () => {
    const h = harness();
    const socket = await h.start();
    h.clock.now += 500;
    h.monitor.feedAudio(Buffer.alloc(16_000, 1));
    h.clock.now += 20_000;
    h.monitor.feedAudio(Buffer.alloc(16_000, 2));
    expect(h.monitor.requestEvaluation()).toBe(false);
    expect(h.callbacks.onDebug).toHaveBeenCalledWith(
      'proactive.monitor_chunk_dropped',
      expect.objectContaining({
        reason: 'audio_capture_gap',
        audioBytes: 16_000,
      }),
    );
    expect(socket.sent).toHaveLength(2);
    h.clock.now += 500;
    h.monitor.feedAudio(Buffer.alloc(16_000, 3));
    expect(h.monitor.requestEvaluation()).toBe(true);
    expect(wireAudio(socket.sent)).toEqual(
      Buffer.concat([Buffer.alloc(16_000, 2), Buffer.alloc(16_000, 3)]),
    );
  });

  it.each(['capture_window_expired', 'capture_queue_full'] as const)(
    'clears a partially written frozen clip when it is dropped for %s',
    async (reason) => {
      const h = harness(
        { modalities: ['audio', 'vision'] },
        { maxQueuedInputs: reason === 'capture_queue_full' ? 4 : 4_096 },
      );
      const socket = await h.start();
      h.feedChunk(1);
      socket.pauseAfterAudio = true;
      expect(h.monitor.requestEvaluation()).toBe(false);
      expect(types(socket).at(-1)).toBe('input_audio_buffer.append');
      if (reason === 'capture_window_expired') h.clock.now += 61_000;
      h.feedChunk(2);
      expect(types(socket).at(-1)).toBe('input_audio_buffer.clear');
      expect(h.callbacks.onDebug).toHaveBeenCalledWith(
        'proactive.monitor_chunk_dropped',
        expect.objectContaining({ reason }),
      );
      socket.bufferedAmount = 0;
      socket.pauseAfterAudio = false;
      const index = socket.sent.length;
      expect(h.monitor.requestEvaluation()).toBe(true);
      expect(wireAudio(socket.sent.slice(index))).toEqual(
        Buffer.alloc(32_000, 2),
      );
      expect(wireImages(socket.sent.slice(index))).toEqual([jpeg(4), jpeg(5)]);
    },
  );

  it('reports only the frames actually sent when discarding extra captures within the same audio clip', async () => {
    const h = harness({ modalities: ['audio', 'vision'] });
    const socket = await h.start();
    h.clock.now += 250;
    h.monitor.feedImage(jpeg(1));
    h.clock.now += 250;
    h.monitor.feedAudio(Buffer.alloc(16_000));
    h.monitor.feedImage(jpeg(2));
    h.clock.now += 500;
    h.monitor.feedAudio(Buffer.alloc(16_000));
    h.monitor.feedImage(jpeg(3));
    expect(h.monitor.requestEvaluation()).toBe(true);
    expect(wireImages(socket.sent)).toEqual([jpeg(1), jpeg(3)]);
    expect(h.callbacks.onDebug).toHaveBeenCalledWith(
      'proactive.monitor_chunk_prepared',
      expect.objectContaining({ imageFrames: 2 }),
    );
  });

  it('does not accept capture after close', async () => {
    const h = harness({ modalities: ['audio', 'vision'] });
    await h.start();
    h.monitor.close();
    expect(h.monitor.feedAudio(Buffer.alloc(640))).toBe(false);
    expect(h.monitor.feedImage(jpeg(1))).toBe(false);
    expect(h.monitor.requestEvaluation()).toBe(false);
  });
});

describe('monitor transport and response lifecycle', () => {
  it.each([undefined, 'secret-api-key'])(
    'limits the WebSocket handshake and sends authentication only in headers: %s',
    async (apiKey) => {
      const h = harness({ apiKey });
      await h.start();
      const [url, options] = h.connectionAttempts.mock.calls[0]!;
      expect(String(url)).not.toContain('secret-api-key');
      expect(options).toEqual({
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        maxPayload: QWEN_REALTIME_LIMITS.maxIncomingMessageBytes,
        perMessageDeflate: false,
        handshakeTimeout: 8_000,
      });
      expect(JSON.stringify(h.callbacks.onDebug.mock.calls)).not.toContain(
        'secret-api-key',
      );
    },
  );

  it.each(['startup', 'ready'] as const)(
    'handles a rejected HTTP upgrade during %s without exposing provider details',
    async (phase) => {
      const h = harness();
      if (phase === 'startup') {
        const pending = h.monitor.start();
        const rejected = expect(pending).rejects.toMatchObject({
          code: 'monitor_upgrade_rejected',
          kind: 'configuration',
        });
        h.sockets[0]!.emit('unexpected-response', {
          detail: 'private-upgrade-detail',
        });
        await rejected;
        expect(h.callbacks.onReady).not.toHaveBeenCalled();
      } else {
        const socket = await h.start();
        socket.emit('unexpected-response', {
          detail: 'private-upgrade-detail',
        });
        socket.emit('close');
        expect(h.callbacks.onLifecycleError).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            code: 'monitor_upgrade_rejected',
            kind: 'configuration',
          }),
          7,
        );
      }
      expect(
        JSON.stringify([
          h.callbacks.onDebug.mock.calls,
          h.callbacks.onLifecycleError.mock.calls,
        ]),
      ).not.toContain('private-upgrade-detail');
    },
  );

  it.each([
    { payload: 'not-json-private-detail', code: 'monitor_invalid_json' },
    {
      payload: JSON.stringify({ noType: 'private-detail' }),
      code: 'monitor_invalid_message',
    },
    {
      payload: 'x'.repeat(QWEN_REALTIME_LIMITS.maxIncomingMessageBytes + 1),
      code: 'monitor_message_too_large',
    },
  ])(
    'rejects malformed or oversized provider messages ($code)',
    async ({ payload, code }) => {
      const h = harness();
      const socket = await h.start();
      socket.emit('message', payload, false);
      expect(h.callbacks.onLifecycleError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code, kind: 'protocol' }),
        7,
      );
      expect(
        JSON.stringify([
          h.callbacks.onDebug.mock.calls,
          h.callbacks.onLifecycleError.mock.calls,
        ]),
      ).not.toContain('private-detail');
    },
  );

  it.each([
    ['session.update', 'monitor_session_update_failed'],
    ['conversation.item.create', 'monitor_initialization_failed'],
  ])('rejects startup when %s cannot be written', async (event, code) => {
    const h = harness();
    const pending = h.monitor.start();
    const rejected = expect(pending).rejects.toMatchObject({ code });
    h.sockets[0]!.failingTypes.add(event);
    ready(h.sockets[0]!);
    await rejected;
    expect(h.callbacks.onReady).not.toHaveBeenCalled();
    expect(h.callbacks.onResult).not.toHaveBeenCalled();
  });

  it.each(['input_audio_buffer.append', 'input_image_buffer.append'])(
    'reports an independent writer failure for %s without committing partial media',
    async (event) => {
      const h = harness({ modalities: ['audio', 'vision'] });
      const socket = await h.start();
      h.feedChunk();
      socket.failingTypes.add(event);
      expect(h.monitor.requestEvaluation()).toBe(false);
      expect(types(socket)).not.toContain('input_audio_buffer.commit');
      expect(h.callbacks.onLifecycleError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: 'monitor_media_writer_failed' }),
        7,
      );
      socket.emit('error');
      socket.emit('close');
      expect(h.callbacks.onLifecycleError).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['wait', 'wait'],
    ['Reply: private-provider-text', 'reply'],
    ['Func_call: private-provider-text', 'function_call'],
    ['private-provider-text', 'invalid'],
  ])(
    'logs only the action class %s rather than provider content',
    async (text, action) => {
      const h = harness({ apiKey: 'secret-api-key', model: 'secret-api-key' });
      const socket = await h.start();
      h.feedChunk();
      h.monitor.requestEvaluation();
      complete(socket, 'action-response', text);
      expect(h.callbacks.onDebug).toHaveBeenCalledWith(
        'proactive.monitor_action',
        expect.objectContaining({
          evaluation: 1,
          action,
          responseChars: text.length,
        }),
      );
      const logs = JSON.stringify(h.callbacks.onDebug.mock.calls);
      expect(logs).not.toContain('private-provider-text');
      expect(logs).not.toContain('secret-api-key');
      if (action === 'invalid')
        expect(h.callbacks.onResult).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            triggered: false,
            error: expect.any(String),
          }),
          7,
        );
    },
  );

  it.each([undefined, 'completed'])(
    'accepts a successful terminal with status %s',
    async (status) => {
      const h = harness();
      const socket = await h.start();
      h.feedChunk();
      h.monitor.requestEvaluation();
      socket.message({ type: 'input_audio_buffer.committed' });
      socket.message({
        type: 'response.text.done',
        response_id: 'ok',
        text: 'Reply: Detected.',
      });
      socket.message({
        type: 'response.done',
        response: { id: 'ok', ...(status ? { status } : {}) },
      });
      expect(h.callbacks.onResult).toHaveBeenCalledExactlyOnceWith(
        { triggered: true, summary: 'Detected.', currentState: '' },
        7,
      );
    },
  );

  it('keeps debug image hashes and per-commit counts isolated after clear and recycle', async () => {
    const h = harness({
      modalities: ['audio', 'vision'],
      sessionRecycleEvals: 1,
    });
    const first = await h.start();
    h.feedChunk(1);
    h.monitor.resetPendingCapture();
    h.feedChunk(2);
    h.monitor.requestEvaluation();
    const hash = (marker: number) =>
      createHash('sha256')
        .update(Buffer.from(jpeg(marker), 'base64'))
        .digest('hex')
        .slice(0, 16);
    expect(h.callbacks.onDebug).toHaveBeenCalledWith(
      'proactive.monitor_commit',
      expect.objectContaining({
        evaluation: 1,
        imageFrames: 2,
        audioBytes: 32_000,
        audioMs: 1_000,
        lastFrameHash: hash(5),
      }),
    );
    complete(first);
    h.feedChunk(3);
    h.monitor.requestEvaluation();
    ready(h.sockets[1]!);
    await settleReady(h, 2);
    h.monitor.requestEvaluation();
    expect(h.callbacks.onDebug).toHaveBeenCalledWith(
      'proactive.monitor_commit',
      expect.objectContaining({
        transportGeneration: 2,
        evaluation: 2,
        imageFrames: 2,
        audioBytes: 32_000,
        audioMs: 1_000,
        lastFrameHash: hash(7),
      }),
    );
    expect(h.callbacks.onDebug).not.toHaveBeenCalledWith(
      'proactive.monitor_image_sent',
      expect.objectContaining({ frameHash: hash(2) }),
    );
  });

  it.each([
    { audio: 60, vision: 10, audioBytes: 0, imageFrames: 2 },
    { audio: 10, vision: 60, audioBytes: 32_000, imageFrames: 0 },
  ])(
    'expires only the applicable pending modality window: audio $audio / vision $vision',
    async ({ audio, vision, audioBytes, imageFrames }) => {
      const h = harness({
        modalities: ['audio', 'vision'],
        contextWindowSec: { audio, vision },
      });
      await h.start();
      h.feedChunk();
      h.clock.now += 20_000;
      expect(h.monitor.requestEvaluation()).toBe(false);
      expect(h.callbacks.onDebug).toHaveBeenCalledWith(
        'proactive.monitor_input_dropped',
        expect.objectContaining({
          reason: 'capture_window_expired',
          audioBytes,
          imageFrames,
        }),
      );
    },
  );

  it('splits configured longer clips into bounded audio append messages', async () => {
    const h = harness({ chunkDurationSec: 5 });
    const socket = await h.start();
    for (let index = 0; index < 5; index += 1) h.feedChunk();
    expect(h.monitor.requestEvaluation()).toBe(true);
    const appends = socket.sent.filter(
      (event) => event['type'] === 'input_audio_buffer.append',
    );
    expect(appends).toHaveLength(3);
    for (const event of appends)
      expect(
        Buffer.from(String(event['audio']), 'base64').length,
      ).toBeLessThanOrEqual(QWEN_REALTIME_LIMITS.maxInputAudioFrameBytes);
    expect(wireAudio(socket.sent)).toHaveLength(160_000);
  });

  it.each(['none', 'normal'] as const)(
    'sets fixed %s video compression before media across recycling',
    async (representationCompact) => {
      const h = harness({
        modalities: ['audio', 'vision'],
        representationCompact,
        sessionRecycleEvals: 1,
      });
      const opening = h.monitor.start();
      const first = h.sockets[0]!;
      h.feedChunk(1);
      first.message({ type: 'session.updated' });
      expect(first.sent).toHaveLength(0);
      ready(first);
      await opening;
      expect(first.sent[0]).toHaveProperty(
        'session.video.input.representation_compact',
        representationCompact,
      );
      expect(first.sent).toHaveLength(2);
      h.monitor.requestEvaluation();
      complete(first);
      h.feedChunk(2);
      h.options.representationCompact =
        representationCompact === 'normal' ? 'none' : 'normal';
      expect(h.monitor.requestEvaluation()).toBe(false);
      const second = h.sockets[1]!;
      ready(second);
      await settleReady(h, 2);
      expect(second.sent[0]).toHaveProperty(
        'session.video.input.representation_compact',
        representationCompact,
      );
      expect(second.sent).toHaveLength(2);
      expect(h.monitor.requestEvaluation()).toBe(true);
      expect(wireAudio(second.sent)).toEqual(Buffer.alloc(32_000, 2));
      expect(wireImages(second.sent)).toEqual([jpeg(4), jpeg(5)]);
      first.message({ type: 'error', error: { message: 'stale' } });
      first.emit('error');
      first.emit('close');
      expect(h.callbacks.onLifecycleError).not.toHaveBeenCalled();
    },
  );

  it('does not replay a successfully committed clip after recycling without fresh capture', async () => {
    const h = harness({ sessionRecycleEvals: 1 });
    const first = await h.start();
    h.feedChunk();
    h.monitor.requestEvaluation();
    complete(first);
    expect(h.monitor.requestEvaluation()).toBe(false);
    ready(h.sockets[1]!);
    await settleReady(h, 2);
    expect(h.monitor.requestEvaluation()).toBe(false);
    expect(h.sockets[1]!.sent).toHaveLength(2);
  });

  it.each(['failed', 'cancelled', 'incomplete'])(
    'rejects %s partial replies and permits only fresh capture after recycle',
    async (status) => {
      const h = harness();
      const socket = await h.start();
      h.feedChunk();
      h.monitor.requestEvaluation();
      complete(socket, 'failed', 'Reply: The kettle is boiling.', status);
      expect(h.callbacks.onResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          triggered: false,
          error: expect.any(String),
        }),
        7,
      );
      expect(h.monitor.requestEvaluation()).toBe(false);
      const second = h.sockets[1]!;
      ready(second);
      await settleReady(h, 2);
      expect(h.monitor.requestEvaluation()).toBe(false);
      h.feedChunk(2);
      expect(h.monitor.requestEvaluation()).toBe(true);
      complete(second, 'fresh', 'Reply: A new observation.');
      expect(h.callbacks.onResult).toHaveBeenLastCalledWith(
        expect.objectContaining({
          triggered: true,
          summary: 'A new observation.',
        }),
        7,
      );
    },
  );

  it('ignores another response ID and duplicate terminal events', async () => {
    const h = harness();
    const socket = await h.start();
    h.feedChunk();
    h.monitor.requestEvaluation();
    socket.message({ type: 'input_audio_buffer.committed' });
    socket.message({ type: 'response.created', response: { id: 'current' } });
    complete(socket, 'unrelated', 'Reply: Wrong result.');
    expect(h.callbacks.onResult).not.toHaveBeenCalled();
    complete(socket, 'current', 'Reply: Correct result.');
    complete(socket, 'current', 'Reply: Duplicate result.');
    expect(h.callbacks.onResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ summary: 'Correct result.' }),
      7,
    );
  });

  it('counts the evaluation budget afresh after each successful transport recycle', async () => {
    const h = harness({ sessionRecycleEvals: 2 });
    let socket = await h.start();
    for (let round = 0; round < 3; round += 1) {
      if (round > 0) {
        expect(h.monitor.requestEvaluation()).toBe(false);
        socket = h.sockets[round]!;
        ready(socket);
        await settleReady(h, round + 1);
      }
      for (let evaluation = 0; evaluation < 2; evaluation += 1) {
        h.feedChunk(round + 1);
        expect(h.monitor.requestEvaluation()).toBe(true);
        complete(socket, `${round}-${evaluation}`);
      }
      expect(h.sockets).toHaveLength(round + 1);
    }
  });

  it.each(['evaluation', 'lifecycle'])(
    'redacts provider secrets from %s failures while retaining safe identifiers',
    async (phase) => {
      const h = harness({ apiKey: 'secret-api-key' });
      const socket = await h.start();
      if (phase === 'evaluation') {
        h.feedChunk();
        h.monitor.requestEvaluation();
      }
      socket.message({
        type: 'error',
        error: {
          code: 'rate_limit_exceeded',
          status: 429,
          type: 'rate_limit_error',
          param: 'input_audio_buffer',
          message: 'secret-api-key private-provider-detail',
        },
      });
      socket.emit('close');
      const callback =
        phase === 'evaluation'
          ? h.callbacks.onResult
          : h.callbacks.onLifecycleError;
      expect(callback).toHaveBeenCalledOnce();
      if (phase === 'evaluation') {
        expect(h.callbacks.onDebug).toHaveBeenCalledWith(
          'proactive.monitor_result',
          expect.objectContaining({
            code: 'rate_limit_exceeded',
            status: 429,
            kind: 'transient',
            providerType: 'rate_limit_error',
            param: 'input_audio_buffer',
          }),
        );
      }
      const recorded = JSON.stringify([
        callback.mock.calls,
        h.callbacks.onDebug.mock.calls,
      ]);
      expect(recorded).not.toContain('secret-api-key');
      expect(recorded).not.toContain('private-provider-detail');
    },
  );

  it('sanitizes socket failures and fences duplicates', async () => {
    const h = harness();
    const socket = await h.start();
    socket.emit('error', new Error('private-transport-detail'));
    socket.emit('close');
    expect(h.callbacks.onLifecycleError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        code: 'monitor_socket_error',
        message: 'Monitor WebSocket failed.',
      }),
      7,
    );
    expect(
      JSON.stringify(h.callbacks.onLifecycleError.mock.calls),
    ).not.toContain('private-transport-detail');
  });

  it('rejects pending startup immediately on close', async () => {
    const h = harness({}, { connectTimeoutMs: 60_000 });
    const opening = h.monitor.start();
    h.monitor.close();
    await expect(opening).rejects.toThrow('closed while connecting');
  });

  it('discards pending capture and recycles after a clear send failure', async () => {
    const h = harness();
    const first = await h.start();
    h.feedChunk();
    first.failingTypes.add('input_audio_buffer.clear');
    h.monitor.resetPendingCapture();
    first.emit('error');
    first.emit('close');
    expect(h.callbacks.onLifecycleError).toHaveBeenCalledOnce();
    expect(h.monitor.requestEvaluation()).toBe(false);
    ready(h.sockets[1]!);
    await settleReady(h, 2);
    expect(h.monitor.requestEvaluation()).toBe(false);
    expect(h.sockets[1]!.sent).toHaveLength(2);
  });

  it('does not let debug observers interrupt media, completed results or failures', async () => {
    const h = harness();
    h.callbacks.onDebug.mockImplementation(() => {
      throw new Error('observer failed');
    });
    const socket = await h.start();
    h.feedChunk();
    expect(h.monitor.requestEvaluation()).toBe(true);
    complete(socket, 'ok', 'Reply: Detected.');
    expect(h.callbacks.onResult).toHaveBeenCalledOnce();
    socket.emit('error');
    expect(h.callbacks.onLifecycleError).toHaveBeenCalledOnce();
  });
});

interface ArchivedRequest {
  recordingStatus: string;
  request: number;
  transportGeneration: number;
  previousRequest?: string;
  session: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}
async function archivedHarness(
  overrides: Partial<DashScopeRealtimeMonitorOptions> = {},
  deps: Omit<DashScopeRealtimeMonitorDeps, 'createWebSocket'> = {},
) {
  const temporary = await mkdtemp(
    join(tmpdir(), 'qwen-live-harness-monitor-wiring-'),
  );
  const archiveLog = vi.fn();
  const store = new MonitorDebugStore(archiveLog, join(temporary, 'archives'));
  expect(await store.initialize()).toBe(true);
  const h = harness({ ...overrides, monitorDebug: store }, deps);
  archiveCleanups.push(async () => {
    await store.flush();
    await rm(temporary, { recursive: true, force: true });
  });
  return { ...h, store, archiveLog };
}
async function archives(store: MonitorDebugStore) {
  await store.flush();
  const directories = await readdir(store.root);
  expect(directories).toHaveLength(1);
  const monitorDirectory = join(store.root, directories[0]!);
  const requestsDirectory = join(monitorDirectory, 'requests');
  const requests = (await readdir(requestsDirectory)).sort();
  return Promise.all(
    requests.map(async (name) => {
      const directory = join(requestsDirectory, name);
      const request = JSON.parse(
        await readFile(join(directory, 'request.json'), 'utf8'),
      ) as ArchivedRequest;
      const response = JSON.parse(
        await readFile(join(directory, 'response.json'), 'utf8'),
      ) as Record<string, unknown>;
      return { directory, monitorDirectory, request, response };
    }),
  );
}
async function expectArchivedWire(
  archive: { directory: string; request: ArchivedRequest },
  events: Array<Record<string, unknown>>,
) {
  const wav = await readFile(join(archive.directory, 'input.wav'));
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.readUInt32LE(24)).toBe(16_000);
  expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
  expect(wav.subarray(44)).toEqual(wireAudio(events));
  expect(archive.request.recordingStatus).toBe('saved');
  expect(archive.request.events.map((event) => event['type'])).toEqual(
    events.map((event) => event['type']),
  );
  let audioOffset = 0;
  for (const [index, event] of archive.request.events.entries()) {
    expect(event['eventId'] ?? event['event_id']).toBe(
      events[index]!['event_id'],
    );
    if (event['type'] === 'input_audio_buffer.append') {
      const expected = Buffer.from(String(events[index]!['audio']), 'base64');
      expect(event['byteOffset']).toBe(audioOffset);
      expect(event['bytes']).toBe(expected.length);
      expect(
        wav.subarray(44 + audioOffset, 44 + audioOffset + expected.length),
      ).toEqual(expected);
      audioOffset += expected.length;
    } else if (event['type'] === 'input_image_buffer.append') {
      const expected = Buffer.from(String(events[index]!['image']), 'base64');
      expect(
        await readFile(join(archive.directory, String(event['image']))),
      ).toEqual(expected);
      expect(event['sha256']).toBe(
        createHash('sha256').update(expected).digest('hex'),
      );
    } else {
      expect(event).toEqual(events[index]);
    }
  }
  expect(audioOffset).toBe(wav.length - 44);
}

describe('exact interleaved monitor debug archives', () => {
  it.each([['audio'], ['vision'], ['audio', 'vision']] as const)(
    'archives exact %j inputs and distinguishes real microphone from protocol silence',
    async (...modalities) => {
      const h = await archivedHarness({ modalities });
      const socket = await h.start();
      h.feedChunk(7);
      expect(h.monitor.requestEvaluation()).toBe(true);
      socket.message({ type: 'input_audio_buffer.committed' });
      socket.message({
        type: 'response.text.done',
        response_id: 'first',
        text: 'wait',
      });
      socket.message({
        type: 'response.done',
        event_id: 'event-done',
        response: {
          id: 'first',
          status: 'completed',
          usage: { input_tokens: 20, output_tokens: 1 },
        },
      });
      const secondIndex = socket.sent.length;
      h.feedChunk(8);
      expect(h.monitor.requestEvaluation()).toBe(true);
      complete(socket, 'second', 'Reply: Found it.');
      const [first, second] = await archives(h.store);
      await expectArchivedWire(first!, socket.sent.slice(2, secondIndex));
      await expectArchivedWire(second!, socket.sent.slice(secondIndex));
      expect(first!.request).toMatchObject({
        providerSessionId: 'session-fixture',
        audioSummary: {
          totalBytes: 32_000,
          microphoneBytes: modalities.some((modality) => modality === 'audio')
            ? 32_000
            : 0,
          protocolSilenceBytes: modalities.some(
            (modality) => modality === 'audio',
          )
            ? 0
            : 32_000,
          unknownBytes: 0,
        },
      });
      expect(first!.request.session).toEqual(socket.sent.slice(0, 2));
      expect(second!.request.previousRequest).toBe('000001');
      expect(first!.response).toMatchObject({
        providerSessionId: 'session-fixture',
        responseId: 'first',
        eventId: 'event-done',
        text: 'wait',
        result: { triggered: false },
        usage: { input_tokens: 20 },
      });
      expect(second!.response).not.toHaveProperty('eventId');
      expect(second!.response).not.toHaveProperty('usage');
      expect(h.archiveLog).toHaveBeenCalledWith(
        'proactive.monitor_request_saved',
        expect.objectContaining({ requestDirectory: first!.directory }),
      );
      for (const event of socket.sent)
        expect(event).not.toHaveProperty('origin');
    },
  );

  it('excludes cleared and backpressured queued capture from a committed archive', async () => {
    const h = await archivedHarness();
    const socket = await h.start();
    h.feedChunk(1);
    h.monitor.resetPendingCapture();
    h.feedChunk(2);
    socket.bufferedAmount = QWEN_REALTIME_LIMITS.maxBufferedSocketBytes + 1;
    expect(h.monitor.requestEvaluation()).toBe(false);
    socket.bufferedAmount = 0;
    const index = socket.sent.length;
    expect(h.monitor.requestEvaluation()).toBe(true);
    h.feedChunk(3);
    complete(socket);
    const [archive] = await archives(h.store);
    await expectArchivedWire(archive!, socket.sent.slice(index));
    expect(wireAudio(socket.sent.slice(index))).toEqual(
      Buffer.alloc(32_000, 2),
    );
  });

  it('never invents an archive or replays uncertain media after a rejected commit', async () => {
    const h = await archivedHarness();
    const first = await h.start();
    h.feedChunk();
    first.failingTypes.add('input_audio_buffer.commit');
    expect(h.monitor.requestEvaluation()).toBe(true);
    expect(h.callbacks.onResult).toHaveBeenCalledOnce();
    expect(await archives(h.store)).toEqual([]);
    expect(h.monitor.requestEvaluation()).toBe(false);
    const second = h.sockets[1]!;
    ready(second);
    await settleReady(h, 2);
    expect(h.monitor.requestEvaluation()).toBe(false);
    h.feedChunk(2);
    expect(h.monitor.requestEvaluation()).toBe(true);
    complete(second, 'retry');
    const [archive] = await archives(h.store);
    await expectArchivedWire(archive!, second.sent.slice(2));
    expect(archive!.request).toMatchObject({
      request: 1,
      transportGeneration: 2,
    });
    expect(archive!.response).toMatchObject({
      evaluation: 2,
      transportGeneration: 2,
      responseId: 'retry',
    });
    expect(archive!.request).not.toHaveProperty('previousRequest');
    expect(wireAudio(second.sent)).toEqual(Buffer.alloc(32_000, 2));
  });

  it('does not archive failed media sends or automatically resend committed history', async () => {
    const h = await archivedHarness({ modalities: ['audio', 'vision'] });
    const first = await h.start();
    h.feedChunk(1);
    h.monitor.requestEvaluation();
    complete(first);
    h.feedChunk(2);
    first.failingTypes.add('input_image_buffer.append');
    expect(h.monitor.requestEvaluation()).toBe(false);
    expect(h.callbacks.onLifecycleError).toHaveBeenCalledOnce();
    expect(h.monitor.requestEvaluation()).toBe(false);
    const second = h.sockets[1]!;
    ready(second);
    await settleReady(h, 2);
    expect(h.monitor.requestEvaluation()).toBe(true);
    complete(second, 'second');
    const recorded = await archives(h.store);
    expect(recorded).toHaveLength(2);
    await expectArchivedWire(recorded[1]!, second.sent.slice(2));
    expect(wireAudio(second.sent)).toEqual(Buffer.alloc(32_000, 2));
    expect(recorded[1]!.request).not.toHaveProperty('previousRequest');
  });

  it('records rejected response.create without claiming it was sent', async () => {
    const h = await archivedHarness();
    const socket = await h.start();
    h.feedChunk();
    h.monitor.requestEvaluation();
    socket.failingTypes.add('response.create');
    socket.message({ type: 'input_audio_buffer.committed' });
    const [archive] = await archives(h.store);
    await expectArchivedWire(archive!, socket.sent.slice(2));
    expect(archive!.response).toMatchObject({
      status: 'failed',
      failure: { code: 'monitor_response_request_failed' },
    });
  });

  it.each(['timeout', 'close'] as const)(
    'archives unfinished requests on %s even if diagnostics throw',
    async (ending) => {
      const h = await archivedHarness({}, { evaluationTimeoutMs: 20 });
      h.archiveLog.mockImplementation(() => {
        throw new Error('observer failed');
      });
      const socket = await h.start();
      h.feedChunk();
      h.monitor.requestEvaluation();
      socket.message({ type: 'input_audio_buffer.committed' });
      socket.message({
        type: 'response.text.delta',
        response_id: 'unfinished',
        delta: 'Reply: Incomplete',
      });
      if (ending === 'timeout')
        await vi.waitFor(() =>
          expect(h.callbacks.onResult).toHaveBeenCalledOnce(),
        );
      else h.monitor.close();
      const [archive] = await archives(h.store);
      await expectArchivedWire(archive!, socket.sent.slice(2));
      expect(archive!.response).toMatchObject(
        ending === 'timeout'
          ? {
              status: 'failed',
              text: 'Reply: Incomplete',
              responseId: 'unfinished',
              failure: { code: 'monitor_evaluation_timeout' },
            }
          : { status: 'closed', incomplete: true },
      );
    },
  );

  it('redacts the connection key from archived task and response text', async () => {
    const h = await archivedHarness({
      apiKey: 'secret-key',
      instruction: 'Watch secret-key.',
    });
    const socket = await h.start();
    h.feedChunk();
    h.monitor.requestEvaluation();
    complete(socket, 'redacted', 'Reply: secret-key');
    const recorded = await archives(h.store);
    expect(JSON.stringify(recorded)).not.toContain('secret-key');
    expect(recorded[0]!.response['text']).toBe('Reply: [redacted]');
  });

  it('never creates a recorder without a debug store', async () => {
    const create = vi.spyOn(MonitorDebugStore.prototype, 'create');
    const h = harness();
    const socket = await h.start();
    h.feedChunk();
    h.monitor.requestEvaluation();
    complete(socket);
    expect(create).not.toHaveBeenCalled();
  });
});
