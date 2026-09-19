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
  contextTextOf,
  functionCallOutputOf,
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
  title: string;
  kind: string;
  status: string;
  notification?: string;
  triggerCount?: number;
};
const PREAMBLE = Buffer.alloc(4800, 7);
const MUTED_RECEIPT = Buffer.alloc(4800, 8);
const FALLBACK_AUDIO = Buffer.alloc(4800, 9);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), 'qwen-live-proactive-fallback-'),
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
  const live = await spawnQwenLiveHarness({
    dataDir,
    discoveryDir,
    cwd: directory,
    realtimeEndpoint: fakeDash.url,
    model: 'fixture-shared-realtime',
    apiKey: 'fixture-shared-key',
    env: { PATH: '', QWEN_LIVE_HARNESS_LOG_LEVEL: 'debug' },
    initialConfig: {
      backends: [],
      memory: { enabled: false },
      proactive: { enabled: true },
    },
  });
  resources.live = live;
  const host = new FakeHost(discoveryDir);
  resources.host = host;
  await host.connect();
  const { conn, epoch } = await startLiveCall({ host, fakeDash });
  const receipts: Array<{ callId: string; output: string }> = [];
  const receiptResponses = new Map<
    string,
    { request: Json; responseId: string }
  >();
  const notices: Json[] = [];
  let queuedUserCall = false;
  conn.socket.on('message', (raw, binary) => {
    if (binary) return;
    const message = JSON.parse(String(raw)) as Json;
    const receipt = functionCallOutputOf(message);
    if (receipt) {
      receipts.push(receipt);
      return;
    }
    if (contextTextOf(message)?.startsWith('[PROACTIVE_EVENT]')) {
      notices.push(conn.inbox.at(-1)!);
      return;
    }
    if (message['type'] !== 'response.create') return;
    if (queuedUserCall) {
      queuedUserCall = false;
      return;
    }
    const pending = receipts.shift();
    if (pending) {
      const responseId =
        pending.callId === 'silent-proactive'
          ? conn.beginResponse()
          : conn.respondWithAudio(
              MUTED_RECEIPT,
              'This receipt drain must not be played.',
            );
      if (pending.callId === 'silent-proactive') {
        // Deliberately hold this real response in flight. Fallback must not
        // start until the test sends its final response.done below.
        conn.send({
          type: 'response.audio.delta',
          response_id: responseId,
          delta: MUTED_RECEIPT.toString('base64'),
        });
        conn.send({ type: 'response.audio.done', response_id: responseId });
      }
      receiptResponses.set(pending.callId, {
        request: conn.inbox.at(-1)!,
        responseId,
      });
      return;
    }
    if (notices.length) {
      notices.shift();
      conn.functionCall({
        name: 'remain_silent',
        callId: 'silent-proactive',
        argumentsJson: '{}',
      });
      return;
    }
    const responseId = conn.beginResponse();
    conn.finishResponse(responseId);
  });
  const title = 'Synthetic knock monitor';
  const create = async () => {
    queuedUserCall = true;
    conn.queueFunctionCall({
      name: 'create_proactive_monitor',
      callId: 'create-knock-monitor',
      argumentsJson: JSON.stringify({
        title,
        modalities: ['audio'],
        condition: '听到清晰的敲桌子声',
        trigger_response: '提醒我听到了敲桌声',
        repeat: false,
      }),
      preamble: { audio: PREAMBLE, transcript: '我会留意敲桌子的声音。' },
    });
    conn.speakTranscript('请帮我听敲桌子的声音，听到后提醒我一次。');
    await fakeDash.waitForMessage(
      (message) =>
        functionCallOutputOf(message)?.callId === 'create-knock-monitor',
    );
    await waitForLiveLogEvents(
      dataDir,
      (event) =>
        event.type === 'response.done' &&
        event.payload['responseId'] ===
          receiptResponses.get('create-knock-monitor')?.responseId,
    );
  };
  const task = async (): Promise<Task | undefined> => {
    const discovery = await readLiveDiscovery(discoveryDir);
    const response = await fetch(`${live.url}/live/subagents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${discovery.token}`,
        'x-qwen-live-harness-nonce': discovery.instanceNonce,
      },
      body: JSON.stringify({ action: 'list' }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      page: { snapshot: { tasks: Task[] } };
    };
    return result.page.snapshot.tasks.find((task) => task.title === title);
  };
  const connectionFor = async (predicate: (session: Json) => boolean) => {
    let found: FakeDashScopeConnection | undefined;
    await expect
      .poll(
        () => {
          found = fakeDash.connections.find(
            (candidate) =>
              candidate !== conn &&
              candidate.inbox.some(
                (message) =>
                  message['type'] === 'session.update' &&
                  predicate(message['session'] as Json),
              ),
          );
          return Boolean(found);
        },
        { timeout: 10000 },
      )
      .toBe(true);
    return found!;
  };
  return {
    fakeDash,
    live,
    host,
    conn,
    epoch,
    dataDir,
    task,
    create,
    connectionFor,
    receiptResponses,
  };
}

describe('standalone Proactive silent-response fallback', () => {
  it.each(['played', 'failed'] as const)(
    'drains remain_silent before a real isolated speech worker and records %s delivery',
    async (outcome) => {
      const f = await fixture();
      await f.create();
      const monitor = await f.connectionFor(
        (session) =>
          Array.isArray(session['modalities']) &&
          session['modalities'].length === 1 &&
          session['modalities'][0] === 'text' &&
          session['turn_detection'] === null,
      );
      // Synthetic PCM only. No microphone, speaker, screen, or real provider is used.
      for (let chunk = 0; chunk < 16; chunk++) {
        f.host.sendAudio(f.epoch, Buffer.alloc(4000, 3));
        await new Promise((resolve) => setTimeout(resolve, 125));
      }
      const commit = await f.fakeDash.waitForMessage(
        (message) =>
          monitor.inbox.includes(message) &&
          message['type'] === 'input_audio_buffer.commit',
      );
      expect(
        monitor.inbox
          .filter((message) => message['type'] === 'input_audio_buffer.append')
          .reduce(
            (bytes, message) =>
              bytes + Buffer.from(String(message['audio']), 'base64').length,
            0,
          ),
      ).toBe(64000);
      monitor.send({
        type: 'input_audio_buffer.committed',
        item_id: 'monitor-clip',
      });
      await f.fakeDash.waitForMessage(
        (message) =>
          monitor.inbox.includes(message) &&
          message['type'] === 'response.create',
        { fromIndex: f.fakeDash.inbox.indexOf(commit) + 1 },
      );
      f.host.autoCompletePlayback = false;
      const monitorResponse = monitor.beginResponse();
      monitor.send({
        type: 'response.text.done',
        response_id: monitorResponse,
        text: 'Reply: 检测到敲桌子',
      });
      monitor.finishResponse(monitorResponse);
      const silenceReceipt = await f.fakeDash.waitForMessage(
        (message) =>
          functionCallOutputOf(message)?.callId === 'silent-proactive',
      );
      expect(functionCallOutputOf(silenceReceipt)?.output).toBe('');
      await expect
        .poll(() => f.receiptResponses.has('silent-proactive'))
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(f.fakeDash.connections).toHaveLength(2);
      expect(Buffer.concat(f.host.audioFrames)).toEqual(PREAMBLE);
      f.conn.finishResponse(
        f.receiptResponses.get('silent-proactive')!.responseId,
      );
      await waitForLiveLogEvents(
        f.dataDir,
        (event) =>
          event.type === 'response.done' &&
          event.payload['responseId'] ===
            f.receiptResponses.get('silent-proactive')?.responseId,
      );
      const worker = await f.connectionFor(
        (session) =>
          Array.isArray(session['modalities']) &&
          session['modalities'].includes('audio') &&
          session['turn_detection'] === null,
      );
      const update = worker.inbox.find(
        (message) => message['type'] === 'session.update',
      )!;
      expect(worker.model).toBe(f.conn.model);
      expect(worker.authorization).toBe(f.conn.authorization);
      expect(update).toMatchObject({
        session: {
          voice: 'Tina',
          tools: [],
          tool_choice: 'none',
          smooth_output: false,
          turn_detection: null,
          audio: { output: { format: { type: 'pcm', sample_rate: 24000 } } },
        },
      });
      expect(f.fakeDash.inbox.indexOf(update)).toBeGreaterThan(
        f.fakeDash.inbox.indexOf(
          f.receiptResponses.get('silent-proactive')!.request,
        ),
      );
      await f.fakeDash.waitForMessage(
        (message) =>
          worker.inbox.includes(message) &&
          message['type'] === 'response.create',
      );
      expect(
        worker.inbox.filter((message) => message['type'] === 'response.create'),
      ).toEqual([
        expect.not.objectContaining({
          response: expect.objectContaining({
            instructions: expect.anything(),
          }),
        }),
      ]);
      const summaryMessage = worker.inbox.map(contextTextOf).find(Boolean)!;
      expect(summaryMessage).toContain('检测到敲桌子');
      expect(summaryMessage).not.toContain('听到清晰的敲桌子声');
      await expect
        .poll(async () => (await f.task())?.notification)
        .toBe('preparing');
      expect(Buffer.concat(f.host.audioFrames)).toEqual(PREAMBLE);

      if (outcome === 'failed') {
        worker.send({
          type: 'error',
          error: { message: 'Synthetic speech failure' },
        });
        await expect
          .poll(async () => (await f.task())?.notification)
          .toBe('undelivered');
        expect(await f.task()).toMatchObject({
          status: 'completed',
          notification: 'undelivered',
          triggerCount: 1,
        });
        expect(Buffer.concat(f.host.audioFrames)).toEqual(PREAMBLE);
      } else {
        const responseId = worker.beginResponse();
        worker.send({
          type: 'response.audio.delta',
          response_id: responseId,
          delta: FALLBACK_AUDIO.toString('base64'),
        });
        worker.send({
          type: 'response.audio_transcript.done',
          response_id: responseId,
          transcript: '检测到敲桌子。',
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(Buffer.concat(f.host.audioFrames)).toEqual(PREAMBLE);
        expect((await f.task())?.notification).toBe('preparing');
        worker.send({ type: 'response.audio.done', response_id: responseId });
        worker.finishResponse(responseId);
        await expect
          .poll(async () => (await f.task())?.notification)
          .toBe('speaking');
        expect(Buffer.concat(f.host.audioFrames)).toEqual(
          Buffer.concat([PREAMBLE, FALLBACK_AUDIO]),
        );
        expect((await f.task())?.notification).not.toBe('delivered');
        const marker = [...f.host.messages]
          .reverse()
          .find((message) => message['type'] === 'host.output_audio_finished')!;
        f.host.completePlayback(
          Number(marker['epoch']),
          Number(marker['outputId']),
        );
        await expect
          .poll(async () => (await f.task())?.notification)
          .toBe('delivered');
        expect(await f.task()).toMatchObject({
          status: 'completed',
          notification: 'delivered',
          triggerCount: 1,
        });
      }
      expect(f.fakeDash.connections).toHaveLength(3);
      expect(
        f.conn.inbox.filter((message) =>
          contextTextOf(message)?.startsWith('[PROACTIVE_EVENT]'),
        ),
      ).toHaveLength(1);
      expect(f.live.proc.exitCode).toBeNull();
    },
  );
});
