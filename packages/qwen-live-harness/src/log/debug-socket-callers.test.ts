/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DebugArchive,
  type DebugArchiveEventEnvelope,
  type DebugArchiveMediaRef,
} from './debug-archive.js';
import { openQwenRealtimeSession } from '../realtime/realtime-session.js';
import { searchQwenRealtime } from '../realtime/web-search.js';
import { analyzeQwenRealtimeImage } from '../realtime/visual-analysis.js';
import { synthesizeNotificationSpeech } from '../realtime/notification-speech.js';
import { DashScopeRealtimeMonitor } from '../proactive/realtime-monitor.js';
import { createDebugSocket } from './debug-socket.js';

class Socket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  send(value: string | Uint8Array): void {
    this.sent.push(JSON.parse(String(value)));
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from('client closed'));
  }
  terminate(): void {
    this.readyState = 3;
  }
  message(event: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(event), false);
  }
}

describe('debug socket caller integration', () => {
  it.each(['main', 'search', 'visual', 'notification', 'monitor'] as const)(
    'observes %s before its parser and retains caller correlation without constructor headers',
    async (kind) => {
      const socket = new Socket();
      const events: unknown[] = [];
      const beginConnection = vi.fn((_info: unknown) => ({
        id: 'conn-1',
        path: '/test',
        record: (_direction: string, event: unknown) => events.push(event),
        close() {},
      }));
      const debugArchive = { beginConnection } as unknown as DebugArchive;
      const controller = new AbortController();
      const common = {
        endpoint: 'wss://example.test/realtime',
        apiKey: 'PRIVATE_FIXTURE_KEY',
        model: 'test-model',
        debugArchive,
        debugContext: { operationId: 'operation-7', epoch: 17 },
      };
      const deps = { createWebSocket: () => socket };
      let cancel = () => controller.abort();
      let result: Promise<unknown>;
      if (kind === 'main')
        result = openQwenRealtimeSession(
          {
            ...common,
            callEpoch: 17,
            instructions: 'main instructions',
            tools: [],
          },
          {},
          { ...deps, abortSignal: controller.signal },
        );
      else if (kind === 'search')
        result = searchQwenRealtime(
          { ...common, query: 'weather today', signal: controller.signal },
          deps,
        );
      else if (kind === 'visual')
        result = analyzeQwenRealtimeImage(
          {
            ...common,
            image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
            question: 'What is visible?',
            source: 'screen',
            signal: controller.signal,
          },
          deps,
        );
      else if (kind === 'notification')
        result = synthesizeNotificationSpeech(
          {
            ...common,
            summary: 'A task completed.',
            language: 'en',
            signal: controller.signal,
          },
          deps,
        );
      else {
        const monitor = new DashScopeRealtimeMonitor(
          {
            ...common,
            taskId: 'task-9',
            taskGeneration: 3,
            instruction: 'Detect a cough.',
            monitorMode: 'event',
            modalities: ['audio'],
            contextWindowSec: { audio: 60, vision: 10 },
            sessionRecycleEvals: 60,
            representationCompact: 'normal',
          },
          { onResult() {} },
          deps,
        );
        result = monitor.start();
        cancel = () => monitor.close();
      }
      const finished = result.catch(() => undefined);
      try {
        socket.message({
          type: 'session.created',
          event_id: 'event-start',
          session: { id: 'sess-smoke' },
        });
        expect(beginConnection).toHaveBeenCalledWith(
          expect.objectContaining({
            kind,
            operationId: 'operation-7',
            model: 'test-model',
            endpoint: 'wss://example.test/realtime',
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'wire.receive',
            binary: false,
            event: {
              type: 'session.created',
              event_id: 'event-start',
              session: { id: 'sess-smoke' },
            },
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'wire.send',
            event: expect.objectContaining({ type: 'session.update' }),
          }),
        );
        expect(JSON.stringify(events)).not.toContain('PRIVATE_FIXTURE_KEY');
        if (kind === 'monitor')
          expect(beginConnection).toHaveBeenCalledWith(
            expect.objectContaining({
              taskId: 'task-9',
              taskGeneration: 3,
              transportGeneration: 1,
            }),
          );
      } finally {
        cancel();
        await finished;
      }
    },
  );

  it('archives a complete main handshake/tool round with exact PCM media hashes and redacted credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qwen-debug-wire-main-'));
    const archive = new DebugArchive({
      directory,
      secrets: ['PRIVATE_FIXTURE_KEY'],
    });
    const socket = new Socket();
    const calls = vi.fn();
    const tool = {
      type: 'function' as const,
      function: {
        name: 'appshot',
        description: 'Capture source',
        parameters: { type: 'object', properties: {} },
      },
      continuesResponse: true,
    };
    let session:
      Awaited<ReturnType<typeof openQwenRealtimeSession>> | undefined;
    try {
      const opening = openQwenRealtimeSession(
        {
          endpoint: 'wss://example.test/realtime',
          apiKey: 'PRIVATE_FIXTURE_KEY',
          model: 'test-model',
          callEpoch: 17,
          voice: 'Tina',
          instructions: 'Exact instructions\nPRIVATE_FIXTURE_KEY',
          tools: [tool],
          debugArchive: archive,
        },
        { onFunctionCall: calls },
        { createWebSocket: () => socket },
      );
      socket.message({
        type: 'session.created',
        event_id: 'created',
        session: { id: 'sess-complete' },
      });
      socket.message({
        type: 'session.updated',
        event_id: 'updated',
        session: { id: 'sess-complete' },
      });
      session = await opening;
      const input = Buffer.from([1, 0, 2, 0, 3, 0]);
      expect(session.pushAudio(input)).toBe(true);
      socket.message({
        type: 'input_audio_buffer.committed',
        event_id: 'user-committed',
        item_id: 'user-1',
      });
      socket.message({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'user-text',
        item_id: 'user-1',
        transcript: 'Look at the screen.',
      });
      socket.message({
        type: 'response.created',
        event_id: 'response-start',
        response: { id: 'resp-complete', status: 'in_progress' },
      });
      const output = Buffer.from([4, 0, 5, 0, 6, 0]);
      socket.message({
        type: 'response.audio.delta',
        response_id: 'resp-complete',
        item_id: 'audio-1',
        content_index: 0,
        delta: output.toString('base64'),
      });
      const item = {
        id: 'item-appshot',
        type: 'function_call',
        status: 'completed',
        call_id: 'call-appshot',
        name: 'appshot',
        arguments: '{}',
      };
      socket.message({
        type: 'response.output_item.done',
        event_id: 'tool-done',
        response_id: 'resp-complete',
        item,
      });
      socket.message({
        type: 'response.done',
        event_id: 'response-done',
        response: { id: 'resp-complete', status: 'completed', output: [item] },
      });
      expect(calls).toHaveBeenCalledOnce();
      expect(
        session.submitFunctionOutput(
          { callEpoch: 17, callId: 'call-appshot' },
          '{"status":"ok"}',
        ),
      ).toBe(true);
      const receipt = socket.sent.find(
        (event) =>
          (event['item'] as Record<string, unknown> | undefined)?.['type'] ===
          'function_call_output',
      )!;
      socket.message({
        type: 'conversation.item.created',
        event_id: 'receipt-ack',
        item: {
          ...(receipt['item'] as object),
          id: 'output-appshot',
          status: 'completed',
        },
      });
      session.close({ discardPendingInput: true });
      await archive.close();
      const text = await readFile(join(archive.path, 'events.jsonl'), 'utf8');
      expect(text).not.toContain('PRIVATE_FIXTURE_KEY');
      const events = text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as DebugArchiveEventEnvelope);
      const wire = events.map(
        (entry) => entry.event as Record<string, unknown>,
      );
      const outgoing = wire
        .filter((entry) => entry['type'] === 'wire.send')
        .map((entry) => entry['event'] as Record<string, unknown>);
      const updates = outgoing.filter(
        (entry) => entry['type'] === 'session.update',
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        session: {
          instructions: expect.stringContaining('Exact instructions\n'),
          tools: [{ type: 'function', function: tool.function }],
        },
      });
      expect(
        outgoing.some(
          (entry) =>
            entry['type'] === 'conversation.item.create' &&
            (entry['item'] as Record<string, unknown>)['call_id'] ===
              'call-appshot',
        ),
      ).toBe(true);
      expect(
        outgoing.filter((entry) => entry['type'] === 'response.create'),
      ).toHaveLength(2);
      expect(text).toContain('sess-complete');
      expect(text).toContain('resp-complete');
      const inputRef = outgoing.find(
        (entry) => entry['type'] === 'input_audio_buffer.append',
      )!['audio'] as DebugArchiveMediaRef;
      const receivedAudio = wire.find(
        (entry) =>
          entry['type'] === 'wire.receive' &&
          (entry['event'] as Record<string, unknown>)['type'] ===
            'response.audio.delta',
      )!['event'] as Record<string, unknown>;
      const outputRef = receivedAudio['delta'] as DebugArchiveMediaRef;
      for (const [ref, expected] of [
        [inputRef, input],
        [outputRef, output],
      ] as const) {
        const media = await readFile(join(archive.path, ref.$media));
        expect(
          media.subarray(ref.byteOffset, ref.byteOffset + ref.bytes),
        ).toEqual(expected);
        expect(ref.sha256).toBe(
          createHash('sha256').update(expected).digest('hex'),
        );
      }
      expect(
        JSON.parse(await readFile(join(archive.path, 'manifest.json'), 'utf8')),
      ).toMatchObject({ incomplete: false, status: 'closed' });
    } finally {
      session?.close({ discardPendingInput: true });
      await archive.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('marks a capacity-rejected raw message incomplete instead of silently truncating it', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'qwen-debug-wire-capacity-'),
    );
    const archive = new DebugArchive({ directory, maxQueuedBytes: 64 * 1024 });
    const socket = new Socket();
    try {
      createDebugSocket(() => socket, {
        debugArchive: archive,
        info: { kind: 'main', model: 'test', endpoint: 'wss://example.test' },
      });
      socket.emit('message', 'malformed '.repeat(20_000), false);
      await archive.close();
      expect(
        JSON.parse(await readFile(join(archive.path, 'manifest.json'), 'utf8')),
      ).toMatchObject({ incomplete: true, status: 'incomplete' });
    } finally {
      await archive.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
