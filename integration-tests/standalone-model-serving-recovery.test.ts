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
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import {
  FakeHost,
  readLiveDiscovery,
  readLiveLogEvents,
  spawnQwenLiveHarness,
  startLiveCall,
  waitForLiveLogEvents,
} from './qwen-live-harness.js';

type Task = { id: string; title: string; kind: string; status: string };

it('recovers a model-serving failure after monitor admission without ending the call or replaying work and media', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'qwen-live-model-serving-recovery-'),
  );
  const dataDir = join(directory, 'data');
  const discoveryDir = join(directory, 'discovery');
  await mkdir(dataDir);
  await mkdir(discoveryDir);
  const fakeDash = await startFakeDashScopeServer();
  // The creating response is scripted separately; hold its receipt response
  // open so the provider error lands on tool_continuation, as in the incident.
  fakeDash.autoAckResponses = false;
  const live = await spawnQwenLiveHarness({
    dataDir,
    discoveryDir,
    cwd: directory,
    realtimeEndpoint: fakeDash.url,
    env: { PATH: '', QWEN_LIVE_HARNESS_LOG_LEVEL: 'debug' },
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
    const discovery = await readLiveDiscovery(discoveryDir);
    const tasks = async (): Promise<Task[]> => {
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
      const result = (await response.json()) as {
        page: { snapshot: { tasks: Task[] } };
      };
      return result.page.snapshot.tasks.map(({ id, title, kind, status }) => ({
        id,
        title,
        kind,
        status,
      }));
    };
    const isMainConnection = (candidate: FakeDashScopeConnection) =>
      candidate.inbox.some((message) => {
        if (message['type'] !== 'session.update') return false;
        const session = message['session'] as Record<string, unknown>;
        return Array.isArray(session['tools']) && session['tools'].length > 0;
      });

    // Only synthetic media enters the real daemon. Seed one image before the
    // task request so recovery must not replay it onto the replacement main
    // connection. No real camera or screen is opened by this fake Host.
    host.setVisualInput(epoch, 'camera', 'live-feed');
    await fakeDash.waitForMessage(
      (message) =>
        conn.inbox.includes(message) &&
        (contextTextOf(message)?.includes('source=camera mode=live-feed') ??
          false),
    );
    host.sendAudio(epoch, Buffer.alloc(3200, 1));
    await fakeDash.waitForMessage(
      (message) =>
        conn.inbox.includes(message) &&
        message['type'] === 'input_audio_buffer.append',
    );
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    host.sendCameraFrame(epoch, image);
    const imageInput = await fakeDash.waitForMessage(
      (message) =>
        conn.inbox.includes(message) &&
        message['type'] === 'input_image_buffer.append',
    );
    expect(imageInput['image']).toBe(image);

    const title = 'Synthetic portal monitor';
    const callId = 'create-synthetic-portal-monitor';
    conn.queueFunctionCall({
      name: 'create_proactive_monitor',
      callId,
      argumentsJson: JSON.stringify({
        title,
        modalities: ['vision'],
        condition: 'The synthetic portal is visible in the camera view.',
        trigger_response: 'Remind the user to take a break.',
        repeat: false,
      }),
    });
    conn.speakTranscript(
      'When you see the synthetic portal in my camera view, remind me to take a break.',
    );
    const receipt = await fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === callId,
    );
    await fakeDash.waitForMessage(
      (message) =>
        conn.inbox.includes(message) && message['type'] === 'response.create',
      { fromIndex: fakeDash.inbox.indexOf(receipt) + 1 },
    );
    await expect
      .poll(async () => (await tasks()).find((task) => task.title === title))
      .toMatchObject({ kind: 'proactive', title, status: 'monitoring' });
    const originalTask = (await tasks()).find((task) => task.title === title)!;
    expect((await tasks()).filter((task) => task.kind === 'proactive')).toEqual(
      [originalTask],
    );
    expect(fakeDash.connections).toHaveLength(2);
    const monitor = fakeDash.connections.find(
      (candidate) => candidate !== conn,
    )!;
    expect(monitor.socket.readyState).toBe(monitor.socket.OPEN);
    const responseId = conn.beginResponse();
    await waitForLiveLogEvents(
      dataDir,
      (event) =>
        event.type === 'response.created' &&
        event.payload['responseId'] === responseId &&
        event.payload['authority'] === 'tool_continuation',
    );

    const hostStateIndex = host.states.length;
    const errorMessage =
      '<50002> InternalError.Algo.ModelServingError: Internal Error calling model processing.';
    conn.send({
      type: 'error',
      error: { code: 'COMMON_ERROR', message: errorMessage },
    });
    // The real provider also closed this connection with 1011. The following
    // close must not turn a single recovery into a second attempt or a hangup.
    conn.socket.close(1011, errorMessage);
    await waitForLiveLogEvents(
      dataDir,
      (event) =>
        event.type === 'realtime.protocol' &&
        event.payload['type'] === 'transport.recovery_completed',
      { timeoutMs: 12000 },
    );
    const mainConnections = fakeDash.connections.filter(isMainConnection);
    expect(mainConnections).toHaveLength(2);
    expect(fakeDash.connections).toHaveLength(3);
    const replacement = mainConnections.find(
      (candidate) => candidate !== conn,
    )!;
    expect(replacement.socket.readyState).toBe(replacement.socket.OPEN);
    expect(monitor.socket.readyState).toBe(monitor.socket.OPEN);
    expect((await tasks()).filter((task) => task.kind === 'proactive')).toEqual(
      [originalTask],
    );

    const fromIndex = fakeDash.inbox.length;
    replacement.speakTranscript('Please say hello.');
    await fakeDash.waitForMessage(
      (message) =>
        replacement.inbox.includes(message) &&
        message['type'] === 'response.create',
      { fromIndex },
    );
    const answer = Buffer.alloc(4800, 6);
    const audioIndex = host.audioFrames.length;
    const answerId = replacement.respondWithAudio(answer, 'Hello.');
    expect(await host.waitForAudioFrame({ fromIndex: audioIndex })).toEqual(
      answer,
    );
    await waitForLiveLogEvents(
      dataDir,
      (event) =>
        event.type === 'response.done' &&
        event.payload['responseId'] === answerId &&
        event.payload['authority'] === 'direct' &&
        event.payload['status'] === 'completed',
    );

    const events = await readLiveLogEvents(dataDir);
    expect(
      events.filter(
        (event) =>
          event.type === 'tool.call' &&
          event.payload['name'] === 'create_proactive_monitor',
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === 'proactive.debug' &&
          event.payload['event'] === 'proactive.task_state' &&
          event.payload['status'] === 'provisioning',
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === 'session.end' ||
          event.type === 'call.ended' ||
          (event.type === 'failure' &&
            (event.payload['code'] === 'call_failed' ||
              event.payload['fatal'] === true)),
      ),
    ).toEqual([]);
    expect(
      host.states
        .slice(hostStateIndex)
        .some((entry) =>
          ['idle', 'stopping', 'error'].includes(String(entry.status['state'])),
        ),
    ).toBe(false);
    expect(
      fakeDash.inbox.filter(
        (message) => functionCallOutputOf(message)?.callId === callId,
      ),
    ).toHaveLength(1);
    expect(
      replacement.inbox.some((message) => functionCallOutputOf(message)),
    ).toBe(false);
    expect(
      conn.inbox.filter(
        (message) => message['type'] === 'input_image_buffer.append',
      ),
    ).toHaveLength(1);
    expect(
      replacement.inbox.filter(
        (message) => message['type'] === 'input_image_buffer.append',
      ),
    ).toEqual([]);
    expect(fakeDash.connections).toHaveLength(3);
    expect(monitor.socket.readyState).toBe(monitor.socket.OPEN);
    expect((await tasks()).filter((task) => task.kind === 'proactive')).toEqual(
      [originalTask],
    );
    expect(live.proc.exitCode).toBeNull();
    expect((await fetch(`${live.url}/healthz`)).status).toBe(200);
  } finally {
    host.close();
    await live.dispose();
    await fakeDash.close();
    await rm(directory, { recursive: true, force: true });
  }
});
