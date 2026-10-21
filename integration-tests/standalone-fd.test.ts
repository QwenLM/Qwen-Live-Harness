/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { FakeHost, spawnQwenLiveHarness } from './qwen-live-harness.js';

it('runs FD through the shipped daemon and Host boundary without Qwen voice-turn events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-live-fd-'));
  const dataDir = join(directory, 'data'),
    discoveryDir = join(directory, 'discovery');
  await mkdir(dataDir);
  await mkdir(discoveryDir);
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const inbox: Record<string, unknown>[] = [];
  let connection!: WebSocket;
  wss.on('connection', (socket, request) => {
    connection = socket;
    expect(request.url).toBe('/v1/live/sessions');
    expect(request.headers.authorization).toBe('Bearer fd-fixture');
    socket.on('message', (data) => {
      const event = JSON.parse(data.toString());
      inbox.push(event);
      if (event.type === 'session.start')
        socket.send(
          JSON.stringify({
            type: 'session.started',
            session: { ...event.session, id: 'live-fake' },
          }),
        );
      if (event.type === 'session.close')
        socket.send(
          JSON.stringify({
            type: 'session.closed',
            reason: 'close_requested',
            usage: { seconds: 3 },
          }),
        );
      if (
        /^session\.(thinking|commentary|instructions)\.append$/u.test(
          event.type,
        )
      )
        socket.send(
          JSON.stringify({
            type: event.type + 'ed',
            client_event_id: event.event_id,
            start_ms: 0,
            end_ms: 100,
          }),
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No server port');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const live = await spawnQwenLiveHarness({
    dataDir,
    discoveryDir,
    cwd: directory,
    realtimeEndpoint: endpoint,
    initialConfig: {
      mode: 'fd',
      fd: { apiKey: 'fd-fixture', endpoint },
      backends: [],
    },
  });
  const host = new FakeHost(discoveryDir);
  try {
    await host.connect();
    expect(
      host.messages.find((m) => m['type'] === 'host.welcome')?.[
        'voiceSettingsV1'
      ],
    ).toMatchObject({ model: 'gpt-live-1', voice: 'marin' });
    host.action('new');
    const state = await host.waitForState(
      (s) => s.status['state'] === 'listening',
    );
    host.sendAudio(state.epoch, Buffer.alloc(640));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inbox.some((e) => e['type'] === 'session.input_audio.append')).toBe(
      true,
    );
    connection.send(
      JSON.stringify({
        type: 'session.output_transcript.delta',
        delta: 'Ready.',
        start_ms: 0,
        end_ms: 200,
      }),
    );
    const speech = Buffer.alloc(640, 12);
    connection.send(
      JSON.stringify({
        type: 'session.output_audio.delta',
        delta: speech.toString('base64'),
      }),
    );
    const frame = await host.waitForAudioFrame();
    expect(frame.length).toBeGreaterThan(speech.length);
    expect(inbox.find((e) => e['type'] === 'session.start')).toMatchObject({
      session: {
        delegation: { type: 'responses', responses: { model: 'gpt-6-luna' } },
      },
    });
    for (const event of [
      {
        type: 'session.input_transcript.delta',
        delta: 'List my sessions.',
        start_ms: 1000,
        end_ms: 1300,
      },
      {
        type: 'session.delegation.created',
        offset_ms: 1300,
        delegation: { id: 'd1', target: 'responses', response_id: 'r1' },
      },
      {
        type: 'response.event',
        delegation_id: 'd1',
        event: { type: 'response.created', response: { id: 'r1' } },
      },
      {
        type: 'response.event',
        delegation_id: 'd1',
        event: {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'c1',
            name: 'session_list',
            arguments: '{}',
          },
        },
      },
      {
        type: 'response.event',
        delegation_id: 'd1',
        event: {
          type: 'response.completed',
          response: { id: 'r1', output: [] },
        },
      },
    ])
      connection.send(JSON.stringify(event));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(inbox).toContainEqual(
      expect.objectContaining({
        type: 'response.item.create',
        item: expect.objectContaining({
          type: 'function_call_output',
          call_id: 'c1',
        }),
      }),
    );
    expect(inbox.filter((e) => e['type'] === 'response.create')).toHaveLength(
      1,
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(
      host.messages.some((m) => m['type'] === 'host.output_audio_finished'),
    ).toBe(true);
    const before = host.states.length;
    host.action('stop');
    await host.waitForState((s) => s.status['state'] === 'idle', {
      fromIndex: before,
    });
    // response.create above continues only the backend; no voice response body.
    expect(
      inbox
        .filter((e) => e['type'] === 'response.create')
        .every((e) => e['response'] === undefined),
    ).toBe(true);
    expect(inbox.map((e) => e['type'])).not.toContain(
      'input_audio_buffer.commit',
    );
    const files = await readdir(join(dataDir, 'sessions'));
    const log = await readFile(
      join(
        dataDir,
        'sessions',
        files.find((f) => f.endsWith('.jsonl'))!,
      ),
      'utf8',
    );
    expect(log).toContain('"seconds":3');
    expect(log).not.toContain('fd-fixture');
  } finally {
    host.close();
    await live.dispose();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
