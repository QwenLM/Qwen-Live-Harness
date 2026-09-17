/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  contextTextOf,
  functionCallOutputOf,
  permissionPayloadOf,
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

it.each(['permission', 'direct'] as const)(
  'recovers an interrupted unacknowledged %s request and still executes the newer stop once',
  async (authority) => {
    const directory = await mkdtemp(
      join(tmpdir(), 'qwen-live-response-recovery-'),
    );
    const dataDir = join(directory, 'data');
    const discoveryDir = join(directory, 'discovery');
    await mkdir(dataDir);
    await mkdir(discoveryDir);
    const fakeDash = await startFakeDashScopeServer();
    const agent = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../packages/qwen-live-harness/test-fixtures/fake-acp-agent.mjs',
    );
    const live = await spawnQwenLiveHarness({
      dataDir,
      discoveryDir,
      cwd: directory,
      realtimeEndpoint: fakeDash.url,
      env: { QWEN_LIVE_HARNESS_LOG_LEVEL: 'debug' },
      initialConfig: {
        backends:
          authority === 'permission'
            ? [
                {
                  name: 'synthetic',
                  kind: 'acp',
                  command: process.execPath,
                  args: [agent],
                  cwd: directory,
                  default: true,
                },
              ]
            : [],
        memory: { enabled: false },
        proactive: { enabled: true },
      },
    });
    const host = new FakeHost(discoveryDir);
    try {
      await host.connect();
      const { conn } = await startLiveCall({ host, fakeDash });
      const invoke = async (
        name: string,
        args: Record<string, unknown>,
        callId: string,
      ) => {
        const fromIndex = fakeDash.inbox.length;
        conn.queueFunctionCall({
          name,
          argumentsJson: JSON.stringify(args),
          callId,
        });
        conn.speakTranscript(`Please run ${name}.`);
        return fakeDash.waitForMessage(
          (message) => functionCallOutputOf(message)?.callId === callId,
          { fromIndex },
        );
      };
      const created = await invoke(
        'create_proactive_timer',
        {
          title: 'Synthetic reminder',
          duration_sec: 3600,
          reminder_text: 'Synthetic reminder',
        },
        'create-reminder',
      );
      await waitForLiveResponseAfter(
        { fakeDash, dataDir },
        created,
        'tool_continuation',
      );

      const discovery = await readLiveDiscovery(discoveryDir);
      const page = async () => {
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
          page: {
            snapshot: {
              tasks: Array<{ title: string; status: string; kind: string }>;
            };
          };
        };
        return body.page;
      };
      fakeDash.autoAckResponses = false;
      let fromIndex = fakeDash.inbox.length;
      if (authority === 'permission') {
        await invoke(
          'handoff',
          { task: 'permission: keep this unrelated background task waiting' },
          'waiting-backend',
        );
        const permission = await fakeDash.waitForMessage(
          (message) => permissionPayloadOf(message)?.request_id === 'req_1',
          { fromIndex },
        );
        fromIndex = fakeDash.inbox.indexOf(permission) + 1;
      } else {
        conn.speakTranscript('Tell me about the reminder.');
      }
      await fakeDash.waitForMessage(
        (message) => message['type'] === 'response.create',
        { fromIndex },
      );
      const stop = 'Please stop the Synthetic reminder.';
      conn.speakTranscript(stop);
      await expect
        .poll(() => fakeDash.connections.length, { timeout: 12000 })
        .toBe(2);
      const replacement = fakeDash.connections[1]!;
      const replay = await fakeDash.waitForMessage(
        (message) =>
          replacement.inbox.includes(message) &&
          contextTextOf(message) === stop,
      );
      await fakeDash.waitForMessage(
        (message) =>
          replacement.inbox.includes(message) &&
          message['type'] === 'response.create',
        { fromIndex: fakeDash.inbox.indexOf(replay) + 1 },
      );
      expect(
        (await page()).snapshot.tasks.find(
          (task) => task.title === 'Synthetic reminder',
        )?.status,
      ).toBe('monitoring');
      if (authority === 'permission') {
        expect(
          replacement.inbox.some((message) =>
            contextTextOf(message)?.includes('req_1'),
          ),
        ).toBe(true);
        expect(
          (await page()).snapshot.tasks.some(
            (task) => task.kind === 'harness' && task.status === 'waiting',
          ),
        ).toBe(true);
      }
      fakeDash.autoAckResponses = true;
      replacement.functionCall({
        name: 'cancel_proactive_task',
        callId: 'stop-after-recovery',
        argumentsJson: JSON.stringify({ target_title: 'Synthetic reminder' }),
      });
      await fakeDash.waitForMessage(
        (message) =>
          functionCallOutputOf(message)?.callId === 'stop-after-recovery',
      );
      await expect
        .poll(
          async () =>
            (await page()).snapshot.tasks.find(
              (task) => task.title === 'Synthetic reminder',
            )?.status,
        )
        .toBe('cancelled');
      expect(
        fakeDash.inbox.filter(
          (message) =>
            functionCallOutputOf(message)?.callId === 'stop-after-recovery',
        ),
      ).toHaveLength(1);
      await waitForLiveLogEvents(
        dataDir,
        (event) =>
          event.type === 'realtime.protocol' &&
          event.payload['type'] === 'transport.recovery_completed',
      );
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
