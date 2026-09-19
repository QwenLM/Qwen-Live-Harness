/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolDispatcher } from './dispatcher.js';
import type { ToolContext, ToolHandler } from './dispatcher.js';
import type { RuntimeFailureSink } from '../log/runtime-failure.js';

function makeContext(
  transcript: ToolContext['activeTranscript'] = [],
): ToolContext {
  return { activeTranscript: transcript };
}

function makeDispatcher(
  handlers: Record<string, ToolHandler>,
  timeoutMs?: number,
  onFailure?: RuntimeFailureSink,
): ToolDispatcher {
  return new ToolDispatcher({
    handlers: new Map(Object.entries(handlers)),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(onFailure ? { onFailure } : {}),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ToolDispatcher', () => {
  it('answers an unregistered tool with an error receipt instead of stalling', async () => {
    const dispatcher = makeDispatcher({});

    const result = await dispatcher.dispatch('mystery', '{}', makeContext());

    expect(result.ok).toBe(false);
    const receipt = JSON.parse(result.receipt) as {
      status: string;
      note: string;
    };
    expect(receipt.status).toBe('error');
    expect(receipt.note).toContain('No handler');
    expect(receipt.note).toContain('mystery');
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['a JSON array', '[1, 2, 3]'],
    ['a JSON scalar', '"hello"'],
    ['JSON null', 'null'],
    ['a JSON number', '123'],
    ['a JSON boolean', 'true'],
    ['a string-encoded object', '"{}"'],
  ])(
    'rejects %s arguments without executing the handler',
    async (_label, raw) => {
      vi.useFakeTimers();
      const seen: Array<Record<string, unknown>> = [];
      const dispatcher = makeDispatcher({
        echo: (args) => {
          seen.push(args);
          return { status: 'ok' };
        },
      });

      const result = await dispatcher.dispatch('echo', raw, makeContext());

      expect(result).toEqual({
        ok: false,
        receipt: JSON.stringify({
          status: 'error',
          code: 'invalid_arguments',
          note: 'Tool arguments must be a valid JSON object. No action was executed.',
        }),
      });
      expect(seen).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('still dispatches an explicit empty JSON object for argument-free tools', async () => {
    const handler = vi.fn<ToolHandler>(() => ({ status: 'ok' }));
    const ctx = makeContext();
    const dispatcher = makeDispatcher({ appshot: handler });
    expect(await dispatcher.dispatch('appshot', ' \n {} \t', ctx)).toEqual({
      ok: true,
      receipt: '{"status":"ok"}',
    });
    expect(handler).toHaveBeenCalledExactlyOnceWith({}, ctx);
  });

  it('passes well-formed JSON object arguments through to the handler', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const dispatcher = makeDispatcher({
      echo: (args) => {
        seen.push(args);
        return { status: 'ok' };
      },
    });

    await dispatcher.dispatch(
      'echo',
      '{"sessionHandle":"session_1","count":2}',
      makeContext(),
    );

    expect(seen).toEqual([{ sessionHandle: 'session_1', count: 2 }]);
  });

  it('serializes a successful handler result as the JSON receipt', async () => {
    const outcome = { status: 'accepted', jobHandle: 'job_1', queued: false };
    const dispatcher = makeDispatcher({
      start_job: () => outcome,
    });

    const result = await dispatcher.dispatch('start_job', '{}', makeContext());

    expect(result.ok).toBe(true);
    expect(result.receipt).toBe(JSON.stringify(outcome));
  });

  it('awaits async handlers before building the receipt', async () => {
    const dispatcher = makeDispatcher({
      async_tool: async () => ({ status: 'done' }),
    });

    const result = await dispatcher.dispatch('async_tool', '{}', makeContext());

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.receipt)).toEqual({ status: 'done' });
  });

  it('turns a thrown handler error into an error receipt with the message truncated to 300 chars', async () => {
    const longMessage = 'x'.repeat(400);
    const dispatcher = makeDispatcher({
      boom: () => {
        throw new Error(longMessage);
      },
    });

    const result = await dispatcher.dispatch('boom', '{}', makeContext());

    expect(result.ok).toBe(false);
    const receipt = JSON.parse(result.receipt) as {
      status: string;
      note: string;
    };
    expect(receipt.status).toBe('error');
    expect(receipt.note).toBe(longMessage.slice(0, 300));
    expect(receipt.note).toHaveLength(300);
  });

  it('falls back to a generic note for non-Error and empty-message throws', async () => {
    const dispatcher = makeDispatcher({
      raw_throw: () => {
        // A non-Error throw (object, not string — the lint bans literals).
        throw { reason: 'not an error object' };
      },
      empty_message: () => {
        throw new Error('');
      },
    });

    for (const name of ['raw_throw', 'empty_message']) {
      const result = await dispatcher.dispatch(name, '{}', makeContext());
      expect(result.ok).toBe(false);
      expect(JSON.parse(result.receipt)).toEqual({
        status: 'error',
        note: 'the tool failed',
      });
    }
  });

  it('times out a hung handler and returns the timeout receipt', async () => {
    vi.useFakeTimers();
    const dispatcher = makeDispatcher(
      {
        hang: () => new Promise<Record<string, unknown>>(() => {}),
      },
      50,
    );

    const pending = dispatcher.dispatch('hang', '{}', makeContext());
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;

    expect(result.ok).toBe(false);
    const receipt = JSON.parse(result.receipt) as {
      status: string;
      note: string;
    };
    // The handler keeps running (side effects are real): the receipt must
    // read as "still in progress", never as a retryable failure.
    expect(receipt.status).toBe('pending');
    expect(receipt.note).toContain('Do not retry');
  });

  it('does not time out a handler that resolves before the deadline', async () => {
    vi.useFakeTimers();
    const dispatcher = makeDispatcher(
      {
        quick: () => ({ status: 'ok' }),
      },
      50,
    );

    const result = await dispatcher.dispatch('quick', '{}', makeContext());

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.receipt)).toEqual({ status: 'ok' });
  });

  it('uses capability-specific timeout guidance without inventing a backend job', async () => {
    vi.useFakeTimers();
    const note =
      'The result is unknown. Do not immediately retry or claim success.';
    const dispatcher = new ToolDispatcher({
      handlers: new Map([
        ['appshot', () => new Promise<Record<string, unknown>>(() => {})],
      ]),
      timeoutMs: 50,
      timeoutNote: note,
    });
    const pending = dispatcher.dispatch('appshot', '{}', makeContext());
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toEqual({
      ok: false,
      receipt: JSON.stringify({ status: 'pending', note }),
    });
  });

  it('threads ctx.activeTranscript through to the handler untouched', async () => {
    const transcript = [
      { role: 'user' as const, text: 'run the tests' },
      { role: 'assistant' as const, text: 'Starting them now.' },
    ];
    let received: ToolContext | undefined;
    const dispatcher = makeDispatcher({
      capture: (_args, ctx) => {
        received = ctx;
        return { status: 'ok' };
      },
    });

    await dispatcher.dispatch('capture', '{}', makeContext(transcript));

    expect(received?.activeTranscript).toBe(transcript);
  });

  it('reports an unknown tool without retaining arguments or conversation', async () => {
    const onFailure = vi.fn<RuntimeFailureSink>();
    const dispatcher = makeDispatcher({}, undefined, onFailure);
    const result = await dispatcher.dispatch(
      'mystery',
      '{"secret":"PRIVATE-ARGUMENT"}',
      makeContext([{ role: 'user', text: 'PRIVATE-CONVERSATION' }]),
    );
    expect(result).toEqual({
      ok: false,
      receipt: JSON.stringify({
        status: 'error',
        note: 'No handler for tool mystery.',
      }),
    });
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({
      source: 'tool',
      code: 'tool_unknown',
      stage: 'lookup',
      impact: 'operation',
      toolName: 'mystery',
      message: 'The requested tool has no registered handler.',
    });
    expect(JSON.stringify(onFailure.mock.calls)).not.toMatch(
      /PRIVATE-ARGUMENT|PRIVATE-CONVERSATION/,
    );
  });

  it.each([
    ['', 'tool_arguments_invalid'],
    ['   ', 'tool_arguments_invalid'],
    ['{"secret":"PRIVATE-ARGUMENT"', 'tool_arguments_invalid'],
    ['["PRIVATE-ARGUMENT"]', 'tool_arguments_shape'],
    ['"PRIVATE-ARGUMENT"', 'tool_arguments_shape'],
    ['null', 'tool_arguments_shape'],
    ['false', 'tool_arguments_shape'],
    ['123', 'tool_arguments_shape'],
  ])(
    'reports %s as %s and refuses execution without exposing arguments',
    async (raw, code) => {
      const onFailure = vi.fn<RuntimeFailureSink>();
      const handler = vi.fn<ToolHandler>(() => ({ status: 'accepted' }));
      const dispatcher = makeDispatcher(
        { echo: handler },
        undefined,
        onFailure,
      );
      const ctx = makeContext();
      expect(await dispatcher.dispatch('echo', raw, ctx)).toEqual({
        ok: false,
        receipt: JSON.stringify({
          status: 'error',
          code: 'invalid_arguments',
          note: 'Tool arguments must be a valid JSON object. No action was executed.',
        }),
      });
      expect(handler).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          source: 'tool',
          code,
          stage: 'arguments',
          impact: 'operation',
          toolName: 'echo',
        }),
      );
      expect(JSON.stringify(onFailure.mock.calls)).not.toContain(
        'PRIVATE-ARGUMENT',
      );
    },
  );

  it.each(['{}', '  {}  ', '{"private":"PRIVATE-ARGUMENT"}'])(
    'does not report a failure for valid object arguments: %s',
    async (raw) => {
      const onFailure = vi.fn<RuntimeFailureSink>();
      const dispatcher = makeDispatcher(
        { echo: () => ({ status: 'ok' }) },
        undefined,
        onFailure,
      );
      expect((await dispatcher.dispatch('echo', raw, makeContext())).ok).toBe(
        true,
      );
      expect(onFailure).not.toHaveBeenCalled();
    },
  );

  it('reports handler failures with controlled diagnostics while preserving the existing error receipt', async () => {
    const onFailure = vi.fn<RuntimeFailureSink>();
    const message = 'PRIVATE-ERROR-BODY token=sk-test-secret\n\u001b[31m';
    const handler = vi.fn<ToolHandler>(() => {
      throw new TypeError(message);
    });
    const dispatcher = makeDispatcher(
      { broken: handler },
      undefined,
      onFailure,
    );
    expect(await dispatcher.dispatch('broken', '{}', makeContext())).toEqual({
      ok: false,
      receipt: JSON.stringify({ status: 'error', note: message }),
    });
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        code: 'tool_handler_failed',
        stage: 'handler',
        toolName: 'broken',
        errorName: 'TypeError',
        executionUncertain: true,
      }),
    );
    expect(JSON.stringify(onFailure.mock.calls)).not.toMatch(
      /PRIVATE-ERROR-BODY|sk-test-secret|31m/,
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it('distinguishes serialization failures after handler execution without retrying the handler', async () => {
    const onFailure = vi.fn<RuntimeFailureSink>();
    const circular: Record<string, unknown> = { body: 'PRIVATE-RESULT' };
    circular['self'] = circular;
    const handler = vi.fn<ToolHandler>(() => circular);
    const dispatcher = makeDispatcher(
      { cyclic: handler },
      undefined,
      onFailure,
    );
    const result = await dispatcher.dispatch('cyclic', '{}', makeContext());
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.receipt)).toMatchObject({
      status: 'error',
      note: expect.stringContaining('circular'),
    });
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        code: 'tool_result_serialization_failed',
        stage: 'serialization',
        errorName: 'TypeError',
        executionUncertain: true,
      }),
    );
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain(
      'PRIVATE-RESULT',
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it('reports a business error receipt without changing the existing ok:true contract or retaining its note', async () => {
    const onFailure = vi.fn<RuntimeFailureSink>();
    const outcome = {
      status: 'error',
      note: 'PRIVATE-BUSINESS-NOTE',
      headers: { Authorization: 'PRIVATE-HEADER' },
    };
    const dispatcher = makeDispatcher(
      { reject: () => outcome },
      undefined,
      onFailure,
    );
    expect(await dispatcher.dispatch('reject', '{}', makeContext())).toEqual({
      ok: true,
      receipt: JSON.stringify(outcome),
    });
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        code: 'tool_business_rejected',
        stage: 'result',
        toolName: 'reject',
        impact: 'operation',
      }),
    );
    expect(JSON.stringify(onFailure.mock.calls)).not.toMatch(
      /PRIVATE-BUSINESS-NOTE|PRIVATE-HEADER|Authorization/,
    );
  });

  it('observes only the serialized receipt without reevaluating getters or toJSON', async () => {
    const onFailure = vi.fn<RuntimeFailureSink>();
    const toJSON = vi.fn(() => ({ status: 'error', note: 'fixture note' }));
    const dispatcher = makeDispatcher(
      { custom: () => ({ toJSON }) },
      undefined,
      onFailure,
    );
    expect(await dispatcher.dispatch('custom', '{}', makeContext())).toEqual({
      ok: true,
      receipt: '{"status":"error","note":"fixture note"}',
    });
    expect(toJSON).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    onFailure.mockClear();
    const outcome: Record<string, unknown> = { result: 'ok' };
    const status = vi.fn(() => {
      throw new Error('non-enumerable getter must not run');
    });
    Object.defineProperty(outcome, 'status', {
      enumerable: false,
      get: status,
    });
    expect(
      await makeDispatcher(
        { custom: () => outcome },
        undefined,
        onFailure,
      ).dispatch('custom', '{}', makeContext()),
    ).toEqual({ ok: true, receipt: '{"result":"ok"}' });
    expect(status).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports timeout uncertainty but leaves late handler execution running', async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn<RuntimeFailureSink>();
    let finish!: (value: Record<string, unknown>) => void;
    const completed = vi.fn();
    const handler = vi.fn<ToolHandler>(() =>
      new Promise<Record<string, unknown>>((resolve) => {
        finish = resolve;
      }).then((value) => {
        completed();
        return value;
      }),
    );
    const dispatcher = makeDispatcher({ slow: handler }, 50, onFailure);
    const pending = dispatcher.dispatch('slow', '{}', makeContext());
    await vi.advanceTimersByTimeAsync(50);
    expect(JSON.parse((await pending).receipt).status).toBe('pending');
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        code: 'tool_timeout_pending',
        stage: 'handler',
        errorName: 'ToolTimeoutError',
        executionUncertain: true,
      }),
    );
    expect(completed).not.toHaveBeenCalled();
    finish({ status: 'accepted' });
    await Promise.resolve();
    expect(completed).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('contains observer exceptions across parser, handler, serialization, lookup and business failures', async () => {
    const onFailure = vi.fn<RuntimeFailureSink>(() => {
      throw new Error('diagnostic sink failed');
    });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const echo = vi.fn<ToolHandler>(() => ({ status: 'accepted' }));
    const dispatcher = makeDispatcher(
      {
        echo,
        broken: () => {
          throw new Error('handler failure');
        },
        cyclic: () => circular,
        business: () => ({ status: 'error' }),
      },
      undefined,
      onFailure,
    );
    for (const raw of ['{broken', '[]']) {
      const result = await dispatcher.dispatch('echo', raw, makeContext());
      expect(result.ok).toBe(false);
      expect(JSON.parse(result.receipt)).toMatchObject({
        status: 'error',
        code: 'invalid_arguments',
      });
    }
    expect((await dispatcher.dispatch('broken', '{}', makeContext())).ok).toBe(
      false,
    );
    expect((await dispatcher.dispatch('cyclic', '{}', makeContext())).ok).toBe(
      false,
    );
    expect((await dispatcher.dispatch('missing', '{}', makeContext())).ok).toBe(
      false,
    );
    expect(await dispatcher.dispatch('business', '{}', makeContext())).toEqual({
      ok: true,
      receipt: '{"status":"error"}',
    });
    expect(echo).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(6);
  });

  it('keeps the pending timeout receipt when the diagnostic sink throws', async () => {
    vi.useFakeTimers();
    const dispatcher = makeDispatcher(
      { hang: () => new Promise<Record<string, unknown>>(() => {}) },
      50,
      () => {
        throw new Error('diagnostic sink failed');
      },
    );
    const pending = dispatcher.dispatch('hang', '{}', makeContext());
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.receipt).status).toBe('pending');
  });
});
