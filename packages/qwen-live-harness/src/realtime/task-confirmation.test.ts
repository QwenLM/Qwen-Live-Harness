/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { buildLiveSessionTools } from '../tools/definitions.js';
import {
  openQwenRealtimeSession,
  type RealtimeFunctionOutputOptions,
} from './realtime-session.js';

class Socket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];

  private contextSequence = 0;
  private latestContextItemId?: string;
  private readonly responseParents: Array<string | undefined> = [];
  send(data: string | Uint8Array): void {
    const event = JSON.parse(String(data)) as Record<string, unknown>;
    this.sent.push(event);
    this.acknowledgeContext(event);
  }

  /** Real providers echo user context and assign the item ID before inference. */
  private acknowledgeContext(event: Record<string, unknown>): void {
    if (event['type'] === 'response.create')
      this.responseParents.push(this.latestContextItemId);
    const item = event['item'] as Record<string, unknown> | undefined;
    if (
      event['type'] !== 'conversation.item.create' ||
      item?.['type'] !== 'message' ||
      item['role'] !== 'user'
    )
      return;
    const previous = this.latestContextItemId;
    const id = `context-${++this.contextSequence}`;
    this.latestContextItemId = id;
    this.message({
      type: 'conversation.item.created',
      previous_item_id: previous ?? null,
      item: { ...item, id, status: 'completed' },
    });
  }
  private outputAncestry(event: Record<string, unknown>): void {
    if (event['type'] !== 'response.created') return;
    const parent = this.responseParents.shift();
    const response = event['response'] as Record<string, unknown> | undefined;
    if (!parent || typeof response?.['id'] !== 'string') return;
    const responseId = response['id'];
    const item = {
      id: `assistant-${responseId}`,
      type: 'message',
      role: 'assistant',
      content: [],
    };
    this.message({
      type: 'conversation.item.created',
      previous_item_id: parent,
      item,
    });
    this.message({
      type: 'response.output_item.added',
      response_id: responseId,
      output_index: 0,
      item,
    });
  }
  close(): void {
    this.readyState = 3;
  }

  message(event: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(event), false);
    this.outputAncestry(event);
  }

  acknowledge(callId: string): void {
    const output = this.sent.findLast((event) => {
      const item = event['item'] as Record<string, unknown> | undefined;
      return (
        item?.['type'] === 'function_call_output' && item['call_id'] === callId
      );
    });
    expect(output).toBeDefined();
    this.message({
      type: 'conversation.item.created',
      item: { ...(output!['item'] as object), status: 'completed' },
    });
  }

  get requests(): Record<string, unknown>[] {
    return this.sent.filter((event) => event['type'] === 'response.create');
  }
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
}

async function connect() {
  const socket = new Socket();
  const callbacks = {
    onFunctionCall: vi.fn(),
    onOutputAudioDelta: vi.fn(),
    onOutputAudioDone: vi.fn(),
    onOutputTextDelta: vi.fn(),
    onOutputTextDone: vi.fn(),
    onDialogue: vi.fn(),
    onResponseCreated: vi.fn(),
    onResponseDone: vi.fn(),
    onError: vi.fn(),
    onRecoveryNeeded: vi.fn(),
  };
  const opening = openQwenRealtimeSession(
    {
      endpoint: 'wss://dashscope.example/realtime',
      apiKey: 'test-confirmation-key',
      model: 'qwen3.8-omni-flash-realtime',
      callEpoch: 1,
      instructions: 'Synthetic task receipt tests.',
      tools: buildLiveSessionTools(true, true, true),
    },
    callbacks,
    { createWebSocket: () => socket },
  );
  socket.message({
    type: 'session.created',
    session: { id: 'sess-confirmation' },
  });
  socket.message({ type: 'session.updated', session: {} });
  return { socket, callbacks, session: await opening };
}

function commit(socket: Socket, itemId: string): void {
  socket.message({ type: 'input_audio_buffer.committed', item_id: itemId });
  socket.message({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: '请处理这个请求。',
  });
}

function created(socket: Socket, id: string): void {
  socket.message({ type: 'response.created', response: { id } });
}

function audio(socket: Socket, id: string): void {
  socket.message({
    type: 'response.audio.delta',
    response_id: id,
    delta: Buffer.from([1, 0, 2, 0]).toString('base64'),
  });
  socket.message({ type: 'response.audio.done', response_id: id });
}

function call(name: string, id: string) {
  return {
    type: 'function_call',
    status: 'completed',
    id: `item-${id}`,
    call_id: id,
    name,
    arguments: name === 'handoff' ? '{"task":"Run the task."}' : '{}',
  };
}

function done(
  socket: Socket,
  id: string,
  output: ReturnType<typeof call>[] = [],
  status = 'completed',
): void {
  socket.message({ type: 'response.done', response: { id, status, output } });
}

function startTools(
  socket: Socket,
  calls: ReturnType<typeof call>[],
  parentAudio = true,
): void {
  commit(socket, 'input-parent');
  created(socket, 'parent');
  if (parentAudio) audio(socket, 'parent');
  done(socket, 'parent', calls);
}

const searchReceipt = JSON.stringify({
  status: 'accepted',
  taskId: 'search:1',
});
const handoffReceipt = JSON.stringify({
  status: 'accepted',
  job: 'job_1',
  session: 'session_1',
});

describe('task admission confirmation audio', () => {
  it('silently drains remain_silent receipts before external playback or the next user response', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      expect(session.respondToProactiveEvent('[PROACTIVE_EVENT] test')).toBe(
        true,
      );
      created(socket, 'proactive-no-audio');
      done(socket, 'proactive-no-audio', [
        call('remain_silent', 'silent-call'),
      ]);
      expect(session.canDeliverExternalAudio?.()).toBe(false);
      socket.acknowledge('silent-call');
      expect(socket.requests).toHaveLength(2);
      created(socket, 'silent-drain');
      audio(socket, 'silent-drain');
      done(socket, 'silent-drain');
      await flush();
      expect(callbacks.onOutputAudioDelta).not.toHaveBeenCalled();
      expect(callbacks.onFunctionCall).not.toHaveBeenCalled();
      expect(session.canDeliverExternalAudio?.()).toBe(true);
      commit(socket, 'next-user');
      created(socket, 'new-direct');
      audio(socket, 'new-direct');
      done(socket, 'new-direct');
      expect(callbacks.onOutputAudioDelta).toHaveBeenCalledOnce();
    } finally {
      session.close({ discardPendingInput: true });
    }
  });

  it('fences a repeated tool in a silent receipt drain instead of opening another receipt loop', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      session.respondToProactiveEvent('[PROACTIVE_EVENT] test');
      created(socket, 'silence-parent');
      done(socket, 'silence-parent', [call('remain_silent', 'first-silence')]);
      socket.acknowledge('first-silence');
      created(socket, 'drain-loop');
      done(socket, 'drain-loop', [call('handoff', 'forbidden-in-drain')]);
      expect(callbacks.onRecoveryNeeded).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'silent_receipt_tool_loop',
          authority: 'tool_continuation',
        }),
      );
      expect(callbacks.onFunctionCall).not.toHaveBeenCalled();
      expect(
        socket.sent.filter(
          (e) =>
            (e['item'] as Record<string, unknown> | undefined)?.['type'] ===
            'function_call_output',
        ),
      ).toHaveLength(1);
      expect(session.canDeliverExternalAudio?.()).toBe(false);
    } finally {
      session.close({ discardPendingInput: true });
    }
  });
  it('delivers visual evidence in its own audible response without granting any tool authority', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      startTools(socket, [call('appshot', 'capture')]);
      session.submitFunctionOutput(
        { callEpoch: 1, callId: 'capture' },
        JSON.stringify({
          status: 'accepted',
          taskId: 'visual:1',
          source: 'screen',
          asset: 'asset_1',
        }),
      );
      socket.acknowledge('capture');
      created(socket, 'visual-receipt');
      audio(socket, 'visual-receipt');
      done(socket, 'visual-receipt');
      await flush();
      callbacks.onOutputAudioDelta.mockClear();
      expect(
        session.respondToVisualResult?.(
          '{"status":"completed","answer":"K7M4","query":"What code?"}',
          { fallbackLanguage: 'en', outputLanguage: 'zh-CN' },
        ),
      ).toBe(true);
      const textItem = socket.sent.findLast(
        (e) =>
          (e['item'] as Record<string, unknown> | undefined)?.['role'] ===
          'user',
      );
      expect(JSON.stringify(textItem)).toContain('visual_result');
      expect(JSON.stringify(textItem)).toContain('zh-CN');
      expect(socket.requests.at(-1)).not.toHaveProperty(
        'response.instructions',
      );
      created(socket, 'visual-result');
      audio(socket, 'visual-result');
      done(socket, 'visual-result', [call('handoff', 'forbidden-by-picture')]);
      expect(callbacks.onOutputAudioDelta).toHaveBeenCalledOnce();
      expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
      expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
        expect.objectContaining({ authority: 'visual_result' }),
      );
    } finally {
      session.close({ discardPendingInput: true });
    }
  });
  it.each([
    ['web_search', searchReceipt],
    ['handoff', handoffReceipt],
    [
      'appshot',
      JSON.stringify({
        status: 'accepted',
        taskId: 'visual:1',
        source: 'screen',
        asset: 'asset_1',
        width: 1920,
        height: 1080,
      }),
    ],
  ])(
    'consumes %s receipts without repeating their preamble and retains text/history',
    async (name, receipt) => {
      const { socket, callbacks, session } = await connect();
      try {
        startTools(socket, [call(name, 'call-parent')]);
        expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
        expect(
          session.submitFunctionOutput(
            { callEpoch: 1, callId: 'call-parent' },
            receipt,
          ),
        ).toBe(true);
        expect(socket.requests).toHaveLength(1);
        socket.acknowledge('call-parent');
        await flush();
        expect(socket.requests).toHaveLength(2);
        created(socket, 'confirmation');
        expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
          expect.objectContaining({
            responseId: 'confirmation',
            authority: 'tool_continuation',
          }),
        );
        audio(socket, 'confirmation');
        socket.message({
          type: 'response.audio_transcript.delta',
          response_id: 'confirmation',
          delta: '任务已交给子智能体。',
        });
        socket.message({
          type: 'response.audio_transcript.done',
          response_id: 'confirmation',
          transcript: '任务已交给子智能体。',
        });
        done(socket, 'confirmation');
        await flush();
        expect(
          callbacks.onOutputAudioDelta.mock.calls.map(
            ([event]) => event.responseId,
          ),
        ).toEqual(['parent']);
        expect(
          callbacks.onOutputAudioDone.mock.calls.map(
            ([event]) => event.responseId,
          ),
        ).toEqual(['parent']);
        expect(callbacks.onOutputTextDone).toHaveBeenLastCalledWith(
          expect.objectContaining({
            responseId: 'confirmation',
            text: '任务已交给子智能体。',
            audioSuppressed: true,
          }),
        );
        expect(callbacks.onOutputTextDelta).toHaveBeenLastCalledWith(
          expect.objectContaining({
            responseId: 'confirmation',
            text: '任务已交给子智能体。',
            audioSuppressed: true,
          }),
        );
        expect(callbacks.onDialogue).not.toHaveBeenCalledWith(
          expect.objectContaining({
            role: 'assistant',
            inputItemId: 'input-parent',
            text: '任务已交给子智能体。',
          }),
        );
        expect(
          socket.sent.some(
            (event) => event['type'] === 'conversation.item.delete',
          ),
        ).toBe(false);
        expect(
          socket.sent.filter(
            (event) =>
              event['type'] === 'conversation.item.create' &&
              (event['item'] as Record<string, unknown>)['type'] ===
                'function_call_output',
          ),
        ).toHaveLength(1);

        commit(socket, 'input-next');
        created(socket, 'next-user');
        audio(socket, 'next-user');
        done(socket, 'next-user');
        await flush();
        expect(
          name === 'web_search'
            ? session.respondToSearchResult?.('The weather is sunny.')
            : session.respondToTaskResult?.('The requested work completed.'),
        ).toBe(true);
        created(socket, 'actual-result');
        expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
          expect.objectContaining({
            authority: name === 'web_search' ? 'search_result' : 'task_result',
          }),
        );
        audio(socket, 'actual-result');
        done(socket, 'actual-result');
        expect(
          callbacks.onOutputAudioDelta.mock.calls.map(
            ([event]) => event.responseId,
          ),
        ).toEqual(['parent', 'next-user', 'actual-result']);
        expect(callbacks.onError).not.toHaveBeenCalled();
      } finally {
        session.close({ discardPendingInput: true });
      }
    },
  );

  it.each([
    ['web_search', searchReceipt],
    ['handoff', handoffReceipt],
  ])(
    'keeps %s confirmation audible if the parent had no audio',
    async (name, receipt) => {
      const { socket, callbacks, session } = await connect();
      try {
        startTools(socket, [call(name, 'call-parent')], false);
        session.submitFunctionOutput(
          { callEpoch: 1, callId: 'call-parent' },
          receipt,
        );
        socket.acknowledge('call-parent');
        await flush();
        created(socket, 'confirmation');
        audio(socket, 'confirmation');
        done(socket, 'confirmation');
        expect(callbacks.onOutputAudioDelta).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ responseId: 'confirmation' }),
        );
      } finally {
        session.close({ discardPendingInput: true });
      }
    },
  );

  it.each([
    [
      'web_search',
      JSON.stringify({ status: 'error', note: 'The query is invalid.' }),
    ],
    [
      'web_search',
      JSON.stringify({
        status: 'accepted',
        taskId: 'search:1',
        answer: 'A partial answer.',
      }),
    ],
    [
      'handoff',
      JSON.stringify({ status: 'rejected', note: 'No backend is available.' }),
    ],
    [
      'handoff',
      JSON.stringify({
        status: 'accepted',
        job: 'job_1',
        session: 'session_1',
        note: 'Images could not be sent.',
      }),
    ],
    ['session_create', JSON.stringify({ status: 'ok', handle: 'session_1' })],
  ])(
    'keeps %s errors, warnings, partial results and prerequisite confirmations audible',
    async (name, receipt) => {
      const { socket, callbacks, session } = await connect();
      try {
        startTools(socket, [call(name, 'call-parent')]);
        session.submitFunctionOutput(
          { callEpoch: 1, callId: 'call-parent' },
          receipt,
        );
        socket.acknowledge('call-parent');
        await flush();
        expect(socket.requests).toHaveLength(2);
        created(socket, 'confirmation');
        audio(socket, 'confirmation');
        done(socket, 'confirmation');
        expect(
          callbacks.onOutputAudioDelta.mock.calls.map(
            ([event]) => event.responseId,
          ),
        ).toEqual(['parent', 'confirmation']);
      } finally {
        session.close({ discardPendingInput: true });
      }
    },
  );

  it.each(['create_proactive_monitor', 'create_live_narration'])(
    'only suppresses %s when local committed metadata confirms admission',
    async (name) => {
      for (const options of [
        undefined,
        { taskAdmission: false },
        { taskAdmission: true },
      ] satisfies (RealtimeFunctionOutputOptions | undefined)[]) {
        const { socket, callbacks, session } = await connect();
        try {
          startTools(socket, [call(name, 'call-parent')]);
          session.submitFunctionOutput(
            { callEpoch: 1, callId: 'call-parent' },
            '提醒任务已创建。',
            options,
          );
          socket.acknowledge('call-parent');
          await flush();
          created(socket, 'confirmation');
          audio(socket, 'confirmation');
          done(socket, 'confirmation');
          expect(callbacks.onOutputAudioDelta).toHaveBeenCalledTimes(
            options?.taskAdmission ? 1 : 2,
          );
          if (options?.taskAdmission) {
            await flush();
            expect(
              session.respondToProactiveEvent(
                '[PROACTIVE_EVENT] A new observed event.',
              ),
            ).toBe(true);
            created(socket, 'actual-proactive-event');
            audio(socket, 'actual-proactive-event');
            done(socket, 'actual-proactive-event');
            expect(callbacks.onOutputAudioDelta).toHaveBeenLastCalledWith(
              expect.objectContaining({ responseId: 'actual-proactive-event' }),
            );
          }
        } finally {
          session.close({ discardPendingInput: true });
        }
      }
    },
  );

  it.each([
    ['handoff', handoffReceipt, true],
    ['session_list', JSON.stringify({ status: 'ok', sessions: [] }), false],
    [
      'handoff',
      JSON.stringify({ status: 'error', note: 'Unavailable.' }),
      false,
    ],
  ] as const)(
    'waits for all sibling receipts and suppresses only a wholly successful admission batch (%s)',
    async (secondName, secondReceipt, suppressed) => {
      const { socket, callbacks, session } = await connect();
      try {
        startTools(socket, [
          call('web_search', 'call-first'),
          call(secondName, 'call-second'),
        ]);
        session.submitFunctionOutput(
          { callEpoch: 1, callId: 'call-first' },
          searchReceipt,
        );
        socket.acknowledge('call-first');
        await flush();
        expect(socket.requests).toHaveLength(1);
        session.submitFunctionOutput(
          { callEpoch: 1, callId: 'call-second' },
          secondReceipt,
        );
        expect(socket.requests).toHaveLength(1);
        socket.acknowledge('call-second');
        await flush();
        expect(socket.requests).toHaveLength(2);
        created(socket, 'confirmation');
        audio(socket, 'confirmation');
        done(socket, 'confirmation');
        expect(callbacks.onOutputAudioDelta).toHaveBeenCalledTimes(
          suppressed ? 1 : 2,
        );
      } finally {
        session.close({ discardPendingInput: true });
      }
    },
  );

  it('drains a late receipt after the newer active user response and before the actual result, without tool authority', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      startTools(socket, [call('handoff', 'call-parent')]);
      commit(socket, 'input-newer');
      created(socket, 'newer-user');
      audio(socket, 'newer-user');
      session.submitFunctionOutput(
        { callEpoch: 1, callId: 'call-parent' },
        handoffReceipt,
      );
      socket.acknowledge('call-parent');
      await flush();
      expect(socket.requests).toHaveLength(2);
      expect(
        session.respondToTaskResult?.('The requested work completed.'),
      ).toBe(true);
      done(socket, 'newer-user');
      await flush();
      expect(socket.requests).toHaveLength(3);
      // The actual result must not enter the server's stale tool-result cache.
      expect(JSON.stringify(socket.sent)).not.toContain(
        'The requested work completed.',
      );
      created(socket, 'stale-drain');
      expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
        expect.objectContaining({ authority: 'tool_continuation' }),
      );
      audio(socket, 'stale-drain');
      done(socket, 'stale-drain', [call('handoff', 'call-unauthorized-retry')]);
      expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
      expect(socket.sent.at(-1)).toMatchObject({
        item: {
          type: 'function_call_output',
          call_id: 'call-unauthorized-retry',
          output: JSON.stringify({
            status: 'error',
            note: 'This response is not authorized to call tools.',
          }),
        },
      });
      socket.acknowledge('call-unauthorized-retry');
      await flush();
      expect(socket.requests).toHaveLength(4);
      expect(JSON.stringify(socket.sent)).toContain(
        'The requested work completed.',
      );
      created(socket, 'actual-result');
      audio(socket, 'actual-result');
      done(socket, 'actual-result');
      expect(
        callbacks.onOutputAudioDelta.mock.calls.map(
          ([event]) => event.responseId,
        ),
      ).toEqual(['parent', 'newer-user', 'actual-result']);
      expect(callbacks.onError).not.toHaveBeenCalled();
    } finally {
      session.close({ discardPendingInput: true });
    }
  });

  it('retains an unsent receipt continuation across another speech generation', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      startTools(socket, [call('handoff', 'call-parent')]);
      commit(socket, 'input-middle');
      created(socket, 'middle-user');
      session.submitFunctionOutput(
        { callEpoch: 1, callId: 'call-parent' },
        handoffReceipt,
      );
      socket.acknowledge('call-parent');
      await flush();
      socket.message({
        type: 'input_audio_buffer.speech_started',
        item_id: 'input-latest',
      });
      done(socket, 'middle-user', [], 'cancelled');
      socket.message({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'input-latest',
      });
      commit(socket, 'input-latest');
      await flush();

      const authorities: string[] = [];
      for (let index = 0; index < 2; index++) {
        expect(socket.requests).toHaveLength(3 + index);
        const id = `after-barge-${index}`;
        created(socket, id);
        const authority =
          callbacks.onResponseCreated.mock.lastCall?.[0]?.authority;
        authorities.push(authority);
        audio(socket, id);
        if (authority === 'direct') {
          expect(callbacks.onOutputAudioDelta).toHaveBeenLastCalledWith(
            expect.objectContaining({ responseId: id }),
          );
        } else {
          expect(authority).toBe('tool_continuation');
          expect(
            callbacks.onOutputAudioDelta.mock.calls.some(
              ([event]) => event.responseId === id,
            ),
          ).toBe(false);
        }
        done(socket, id);
        await flush();
      }
      expect(authorities).toEqual(['tool_continuation', 'direct']);
      expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
      expect(callbacks.onError).not.toHaveBeenCalled();
    } finally {
      session.close({ discardPendingInput: true });
    }
  });

  it('does not lose receipt drainage while the next speech awaits commit/transcription', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      startTools(socket, [call('handoff', 'call-parent')]);
      socket.message({
        type: 'input_audio_buffer.speech_started',
        item_id: 'input-latest',
      });
      socket.message({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'input-latest',
      });
      session.submitFunctionOutput(
        { callEpoch: 1, callId: 'call-parent' },
        handoffReceipt,
      );
      socket.acknowledge('call-parent');
      await flush();
      commit(socket, 'input-latest');
      await flush();
      const authorities: string[] = [];
      for (let index = 0; index < 2; index++) {
        expect(socket.requests).toHaveLength(2 + index);
        const id = `after-commit-${index}`;
        created(socket, id);
        const authority =
          callbacks.onResponseCreated.mock.lastCall?.[0]?.authority;
        authorities.push(authority);
        audio(socket, id);
        expect(
          callbacks.onOutputAudioDelta.mock.calls.some(
            ([event]) => event.responseId === id,
          ),
        ).toBe(authority === 'direct');
        done(socket, id);
        await flush();
      }
      expect(authorities).toEqual(['tool_continuation', 'direct']);
      expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
      expect(callbacks.onError).not.toHaveBeenCalled();
    } finally {
      session.close({ discardPendingInput: true });
    }
  });

  it('does not merge permission data ahead of a queued receipt drain or replace an already sent direct response', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      startTools(socket, [call('handoff', 'call-parent')]);
      commit(socket, 'input-newer');
      expect(socket.requests).toHaveLength(2);
      // The newer direct request has left the socket but is not acknowledged.
      session.submitFunctionOutput(
        { callEpoch: 1, callId: 'call-parent' },
        handoffReceipt,
      );
      socket.acknowledge('call-parent');
      await flush();
      expect(session.askPermission?.('A pending command needs approval.')).toBe(
        true,
      );
      expect(JSON.stringify(socket.sent)).not.toContain(
        'A pending command needs approval.',
      );
      created(socket, 'pending-direct');
      expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
        expect.objectContaining({
          responseId: 'pending-direct',
          authority: 'direct',
          inputItemId: 'input-newer',
        }),
      );
      audio(socket, 'pending-direct');
      done(socket, 'pending-direct');
      await flush();
      expect(socket.requests).toHaveLength(3);
      expect(JSON.stringify(socket.sent)).not.toContain(
        'A pending command needs approval.',
      );
      created(socket, 'before-permission-drain');
      expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
        expect.objectContaining({
          responseId: 'before-permission-drain',
          authority: 'tool_continuation',
        }),
      );
      audio(socket, 'before-permission-drain');
      done(socket, 'before-permission-drain');
      await flush();
      expect(socket.requests).toHaveLength(4);
      expect(JSON.stringify(socket.sent)).toContain(
        'A pending command needs approval.',
      );
      created(socket, 'permission');
      expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
        expect.objectContaining({
          responseId: 'permission',
          authority: 'permission',
        }),
      );
      audio(socket, 'permission');
      done(socket, 'permission');
      expect(
        callbacks.onOutputAudioDelta.mock.calls.map(
          ([event]) => event.responseId,
        ),
      ).toEqual(['parent', 'pending-direct', 'permission']);
      expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
      expect(callbacks.onError).not.toHaveBeenCalled();
    } finally {
      session.close({ discardPendingInput: true });
    }
  });

  it('keeps permission data out of a pending silent receipt response while a new committed user response is queued', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      startTools(socket, [call('handoff', 'call-parent')]);
      socket.message({
        type: 'input_audio_buffer.speech_started',
        item_id: 'input-newer',
      });
      socket.message({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'input-newer',
      });
      session.submitFunctionOutput(
        { callEpoch: 1, callId: 'call-parent' },
        handoffReceipt,
      );
      socket.acknowledge('call-parent');
      await flush();
      expect(socket.requests).toHaveLength(2);
      commit(socket, 'input-newer');
      expect(
        session.askPermission?.('PERMISSION-MUST-NOT-ENTER-SILENT-RESPONSE'),
      ).toBe(true);
      expect(JSON.stringify(socket.sent)).not.toContain(
        'PERMISSION-MUST-NOT-ENTER-SILENT-RESPONSE',
      );
      created(socket, 'silent-drain');
      expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
        expect.objectContaining({
          responseId: 'silent-drain',
          authority: 'tool_continuation',
        }),
      );
      audio(socket, 'silent-drain');
      done(socket, 'silent-drain');
      await flush();
      expect(socket.requests).toHaveLength(3);
      expect(JSON.stringify(socket.sent)).not.toContain(
        'PERMISSION-MUST-NOT-ENTER-SILENT-RESPONSE',
      );
      created(socket, 'newer-user');
      expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
        expect.objectContaining({
          responseId: 'newer-user',
          authority: 'direct',
          inputItemId: 'input-newer',
        }),
      );
      audio(socket, 'newer-user');
      done(socket, 'newer-user');
      await flush();
      expect(socket.requests).toHaveLength(4);
      expect(JSON.stringify(socket.sent)).toContain(
        'PERMISSION-MUST-NOT-ENTER-SILENT-RESPONSE',
      );
      created(socket, 'permission');
      expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
        expect.objectContaining({
          responseId: 'permission',
          authority: 'permission',
        }),
      );
      audio(socket, 'permission');
      done(socket, 'permission');
      expect(
        callbacks.onOutputAudioDelta.mock.calls.map(
          ([event]) => event.responseId,
        ),
      ).toEqual(['parent', 'newer-user', 'permission']);
      expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
      expect(callbacks.onError).not.toHaveBeenCalled();
    } finally {
      session.close({ discardPendingInput: true });
    }
  });

  it.each([false, true])(
    'preserves queued permission across another barge-in without injecting or speaking before the latest user commit (speech stopped: %s)',
    async (stopBeforeDrain) => {
      const { socket, callbacks, session } = await connect();
      try {
        startTools(socket, [call('handoff', 'call-parent')]);
        commit(socket, 'input-middle');
        created(socket, 'middle-user');
        session.submitFunctionOutput(
          { callEpoch: 1, callId: 'call-parent' },
          handoffReceipt,
        );
        socket.acknowledge('call-parent');
        await flush();
        expect(session.askPermission?.('DEFERRED-PERMISSION-AFTER-USER')).toBe(
          true,
        );
        expect(JSON.stringify(socket.sent)).not.toContain(
          'DEFERRED-PERMISSION-AFTER-USER',
        );
        socket.message({
          type: 'input_audio_buffer.speech_started',
          item_id: 'input-latest',
        });
        if (stopBeforeDrain)
          socket.message({
            type: 'input_audio_buffer.speech_stopped',
            item_id: 'input-latest',
          });
        expect(JSON.stringify(socket.sent)).not.toContain(
          'DEFERRED-PERMISSION-AFTER-USER',
        );
        done(socket, 'middle-user', [], 'cancelled');
        await flush();
        expect(socket.requests).toHaveLength(3);
        created(socket, 'silent-drain');
        expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
          expect.objectContaining({
            responseId: 'silent-drain',
            authority: 'tool_continuation',
          }),
        );
        audio(socket, 'silent-drain');
        done(socket, 'silent-drain');
        await flush();
        // Receipt cleanup finishes while actual speech or its final commit is
        // still pending. The preserved permission must not win this gap.
        expect(socket.requests).toHaveLength(3);
        expect(JSON.stringify(socket.sent)).not.toContain(
          'DEFERRED-PERMISSION-AFTER-USER',
        );
        if (!stopBeforeDrain)
          socket.message({
            type: 'input_audio_buffer.speech_stopped',
            item_id: 'input-latest',
          });
        commit(socket, 'input-latest');
        await flush();
        expect(socket.requests).toHaveLength(4);
        expect(JSON.stringify(socket.sent)).not.toContain(
          'DEFERRED-PERMISSION-AFTER-USER',
        );
        created(socket, 'latest-user');
        expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
          expect.objectContaining({
            responseId: 'latest-user',
            authority: 'direct',
            inputItemId: 'input-latest',
          }),
        );
        audio(socket, 'latest-user');
        done(socket, 'latest-user');
        await flush();
        expect(socket.requests).toHaveLength(5);
        expect(JSON.stringify(socket.sent)).toContain(
          'DEFERRED-PERMISSION-AFTER-USER',
        );
        created(socket, 'permission');
        expect(callbacks.onResponseCreated).toHaveBeenLastCalledWith(
          expect.objectContaining({
            responseId: 'permission',
            authority: 'permission',
          }),
        );
        audio(socket, 'permission');
        done(socket, 'permission');
        expect(
          callbacks.onOutputAudioDelta.mock.calls.map(
            ([event]) => event.responseId,
          ),
        ).toEqual(['parent', 'latest-user', 'permission']);
        expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
        expect(callbacks.onError).not.toHaveBeenCalled();
      } finally {
        session.close({ discardPendingInput: true });
      }
    },
  );

  it.each([
    [
      'web_search',
      '{"query":"Current weather"}',
      ' { "query" : "Current weather" } ',
      searchReceipt,
      undefined,
      true,
    ],
    [
      'handoff',
      '{"task":"Fix the test","session":"session_1"}',
      '{"session":"session_1", "task":"Fix the test"}',
      handoffReceipt,
      undefined,
      true,
    ],
    [
      'create_proactive_monitor',
      '{"title":"Cough","modalities":["audio"]}',
      '{"modalities":["audio"],"title":"Cough"}',
      '提醒任务已创建。',
      { taskAdmission: true },
      true,
    ],
    [
      'handoff',
      '{"task":"Fix the test","session":"session_1"}',
      '{"session":"session_1", "task":"Fix the test"}',
      JSON.stringify({
        status: 'accepted',
        job: 'job_1',
        session: 'session_1',
        note: 'Images could not be sent.',
      }),
      undefined,
      false,
    ],
    [
      'web_search',
      '{"query":"Current weather"}',
      ' { "query" : "Current weather" } ',
      JSON.stringify({
        status: 'accepted',
        taskId: 'search:1',
        answer: 'An initial partial answer.',
      }),
      undefined,
      false,
    ],
  ] as const)(
    'reuses the accepted %s receipt when its continuation repeats the exact admitted request',
    async (name, args, repeatedArgs, receipt, options, suppressed) => {
      const { socket, callbacks, session } = await connect();
      try {
        startTools(socket, [{ ...call(name, 'call-parent'), arguments: args }]);
        session.submitFunctionOutput(
          { callEpoch: 1, callId: 'call-parent' },
          receipt,
          options,
        );
        socket.acknowledge('call-parent');
        await flush();
        created(socket, 'confirmation');
        audio(socket, 'confirmation');
        done(socket, 'confirmation', [
          { ...call(name, 'call-repeat'), arguments: repeatedArgs },
        ]);
        expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
        expect(socket.sent.at(-1)).toMatchObject({
          item: {
            type: 'function_call_output',
            call_id: 'call-repeat',
            output: receipt,
          },
        });
        expect(
          callbacks.onOutputAudioDelta.mock.calls.map(
            ([event]) => event.responseId,
          ),
        ).toEqual(suppressed ? ['parent'] : ['parent', 'confirmation']);
        socket.acknowledge('call-repeat');
        await flush();
        expect(socket.requests).toHaveLength(3);
        created(socket, 'duplicate-confirmation');
        audio(socket, 'duplicate-confirmation');
        done(socket, 'duplicate-confirmation', [
          call('handoff', 'call-not-authorized'),
        ]);
        expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(1);
        expect(socket.sent.at(-1)).toMatchObject({
          item: {
            type: 'function_call_output',
            call_id: 'call-not-authorized',
            output: JSON.stringify({
              status: 'error',
              note: 'This response is not authorized to call tools.',
            }),
          },
        });
        expect(
          callbacks.onOutputAudioDelta.mock.calls.map(
            ([event]) => event.responseId,
          ),
        ).toEqual(
          suppressed
            ? ['parent']
            : ['parent', 'confirmation', 'duplicate-confirmation'],
        );
      } finally {
        session.close({ discardPendingInput: true });
      }
    },
  );

  it.each([
    ['handoff', '{"task":"Fix a different test","session":"session_1"}'],
    ['handoff', '{"task":"Fix the test","session":"session_2"}'],
    ['web_search', '{"query":"Current weather"}'],
  ])(
    'preserves legitimate different chained requests through %s',
    async (name, args) => {
      const { socket, callbacks, session } = await connect();
      try {
        startTools(socket, [
          {
            ...call('handoff', 'call-parent'),
            arguments: '{"task":"Fix the test","session":"session_1"}',
          },
        ]);
        session.submitFunctionOutput(
          { callEpoch: 1, callId: 'call-parent' },
          handoffReceipt,
        );
        socket.acknowledge('call-parent');
        await flush();
        created(socket, 'confirmation');
        done(socket, 'confirmation', [
          { ...call(name, 'call-different'), arguments: args },
        ]);
        expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(2);
        expect(callbacks.onFunctionCall).toHaveBeenLastCalledWith(
          expect.objectContaining({
            name,
            callId: 'call-different',
            arguments: args,
          }),
        );
        session.submitFunctionOutput(
          { callEpoch: 1, callId: 'call-different' },
          name === 'web_search'
            ? JSON.stringify({ status: 'accepted', taskId: 'search:2' })
            : JSON.stringify({
                status: 'accepted',
                job: 'job_2',
                session: 'session_2',
              }),
        );
        socket.acknowledge('call-different');
        await flush();
        created(socket, 'chained-confirmation');
        audio(socket, 'chained-confirmation');
        done(socket, 'chained-confirmation');
        expect(
          callbacks.onOutputAudioDelta.mock.calls.map(
            ([event]) => event.responseId,
          ),
        ).toEqual(['parent']);
      } finally {
        session.close({ discardPendingInput: true });
      }
    },
  );

  it('does not deduplicate a new real user turn that explicitly repeats an earlier accepted request', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      const args = '{"task":"Fix the test","session":"session_1"}';
      startTools(socket, [
        { ...call('handoff', 'call-parent'), arguments: args },
      ]);
      session.submitFunctionOutput(
        { callEpoch: 1, callId: 'call-parent' },
        handoffReceipt,
      );
      socket.acknowledge('call-parent');
      await flush();
      created(socket, 'confirmation');
      done(socket, 'confirmation');
      await flush();
      commit(socket, 'input-repeat');
      created(socket, 'user-repeat');
      done(socket, 'user-repeat', [
        { ...call('handoff', 'call-repeat'), arguments: args },
      ]);
      expect(callbacks.onFunctionCall).toHaveBeenCalledTimes(2);
      expect(callbacks.onFunctionCall).toHaveBeenLastCalledWith(
        expect.objectContaining({
          callId: 'call-repeat',
          responseId: 'user-repeat',
        }),
      );
    } finally {
      session.close({ discardPendingInput: true });
    }
  });

  it('does not carry unheard confirmation claims into a later Harness handoff transcript', async () => {
    const { socket, callbacks, session } = await connect();
    try {
      startTools(socket, [call('web_search', 'call-parent')]);
      session.submitFunctionOutput(
        { callEpoch: 1, callId: 'call-parent' },
        searchReceipt,
      );
      socket.acknowledge('call-parent');
      await flush();
      created(socket, 'confirmation');
      socket.message({
        type: 'response.audio_transcript.delta',
        response_id: 'confirmation',
        delta: 'UNHEARD-UNSUPPORTED-CLAIM',
      });
      socket.message({
        type: 'response.audio_transcript.done',
        response_id: 'confirmation',
        transcript: 'UNHEARD-UNSUPPORTED-CLAIM',
      });
      done(socket, 'confirmation');
      await flush();
      commit(socket, 'input-later-handoff');
      created(socket, 'later-handoff');
      done(socket, 'later-handoff', [call('handoff', 'call-later-handoff')]);
      const handedOff = callbacks.onFunctionCall.mock.lastCall?.[0];
      expect(handedOff).toMatchObject({
        name: 'handoff',
        callId: 'call-later-handoff',
      });
      expect(JSON.stringify(handedOff.activeTranscript)).not.toContain(
        'UNHEARD-UNSUPPORTED-CLAIM',
      );
      expect(callbacks.onOutputTextDone).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'UNHEARD-UNSUPPORTED-CLAIM',
          audioSuppressed: true,
        }),
      );
    } finally {
      session.close({ discardPendingInput: true });
    }
  });
});
