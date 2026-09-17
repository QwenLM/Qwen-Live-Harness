/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openQwenRealtimeSession,
  QWEN_REALTIME_LIMITS,
  type QwenRealtimeCallbacks,
  type QwenRealtimeSession,
} from './realtime-session.js';

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];
  send = vi.fn((data: string | Uint8Array) => {
    this.sent.push(JSON.parse(String(data)) as Record<string, unknown>);
  });

  close(): void {
    this.readyState = 3;
    this.emit('close', 1000, 'client');
  }

  message(message: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(message), false);
  }
}

const sessions: QwenRealtimeSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0))
    session.close({ discardPendingInput: true });
  vi.useRealTimers();
});

async function connect(callbacks: QwenRealtimeCallbacks = {}) {
  vi.useFakeTimers();
  const socket = new FakeSocket();
  const opening = openQwenRealtimeSession(
    {
      endpoint: 'wss://realtime.example.test/api-ws/v1/realtime',
      model: 'qwen3.8-omni-flash-realtime',
      callEpoch: 7,
      voice: 'Tina',
      instructions: 'Test instructions',
      tools: [],
    },
    callbacks,
    { createWebSocket: () => socket },
  );
  socket.message({
    type: 'session.created',
    event_id: 'created',
    session: { id: 'sess-heartbeat' },
  });
  socket.message({ type: 'session.updated', event_id: 'updated' });
  const session = await opening;
  sessions.push(session);
  socket.sent.length = 0;
  return { socket, session };
}

describe('muted foreground microphone heartbeat', () => {
  it('sends exactly one second of 16 kHz PCM silence every 30 seconds only while muted', async () => {
    const onInputHeartbeat = vi.fn();
    const onDialogue = vi.fn();
    const onInputCommitted = vi.fn();
    const { socket, session } = await connect({
      onInputHeartbeat,
      onDialogue,
      onInputCommitted,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.sent).toHaveLength(0);
    session.setInputMuted(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(socket.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent).toHaveLength(1);
    const first = socket.sent[0]!;
    expect(first['type']).toBe('input_audio_buffer.append');
    const audio = Buffer.from(String(first['audio']), 'base64');
    expect(audio).toHaveLength(32_000);
    expect(audio.equals(Buffer.alloc(32_000))).toBe(true);
    expect(onInputHeartbeat).toHaveBeenCalledExactlyOnceWith({
      callEpoch: 7,
      sessionId: 'sess-heartbeat',
      eventId: first['event_id'],
      bytes: 32_000,
      durationMs: 1_000,
      intervalMs: 30_000,
    });
    session.setInputMuted(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent).toHaveLength(2);
    expect(onDialogue).not.toHaveBeenCalled();
    expect(onInputCommitted).not.toHaveBeenCalled();
    expect(session.takeTranscriptTail()).toEqual([]);
    session.setInputMuted(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.sent).toHaveLength(2);
    session.setInputMuted(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent).toHaveLength(3);
  });

  it('does not commit, create responses, cancel TTS, or invent a user speech event', async () => {
    const onBargeIn = vi.fn();
    const onSpeechStarted = vi.fn();
    const onDialogue = vi.fn();
    const { socket, session } = await connect({
      onBargeIn,
      onSpeechStarted,
      onDialogue,
    });
    expect(session.speakToUser('A response already speaking.')).toBe(true);
    socket.message({ type: 'session.updated', event_id: 'speech-updated' });
    socket.message({
      type: 'response.created',
      event_id: 'response-created',
      response: { id: 'resp-speaking', status: 'in_progress' },
    });
    socket.sent.length = 0;
    session.setInputMuted(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent.map((entry) => entry['type'])).toEqual([
      'input_audio_buffer.append',
    ]);
    expect(onBargeIn).not.toHaveBeenCalled();
    expect(onSpeechStarted).not.toHaveBeenCalled();
    expect(onDialogue).not.toHaveBeenCalled();
  });

  it.each(['client', 'remote', 'provider-error'] as const)(
    'cleans up on %s closure',
    async (reason) => {
      const { socket, session } = await connect();
      session.setInputMuted(true);
      if (reason === 'client') session.close();
      else if (reason === 'remote')
        socket.emit('close', 1011, 'Backend unavailable');
      else
        socket.message({
          type: 'error',
          error: { type: 'server_error', message: 'Backend unavailable' },
        });
      const count = socket.sent.length;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(socket.sent).toHaveLength(count);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('logs a skipped heartbeat as nonfatal backpressure and retries on the next interval', async () => {
    const onError = vi.fn();
    const { socket, session } = await connect({ onError });
    socket.bufferedAmount = QWEN_REALTIME_LIMITS.maxBufferedSocketBytes + 1;
    session.setInputMuted(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'input_heartbeat_backpressure',
        fatal: false,
      }),
    );
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent).toHaveLength(1);
  });

  it.each(['closed-socket', 'send-throws'] as const)(
    'reports %s send failures and stops the heartbeat',
    async (failure) => {
      const onError = vi.fn();
      const { socket, session } = await connect({ onError });
      if (failure === 'closed-socket') socket.readyState = 3;
      else
        socket.send.mockImplementation(() => {
          throw new Error('Send failed');
        });
      session.setInputMuted(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          code:
            failure === 'closed-socket'
              ? 'input_heartbeat_send_failed'
              : 'send_failed',
          fatal: true,
        }),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
