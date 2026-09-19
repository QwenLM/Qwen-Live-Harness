/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MonitorDebugStore,
  type MonitorAudioOrigin,
  type MonitorDebugInfo,
  type MonitorDebugRecorder,
} from './monitor-debug-store.js';

const INFO: MonitorDebugInfo = {
  taskId: 'monitor-1',
  taskGeneration: 3,
  model: 'test-model',
  modalities: ['vision', 'audio'],
};

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

function sendImage(recorder: MonitorDebugRecorder, bytes: Buffer): void {
  recorder.sent({
    type: 'input_image_buffer.append',
    image: bytes.toString('base64'),
    event_id: 'image-event',
  });
}

function sendAudio(
  recorder: MonitorDebugRecorder,
  bytes: Buffer,
  origin?: MonitorAudioOrigin,
): void {
  recorder.sent(
    {
      type: 'input_audio_buffer.append',
      audio: bytes.toString('base64'),
      event_id: 'audio-event',
    },
    origin ? { origin } : undefined,
  );
}

function commit(recorder: MonitorDebugRecorder): void {
  recorder.sent({
    type: 'input_audio_buffer.commit',
    event_id: 'commit-event',
  });
}

describe('MonitorDebugStore', () => {
  let temporary: string;
  let root: string;
  let store: MonitorDebugStore;
  let log: ReturnType<typeof vi.fn>;
  let stores: MonitorDebugStore[];

  beforeEach(async () => {
    temporary = await mkdtemp(
      join(tmpdir(), 'qwen-live-harness-monitor-store-test-'),
    );
    root = join(temporary, 'archives');
    log = vi.fn();
    store = new MonitorDebugStore(log, root);
    stores = [store];
  });

  afterEach(async () => {
    await Promise.all(stores.map((item) => item.flush()));
    vi.restoreAllMocks();
    await rm(temporary, { recursive: true, force: true });
  });

  async function recorder(
    apiKey?: string,
    info: MonitorDebugInfo = INFO,
  ): Promise<MonitorDebugRecorder> {
    expect(await store.initialize()).toBe(true);
    const result = store.create(info, apiKey);
    expect(result).toBeDefined();
    await result!.start();
    return result!;
  }

  async function ownedDirectory(createdAt: number): Promise<string> {
    const directory = join(root, `monitor-${createdAt}-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, 'monitor.json'),
      JSON.stringify({
        format: 'qwen-live-harness-monitor-debug-v1',
        createdAt,
      }),
      { mode: 0o600 },
    );
    return directory;
  }

  it('does not create files before debug initialization or for tasks without media', async () => {
    expect(store.create(INFO)).toBeUndefined();
    expect(store.create({ ...INFO, modalities: ['audio'] })).toBeUndefined();
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.initialize()).toBe(true);
    expect(store.create({ ...INFO, modalities: [] })).toBeUndefined();
    expect(store.create({ ...INFO, modalities: ['text'] })).toBeUndefined();
    await store.flush();
    expect(await readdir(root)).toEqual([]);
  });

  it('archives audio-only sent frames with explicit origins without altering wire bodies or WAV order', async () => {
    const archive = await recorder(undefined, {
      ...INFO,
      modalities: ['audio'],
    });
    const microphone = Buffer.from([1, 0, 2, 0, 3, 0]);
    const silence = Buffer.alloc(8);
    const unknown = Buffer.from([4, 0]);
    const quietMicrophone = Buffer.alloc(4);
    const wire = {
      type: 'input_audio_buffer.append',
      audio: microphone.toString('base64'),
      event_id: 'mic-event',
    };
    const originalWire = { ...wire };
    archive.beginTransport(1);
    archive.sent(wire, { origin: 'microphone' });
    sendAudio(archive, silence, 'protocol_silence');
    sendAudio(archive, unknown);
    sendAudio(archive, quietMicrophone, 'microphone');
    commit(archive);
    archive.result({ status: 'completed', text: 'wait' });
    await store.flush();
    expect(wire).toEqual(originalWire);
    expect(wire).not.toHaveProperty('origin');
    const directory = join(archive.directory, 'requests', '000001');
    expect(await readdir(directory)).toEqual([
      'input.wav',
      'request.json',
      'response.json',
    ]);
    const request = await readJson(join(directory, 'request.json'));
    expect(request).toMatchObject({
      monitor: { modalities: ['audio'] },
      audioSummary: {
        totalBytes: 20,
        microphoneBytes: 10,
        protocolSilenceBytes: 8,
        unknownBytes: 2,
      },
      events: [
        {
          type: 'input_audio_buffer.append',
          origin: 'microphone',
          byteOffset: 0,
          bytes: 6,
        },
        {
          type: 'input_audio_buffer.append',
          origin: 'protocol_silence',
          byteOffset: 6,
          bytes: 8,
        },
        {
          type: 'input_audio_buffer.append',
          origin: 'unknown',
          byteOffset: 14,
          bytes: 2,
        },
        {
          type: 'input_audio_buffer.append',
          origin: 'microphone',
          byteOffset: 16,
          bytes: 4,
        },
        { type: 'input_audio_buffer.commit' },
      ],
    });
    const audio = await readFile(join(directory, 'input.wav'));
    expect(audio.subarray(44)).toEqual(
      Buffer.concat([microphone, silence, unknown, quietMicrophone]),
    );
    expect(audio.readUInt32LE(40)).toBe(20);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    for (const file of ['input.wav', 'request.json', 'response.json'])
      expect((await lstat(join(directory, file))).mode & 0o777).toBe(0o600);
  });

  it('pins provider session IDs to their transport and backfills a pending request only once', async () => {
    const archive = await recorder();
    archive.beginTransport(1);
    archive.setProviderSessionId('session-one');
    commit(archive);
    archive.setProviderSessionId('conflicting-session');
    for (let index = 0; index < 20; index++)
      archive.setProviderSessionId('session-one');
    // Ending this transport records the old request before resetting its identity.
    archive.beginTransport(2);
    commit(archive);
    archive.result({
      status: 'completed',
      providerSessionId: 'unverified-result-field',
    });
    archive.beginTransport(3);
    commit(archive);
    archive.setProviderSessionId('session-three');
    archive.result({
      status: 'completed',
      providerSessionId: 'spoofed-result-field',
    });
    archive.beginTransport(4);
    archive.setProviderSessionId('session-four');
    commit(archive);
    archive.result({ status: 'failed', text: 'Synthetic provider failure.' });
    archive.beginTransport(5);
    archive.setProviderSessionId('session-five');
    commit(archive);
    archive.close();
    await store.flush();
    for (const file of ['request.json', 'response.json']) {
      expect(
        await readJson(join(archive.directory, 'requests', '000001', file)),
      ).toMatchObject({ providerSessionId: 'session-one' });
      expect(
        await readJson(join(archive.directory, 'requests', '000002', file)),
      ).not.toHaveProperty('providerSessionId');
      expect(
        await readJson(join(archive.directory, 'requests', '000003', file)),
      ).toMatchObject({ providerSessionId: 'session-three' });
      expect(
        await readJson(join(archive.directory, 'requests', '000004', file)),
      ).toMatchObject({ providerSessionId: 'session-four' });
      expect(
        await readJson(join(archive.directory, 'requests', '000005', file)),
      ).toMatchObject({ providerSessionId: 'session-five' });
    }
  });

  it('ignores malformed or secret-bearing provider IDs and unrecognized diagnostic metadata', async () => {
    const key = 'sk-fixture-secret';
    const archive = await recorder(key, { ...INFO, modalities: ['audio'] });
    archive.beginTransport(1);
    for (const id of [
      '',
      ' ',
      'id\n',
      'x'.repeat(257),
      key,
      'prefix-' + key,
      'id?token=value',
      '🙂',
    ])
      archive.setProviderSessionId(id);
    archive.sent(
      { type: 'input_audio_buffer.append', audio: 'AQACAA==' },
      {
        origin: key as MonitorAudioOrigin,
      },
    );
    commit(archive);
    archive.result({ status: 'completed', providerSessionId: key });
    await store.flush();
    const directory = join(archive.directory, 'requests', '000001');
    const request = await readJson(join(directory, 'request.json'));
    expect(request).not.toHaveProperty('providerSessionId');
    expect(request).toMatchObject({
      audioSummary: {
        totalBytes: 4,
        microphoneBytes: 0,
        protocolSilenceBytes: 0,
        unknownBytes: 4,
      },
    });
    const response = await readJson(join(directory, 'response.json'));
    expect(response).not.toHaveProperty('providerSessionId');
    expect(
      JSON.stringify({ request, response, logs: log.mock.calls }),
    ).not.toContain(key);
  });

  it('archives manual task text only in the first response request, with two one-second media intervals', async () => {
    const archive = await recorder();
    archive.beginTransport(1);
    archive.setProviderSessionId('sess-manual-clips');
    const settings = {
      type: 'session.update',
      session: { instructions: 'Fixed monitor system prompt.' },
    };
    archive.sent(settings);
    const silence = Buffer.alloc(32_000);
    for (let turn = 1; turn <= 2; turn++) {
      for (let frame = 0; frame < 2; frame++) {
        sendAudio(archive, silence, 'protocol_silence');
        sendImage(archive, Buffer.from([0xff, 0xd8, turn, frame, 0xff, 0xd9]));
      }
      commit(archive);
      archive.sent({
        type: 'response.create',
        ...(turn === 1
          ? {
              response: { instructions: 'Tell me when the light turns green.' },
            }
          : {}),
      });
      archive.result({ status: 'completed', text: 'wait' });
    }
    await store.flush();

    for (let turn = 1; turn <= 2; turn++) {
      const directory = join(archive.directory, 'requests', `00000${turn}`);
      const request = await readJson(join(directory, 'request.json'));
      expect(request).toMatchObject({
        providerSessionId: 'sess-manual-clips',
        session: [settings],
        audioSummary: { totalBytes: 64_000, protocolSilenceBytes: 64_000 },
        ...(turn === 2 ? { previousRequest: '000001' } : {}),
      });
      const events = request['events'] as Array<Record<string, unknown>>;
      expect(events.map((event) => event['type'])).toEqual([
        'input_audio_buffer.append',
        'input_image_buffer.append',
        'input_audio_buffer.append',
        'input_image_buffer.append',
        'input_audio_buffer.commit',
        'response.create',
      ]);
      expect(events[0]).toMatchObject({ byteOffset: 0, bytes: 32_000 });
      expect(events[2]).toMatchObject({ byteOffset: 32_000, bytes: 32_000 });
      expect(events[5]).toEqual(
        turn === 1
          ? {
              type: 'response.create',
              response: { instructions: 'Tell me when the light turns green.' },
            }
          : { type: 'response.create' },
      );
      expect((await readFile(join(directory, 'input.wav'))).byteLength).toBe(
        64_044,
      );
    }
  });

  it('archives exact sent media, WAV offsets and ordering with private permissions', async () => {
    const key = 'sk-connection-secret';
    const archive = await recorder(key);
    const image = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    const nextImage = Buffer.from([0xff, 0xd8, 3, 4, 0xff, 0xd9]);
    const audio = Buffer.from([0, 0, 0xff, 0x7f, 0, 0x80]);
    const silence = Buffer.alloc(8);
    archive.beginTransport(4);
    archive.sent({
      type: 'session.update',
      headers: { Authorization: `Bearer ${key}` },
      session: {
        instructions: `Remember the private-user-note; key=${key}`,
        apiKey: key,
      },
    });
    archive.sent({
      type: 'conversation.item.create',
      item: { role: 'user', text: 'Keep actual model context.' },
    });
    sendAudio(archive, audio, 'microphone');
    sendImage(archive, image);
    sendAudio(archive, silence, 'protocol_silence');
    sendImage(archive, nextImage);
    commit(archive);
    archive.sent({ type: 'response.create', event_id: 'response-event' });
    archive.result({
      status: 'completed',
      text: `Reply ${key}`,
      result: 'reply',
    });
    await store.flush();

    const directory = join(archive.directory, 'requests', '000001');
    const request = await readJson(join(directory, 'request.json'));
    expect(request).toMatchObject({
      recordingStatus: 'saved',
      monitor: INFO,
      request: 1,
      transportGeneration: 4,
      audioSummary: {
        totalBytes: audio.length + silence.length,
        microphoneBytes: audio.length,
        protocolSilenceBytes: silence.length,
        unknownBytes: 0,
      },
      audioFormat: {
        encoding: 'pcm16le',
        sampleRate: 16_000,
        channels: 1,
        byteOffsetsExcludeWavHeader: true,
      },
      session: [
        {
          type: 'session.update',
          session: {
            instructions: 'Remember the private-user-note; key=[redacted]',
          },
        },
        {
          type: 'conversation.item.create',
          item: { role: 'user', text: 'Keep actual model context.' },
        },
      ],
      events: [
        {
          type: 'input_audio_buffer.append',
          audio: 'input.wav',
          byteOffset: 0,
          origin: 'microphone',
          bytes: audio.length,
          eventId: 'audio-event',
        },
        {
          type: 'input_image_buffer.append',
          image: 'image-0001.jpg',
          bytes: image.length,
          eventId: 'image-event',
          sha256: createHash('sha256').update(image).digest('hex'),
        },
        {
          type: 'input_audio_buffer.append',
          audio: 'input.wav',
          byteOffset: audio.length,
          origin: 'protocol_silence',
          bytes: silence.length,
          eventId: 'audio-event',
        },
        {
          type: 'input_image_buffer.append',
          image: 'image-0002.jpg',
          bytes: nextImage.length,
          eventId: 'image-event',
          sha256: createHash('sha256').update(nextImage).digest('hex'),
        },
        { type: 'input_audio_buffer.commit', event_id: 'commit-event' },
        { type: 'response.create', event_id: 'response-event' },
      ],
    });
    expect(JSON.stringify(request)).not.toContain(key);
    expect(JSON.stringify(request)).not.toContain('Authorization');
    expect(JSON.stringify(request)).not.toContain('apiKey');
    expect(await readFile(join(directory, 'image-0001.jpg'))).toEqual(image);
    expect(await readFile(join(directory, 'image-0002.jpg'))).toEqual(
      nextImage,
    );
    const wav = await readFile(join(directory, 'input.wav'));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(audio.length + silence.length);
    expect(wav.subarray(44)).toEqual(Buffer.concat([audio, silence]));
    expect(await readJson(join(directory, 'response.json'))).toEqual({
      status: 'completed',
      text: 'Reply [redacted]',
      result: 'reply',
    });
    for (const path of [
      root,
      archive.directory,
      join(archive.directory, 'requests'),
      directory,
    ]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
    }
    for (const path of [
      join(archive.directory, 'monitor.json'),
      ...[
        'request.json',
        'response.json',
        'image-0001.jpg',
        'image-0002.jpg',
        'input.wav',
      ].map((file) => join(directory, file)),
    ]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }
    expect(log).toHaveBeenCalledWith(
      'proactive.monitor_request_saved',
      expect.objectContaining({
        directory: archive.directory,
        requestDirectory: directory,
        imageFrames: 2,
        audioBytes: audio.length + silence.length,
      }),
    );
  });

  it('separates requests and transports without copying old media or cleared inputs', async () => {
    const archive = await recorder();
    archive.beginTransport(1);
    sendImage(archive, Buffer.from('discarded image'));
    sendAudio(archive, Buffer.from('discarded audio'));
    archive.sent({ type: 'input_audio_buffer.clear' });
    sendImage(archive, Buffer.from('first image'));
    sendAudio(archive, Buffer.from([1, 0]), 'microphone');
    commit(archive);
    archive.result({ text: 'wait', status: 'completed' });
    sendImage(archive, Buffer.from('second image'));
    sendAudio(archive, Buffer.alloc(4), 'protocol_silence');
    commit(archive);
    sendImage(archive, Buffer.from('uncommitted old transport image'));
    sendAudio(archive, Buffer.from([2, 0]));
    archive.beginTransport(2);
    commit(archive);
    archive.close();
    await store.flush();

    const requests = join(archive.directory, 'requests');
    expect(await readdir(requests)).toEqual(['000001', '000002', '000003']);
    expect(
      await readFile(join(requests, '000001', 'image-0001.jpg'), 'utf8'),
    ).toBe('first image');
    expect(
      await readFile(join(requests, '000002', 'image-0001.jpg'), 'utf8'),
    ).toBe('second image');
    expect(
      await readJson(join(requests, '000002', 'request.json')),
    ).toMatchObject({
      previousRequest: '000001',
      transportGeneration: 1,
      audioSummary: {
        totalBytes: 4,
        microphoneBytes: 0,
        protocolSilenceBytes: 4,
        unknownBytes: 0,
      },
    });
    expect(
      await readJson(join(requests, '000001', 'request.json')),
    ).toMatchObject({
      audioSummary: {
        totalBytes: 2,
        microphoneBytes: 2,
        protocolSilenceBytes: 0,
        unknownBytes: 0,
      },
    });
    expect(
      await readJson(join(requests, '000002', 'response.json')),
    ).toMatchObject({ status: 'recycled', incomplete: true });
    const recycled = await readJson(join(requests, '000003', 'request.json'));
    expect(recycled).toMatchObject({
      request: 3,
      transportGeneration: 2,
      session: [],
      audioSummary: {
        totalBytes: 0,
        microphoneBytes: 0,
        protocolSilenceBytes: 0,
        unknownBytes: 0,
      },
      events: [{ type: 'input_audio_buffer.commit' }],
    });
    expect(recycled).not.toHaveProperty('previousRequest');
    expect(await readdir(join(requests, '000003'))).toEqual([
      'input.wav',
      'request.json',
      'response.json',
    ]);
    expect(
      await readJson(join(requests, '000003', 'response.json')),
    ).toMatchObject({ status: 'closed', incomplete: true });
  });

  it('explicitly truncates large response text and ignores media after closing', async () => {
    const archive = await recorder();
    commit(archive);
    archive.result({ text: 'x'.repeat(131_073), status: 'completed' });
    archive.close();
    sendImage(archive, Buffer.from('closed'));
    commit(archive);
    await store.flush();
    const requests = join(archive.directory, 'requests');
    expect(await readdir(requests)).toEqual(['000001']);
    expect(await readJson(join(requests, '000001', 'response.json'))).toEqual({
      text: 'x'.repeat(131_072),
      textTruncated: true,
      status: 'completed',
    });
  });

  it('retains the latest ten monitors across modalities without recreating an evicted active archive', async () => {
    const first = await recorder();
    sendImage(first, Buffer.from('pending old image'));
    commit(first);
    const latest: MonitorDebugRecorder[] = [];
    for (let index = 0; index < 10; index += 1) {
      latest.push(
        store.create({
          ...INFO,
          taskId: `monitor-${index + 2}`,
          modalities: index % 2 ? ['audio'] : ['vision'],
        })!,
      );
    }
    await store.flush();
    expect((await readdir(root)).sort()).toEqual(
      latest.map((item) => basename(item.directory)).sort(),
    );
    sendImage(first, Buffer.from('later old image'));
    commit(first);
    first.result({ text: 'late response' });
    await store.flush();
    await expect(lstat(first.directory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(log).toHaveBeenCalledWith(
      'proactive.monitor_request_skipped',
      expect.objectContaining({
        directory: first.directory,
        reason: 'evicted',
        retained: false,
      }),
    );
    sendImage(latest[9]!, Buffer.from('new retained image'));
    commit(latest[9]!);
    await store.flush();
    expect(
      await readFile(
        join(latest[9]!.directory, 'requests', '000001', 'image-0001.jpg'),
        'utf8',
      ),
    ).toBe('new retained image');
  });

  it('prunes owned monitors by creation time at startup, preserving unrelated and symlink data', async () => {
    await mkdir(root, { mode: 0o700 });
    const owned: string[] = [];
    for (let time = 1; time <= 11; time += 1)
      owned.push(await ownedDirectory(time));
    await utimes(owned[0]!, new Date(), new Date());
    const unrelated = join(root, 'personal-notes');
    await mkdir(unrelated, { mode: 0o700 });
    await writeFile(join(unrelated, 'keep.txt'), 'keep');
    const unmarked = join(root, `monitor-0-${randomUUID()}`);
    await mkdir(unmarked, { mode: 0o700 });
    const wrongMarker = join(root, `monitor-0-${randomUUID()}`);
    await mkdir(wrongMarker, { mode: 0o700 });
    await writeFile(
      join(wrongMarker, 'monitor.json'),
      JSON.stringify({ format: 'different-owner', createdAt: 0 }),
    );
    const outside = join(temporary, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, 'keep.txt'), 'outside');
    await symlink(outside, join(root, `monitor-0-${randomUUID()}`));
    const markerLink = join(root, `monitor-0-${randomUUID()}`);
    await mkdir(markerLink, { mode: 0o700 });
    await symlink(
      join(owned[0]!, 'monitor.json'),
      join(markerLink, 'monitor.json'),
    );
    expect(await store.initialize()).toBe(true);
    await expect(lstat(owned[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const directory of [
      ...owned.slice(1),
      unrelated,
      unmarked,
      wrongMarker,
      markerLink,
    ])
      expect((await lstat(directory)).isDirectory()).toBe(true);
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside');
    expect(await readFile(join(unrelated, 'keep.txt'), 'utf8')).toBe('keep');
    expect(log).toHaveBeenCalledWith('proactive.monitor_debug_pruned', {
      directory: owned[0],
    });
  });

  it('rejects shared or symlink archive roots without touching their contents', async () => {
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o755);
    await writeFile(join(root, 'keep.txt'), 'keep');
    expect(await store.initialize()).toBe(false);
    expect(store.create(INFO)).toBeUndefined();
    const linked = new MonitorDebugStore(
      log,
      join(temporary, 'linked-archives'),
    );
    stores.push(linked);
    await symlink(root, linked.root);
    expect(await linked.initialize()).toBe(false);
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('does not recreate an active directory pruned by another store', async () => {
    const archive = await recorder();
    const otherStore = new MonitorDebugStore(log, root);
    stores.push(otherStore);
    expect(await otherStore.initialize()).toBe(true);
    for (let index = 0; index < 10; index += 1)
      otherStore.create({ ...INFO, taskId: `other-${index}` });
    await otherStore.flush();
    await expect(lstat(archive.directory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    sendImage(archive, Buffer.from('old active monitor'));
    commit(archive);
    await expect(store.flush()).resolves.toBeUndefined();
    await expect(lstat(archive.directory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await readdir(root)).length).toBe(10);
    expect(log).toHaveBeenCalledWith(
      'proactive.monitor_debug_failed',
      expect.objectContaining({
        directory: archive.directory,
        incomplete: true,
      }),
    );
  });

  it('makes write failures nonfatal and logs explicitly incomplete recording', async () => {
    const archive = await recorder();
    const blocked = join(archive.directory, 'requests', '000001');
    await writeFile(blocked, 'existing-file');
    expect(() => {
      sendImage(archive, Buffer.from('image'));
      commit(archive);
    }).not.toThrow();
    await expect(store.flush()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      'proactive.monitor_debug_failed',
      expect.objectContaining({
        directory: archive.directory,
        reason: 'write_failed',
        incomplete: true,
      }),
    );
    expect(await readFile(blocked, 'utf8')).toBe('existing-file');
    commit(archive);
    await store.flush();
    expect(await readdir(join(archive.directory, 'requests'))).toEqual([
      '000001',
    ]);
  });

  it.each(['provider_session', 'response_create', 'result'])(
    'does not follow a replaced request-directory symlink when writing %s',
    async (update) => {
      const archive = await recorder();
      commit(archive);
      await store.flush();
      const directory = join(archive.directory, 'requests', '000001');
      await rename(directory, join(archive.directory, 'preserved-request'));
      const outside = join(temporary, 'outside-request');
      await mkdir(outside, { mode: 0o700 });
      await writeFile(join(outside, 'keep.txt'), 'outside data');
      await symlink(outside, directory);
      if (update === 'provider_session')
        archive.setProviderSessionId('session-late');
      else if (update === 'response_create')
        archive.sent({ type: 'response.create' });
      else archive.result({ status: 'completed', text: 'wait' });
      await expect(store.flush()).resolves.toBeUndefined();
      expect(await readdir(outside)).toEqual(['keep.txt']);
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe(
        'outside data',
      );
      expect(log).toHaveBeenCalledWith(
        'proactive.monitor_debug_failed',
        expect.objectContaining({ reason: 'write_failed', incomplete: true }),
      );
    },
  );

  it('preserves a completed response and makes serialization failures nonfatal', async () => {
    const archive = await recorder();
    commit(archive);
    archive.result({ status: 'completed', text: 'first response' });
    archive.result({
      status: 'error',
      text: 'unrelated later transport error',
    });
    await store.flush();
    expect(
      await readJson(
        join(archive.directory, 'requests', '000001', 'response.json'),
      ),
    ).toEqual({ status: 'completed', text: 'first response' });
    commit(archive);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => archive.result(circular)).not.toThrow();
    await expect(store.flush()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      'proactive.monitor_debug_failed',
      expect.objectContaining({
        directory: archive.directory,
        incomplete: true,
      }),
    );
  });

  it.each(
    ['pending', 'queued'].flatMap((boundary) =>
      ['audio', 'vision'].map((modality) => ({ boundary, modality })),
    ),
  )(
    'bounds $boundary $modality media without throwing into the model',
    async ({ boundary, modality }) => {
      const archive = await recorder(undefined, {
        ...INFO,
        modalities: [modality],
      });
      const payload = Buffer.alloc(2 * 1024 * 1024).toString('base64');
      const input =
        modality === 'audio'
          ? { type: 'input_audio_buffer.append', audio: payload }
          : { type: 'input_image_buffer.append', image: payload };
      for (let index = 0; index < 16; index += 1) archive.sent(input);
      if (boundary === 'queued') commit(archive);
      expect(() => archive.sent(input)).not.toThrow();
      commit(archive);
      await expect(store.flush()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        'proactive.monitor_debug_failed',
        expect.objectContaining({
          directory: archive.directory,
          reason: 'pending_byte_limit',
          incomplete: true,
        }),
      );
      expect(await readdir(join(archive.directory, 'requests'))).toEqual([]);
    },
  );

  it('does not let a failing log sink break initialization, recording or cleanup', async () => {
    log.mockImplementation(() => {
      throw new Error('log sink unavailable');
    });
    const archive = await recorder();
    commit(archive);
    archive.close();
    await expect(store.flush()).resolves.toBeUndefined();
    expect(
      await readJson(
        join(archive.directory, 'requests', '000001', 'request.json'),
      ),
    ).toMatchObject({ recordingStatus: 'saved' });
  });
});
