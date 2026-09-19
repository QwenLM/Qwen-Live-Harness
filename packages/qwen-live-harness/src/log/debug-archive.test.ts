/**
 * @license
 * Copyright 2026 Qwen Team
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
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DebugArchive,
  type DebugArchiveEventEnvelope,
  type DebugArchiveMediaRef,
  type DebugArchiveOptions,
} from './debug-archive.js';

const JPEG = Buffer.from([0xff, 0xd8, 7, 8, 0xff, 0xd9]);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
type Json = Record<string, unknown>;
let temporary: string;
let root: string;
let archives: DebugArchive[];

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'qwen-debug-archive-test-'));
  root = join(temporary, 'debug');
  archives = [];
});
afterEach(async () => {
  await Promise.all(archives.map((archive) => archive.close()));
  vi.restoreAllMocks();
  await rm(temporary, { recursive: true, force: true });
});
function archive(options: Partial<DebugArchiveOptions> = {}): DebugArchive {
  const value = new DebugArchive({ directory: root, ...options });
  archives.push(value);
  return value;
}
async function manifest(value: DebugArchive): Promise<Json> {
  return JSON.parse(
    await readFile(join(value.path, 'manifest.json'), 'utf8'),
  ) as Json;
}
async function events(
  value: DebugArchive,
): Promise<DebugArchiveEventEnvelope[]> {
  const text = await readFile(join(value.path, 'events.jsonl'), 'utf8');
  return text.trim()
    ? text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as DebugArchiveEventEnvelope)
    : [];
}
async function media(
  value: DebugArchive,
  ref: DebugArchiveMediaRef,
): Promise<Buffer> {
  const bytes = (await readFile(join(value.path, ref.$media))).subarray(
    ref.byteOffset,
    ref.byteOffset + ref.bytes,
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sha256);
  return bytes;
}
function wire(value: DebugArchiveEventEnvelope): Json {
  return (value.event as Json)['event'] as Json;
}

describe('bounded standalone debug archives', () => {
  it('creates a private unique run and persists full ordered connection/runtime events through close', async () => {
    const value = archive({
      sessionId: 'local-run',
      metadata: { runtime: { version: 'test' } },
    });
    const main = value.beginConnection({
      kind: 'main',
      id: 'main-1',
      callEpoch: 2,
      model: 'invite-model',
    });
    const monitor = value.beginConnection({
      kind: 'monitor',
      taskId: 'task-1',
    });
    const args = '{"title":"Desk","narration_style":"cut';
    const instructions = 'Full instructions ' + 'long prompt '.repeat(500);
    main.record('out', {
      type: 'wire.send',
      attemptId: 's1',
      event: {
        type: 'session.update',
        session: {
          instructions,
          tools: [
            {
              type: 'function',
              function: {
                name: 'watch',
                parameters: {
                  type: 'object',
                  properties: { title: { type: 'string' } },
                },
              },
            },
          ],
        },
      },
    });
    monitor.record('in', {
      type: 'wire.receive',
      binary: false,
      event: { type: 'response.function_call_arguments.done', arguments: args },
    });
    main.record('local', {
      type: 'wire.send_result',
      attemptId: 's1',
      status: 'sent',
    });
    value.recordRuntime('tool.result', { output: 'Complete result body' });
    await value.close();
    const saved = await events(value);
    expect(saved.map((event) => event.globalSeq)).toEqual(
      saved.map((_, i) => i + 1),
    );
    for (const id of [main.id, monitor.id, 'runtime']) {
      const rows = saved.filter((row) => row.connectionId === id);
      expect(rows.map((row) => row.connectionSeq)).toEqual(
        rows.map((_, i) => i + 1),
      );
    }
    expect(
      saved.every(
        (row) =>
          Number.isFinite(row.wallTimeMs) &&
          Number.isFinite(Date.parse(row.wallTime)),
      ),
    ).toBe(true);
    expect(saved.map((row) => BigInt(row.monotonicNs))).toEqual(
      saved
        .map((row) => BigInt(row.monotonicNs))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect(
      saved.find(
        (row) =>
          (row.event as Json)['attemptId'] === 's1' && row.direction === 'out',
      )?.event,
    ).toMatchObject({ event: { session: { instructions } } });
    expect(saved.find((row) => row.direction === 'in')?.event).toMatchObject({
      event: { arguments: args },
    });
    expect(await manifest(value)).toMatchObject({
      format: 'qwen-live-harness-debug-v1',
      status: 'closed',
      incomplete: false,
      sessionId: 'local-run',
      connections: { count: 2 },
      counters: {
        writtenEvents: saved.length,
        droppedEvents: 0,
        queuedBytes: 0,
      },
    });
    for (const directory of [root, value.path, join(value.path, 'media')])
      expect((await lstat(directory)).mode & 0o077).toBe(0);
    for (const file of ['manifest.json', 'events.jsonl'])
      expect((await lstat(join(value.path, file))).mode & 0o077).toBe(0);
    const other = archive();
    await other.close();
    expect(other.path).not.toBe(value.path);
  });

  it('aggregates exact PCM chunks by connection/direction, including unsuccessful send attempts', async () => {
    const value = archive();
    const conn = value.beginConnection({ kind: 'main' });
    const chunks = Array.from({ length: 100 }, (_, i) => Buffer.alloc(640, i));
    for (const [i, chunk] of chunks.entries()) {
      conn.record('out', {
        type: 'wire.send',
        attemptId: String(i),
        event: {
          type: 'input_audio_buffer.append',
          audio: chunk.toString('base64'),
        },
      });
      conn.record('local', {
        type: 'wire.send_result',
        attemptId: String(i),
        status: i === 50 ? 'threw' : 'sent',
      });
    }
    conn.record('in', {
      type: 'wire.receive',
      event: {
        type: 'response.audio.delta',
        delta: Buffer.from([1, 2, 3, 4]).toString('base64'),
      },
    });
    conn.close('transport ended');
    conn.record('out', { ignored: true });
    await value.close();
    const rows = await events(value);
    const outgoing = rows.filter((row) => row.direction === 'out');
    expect(outgoing).toHaveLength(100);
    for (const [i, row] of outgoing.entries()) {
      const ref = wire(row)['audio'] as DebugArchiveMediaRef;
      expect(ref).toMatchObject({
        $media: `media/${conn.id}-input.pcm`,
        byteOffset: i * 640,
        bytes: 640,
        encoding: 'base64',
        kind: 'audio',
      });
      expect(await media(value, ref)).toEqual(chunks[i]);
    }
    expect(await readdir(join(value.path, 'media'))).toHaveLength(2);
    const input = await readFile(
      join(value.path, 'media', `${conn.id}-input.pcm`),
    );
    expect(input).toEqual(Buffer.concat(chunks));
    expect(JSON.stringify(rows)).not.toContain(chunks[20]!.toString('base64'));
    expect(rows.some((row) => (row.event as Json)['status'] === 'threw')).toBe(
      true,
    );
  });

  it('deduplicates images, recognizes Host capture/ContentBlock media, and snapshots mutable binary buffers', async () => {
    const value = archive();
    const main = value.beginConnection({ kind: 'visual' });
    const png = Buffer.from(PNG);
    const binary = Uint8Array.from([4, 5, 6]);
    main.record('out', {
      type: 'wire.send',
      event: {
        type: 'input_image_buffer.append',
        image: JPEG.toString('base64'),
      },
    });
    main.record('local', {
      source: 'screen',
      width: 1920,
      height: 1080,
      image: JPEG.toString('base64'),
    });
    value.recordRuntime('capture', {
      jpegBase64: JPEG.toString('base64'),
      block: { type: 'image', mimeType: 'image/png', data: png },
      bytes: binary,
    });
    png.fill(0);
    binary.fill(0);
    await value.close();
    const rows = await events(value);
    const first = wire(rows.find((row) => row.direction === 'out')!)[
      'image'
    ] as DebugArchiveMediaRef;
    const capture = rows.find(
      (row) => (row.event as Json)['source'] === 'screen',
    )!.event as Json;
    expect(capture['image']).toEqual(first);
    const runtime = (
      rows.find((row) => (row.event as Json)['type'] === 'capture')!
        .event as Json
    )['payload'] as Json;
    expect(runtime['jpegBase64']).toEqual(first);
    const pngRef = (runtime['block'] as Json)['data'] as DebugArchiveMediaRef;
    expect(pngRef.$media.endsWith('.png')).toBe(true);
    expect(pngRef.encoding).toBe('uint8array');
    expect(await media(value, pngRef)).toEqual(PNG);
    expect(
      await media(value, runtime['bytes'] as DebugArchiveMediaRef),
    ).toEqual(Buffer.from([4, 5, 6]));
    expect(await readdir(join(value.path, 'media'))).toHaveLength(3);
  });

  it('preserves malformed media and raw arguments instead of dropping the diagnostic event', async () => {
    const value = archive();
    const conn = value.beginConnection({ kind: 'main' });
    const invalid = 'this is not base64 \n!';
    const nonCanonical = 'AR==';
    conn.record('out', {
      type: 'wire.send',
      event: { type: 'input_audio_buffer.append', audio: invalid },
    });
    conn.record('in', {
      type: 'wire.receive',
      event: { type: 'response.audio.delta', delta: nonCanonical },
    });
    conn.record('local', {
      type: 'function_call_output',
      output: '{"audio":"AQI=","arguments":"unterminated',
    });
    await value.close();
    const rows = await events(value);
    expect(wire(rows.find((row) => row.direction === 'out')!)['audio']).toBe(
      invalid,
    );
    expect(wire(rows.find((row) => row.direction === 'in')!)['delta']).toBe(
      nonCanonical,
    );
    expect(
      rows.find((row) => (row.event as Json)['type'] === 'function_call_output')
        ?.event,
    ).toMatchObject({ output: '{"audio":"AQI=","arguments":"unterminated' });
    expect(await readdir(join(value.path, 'media'))).toEqual([]);
    expect(await manifest(value)).toMatchObject({
      incomplete: false,
      counters: { invalidMediaValues: 2 },
    });
  });

  it('redacts keys, headers, camel-case tokens, URL credentials, nested JSON secrets, and known values without damaging tool schemas or usage', async () => {
    const secret = 'known-fixture-key';
    const other = 'unknown-controller-value';
    const value = archive({
      secrets: [secret],
      metadata: {
        effectiveConfig: {
          realtimeApiKey: secret,
          backends: [{ peerDiscovery: { controllerToken: other } }],
          authToken: 'unknown-auth-value',
          endpoint:
            'https://user:privatepass@example.invalid/v1?token=query-value',
        },
      },
    });
    const conn = value.beginConnection({
      kind: 'main',
      endpoint: `https://user:privatepass@example.invalid?api_key=${secret}`,
    });
    conn.record('out', {
      type: 'wire.send',
      headers: {
        Authorization: 'Bearer opaque-header-token',
        'X-Private': 'header-only-secret',
      },
      event: {
        type: 'session.update',
        session: {
          instructions: `Keep this instruction, except ${secret}.`,
          tools: [
            {
              function: {
                parameters: {
                  properties: {
                    apiKey: {
                      type: 'string',
                      description: 'Preserve this JSON schema',
                    },
                    headers: { type: 'object', description: 'Headers schema' },
                  },
                },
              },
            },
          ],
        },
      },
    });
    conn.record('local', {
      input_tokens: 12,
      output_tokens: 3,
      controllerToken: other,
      output: '{"authToken":"nested-value","title":"keep-title"}',
      error: new Error(`PRIVATE ${secret}`),
    });
    await value.close();
    const saved = JSON.stringify([await manifest(value), await events(value)]);
    for (const credential of [
      secret,
      other,
      'unknown-auth-value',
      'privatepass',
      'query-value',
      'opaque-header-token',
      'header-only-secret',
      'nested-value',
    ])
      expect(saved).not.toContain(credential);
    expect(saved).toContain('Preserve this JSON schema');
    expect(saved).toContain('Headers schema');
    expect(saved).toContain('keep-title');
    expect(saved).toContain('"input_tokens":12');
    expect(await manifest(value)).toMatchObject({
      incomplete: false,
      redacted: true,
      redaction: { media: 'not-inspected' },
    });
    expect(
      (await events(value)).filter((row) => row.redacted).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('marks queue overflow incomplete while draining previously accepted tails', async () => {
    const warnings = vi.fn(() => {
      throw new Error('logging failure');
    });
    const value = archive({ maxQueuedBytes: 2048, onWarning: warnings });
    const conn = value.beginConnection({ kind: 'main' });
    conn.record('local', { type: 'keep', text: 'Accepted before overflow' });
    expect(() =>
      conn.record('local', { type: 'too-big', text: 'x'.repeat(10000) }),
    ).not.toThrow();
    conn.record('local', { type: 'after-limit' });
    await expect(value.close()).resolves.toBeUndefined();
    expect(
      (await events(value)).some(
        (row) => (row.event as Json)['type'] === 'keep',
      ),
    ).toBe(true);
    expect(
      (await events(value)).some(
        (row) => (row.event as Json)['type'] === 'too-big',
      ),
    ).toBe(false);
    const saved = await manifest(value);
    expect(saved).toMatchObject({
      status: 'incomplete',
      incomplete: true,
      counters: { queuedBytes: 0 },
    });
    expect((saved['counters'] as Json)['queuedHighWater']).toBeLessThanOrEqual(
      2048,
    );
    expect(warnings).toHaveBeenCalledOnce();
  });

  it('enforces the run byte cap including the manifest reserve, without silently growing files', async () => {
    const value = archive({ maxBytes: 32768, maxQueuedBytes: 128 * 1024 });
    const conn = value.beginConnection({ kind: 'main' });
    for (let i = 0; i < 20; i++)
      conn.record('out', {
        type: 'input_audio_buffer.append',
        audio: Buffer.alloc(4000, i).toString('base64'),
      });
    await value.close();
    const saved = await manifest(value);
    expect(saved).toMatchObject({
      status: 'incomplete',
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'run_limit' }),
      ]),
    });
    let total = 0;
    for (const name of await readdir(value.path)) {
      const path = join(value.path, name);
      const info = await lstat(path);
      if (info.isFile()) total += info.size;
      if (info.isDirectory())
        for (const file of await readdir(path))
          total += (await lstat(join(path, file))).size;
    }
    expect(total).toBeLessThanOrEqual(32768);
    expect((saved['counters'] as Json)['droppedEvents']).toBeGreaterThan(0);
  });

  it('fails closed on cyclic/unserializable events without rejecting application execution', async () => {
    for (const event of [
      1n,
      (() => {
        const x: Json = {};
        x['self'] = x;
        return x;
      })(),
    ]) {
      const value = archive();
      value.recordRuntime('before', { safe: true });
      expect(() => value.recordRuntime('bad', event)).not.toThrow();
      await value.close();
      expect(await manifest(value)).toMatchObject({ incomplete: true });
      expect(
        (await events(value)).some(
          (row) => (row.event as Json)['type'] === 'before',
        ),
      ).toBe(true);
    }
  });

  it('does not follow a symlink root or alter its target', async () => {
    const target = join(temporary, 'outside');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, root);
    const warning = vi.fn();
    const value = archive({ onWarning: warning });
    value.recordRuntime('event', { value: 'data' });
    await value.close();
    expect(await readdir(target)).toEqual([]);
    expect(value.isIncomplete).toBe(true);
    expect(warning).toHaveBeenCalled();
  });

  it('rejects a publicly readable archive root instead of changing its permissions', async () => {
    await mkdir(root, { mode: 0o755 });
    await chmod(root, 0o755);
    const value = archive();
    await value.close();
    expect(value.isIncomplete).toBe(true);
    expect((await lstat(root)).mode & 0o077).not.toBe(0);
    expect(await readdir(root)).toEqual([]);
  });

  it('marks a replaced events symlink incomplete and never appends to the external target', async () => {
    const value = archive();
    const conn = value.beginConnection({ kind: 'main' });
    await value.flush();
    const outside = join(temporary, 'outside-file');
    await writeFile(outside, 'untouched', { mode: 0o600 });
    await rename(
      join(value.path, 'events.jsonl'),
      join(value.path, 'events-before.jsonl'),
    );
    await symlink(outside, join(value.path, 'events.jsonl'));
    conn.record('local', { type: 'first queued after replacement' });
    conn.record('local', { type: 'second queued tail' });
    await value.close();
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    expect(await manifest(value)).toMatchObject({
      incomplete: true,
      counters: { queuedBytes: 0 },
    });
  });

  it('refuses preplanted PCM symlinks and detects corrupt deduplicated images', async () => {
    const value = archive();
    const conn = value.beginConnection({ kind: 'main' });
    await value.flush();
    const outside = join(temporary, 'audio-target');
    await writeFile(outside, 'original', { mode: 0o600 });
    await symlink(outside, join(value.path, 'media', `${conn.id}-input.pcm`));
    conn.record('out', {
      type: 'input_audio_buffer.append',
      audio: 'AQIDBA==',
    });
    await value.close();
    expect(await readFile(outside, 'utf8')).toBe('original');
    expect(value.isIncomplete).toBe(true);
    const images = archive();
    const source = images.beginConnection({ kind: 'visual' });
    source.record('out', {
      type: 'input_image_buffer.append',
      image: JPEG.toString('base64'),
    });
    await images.flush();
    const row = (await events(images)).find((row) => row.direction === 'out')!;
    const ref = (row.event as Json)['image'] as DebugArchiveMediaRef;
    await writeFile(
      join(images.path, ref.$media),
      Buffer.alloc(JPEG.length, 9),
    );
    source.record('out', {
      type: 'input_image_buffer.append',
      image: JPEG.toString('base64'),
    });
    await images.close();
    expect(await manifest(images)).toMatchObject({
      incomplete: true,
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'media_integrity_failed' }),
      ]),
    });
  });

  it('retains the latest finished runs, including incomplete/crashed ones, without deleting live or foreign data', async () => {
    const active = archive({ retainRuns: 2 });
    await active.flush();
    const old: DebugArchive[] = [];
    for (let i = 0; i < 3; i++) {
      const value = archive({ retainRuns: 2 });
      await value.close();
      old.push(value);
    }
    await expect(lstat(old[0]!.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(active.path)).isDirectory()).toBe(true);
    const crashed = old[1]!;
    const marker = await manifest(crashed);
    delete marker['closedAt'];
    marker['pid'] = 2147483647;
    marker['status'] = 'recording';
    await writeFile(
      join(crashed.path, 'manifest.json'),
      JSON.stringify(marker),
      { mode: 0o600 },
    );
    const foreign = join(root, `run-1-${randomUUID()}`);
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(
      join(foreign, 'manifest.json'),
      JSON.stringify({ format: 'different-owner' }),
      { mode: 0o600 },
    );
    const latest = archive({ retainRuns: 2 });
    await latest.close();
    await expect(lstat(crashed.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(foreign)).isDirectory()).toBe(true);
    expect((await lstat(active.path)).isDirectory()).toBe(true);
  });

  it('makes close idempotent, ignores new recording afterwards, and creates no per-frame files', async () => {
    const value = archive();
    const conn = value.beginConnection({
      kind: 'main',
      id: '../../unsafe-name',
    });
    conn.record('out', { type: 'input_audio_buffer.append', audio: 'AQI=' });
    const close = value.close();
    expect(value.close()).toBe(close);
    await close;
    const before = await readFile(join(value.path, 'events.jsonl'), 'utf8');
    conn.record('in', { ignored: true });
    value.recordRuntime('ignored', {});
    value
      .beginConnection({ kind: 'visual' })
      .record('local', { ignored: true });
    await value.flush();
    expect(await readFile(join(value.path, 'events.jsonl'), 'utf8')).toBe(
      before,
    );
    expect(await readdir(join(value.path, 'media'))).toEqual([
      `${conn.id}-input.pcm`,
    ]);
    expect(basename(value.path)).toMatch(/^run-\d+-[a-f0-9-]{36}$/);
  });
});
