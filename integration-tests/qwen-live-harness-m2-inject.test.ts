/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * qwen-live-harness M2 — result-injection window discipline (orchestrator/injector):
 *
 *   1. a backend turn_complete that arrives while a realtime response is in
 *      flight is NOT injected; it is delivered right after the response
 *      settles (`response.done`);
 *   2. several jobs finishing while the window is closed are delivered by
 *      independent speech-only connections, without mixing job identities.
 *
 * The fake OpenAI handler gates each backend turn on a marker-keyed deferred
 * so the test controls exactly when qwen serve finishes each turn. The
 * daemon-side "turn_complete reached the orchestrator" edge is observed
 * through the daemon's session JSONL log.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sleep } from './qwen-backend-harness.js';
import {
  contextTextOf,
  functionCallOutputOf,
  taskResultPayloadOf,
  speechSummaryOf,
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import {
  bootLiveStack,
  deferred,
  startLiveCall,
  waitForLiveLogEvents,
  waitForLiveResponseAfter,
  type Deferred,
  type LiveStack,
} from './qwen-live-harness.js';

const SKIP =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
    process.env['QWEN_SANDBOX'].toLowerCase() !== 'false',
  );
const describeE2E = SKIP ? describe.skip : describe;

const isTurnComplete = (event: {
  type: string;
  payload: Record<string, unknown>;
}) =>
  event.type === 'backend.event' && event.payload['type'] === 'turn_complete';

describeE2E('qwen-live-harness M2 — injection window', () => {
  /** Consumed by the fake model: a gate is deleted the moment it matches. */
  const gates = new Map<string, Deferred>();
  /** Stable test-side resolve handles (the fake model never touches these). */
  const gateHandles = new Map<string, Deferred>();
  let stack: LiveStack;
  let conn: FakeDashScopeConnection;
  let callSeq = 0;

  const gatedHandoff = async (
    request: string,
    task: string,
    extraArgs: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const gate = deferred();
    gates.set(task, gate);
    gateHandles.set(task, gate);
    const callId = `call-h${++callSeq}`;
    const fromIndex = stack.fakeDash.inbox.length;
    conn.queueFunctionCall({
      name: 'handoff',
      argumentsJson: JSON.stringify({ task, ...extraArgs }),
      callId,
    });
    conn.speakTranscript(request);
    const receiptMessage = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === callId,
      {
        fromIndex,
        timeoutMs: 30_000,
        description: `handoff receipt for ${task}`,
      },
    );
    const receipt = JSON.parse(
      functionCallOutputOf(receiptMessage)!.output,
    ) as Record<string, unknown>;
    expect(receipt['status']).toBe('accepted');
    expect(typeof receipt['job']).toBe('string');
    await waitForLiveResponseAfter(stack, receiptMessage, 'tool_continuation');
    return receipt;
  };

  /** Open a held response and wait until the daemon has registered it. */
  const holdResponse = async (): Promise<string> => {
    const stateIndex = stack.host.states.length;
    const fromIndex = stack.fakeDash.inbox.length;
    stack.fakeDash.autoAckResponses = false;
    conn.speakTranscript('Keep this foreground answer in progress.');
    await stack.fakeDash.waitForMessage(
      (message) =>
        conn.inbox.includes(message) && message['type'] === 'response.create',
      { fromIndex, description: 'a real foreground response request to hold' },
    );
    const holdId = conn.beginResponse();
    stack.fakeDash.autoAckResponses = true;
    await stack.host.waitForState(
      (entry) => entry.status['state'] === 'speaking',
      { timeoutMs: 10_000, fromIndex: stateIndex },
    );
    return holdId;
  };

  beforeAll(async () => {
    stack = await bootLiveStack({
      makeOpenAIHandler:
        () =>
        async ({ body }) => {
          // qwen serve sends the WHOLE conversation history with every model
          // request, and both tests share one backend session — so match
          // markers only against the current turn's LAST message (earlier
          // turns' markers stay in the history forever) and consume the gate
          // on match so a settled gate can never vacuously match a later
          // turn.
          const messages = (body['messages'] ?? []) as unknown[];
          const lastMessage = JSON.stringify(messages.at(-1) ?? '');
          for (const [marker, gate] of gates) {
            if (lastMessage.includes(marker)) {
              gates.delete(marker);
              await gate.promise;
              return { content: `finished ${marker}` };
            }
          }
          return { content: 'ok' };
        },
    });
    conn = (await startLiveCall(stack)).conn;
  }, 180_000);

  afterAll(async () => {
    for (const gate of gateHandles.values()) gate.resolve(); // never leave serve hung
    await stack?.dispose();
  }, 60_000);

  it('holds [COMPLETE] while a response is in flight and injects after response.done', async () => {
    const inboxIndex = stack.fakeDash.inbox.length;
    const receipt = await gatedHandoff(
      'Please run the repository tests in the background.',
      'inject-window-task',
    );
    const job = String(receipt['job']);

    // Close the injection window: a response is now in flight.
    const holdId = await holdResponse();

    // Let the backend turn finish and wait until the daemon's orchestrator
    // has consumed the turn_complete event (session-log sync point).
    gateHandles.get('inject-window-task')!.resolve();
    await waitForLiveLogEvents(stack.dataDir, isTurnComplete, {
      minCount: 1,
      timeoutMs: 30_000,
      description: 'backend.event turn_complete (inject-window-task)',
    });
    // Negative assertion needs a bounded settle window: a (buggy) premature
    // injection would be written to this loopback socket within milliseconds
    // of the log line above — there is no further event to await when the
    // implementation is correct.
    await sleep(250);
    const premature = stack.fakeDash.inbox
      .slice(inboxIndex)
      .map((message) => contextTextOf(message) ?? '')
      .filter((text) => text.includes('[COMPLETE'));
    expect(premature).toEqual([]);

    // Reopen the window: the queued conclusion must now arrive.
    conn.finishResponse(holdId);
    const complete = await stack.fakeDash.waitForMessage(
      (message) => {
        return (
          taskResultPayloadOf(message)?.status === 'completed' &&
          taskResultPayloadOf(message)?.job === job
        );
      },
      {
        timeoutMs: 15_000,
        fromIndex: inboxIndex,
        description: `[COMPLETE ${job}] after response.done`,
      },
    );
    expect(contextTextOf(complete)).toContain('finished inject-window-task');
    expect(contextTextOf(complete)).not.toContain('[SPEAK_TO_USER]');
    await waitForLiveResponseAfter(stack, complete, 'task_result');
  });

  it('queues independent completion summaries without combining their task identities', async () => {
    // A second backend session so two independent turns can complete.
    const createIndex = stack.fakeDash.inbox.length;
    conn.queueFunctionCall({
      name: 'session_create',
      argumentsJson: JSON.stringify({ label: 'second workstream' }),
      callId: 'call-sc',
    });
    conn.speakTranscript('Create a second workstream.');
    const createdMessage = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === 'call-sc',
      {
        fromIndex: createIndex,
        timeoutMs: 30_000,
        description: 'session_create receipt',
      },
    );
    const created = JSON.parse(
      functionCallOutputOf(createdMessage)!.output,
    ) as Record<string, unknown>;
    expect(created['status']).toBe('ok');
    const secondSession = String(created['handle']);
    await waitForLiveResponseAfter(stack, createdMessage, 'tool_continuation');

    const receiptA = await gatedHandoff(
      'Please inspect the repository documentation.',
      'batch-task-a',
    );
    const receiptB = await gatedHandoff(
      'Please run the project tests in the second session.',
      'batch-task-b',
      {
        session: secondSession,
      },
    );
    expect(receiptB['session']).toBe(secondSession);
    const jobA = String(receiptA['job']);
    const jobB = String(receiptB['job']);
    expect(jobA).not.toBe(jobB);

    const inboxIndex = stack.fakeDash.inbox.length;
    const holdId = await holdResponse();

    gateHandles.get('batch-task-a')!.resolve();
    gateHandles.get('batch-task-b')!.resolve();
    // 1 turn_complete from the previous test + 2 here.
    await waitForLiveLogEvents(stack.dataDir, isTurnComplete, {
      minCount: 3,
      timeoutMs: 30_000,
      description: 'backend.event turn_complete (batch-task-a/b)',
    });
    await sleep(250); // bounded settle window for the negative assertion
    const premature = stack.fakeDash.inbox
      .slice(inboxIndex)
      .map((message) => contextTextOf(message) ?? '')
      .filter((text) => text.includes('[COMPLETE'));
    expect(premature).toEqual([]);

    conn.finishResponse(holdId);
    for (const job of [jobA, jobB]) {
      const outcome = await stack.fakeDash.waitForMessage(
        (message) =>
          taskResultPayloadOf(message)?.status === 'completed' &&
          taskResultPayloadOf(message)?.job === job,
        {
          timeoutMs: 15_000,
          fromIndex: inboxIndex,
          description: `independent [COMPLETE ${job}] outcome`,
        },
      );
      const text = speechSummaryOf(outcome)!;
      expect(taskResultPayloadOf(outcome)).toMatchObject({
        status: 'completed',
        job,
      });
      expect(conn.inbox).not.toContain(outcome);
      expect(text).not.toContain(`[COMPLETE ${job === jobA ? jobB : jobA}]`);
      await waitForLiveResponseAfter(stack, outcome, 'task_result');
    }
  });
});
