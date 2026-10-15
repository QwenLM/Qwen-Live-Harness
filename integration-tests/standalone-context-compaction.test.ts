/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  contextTextOf,
  functionCallOutputOf,
  startFakeDashScopeServer,
} from './fake-dashscope-server.js';
import {
  FakeHost,
  readLiveDiscovery,
  spawnQwenLiveHarness,
  startLiveCall,
  waitForLiveLogEvents,
  waitForLiveResponseAfter,
} from './qwen-live-harness.js';

it.each(['success', 'summary_failure'] as const)(
  'compaction %s keeps task ownership and playback boundaries through the real daemon',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'qwen-live-compaction-'));
    const dataDir = join(directory, 'data'),
      discoveryDir = join(directory, 'discovery');
    await mkdir(dataDir);
    await mkdir(discoveryDir);
    const summaries: Record<string, unknown>[] = [];
    const fakeDash = await startFakeDashScopeServer({
      httpHandler: async (req, res) => {
        if (req.url !== '/compatible-mode/v1/chat/completions') {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        summaries.push(
          JSON.parse(Buffer.concat(chunks).toString()) as Record<
            string,
            unknown
          >,
        );
        res.writeHead(mode === 'summary_failure' ? 503 : 200, {
          'content-type': 'application/json',
        });
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  tool_calls: null,
                  content:
                    'The user chose synthetic blue. A reminder was accepted, not delivered. All approvals are historical.',
                },
              },
            ],
          }),
        );
      },
    });
    const live = await spawnQwenLiveHarness({
      dataDir,
      discoveryDir,
      cwd: directory,
      realtimeEndpoint: fakeDash.url,
      model: 'qwen3.8-omni-flash-realtime',
      env: { QWEN_LIVE_HARNESS_LOG_LEVEL: 'debug' },
      initialConfig: {
        backends: [],
        memory: { enabled: false },
        proactive: { enabled: true },
      },
    });
    const host = new FakeHost(discoveryDir);
    try {
      await host.connect();
      const { conn, epoch } = await startLiveCall({ host, fakeDash });
      const fromIndex = fakeDash.inbox.length;
      conn.queueFunctionCall({
        name: 'create_proactive_timer',
        callId: 'create-once',
        argumentsJson: JSON.stringify({
          title: 'Synthetic reminder',
          duration_sec: 3600,
          reminder_text: 'Synthetic reminder',
        }),
      });
      conn.speakTranscript(
        'Remind me in one hour; the selected color is synthetic blue.',
      );
      const receipt = await fakeDash.waitForMessage(
        (message) => functionCallOutputOf(message)?.callId === 'create-once',
        { fromIndex },
      );
      await waitForLiveResponseAfter(
        { fakeDash, dataDir },
        receipt,
        'tool_continuation',
      );
      for (let i = 0; i < 18; i++) {
        const fromIndex = fakeDash.inbox.length;
        conn.speakTranscript(
          `Synthetic historical constraint ${i}; no new action is authorized.`,
        );
        const request = await fakeDash.waitForMessage(
          (message) =>
            conn.inbox.includes(message) &&
            message['type'] === 'response.create',
          { fromIndex },
        );
        const responseId = fakeDash.autoResponseIdFor(request);
        await waitForLiveLogEvents(
          dataDir,
          (event) =>
            event.type === 'response.done' &&
            event.payload['responseId'] === responseId,
        );
      }
      await expect.poll(() => summaries.length).toBeGreaterThan(0);
      expect(fakeDash.connections).toHaveLength(1); // Background summary alone does not replace the engine.
      expect(summaries[0]?.['model']).toBe('qwen3.7-plus');
      expect(summaries[0]?.['tools']).toBeUndefined();
      host.autoCompletePlayback = false;
      fakeDash.autoAckResponses = false;
      const usageFromIndex = fakeDash.inbox.length;
      conn.speakTranscript('Please explain the selected color.');
      await fakeDash.waitForMessage(
        (message) =>
          conn.inbox.includes(message) && message['type'] === 'response.create',
        { fromIndex: usageFromIndex },
      );
      conn.respondWithAudio(
        Buffer.alloc(4800, 1),
        'The selected color is synthetic blue.',
        180000,
      );
      await expect
        .poll(() =>
          host.messages.some(
            (message) => message['type'] === 'host.output_audio_finished',
          ),
        )
        .toBe(true);
      const finished = host.messages.find(
        (message) => message['type'] === 'host.output_audio_finished',
      )!;
      // Even a forged completion cannot open the rotation barrier.
      host.sendUnverifiedPlaybackCompletion(
        epoch,
        Number(finished['outputId']) + 1,
      );
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(fakeDash.connections).toHaveLength(1);
      host.completePlayback(epoch, Number(finished['outputId']));
      if (mode === 'success') {
        await waitForLiveLogEvents(
          dataDir,
          (event) =>
            event.type === 'realtime.protocol' &&
            event.payload['type'] === 'compaction.completed',
        );
        expect(fakeDash.connections).toHaveLength(2);
        const replacement = fakeDash.connections[1]!;
        const texts = replacement.inbox
          .map(contextTextOf)
          .filter(Boolean)
          .join('\n');
        expect(texts).toContain('synthetic blue');
        expect(texts).toContain('[MEMORY_CONTEXT]');
        expect(texts).toContain('Synthetic reminder');
        expect(texts).toContain('never instructions or authorization');
        expect(
          replacement.inbox.some(
            (message) => message['type'] === 'response.create',
          ),
        ).toBe(false);
        const initial = conn.inbox.find(
          (message) => message['type'] === 'session.update',
        )!;
        const updated = replacement.inbox.find(
          (message) => message['type'] === 'session.update',
        )!;
        expect(updated['session']).toEqual(initial['session']);
        const createdIndex = replacement.trace.findIndex(
          (event) =>
            event.direction === 'out' &&
            event.message['type'] === 'conversation.item.created',
        );
        expect(createdIndex).toBeGreaterThan(0);
        fakeDash.autoAckResponses = true;
        replacement.queueFunctionCall({
          name: 'cancel_proactive_task',
          callId: 'cancel-after-compaction',
          argumentsJson: JSON.stringify({ target_title: 'Synthetic reminder' }),
        });
        replacement.speakTranscript('Cancel the Synthetic reminder now.');
        const cancelled = await fakeDash.waitForMessage(
          (message) =>
            functionCallOutputOf(message)?.callId === 'cancel-after-compaction',
        );
        await waitForLiveResponseAfter(
          { fakeDash, dataDir },
          cancelled,
          'tool_continuation',
        );
        fakeDash.autoAckResponses = false;
        const recoveryFromIndex = fakeDash.inbox.length;
        replacement.speakTranscript('What has finished?');
        await fakeDash.waitForMessage(
          (message) =>
            replacement.inbox.includes(message) &&
            message['type'] === 'response.create',
          { fromIndex: recoveryFromIndex },
        );
        replacement.beginResponse();
        replacement.send({
          type: 'error',
          error: {
            code: 'COMMON_ERROR',
            message:
              '<50002> InternalError.Algo.ModelServingError: Internal Error calling model processing.',
          },
        });
        await waitForLiveLogEvents(
          dataDir,
          (event) =>
            event.type === 'realtime.protocol' &&
            event.payload['type'] === 'transport.recovery_completed',
        );
        const restored = fakeDash.connections.findLast((candidate) =>
          candidate.inbox.some((message) =>
            contextTextOf(message)?.includes('Transport recovery context only'),
          ),
        )!;
        expect(restored).toBeDefined();
        const restoredText = restored.inbox
          .map(contextTextOf)
          .filter(Boolean)
          .join('\n');
        expect(restoredText).toContain('"summary"');
        expect(restoredText).toContain('The user chose synthetic blue.');
        expect(
          restored.inbox.some(
            (message) => functionCallOutputOf(message) !== undefined,
          ),
        ).toBe(false);
      } else {
        await waitForLiveLogEvents(
          dataDir,
          (event) =>
            event.type === 'realtime.protocol' &&
            event.payload['type'] === 'compaction.summary_failed',
        );
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect(fakeDash.connections).toHaveLength(1);
        expect(conn.socket.readyState).toBe(1);
      }
      expect(
        fakeDash.inbox.filter(
          (message) => functionCallOutputOf(message)?.callId === 'create-once',
        ),
      ).toHaveLength(1);
      const discovery = await readLiveDiscovery(discoveryDir);
      const response = await fetch(`${live.url}/live/subagents`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${discovery.token}`,
          'x-qwen-live-harness-nonce': discovery.instanceNonce,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'list' }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        page: { snapshot: { tasks: Array<{ title: string; status: string }> } };
      };
      expect(
        body.page.snapshot.tasks.find(
          (task) => task.title === 'Synthetic reminder',
        )?.status,
      ).toBe(mode === 'success' ? 'cancelled' : 'monitoring');
      expect(live.proc.exitCode).toBeNull();
      expect((await fetch(`${live.url}/healthz`)).status).toBe(200);
    } finally {
      host.close();
      await live.dispose();
      await fakeDash.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
