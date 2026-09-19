/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { MemoryDialogueCollector } from '../memory/dialogue.js';
import { memoryContextMessage, MEMORY_TOOLS } from '../memory/tools.js';
import {
  openQwenRealtimeSession,
  MAX_REALTIME_INSTRUCTIONS_CHARS,
  QwenRealtimeError,
  QWEN_REALTIME_LIMITS,
  type QwenRealtimeCallbacks,
} from './realtime-session.js';

class MemorySocket {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  readonly outputs = new Map<string, Array<Record<string, unknown>>>();
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  send(value: string | Uint8Array): void {
    this.sent.push(JSON.parse(String(value)));
  }
  close(): void {
    this.readyState = 3;
  }
  on(name: string, callback: (...args: unknown[]) => void): void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback]);
  }
  message(value: Record<string, unknown>): void {
    if (value['type'] === 'response.output_item.done') {
      const responseId = value['response_id'];
      const item = value['item'];
      if (typeof responseId === 'string' && typeof item === 'object' && item) {
        this.outputs.set(responseId, [
          ...(this.outputs.get(responseId) ?? []),
          item as Record<string, unknown>,
        ]);
      }
    }
    for (const callback of this.handlers.get('message') ?? [])
      callback(JSON.stringify(value), false);
  }
  messages(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((item) => item['type'] === type);
  }
  acknowledgeToolOutputs(): void {
    for (const event of this.messages('conversation.item.create')) {
      const item = event['item'] as Record<string, unknown>;
      if (item['type'] === 'function_call_output')
        this.message({
          type: 'conversation.item.created',
          event_id: `ack-${event['event_id']}`,
          item: {
            ...item,
            id: `receipt-${item['call_id']}`,
            status: 'completed',
          },
        });
    }
  }
}

async function connect(callbacks: QwenRealtimeCallbacks = {}, model = 'test') {
  const socket = new MemorySocket();
  const pending = openQwenRealtimeSession(
    {
      endpoint: 'https://example.test',
      apiKey: 'test-key',
      model,
      callEpoch: 1,
      instructions: 'base instructions',
      tools: MEMORY_TOOLS,
    },
    callbacks,
    { createWebSocket: () => socket },
  );
  socket.message({ type: 'session.created' });
  socket.message({ type: 'session.updated' });
  return { socket, session: await pending };
}

function input(socket: MemorySocket, id = 'input-1', text?: string): void {
  socket.message({ type: 'input_audio_buffer.committed', item_id: id });
  if (text !== undefined)
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: id,
      transcript: text,
    });
}
function created(socket: MemorySocket, id: string): void {
  socket.message({ type: 'response.created', response: { id } });
}
function done(socket: MemorySocket, id: string): void {
  socket.message({
    type: 'response.done',
    response: { id, status: 'completed', output: socket.outputs.get(id) ?? [] },
  });
}
function text(socket: MemorySocket, id: string, value: string): void {
  socket.message({
    type: 'response.output_text.done',
    response_id: id,
    text: value,
  });
}
function call(
  socket: MemorySocket,
  responseId: string,
  callId: string,
  name = 'omniretrieve',
): void {
  socket.message({
    type: 'response.output_item.done',
    response_id: responseId,
    item: {
      id: 'item-' + callId,
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name,
      arguments: JSON.stringify({ query: 'tea', source: 'dialogue' }),
    },
  });
}

describe('Memory Realtime publication and dialogue boundaries', () => {
  it.each([
    'qwen3.8-omni-flash-realtime',
    'example-omni-realtime-deployment',
    'custom-realtime',
  ])(
    'preserves complete Memory schemas on initial and dynamic %s publication',
    async (model) => {
      const { socket, session } = await connect({}, model);
      try {
        expect(session.configure({ tools: [] })).toBe(true);
        socket.message({ type: 'session.updated' });
        expect(
          session.configure({
            tools: MEMORY_TOOLS,
          }),
        ).toBe(true);
        const publications = socket.messages('session.update');
        expect(publications).toHaveLength(3);
        for (const [index, publication] of publications.entries()) {
          const published = publication['session'] as {
            instructions: string;
            tools: Array<{
              type: string;
              function: { name: string; parameters: Record<string, unknown> };
            }>;
          };
          expect(published.instructions).toBe(
            index === 0 ? 'base instructions' : undefined,
          );
          if (index === 1) {
            expect(published.tools).toEqual([]);
            continue;
          }
          // The transport strips only local behavior flags, never schema fields.
          expect(published.tools).toEqual(
            MEMORY_TOOLS.map(({ type, function: definition }) => ({
              type,
              function: definition,
            })),
          );
          // Explicit literals also catch accidental removal from MEMORY_TOOLS:
          // comparing the wire to that same definition alone would miss it.
          expect(
            published.tools.find((tool) => tool.function.name === 'omnibio')
              ?.function.parameters,
          ).toMatchObject({
            type: 'object',
            properties: {
              operations: {
                type: 'object',
                properties: {
                  add: {
                    type: 'array',
                    items: { type: 'string', minLength: 1 },
                  },
                  update: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        index: { type: 'integer', minimum: 0 },
                        content: { type: 'string', minLength: 1 },
                      },
                      required: ['index', 'content'],
                      additionalProperties: false,
                    },
                  },
                  delete: {
                    type: 'array',
                    items: { type: 'integer', minimum: 0 },
                  },
                },
                additionalProperties: false,
              },
            },
            required: ['operations'],
            additionalProperties: false,
          });
          expect(
            published.tools.find(
              (tool) => tool.function.name === 'omniretrieve',
            )?.function.parameters,
          ).toMatchObject({
            type: 'object',
            properties: {
              query: { type: 'string', minLength: 1 },
              source: { type: 'string', enum: ['dialogue', 'env'] },
              time_range: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
              },
            },
            required: ['query', 'source'],
            additionalProperties: false,
          });
        }
      } finally {
        session.close({ discardPendingInput: true });
      }
    },
  );

  it('publishes Memory in one silent user item before its receipt without changing instructions', async () => {
    const onFunctionCall = vi.fn();
    const { socket, session } = await connect({ onFunctionCall });
    input(socket, 'input-1', 'What did I say about tea?');
    created(socket, 'direct');
    call(socket, 'direct', 'retrieve');
    done(socket, 'direct');
    expect(onFunctionCall).toHaveBeenCalledOnce();
    const memory = memoryContextMessage(1, '<retrieved>green tea</retrieved>');
    expect(session.sendBackendContext(memory)).toBe(true);
    expect(socket.messages('session.update')).toHaveLength(1);
    session.submitFunctionOutput(
      { callEpoch: 1, callId: 'retrieve' },
      'Successfully searched past conversations. 1 matched.',
    );
    expect(socket.messages('session.update')).toHaveLength(1);
    socket.acknowledgeToolOutputs();
    await Promise.resolve();
    const items = socket
      .messages('conversation.item.create')
      .map((event) => event['item']);
    expect(items).toEqual([
      expect.objectContaining({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `[BACKEND] ${memory}` }],
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'retrieve',
      }),
    ]);
    expect(socket.messages('session.update')).toHaveLength(1);
    const response = socket.messages('response.create').at(-1)?.['response'];
    expect(response).toMatchObject({
      modalities: ['text', 'audio'],
    });
    expect(response).not.toHaveProperty('instructions');
    expect(socket.messages('input_audio_buffer.commit')).toHaveLength(0);
    created(socket, 'continuation');
    text(socket, 'continuation', 'You mentioned green tea.');
    done(socket, 'continuation');
    session.close({ discardPendingInput: true });
  });

  it('revokes removed tools immediately and persists their removal only at idle', async () => {
    const onFunctionCall = vi.fn();
    const { socket, session } = await connect({ onFunctionCall });
    input(socket, 'input-1', 'Remember this.');
    created(socket, 'direct');
    session.configure({ tools: [] });
    session.sendBackendContext(memoryContextMessage(2));
    call(socket, 'direct', 'late-memory', 'omnibio');
    expect(onFunctionCall).not.toHaveBeenCalled();
    expect(socket.messages('session.update')).toHaveLength(1);
    done(socket, 'direct');
    socket.acknowledgeToolOutputs();
    await Promise.resolve();
    expect(socket.messages('session.update').at(-1)?.['session']).toEqual({
      tools: [],
    });
    for (const request of socket.messages('response.create'))
      expect(request['response']).not.toHaveProperty('instructions');
    session.close({ discardPendingInput: true });
  });

  it('records late ASR and user-authorized continuations but excludes synthetic speech', async () => {
    const onDialogue = vi.fn();
    const { socket, session } = await connect({ onDialogue });
    input(socket);
    created(socket, 'direct');
    text(socket, 'direct', 'I will check.');
    call(socket, 'direct', 'retrieve');
    done(socket, 'direct');
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'input-1',
      transcript: 'My tea preference?',
    });
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'input-1',
      transcript: 'My tea preference?',
    });
    session.submitFunctionOutput(
      { callEpoch: 1, callId: 'retrieve' },
      '1 matched.',
    );
    socket.acknowledgeToolOutputs();
    created(socket, 'continuation');
    text(socket, 'continuation', 'You like green tea.');
    done(socket, 'continuation');
    expect(
      onDialogue.mock.calls.map(([event]) => [
        event.role,
        event.text,
        event.source,
      ]),
    ).toEqual([
      ['assistant', 'I will check.', 'filler'],
      ['user', 'My tea preference?', undefined],
      ['assistant', 'You like green tea.', 'normal'],
    ]);
    expect(session.respondToProactiveEvent('Movement detected.')).toBe(true);
    created(socket, 'proactive');
    text(socket, 'proactive', 'Movement detected.');
    done(socket, 'proactive');
    expect(session.speakToUser('A background job completed.')).toBe(true);
    created(socket, 'background');
    text(socket, 'background', 'A background job completed.');
    done(socket, 'background');
    expect(onDialogue).toHaveBeenCalledTimes(3);
    session.close({ discardPendingInput: true });
  });

  it('retires a failed late ASR input so subsequent dialogue records before call end', async () => {
    const recordUser = vi.fn();
    const recordAssistant = vi.fn();
    const collector = new MemoryDialogueCollector({
      recordUser,
      recordAssistant,
    });
    const onError = vi.fn();
    const { socket, session } = await connect({
      onInputCommitted: (event) => collector.beginInput(event.itemId!),
      onDialogue: (event) => collector.accept(event),
      onError,
    });
    try {
      input(socket, 'failed-input');
      created(socket, 'first');
      text(socket, 'first', 'An answer without a reliable transcript.');
      done(socket, 'first');
      socket.message({
        type: 'conversation.item.input_audio_transcription.failed',
        item_id: 'failed-input',
        error: { message: 'Transcription unavailable' },
      });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ fatal: false }),
      );
      input(socket, 'second-input', 'I prefer green tea.');
      created(socket, 'second');
      text(socket, 'second', 'You prefer green tea.');
      done(socket, 'second');
      expect(recordUser.mock.calls).toEqual([['I prefer green tea.']]);
      expect(recordAssistant.mock.calls).toEqual([
        ['You prefer green tea.', { source: 'normal', interrupted: false }],
      ]);
      socket.message({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'failed-input',
        transcript: 'A late transcript for the already retired input.',
      });
      expect(recordUser).toHaveBeenCalledOnce();
      expect(recordAssistant).toHaveBeenCalledOnce();
    } finally {
      session.close({ discardPendingInput: true });
      collector.close();
    }
  });

  it('retires a committed failed ASR input before reporting input loss', async () => {
    const events: string[] = [];
    const { socket, session } = await connect({
      onDialogue: (event) => {
        expect(event).toMatchObject({
          inputItemId: 'failed-input',
          role: 'user',
          text: '',
        });
        events.push('retired');
      },
      onError: (error) => {
        expect(error.fatal).toBe(true);
        events.push('error');
      },
    });
    input(socket, 'failed-input');
    socket.message({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'failed-input',
      error: { message: 'Transcription unavailable' },
    });
    expect(events).toEqual(['retired', 'error']);
    session.close({ discardPendingInput: true });
  });

  it.each([undefined, 'future-input'])(
    'does not retire dialogue for an ASR failure with an unregistered id %s',
    async (itemId) => {
      const onDialogue = vi.fn();
      const { socket, session } = await connect({ onDialogue });
      socket.message({
        type: 'conversation.item.input_audio_transcription.failed',
        ...(itemId ? { item_id: itemId } : {}),
        error: { message: 'Transcription unavailable' },
      });
      expect(onDialogue).not.toHaveBeenCalled();
      input(socket, 'future-input', 'A real subsequent question.');
      expect(onDialogue).toHaveBeenCalledWith(
        expect.objectContaining({
          inputItemId: 'future-input',
          role: 'user',
          text: 'A real subsequent question.',
        }),
      );
      session.close({ discardPendingInput: true });
    },
  );

  it('preserves interrupted user-response text with an interruption marker', async () => {
    const onDialogue = vi.fn();
    const { socket, session } = await connect({ onDialogue });
    input(socket, 'input-1', 'Tell me more.');
    created(socket, 'direct');
    text(socket, 'direct', 'The answer begins');
    session.cancelResponse();
    expect(onDialogue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: 'assistant',
        text: 'The answer begins',
        source: 'normal',
        interrupted: true,
      }),
    );
    session.close({ discardPendingInput: true });
  });

  it('reports an interrupted answer before the next user transcript, without waiting for cancel ACK', async () => {
    const onDialogue = vi.fn();
    const { socket, session } = await connect({ onDialogue });
    input(socket, 'input-1', 'First question');
    created(socket, 'direct');
    text(socket, 'direct', 'A partial answer');
    socket.message({
      type: 'input_audio_buffer.speech_started',
      item_id: 'input-2',
    });
    input(socket, 'input-2', 'Second question');
    socket.message({
      type: 'response.done',
      response: { id: 'direct', status: 'cancelled' },
    });
    expect(
      onDialogue.mock.calls.map(([event]) => [
        event.role,
        event.text,
        event.interrupted,
      ]),
    ).toEqual([
      ['user', 'First question', undefined],
      ['assistant', 'A partial answer', true],
      ['user', 'Second question', undefined],
    ]);
    session.close({ discardPendingInput: true });
  });

  it('rejects oversized initial instructions before opening a socket', async () => {
    const createWebSocket = vi.fn(() => new MemorySocket());
    await expect(
      openQwenRealtimeSession(
        {
          endpoint: 'https://example.test',
          model: 'test',
          callEpoch: 1,
          instructions: 'x'.repeat(MAX_REALTIME_INSTRUCTIONS_CHARS + 1),
          tools: MEMORY_TOOLS,
        },
        {},
        { createWebSocket },
      ),
    ).rejects.toMatchObject({
      constructor: QwenRealtimeError,
      code: 'instructions_too_large',
      kind: 'configuration',
      fatal: true,
    });
    expect(createWebSocket).not.toHaveBeenCalled();
  });

  it('retains all parts of a provider-split answer as one recorded response', async () => {
    const onDialogue = vi.fn();
    const { socket, session } = await connect({ onDialogue });
    input(socket, 'input-1', 'Tell me both points.');
    created(socket, 'part-1');
    text(socket, 'part-1', 'First point is blue.');
    created(socket, 'part-2');
    text(socket, 'part-2', 'Second point is red.');
    done(socket, 'part-2');
    expect(onDialogue).toHaveBeenCalledTimes(2);
    expect(onDialogue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inputItemId: 'input-1',
        role: 'assistant',
        text: 'First point is blue.\nSecond point is red.',
        source: 'normal',
        interrupted: false,
      }),
    );
    session.close({ discardPendingInput: true });
  });

  it('deduplicates tool publication and rejects oversized context without changing system instructions', async () => {
    const { socket, session } = await connect();
    session.configure({ tools: [] });
    session.configure({ tools: [] });
    expect(socket.messages('session.update')).toHaveLength(2);
    expect(() =>
      session.sendBackendContext(
        'x'.repeat(QWEN_REALTIME_LIMITS.maxContextChars + 1),
      ),
    ).toThrow(RangeError);
    expect(socket.messages('session.update')).toHaveLength(2);
    expect(
      socket.messages('session.update')[1]?.['session'],
    ).not.toHaveProperty('instructions');
    session.close();
  });

  it.each(['remote', 'provider', 'client'] as const)(
    'flushes already-produced user dialogue on %s closure before notifying consumers',
    async (reason) => {
      const onDialogue = vi.fn();
      const order: string[] = [];
      const { socket, session } = await connect({
        onDialogue: (event) => {
          onDialogue(event);
          order.push(event.role);
        },
        onClose: () => order.push('close'),
      });
      input(socket, 'input-1', 'When is my appointment?');
      created(socket, 'direct');
      socket.message({
        type: 'response.audio_transcript.done',
        response_id: 'direct',
        transcript: 'Your appointment is on Tuesday.',
      });
      if (reason === 'remote')
        for (const cb of socket.handlers.get('close') ?? [])
          cb(1006, 'network lost');
      else if (reason === 'provider')
        socket.message({
          type: 'error',
          error: { message: 'connection failed' },
        });
      else {
        session.flushDialogue();
        session.close({ discardPendingInput: true });
      }
      expect(onDialogue).toHaveBeenLastCalledWith(
        expect.objectContaining({
          role: 'assistant',
          text: 'Your appointment is on Tuesday.',
          interrupted: true,
        }),
      );
      expect(order).toEqual(['user', 'assistant', 'close']);
    },
  );
});
