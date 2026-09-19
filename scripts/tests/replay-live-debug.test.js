/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  exportArchive,
  inspectArchive,
  parseArgs,
} from '../replay-live-debug.mjs';
import { DebugArchive } from '../../packages/qwen-live-harness/src/log/debug-archive.ts';

const temporaryDirectories = [];
const script = path.resolve('scripts/replay-live-debug.mjs');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'live-debug-replay-test-'),
  );
  temporaryDirectories.push(directory);
  const run = path.join(directory, 'run');
  await mkdir(path.join(run, 'media'), { recursive: true });
  const bytes = Buffer.from([0, 0, 11, 0, 22, 0, 33, 0]);
  const mediaPath = 'media/conn-000001-input.pcm';
  await writeFile(
    path.join(run, mediaPath),
    Buffer.concat([Buffer.from([99, 99]), bytes, Buffer.from([88, 88])]),
  );
  const reference = {
    $media: mediaPath,
    byteOffset: 2,
    bytes: bytes.length,
    sha256: sha256(bytes),
    encoding: 'base64',
    kind: 'audio',
  };
  const records = [];
  const sequences = new Map();
  const add = (
    direction,
    event,
    connectionId = 'conn-000001',
    kind = 'main',
  ) => {
    const connectionSeq = (sequences.get(connectionId) ?? 0) + 1;
    sequences.set(connectionId, connectionSeq);
    const row = {
      globalSeq: records.length + 1,
      connectionSeq,
      connectionId,
      kind,
      wallTime: '2026-09-19T01:00:00.000Z',
      wallTimeMs: 1789779600000,
      monotonicNs: String(records.length + 1000),
      direction,
      event,
    };
    records.push(row);
    return row;
  };
  add('local', {
    type: 'archive.connection_registered',
    kind: 'main',
    model: 'qwen-test-realtime',
    endpoint: 'wss://example.invalid/?token=PRIVATE_ENDPOINT',
    taskId: 'private-task-title',
    session: { instructions: 'SNAPSHOT_NOT_A_SECOND_SEND' },
  });
  const send = (attemptId, event, status = 'sent') => {
    const row = add('out', { type: 'wire.send', attemptId, event });
    if (status) add('local', { type: 'wire.send_result', attemptId, status });
    return row;
  };
  send('send-1', {
    type: 'session.update',
    session: { instructions: 'PRIVATE_PROMPT', tools: [] },
  });
  const mediaRow = send('send-2', {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'PRIVATE_QUERY' },
        { type: 'input_audio', audio: reference },
      ],
    },
  });
  send('send-3', { type: 'response.create' });
  add('in', {
    type: 'wire.receive',
    binary: false,
    event: {
      type: 'response.done',
      response: {
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'text', text: 'PRIVATE_ANSWER' }],
          },
        ],
      },
    },
  });
  const manifest = {
    format: 'qwen-live-harness-debug-v1',
    status: 'closed',
    incomplete: false,
    warnings: [],
    files: { events: 'events.jsonl', media: 'media' },
    counters: {},
    connections: {
      count: 1,
      index: 'events.jsonl',
      registrationType: 'archive.connection_registered',
    },
  };
  const flush = async () => {
    manifest.counters = {
      recordedEvents: records.length,
      writtenEvents: records.length,
      droppedEvents: 0,
      lastGlobalSeq: records.at(-1)?.globalSeq ?? 0,
      dataBytes: 0,
    };
    await writeFile(path.join(run, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(
      path.join(run, 'events.jsonl'),
      records.map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
  };
  await flush();
  return {
    directory,
    run,
    bytes,
    reference,
    records,
    manifest,
    add,
    send,
    mediaRow,
    flush,
  };
}

describe('offline debug archive inspector', () => {
  it('inspects and exports the actual archive writer format without any model or device call', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'live-debug-writer-test-'),
    );
    temporaryDirectories.push(directory);
    const writer = new DebugArchive({
      directory: path.join(directory, 'debug'),
      metadata: { apiKey: 'TEST_SECRET', context: 'PRIVATE_CONTEXT' },
      secrets: ['TEST_SECRET'],
    });
    const connection = writer.beginConnection({
      kind: 'monitor',
      model: 'synthetic-test',
      taskId: 'PRIVATE_TASK',
    });
    const pcm = Buffer.from([0, 0, 1, 0, 2, 0]);
    connection.record('out', {
      type: 'wire.send',
      attemptId: 'send-1',
      event: {
        type: 'input_audio_buffer.append',
        audio: pcm.toString('base64'),
      },
    });
    connection.record('local', {
      type: 'wire.send_result',
      attemptId: 'send-1',
      status: 'sent',
    });
    connection.record('in', {
      type: 'wire.receive',
      binary: false,
      event: {
        type: 'input_audio_buffer.committed',
        item_id: 'synthetic-item',
      },
    });
    await writer.close();
    const result = await inspectArchive(writer.path);
    expect(result).toMatchObject({
      complete: true,
      integrity: 'verified',
      mediaSegmentsVerified: 1,
    });
    expect(
      result.connections.find((entry) => entry.connectionId === connection.id)
        .state,
    ).toBe('closed');
    expect(JSON.stringify(result)).not.toMatch(
      /TEST_SECRET|PRIVATE_CONTEXT|PRIVATE_TASK/u,
    );
    const output = path.join(directory, 'export');
    await exportArchive(writer.path, connection.id, output);
    const requests = JSON.parse(
      await readFile(path.join(output, 'requests.json'), 'utf8'),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].event.audio).toBe(pcm.toString('base64'));
  });

  it('verifies sequence, send outcomes and exact media ranges without printing private contents', async () => {
    const f = await fixture();
    const report = await inspectArchive(f.run);
    expect(report.complete).toBe(true);
    expect(report.integrity).toBe('verified');
    expect(report.connections).toMatchObject([
      {
        connectionId: 'conn-000001',
        kind: 'main',
        model: 'qwen-test-realtime',
        outbound: 3,
        inbound: 1,
        sent: 3,
        threw: 0,
        unconfirmed: 0,
        mediaReferences: 1,
      },
    ]);
    expect(JSON.stringify(report)).not.toMatch(
      /PRIVATE_|private-task|SNAPSHOT_/u,
    );
    const cli = spawnSync(process.execPath, [script, f.run], {
      encoding: 'utf8',
      env: { ...process.env, DASHSCOPE_API_KEY: 'DO_NOT_READ_OR_UPLOAD' },
    });
    expect(cli.status).toBe(0);
    expect(cli.stdout).not.toMatch(
      /PRIVATE_|DO_NOT_READ|private-task|SNAPSHOT_/u,
    );
    expect(JSON.parse(cli.stdout).offlineOnly).toBe(true);
    expect(cli.stderr).toBe('');
  });

  it('lists independent connections and runtime without inventing a model session', async () => {
    const f = await fixture();
    f.add(
      'local',
      {
        type: 'archive.connection_registered',
        kind: 'monitor',
        model: 'test-monitor',
      },
      'conn-000002',
      'monitor',
    );
    f.add(
      'local',
      { type: 'runtime.example', text: 'PRIVATE_RUNTIME' },
      'runtime',
      'runtime',
    );
    await f.flush();
    const report = await inspectArchive(f.run);
    expect(
      report.connections.map(({ connectionId, kind }) => [connectionId, kind]),
    ).toEqual([
      ['conn-000001', 'main'],
      ['conn-000002', 'monitor'],
      ['runtime', 'runtime'],
    ]);
    expect(report.complete).toBe(true);
  });

  it('lists validated provider session IDs and counts unique responses per connection', async () => {
    const f = await fixture();
    f.add('in', {
      type: 'wire.receive',
      event: { type: 'session.created', session: { id: 'sess_primary_1' } },
    });
    f.add('in', {
      type: 'wire.receive',
      event: { type: 'session.updated', session: { id: 'sess_primary_1' } },
    });
    f.add('in', {
      type: 'wire.receive',
      event: {
        type: 'session.updated',
        session: { id: 'INVALID PRIVATE SESSION TEXT' },
      },
    });
    f.add('in', {
      type: 'wire.receive',
      event: { type: 'session.updated', session: { id: 'x'.repeat(257) } },
    });
    f.add('in', {
      type: 'wire.receive',
      event: { type: 'response.created', response: { id: 'resp_1' } },
    });
    f.add('in', {
      type: 'wire.receive',
      event: {
        type: 'response.done',
        response: { id: 'resp_1', status: 'completed' },
      },
    });
    f.add('in', {
      type: 'wire.receive',
      event: {
        type: 'response.done',
        response: { id: 'resp_2', status: 'cancelled' },
      },
    });
    f.add(
      'local',
      { type: 'archive.connection_registered', kind: 'monitor' },
      'conn-000002',
      'monitor',
    );
    f.add(
      'in',
      {
        type: 'wire.receive',
        event: { type: 'session.created', session: { id: 'sess_monitor_2' } },
      },
      'conn-000002',
      'monitor',
    );
    await f.flush();
    const report = await inspectArchive(f.run);
    expect(report.connections[0]).toMatchObject({
      providerSessionIds: ['sess_primary_1'],
      responseCount: 2,
    });
    expect(report.connections[1]).toMatchObject({
      providerSessionIds: ['sess_monitor_2'],
      responseCount: 0,
    });
    expect(JSON.stringify(report)).not.toMatch(
      /INVALID PRIVATE|resp_1|resp_2/u,
    );
  });

  it('keeps unknown sends and thrown writes distinct from confirmed socket sends', async () => {
    const f = await fixture();
    f.send('send-threw', { type: 'response.cancel' }, 'threw');
    f.send('send-unknown', { type: 'response.create' }, undefined);
    // undefined selects the helper default; explicitly remove the outcome.
    f.records.pop();
    await f.flush();
    const report = await inspectArchive(f.run);
    expect(report.connections[0]).toMatchObject({
      sent: 3,
      threw: 1,
      unconfirmed: 1,
    });
    expect(report.complete).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'send_outcome_unknown',
        severity: 'warning',
      }),
    );
  });

  it('reports recording/incomplete manifests without claiming a complete capture', async () => {
    const f = await fixture();
    f.manifest.status = 'recording';
    await f.flush();
    expect((await inspectArchive(f.run)).complete).toBe(false);
    f.manifest.status = 'incomplete';
    f.manifest.incomplete = true;
    f.manifest.warnings.push({
      code: 'disk_limit',
      message: 'PRIVATE_WARNING',
      at: 'now',
    });
    await f.flush();
    const result = await inspectArchive(f.run);
    expect(result).toMatchObject({
      complete: false,
      integrity: 'verified',
      manifestWarningCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_WARNING');
  });

  it('flags truncated wire data even if the manifest could not record the warning', async () => {
    const f = await fixture();
    f.add('in', {
      type: 'wire.receive',
      event: {
        raw: {
          kind: 'text',
          encoding: 'utf8',
          data: 'PRIVATE_PREFIX',
          bytes: 200000,
          truncated: true,
        },
      },
    });
    await f.flush();
    const report = await inspectArchive(f.run);
    expect(report.complete).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'wire_frame_truncated',
        severity: 'warning',
      }),
    );
    expect(JSON.stringify(report)).not.toContain('PRIVATE_PREFIX');
  });

  it('flags hash corruption and refuses to export before creating output', async () => {
    const f = await fixture();
    await writeFile(path.join(f.run, f.reference.$media), Buffer.alloc(100));
    expect((await inspectArchive(f.run)).issues).toContainEqual(
      expect.objectContaining({ code: 'media_hash_mismatch' }),
    );
    const destination = path.join(f.directory, 'export');
    await expect(
      exportArchive(f.run, 'conn-000001', destination),
    ).rejects.toThrow('archive_integrity_failed');
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    '../outside.pcm',
    '/etc/passwd',
    'media/../../outside.pcm',
    'media\\outside.pcm',
    'media/./audio.pcm',
    'media//audio.pcm',
  ])('rejects unsafe media paths: %s', async (unsafePath) => {
    const f = await fixture();
    f.reference.$media = unsafePath;
    await f.flush();
    const report = await inspectArchive(f.run);
    expect(report.integrity).toBe('failed');
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'unsafe_archive_path' }),
    );
  });

  it('rejects symlinks in media, nested directories, and event files', async () => {
    const f = await fixture();
    const target = path.join(f.directory, 'target.pcm');
    await writeFile(target, f.bytes);
    await symlink(target, path.join(f.run, 'media', 'linked.pcm'));
    f.reference.$media = 'media/linked.pcm';
    f.reference.byteOffset = 0;
    await f.flush();
    expect((await inspectArchive(f.run)).issues).toContainEqual(
      expect.objectContaining({ code: 'archive_symlink_or_nonregular_file' }),
    );
    await symlink(f.directory, path.join(f.run, 'media', 'linked-dir'));
    f.reference.$media = 'media/linked-dir/target.pcm';
    await f.flush();
    expect((await inspectArchive(f.run)).issues).toContainEqual(
      expect.objectContaining({ code: 'archive_symlink_or_nonregular_file' }),
    );
    await rm(path.join(f.run, 'events.jsonl'));
    await symlink(target, path.join(f.run, 'events.jsonl'));
    await expect(inspectArchive(f.run)).rejects.toThrow(
      'archive_symlink_or_nonregular_file',
    );
  });

  it.each([
    { byteOffset: -1 },
    { bytes: -1 },
    { bytes: 200 },
    { byteOffset: Number.MAX_SAFE_INTEGER, bytes: 8 },
    { encoding: 'invented' },
    { sha256: 'invalid' },
  ])(
    'rejects invalid or out-of-bounds media references: %j',
    async (change) => {
      const f = await fixture();
      Object.assign(f.reference, change);
      await f.flush();
      expect((await inspectArchive(f.run)).integrity).toBe('failed');
    },
  );

  it('reports invalid JSON and event order without reflecting raw input', async () => {
    const f = await fixture();
    f.records[2].globalSeq = 1;
    await f.flush();
    await writeFile(
      path.join(f.run, 'events.jsonl'),
      '\nPRIVATE_TRUNCATED_JSON',
      { flag: 'a' },
    );
    const report = await inspectArchive(f.run);
    expect(report.integrity).toBe('failed');
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'global_sequence_not_increasing',
        'event_invalid_json',
      ]),
    );
    expect(JSON.stringify(report)).not.toContain('PRIVATE_TRUNCATED_JSON');
  });
});

describe('offline connection export', () => {
  it('restores base64 and only referenced bytes without multiplying session snapshots', async () => {
    const f = await fixture();
    const destination = path.join(f.directory, 'export');
    const report = await exportArchive(f.run, 'conn-000001', destination);
    expect(report).toMatchObject({
      exported: true,
      requestCount: 3,
      responseCount: 1,
      offlineOnly: true,
    });
    const requests = JSON.parse(
      await readFile(path.join(destination, 'requests.json'), 'utf8'),
    );
    expect(requests.map((row) => row.event.type)).toEqual([
      'session.update',
      'conversation.item.create',
      'response.create',
    ]);
    expect(requests[1].event.item.content[1].audio).toBe(
      f.bytes.toString('base64'),
    );
    expect(requests[2].event).toEqual({ type: 'response.create' });
    expect(requests.every((row) => row.sendStatus === 'sent')).toBe(true);
    expect(JSON.stringify(requests)).not.toContain(
      'SNAPSHOT_NOT_A_SECOND_SEND',
    );
    const records = (
      await readFile(path.join(destination, 'events.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const reference = records.find(
      (row) =>
        row.event.attemptId === 'send-2' && row.event.type === 'wire.send',
    ).event.event.item.content[1].audio;
    expect(reference.byteOffset).toBe(0);
    expect(await readFile(path.join(destination, reference.$media))).toEqual(
      f.bytes,
    );
    expect((await stat(destination)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(path.join(destination, 'requests.json'))).mode & 0o777,
    ).toBe(0o600);
    const manifest = JSON.parse(
      await readFile(path.join(destination, 'manifest.json'), 'utf8'),
    );
    expect(manifest.sourceEventsSha256).toBe(
      sha256(await readFile(path.join(f.run, 'events.jsonl'))),
    );
  });

  it.each([0, 1, 2, 65535, 65536, 65537, 65538, 131071, 131073])(
    'restores %i media bytes exactly across streaming base64 boundaries',
    async (size) => {
      const f = await fixture();
      const bytes = Buffer.alloc(size);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = index % 251;
      }
      await writeFile(
        path.join(f.run, f.reference.$media),
        Buffer.concat([Buffer.from([99, 99]), bytes, Buffer.from([88, 88])]),
      );
      f.reference.bytes = bytes.length;
      f.reference.sha256 = sha256(bytes);
      await f.flush();
      const destination = path.join(f.directory, 'export');
      await exportArchive(f.run, 'conn-000001', destination);
      const requests = JSON.parse(
        await readFile(path.join(destination, 'requests.json'), 'utf8'),
      );
      expect(requests[1].event.item.content[1].audio).toBe(
        bytes.toString('base64'),
      );
      expect(
        await readFile(path.join(destination, 'media', '000001.pcm')),
      ).toEqual(bytes);
    },
  );

  it('exports hydrated media larger than the process heap without whole-run JSON allocation', async () => {
    const f = await fixture();
    const mediaBytes = 64 * 1024 * 1024 + 7;
    const block = Buffer.alloc(64 * 1024, 0x5a);
    const checksum = createHash('sha256');
    const mediaFile = await open(path.join(f.run, f.reference.$media), 'w');
    try {
      let remaining = mediaBytes;
      while (remaining > 0) {
        const chunk = block.subarray(0, Math.min(block.length, remaining));
        checksum.update(chunk);
        await mediaFile.writeFile(chunk);
        remaining -= chunk.length;
      }
    } finally {
      await mediaFile.close();
    }
    Object.assign(f.reference, {
      byteOffset: 0,
      bytes: mediaBytes,
      sha256: checksum.digest('hex'),
    });
    await f.flush();
    const destination = path.join(f.directory, 'export');
    const result = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=64',
        script,
        f.run,
        '--connection',
        'conn-000001',
        '--output',
        destination,
      ],
      { encoding: 'utf8', timeout: 20000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      exported: true,
      integrity: 'verified',
      requestCount: 3,
      mediaSegmentsVerified: 1,
    });
    expect(
      (await stat(path.join(destination, 'requests.json'))).size,
    ).toBeGreaterThan(64 * 1024 * 1024);
    expect(
      (await stat(path.join(destination, 'media', '000001.pcm'))).size,
    ).toBe(mediaBytes);
  }, 30000);

  it('exports a main-session function call as inert data without executing it', async () => {
    const f = await fixture();
    const marker = path.join(f.directory, 'must-not-exist');
    f.add('in', {
      type: 'wire.receive',
      binary: false,
      event: {
        type: 'response.done',
        response: {
          output: [
            {
              type: 'function_call',
              name: 'exec',
              call_id: 'call_1',
              arguments: JSON.stringify({ command: `touch ${marker}` }),
            },
          ],
        },
      },
    });
    f.send('receipt', {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'not executed',
      },
    });
    await f.flush();
    const destination = path.join(f.directory, 'export');
    const report = await exportArchive(f.run, 'conn-000001', destination);
    expect(report.connections[0].toolEvents).toBe(2);
    expect(
      await readFile(path.join(destination, 'responses.json'), 'utf8'),
    ).toContain('function_call');
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves raw strings and marks restored byte arrays explicitly as binary', async () => {
    const f = await fixture();
    const bytes = Buffer.from([0xff, 0, 0x81, 0x7f]);
    await writeFile(path.join(f.run, 'media', 'raw.bin'), bytes);
    f.add('in', {
      type: 'wire.receive',
      binary: true,
      event: {
        $media: 'media/raw.bin',
        byteOffset: 0,
        bytes: bytes.length,
        sha256: sha256(bytes),
        encoding: 'uint8array',
        kind: 'binary',
      },
    });
    f.add('in', {
      type: 'wire.receive',
      binary: false,
      event: 'not JSON: AAAB',
    });
    await f.flush();
    const destination = path.join(f.directory, 'export');
    await exportArchive(f.run, 'conn-000001', destination);
    const responses = JSON.parse(
      await readFile(path.join(destination, 'responses.json'), 'utf8'),
    );
    expect(responses.at(-2)).toMatchObject({
      binary: true,
      event: { $binary: bytes.toString('base64'), encoding: 'base64' },
    });
    expect(responses.at(-1)).toMatchObject({
      binary: false,
      event: 'not JSON: AAAB',
    });
  });

  it('exports only the selected connection and leaves the original archive untouched', async () => {
    const f = await fixture();
    f.add(
      'local',
      {
        type: 'archive.connection_registered',
        kind: 'search',
        model: 'test-search',
      },
      'conn-000002',
      'search',
    );
    f.add(
      'out',
      {
        type: 'wire.send',
        attemptId: 'search-send',
        event: {
          type: 'session.update',
          session: { instructions: 'OTHER_CONNECTION_PRIVATE' },
        },
      },
      'conn-000002',
      'search',
    );
    f.add(
      'local',
      { type: 'wire.send_result', attemptId: 'search-send', status: 'sent' },
      'conn-000002',
      'search',
    );
    await f.flush();
    const original = await readFile(path.join(f.run, 'events.jsonl'));
    const destination = path.join(f.directory, 'export');
    await exportArchive(f.run, 'conn-000001', destination);
    expect(await readFile(path.join(f.run, 'events.jsonl'))).toEqual(original);
    for (const file of [
      'requests.json',
      'responses.json',
      'events.jsonl',
      'manifest.json',
    ]) {
      expect(
        await readFile(path.join(destination, file), 'utf8'),
      ).not.toContain('OTHER_CONNECTION_PRIVATE');
    }
  });

  it('preserves explicit redaction flags in exported requests, responses and manifest', async () => {
    const f = await fixture();
    f.manifest.redacted = true;
    f.mediaRow.redacted = true;
    f.records.find((row) => row.event.type === 'wire.receive').event.redacted =
      true;
    await f.flush();
    const destination = path.join(f.directory, 'export');
    await exportArchive(f.run, 'conn-000001', destination);
    expect(
      JSON.parse(
        await readFile(path.join(destination, 'requests.json'), 'utf8'),
      )[1].redacted,
    ).toBe(true);
    expect(
      JSON.parse(
        await readFile(path.join(destination, 'responses.json'), 'utf8'),
      )[0].redacted,
    ).toBe(true);
    expect(
      JSON.parse(
        await readFile(path.join(destination, 'manifest.json'), 'utf8'),
      ).redacted,
    ).toBe(true);
  });

  it('never overwrites an existing output or writes into its source archive', async () => {
    const f = await fixture();
    const destination = path.join(f.directory, 'existing');
    await mkdir(destination);
    await writeFile(path.join(destination, 'marker'), 'keep');
    await expect(
      exportArchive(f.run, 'conn-000001', destination),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path.join(destination, 'marker'), 'utf8')).toBe(
      'keep',
    );
    await expect(
      exportArchive(f.run, 'conn-000001', path.join(f.run, 'export')),
    ).rejects.toThrow('output_must_be_outside_archive');
    await expect(
      exportArchive(f.run, 'not-real', path.join(f.directory, 'absent')),
    ).rejects.toThrow('connection_not_found');
  });

  it('keeps incomplete exports explicitly incomplete and preserves failed sends', async () => {
    const f = await fixture();
    f.manifest.status = 'incomplete';
    f.manifest.incomplete = true;
    f.send('send-threw', { type: 'response.create' }, 'threw');
    f.send(
      'send-failed-or-uncertain',
      { type: 'response.create' },
      'failed_or_uncertain',
    );
    await f.flush();
    const destination = path.join(f.directory, 'export');
    await exportArchive(f.run, 'conn-000001', destination);
    const manifest = JSON.parse(
      await readFile(path.join(destination, 'manifest.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({
      complete: false,
      sourceStatus: 'incomplete',
      offlineOnly: true,
    });
    const requests = JSON.parse(
      await readFile(path.join(destination, 'requests.json'), 'utf8'),
    );
    expect(requests.at(-2).sendStatus).toBe('threw');
    expect(requests.at(-1).sendStatus).toBe('failed_or_uncertain');
  });
});

describe('offline-only CLI contract', () => {
  it('requires an explicit connection and output together and rejects network flags', () => {
    expect(parseArgs(['archive'])).toEqual({ directory: 'archive' });
    expect(
      parseArgs([
        'archive',
        '--connection',
        'conn-000001',
        '--output',
        'export',
      ]),
    ).toEqual({
      directory: 'archive',
      connection: 'conn-000001',
      output: 'export',
    });
    for (const args of [
      [],
      ['archive', '--live'],
      ['archive', '--allow-upload'],
      ['archive', '--endpoint', 'wss://bad.invalid'],
      ['archive', '--connection', 'conn-000001'],
      ['archive', '--output', 'export'],
    ])
      expect(() => parseArgs(args)).toThrow();
    const help = spawnSync(process.execPath, [script, '--help'], {
      encoding: 'utf8',
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Live/network replay is not implemented');
    expect(help.stdout).toContain('cannot guarantee identical');
  });
});
