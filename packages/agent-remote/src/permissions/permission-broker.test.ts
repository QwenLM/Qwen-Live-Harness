/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  BackendAdaptor,
  BackendHandle,
  PermissionOption,
} from '../adaptor/types.js';
import {
  PermissionBroker,
  type PermissionBrokerMode,
  type PermissionDecisionEvent,
} from './permission-broker.js';

const BACKEND: BackendHandle = { adaptor: 'fake', id: 'session-1' };
const OPTIONS: readonly PermissionOption[] = [
  { optionId: 'all', kind: 'proceed', escalation: 'always' },
  { optionId: 'once', kind: 'proceed', escalation: 'once' },
  { optionId: 'reject', kind: 'reject', escalation: 'once' },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function rig(initial: PermissionBrokerMode = 'ask') {
  const state = { mode: initial };
  const adaptor = {
    respondPermission: vi.fn(
      async (): Promise<'delivered' | 'already_resolved'> => 'delivered',
    ),
  };
  const decisions: PermissionDecisionEvent[] = [];
  const log = vi.fn();
  const getPermissionMode = vi.fn(() => state.mode);
  const broker = new PermissionBroker({
    adaptorFor: () => adaptor as unknown as BackendAdaptor,
    getPermissionMode,
    now: () => 1000,
    log,
    onDecision: (event) => {
      decisions.push(event);
    },
  });
  const request = (
    requestId: string,
    extra: Partial<Parameters<PermissionBroker['onRequest']>[0]> = {},
  ) =>
    broker.onRequest({
      requestId,
      backend: BACKEND,
      sessionHandle: 'session_1',
      jobRef: 'job-1',
      title: 'Run command',
      options: OPTIONS,
      details: {
        toolCallId: `tool-${requestId}`,
        toolName: 'shell',
        command: 'printf "%s" "a  b"',
        rawInput: { command: 'printf "%s" "a  b"' },
      },
      ...extra,
    });
  return { state, adaptor, broker, decisions, log, getPermissionMode, request };
}

describe('PermissionBroker global permission mode', () => {
  it('defaults to ask and preserves pending action metadata', async () => {
    const { broker, request, adaptor } = rig();
    const first = await request('r1');
    expect(first).toMatchObject({
      autoAnswered: false,
      alreadyPending: false,
      pending: {
        requestHandle: 'req_1',
        requestId: 'r1',
        sessionHandle: 'session_1',
        jobRef: 'job-1',
        permissionMode: 'ask',
        createdAt: 1000,
        details: { toolCallId: 'tool-r1', command: 'printf "%s" "a  b"' },
      },
    });
    expect(first.pending).not.toHaveProperty('alwaysPolicy');
    expect(broker.pendingUserRequests).toEqual([first.pending]);
    expect(adaptor.respondPermission).not.toHaveBeenCalled();
  });

  it('uses ask when no callback is supplied or the callback fails', async () => {
    for (const getPermissionMode of [
      undefined,
      () => {
        throw new Error('Unavailable configuration');
      },
    ]) {
      const vote = vi.fn();
      const broker = new PermissionBroker({
        adaptorFor: () =>
          ({ respondPermission: vote }) as unknown as BackendAdaptor,
        ...(getPermissionMode ? { getPermissionMode } : {}),
      });
      const ask = await broker.onRequest({
        requestId: 'r1',
        backend: BACKEND,
        sessionHandle: 'session_1',
        title: 'Run',
        options: OPTIONS,
      });
      expect(ask.pending.permissionMode).toBe('ask');
      expect(ask.autoAnswered).toBe(false);
      expect(vote).not.toHaveBeenCalled();
    }
  });

  it('asks again after every manual approval, without remembering titles or native grants', async () => {
    const { broker, request, adaptor, decisions } = rig();
    await request('r1');
    expect(await broker.respond('req_1', 'allow')).toBe('delivered');
    expect(adaptor.respondPermission).toHaveBeenCalledExactlyOnceWith(
      BACKEND,
      'r1',
      'allow',
    );
    expect(decisions[0]).toMatchObject({
      requestedDecision: 'allow',
      decision: 'allow',
      auto: false,
      outcome: 'delivered',
      permissionMode: 'ask',
    });
    expect((await request('r2')).autoAnswered).toBe(false);
    expect(broker.pendingCount).toBe(1);
  });

  it('automatically uses one-time votes for every new request in allow-all, never native always', async () => {
    const { request, adaptor, decisions, broker } = rig('allow-all');
    const first = await request('r1');
    const second = await request('r2', {
      details: { incomplete: true },
      title: 'Another action',
    });
    expect(first.autoAnswered).toBe(true);
    expect(second.autoAnswered).toBe(true);
    expect(adaptor.respondPermission.mock.calls).toEqual([
      [BACKEND, 'r1', 'allow'],
      [BACKEND, 'r2', 'allow'],
    ]);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({
      auto: true,
      permissionMode: 'allow-all',
      decision: 'allow',
      outcome: 'delivered',
    });
    expect(broker.pendingCount).toBe(0);
  });

  it.each(['ask', 'allow-all'] as const)(
    'cancels rather than choosing always-only permission in %s mode',
    async (mode) => {
      const { request, broker, adaptor, decisions } = rig(mode);
      const ask = await request('r1', {
        options: [{ optionId: 'all', kind: 'proceed', escalation: 'always' }],
      });
      if (mode === 'ask')
        await broker.respond(ask.pending.requestHandle, 'allow');
      expect(adaptor.respondPermission).toHaveBeenCalledExactlyOnceWith(
        BACKEND,
        'r1',
        'cancel',
      );
      expect(decisions[0]?.reason).toMatch(/no identifiable one-time approval/);
      expect(decisions[0]?.decision).toBe('cancel');
    },
  );

  it('does not reinterpret unclassified options as approval', async () => {
    const { request, adaptor, decisions } = rig('allow-all');
    await request('r1', {
      options: [
        { optionId: 'unknown', label: 'Allow everything', kind: 'other' },
      ],
    });
    expect(adaptor.respondPermission).toHaveBeenCalledWith(
      BACKEND,
      'r1',
      'cancel',
    );
    expect(decisions[0]?.reason).toBeDefined();
  });

  it('downgrades legacy allow_always without creating a policy or changing global mode', async () => {
    const { request, broker, adaptor, decisions, state } = rig();
    await request('r1');
    await broker.respond('req_1', 'allow_always', 'only the requested file');
    expect(adaptor.respondPermission).toHaveBeenCalledWith(
      BACKEND,
      'r1',
      'allow',
    );
    expect(decisions[0]).toMatchObject({
      requestedDecision: 'allow_always',
      decision: 'allow',
      permissionMode: 'ask',
      auto: false,
    });
    expect(decisions[0]?.reason).toContain('Only this operation was approved');
    expect(state.mode).toBe('ask');
    expect((await request('r2')).autoAnswered).toBe(false);
  });

  it('does not claim approval for an already-resolved legacy request', async () => {
    const { request, broker, adaptor, decisions } = rig();
    await request('r1');
    adaptor.respondPermission.mockResolvedValueOnce('already_resolved');
    expect(await broker.respond('req_1', 'allow_always')).toBe(
      'already_resolved',
    );
    expect(decisions[0]?.outcome).toBe('already_resolved');
    expect(decisions[0]?.reason).toContain('no new permission');
    expect(broker.pendingCount).toBe(0);
  });

  it('keeps replayed asks idempotent while awaiting a user', async () => {
    const { request, broker } = rig();
    const first = await request('r1');
    const repeated = await request('r1');
    expect(repeated.pending).toBe(first.pending);
    expect(repeated.alreadyPending).toBe(true);
    expect(broker.pendingCount).toBe(1);
  });

  it('isolates colliding request ids across adaptors and sessions', async () => {
    const { request, broker } = rig();
    const second = { ...BACKEND, id: 'session-2' };
    const third = { ...BACKEND, adaptor: 'other' };
    await request('same');
    await request('same', { backend: second, sessionHandle: 'session_2' });
    await request('same', { backend: third, sessionHandle: 'session_3' });
    expect(broker.pendingCount).toBe(3);
    expect(broker.onResolved(BACKEND, 'same')?.requestHandle).toBe('req_1');
    expect(broker.onResolved(second, 'same')?.requestHandle).toBe('req_2');
    expect(broker.onResolved(third, 'same')?.requestHandle).toBe('req_3');
  });

  it('finds a pending request by exact job and clears only the selected session', async () => {
    const { request, broker } = rig();
    await request('r1');
    await request('r2', { jobRef: 'job-2', sessionHandle: 'session_2' });
    expect(broker.pendingForJob(BACKEND, 'job-1')?.requestHandle).toBe('req_1');
    expect(broker.pendingForSession('session_2')?.requestHandle).toBe('req_2');
    broker.clearSession('session_1');
    expect(broker.resolveHandle('req_1')).toBeUndefined();
    expect(broker.resolveHandle('req_2')).toBeDefined();
    expect(await broker.respond('missing', 'deny')).toBe('not_found');
  });

  it('switching modes affects new requests, while pending requests need an explicit refresh', async () => {
    const { request, broker, state, adaptor } = rig();
    await request('r1');
    state.mode = 'allow-all';
    await Promise.resolve();
    expect(adaptor.respondPermission).not.toHaveBeenCalled();
    expect((await request('r1')).alreadyPending).toBe(true);
    await broker.approvePendingAutomatically();
    expect(adaptor.respondPermission).toHaveBeenLastCalledWith(
      BACKEND,
      'r1',
      'allow',
    );
    state.mode = 'ask';
    expect((await request('r2')).autoAnswered).toBe(false);
  });

  it('respects the explicit stale/service-shutdown automatic-approval veto during refresh', async () => {
    const { request, broker, adaptor, state } = rig();
    await request('r1', { allowAutoAnswer: false });
    await request('r2');
    state.mode = 'allow-all';
    await broker.approvePendingAutomatically();
    expect(adaptor.respondPermission).toHaveBeenCalledExactlyOnceWith(
      BACKEND,
      'r2',
      'allow',
    );
    expect(
      broker.pendingUserRequests.map((pending) => pending.requestId),
    ).toEqual(['r1']);
  });

  it('checks ask again immediately before dispatching a queued automatic vote', async () => {
    const { request, state, adaptor, broker } = rig('allow-all');
    const pending = request('r1');
    state.mode = 'ask';
    expect((await pending).autoAnswered).toBe(false);
    expect(adaptor.respondPermission).not.toHaveBeenCalled();
    expect(broker.pendingUserRequests).toHaveLength(1);
  });

  it('stops a refresh when mode changes during the first in-flight approval', async () => {
    const { request, state, adaptor, broker, decisions } = rig();
    await request('r1');
    await request('r2');
    const first = deferred<'delivered'>();
    adaptor.respondPermission.mockReturnValueOnce(first.promise);
    state.mode = 'allow-all';
    const processing = broker.approvePendingAutomatically();
    await vi.waitFor(() =>
      expect(adaptor.respondPermission).toHaveBeenCalledOnce(),
    );
    state.mode = 'ask';
    first.resolve('delivered');
    await processing;
    expect(adaptor.respondPermission).toHaveBeenCalledOnce();
    expect(decisions[0]?.permissionMode).toBe('allow-all');
    expect(
      broker.pendingUserRequests.map((pending) => pending.requestId),
    ).toEqual(['r2']);
  });

  it('shares one in-flight fence across simultaneous refreshes and pending event replays', async () => {
    const { request, state, adaptor, broker, decisions } = rig();
    await request('r1');
    await request('r2');
    const first = deferred<'delivered'>();
    adaptor.respondPermission.mockReturnValueOnce(first.promise);
    state.mode = 'allow-all';
    const a = broker.approvePendingAutomatically();
    const b = broker.approvePendingAutomatically();
    expect((await request('r1')).alreadyPending).toBe(true);
    await vi.waitFor(() =>
      expect(adaptor.respondPermission).toHaveBeenCalledOnce(),
    );
    first.resolve('delivered');
    await Promise.all([a, b]);
    expect(adaptor.respondPermission.mock.calls).toEqual([
      [BACKEND, 'r1', 'allow'],
      [BACKEND, 'r2', 'allow'],
    ]);
    expect(decisions).toHaveLength(2);
  });

  it('does not auto-approve over a manual denial that acquired the fence first', async () => {
    const { request, state, adaptor, broker, decisions } = rig();
    await request('r1');
    const manual = broker.respond('req_1', 'deny');
    state.mode = 'allow-all';
    await Promise.all([manual, broker.approvePendingAutomatically()]);
    expect(adaptor.respondPermission).toHaveBeenCalledExactlyOnceWith(
      BACKEND,
      'r1',
      'deny',
    );
    expect(decisions[0]).toMatchObject({ auto: false, decision: 'deny' });
  });

  it('does not claim a racing manual denial was delivered after automatic approval began', async () => {
    const { request, state, adaptor, broker, decisions } = rig();
    await request('r1');
    const first = deferred<'delivered'>();
    adaptor.respondPermission.mockReturnValueOnce(first.promise);
    state.mode = 'allow-all';
    const automatic = broker.approvePendingAutomatically();
    await vi.waitFor(() =>
      expect(adaptor.respondPermission).toHaveBeenCalledOnce(),
    );
    const manual = broker.respond('req_1', 'deny');
    first.resolve('delivered');
    expect(await manual).toBe('already_resolved');
    await automatic;
    expect(adaptor.respondPermission).toHaveBeenCalledExactlyOnceWith(
      BACKEND,
      'r1',
      'allow',
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ auto: true, decision: 'allow' });
  });

  it('lets an explicit manual decision proceed if a queued automatic vote was stopped by ask mode', async () => {
    const { request, state, broker, adaptor } = rig('allow-all');
    const incoming = request('r1');
    state.mode = 'ask';
    const manual = broker.respond('req_1', 'deny');
    await incoming;
    expect(await manual).toBe('delivered');
    expect(adaptor.respondPermission).toHaveBeenCalledExactlyOnceWith(
      BACKEND,
      'r1',
      'deny',
    );
  });

  it('skips entries resolved or closed while a refresh is in flight', async () => {
    const { request, state, adaptor, broker } = rig();
    await request('r1');
    await request('r2', { sessionHandle: 'session_2' });
    const first = deferred<'delivered'>();
    adaptor.respondPermission.mockReturnValueOnce(first.promise);
    state.mode = 'allow-all';
    const processing = broker.approvePendingAutomatically();
    await vi.waitFor(() =>
      expect(adaptor.respondPermission).toHaveBeenCalledOnce(),
    );
    broker.clearSession('session_2');
    first.resolve('delivered');
    await processing;
    expect(adaptor.respondPermission).toHaveBeenCalledOnce();
    expect(broker.pendingCount).toBe(0);
  });

  it('keeps failed automatic requests available for a user decision without leaking provider errors', async () => {
    const { request, broker, adaptor, log, decisions, state } =
      rig('allow-all');
    adaptor.respondPermission.mockRejectedValueOnce(
      new Error('credential=private-value'),
    );
    expect((await request('r1')).autoAnswered).toBe(false);
    expect(broker.pendingUserRequests).toHaveLength(1);
    expect(decisions).toHaveLength(0);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-value');
    state.mode = 'ask';
    expect(await broker.respond('req_1', 'deny')).toBe('delivered');
    expect(adaptor.respondPermission).toHaveBeenLastCalledWith(
      BACKEND,
      'r1',
      'deny',
    );
  });

  it('preserves correlation after synchronous backend resolution and isolates failing observers', async () => {
    const vote = vi.fn(async (): Promise<'delivered'> => {
      broker.onResolved(BACKEND, 'r1');
      return 'delivered';
    });
    const onDecision = vi.fn(() => {
      throw new Error('observer failed');
    });
    const broker = new PermissionBroker({
      adaptorFor: () =>
        ({ respondPermission: vote }) as unknown as BackendAdaptor,
      getPermissionMode: () => 'allow-all',
      onDecision,
      log: () => {
        throw new Error('log failed');
      },
    });
    const result = await broker.onRequest({
      requestId: 'r1',
      backend: BACKEND,
      sessionHandle: 'session_1',
      jobRef: 'job-1',
      title: 'Run command',
      options: OPTIONS,
      details: { toolCallId: 'tool-1' },
    });
    expect(result.autoAnswered).toBe(true);
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        auto: true,
        outcome: 'delivered',
        pending: expect.objectContaining({
          jobRef: 'job-1',
          details: { toolCallId: 'tool-1' },
        }),
      }),
    );
    expect(broker.pendingCount).toBe(0);
    expect(vote).toHaveBeenCalledOnce();
  });

  it('redacts credentials in permission titles and optional decision notes', async () => {
    const { request, broker, log } = rig();
    const ask = await request('r1', {
      title: 'TOKEN=private-value printf test',
    });
    await broker.respond('req_1', 'allow', 'password=another-secret');
    expect(ask.pending.title).not.toContain('private-value');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-value');
    expect(JSON.stringify(log.mock.calls)).not.toContain('another-secret');
  });
});
