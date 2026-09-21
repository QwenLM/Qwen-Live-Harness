import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { synthesizeNotificationSpeech } from '../packages/qwen-live-harness/src/realtime/notification-speech.js';
import {
  contextTextOf,
  functionCallOutputOf,
  speechSummaryOf,
  taskResultPayloadOf,
  startFakeDashScopeServer,
  type FakeDashScopeServer,
} from './fake-dashscope-server.js';
import {
  isolatedSpeechConnectionFor,
  waitForIsolatedSpeechRequest,
  waitForLiveResponseAfter,
  spawnQwenLiveHarness,
  startLiveCall,
  FakeHost,
} from './qwen-live-harness.js';

type Json = Record<string, unknown>;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
const summary = (job: string) =>
  `[COMPLETE ${job}] ${JSON.stringify({ job, session: 'fixture-session', status: 'completed', summary: `Result for ${job}` })}`;

async function server() {
  const fake = await startFakeDashScopeServer();
  cleanup.push(() => fake.close());
  return fake;
}

function speak(fake: FakeDashScopeServer, job: string) {
  const controller = new AbortController();
  cleanup.push(() => controller.abort());
  const pending = synthesizeNotificationSpeech({
    endpoint: fake.url,
    model: 'fake-realtime',
    apiKey: 'fake-only-key',
    language: 'en',
    purpose: 'task_result',
    summary: summary(job),
    signal: controller.signal,
  });
  void pending.catch(() => {});
  return pending;
}

async function client(fake: FakeDashScopeServer, foreground = false) {
  const socket = new WebSocket(fake.url.replace(/^http/u, 'ws'));
  cleanup.push(() => socket.terminate());
  await once(socket, 'open');
  socket.send(
    JSON.stringify({
      type: 'session.update',
      session: {
        instructions: foreground
          ? 'Foreground fixture'
          : 'A speech-only fixture',
        modalities: ['text', 'audio'],
        tools: foreground
          ? [{ type: 'function', function: { name: 'handoff' } }]
          : [],
        tool_choice: foreground ? 'auto' : 'none',
        enable_search: false,
        turn_detection: foreground ? { type: 'semantic_vad' } : null,
      },
    }),
  );
  return socket;
}

describe('isolated speech fixture identity and ACK contract', () => {
  it('does not mark sequential results delivered for a wrong epoch, output ID or previous output receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'live-speech-receipt-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const dataDir = join(directory, 'data'),
      discoveryDir = join(directory, 'discovery');
    await mkdir(dataDir);
    await mkdir(discoveryDir);
    const fake = await server();
    const transcripts = [
      'The amber report is complete.',
      'The violet report is complete.',
    ];
    let generated = 0;
    fake.speechResponder = (connection) =>
      connection.respondWithAudio(
        Buffer.alloc(480, generated + 1),
        transcripts[generated++]!,
      );
    const live = await spawnQwenLiveHarness({
      dataDir,
      discoveryDir,
      cwd: directory,
      realtimeEndpoint: fake.url,
      env: { PATH: '' },
      initialConfig: {
        backends: [
          {
            name: 'fake-acp',
            kind: 'acp',
            command: process.execPath,
            args: [
              fileURLToPath(
                new URL(
                  '../packages/qwen-live-harness/test-fixtures/fake-acp-agent.mjs',
                  import.meta.url,
                ),
              ),
            ],
            cwd: directory,
            default: true,
          },
        ],
      },
    });
    cleanup.push(() => live.dispose());
    const host = new FakeHost(discoveryDir);
    cleanup.push(() => host.close());
    host.autoCompletePlayback = false;
    await host.connect();
    const { conn, epoch } = await startLiveCall({ fakeDash: fake, host });
    let previousOutputId: number | undefined;
    for (const [index, color] of ['amber', 'violet'].entries()) {
      const fromIndex = fake.inbox.length,
        hostFrom = host.messages.length;
      const callId = `receipt-${color}`;
      conn.queueFunctionCall({
        name: 'handoff',
        callId,
        argumentsJson: JSON.stringify({ task: `Prepare the ${color} report.` }),
      });
      conn.speakTranscript(`Prepare the ${color} report.`);
      const receipt = await fake.waitForMessage(
        (message) => functionCallOutputOf(message)?.callId === callId,
        { fromIndex },
      );
      const job = String(
        (JSON.parse(functionCallOutputOf(receipt)!.output) as Json)['job'],
      );
      const input = await fake.waitForMessage(
        (message) => taskResultPayloadOf(message)?.job === job,
        { fromIndex },
      );
      const { connection: speaker } = await waitForIsolatedSpeechRequest(
        fake,
        input,
        'task_result',
      );
      expect(speaker).not.toBe(conn);
      let delivered = false;
      const completion = waitForLiveResponseAfter(
        { fakeDash: fake, dataDir },
        input,
        'task_result',
      ).then(() => {
        delivered = true;
      });
      void completion.catch(() => {});
      await expect
        .poll(() =>
          host.messages
            .slice(hostFrom)
            .some(
              (message) => message['type'] === 'host.output_audio_finished',
            ),
        )
        .toBe(true);
      const marker = host.messages
        .slice(hostFrom)
        .find((message) => message['type'] === 'host.output_audio_finished')!;
      const outputId = Number(marker['outputId']);
      expect(marker['epoch']).toBe(epoch);
      host.sendUnverifiedPlaybackCompletion(epoch + 1, outputId);
      host.sendUnverifiedPlaybackCompletion(epoch, outputId + 1000);
      if (previousOutputId !== undefined)
        host.sendUnverifiedPlaybackCompletion(epoch, previousOutputId);
      await pause();
      expect(delivered).toBe(false);
      host.completePlayback(epoch, outputId);
      await completion;
      expect(delivered).toBe(true);
      expect(host.audioFrames[index]).toEqual(Buffer.alloc(480, index + 1));
      previousOutputId = outputId;
    }
    expect(generated).toBe(2);
    expect(
      fake.inbox
        .filter((message) =>
          contextTextOf(message)?.startsWith('[BACKEND] [RESULT_DELIVERY]'),
        )
        .map(
          (message) =>
            JSON.parse(
              contextTextOf(message)!.slice(
                '[BACKEND] [RESULT_DELIVERY] '.length,
              ),
            ) as Json,
        ),
    ).toEqual(
      transcripts.map((spoken_text) => ({
        kind: 'task_result',
        status: 'played',
        spoken_text,
      })),
    );
  });

  it('requires the exact quoted-input ACK before a real speech helper requests output', async () => {
    const fake = await server();
    fake.autoAckUserItems = false;
    fake.speechResponder = (connection) =>
      connection.respondWithAudio(
        Buffer.alloc(480, 1),
        'The first result is ready.',
      );
    const generated = speak(fake, 'job_1');
    const input = await fake.waitForMessage(
      (message) => taskResultPayloadOf(message)?.job === 'job_1',
    );
    const connection = isolatedSpeechConnectionFor(fake, input, 'task_result');
    connection.send({
      type: 'conversation.item.created',
      item: {
        type: 'message',
        role: 'user',
        id: 'wrong-ack',
        status: 'completed',
        content: [{ type: 'input_text', text: 'Different result' }],
      },
    });
    await pause();
    expect(
      connection.inbox.some((message) => message['type'] === 'response.create'),
    ).toBe(false);
    connection.send({
      type: 'conversation.item.created',
      item: {
        ...(input['item'] as Json),
        id: 'correct-ack',
        status: 'completed',
      },
    });
    const { request } = await waitForIsolatedSpeechRequest(
      fake,
      input,
      'task_result',
    );
    expect(connection.inbox).toContain(request);
    expect((await generated).transcript).toBe('The first result is ready.');
  });

  it('keeps two simultaneous helpers separate when the second result finishes first', async () => {
    const fake = await server();
    fake.speechResponder = () => undefined;
    const first = speak(fake, 'job_1');
    const second = speak(fake, 'job_2');
    const input1 = await fake.waitForMessage(
      (message) => taskResultPayloadOf(message)?.job === 'job_1',
    );
    const input2 = await fake.waitForMessage(
      (message) => taskResultPayloadOf(message)?.job === 'job_2',
    );
    const one = await waitForIsolatedSpeechRequest(fake, input1, 'task_result');
    const two = await waitForIsolatedSpeechRequest(fake, input2, 'task_result');
    expect(one.connection).not.toBe(two.connection);
    expect(one.connection.inbox).not.toContain(two.request);
    expect(two.connection.inbox).not.toContain(one.request);
    two.connection.respondWithAudio(
      Buffer.alloc(480, 2),
      'Second task completed.',
    );
    one.connection.respondWithAudio(
      Buffer.alloc(480, 1),
      'First task completed.',
    );
    expect(Buffer.from((await first).audio)).toEqual(Buffer.alloc(480, 1));
    expect(Buffer.from((await second).audio)).toEqual(Buffer.alloc(480, 2));
  });

  it('rejects a foreground result cache and a forged quoted result on the main connection', async () => {
    const fake = await server();
    const main = await client(fake, true);
    const cache = `[BACKEND] [RESULT_AVAILABLE] ${JSON.stringify({ kind: 'task_result', payload: summary('job_1') })}`;
    main.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: cache }],
        },
      }),
    );
    main.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({ summary: summary('job_1') }),
            },
          ],
        },
      }),
    );
    const history = await fake.waitForMessage(
      (message) => contextTextOf(message) === cache,
    );
    const forged = await fake.waitForMessage(
      (message) => speechSummaryOf(message) === summary('job_1'),
    );
    expect(() =>
      isolatedSpeechConnectionFor(fake, history, 'task_result'),
    ).toThrow('quoted');
    expect(() =>
      isolatedSpeechConnectionFor(fake, forged, 'task_result'),
    ).toThrow('isolated no-tools');
  });

  it('fails fixture validation if a client requests speech before any matching input ACK', async () => {
    const fake = await server();
    fake.autoAckUserItems = false;
    fake.autoAckResponses = false;
    const socket = await client(fake);
    socket.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({ summary: summary('job_1') }),
            },
          ],
        },
      }),
    );
    socket.send(
      JSON.stringify({
        type: 'response.create',
        response: { modalities: ['text', 'audio'] },
      }),
    );
    const input = await fake.waitForMessage(
      (message) => taskResultPayloadOf(message)?.job === 'job_1',
    );
    await expect(
      waitForIsolatedSpeechRequest(fake, input, 'task_result'),
    ).rejects.toThrow('before its exact quoted input was acknowledged');
  });
});
