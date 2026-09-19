/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contextTextOf,
  functionCallOutputOf,
  notificationOf,
  startFakeDashScopeServer,
  type FakeDashScopeConnection,
  type FakeDashScopeServer,
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

describe('standalone Omni without any coding backend', () => {
  let directory: string;
  let dataDir: string;
  let discoveryDir: string;
  let live: SpawnedQwenLiveHarness;
  let fakeDash: FakeDashScopeServer;
  let host: FakeHost;
  let conn: FakeDashScopeConnection;
  let epoch: number;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'qwen-live-harness-no-backend-'));
    dataDir = join(directory, 'data');
    discoveryDir = join(directory, 'discovery');
    await mkdir(dataDir);
    await mkdir(discoveryDir);
    fakeDash = await startFakeDashScopeServer({
      autoAckAudioCommits: true,
      visualAnalysisReply: 'The synthetic snapshot contains a blue region.',
    });
    live = await spawnQwenLiveHarness({
      dataDir,
      discoveryDir,
      cwd: directory,
      realtimeEndpoint: fakeDash.url,
      // This process cannot discover or invoke an installed agent or runner.
      env: { PATH: '' },
      initialConfig: {
        backends: [],
        memory: {
          enabled: true,
          updater: { enabled: false },
          observer: { enabled: false },
          retrieve: { useVector: false },
        },
        proactive: { enabled: true },
      },
    });
    host = new FakeHost(discoveryDir);
    await host.connect();
    ({ conn, epoch } = await startLiveCall({ host, fakeDash }));
  });

  afterAll(async () => {
    host?.close();
    await live?.dispose();
    await fakeDash?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function tool(name: string, args: Json, callId: string) {
    const fromIndex = fakeDash.inbox.length;
    conn.queueFunctionCall({
      name,
      argumentsJson: JSON.stringify(args),
      callId,
    });
    conn.speakTranscript(`Please run ${name}.`);
    const message = await fakeDash.waitForMessage(
      (value) => functionCallOutputOf(value)?.callId === callId,
      { fromIndex },
    );
    const output = functionCallOutputOf(message)!.output;
    await responseAfter(message, 'tool_continuation');
    return output;
  }

  async function responseAfter(
    anchor: Json,
    authority: 'tool_continuation' | 'visual_result',
  ) {
    // Independent image workers also send response.create. Match the main
    // connection rather than letting their request satisfy this turn's wait.
    const request = await fakeDash.waitForMessage(
      (message) =>
        conn.inbox.includes(message) && message['type'] === 'response.create',
      { fromIndex: fakeDash.inbox.indexOf(anchor) + 1 },
    );
    const responseId = fakeDash.autoResponseIdFor(request);
    expect(responseId).toBeDefined();
    await waitForLiveLogEvents(
      dataDir,
      (event) =>
        event.type === 'response.done' &&
        event.payload['responseId'] === responseId &&
        event.payload['authority'] === authority &&
        event.payload['status'] === 'completed',
    );
  }

  async function subagents(action: Json = { action: 'list' }): Promise<Json> {
    const record = await readLiveDiscovery(discoveryDir);
    const response = await fetch(`${live.url}/live/subagents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${record.token}`,
        'x-qwen-live-harness-nonce': record.instanceNonce,
      },
      body: JSON.stringify(action),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Json;
  }

  it('starts from backends: [] with no PATH and advertises independent capabilities', () => {
    const session = fakeDash.inbox.find(
      (value) => value['type'] === 'session.update',
    )?.['session'] as Json;
    const names = (
      session['tools'] as Array<{ function: { name: string } }>
    ).map((value) => value.function.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'appshot',
        'create_proactive_monitor',
        'create_proactive_timer',
        'omnibio',
        'omniretrieve',
      ]),
    );
    expect(String(session['instructions'])).toMatch(/no background Harness/i);
    expect(live.proc.exitCode).toBeNull();
    expect(live.stderrBuf.value).not.toContain('qwen serve');
  });

  it('still routes microphone PCM and spoken output without a backend session', async () => {
    const input = Buffer.alloc(3200, 1);
    const fromIndex = fakeDash.inbox.length;
    host.sendAudio(epoch, input);
    const append = await fakeDash.waitForMessage(
      (value) => value['type'] === 'input_audio_buffer.append',
      { fromIndex },
    );
    expect(Buffer.from(String(append['audio']), 'base64')).toEqual(input);
    const output = Buffer.alloc(4800, 2);
    const framesBefore = host.audioFrames.length;
    const statesBefore = host.states.length;
    conn.respondWithAudio(output);
    expect(await host.waitForAudioFrame({ fromIndex: framesBefore })).toEqual(
      output,
    );
    await host.waitForState((value) => value.status['state'] === 'listening', {
      fromIndex: statesBefore,
    });
  });

  it.each([
    ['handoff', { task: 'Create a file for me.' }],
    [
      'session_create',
      { backend: 'codex', label: 'Do not create this session' },
    ],
    ['session_list', {}],
    ['session_monitor', { session: 'session_1' }],
    ['session_stop', { session: 'session_1' }],
    ['respond_permission', { request_id: 'req_1', decision: 'allow' }],
  ] as Array<[string, Json]>)(
    'turns %s into an install/configure receipt and continues the voice response',
    async (name, args) => {
      const receipt = JSON.parse(
        await tool(name, args, `no-backend-${name}`),
      ) as Json;
      expect(receipt).toMatchObject({ status: 'error', code: 'no_backend' });
      expect(String(receipt['note'])).toMatch(/install.*configur/i);
      expect(receipt).not.toHaveProperty('handle');
      expect(receipt).not.toHaveProperty('job');
      const result = await subagents();
      expect(result).toMatchObject({
        type: 'page',
        page: { total: 0, snapshot: { tasks: [] } },
      });
      expect(live.proc.exitCode).toBeNull();
    },
  );

  it('starts independent On Demand analysis and retains screen metadata without a backend', async () => {
    const receipt = JSON.parse(
      await tool('appshot', {}, 'no-backend-appshot'),
    ) as Json;
    expect(receipt).toMatchObject({
      status: 'accepted',
      source: 'screen',
      screen_scope: 'display',
      accessibility_text: 'fake accessibility text',
    });
    expect(receipt['taskId']).toMatch(/^visual:/);
    expect(receipt['asset']).toMatch(/^asset_/);
    const result = await fakeDash.waitForMessage(
      (message) =>
        conn.inbox.includes(message) &&
        notificationOf(message)?.kind === 'visual_result',
    );
    expect(JSON.parse(notificationOf(result)!.payload)).toMatchObject({
      status: 'completed',
      asset: receipt['asset'],
      answer: 'The synthetic snapshot contains a blue region.',
    });
    // Receipt completion is not result delivery. Drain the asynchronous visual
    // notification before the following test queues a new user tool call.
    await responseAfter(result, 'visual_result');
  });

  it('keeps Memory writes and refreshed context available', async () => {
    const fact = 'The user prefers concise answers in no-backend mode.';
    const fromIndex = fakeDash.inbox.length;
    const receipt = await tool(
      'omnibio',
      { operations: { add: [fact] } },
      'no-backend-memory',
    );
    expect(receipt).not.toContain('Failed');
    const update = await fakeDash.waitForMessage(
      (value) =>
        contextTextOf(value)?.startsWith('[BACKEND] [MEMORY_CONTEXT] ') ===
          true && contextTextOf(value)?.includes(fact) === true,
      { fromIndex },
    );
    const snapshot = JSON.parse(
      contextTextOf(update)!.slice('[BACKEND] [MEMORY_CONTEXT] '.length),
    ) as Json;
    expect(snapshot).toMatchObject({
      enabled: true,
      revision: expect.any(Number),
    });
    expect(String(snapshot['sections'])).toContain(fact);
    expect(
      conn.inbox.filter(
        (value) =>
          value['type'] === 'session.update' &&
          'instructions' in (value['session'] as Json),
      ),
    ).toHaveLength(1);
    for (const request of conn.inbox.filter(
      (value) => value['type'] === 'response.create',
    )) {
      expect(request).not.toHaveProperty('response.instructions');
    }
  });

  it('creates a Proactive timer and supports stopping it in Subagents', async () => {
    const title = 'Standalone reminder';
    const receipt = await tool(
      'create_proactive_timer',
      {
        title,
        duration_sec: 600,
        reminder_text: 'Take a break.',
      },
      'no-backend-timer',
    );
    expect(receipt).toContain(title);
    const result = await subagents();
    const page = result['page'] as {
      snapshot: { tasks: Array<{ id: string; kind: string; title: string }> };
    };
    const proactiveTasks = page.snapshot.tasks.filter(
      (task) => task.kind === 'proactive',
    );
    expect(proactiveTasks).toHaveLength(1);
    const task = proactiveTasks[0]!;
    expect(task).toMatchObject({ kind: 'proactive', title });
    const fromIndex = fakeDash.inbox.length;
    expect(await subagents({ action: 'stop', taskId: task.id })).toMatchObject({
      type: 'outcome',
      outcome: 'stopped',
    });
    const stopped = await fakeDash.waitForMessage(
      (value) => contextTextOf(value)?.includes('[SUBAGENT_CONTROL ') ?? false,
      { fromIndex },
    );
    expect(contextTextOf(stopped)).toContain('cancelled');
    expect(fakeDash.connections).toHaveLength(2);
  });

  it('continues to forward Live Feed frames directly to Omni', async () => {
    const fromIndex = fakeDash.inbox.length;
    host.setVisualInput(epoch, 'camera', 'live-feed');
    await fakeDash.waitForMessage(
      (value) =>
        contextTextOf(value)?.includes('source=camera mode=live-feed') ?? false,
      { fromIndex },
    );
    host.sendAudio(epoch, Buffer.alloc(3200, 1));
    await fakeDash.waitForMessage(
      (value) => value['type'] === 'input_audio_buffer.append',
      { fromIndex },
    );
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    host.sendCameraFrame(epoch, image);
    const append = await fakeDash.waitForMessage(
      (value) => value['type'] === 'input_image_buffer.append',
      { fromIndex },
    );
    expect(append['image']).toBe(image);
  });
});
