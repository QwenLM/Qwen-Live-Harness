/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLiveSessionTools } from '../tools/definitions.js';
import { openQwenRealtimeSession } from './realtime-session.js';

const REJECTED_SPEECH =
  'Input speech was not accepted by semantic turn detection';

class Socket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];

  send(data: string | Uint8Array): void {
    this.sent.push(JSON.parse(String(data)) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
  }

  message(event: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(event), false);
  }

  get requests(): Record<string, unknown>[] {
    return this.sent.filter((event) => event['type'] === 'response.create');
  }
}

afterEach(() => vi.useRealTimers());

async function connect() {
  const socket = new Socket();
  const callbacks = {
    onInputCommitted: vi.fn(),
    onInputRejected: vi.fn(),
    onInputTranscriptDelta: vi.fn(),
    onInputTranscriptDone: vi.fn(),
    onDialogue: vi.fn(),
    onRecoveryNeeded: vi.fn(),
    onFunctionCall: vi.fn(),
    onResponseCreated: vi.fn(),
    onResponseDone: vi.fn(),
    onOutputAudioDelta: vi.fn(),
    onError: vi.fn(),
  };
  const opening = openQwenRealtimeSession(
    {
      endpoint: 'wss://dashscope.example/realtime',
      apiKey: 'synthetic-semantic-key',
      model: 'qwen3.8-omni-flash-realtime',
      callEpoch: 1,
      instructions: 'Synthetic semantic VAD tests.',
      tools: buildLiveSessionTools(true, true, true),
    },
    callbacks,
    {
      createWebSocket: () => socket,
      responseCreatedTimeoutMs: 100,
      responseDoneTimeoutMs: 100,
    },
  );
  socket.message({ type: 'session.created', session: { id: 'sess-semantic' } });
  socket.message({ type: 'session.updated', session: {} });
  return { socket, callbacks, session: await opening };
}

function speech(socket: Socket, itemId: string): void {
  socket.message({
    type: 'input_audio_buffer.speech_started',
    item_id: itemId,
  });
  socket.message({
    type: 'input_audio_buffer.speech_stopped',
    item_id: itemId,
  });
  socket.message({ type: 'input_audio_buffer.committed', item_id: itemId });
  socket.message({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: '请看看屏幕。',
  });
}

function rejected(socket: Socket, requestEventId?: unknown): void {
  socket.message({
    type: 'error',
    event_id: 'event-provider-semantic-rejection',
    error: {
      type: 'invalid_request_error',
      message: REJECTED_SPEECH,
      ...(requestEventId !== undefined ? { event_id: requestEventId } : {}),
    },
  });
}

describe('semantic VAD input acceptance and request rejection', () => {
  it('attaches only the bound recovered real-user transcript to a narration tool event', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      const source = '请用英语持续描述屏幕。';
      expect(
        session.resumeUserText?.({
          itemId: 'recovered-real-user',
          text: source,
        }),
      ).toBe(true);
      socket.message({
        type: 'response.created',
        response: { id: 'narration' },
      });
      socket.message({
        type: 'response.done',
        response: {
          id: 'narration',
          status: 'completed',
          output: [
            {
              id: 'narration-tool',
              type: 'function_call',
              status: 'completed',
              call_id: 'narration-call',
              name: 'create_live_narration',
              arguments:
                '{"title":"Screen","modalities":["vision"],"narration_focus":"Screen changes"}',
            },
          ],
        },
      });
      expect(callbacks.onFunctionCall).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          inputItemId: 'recovered-real-user',
          inputTranscript: source,
          name: 'create_live_narration',
        }),
      );
      expect(callbacks.onInputTranscriptDone).not.toHaveBeenCalled();
    } finally {
      session.close({ discardPendingInput: true });
    }
  });
  it('does not turn an early audio item announcement into a committed speech turn', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      socket.message({
        type: 'input_audio_buffer.speech_started',
        item_id: 'input-1',
      });
      socket.message({
        type: 'conversation.item.created',
        item: {
          id: 'input-1',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_audio' }],
        },
      });
      expect(socket.requests).toHaveLength(0);
      expect(callbacks.onInputCommitted).not.toHaveBeenCalled();
      socket.message({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'input-1',
      });
      expect(socket.requests).toHaveLength(0);
      socket.message({
        type: 'input_audio_buffer.committed',
        item_id: 'input-1',
      });
      expect(socket.requests).toHaveLength(1);
      expect(callbacks.onInputCommitted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ itemId: 'input-1', responsePending: true }),
      );
      socket.message({
        type: 'input_audio_buffer.committed',
        item_id: 'input-1',
      });
      expect(socket.requests).toHaveLength(1);
      expect(callbacks.onInputCommitted).toHaveBeenCalledTimes(1);
    } finally {
      session.close({ discardPendingInput: true });
    }
  });

  it.each([true, false])(
    'keeps an acknowledged appshot and the connection after its continuation is rejected (request reference: %s)',
    async (explicitReference) => {
      vi.useFakeTimers();
      const { socket, callbacks, session } = await connect();
      try {
        speech(socket, 'input-original');
        socket.message({
          type: 'response.created',
          response: { id: 'response-original' },
        });
        socket.message({
          type: 'response.done',
          response: {
            id: 'response-original',
            status: 'completed',
            output: [
              {
                id: 'item-appshot',
                type: 'function_call',
                status: 'completed',
                name: 'appshot',
                call_id: 'call-appshot',
                arguments: '{}',
              },
            ],
          },
        });
        expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
        expect(
          session.submitFunctionOutput(
            { callEpoch: 1, callId: 'call-appshot' },
            '{"status":"ok","source":"screen","asset":"asset_1"}',
          ),
        ).toBe(true);
        socket.message({
          type: 'conversation.item.created',
          item: {
            id: 'output-appshot',
            type: 'function_call_output',
            call_id: 'call-appshot',
            status: 'completed',
          },
        });
        await Promise.resolve();
        expect(socket.requests).toHaveLength(2);
        rejected(
          socket,
          explicitReference ? socket.requests[1]!['event_id'] : undefined,
        );
        expect(socket.readyState).toBe(socket.OPEN);
        expect(callbacks.onError).toHaveBeenLastCalledWith(
          expect.objectContaining({ fatal: false }),
        );
        expect(callbacks.onResponseDone).toHaveBeenLastCalledWith(
          expect.objectContaining({
            authority: 'tool_continuation',
            status: 'failed',
          }),
        );
        expect(callbacks.onInputRejected).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(150);
        expect(socket.readyState).toBe(socket.OPEN);
        expect(socket.requests).toHaveLength(2);
        speech(socket, 'input-next');
        expect(socket.requests).toHaveLength(3);
        socket.message({
          type: 'response.created',
          response: { id: 'response-next' },
        });
        expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
          expect.objectContaining({
            responseId: 'response-next',
            authority: 'direct',
            inputItemId: 'input-next',
          }),
        );
        socket.message({
          type: 'response.audio.delta',
          response_id: 'response-next',
          delta: Buffer.from([1, 0, 2, 0]).toString('base64'),
        });
        socket.message({
          type: 'response.done',
          response: { id: 'response-next', status: 'completed', output: [] },
        });
        expect(callbacks.onOutputAudioDelta).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ responseId: 'response-next' }),
        );
        expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
        expect(
          socket.sent.filter(
            (event) =>
              (event['item'] as Record<string, unknown> | undefined)?.[
                'type'
              ] === 'function_call_output',
          ),
        ).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(150);
        expect(socket.readyState).toBe(socket.OPEN);
      } finally {
        session.close({ discardPendingInput: true });
      }
    },
  );

  it('does not retire or rebind the current pending request on an unrelated error event reference', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      speech(socket, 'input-current');
      expect(socket.requests).toHaveLength(1);
      rejected(socket, 'event-another-old-client-request');
      expect(socket.readyState).toBe(socket.OPEN);
      expect(callbacks.onResponseDone).not.toHaveBeenCalled();
      expect(callbacks.onInputRejected).not.toHaveBeenCalled();
      socket.message({
        type: 'response.created',
        response: { id: 'response-current' },
      });
      expect(callbacks.onResponseCreated).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          responseId: 'response-current',
          authority: 'direct',
          inputItemId: 'input-current',
        }),
      );
      socket.message({
        type: 'response.done',
        response: { id: 'response-current', status: 'completed', output: [] },
      });
      expect(callbacks.onResponseDone).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          responseId: 'response-current',
          status: 'completed',
        }),
      );
    } finally {
      session.close({ discardPendingInput: true });
    }
  });

  it('keeps authentication errors fatal instead of broadly downgrading provider failures', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      socket.message({
        type: 'error',
        error: {
          type: 'authentication_error',
          code: 'invalid_api_key',
          message: 'The API key is invalid.',
        },
      });
      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ fatal: true, code: 'invalid_api_key' }),
      );
      expect(socket.readyState).toBe(3);
    } finally {
      session.close({ discardPendingInput: true });
    }
  });

  it('releases an uncommitted VAD candidate and ignores its late transcript, failure and commit events', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      socket.message({
        type: 'input_audio_buffer.speech_started',
        item_id: 'input-rejected',
      });
      rejected(socket);
      expect(callbacks.onInputRejected).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          itemId: 'input-rejected',
          reason: 'semantic_vad',
        }),
      );
      expect(callbacks.onResponseDone).not.toHaveBeenCalled();
      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          fatal: false,
          code: 'semantic_turn_rejected',
        }),
      );
      socket.message({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'input-rejected',
        delta: 'rejected noise',
      });
      socket.message({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'input-rejected',
        transcript: 'rejected noise',
      });
      socket.message({
        type: 'conversation.item.input_audio_transcription.failed',
        item_id: 'input-rejected',
        error: { message: 'rejected noise' },
      });
      socket.message({
        type: 'input_audio_buffer.committed',
        item_id: 'input-rejected',
      });
      expect(socket.requests).toHaveLength(0);
      expect(callbacks.onInputCommitted).not.toHaveBeenCalled();
      expect(callbacks.onInputTranscriptDelta).not.toHaveBeenCalled();
      expect(callbacks.onInputTranscriptDone).not.toHaveBeenCalled();
      expect(callbacks.onDialogue).not.toHaveBeenCalled();
      expect(callbacks.onError).toHaveBeenCalledTimes(1);
      expect(
        socket.sent.some(
          (event) => event['type'] === 'input_audio_buffer.clear',
        ),
      ).toBe(false);
      speech(socket, 'input-next');
      expect(socket.requests).toHaveLength(1);
      expect(callbacks.onInputTranscriptDone).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ itemId: 'input-next' }),
      );
      expect(socket.readyState).toBe(socket.OPEN);
    } finally {
      session.close({ discardPendingInput: true });
    }
  });

  it('does not discard an uncommitted candidate when a semantic error explicitly references an unrelated request', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      socket.message({
        type: 'input_audio_buffer.speech_started',
        item_id: 'input-still-speaking',
      });
      rejected(socket, 'unknown-old-request');
      expect(callbacks.onInputRejected).not.toHaveBeenCalled();
      expect(callbacks.onResponseDone).not.toHaveBeenCalled();
      expect(socket.requests).toHaveLength(0);
      socket.message({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'input-still-speaking',
      });
      socket.message({
        type: 'input_audio_buffer.committed',
        item_id: 'input-still-speaking',
      });
      socket.message({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'input-still-speaking',
        transcript: 'Keep the real user input.',
      });
      expect(socket.requests).toHaveLength(1);
      expect(callbacks.onInputCommitted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ itemId: 'input-still-speaking' }),
      );
      expect(callbacks.onInputTranscriptDone).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          itemId: 'input-still-speaking',
          text: 'Keep the real user input.',
        }),
      );
      expect(socket.readyState).toBe(socket.OPEN);
    } finally {
      session.close({ discardPendingInput: true });
    }
  });

  it('does not let a rejected old commit replace the newer recovery input', async () => {
    vi.useFakeTimers();
    const { socket, callbacks, session } = await connect();
    try {
      socket.message({
        type: 'input_audio_buffer.speech_started',
        item_id: 'input-rejected',
      });
      rejected(socket);
      speech(socket, 'input-newer');
      socket.message({
        type: 'input_audio_buffer.committed',
        item_id: 'input-rejected',
      });
      socket.message({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'input-rejected',
        transcript: 'Never replay this rejected input.',
      });
      expect(socket.requests).toHaveLength(1);
      expect(callbacks.onInputTranscriptDone).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ itemId: 'input-newer' }),
      );
      await vi.advanceTimersByTimeAsync(150);
      expect(callbacks.onRecoveryNeeded).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          code: 'response_created_timeout',
          responseId: expect.stringMatching(/^unacknowledged-/),
          input: { kind: 'text', itemId: 'input-newer', text: '请看看屏幕。' },
        }),
      );
      expect(callbacks.onFunctionCall).not.toHaveBeenCalled();
    } finally {
      session.close({ discardPendingInput: true });
    }
  });
});
