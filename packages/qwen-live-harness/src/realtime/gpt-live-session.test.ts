/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gptLiveUrl, openGptLiveSession } from './gpt-live-session.js';

class Socket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(data: string | Uint8Array): void {
    this.sent.push(JSON.parse(String(data)));
  }
  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
  message(event: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(event), false);
  }
}

async function fixture() {
  const socket = new Socket();
  const callbacks = {
    onAudio: vi.fn(),
    onTranscript: vi.fn(),
    onDelegation: vi.fn(),
    onResponse: vi.fn(),
    onAppend: vi.fn(),
    onUsage: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
  const opening = openGptLiveSession(
    {
      endpoint: 'https://api.openai.com',
      apiKey: 'fake-key',
      model: 'gpt-live-1',
      instructions: 'Be concise.',
      responses: { model: 'gpt-6-luna', instructions: 'Use tools.', tools: [] },
    },
    callbacks,
    { createSocket: () => socket, timeoutMs: 1000 },
  );
  socket.emit('open');
  socket.message({
    type: 'session.started',
    session: {
      id: 'live_1',
      audio: { format: { type: 'audio/pcm', rate: 16000 } },
    },
  });
  return { socket, callbacks, session: await opening };
}

afterEach(() => vi.useRealTimers());

describe('GPT Live transport', () => {
  it('streams and appends while output is active without a voice response command', async () => {
    const { socket, callbacks, session } = await fixture();
    socket.message({
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(640).toString('base64'),
    });
    expect(session.pushAudio(Buffer.alloc(640))).toBe(true);
    expect(session.append('thinking', 'The background lookup finished.')).toBe(
      true,
    );
    expect(
      session.append('instructions', 'Use the corrected result now.'),
    ).toBe(true);
    expect(callbacks.onAudio).toHaveBeenCalledOnce();
    expect(socket.sent.map((e) => e['type'])).toEqual([
      'session.start',
      'session.input_audio.append',
      'session.thinking.append',
      'session.instructions.append',
    ]);
    const close = session.close();
    socket.message({ type: 'session.closed', usage: { seconds: 12 } });
    expect(await close).toBe(true);
    expect(callbacks.onUsage).toHaveBeenCalledWith(12, true);
  });

  it('retains overlapping transcript intervals and deduplicates delegations', async () => {
    const { socket, callbacks, session } = await fixture();
    socket.message({
      type: 'session.input_transcript.delta',
      delta: 'Thursday',
      start_ms: 1000,
      end_ms: 1200,
    });
    socket.message({
      type: 'session.output_transcript.delta',
      delta: 'Let me check',
      start_ms: 1100,
      end_ms: 1400,
    });
    const event = {
      type: 'session.delegation.created',
      offset_ms: 1200,
      delegation: { id: 'item_1', target: 'responses' },
    };
    socket.message(event);
    socket.message(event);
    expect(
      callbacks.onTranscript.mock.calls.map(([f]) => [f.role, f.startMs]),
    ).toEqual([
      ['user', 1000],
      ['assistant', 1100],
    ]);
    expect(callbacks.onDelegation).toHaveBeenCalledOnce();
    expect(session.append('commentary', 'Found it.', 'unknown')).toBe(false);
    expect(session.append('commentary', 'Found it.', 'item_1')).toBe(false);
    expect(session.append('commentary', 'Found it.')).toBe(true);
    socket.close();
  });

  it('uses managed Responses tools and forwards only known delegation envelopes', async () => {
    const { socket, session, callbacks } = await fixture();
    expect(socket.sent[0]).toMatchObject({
      session: {
        delegation: {
          type: 'responses',
          responses: { model: 'gpt-6-luna', parallel_tool_calls: false },
        },
      },
    });
    socket.message({
      type: 'response.event',
      delegation_id: 'unknown',
      event: { type: 'response.created' },
    });
    expect(callbacks.onResponse).not.toHaveBeenCalled();
    socket.message({
      type: 'session.delegation.created',
      offset_ms: 1000,
      delegation: { id: 'd1', target: 'responses' },
    });
    socket.message({
      type: 'response.event',
      delegation_id: 'd1',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'c1',
          name: 'session_list',
          arguments: '{}',
        },
      },
    });
    expect(callbacks.onResponse).toHaveBeenCalledOnce();
    expect(
      session.submitToolOutputs([
        { callId: 'c1', output: '{}' },
        { callId: 'c2', output: '{}' },
      ]),
    ).toBe(true);
    expect(socket.sent.slice(-3).map((e) => e['type'])).toEqual([
      'response.item.create',
      'response.item.create',
      'response.create',
    ]);
    socket.message({
      type: 'error',
      error: {
        client_event_id: socket.sent.at(-1)!['event_id'],
        code: 'tool_outputs_required',
      },
    });
    expect(callbacks.onError).toHaveBeenLastCalledWith(
      expect.any(Error),
      false,
    );
    socket.message({
      type: 'error',
      error: { code: 'responses_validation_failed' },
    });
    expect(callbacks.onError).toHaveBeenLastCalledWith(
      expect.any(Error),
      false,
    );
    expect(socket.readyState).toBe(1);
    expect(
      session.configureResponses({ instructions: 'Changed tools', tools: [] }),
    ).toBe(true);
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'session.update',
      session: {
        delegation: { responses: { instructions: 'Changed tools', tools: [] } },
      },
    });
    socket.close();
    expect(session.submitToolOutputs([{ callId: 'late', output: '{}' }])).toBe(
      false,
    );
  });

  it('correlates append acknowledgments and never treats them as audio completion', async () => {
    const { socket, callbacks, session } = await fixture();
    session.append('thinking', '中文事实'.repeat(80));
    const commands = socket.sent.filter(
      (e) => e['type'] === 'session.thinking.append',
    );
    expect(commands.length).toBeGreaterThan(1);
    for (const command of commands) {
      expect(Buffer.byteLength(String(command['content']))).toBeLessThanOrEqual(
        480,
      );
      socket.message({
        type: 'session.thinking.appended',
        client_event_id: command['event_id'],
        start_ms: 0,
        end_ms: 100,
      });
    }
    expect(callbacks.onAppend).toHaveBeenCalledTimes(commands.length);
    expect(callbacks.onAudio).not.toHaveBeenCalled();
    socket.close();
  });

  it('reports close without session.closed as unconfirmed and bounds finalization', async () => {
    vi.useFakeTimers();
    const { socket, session } = await fixture();
    const close = session.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await close).toBe(false);
    expect(socket.readyState).toBe(3);
  });

  it('drains queued background context when microphone transport resumes', async () => {
    const { socket, session } = await fixture();
    socket.bufferedAmount = 2 * 1024 * 1024;
    expect(
      session.append('thinking', 'The lookup returned a corrected URL.'),
    ).toBe(true);
    expect(socket.sent).toHaveLength(1);
    socket.bufferedAmount = 0;
    session.pushAudio(Buffer.alloc(640));
    expect(socket.sent.map((e) => e['type'])).toEqual([
      'session.start',
      'session.thinking.append',
      'session.input_audio.append',
    ]);
    socket.close();
  });

  it('continues paced silence and background context transport while input is muted', async () => {
    vi.useFakeTimers();
    const { socket, session } = await fixture();
    session.setInputMuted(true);
    socket.bufferedAmount = 2 * 1024 * 1024;
    expect(session.append('commentary', 'The test finished.')).toBe(true);
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(60);
    expect(
      socket.sent.filter((e) => e['type'] === 'session.input_audio.append'),
    ).toHaveLength(3);
    expect(
      socket.sent.filter((e) => e['type'] === 'session.commentary.append'),
    ).toHaveLength(1);
    session.setInputMuted(false);
    const count = socket.sent.length;
    await vi.advanceTimersByTimeAsync(60);
    expect(socket.sent).toHaveLength(count);
    socket.close();
  });

  it('rejects work after transport closure and ignores late errors and output', async () => {
    vi.useFakeTimers();
    const { socket, session, callbacks } = await fixture();
    socket.close();
    expect(session.append('thinking', 'Late result.')).toBe(false);
    expect(session.pushAudio(Buffer.alloc(640))).toBe(false);
    session.setInputMuted(true);
    socket.emit('error', new Error('Late transport error'));
    socket.message({
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(640).toString('base64'),
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(socket.sent).toHaveLength(1);
    expect(callbacks.onClose).toHaveBeenCalledOnce();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onAudio).not.toHaveBeenCalled();
    expect(await session.close()).toBe(false);
  });

  it('rejects unsupported PCM negotiation before playing any bytes', async () => {
    const socket = new Socket();
    const onAudio = vi.fn();
    const promise = openGptLiveSession(
      {
        endpoint: 'http://127.0.0.1',
        apiKey: 'fake',
        model: 'gpt-live-1',
        instructions: '',
        responses: { model: 'gpt-6-luna', instructions: '', tools: [] },
      },
      {
        onAudio,
        onTranscript: vi.fn(),
        onDelegation: vi.fn(),
        onResponse: vi.fn(),
        onError: vi.fn(),
        onClose: vi.fn(),
      },
      { createSocket: () => socket },
    );
    socket.emit('open');
    socket.message({
      type: 'session.started',
      session: {
        id: 'bad',
        audio: { format: { type: 'audio/pcm', rate: 24000 } },
      },
    });
    await expect(promise).rejects.toThrow('16 kHz');
    expect(onAudio).not.toHaveBeenCalled();
  });

  it('keeps credentials off URLs and requires TLS away from loopback', () => {
    expect(gptLiveUrl('https://api.openai.com/v1')).toBe(
      'wss://api.openai.com/v1/live/sessions',
    );
    expect(() => gptLiveUrl('http://example.com')).toThrow('encrypted');
    expect(() => gptLiveUrl('https://example.com?key=secret')).toThrow('query');
  });
});
