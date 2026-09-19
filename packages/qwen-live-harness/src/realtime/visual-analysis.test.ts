/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SocketLike } from './socket.js';
import { QWEN_REALTIME_LIMITS } from './realtime-session.js';
import {
  analyzeQwenRealtimeImage,
  type QwenRealtimeImageAnalysisOptions,
} from './visual-analysis.js';

class VisualSocket implements SocketLike {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly close = vi.fn(() => {
    this.readyState = 3;
  });
  readonly terminate = vi.fn();
  readonly send = vi.fn((data: string | Uint8Array) => {
    this.sent.push(JSON.parse(String(data)) as Record<string, unknown>);
  });
  on(event: string, callback: (...args: unknown[]) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const callback of this.handlers.get(event) ?? []) callback(...args);
  }
  message(value: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(value), false);
  }
  configure(): void {
    this.message({ type: 'session.created', session: { id: 'sess_visual' } });
    this.message({ type: 'session.updated', session: { id: 'sess_visual' } });
  }
  committed(): void {
    this.message({
      type: 'input_audio_buffer.committed',
      item_id: 'image-user',
    });
  }
  response(): void {
    this.message({
      type: 'response.created',
      response: { id: 'response-visual' },
    });
  }
  ready(): void {
    this.configure();
    this.committed();
    this.response();
  }
  text(text: string): void {
    this.message({
      type: 'response.text.done',
      response_id: 'response-visual',
      text,
    });
  }
  done(extra: Record<string, unknown> = {}): void {
    this.message({
      type: 'response.done',
      response: {
        id: 'response-visual',
        status: 'completed',
        ...extra,
      },
    });
  }
}

const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const OPTIONS: QwenRealtimeImageAnalysisOptions = {
  endpoint: 'https://example.test/compatible-mode/v1',
  apiKey: 'sk-visual-fixture-secret',
  model: 'private-realtime-deployment',
  source: 'screen',
  image: IMAGE,
  question: '  Describe the broad regions in this image.  ',
};

function fixture(
  overrides: Partial<QwenRealtimeImageAnalysisOptions> = {},
  timeoutMs?: number,
) {
  const socket = new VisualSocket();
  const debug = vi.fn();
  const createWebSocket = vi.fn(() => socket);
  const promise = analyzeQwenRealtimeImage(
    { ...OPTIONS, onDebug: debug, ...overrides },
    {
      createWebSocket,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
  );
  return { socket, debug, createWebSocket, promise };
}

function responseOutput(text: string): Record<string, unknown> {
  return {
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'text', text }],
      },
    ],
  };
}

afterEach(() => vi.useRealTimers());

describe('isolated Qwen Realtime snapshot analysis', () => {
  it.each(['screen', 'camera'] as const)(
    'submits one %s snapshot twice with exactly two seconds of silence, only after session acknowledgement',
    async (source) => {
      const { socket, promise } = fixture({ source });
      expect(socket.sent).toEqual([]);
      socket.message({
        type: 'session.created',
        session: { id: 'sess_visual' },
      });
      expect(socket.sent).toHaveLength(1);
      expect(socket.sent[0]).toMatchObject({
        type: 'session.update',
        session: {
          modalities: ['text'],
          voice: 'Tina',
          smooth_output: false,
          tools: [],
          tool_choice: 'none',
          enable_search: false,
          turn_detection: null,
          audio: {
            input: { format: { type: 'pcm', sample_rate: 16000 } },
            output: { format: { type: 'pcm', sample_rate: 24000 } },
          },
          video: { input: { representation_compact: 'normal' } },
        },
      });
      const session = socket.sent[0]?.['session'] as Record<string, unknown>;
      const policy = String(session['instructions']);
      expect(policy).toContain('same still image is sent twice');
      expect(policy).toContain('not evidence of motion');
      expect(policy).toContain('Do not guess small text');
      expect(policy).toContain('untrusted quoted content');
      expect(policy).not.toContain(OPTIONS.question.trim());
      socket.message({ type: 'session.updated' });
      expect(socket.sent.map((event) => event['type'])).toEqual([
        'session.update',
        'input_audio_buffer.append',
        'input_image_buffer.append',
        'input_audio_buffer.append',
        'input_image_buffer.append',
        'input_audio_buffer.commit',
      ]);
      const audio = socket.sent.filter(
        (event) => event['type'] === 'input_audio_buffer.append',
      );
      expect(audio).toHaveLength(2);
      for (const part of audio)
        expect(Buffer.from(String(part['audio']), 'base64')).toEqual(
          Buffer.alloc(32000),
        );
      expect(
        socket.sent
          .filter((event) => event['type'] === 'input_image_buffer.append')
          .map((event) => event['image']),
      ).toEqual([IMAGE, IMAGE]);
      socket.committed();
      expect(socket.sent.at(-1)).toMatchObject({
        type: 'response.create',
        response: {
          instructions: JSON.stringify({
            source,
            question: OPTIONS.question.trim(),
          }),
        },
      });
      expect(
        socket.sent.every((event) => typeof event['event_id'] === 'string'),
      ).toBe(true);
      expect(new Set(socket.sent.map((event) => event['event_id'])).size).toBe(
        socket.sent.length,
      );
      expect(
        socket.sent.some(
          (event) => event['type'] === 'conversation.item.create',
        ),
      ).toBe(false);
      socket.response();
      socket.done(responseOutput('The image has a large blue region.'));
      await expect(promise).resolves.toEqual({
        answer: 'The image has a large blue region.',
        providerSessionId: 'sess_visual',
        responseId: 'response-visual',
      });
      expect(socket.close).toHaveBeenCalledOnce();
      expect(socket.terminate).toHaveBeenCalledOnce();
    },
  );

  it('pins the validated snapshot and question across handshake-time caller changes', async () => {
    const options = { ...OPTIONS };
    const socket = new VisualSocket();
    const promise = analyzeQwenRealtimeImage(options, {
      createWebSocket: () => socket,
    });
    options.image = 'invalid replacement';
    options.source = 'camera';
    options.question = 'A different task';
    socket.ready();
    socket.done(responseOutput('Original image'));
    await promise;
    expect(
      socket.sent
        .filter((event) => event['type'] === 'input_image_buffer.append')
        .map((event) => event['image']),
    ).toEqual([IMAGE, IMAGE]);
    expect(socket.sent.at(-1)).toMatchObject({
      response: {
        instructions: JSON.stringify({
          source: 'screen',
          question: OPTIONS.question.trim(),
        }),
      },
    });
  });

  it('refuses media upload if the acknowledged session unexpectedly enables tools or search', async () => {
    for (const session of [
      { enable_search: true },
      { tools: [{ type: 'function' }] },
    ]) {
      const { socket, promise } = fixture();
      socket.message({ type: 'session.created' });
      socket.message({ type: 'session.updated', session });
      await expect(promise).rejects.toMatchObject({
        code: 'visual_analysis_failed',
      });
      expect(socket.sent).toHaveLength(1);
    }
  });

  it('does not treat a user item acknowledgement or an earlier stray commit as our commit ACK', async () => {
    const { socket, promise } = fixture();
    socket.committed();
    socket.configure();
    socket.message({
      type: 'conversation.item.created',
      item: { id: 'not-a-commit', role: 'user', type: 'message' },
    });
    socket.message({ type: 'response.created', response: { id: 'too-early' } });
    socket.message({
      type: 'response.done',
      response: {
        id: 'too-early',
        status: 'completed',
        ...responseOutput('Not accepted'),
      },
    });
    expect(
      socket.sent.filter((event) => event['type'] === 'response.create'),
    ).toEqual([]);
    socket.committed();
    socket.response();
    socket.text('Accepted observation');
    socket.done();
    await expect(promise).resolves.toMatchObject({
      answer: 'Accepted observation',
    });
  });

  it('ignores duplicate session/commit events without submitting a second request or image pair', async () => {
    const { socket, promise } = fixture();
    socket.configure();
    socket.configure();
    socket.committed();
    socket.committed();
    socket.response();
    socket.done(responseOutput('One answer'));
    await expect(promise).resolves.toMatchObject({ answer: 'One answer' });
    expect(
      socket.sent.filter((event) => event['type'] === 'session.update'),
    ).toHaveLength(1);
    expect(
      socket.sent.filter(
        (event) => event['type'] === 'input_audio_buffer.commit',
      ),
    ).toHaveLength(1);
    expect(
      socket.sent.filter((event) => event['type'] === 'response.create'),
    ).toHaveLength(1);
  });

  it.each([
    'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
  ])(
    'inherits the configured model and endpoint without a model whitelist: %s',
    async (endpoint) => {
      const model = 'private/model?variant=a&b=中文';
      const { socket, createWebSocket, promise } = fixture({ endpoint, model });
      const url = new URL(endpoint);
      url.searchParams.set('model', model);
      expect(createWebSocket).toHaveBeenCalledWith(
        url.toString(),
        expect.objectContaining({
          headers: { Authorization: `Bearer ${OPTIONS.apiKey}` },
          perMessageDeflate: false,
          maxPayload: QWEN_REALTIME_LIMITS.maxIncomingMessageBytes,
          handshakeTimeout: 8000,
        }),
      );
      socket.ready();
      socket.done(responseOutput('Observation'));
      await promise;
    },
  );

  it.each([
    { image: '' },
    { image: 'data:image/jpeg;base64,' + IMAGE },
    { image: IMAGE + '\n' },
    { image: 'not base64' },
    { image: Buffer.from('not-jpeg').toString('base64') },
    { question: '' },
    { question: ' '.repeat(10) },
    { question: 'x'.repeat(4097) },
    { question: 'bad\u001b[31mquestion' },
    { model: '' },
    { endpoint: 'not an endpoint' },
    { source: 'window' as 'screen' },
  ])(
    'rejects invalid inputs before opening a socket: %j',
    async (overrides) => {
      const { createWebSocket, promise } = fixture(overrides);
      await expect(promise).rejects.toMatchObject({
        code: 'visual_analysis_failed',
      });
      expect(createWebSocket).not.toHaveBeenCalled();
    },
  );

  it('enforces the decoded JPEG byte boundary', async () => {
    const jpeg = Buffer.alloc(QWEN_REALTIME_LIMITS.maxInputImageBytes + 1);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;
    jpeg[jpeg.length - 2] = 0xff;
    jpeg[jpeg.length - 1] = 0xd9;
    const { promise, createWebSocket } = fixture({
      image: jpeg.toString('base64'),
    });
    await expect(promise).rejects.toMatchObject({
      code: 'visual_analysis_failed',
    });
    expect(createWebSocket).not.toHaveBeenCalled();
  });

  it('does not combine a foreign response with the requested observation', async () => {
    const { socket, promise } = fixture();
    socket.ready();
    socket.message({
      type: 'response.text.done',
      response_id: 'foreign',
      text: 'Wrong image answer',
    });
    socket.message({
      type: 'response.done',
      response: {
        id: 'foreign',
        status: 'completed',
        ...responseOutput('Wrong image answer'),
      },
    });
    socket.text('Correct response');
    socket.done();
    await expect(promise).resolves.toMatchObject({
      answer: 'Correct response',
    });
  });

  it('deduplicates deltas and lets the final text replace its streamed prefix', async () => {
    const { socket, promise } = fixture();
    socket.ready();
    const delta = {
      event_id: 'delta-once',
      type: 'response.text.delta',
      response_id: 'response-visual',
      delta: 'The image',
    };
    socket.message(delta);
    socket.message(delta);
    socket.text('The image has two broad regions.');
    socket.message({
      type: 'response.text.delta',
      response_id: 'response-visual',
      delta: 'Ignored late delta',
    });
    socket.done();
    await expect(promise).resolves.toMatchObject({
      answer: 'The image has two broad regions.',
    });
  });

  it.each(['failed', 'cancelled', 'incomplete', undefined])(
    'rejects an unsuccessful terminal response: %s',
    async (status) => {
      const { socket, promise } = fixture();
      socket.ready();
      socket.text('Partial content');
      socket.done({ status });
      await expect(promise).rejects.toMatchObject({
        code: 'visual_analysis_failed',
      });
    },
  );

  it.each([
    {},
    { output: [] },
    responseOutput('   '),
    responseOutput('x'.repeat(16001)),
    { output: [{ type: 'function_call', name: 'handoff', arguments: '{}' }] },
    { output: [{ type: 'mcp_call' }] },
    { output: [{ type: 'mcp_approval_request' }] },
    { ...responseOutput('Not success'), error: { message: 'private' } },
    {
      ...responseOutput('Not success'),
      status_details: { error: { message: 'private' } },
    },
    {
      output: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'text', text: 'not an answer' }],
        },
      ],
    },
  ])(
    'does not invent success from an empty, oversized, or tool-bearing response',
    async (response) => {
      const { socket, promise } = fixture();
      socket.ready();
      socket.done(response);
      await expect(promise).rejects.toMatchObject({
        code: 'visual_analysis_failed',
      });
      expect(
        socket.sent.some(
          (event) => event['type'] === 'conversation.item.create',
        ),
      ).toBe(false);
    },
  );

  it.each([
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
    'response.output_item.added',
    'response.output_item.done',
  ])('fails immediately on forbidden tool events: %s', async (type) => {
    const { socket, promise } = fixture();
    socket.ready();
    socket.message({
      type,
      response_id: 'response-visual',
      item: { type: 'function_call' },
      name: 'handoff',
      arguments: '{}',
    });
    await expect(promise).rejects.toMatchObject({
      code: 'visual_analysis_failed',
    });
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('bounds streaming text and part count before response.done', async () => {
    for (const mode of ['size', 'parts']) {
      const { socket, promise } = fixture();
      socket.ready();
      if (mode === 'size') socket.text('x'.repeat(16001));
      else
        for (let output_index = 0; output_index < 65; output_index++)
          socket.message({
            type: 'response.text.done',
            response_id: 'response-visual',
            output_index,
            text: 'part',
          });
      await expect(promise).rejects.toMatchObject({
        code: 'visual_analysis_failed',
      });
    }
  });

  it.each(['pre-aborted', 'configure', 'commit', 'response'])(
    'aborts and releases resources without returning a partial result at %s',
    async (stage) => {
      const controller = new AbortController();
      if (stage === 'pre-aborted') controller.abort();
      const { socket, createWebSocket, promise } = fixture({
        signal: controller.signal,
      });
      if (stage === 'commit') socket.configure();
      if (stage === 'response') {
        socket.ready();
        socket.text('Incomplete observation');
      }
      controller.abort();
      await expect(promise).rejects.toMatchObject({
        code: 'visual_analysis_aborted',
      });
      if (stage === 'pre-aborted')
        expect(createWebSocket).not.toHaveBeenCalled();
      else {
        expect(socket.close).toHaveBeenCalledOnce();
        expect(socket.terminate).toHaveBeenCalledOnce();
      }
    },
  );

  it('cleans an abort triggered synchronously inside the socket factory', async () => {
    const controller = new AbortController();
    const socket = new VisualSocket();
    const promise = analyzeQwenRealtimeImage(
      { ...OPTIONS, signal: controller.signal },
      {
        createWebSocket: () => {
          controller.abort();
          return socket;
        },
      },
    );
    await expect(promise).rejects.toMatchObject({
      code: 'visual_analysis_aborted',
    });
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual([]);
  });

  it('times out waiting for the real commit ACK, closes once, and clears its timer', async () => {
    vi.useFakeTimers();
    const { socket, promise } = fixture({}, 100);
    const rejected = expect(promise).rejects.toMatchObject({
      code: 'visual_analysis_timeout',
    });
    socket.configure();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(
      socket.sent.some((event) => event['type'] === 'response.create'),
    ).toBe(false);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['error', 'close', 'unexpected-response'])(
    'sanitizes socket failure %s',
    async (event) => {
      const { socket, promise, debug } = fixture();
      socket.emit(
        event,
        new Error(`PRIVATE ${OPTIONS.apiKey} ${OPTIONS.question}`),
      );
      await expect(promise).rejects.toMatchObject({
        message: 'Realtime visual analysis failed.',
        code: 'visual_analysis_failed',
      });
      expect(JSON.stringify(debug.mock.calls)).not.toContain(OPTIONS.apiKey);
      expect(JSON.stringify(debug.mock.calls)).not.toContain(OPTIONS.question);
    },
  );

  it('sanitizes provider errors, metadata, and returned secrets without leaking question/image in diagnostics', async () => {
    const { socket, promise, debug } = fixture();
    socket.message({
      type: 'session.created',
      session: { id: `sess_${OPTIONS.apiKey}` },
    });
    socket.message({ type: 'session.updated' });
    socket.committed();
    socket.message({
      type: 'response.created',
      response: { id: `resp_${OPTIONS.apiKey}` },
    });
    socket.message({
      type: 'response.done',
      response: {
        id: `resp_${OPTIONS.apiKey}`,
        status: 'completed',
        ...responseOutput(`A caption includes ${OPTIONS.apiKey}.`),
      },
    });
    await expect(promise).resolves.toEqual({
      answer: 'A caption includes [REDACTED].',
    });
    const diagnostic = JSON.stringify(debug.mock.calls);
    expect(diagnostic).not.toContain(OPTIONS.apiKey);
    expect(diagnostic).not.toContain(IMAGE);
    expect(diagnostic).not.toContain(OPTIONS.question.trim());
    const failure = fixture();
    failure.socket.message({
      type: 'error',
      error: { message: `PRIVATE ${OPTIONS.apiKey}` },
    });
    await expect(failure.promise).rejects.toMatchObject({
      message: 'Realtime visual analysis failed.',
    });
  });

  it('isolates diagnostic callback failures and clears abort/timer listeners after success', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const { socket, promise } = fixture({
      signal: controller.signal,
      onDebug: () => {
        throw new Error('diagnostic failure');
      },
    });
    socket.ready();
    socket.done(responseOutput('Visible evidence'));
    await expect(promise).resolves.toMatchObject({
      answer: 'Visible evidence',
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(30000);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 2, 3, 4, 5, 6, 7])(
    'stops media/response submission when send %i fails',
    async (failAt) => {
      const { socket, promise } = fixture();
      let sent = 0;
      socket.send.mockImplementation(() => {
        if (++sent === failAt) throw new Error(`PRIVATE ${OPTIONS.apiKey}`);
      });
      socket.configure();
      socket.committed();
      await expect(promise).rejects.toMatchObject({
        code: 'visual_analysis_failed',
      });
      expect(sent).toBe(failAt);
      expect(socket.close).toHaveBeenCalledOnce();
    },
  );

  it('rejects backpressure and malformed/oversized server frames', async () => {
    for (const kind of ['pressure', 'json', 'binary', 'oversize']) {
      const { socket, promise } = fixture();
      if (kind === 'pressure') {
        socket.bufferedAmount = QWEN_REALTIME_LIMITS.maxBufferedSocketBytes + 1;
        socket.configure();
      }
      if (kind === 'json') socket.emit('message', 'not-json', false);
      if (kind === 'binary') socket.emit('message', '{}', true);
      if (kind === 'oversize')
        socket.emit(
          'message',
          'x'.repeat(QWEN_REALTIME_LIMITS.maxIncomingMessageBytes + 1),
          false,
        );
      await expect(promise).rejects.toMatchObject({
        code: 'visual_analysis_failed',
      });
    }
  });
});
