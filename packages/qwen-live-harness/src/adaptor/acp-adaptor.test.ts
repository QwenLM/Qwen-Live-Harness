/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import type { ChildProcess } from 'node:child_process';
import type { Client } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveLogger } from '../logger.js';
import {
  ACP_INIT_TIMEOUT_MS,
  ACP_PACKAGE_RUNNER_INIT_TIMEOUT_MS,
  AcpAdaptor,
  type AcpConnectionLike,
} from './acp-adaptor.js';
import type { BackendEvent } from './types.js';

/**
 * In-process fake connection. The adaptor hands its Client to `connect`;
 * the fake captures it so tests can drive inbound notifications, ext
 * methods, and permission requests exactly like a real child would.
 */
class FakeConnection implements AcpConnectionLike {
  client!: Client;
  initialized!: Promise<Record<string, unknown>>;
  newSessionCalls: Array<Record<string, unknown>> = [];
  promptCalls: Array<Record<string, unknown>> = [];
  cancelCalls: Array<Record<string, unknown>> = [];
  extCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  authCalls: Array<Record<string, unknown>> = [];
  sessionSeq = 0;
  /** Resolve the in-flight prompt; defaults to end_turn. */
  settlePrompt: (stopReason?: string, error?: unknown) => void = () => {};
  /** Reject newSession once with this, then succeed. */
  newSessionError: unknown = undefined;
  /** Reject initialize with this non-undefined value. */
  initializeError: unknown = undefined;
  private promptWaiter?: {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  };

  constructor(
    private readonly initializeResponse: Record<string, unknown> = {},
  ) {}

  connect(): (
    client: Client,
    onExit: (info: { code: number | null; signal: string | null }) => void,
  ) => Promise<AcpConnectionLike> {
    return (client, onExit) => {
      this.client = client;
      this.onExit = onExit;
      this.initialized = Promise.resolve({
        agentInfo: { name: 'fake' },
        agentCapabilities: {
          promptCapabilities: { image: true },
        },
        authMethods: [{ id: 'openai' }],
        ...this.initializeResponse,
      });
      return Promise.resolve(this);
    };
  }

  onExit: (info: { code: number | null; signal: string | null }) => void =
    () => {};

  initialize(): Promise<Record<string, unknown>> {
    if (this.initializeError !== undefined) {
      return Promise.reject(this.initializeError);
    }
    return this.initialized;
  }

  authenticate(params: Record<string, unknown>): Promise<unknown> {
    this.authCalls.push(params);
    return Promise.resolve({});
  }

  newSession(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.newSessionCalls.push(params);
    if (this.newSessionError !== undefined) {
      const error = this.newSessionError;
      this.newSessionError = undefined;
      return Promise.reject(error);
    }
    this.sessionSeq += 1;
    return Promise.resolve({
      sessionId: `acp-${this.sessionSeq}`,
      modes: { availableModes: [{ id: 'default', name: 'Default' }] },
    });
  }

  prompt(params: Record<string, unknown>): Promise<{ stopReason?: string }> {
    this.promptCalls.push(params);
    let resolve!: (value: unknown) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.pendingStopReason = 'end_turn';
    this.promptWaiter = { promise, resolve, reject };
    return promise.then(() => ({ stopReason: this.pendingStopReason }));
  }

  pendingStopReason: string = 'end_turn';

  cancel(params: Record<string, unknown>): Promise<void> {
    this.cancelCalls.push(params);
    return Promise.resolve();
  }

  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.extCalls.push({ method, params });
    return Promise.resolve({});
  }

  setSessionMode(params: Record<string, unknown>): Promise<unknown> {
    this.setModeCalls.push(params);
    return Promise.resolve({});
  }

  setModeCalls: Array<Record<string, unknown>> = [];

  settle(stopReason = 'end_turn', error?: unknown): void {
    const waiter = this.promptWaiter;
    this.promptWaiter = undefined;
    if (waiter === undefined) return;
    if (error !== undefined) waiter.reject(error);
    else {
      this.pendingStopReason = stopReason;
      waiter.resolve({});
    }
  }

  // Inbound helpers driving the adaptor's client handlers.
  update(sessionId: string, update: Record<string, unknown>): void {
    void this.client.sessionUpdate({ sessionId, update } as never);
  }

  drain(sessionId: string): void {
    void this.client.extMethod?.('craft/drainMidTurnQueue', { sessionId });
  }

  /** Drain and hand back what the agent would have pulled into the turn. */
  drainMessages(sessionId: string): Promise<Record<string, unknown>> {
    return this.client.extMethod!('craft/drainMidTurnQueue', {
      sessionId,
    }) as Promise<Record<string, unknown>>;
  }
}

const logger: LiveLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as LiveLogger;

function makeAdaptor(connection: FakeConnection): AcpAdaptor {
  return new AcpAdaptor({
    name: 'acp',
    command: 'unused',
    defaultCwd: '/ws',
    logger,
    connect: connection.connect(),
  });
}

/** Collects events while subscribed; never resolves on its own. */
function eventCollector(adaptor: AcpAdaptor, sessionId: string) {
  const events: BackendEvent[] = [];
  const subscribed = (async () => {
    for await (const event of adaptor.events({
      id: sessionId,
      adaptor: 'acp',
    })) {
      events.push(event);
    }
  })();
  return {
    events,
    /** Resolves once the given predicate holds over the collected events. */
    waitFor: async (
      predicate: (events: readonly BackendEvent[]) => boolean,
    ): Promise<readonly BackendEvent[]> => {
      await vi.waitFor(() => {
        if (!predicate(events)) throw new Error('events not ready');
      });
      return events;
    },
    /** Resolves when the stream ends (session_closed was consumed). */
    ended: subscribed.then(() => events),
  };
}

const adaptors: AcpAdaptor[] = [];

describe('AcpAdaptor exact cancellation and asking mode', () => {
  it('removes queued B without cancelling active A and rejects stale refs', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession();
    const events = eventCollector(adaptor, handle.id);
    const first = await adaptor.prompt(handle, [{ type: 'text', text: 'A' }]);
    const second = await adaptor.prompt(handle, [{ type: 'text', text: 'B' }]);
    const third = await adaptor.prompt(handle, [{ type: 'text', text: 'C' }]);
    expect(await adaptor.cancelJob(handle, second.jobRef!)).toBe('stopped');
    expect(await adaptor.cancelJob(handle, second.jobRef!)).toBe('not_found');
    expect(await adaptor.cancelJob(handle, 'unknown')).toBe('not_found');
    expect(adaptor.isBusy(handle)).toBe(true);
    expect(connection.cancelCalls).toEqual([]);
    connection.update(handle.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'A result' },
    });
    connection.settle();
    await events.waitFor((items) =>
      items.some(
        (item) => item.type === 'turn_started' && item.jobRef === third.jobRef,
      ),
    );
    expect(events.events).toContainEqual({
      type: 'turn_error',
      jobRef: second.jobRef,
      error: 'cancelled',
    });
    expect(events.events).toContainEqual({
      type: 'turn_complete',
      jobRef: first.jobRef,
      summary: 'A result',
      detail: 'A result',
    });
    expect(await adaptor.cancelJob(handle, first.jobRef!)).toBe('not_found');
    expect(connection.cancelCalls).toEqual([]);
    expect(await adaptor.cancelJob(handle, third.jobRef!)).toBe('stopping');
    expect(await adaptor.cancelJob(handle, third.jobRef!)).toBe('stopping');
    expect(connection.cancelCalls).toEqual([{ sessionId: handle.id }]);
    expect(adaptor.isBusy(handle)).toBe(true);
    connection.settle('cancelled');
    await events.waitFor((items) =>
      items.some(
        (item) => item.type === 'turn_error' && item.jobRef === third.jobRef,
      ),
    );
    expect(adaptor.isBusy(handle)).toBe(false);
  });

  it('awaits the advertised asking mode before exposing the new session', async () => {
    const connection = new FakeConnection();
    let finish!: () => void;
    vi.spyOn(connection, 'setSessionMode').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({});
        }),
    );
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    let ready = false;
    const creating = adaptor.createSession().then((handle) => {
      ready = true;
      return handle;
    });
    await vi.waitFor(() =>
      expect(connection.setSessionMode).toHaveBeenCalled(),
    );
    expect(ready).toBe(false);
    expect(connection.promptCalls).toEqual([]);
    finish();
    await creating;
    expect(ready).toBe(true);
  });

  it.each(['unknown', 'rejected'])(
    'warns when asking mode negotiation is %s without choosing full access',
    async (mode) => {
      const connection = new FakeConnection();
      if (mode === 'unknown')
        vi.spyOn(connection, 'newSession').mockResolvedValue({
          sessionId: 'unknown',
          modes: {
            availableModes: [
              { id: 'read-only', name: 'Read only' },
              { id: 'agent-full-access', name: 'Full access' },
            ],
          },
        });
      else
        vi.spyOn(connection, 'setSessionMode').mockRejectedValue(
          new Error('unsupported'),
        );
      const warn = vi.fn();
      const adaptor = new AcpAdaptor({
        name: 'mode-test',
        command: 'unused',
        defaultCwd: '/fixture',
        logger: { warn } as unknown as LiveLogger,
        connect: connection.connect(),
      });
      adaptors.push(adaptor);
      await adaptor.createSession();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('manual approval is not guaranteed'),
      );
      expect(
        connection.setModeCalls.some(
          (call) => call['modeId'] === 'agent-full-access',
        ),
      ).toBe(false);
      if (mode === 'unknown') expect(connection.setModeCalls).toEqual([]);
    },
  );
});

afterEach(async () => {
  for (const adaptor of adaptors.splice(0)) await adaptor.close();
});

describe('AcpAdaptor sessions and receipts', () => {
  it('preflight initializes and captures image capability', async () => {
    const connection = new FakeConnection();
    const initialize = vi.spyOn(connection, 'initialize');
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    await adaptor.preflight();
    expect(adaptor.capabilities().imageInput).toBe(true);
    // authenticate was attempted (authMethods advertised openai)
    expect(connection.authCalls).toHaveLength(1);
    const packageInfo = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { name: string; version: string };
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        clientInfo: { name: packageInfo.name, version: packageInfo.version },
      }),
    );
  });

  it('completes the handshake when initialize outlasts the old 10s budget', async () => {
    vi.useFakeTimers();
    try {
      const connection = new FakeConnection();
      let resolveInitialize!: (value: Record<string, unknown>) => void;
      connection.initialize = () =>
        new Promise((resolve) => {
          resolveInitialize = resolve;
        });
      const adaptor = makeAdaptor(connection);
      adaptors.push(adaptor);
      const preflight = adaptor.preflight();
      // The old 10s budget would have rejected here; the widened budget
      // still lets a slow handshake finish.
      await vi.advanceTimersByTimeAsync(29_000);
      resolveInitialize({ agentCapabilities: {}, authMethods: [] });
      await preflight;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects native ACP initialization at the 30 second deadline', async () => {
    vi.useFakeTimers();
    try {
      const connection = new FakeConnection();
      connection.initialize = () => new Promise(() => {});
      const adaptor = makeAdaptor(connection);
      adaptors.push(adaptor);
      expect(ACP_INIT_TIMEOUT_MS).toBe(30_000);
      let settled = false;
      const result = adaptor.preflight().then(
        () => undefined,
        (error: unknown) => error,
      );
      void result.finally(() => {
        settled = true;
      });
      // Let the async connect seam settle and arm the deadline.
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(ACP_INIT_TIMEOUT_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({
        message: "acp backend 'acp' did not initialize",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows five minutes for a cold package-runner adapter bootstrap', async () => {
    vi.useFakeTimers();
    try {
      const connection = new FakeConnection();
      connection.initialize = () => new Promise(() => {});
      const adaptor = new AcpAdaptor({
        name: 'acp',
        command: '/opt/homebrew/bin/npx',
        defaultCwd: '/ws',
        logger,
        connect: connection.connect(),
      });
      adaptors.push(adaptor);

      let settled = false;
      const result = adaptor.preflight().then(
        () => undefined,
        (error: unknown) => error,
      );
      void result.finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(ACP_PACKAGE_RUNNER_INIT_TIMEOUT_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({
        message: "acp backend 'acp' did not initialize",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders structured initialize rejections as readable errors', async () => {
    const connection = new FakeConnection();
    connection.initializeError = {
      code: -32_602,
      message: 'Unsupported protocol version',
    };
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);

    await expect(adaptor.preflight()).rejects.toThrow(
      "acp backend 'acp' failed to initialize: Unsupported protocol version (code -32602)",
    );
  });

  it('authenticates and retries when newSession returns auth_required', async () => {
    const connection = new FakeConnection();
    connection.newSessionError = Object.assign(new Error('auth required'), {
      code: -32000,
    });
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });
    expect(handle.adaptor).toBe('acp');
    expect(connection.authCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('accepts an idle prompt and emits turn lifecycle events', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    await adaptor.preflight();
    const handle = await adaptor.createSession({ cwd: '/ws' });

    const collector = eventCollector(adaptor, handle.id);
    const receipt = await adaptor.prompt(handle, [
      { type: 'text', text: 'do it' },
    ]);
    expect(receipt).toEqual({ status: 'accepted', jobRef: 'turn-1' });
    connection.update(handle.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'working' },
    });
    connection.settle('end_turn');
    const events = await collector.waitFor((collected) =>
      collected.some((event) => event.type === 'turn_complete'),
    );

    expect(events).toEqual([
      { type: 'turn_started', jobRef: 'turn-1' },
      { type: 'activity', jobRef: 'turn-1', kind: 'message', text: 'working' },
      {
        type: 'turn_complete',
        jobRef: 'turn-1',
        summary: 'working',
        detail: 'working',
      },
    ]);
  });

  it('attributes permission requests to the active turn', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });
    const collector = eventCollector(adaptor, handle.id);

    void adaptor.prompt(handle, [{ type: 'text', text: 'do it' }]);
    const vote = connection.client.requestPermission({
      sessionId: handle.id,
      toolCall: { name: 'Bash', command: 'rm -rf /tmp' },
      options: [{ optionId: 'allow', name: 'Allow once' }],
    } as never);
    const events = await collector.waitFor((collected) =>
      collected.some((event) => event.type === 'permission_request'),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'permission_request',
        jobRef: 'turn-1',
        requestId: 'perm-1',
      }),
    );
    await adaptor.respondPermission(handle, 'perm-1', 'allow');
    await vote;
    connection.settle();
  });

  /**
   * A steer receipt names a message the model has already told the user
   * about. Dropping that message on cancel without ever reporting an owner
   * strands the orchestrator's task at 'accepted' — it is waiting for a
   * turn_joined that can no longer come.
   */
  it('attributes undelivered steering to the turn it dies with', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });
    await adaptor.prompt(handle, [{ type: 'text', text: 'first' }]);
    connection.drain(handle.id);

    const collector = eventCollector(adaptor, handle.id);
    const receipt = await adaptor.prompt(
      handle,
      [{ type: 'text', text: 'also skip integration' }],
      { steer: true },
    );
    await adaptor.cancel(handle);
    connection.settle('cancelled');

    const events = await collector.waitFor((collected) =>
      collected.some((event) => event.type === 'turn_error'),
    );
    // Bound to the cancelled turn, and bound BEFORE its failure so the
    // cancellation covers it.
    const joinedAt = events.findIndex(
      (event) =>
        event.type === 'turn_joined' &&
        event.messageId === receipt.joinedMessageId &&
        event.jobRef === 'turn-1',
    );
    const erroredAt = events.findIndex((event) => event.type === 'turn_error');
    expect(joinedAt).toBeGreaterThanOrEqual(0);
    expect(joinedAt).toBeLessThan(erroredAt);
  });

  it('attributes undelivered steering when the agent process dies', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    await adaptor.preflight();
    const handle = await adaptor.createSession({ cwd: '/ws' });
    await adaptor.prompt(handle, [{ type: 'text', text: 'first' }]);
    connection.drain(handle.id);

    const collector = eventCollector(adaptor, handle.id);
    const receipt = await adaptor.prompt(
      handle,
      [{ type: 'text', text: 'also skip integration' }],
      { steer: true },
    );
    connection.onExit({ code: 1, signal: null });

    const events = await collector.waitFor((collected) =>
      collected.some((event) => event.type === 'session_closed'),
    );
    expect(events).toContainEqual({
      type: 'turn_joined',
      messageId: receipt.joinedMessageId,
      jobRef: 'turn-1',
    });
  });

  it('maps stopReasons to turn_error semantics', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });

    const cases: Array<[string, string]> = [
      ['cancelled', 'cancelled'],
      ['refusal', 'the agent declined to continue the task'],
    ];
    for (const [stopReason, expected] of cases) {
      const collector = eventCollector(adaptor, handle.id);
      await adaptor.prompt(handle, [{ type: 'text', text: 'go' }]);
      connection.settle(stopReason);
      const events = await collector.waitFor((collected) =>
        collected.some((event) => event.type === 'turn_error'),
      );
      expect(events[events.length - 1]).toMatchObject({
        type: 'turn_error',
        error: expected,
      });
    }
  });

  it('steers into the drain queue once the agent has drained', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    await adaptor.preflight();
    const handle = await adaptor.createSession({ cwd: '/ws' });
    await adaptor.prompt(handle, [{ type: 'text', text: 'first' }]);
    expect(adaptor.isBusy(handle)).toBe(true);

    // Before any drain: honest 'queued', never a joinedActiveTurn lie.
    const before = await adaptor.prompt(
      handle,
      [{ type: 'text', text: 'also this' }],
      { steer: true },
    );
    expect(before).toMatchObject({ status: 'queued' });

    connection.drain(handle.id);
    const after = await adaptor.prompt(
      handle,
      [{ type: 'text', text: 'and that' }],
      { steer: true },
    );
    // The receipt names the MESSAGE. Naming the running turn here would
    // bind the task to a turn that may end before the agent drains.
    expect(after).toMatchObject({
      status: 'accepted',
      joinedActiveTurn: true,
      joinedMessageId: expect.any(String),
    });
    expect(after.jobRef).toBeUndefined();
  });

  it('reports the running turn as the owner of drained steering', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });
    await adaptor.prompt(handle, [{ type: 'text', text: 'first' }]);
    connection.drain(handle.id);

    const collector = eventCollector(adaptor, handle.id);
    const receipt = await adaptor.prompt(
      handle,
      [{ type: 'text', text: 'also skip integration' }],
      { steer: true },
    );
    const drained = await connection.drainMessages(handle.id);

    // The agent really received the text, in the turn that is still running.
    expect(drained['messages']).toEqual(['also skip integration']);
    const events = await collector.waitFor((collected) =>
      collected.some((event) => event.type === 'turn_joined'),
    );
    expect(events).toContainEqual({
      type: 'turn_joined',
      messageId: receipt.joinedMessageId,
      jobRef: 'turn-1',
    });
  });

  /**
   * The race a real user hits: steering lands after the agent's last drain
   * of a turn, so it runs in the NEXT turn. The receipt already said it
   * joined running work, so the adaptor must report the turn that actually
   * carries it — otherwise the orchestrator leaves the task bound to a turn
   * that never ran it, and that turn's [COMPLETE] omits the instruction.
   */
  it('reports the next turn as the owner of steering the agent never drained', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });
    await adaptor.prompt(handle, [{ type: 'text', text: 'first' }]);
    connection.drain(handle.id);

    const collector = eventCollector(adaptor, handle.id);
    const receipt = await adaptor.prompt(
      handle,
      [{ type: 'text', text: 'also skip integration' }],
      { steer: true },
    );
    // Turn ends before the agent pulls again.
    connection.settle('end_turn');

    const events = await collector.waitFor((collected) =>
      collected.some((event) => event.type === 'turn_joined'),
    );
    expect(events).toContainEqual({
      type: 'turn_joined',
      messageId: receipt.joinedMessageId,
      jobRef: 'turn-2',
    });
    // And it really is carried by that next turn, not silently dropped.
    await vi.waitFor(() => {
      expect(connection.promptCalls).toHaveLength(2);
    });
    expect(JSON.stringify(connection.promptCalls[1])).toContain(
      'also skip integration',
    );
  });

  it('delivers queued prompts and undrained steers after the turn ends', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });
    await adaptor.prompt(handle, [{ type: 'text', text: 'first' }]);
    const queued = await adaptor.prompt(handle, [
      { type: 'text', text: 'second task' },
    ]);
    expect(queued).toMatchObject({ status: 'queued', jobRef: 'turn-2' });

    const collector = eventCollector(adaptor, handle.id);
    connection.settle('end_turn');
    await vi.waitFor(() => {
      expect(connection.promptCalls).toHaveLength(2);
    });
    connection.settle('end_turn');
    const events = await collector.waitFor(
      (collected) =>
        collected.filter((event) => event.type === 'turn_complete').length ===
        2,
    );
    // The queued prompt starts under its pre-minted jobRef, not a new one.
    expect(
      events.map(
        (event) => `${event.type}:${'jobRef' in event ? event.jobRef : ''}`,
      ),
    ).toEqual([
      'turn_started:turn-1',
      'turn_complete:turn-1',
      'turn_started:turn-2',
      'turn_complete:turn-2',
    ]);
  });

  it('rejects when the queue is full', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });
    await adaptor.prompt(handle, [{ type: 'text', text: 'first' }]);
    for (let index = 0; index < 8; index++) {
      await adaptor.prompt(handle, [{ type: 'text', text: `q${index}` }]);
    }
    const overflow = await adaptor.prompt(handle, [
      { type: 'text', text: 'one too many' },
    ]);
    expect(overflow).toMatchObject({ status: 'rejected' });
    expect(String(overflow.note)).toContain('queue is full');
  });

  it('surfaces a crashed child to every session and rejects stale handles', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });
    await adaptor.prompt(handle, [{ type: 'text', text: 'running' }]);

    const collector = eventCollector(adaptor, handle.id);
    connection.onExit({ code: 1, signal: null });
    const events = await collector.ended;
    // Cascade order: busy turn errored, then closed.
    expect(events.map((event) => event.type)).toEqual([
      'turn_started',
      'turn_error',
      'session_closed',
    ]);

    const stale = await adaptor.prompt(handle, [
      { type: 'text', text: 'again' },
    ]);
    expect(stale).toMatchObject({ status: 'rejected' });

    // The next createSession respawns a fresh generation and works.
    const fresh = await adaptor.createSession({ cwd: '/ws' });
    expect(fresh.id).toBe('acp-2');
    const freshReceipt = await adaptor.prompt(fresh, [
      { type: 'text', text: 'after respawn' },
    ]);
    expect(freshReceipt).toMatchObject({ status: 'accepted' });
  });

  it('uses ordinary ACP completion without private Qwen Live Harness RPCs', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });
    const collector = eventCollector(adaptor, handle.id);
    expect(adaptor.capabilities().proactiveSpeak).toBe(false);
    expect(connection.extCalls).toEqual([]);
    expect(connection.newSessionCalls).toEqual([
      { cwd: '/ws', mcpServers: [] },
    ]);

    for (const method of [
      'qwen/control/live/speak-to-user',
      'qwen/control/session/live-conversation',
      'some/other/method',
    ]) {
      await expect(
        connection.client.extMethod!(method, {
          callerSessionId: handle.id,
          sessionId: handle.id,
          message: 'the tests passed',
          active: true,
        }),
      ).rejects.toMatchObject({ code: -32601 });
    }
    connection.update(handle.id, {
      sessionUpdate: 'something-unknown',
      anything: true,
    });
    const receipt = await adaptor.prompt(handle, [
      { type: 'text', text: 'run the tests' },
    ]);
    connection.update(handle.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'the tests passed' },
    });
    connection.settle();
    const events = await collector.waitFor((collected) =>
      collected.some((event) => event.type === 'turn_complete'),
    );
    expect(events).toContainEqual({
      type: 'turn_complete',
      jobRef: receipt.jobRef,
      summary: 'the tests passed',
      detail: 'the tests passed',
    });
    expect(events.some((event) => event.type === 'speak')).toBe(false);
    expect(adaptor.capabilities().proactiveSpeak).toBe(false);
    expect(connection.extCalls).toEqual([]);
  });
});

describe('AcpAdaptor real child lifecycle', () => {
  const fixturePath = join(
    fileURLToPath(
      new URL('../../test-fixtures/fake-acp-agent.mjs', import.meta.url),
    ),
  );

  function spawnedAdaptor(): AcpAdaptor {
    return new AcpAdaptor({
      name: 'acp',
      command: process.execPath,
      args: [fixturePath],
      defaultCwd: '/tmp',
      logger,
    });
  }

  it('spawns, initializes, runs a prompt round-trip, and closes', async () => {
    const adaptor = spawnedAdaptor();
    adaptors.push(adaptor);
    await adaptor.preflight();
    expect(adaptor.capabilities().imageInput).toBe(true);
    const handle = await adaptor.createSession({ cwd: '/tmp' });

    const collector = eventCollector(adaptor, handle.id);
    const receipt = await adaptor.prompt(handle, [
      { type: 'text', text: 'hello fixture' },
    ]);
    expect(receipt).toMatchObject({ status: 'accepted', jobRef: 'turn-1' });
    const events = await collector.waitFor((collected) =>
      collected.some((event) => event.type === 'turn_complete'),
    );
    expect(events).toEqual([
      { type: 'turn_started', jobRef: 'turn-1' },
      {
        type: 'activity',
        jobRef: 'turn-1',
        kind: 'message',
        text: 'echo: hello fixture',
      },
      {
        type: 'turn_complete',
        jobRef: 'turn-1',
        summary: 'echo: hello fixture',
        detail: 'echo: hello fixture',
      },
    ]);
  });

  it('retains a failed child shutdown handle and retries it without allowing new work', async () => {
    const adaptor = spawnedAdaptor();
    adaptors.push(adaptor);
    await adaptor.preflight();
    const owned = adaptor as unknown as { child: ChildProcess | undefined };
    const child = owned.child!;
    const kill = vi.spyOn(child, 'kill').mockImplementationOnce(() => {
      throw new Error('Synthetic signal failure');
    });
    const first = adaptor.close();
    expect(adaptor.close()).toBe(first);
    await expect(first).rejects.toThrow('Synthetic signal failure');
    expect(owned.child).toBe(child);
    await expect(adaptor.preflight()).rejects.toThrow('closed');
    await adaptor.close();
    expect(owned.child).toBeUndefined();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it('fails preflight in milliseconds when the child crashes at boot', async () => {
    const adaptor = new AcpAdaptor({
      name: 'acp',
      command: process.execPath,
      args: [fixturePath],
      defaultCwd: '/tmp',
      logger,
      env: { FAKE_ACP_MODE: 'crash-after-init' },
    });
    adaptors.push(adaptor);
    const started = Date.now();
    await expect(adaptor.preflight()).rejects.toThrow();
    // The handshake timeout must not be the failure path.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
