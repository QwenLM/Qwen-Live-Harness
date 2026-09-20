/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRecoveringQwenRealtimeSession } from './recovering-session.js';
import { RecoveryInputBuffer } from './recovery-input.js';
import type {
  QwenRealtimeCallbacks,
  QwenRealtimeSession,
} from './realtime-session.js';

class Socket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Record<string, unknown>[] = [];
  private readonly tools = new Map<string, Record<string, unknown>[]>();
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
  message(message: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(message), false);
    this.outputAncestry(message);
  }
  ready(): void {
    this.message({ type: 'session.created', session: { id: 'session-test' } });
    this.message({ type: 'session.updated' });
  }
  user(id: string, text: string): void {
    this.message({ type: 'input_audio_buffer.speech_started', item_id: id });
    this.message({ type: 'input_audio_buffer.committed', item_id: id });
    this.message({ type: 'input_audio_buffer.speech_stopped', item_id: id });
    this.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: id,
      transcript: text,
    });
  }
  response(id: string): void {
    this.message({ type: 'response.created', response: { id } });
  }
  done(id: string, status = 'completed'): void {
    this.message({
      type: 'response.done',
      response: { id, status, output: this.tools.get(id) ?? [] },
    });
  }
  tool(responseId: string, callId: string): void {
    const item = {
      id: 'item-' + callId,
      type: 'function_call',
      status: 'completed',
      name: 'handoff',
      call_id: callId,
      arguments: '{"task":"synthetic only"}',
    };
    this.tools.set(responseId, [...(this.tools.get(responseId) ?? []), item]);
    this.message({
      type: 'response.output_item.done',
      response_id: responseId,
      item,
    });
  }
  count(type: string): number {
    return this.sent.filter((item) => item['type'] === type).length;
  }
}

const sessions: QwenRealtimeSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0))
    session.close({ discardPendingInput: true });
  vi.useRealTimers();
});

async function rig(callbacks: QwenRealtimeCallbacks = {}) {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  const onError = vi.fn();
  const onFunctionCall = vi.fn();
  const onProtocolDebug = vi.fn();
  const opening = openRecoveringQwenRealtimeSession(
    {
      endpoint: 'wss://fixture.example.test',
      model: 'test',
      callEpoch: 1,
      instructions: 'Synthetic test only',
      tools: [
        {
          type: 'function',
          function: {
            name: 'handoff',
            description: 'Synthetic',
            parameters: { type: 'object' },
          },
        },
      ],
    },
    { onError, onFunctionCall, onProtocolDebug, ...callbacks },
    {
      responseCreatedTimeoutMs: 100,
      cancellationGraceMs: 20,
      connectTimeoutMs: 100,
      createWebSocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
    },
  );
  sockets[0]!.ready();
  const session = await opening;
  sessions.push(session);
  return { session, sockets, onError, onFunctionCall, onProtocolDebug };
}

describe('response state recovery', () => {
  it('keeps independent speech blocked while a notification or replacement transport is unsettled', async () => {
    const r = await rig();
    expect(r.session.canStartExternalSpeech?.()).toBe(true);
    r.session.askPermission?.('A command requires approval.');
    expect(r.session.canStartExternalSpeech?.()).toBe(false);
    r.sockets[0]!.user('latest-user', 'Stop that task.');
    await vi.advanceTimersByTimeAsync(20);
    expect(r.sockets).toHaveLength(2);
    expect(r.session.canStartExternalSpeech?.()).toBe(false);
    r.sockets[1]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.session.canStartExternalSpeech?.()).toBe(false);
    r.sockets[1]!.response('restored-user');
    r.sockets[1]!.done('restored-user');
    expect(r.session.canStartExternalSpeech?.()).toBe(true);
    r.session.close({ discardPendingInput: true });
    expect(r.session.canStartExternalSpeech?.()).toBe(false);
  });

  it.each(['respondToSearchResult', 'speakPeerReport'] as const)(
    'retains explicit notification language through the recovering %s facade',
    async (route) => {
      const r = await rig();
      const first = r.sockets[0]!;
      first.user('input-before-recovery', '请继续回答。');
      await vi.advanceTimersByTimeAsync(100);
      expect(r.sockets).toHaveLength(2);
      const second = r.sockets[1]!;
      second.ready();
      await vi.advanceTimersByTimeAsync(0);
      second.response('recovered-user');
      second.done('recovered-user');
      await vi.advanceTimersByTimeAsync(0);
      expect(
        r.session[route]?.('English untrusted result', {
          fallbackLanguage: 'en',
          outputLanguage: 'zh-CN',
        }),
      ).toBe(true);
      const context = second.sent.findLast(
        (event) => event['type'] === 'conversation.item.create',
      );
      const item = context?.['item'] as { content: [{ text: string }] };
      expect(item.content[0].text).toContain('"output_language":"zh-CN"');
      expect(item.content[0].text).toContain('English untrusted result');
      expect(second.sent.at(-1)?.['response']).not.toHaveProperty(
        'instructions',
      );
    },
  );

  it('keeps the original system prompt on recovery while applying the latest tool surface', async () => {
    const r = await rig();
    const first = r.sockets[0]!;
    first.user('input-before-recovery', '请继续');
    // Extra fields from JavaScript callers must not change the logical call's
    // system prompt, even though configure's TypeScript API only takes tools.
    const settings = { tools: [], instructions: 'Do not use this prompt' };
    expect(r.session.configure(settings)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    const second = r.sockets[1]!;
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'appshot',
          description: 'Synthetic screenshot',
          parameters: { type: 'object' },
        },
      },
    ];
    // A settings change during the replacement handshake must survive it.
    expect(r.session.configure({ tools })).toBe(true);
    second.ready();
    await vi.advanceTimersByTimeAsync(0);
    const updates = second.sent.filter(
      (event) => event['type'] === 'session.update',
    );
    expect(updates[0]?.['session']).toMatchObject({
      instructions: expect.stringContaining('Synthetic test only'),
      tools: [],
    });
    expect(updates.at(-1)?.['session']).toMatchObject({ tools });
    expect(
      updates
        .slice(1)
        .every(
          (event) => !Object.hasOwn(event['session'] as object, 'instructions'),
        ),
    ).toBe(true);
    expect(JSON.stringify(second.sent)).not.toContain('Do not use this prompt');
  });

  it('fences an unacknowledged permission and resumes the new stop request, never old tools', async () => {
    const r = await rig();
    const first = r.sockets[0]!;
    r.session.askPermission?.('[PERMISSION] synthetic');
    first.user('stop-input', '停止后台任务');
    expect(first.count('response.cancel')).toBe(0); // API forbids cancellation before created.
    await vi.advanceTimersByTimeAsync(20);
    expect(r.sockets).toHaveLength(2);
    expect(first.readyState).toBe(3);
    const second = r.sockets[1]!;
    second.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.count('response.create')).toBe(1);
    expect(second.sent).toContainEqual(
      expect.objectContaining({
        type: 'conversation.item.create',
        item: expect.objectContaining({
          role: 'user',
          content: [{ type: 'input_text', text: '停止后台任务' }],
        }),
      }),
    );
    first.response('late-old-permission');
    first.tool('late-old-permission', 'old-tool');
    first.done('late-old-permission');
    expect(r.onFunctionCall).not.toHaveBeenCalled();
    second.response('new-user-answer');
    second.tool('new-user-answer', 'new-tool');
    second.done('new-user-answer');
    expect(r.onFunctionCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ callId: 'new-tool' }),
    );
    expect(r.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        fatal: false,
        code: 'response_cancel_timeout',
      }),
    );
  });

  it('bounds a direct request with no created ACK and does not retry forever', async () => {
    const r = await rig();
    r.sockets[0]!.user('input-1', '请停止');
    await vi.advanceTimersByTimeAsync(100);
    r.sockets[1]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    r.sockets[2]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.sockets).toHaveLength(3);
    expect(r.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'realtime_recovery_exhausted',
        fatal: true,
      }),
    );
    await expect(r.session.closed).resolves.toMatchObject({ reason: 'error' });
  });

  it('uses the cancellation ACK barrier when available and rejects repeated retired ACKs', async () => {
    const r = await rig();
    const socket = r.sockets[0]!;
    r.session.askPermission?.('synthetic');
    socket.user('new-input', '停止');
    socket.response('old-permission');
    expect(socket.count('response.cancel')).toBe(1);
    expect(socket.count('response.create')).toBe(1);
    socket.done('old-permission', 'cancelled');
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.count('response.create')).toBe(2);
    socket.response('old-permission');
    socket.tool('old-permission', 'late-tool');
    expect(r.onFunctionCall).not.toHaveBeenCalled();
    socket.response('new-answer');
    socket.tool('new-answer', 'valid-tool');
    socket.done('new-answer');
    expect(r.onFunctionCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ callId: 'valid-tool' }),
    );
    expect(r.sockets).toHaveLength(1);
  });

  it('does not replay dispatched tools and safely ignores their late output after recovery', async () => {
    const r = await rig();
    const first = r.sockets[0]!;
    first.user('clone-input', '克隆仓库');
    first.response('clone-response');
    first.tool('clone-response', 'clone-call');
    first.done('clone-response');
    first.user('stop-input', '停止');
    await vi.advanceTimersByTimeAsync(100);
    r.sockets[1]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.onFunctionCall).toHaveBeenCalledTimes(1);
    expect(
      r.session.submitFunctionOutput(
        { callEpoch: 1, callId: 'clone-call' },
        '{"status":"accepted"}',
      ),
    ).toBe(true);
    expect(
      r.session.submitFunctionOutput(
        { callEpoch: 1, callId: 'clone-call' },
        '{"status":"accepted"}',
      ),
    ).toBe(true);
    expect(r.sockets[1]!.count('conversation.item.create')).toBe(2);
    expect(r.onProtocolDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool.output_ignored',
        reason: 'transport_recovered',
      }),
    );
  });

  it('does not reconnect ordinary provider errors', async () => {
    const r = await rig();
    r.sockets[0]!.message({
      type: 'error',
      error: { message: 'Access denied', type: 'invalid_request_error' },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.sockets).toHaveLength(1);
    expect(r.onError).toHaveBeenCalledWith(
      expect.objectContaining({ fatal: true }),
    );
  });

  it('closing while reconnecting aborts replacement and clears queued microphone input', async () => {
    const r = await rig();
    r.sockets[0]!.user('input-1', '停止');
    await vi.advanceTimersByTimeAsync(100);
    expect(r.session.pushAudio(Buffer.alloc(3200, 1))).toBe(true);
    r.session.close();
    r.sockets[1]!.ready();
    await vi.advanceTimersByTimeAsync(500);
    expect(r.sockets[1]!.count('input_audio_buffer.append')).toBe(0);
    await expect(r.session.closed).resolves.toMatchObject({ reason: 'client' });
  });

  it('retries one failed recovery handshake with a new fence and ignores its late events', async () => {
    const r = await rig();
    r.sockets[0]!.user('input-1', '停止');
    await vi.advanceTimersByTimeAsync(100);
    const failed = r.sockets[1]!;
    await vi.advanceTimersByTimeAsync(100);
    expect(r.sockets).toHaveLength(3);
    r.sockets[2]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    failed.ready();
    failed.response('late-failed');
    failed.tool('late-failed', 'late-tool');
    expect(r.onFunctionCall).not.toHaveBeenCalled();
    expect(r.onError.mock.calls.some(([error]) => error.fatal)).toBe(false);
    expect(r.sockets[2]!.count('response.create')).toBe(1);
  });

  it('restores current permission context before the new user vote and aborts if restoration throws', async () => {
    const holder: { session?: QwenRealtimeSession } = {};
    const r = await rig({
      onTransportRecovery(event) {
        if (event.phase === 'restoring')
          holder.session!.sendBackendContext('[PERMISSION] req_9 is pending');
      },
    });
    holder.session = r.session;
    r.session.askPermission?.('old');
    r.sockets[0]!.user('vote', '允许');
    await vi.advanceTimersByTimeAsync(20);
    const second = r.sockets[1]!;
    second.ready();
    await vi.advanceTimersByTimeAsync(0);
    const wire = JSON.stringify(second.sent);
    expect(wire.indexOf('req_9')).toBeLessThan(wire.indexOf('允许'));
    expect(wire.lastIndexOf('response.create')).toBeGreaterThan(
      wire.indexOf('req_9'),
    );

    const failing = await rig({
      onTransportRecovery(event) {
        if (event.phase === 'restoring') throw new Error('Control state lost');
      },
    });
    failing.sockets[0]!.user('vote', '允许');
    await vi.advanceTimersByTimeAsync(100);
    failing.sockets[1]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(failing.sockets[1]!.count('response.create')).toBe(0);
    expect(failing.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'realtime_recovery_restore_failed',
        fatal: true,
      }),
    );
  });

  it('replays only the freshest memory snapshot without dropping other queued context', async () => {
    const holder: { session?: QwenRealtimeSession } = {};
    const latest = '[MEMORY_CONTEXT] {"enabled":false,"revision":3}';
    const r = await rig({
      onTransportRecovery(event) {
        if (event.phase === 'restoring')
          holder.session!.sendBackendContext(latest);
      },
    });
    holder.session = r.session;
    r.sockets[0]!.user('input', '请继续');
    await vi.advanceTimersByTimeAsync(100);
    r.session.sendBackendContext(
      '[MEMORY_CONTEXT] {"enabled":true,"revision":1}',
    );
    r.session.sendBackendContext('[PERMISSION] req_9 is still pending');
    r.session.sendBackendContext(
      '[MEMORY_CONTEXT] {"enabled":true,"revision":2}',
    );
    const second = r.sockets[1]!;
    second.ready();
    await vi.advanceTimersByTimeAsync(0);
    const contexts = second.sent.filter(
      (event) => event['type'] === 'conversation.item.create',
    );
    const wire = contexts
      .map((event) => {
        const item = event['item'] as { content: [{ text: string }] };
        return item.content[0].text;
      })
      .join('\n');
    expect(wire).toContain('req_9 is still pending');
    expect(wire).not.toContain('"revision":1');
    expect(wire).not.toContain('"revision":2');
    expect(
      contexts.filter((event) =>
        JSON.stringify(event).includes('[MEMORY_CONTEXT]'),
      ),
    ).toHaveLength(1);
    expect(wire).toContain(latest);
    expect(wire.indexOf('[MEMORY_CONTEXT]')).toBeLessThan(
      wire.indexOf('请继续'),
    );
  });

  it('replays a complete microphone prefix once, then protocol silence and separately queued new audio', async () => {
    const onTransportRecovery = vi.fn();
    const r = await rig({ onTransportRecovery });
    const first = r.sockets[0]!;
    r.session.askPermission?.('synthetic');
    r.session.pushAudio(Buffer.alloc(6400, 7));
    first.message({
      type: 'input_audio_buffer.speech_started',
      item_id: 'raw-input',
      audio_start_ms: 0,
    });
    first.message({
      type: 'input_audio_buffer.speech_stopped',
      item_id: 'raw-input',
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(() => r.session.pushAudio(Buffer.alloc(3))).toThrow(/PCM16/);
    expect(() => r.session.pushAudio(Buffer.alloc(65538))).toThrow(/PCM16/);
    r.session.pushAudio(Buffer.alloc(3200, 9));
    const second = r.sockets[1]!;
    second.ready();
    await vi.advanceTimersByTimeAsync(0);
    const audio = second.sent
      .filter((event) => event['type'] === 'input_audio_buffer.append')
      .map((event) => Buffer.from(String(event['audio']), 'base64'));
    expect(audio).toEqual([
      Buffer.alloc(6400, 7),
      Buffer.alloc(32000),
      Buffer.alloc(3200, 9),
    ]);
    expect(second.count('input_audio_buffer.commit')).toBe(0);
    expect(second.count('response.create')).toBe(0);
    expect(onTransportRecovery).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'completed', inputKind: 'audio' }),
    );
  });

  it('does not replay an unknown microphone boundary or opening tail and asks for repetition', async () => {
    const r = await rig();
    r.session.askPermission?.('synthetic');
    r.session.pushAudio(Buffer.alloc(6400, 7));
    r.sockets[0]!.message({
      type: 'input_audio_buffer.speech_started',
      item_id: 'unknown',
    });
    await vi.advanceTimersByTimeAsync(20);
    r.session.pushAudio(Buffer.alloc(3200, 9));
    const second = r.sockets[1]!;
    second.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.count('input_audio_buffer.append')).toBe(0);
    expect(second.count('response.create')).toBe(0);
    expect(r.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'realtime_recovery_input_unavailable',
        fatal: false,
      }),
    );
  });

  it('places recovery tail silence after both halves when the user muted mid-utterance during reconnect', async () => {
    const r = await rig();
    r.session.askPermission?.('synthetic');
    r.session.pushAudio(Buffer.alloc(6400, 7));
    r.sockets[0]!.message({
      type: 'input_audio_buffer.speech_started',
      item_id: 'raw-input',
      audio_start_ms: 0,
    });
    await vi.advanceTimersByTimeAsync(20);
    r.session.pushAudio(Buffer.alloc(3200, 9));
    r.session.setInputMuted(true);
    const second = r.sockets[1]!;
    second.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      second.sent
        .filter((event) => event['type'] === 'input_audio_buffer.append')
        .map((event) => Buffer.from(String(event['audio']), 'base64')),
    ).toEqual([
      Buffer.alloc(6400, 7),
      Buffer.alloc(3200, 9),
      Buffer.alloc(32000),
    ]);
    expect(second.count('input_audio_buffer.commit')).toBe(0);
  });

  it('fails closed instead of dispatching a new call that collides with an unresolved old transport tool', async () => {
    const r = await rig();
    const first = r.sockets[0]!;
    first.user('clone-input', '克隆仓库');
    first.response('old');
    first.tool('old', 'collision');
    first.done('old');
    first.user('stop-input', '停止');
    await vi.advanceTimersByTimeAsync(100);
    const second = r.sockets[1]!;
    second.ready();
    await vi.advanceTimersByTimeAsync(0);
    second.response('new');
    second.tool('new', 'collision');
    second.done('new');
    expect(r.onFunctionCall).toHaveBeenCalledTimes(1);
    expect(r.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'realtime_tool_call_collision',
        fatal: true,
      }),
    );
    expect(second.readyState).toBe(3);
  });

  it('preserves the normal close guard unless pending input was explicitly discarded', async () => {
    const r = await rig();
    r.sockets[0]!.message({
      type: 'input_audio_buffer.speech_started',
      item_id: 'unfinished',
    });
    r.session.close();
    expect(r.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'unrecoverable_input', fatal: true }),
    );
    await expect(r.session.closed).resolves.toMatchObject({ reason: 'error' });
  });
});

describe('bounded recovery input', () => {
  it('prefers the latest ASR, excludes dispatched/completed turns and never buffers heartbeat silence', () => {
    const buffer = new RecoveryInputBuffer();
    buffer.protocolSilence(32_000);
    buffer.audio(Buffer.alloc(3200, 7));
    buffer.speech('new-input', 1000);
    expect(buffer.snapshot()).toEqual({
      kind: 'audio',
      audio: Buffer.alloc(3200, 7),
      stopped: false,
    });
    buffer.transcript('new-input', '停止');
    expect(buffer.snapshot()).toEqual({
      kind: 'text',
      itemId: 'new-input',
      text: '停止',
    });
    buffer.dispatched('new-input');
    expect(buffer.snapshot()).toEqual({
      kind: 'none',
      reason: 'tool_dispatched',
    });
    buffer.speech('next', 1000);
    buffer.completed('next');
    expect(buffer.snapshot()).toEqual({ kind: 'none', reason: 'completed' });
  });

  it.each([undefined, -1, Number.POSITIVE_INFINITY, 999_999])(
    'never guesses a partial utterance when start is %s',
    (start) => {
      const buffer = new RecoveryInputBuffer();
      buffer.audio(Buffer.alloc(32_000, 3));
      buffer.speech('input-1', start);
      expect(buffer.snapshot()).toEqual({
        kind: 'none',
        reason: 'unavailable',
      });
      buffer.transcript('input-1', '不要删除文件');
      expect(buffer.snapshot()).toEqual({
        kind: 'text',
        itemId: 'input-1',
        text: '不要删除文件',
      });
    },
  );

  it('moves a committed input without a speech-start event to a new unknown boundary, not old speech', () => {
    const buffer = new RecoveryInputBuffer();
    buffer.audio(Buffer.alloc(32_000, 3));
    buffer.speech('old', 0);
    buffer.transcript('old', '删除文件');
    buffer.committed('new');
    expect(buffer.snapshot()).toEqual({ kind: 'none', reason: 'unavailable' });
    buffer.transcript('new', '不要删除');
    expect(buffer.snapshot()).toEqual({
      kind: 'text',
      itemId: 'new',
      text: '不要删除',
    });
  });
});
