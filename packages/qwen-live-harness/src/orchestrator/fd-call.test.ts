/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { FdCall, type FdCallOptions } from './fd-call.js';
import type {
  GptLiveCallbacks,
  GptLiveSession,
} from '../realtime/gpt-live-session.js';

function fixture() {
  let callbacks!: GptLiveCallbacks;
  const session: GptLiveSession = {
    sessionId: 'session-fake',
    pushAudio: vi.fn(() => true),
    append: vi.fn(() => true),
    setInputMuted: vi.fn(),
    close: vi.fn(async () => true),
    submitToolOutputs: vi.fn(() => true),
    configureResponses: vi.fn(() => true),
  };
  const tool = vi.fn<FdCallOptions['tool']>(async (call) =>
    call.isCurrent() ? 'accepted' : 'stale',
  );
  const call = new FdCall({
    config: {
      endpoint: 'https://example.com',
      apiKey: 'fake',
      model: 'gpt-live-1',
      instructions: '',
      responses: { model: 'gpt-6-luna', instructions: '', tools: [] },
    },
    sendAudio: vi.fn(() => true),
    finishAudio: vi.fn(),
    transcript: vi.fn(),
    tool,
    error: vi.fn(),
    usage: vi.fn(),
    closed: vi.fn(),
    open: async (_config, handlers) => {
      callbacks = handlers;
      return session;
    },
  });
  const fragment = (text = 'Analyze the repo.', startMs = 1000, endMs = 1300) =>
    callbacks.onTranscript({ role: 'user', text, startMs, endMs });
  const delegate = (id = 'd1', offsetMs = 1300) =>
    callbacks.onDelegation({ id, offsetMs });
  const event = (
    type: string,
    rest: Record<string, unknown> = {},
    delegationId = 'd1',
  ) => callbacks.onResponse({ delegationId, event: { type, ...rest } });
  const response = (id = 'r1', delegationId = 'd1') =>
    event('response.created', { response: { id } }, delegationId);
  const fn = (
    callId = 'c1',
    name = 'handoff',
    args = '{"task":"Analyze the repo."}',
    delegationId = 'd1',
  ) =>
    event(
      'response.output_item.done',
      {
        item: { type: 'function_call', call_id: callId, name, arguments: args },
      },
      delegationId,
    );
  const done = (id = 'r1', delegationId = 'd1') =>
    event('response.completed', { response: { id, output: [] } }, delegationId);
  return {
    call,
    tool,
    session,
    fragment,
    delegate,
    event,
    response,
    fn,
    done,
    callbacks: () => callbacks,
  };
}

afterEach(() => vi.useRealTimers());

it('executes complete function items once, returns every output, then continues the backend', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.call.start();
  f.fragment();
  f.delegate();
  f.response();
  f.event('response.function_call_arguments.done', { arguments: '{}' });
  f.fn();
  f.fn();
  f.fn('c2', 'session_list', '{}');
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.tool).not.toHaveBeenCalled();
  f.done();
  await vi.advanceTimersByTimeAsync(600);
  expect(f.tool).toHaveBeenCalledTimes(2);
  expect(f.tool.mock.calls[0]?.[0]).toMatchObject({
    delegationId: 'd1',
    responseId: 'r1',
    input: { text: 'Analyze the repo.' },
  });
  expect(f.session.submitToolOutputs).toHaveBeenCalledWith([
    { callId: 'c1', output: 'accepted' },
    { callId: 'c2', output: 'accepted' },
  ]);
  f.done();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.tool).toHaveBeenCalledTimes(2);
  await f.call.close();
});

it('feeds background facts during speech and backend execution without waiting for playback', async () => {
  const f = fixture();
  await f.call.start();
  f.callbacks().onAudio(Buffer.alloc(640, 10));
  expect(f.call.append('thinking', 'The old approach is unavailable.')).toBe(
    true,
  );
  expect(f.call.append('instructions', 'Explain the corrected approach.')).toBe(
    true,
  );
  expect(f.session.append).toHaveBeenCalledWith(
    'thinking',
    'The old approach is unavailable.',
  );
  await f.call.close();
});

it('keeps a delegation bound to its original input across backend continuations', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.call.start();
  f.fragment();
  f.delegate();
  f.response();
  f.fn();
  f.done();
  await vi.advanceTimersByTimeAsync(600);
  f.fragment('Never mind.', 5000, 5300);
  f.response('r2');
  f.fn('c2', 'session_stop', '{}');
  f.done('r2');
  await vi.advanceTimersByTimeAsync(10);
  expect(f.tool.mock.calls.at(-1)?.[0].input?.text).toBe('Analyze the repo.');
  expect(f.session.submitToolOutputs).toHaveBeenLastCalledWith([
    { callId: 'c2', output: 'stale' },
  ]);
  await f.call.close();
});

it('waits for all overlapping Responses tool results before a single continuation', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.call.start();
  f.fragment();
  f.delegate();
  f.response();
  f.fn();
  f.done();
  f.delegate('d2');
  f.response('r2', 'd2');
  f.fn('c2', 'session_list', '{}', 'd2');
  await vi.advanceTimersByTimeAsync(600);
  expect(f.session.submitToolOutputs).not.toHaveBeenCalled();
  f.done('r2', 'd2');
  await vi.advanceTimersByTimeAsync(600);
  expect(f.session.submitToolOutputs).toHaveBeenCalledOnce();
  expect(f.session.submitToolOutputs).toHaveBeenCalledWith([
    { callId: 'c1', output: 'accepted' },
    { callId: 'c2', output: 'accepted' },
  ]);
  await f.call.close();
});

it('does not execute failed responses and cannot authorize calls from unknown delegations', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.call.start();
  f.fragment();
  f.response('fake', 'unknown');
  f.fn('fake', 'handoff', '{}', 'unknown');
  f.done('fake', 'unknown');
  f.delegate();
  f.response();
  f.fn();
  f.event('response.failed', { response: { id: 'r1' } });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.tool).not.toHaveBeenCalled();
  await f.call.close();
});

it('does not submit late results or additional actions after call closure', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.call.start();
  f.fragment();
  f.delegate();
  f.response();
  f.fn();
  f.done();
  await f.call.close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.tool).not.toHaveBeenCalled();
  expect(f.session.submitToolOutputs).not.toHaveBeenCalled();
});
