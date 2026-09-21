/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  contextTextOf,
  functionCallOutputOf,
  speechAnnouncementOf,
  startFakeDashScopeServer,
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import {
  FakeHost,
  readLiveDiscovery,
  readLiveLogEvents,
  spawnQwenLiveHarness,
  startLiveCall,
  waitForLiveLogEvents,
  type SpawnedQwenLiveHarness,
} from './qwen-live-harness.js';

type Json = Record<string, unknown>;
const FALSE_SUCCESS_AUDIO = Buffer.alloc(4800, 11);
const CORRECTION_AUDIO = Buffer.alloc(4800, 22);
const FOLLOW_UP_AUDIO = Buffer.alloc(4800, 33);
const FIXED_CORRECTION = '刚才没有新建持续解说。请再说一下要解说什么画面。';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('mutes a false task-success continuation, reads the runtime rejection, and keeps the call open', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-task-rejection-'));
  const dataDir = join(directory, 'data');
  const discoveryDir = join(directory, 'discovery');
  await mkdir(dataDir);
  await mkdir(discoveryDir);
  const fakeDash = await startFakeDashScopeServer();
  fakeDash.autoAckResponses = false;
  const resources: { live?: SpawnedQwenLiveHarness; host?: FakeHost } = {};
  cleanup.push(async () => {
    resources.host?.close();
    await resources.live?.dispose();
    await fakeDash.close();
    await rm(directory, { recursive: true, force: true });
  });
  const live = await spawnQwenLiveHarness({
    dataDir,
    discoveryDir,
    cwd: directory,
    realtimeEndpoint: fakeDash.url,
    env: { PATH: '' },
    initialConfig: {
      language: 'zh-CN',
      backends: [],
      memory: { enabled: false },
      proactive: { enabled: true },
    },
  });
  resources.live = live;
  const host = new FakeHost(discoveryDir);
  resources.host = host;
  host.autoCompletePlayback = false;
  await host.connect();
  const { conn, epoch } = await startLiveCall({ host, fakeDash });
  const stateStart = host.states.length;
  const callId = 'unrequested-screen-narration';
  let queuedUserCall = true;
  let receiptPending = false;
  let followUpPending = false;
  let continuation: { request: Json; responseId: string } | undefined;
  let followUpResponseId: string | undefined;
  let speech:
    | {
        connection: FakeDashScopeConnection;
        input: Json;
        request: Json;
        responseId: string;
      }
    | undefined;

  // Only fake PCM crosses the real daemon/Host socket. No screen or backend
  // task is needed: the bad tool call must be rejected before either starts.
  fakeDash.speechResponder = (connection, input, request) => {
    const responseId = connection.beginResponse();
    speech = { connection, input, request, responseId };
    connection.send({
      type: 'response.audio.delta',
      response_id: responseId,
      delta: CORRECTION_AUDIO.toString('base64'),
    });
    connection.send({
      type: 'response.audio_transcript.done',
      response_id: responseId,
      transcript: FIXED_CORRECTION,
    });
    // Hold response.done so the test can prove no unvalidated PCM escapes.
    return responseId;
  };
  conn.socket.on('message', (raw, binary) => {
    if (binary) return;
    const message = JSON.parse(String(raw)) as Json;
    if (functionCallOutputOf(message)?.callId === callId) {
      receiptPending = true;
      return;
    }
    if (message['type'] !== 'response.create') return;
    if (queuedUserCall) {
      queuedUserCall = false;
      return; // The shared fake has already emitted the queued tool call.
    }
    if (receiptPending) {
      receiptPending = false;
      continuation = {
        request: conn.inbox.at(-1)!,
        responseId: conn.respondWithAudio(
          FALSE_SUCCESS_AUDIO,
          '屏幕解说已经开启，我会一直给你讲解。',
        ),
      };
    } else if (followUpPending) {
      followUpPending = false;
      followUpResponseId = conn.respondWithAudio(
        FOLLOW_UP_AUDIO,
        '我在，我们可以继续聊。',
      );
    } else {
      const responseId = conn.beginResponse();
      conn.finishResponse(responseId);
    }
  });

  conn.queueFunctionCall({
    name: 'create_live_narration',
    callId,
    argumentsJson: JSON.stringify({
      title: 'Unrequested synthetic narration',
      modalities: ['vision'],
      narration_focus: 'Describe changes on the screen.',
    }),
  });
  conn.speakTranscript('你刚才的回答不准确。');
  const receipt = await fakeDash.waitForMessage(
    (message) => functionCallOutputOf(message)?.callId === callId,
  );
  expect(JSON.parse(functionCallOutputOf(receipt)!.output)).toMatchObject({
    status: 'clarification_required',
    code: 'task_authorization_required',
  });
  await waitForLiveLogEvents(
    dataDir,
    (event) =>
      event.type === 'task.authorization_rejected' &&
      event.payload['tool'] === 'create_live_narration',
  );
  await waitForLiveLogEvents(
    dataDir,
    (event) =>
      event.type === 'response.done' &&
      event.payload['responseId'] === continuation?.responseId &&
      event.payload['authority'] === 'tool_continuation',
  );
  // Provider response modalities do not enforce this boundary: even audio
  // returned despite the local rejection must be discarded by the daemon.
  expect(continuation!.request['type']).toBe('response.create');
  const input = await fakeDash.waitForMessage(
    (message) => speechAnnouncementOf(message) === FIXED_CORRECTION,
  );
  await fakeDash.waitForMessage(
    (message) =>
      message['type'] === 'response.create' && message === speech?.request,
  );
  expect(speech!.input).toBe(input);
  expect(speech!.connection).not.toBe(conn);
  const speechSession = speech!.connection.inbox.find(
    (message) => message['type'] === 'session.update',
  )!['session'] as Json;
  expect(speechSession).toMatchObject({
    tools: [],
    tool_choice: 'none',
    enable_search: false,
    turn_detection: null,
  });
  expect(speechSession['instructions']).toContain(
    'task operation was not performed',
  );
  expect(JSON.parse(contextTextOf(input)!)).toEqual({
    announcement: FIXED_CORRECTION,
  });
  expect(host.audioFrames).toEqual([]);

  speech!.connection.finishResponse(speech!.responseId);
  expect(await host.waitForAudioFrame()).toEqual(CORRECTION_AUDIO);
  await expect
    .poll(() =>
      host.messages.some(
        (message) => message['type'] === 'host.output_audio_finished',
      ),
    )
    .toBe(true);
  const marker = host.messages.find(
    (message) => message['type'] === 'host.output_audio_finished',
  )!;
  const delivered = () =>
    conn.inbox.find((message) => {
      const text = contextTextOf(message);
      if (!text?.startsWith('[BACKEND] [RESULT_DELIVERY] ')) return false;
      return (
        (JSON.parse(text.slice('[BACKEND] [RESULT_DELIVERY] '.length)) as Json)[
          'kind'
        ] === 'task_rejection'
      );
    });
  expect(delivered()).toBeUndefined();
  expect(marker['epoch']).toBe(epoch);
  host.completePlayback(epoch, Number(marker['outputId']));
  await expect.poll(() => delivered() !== undefined).toBe(true);
  expect(
    JSON.parse(
      contextTextOf(delivered()!)!.slice('[BACKEND] [RESULT_DELIVERY] '.length),
    ),
  ).toEqual({
    kind: 'task_rejection',
    status: 'played',
    spoken_text: FIXED_CORRECTION,
  });

  const discovery = await readLiveDiscovery(discoveryDir);
  const page = await fetch(`${live.url}/live/subagents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${discovery.token}`,
      'x-qwen-live-harness-nonce': discovery.instanceNonce,
    },
    body: JSON.stringify({ action: 'list' }),
  });
  expect(page.status).toBe(200);
  expect(await page.json()).toMatchObject({
    page: { snapshot: { tasks: [] } },
  });
  expect(
    host.messages.some((message) => message['type'] === 'host.capture_visual'),
  ).toBe(false);

  host.autoCompletePlayback = true;
  followUpPending = true;
  conn.speakTranscript('你还在吗？');
  expect(await host.waitForAudioFrame({ fromIndex: 1 })).toEqual(
    FOLLOW_UP_AUDIO,
  );
  await waitForLiveLogEvents(
    dataDir,
    (event) =>
      event.type === 'response.done' &&
      event.payload['responseId'] === followUpResponseId &&
      event.payload['authority'] === 'direct',
  );
  expect(host.audioFrames).toEqual([CORRECTION_AUDIO, FOLLOW_UP_AUDIO]);
  expect(
    host.states
      .slice(stateStart)
      .some((entry) =>
        ['idle', 'error'].includes(String(entry.status['state'])),
      ),
  ).toBe(false);
  expect(conn.socket.readyState).toBe(conn.socket.OPEN);
  expect(
    (await readLiveLogEvents(dataDir)).some(
      (event) => event.type === 'session.end',
    ),
  ).toBe(false);
});
