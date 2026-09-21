/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * qwen-live-harness M1 — one full call, end to end, against real subprocesses:
 * a real `qwen serve` (model side backed by the fake OpenAI server), the
 * real `qwen-live-harness` daemon binary, a fake DashScope realtime endpoint, and
 * a protocol-v9 FakeHost.
 *
 *   a. the discovery file exists with the documented fields;
 *   b. FakeHost connect → hello → host.welcome;
 *   c. `toggle` opens the realtime connection (auth header + model query),
 *      sends session.update with Memory and Proactive disabled, and the call
 *      reaches `listening`;
 *   d. direct-answer path: Host input audio frames reach the provider as
 *      input_audio_buffer.append, provider output audio reaches the Host as
 *      bare PCM frames;
 *   e. handoff path: a handoff function call lands on the real serve daemon
 *      as a prompt; the receipt (function_call_output), the [COMPLETE]
 *      structured outcome, and its independent task-result speaker arrive
 *      in order, with playback confirmed separately from task completion;
 *   f. SIGTERM removes the discovery file.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contextTextOf,
  functionCallOutputOf,
  taskResultPayloadOf,
  speechSummaryOf,
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import {
  bootLiveStack,
  liveDiscoveryPath,
  QWEN_LIVE_HARNESS_API_KEY,
  QWEN_LIVE_HARNESS_REALTIME_MODEL,
  waitForLiveLogEvents,
  waitForLiveResponseAfter,
  type LiveStack,
} from './qwen-live-harness.js';
import { sleep } from './qwen-backend-harness.js';

// Windows: the harness relies on POSIX process semantics (SIGTERM shutdown
// path is part of scenario f). Container sandboxes: the serve daemon's ACP
// child cannot reach the host-loopback fake OpenAI server (same skip as
// qwen-serve-streaming.test.ts).
const SKIP =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
    process.env['QWEN_SANDBOX'].toLowerCase() !== 'false',
  );
const describeE2E = SKIP ? describe.skip : describe;

const EXPECTED_TOOL_NAMES = [
  'appshot',
  'handoff',
  'remain_silent',
  'respond_permission',
  'session_create',
  'session_list',
  'session_monitor',
  'session_stop',
  'web_search',
];

describeE2E('qwen-live-harness M1 — end-to-end voice call', () => {
  let stack: LiveStack;
  let conn: FakeDashScopeConnection;
  let callEpoch = 0;

  beforeAll(async () => {
    stack = await bootLiveStack({
      makeOpenAIHandler: () => () => ({
        content: 'm1 backend turn complete',
      }),
    });
  }, 180_000);

  afterAll(async () => {
    await stack?.dispose();
  }, 60_000);

  it('publishes a discovery record with the documented fields', async () => {
    const record = JSON.parse(
      await readFile(liveDiscoveryPath(stack.discoveryDir), 'utf8'),
    ) as Record<string, unknown>;
    expect(record['url']).toBe(stack.live.url);
    expect(typeof record['token']).toBe('string');
    expect(String(record['token']).length).toBeGreaterThan(0);
    expect(record['protocolVersion']).toBe(9);
    expect(record['pid']).toBe(stack.live.proc.pid);
    expect(String(record['instanceNonce'])).toMatch(/^[A-Za-z0-9_-]{16,256}$/);
  });

  it('answers host.hello with host.welcome', () => {
    const welcome = stack.host.states.find(
      (entry) => entry.type === 'host.welcome',
    );
    expect(welcome).toBeDefined();
    expect(Number.isInteger(welcome!.epoch)).toBe(true);
    expect(welcome!.status['available']).toBe(true);
    expect(welcome!.status['state']).toBe('idle');
    expect(
      stack.host.messages.find((entry) => entry['type'] === 'host.welcome')?.[
        'memory'
      ],
    ).toMatchObject({
      enabled: false,
      visualEnabled: false,
      libraryId: 'default',
      model: 'qwen3.7-plus',
      locked: false,
    });
  });

  it('toggle connects to the realtime provider and reaches listening', async () => {
    const stateIndex = stack.host.states.length;
    const connection = stack.fakeDash.waitForConnection(20_000);
    stack.host.action('toggle');
    conn = await connection;

    expect(conn.authorization).toBe(`Bearer ${QWEN_LIVE_HARNESS_API_KEY}`);
    expect(conn.model).toBe(QWEN_LIVE_HARNESS_REALTIME_MODEL);
    expect(conn.requestUrl).toContain('/api-ws/v1/realtime');

    const update = await stack.fakeDash.waitForMessage(
      (message) => message['type'] === 'session.update',
      { timeoutMs: 10_000, description: 'session.update' },
    );
    const session = update['session'] as Record<string, unknown>;
    const tools = session['tools'] as Array<{
      type: string;
      function: { name: string };
    }>;
    expect(tools.map((tool) => tool.function.name).sort()).toEqual(
      EXPECTED_TOOL_NAMES,
    );
    expect(typeof session['instructions']).toBe('string');
    expect(String(session['instructions']).length).toBeGreaterThan(0);
    // Fixed instructions may explain Memory section names even when Memory is
    // disabled. Its separate snapshot, not those words, is the data boundary.
    const memoryMessage = await stack.fakeDash.waitForMessage(
      (message) =>
        contextTextOf(message)?.startsWith('[BACKEND] [MEMORY_CONTEXT] ') ===
        true,
    );
    const memorySnapshot = JSON.parse(
      contextTextOf(memoryMessage)!.slice('[BACKEND] [MEMORY_CONTEXT] '.length),
    ) as Record<string, unknown>;
    expect(memorySnapshot['enabled']).toBe(false);
    expect(memorySnapshot).not.toHaveProperty('sections');
    expect(String(session['instructions'])).not.toContain(
      QWEN_LIVE_HARNESS_API_KEY,
    );

    const listening = await stack.host.waitForState(
      (entry) => entry.status['state'] === 'listening',
      { timeoutMs: 20_000, fromIndex: stateIndex },
    );
    callEpoch = listening.epoch;
    expect(callEpoch).toBeGreaterThan(0);
  });

  it('routes Host input audio up and provider output audio down', async () => {
    const pcmIn = Buffer.alloc(3_200);
    for (let i = 0; i < pcmIn.length; i++) pcmIn[i] = i % 251;
    const inboxIndex = stack.fakeDash.inbox.length;
    stack.host.sendAudio(callEpoch, pcmIn);
    const append = await stack.fakeDash.waitForMessage(
      (message) => message['type'] === 'input_audio_buffer.append',
      { fromIndex: inboxIndex, description: 'input_audio_buffer.append' },
    );
    expect(Buffer.from(String(append['audio']), 'base64').equals(pcmIn)).toBe(
      true,
    );

    const pcmOut = Buffer.alloc(4_800);
    for (let i = 0; i < pcmOut.length; i++) pcmOut[i] = (i * 7) % 253;
    const framesBefore = stack.host.audioFrames.length;
    conn.respondWithAudio(pcmOut);
    const frame = await stack.host.waitForAudioFrame({
      fromIndex: framesBefore,
    });
    expect(frame.equals(pcmOut)).toBe(true);
    await expect
      .poll(() =>
        stack.host.messages.some(
          (message) =>
            message['type'] === 'host.output_audio_finished' &&
            message['epoch'] === callEpoch,
        ),
      )
      .toBe(true);
  });

  it('hands off to the real serve daemon and injects the result back', async () => {
    const inboxIndex = stack.fakeDash.inbox.length;
    const hostMessageIndex = stack.host.messages.length;
    stack.host.autoCompletePlayback = false;
    stack.fakeDash.autoAckResponses = false;
    conn.speakTranscript('fix the failing test');
    await stack.fakeDash.waitForMessage(
      (message) => message['type'] === 'response.create',
      { fromIndex: inboxIndex, description: 'direct response request' },
    );
    conn.functionCall({
      name: 'handoff',
      argumentsJson: '{"task":"fix the failing test"}',
      callId: 'call-1',
      preamble: {
        audio: Buffer.alloc(4_800),
        transcript: 'I will check the failing test.',
      },
    });
    stack.fakeDash.autoAckResponses = true;

    // Receipt: the handoff was admitted by qwen serve.
    const receiptMessage = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === 'call-1',
      {
        timeoutMs: 30_000,
        fromIndex: inboxIndex,
        description: 'the handoff function_call_output receipt',
      },
    );
    const receipt = JSON.parse(
      functionCallOutputOf(receiptMessage)!.output,
    ) as Record<string, unknown>;
    expect(receipt['status']).toBe('accepted');
    expect(receipt['job']).toBe('job_1');

    // The real serve daemon received the prompt (model side = fake OpenAI).
    await expect
      .poll(
        () =>
          stack.fakeOpenAI.requests.some((request) =>
            JSON.stringify(request.body['messages'] ?? []).includes(
              'fix the failing test',
            ),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

    await waitForLiveLogEvents(
      stack.dataDir,
      (event) =>
        event.type === 'backend.event' &&
        event.payload['type'] === 'turn_complete',
    );
    await sleep(250);
    expect(
      stack.fakeDash.inbox
        .slice(inboxIndex)
        .some((message) =>
          contextTextOf(message)?.includes('[COMPLETE job_1]'),
        ),
    ).toBe(false);
    const finished = stack.host.messages
      .slice(hostMessageIndex)
      .find((message) => message['type'] === 'host.output_audio_finished');
    expect(finished).toBeDefined();
    expect(finished!['epoch']).toBe(callEpoch);
    expect(Number(finished!['outputId'])).toBeGreaterThan(0);
    stack.host.completePlayback(callEpoch, Number(finished!['outputId']));
    stack.host.autoCompletePlayback = true;

    // No new user speech: the playback receipt must reopen result injection.
    const completeMessage = await stack.fakeDash.waitForMessage(
      (message) =>
        taskResultPayloadOf(message)?.status === 'completed' &&
        taskResultPayloadOf(message)?.job === 'job_1',
      {
        timeoutMs: 30_000,
        fromIndex: inboxIndex,
        description: 'the [COMPLETE job_1] context injection',
      },
    );
    const completeText = speechSummaryOf(completeMessage)!;
    expect(conn.inbox).not.toContain(completeMessage);
    expect(completeText).toMatch(/^\[COMPLETE job_1\] /);
    expect(completeText).toContain('m1 backend turn complete');
    expect(stack.fakeDash.inbox.indexOf(receiptMessage)).toBeLessThan(
      stack.fakeDash.inbox.indexOf(completeMessage),
    );

    // The model summarizes the outcome; no fixed English text is read aloud.
    expect(completeText).not.toContain('[SPEAK_TO_USER]');
    expect(taskResultPayloadOf(completeMessage)).toMatchObject({
      status: 'completed',
      job: 'job_1',
    });
    await waitForLiveResponseAfter(stack, completeMessage, 'task_result');
  });

  it('removes the discovery file on SIGTERM', async () => {
    const discoveryFile = liveDiscoveryPath(stack.discoveryDir);
    expect(existsSync(discoveryFile)).toBe(true);
    await stack.live.dispose(); // SIGTERM → graceful stop
    expect(existsSync(discoveryFile)).toBe(false);
  });
});
