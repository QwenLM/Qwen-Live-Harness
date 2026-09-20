/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  functionCallOutputOf,
  notificationOf,
  startFakeDashScopeServer,
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import {
  FakeHost,
  readLiveDiscovery,
  spawnQwenLiveHarness,
  startLiveCall,
  waitForLiveLogEvents,
  type SpawnedQwenLiveHarness,
} from './qwen-live-harness.js';

type Json = Record<string, unknown>;
type Task = {
  id: string;
  kind: string;
  status: string;
  output?: string;
  notification?: string;
};
const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const PREAMBLE = Buffer.alloc(4800, 11);
const ADMISSION = Buffer.alloc(4800, 22);
const ANSWER = Buffer.alloc(4800, 33);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function visualPayload(message: Json): Json | undefined {
  const envelope = notificationOf(message);
  if (envelope?.kind !== 'visual_result') return undefined;
  return JSON.parse(envelope.payload) as Json;
}

/** Real isolated daemon, fake capture and provider. Never acquires a device. */
async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), 'qwen-live-visual-integration-'),
  );
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
  const model = 'private-visual-realtime-deployment';
  const apiKey = 'fixture-main-and-visual-api-key';
  const live = await spawnQwenLiveHarness({
    dataDir,
    discoveryDir,
    cwd: directory,
    realtimeEndpoint: fakeDash.url,
    apiKey,
    model,
    env: { PATH: '' },
    initialConfig: {
      backends: [],
      memory: { enabled: false },
      proactive: { enabled: false },
    },
  });
  resources.live = live;
  const host = new FakeHost(discoveryDir);
  resources.host = host;
  await host.connect();
  const { conn } = await startLiveCall({ host, fakeDash });
  const receiptResponses = new Map<
    string,
    { request: Json; responseId: string }
  >();
  const resultResponses = new Map<Json, string>();
  fakeDash.speechResponder = (speech, input) => {
    expect(speech).not.toBe(conn);
    const payload = visualPayload(input);
    expect(payload).toBeDefined();
    const responseId = speech.respondWithAudio(
      ANSWER,
      String(payload?.['answer'] ?? 'Update ready.'),
    );
    resultResponses.set(input, responseId);
    return responseId;
  };
  const pendingReceipts: Array<{ callId: string; output: string }> = [];
  const pendingNotifications: Json[] = [];
  let queuedUserCalls = 0;
  conn.socket.on('message', (raw, binary) => {
    if (binary) return;
    const message = JSON.parse(String(raw)) as Json;
    const receipt = functionCallOutputOf(message);
    if (receipt) {
      pendingReceipts.push(receipt);
      return;
    }
    if (notificationOf(message)) {
      pendingNotifications.push(conn.inbox.at(-1)!);
      return;
    }
    if (message['type'] !== 'response.create') return;
    if (queuedUserCalls > 0) {
      queuedUserCalls--;
      return;
    }
    const request = conn.inbox.at(-1)!;
    const pending = pendingReceipts.shift();
    if (pending) {
      const responseId = conn.respondWithAudio(
        ADMISSION,
        'The visual task was accepted.',
      );
      receiptResponses.set(pending.callId, { request, responseId });
      return;
    }
    const notice = pendingNotifications.shift();
    if (notice) {
      const payload = visualPayload(notice);
      const responseId = conn.respondWithAudio(
        ANSWER,
        String(payload?.['answer'] ?? 'Update ready.'),
      );
      resultResponses.set(notice, responseId);
      return;
    }
    const responseId = conn.beginResponse();
    conn.finishResponse(responseId);
  });
  const control = async (action: Json) => {
    const discovery = await readLiveDiscovery(discoveryDir);
    const response = await fetch(`${live.url}/live/subagents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${discovery.token}`,
        'x-qwen-live-harness-nonce': discovery.instanceNonce,
      },
      body: JSON.stringify(action),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Json;
  };
  const tasks = async () =>
    (
      (await control({ action: 'list' }))['page'] as {
        snapshot: { tasks: Task[] };
      }
    ).snapshot.tasks;
  const waitTask = async (id: string, status: string) => {
    let found: Task | undefined;
    await expect
      .poll(async () => {
        found = (await tasks()).find((task) => task.id === id);
        return found?.status;
      })
      .toBe(status);
    return found!;
  };
  const invoke = async (
    question: string,
    callId = 'visual-capture',
    explicit = true,
  ) => {
    const fromIndex = fakeDash.inbox.length;
    queuedUserCalls++;
    conn.queueFunctionCall({
      name: 'appshot',
      callId,
      argumentsJson: JSON.stringify(explicit ? { query: question } : {}),
      preamble: { audio: PREAMBLE, transcript: 'I will inspect the image.' },
    });
    conn.speakTranscript(question);
    const receiptMessage = await fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === callId,
      { fromIndex },
    );
    const receipt = JSON.parse(
      functionCallOutputOf(receiptMessage)!.output,
    ) as Json;
    await waitForLiveLogEvents(
      dataDir,
      (event) =>
        event.type === 'response.done' &&
        event.payload['authority'] === 'tool_continuation' &&
        event.payload['responseId'] ===
          receiptResponses.get(callId)?.responseId,
    );
    return {
      receipt,
      receiptMessage,
      continuation: receiptResponses.get(callId)!,
      taskId: String(receipt['taskId']),
    };
  };
  const worker = async () => {
    let connection: FakeDashScopeConnection | undefined;
    await expect
      .poll(() => {
        connection = fakeDash.connections.find(
          (candidate) =>
            candidate !== conn &&
            candidate.socket.readyState === candidate.socket.OPEN &&
            candidate.inbox.some(
              (message) =>
                message['type'] === 'session.update' &&
                (message['session'] as Json)['enable_search'] === false,
            ),
        );
        return Boolean(connection);
      })
      .toBe(true);
    await fakeDash.waitForMessage(
      (message) =>
        connection!.inbox.includes(message) &&
        message['type'] === 'input_audio_buffer.commit',
    );
    return connection!;
  };
  const commit = async (connection: FakeDashScopeConnection) => {
    expect(
      connection.inbox.some((message) => message['type'] === 'response.create'),
    ).toBe(false);
    connection.send({
      type: 'input_audio_buffer.committed',
      item_id: 'visual-input',
    });
    return fakeDash.waitForMessage(
      (message) =>
        connection.inbox.includes(message) &&
        message['type'] === 'response.create',
    );
  };
  const answer = (connection: FakeDashScopeConnection, text: string) => {
    const responseId = connection.beginResponse();
    connection.send({
      type: 'response.text.done',
      response_id: responseId,
      text,
    });
    connection.finishResponse(responseId);
  };
  const result = async (question: string) => {
    const message = await fakeDash.waitForMessage(
      (message) => visualPayload(message)?.['query'] === question,
    );
    await waitForLiveLogEvents(
      dataDir,
      (event) =>
        event.type === 'transcript.assistant' &&
        event.payload['source'] === 'isolated_result' &&
        event.payload['purpose'] === 'visual_result' &&
        event.payload['responseId'] === resultResponses.get(message),
    );
    return { message, payload: visualPayload(message)! };
  };
  return {
    fakeDash,
    live,
    host,
    conn,
    dataDir,
    model,
    apiKey,
    control,
    tasks,
    waitTask,
    invoke,
    worker,
    commit,
    answer,
    result,
  };
}

describe('standalone On Demand visual subagent', () => {
  it('waits for the exact quoted input acknowledgement before asking the isolated speaker to respond', async () => {
    const f = await fixture();
    const question = 'Describe the ACK-gated snapshot.';
    const accepted = await f.invoke(question);
    const worker = await f.worker();
    await f.commit(worker);
    f.fakeDash.autoAckUserItems = false;
    f.answer(worker, 'The snapshot contains an orange circle.');
    const input = await f.fakeDash.waitForMessage(
      (message) => visualPayload(message)?.['query'] === question,
    );
    const speaker = f.fakeDash.connections.find((candidate) =>
      candidate.inbox.includes(input),
    )!;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(
      speaker.inbox.some((message) => message['type'] === 'response.create'),
    ).toBe(false);
    expect(Buffer.concat(f.host.audioFrames)).toEqual(PREAMBLE);
    speaker.send({
      type: 'conversation.item.created',
      item: {
        type: 'message',
        id: 'wrong-summary',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'Different quoted result' }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(
      speaker.inbox.some((message) => message['type'] === 'response.create'),
    ).toBe(false);
    speaker.send({
      type: 'conversation.item.created',
      item: {
        ...(input['item'] as Json),
        id: 'provider-assigned-summary',
        status: 'completed',
      },
    });
    await f.result(question);
    expect(await f.waitTask(accepted.taskId, 'completed')).toMatchObject({
      notification: 'delivered',
    });
    expect(
      speaker.inbox.filter((message) => message['type'] === 'response.create'),
    ).toHaveLength(1);
  });

  it.each(['complete', 'cancel'] as const)(
    'buffers isolated result audio until complete and safely handles %s',
    async (outcome) => {
      const f = await fixture();
      const question = 'Describe the buffered snapshot.';
      const accepted = await f.invoke(question);
      const worker = await f.worker();
      await f.commit(worker);
      let speaker: FakeDashScopeConnection | undefined;
      let responseId = '';
      f.fakeDash.speechResponder = (connection, input) => {
        speaker = connection;
        expect(visualPayload(input)?.['query']).toBe(question);
        responseId = connection.beginResponse();
        connection.send({
          type: 'response.audio.delta',
          response_id: responseId,
          delta: ANSWER.toString('base64'),
        });
        connection.send({
          type: 'response.audio_transcript.done',
          response_id: responseId,
          transcript: 'There is a blue circle.',
        });
        return responseId;
      };
      f.answer(worker, 'There is a blue circle.');
      await expect.poll(() => Boolean(speaker)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(Buffer.concat(f.host.audioFrames)).toEqual(PREAMBLE);
      expect(
        (await f.tasks()).find((task) => task.id === accepted.taskId)?.status,
      ).toBe('delivering');
      if (outcome === 'cancel') {
        expect(
          await f.control({ action: 'stop', taskId: accepted.taskId }),
        ).toMatchObject({ type: 'outcome', outcome: 'stopped' });
        await expect
          .poll(() => speaker!.socket.readyState)
          .toBe(speaker!.socket.CLOSED);
        speaker!.finishResponse(responseId);
        expect(await f.waitTask(accepted.taskId, 'cancelled')).toMatchObject({
          status: 'cancelled',
        });
        expect(Buffer.concat(f.host.audioFrames)).toEqual(PREAMBLE);
      } else {
        speaker!.send({ type: 'response.audio.done', response_id: responseId });
        speaker!.finishResponse(responseId);
        expect(await f.waitTask(accepted.taskId, 'completed')).toMatchObject({
          notification: 'delivered',
        });
        expect(Buffer.concat(f.host.audioFrames)).toEqual(
          Buffer.concat([PREAMBLE, ANSWER]),
        );
      }
      expect(f.live.proc.exitCode).toBeNull();
    },
  );

  it.each([true, false])(
    'analyzes through an isolated same-model worker then announces the result without a backend (explicit question=%s)',
    async (explicit) => {
      const f = await fixture();
      const question = 'Describe the main large regions in this snapshot.';
      const accepted = await f.invoke(question, 'analyze-image', explicit);
      expect(accepted.receipt).toMatchObject({
        status: 'accepted',
        source: 'screen',
        screen_scope: 'display',
      });
      expect(accepted.taskId).toMatch(/^visual:/);
      expect(accepted.receipt['asset']).toMatch(/^asset_/);
      expect(accepted.receipt).not.toHaveProperty('answer');
      const worker = await f.worker();
      expect(worker.model).toBe(f.model);
      expect(worker.authorization).toBe(`Bearer ${f.apiKey}`);
      expect(f.conn.model).toBe(worker.model);
      expect(f.conn.authorization).toBe(worker.authorization);
      const update = worker.inbox.find(
        (message) => message['type'] === 'session.update',
      )!;
      expect(update).toMatchObject({
        session: {
          modalities: ['text'],
          voice: 'Tina',
          smooth_output: false,
          tools: [],
          tool_choice: 'none',
          enable_search: false,
          turn_detection: null,
          video: { input: { representation_compact: 'normal' } },
        },
      });
      expect(worker.inbox.map((message) => message['type'])).toEqual([
        'session.update',
        'input_audio_buffer.append',
        'input_image_buffer.append',
        'input_audio_buffer.append',
        'input_image_buffer.append',
        'input_audio_buffer.commit',
      ]);
      for (const event of worker.inbox.filter(
        (message) => message['type'] === 'input_audio_buffer.append',
      ))
        expect(Buffer.from(String(event['audio']), 'base64')).toEqual(
          Buffer.alloc(32000),
        );
      expect(
        worker.inbox
          .filter((message) => message['type'] === 'input_image_buffer.append')
          .map((message) => message['image']),
      ).toEqual([IMAGE, IMAGE]);
      const requested = await f.commit(worker);
      expect(
        JSON.parse((requested['response'] as Json)['instructions'] as string),
      ).toEqual({ source: 'screen', question });
      expect(String((update['session'] as Json)['instructions'])).not.toContain(
        question,
      );
      expect(JSON.stringify(worker.inbox)).not.toContain(
        'fake accessibility text',
      );
      expect(
        worker.inbox.some(
          (message) => message['type'] === 'conversation.item.create',
        ),
      ).toBe(false);
      expect(await f.tasks()).toEqual([
        expect.objectContaining({
          id: accepted.taskId,
          kind: 'visual',
          status: 'running',
        }),
      ]);
      const observation =
        'The snapshot has a large blue left region and a smaller white right region.';
      f.answer(worker, observation);
      const delivered = await f.result(question);
      expect(delivered.payload).toMatchObject({
        query: question,
        answer: observation,
        status: 'completed',
        source: 'screen',
      });
      expect(notificationOf(delivered.message)?.kind).toBe('visual_result');
      expect(f.conn.inbox).not.toContain(delivered.message);
      const speech = f.fakeDash.connections.find((candidate) =>
        candidate.inbox.includes(delivered.message),
      )!;
      expect(speech).not.toBe(worker);
      expect(
        speech.inbox.find((message) => message['type'] === 'session.update')?.[
          'session'
        ],
      ).toMatchObject({
        tools: [],
        tool_choice: 'none',
        enable_search: false,
        turn_detection: null,
      });
      expect(f.fakeDash.inbox.indexOf(delivered.message)).toBeGreaterThan(
        f.fakeDash.inbox.indexOf(accepted.continuation.request),
      );
      expect(await f.waitTask(accepted.taskId, 'completed')).toMatchObject({
        notification: 'delivered',
      });
      expect(Buffer.concat(f.host.audioFrames)).toEqual(
        Buffer.concat([PREAMBLE, ANSWER]),
      );
      expect(
        f.conn.inbox.some(
          (message) => message['type'] === 'input_image_buffer.append',
        ),
      ).toBe(false);
      for (const message of f.conn.inbox.filter(
        (message) => message['type'] === 'response.create',
      ))
        expect(message).not.toHaveProperty('response.instructions');
      expect((await f.tasks()).some((task) => task.kind === 'harness')).toBe(
        false,
      );
      expect(f.live.stderrBuf.value).not.toContain('qwen serve');
      expect(f.live.proc.exitCode).toBeNull();
    },
  );

  it.each(['subagent', 'end_call'] as const)(
    'cancels an in-flight visual worker through %s and never announces late output',
    async (mode) => {
      const f = await fixture();
      const question = 'Do not announce the cancelled snapshot.';
      const accepted = await f.invoke(question);
      const worker = await f.worker();
      await f.commit(worker);
      const before = f.host.audioFrames.length;
      if (mode === 'subagent')
        expect(
          await f.control({ action: 'stop', taskId: accepted.taskId }),
        ).toMatchObject({ type: 'outcome', outcome: 'stopped' });
      else {
        const statesBefore = f.host.states.length;
        f.host.action('stop');
        await f.host.waitForState((entry) => entry.status['state'] === 'idle', {
          fromIndex: statesBefore,
        });
      }
      await f.waitTask(accepted.taskId, 'cancelled');
      await expect
        .poll(() => worker.socket.readyState)
        .toBe(worker.socket.CLOSED);
      f.answer(worker, 'Late cancelled observation');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        f.conn.inbox.some(
          (message) => visualPayload(message)?.['query'] === question,
        ),
      ).toBe(false);
      expect(f.host.audioFrames).toHaveLength(before);
      expect(f.fakeDash.connections).toHaveLength(2);
      expect(f.live.proc.exitCode).toBeNull();
    },
  );

  it('reports a failed visual inference without fabricating image contents or using a Harness', async () => {
    const f = await fixture();
    const question = 'Inspect this snapshot without inventing details.';
    const accepted = await f.invoke(question);
    const worker = await f.worker();
    await f.commit(worker);
    worker.send({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'PRIVATE provider detail and fixture-main-and-visual-api-key',
      },
    });
    const delivered = await f.result(question);
    expect(delivered.payload).toMatchObject({
      status: 'failed',
      failed: true,
      query: question,
    });
    expect(JSON.stringify(delivered.payload)).not.toContain('PRIVATE');
    expect(JSON.stringify(delivered.payload)).not.toContain(f.apiKey);
    expect(await f.waitTask(accepted.taskId, 'failed')).toMatchObject({
      kind: 'visual',
    });
    expect((await f.tasks()).some((task) => task.kind === 'harness')).toBe(
      false,
    );
    expect(f.live.proc.exitCode).toBeNull();
  });
});
