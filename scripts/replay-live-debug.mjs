/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const FORMAT = 'qwen-live-harness-debug-v1';
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_MEDIA_BYTES = 128 * 1024 * 1024;
const IO_CHUNK_BYTES = 64 * 1024;
const USAGE = `Usage: node scripts/replay-live-debug.mjs RUN_DIRECTORY
       node scripts/replay-live-debug.mjs RUN_DIRECTORY --connection ID --output NEW_DIRECTORY

Inspect and verify a private debug archive offline. Default output includes only
connection metadata, counts, and integrity status, not prompts or transcripts.
Export restores recorded model requests/responses and referenced media bytes;
it never calls an API, executes a tool, or starts a backend task. Output must not
already exist. Incomplete captures remain explicitly marked as incomplete.
Live/network replay is not implemented. A recording cannot guarantee identical
model output or recreate server-side state or randomness.
`;

class ArchiveError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function providerId(value) {
  return (
    typeof value === 'string' && /^[A-Za-z\d][A-Za-z\d_-]{0,255}$/u.test(value)
  );
}

function safeRelative(value, mediaOnly = false) {
  if (
    typeof value !== 'string' ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..') ||
    (mediaOnly && !value.startsWith('media/'))
  ) {
    throw new ArchiveError('unsafe_archive_path');
  }
  return value;
}

async function archiveRoot(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ArchiveError('archive_not_a_regular_directory');
  }
  return realpath(directory);
}

async function openArchiveFile(root, relative) {
  safeRelative(relative);
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())
    ) {
      throw new ArchiveError('archive_symlink_or_nonregular_file');
    }
  }
  const canonical = await realpath(current);
  if (!canonical.startsWith(`${root}${path.sep}`)) {
    throw new ArchiveError('unsafe_archive_path');
  }
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!(await file.stat()).isFile()) {
    await file.close();
    throw new ArchiveError('archive_symlink_or_nonregular_file');
  }
  return file;
}

function errorCode(error) {
  if (error instanceof ArchiveError) return error.code;
  if (error?.code === 'ENOENT') return 'archive_file_missing';
  if (error?.code === 'ELOOP') return 'archive_symlink_or_nonregular_file';
  return 'archive_file_unreadable';
}

async function readMedia(root, reference, onChunk) {
  safeRelative(reference.$media, true);
  if (
    !['base64', 'uint8array'].includes(reference.encoding) ||
    !['audio', 'image', 'binary'].includes(reference.kind) ||
    (reference.kind === 'binary' && reference.encoding !== 'uint8array') ||
    !Number.isSafeInteger(reference.byteOffset) ||
    reference.byteOffset < 0 ||
    !Number.isSafeInteger(reference.bytes) ||
    reference.bytes < 0 ||
    reference.bytes > MAX_MEDIA_BYTES ||
    !Number.isSafeInteger(reference.byteOffset + reference.bytes) ||
    typeof reference.sha256 !== 'string' ||
    !/^[a-f\d]{64}$/iu.test(reference.sha256)
  ) {
    throw new ArchiveError('invalid_media_reference');
  }
  const file = await openArchiveFile(root, reference.$media);
  try {
    if (reference.byteOffset + reference.bytes > (await file.stat()).size) {
      throw new ArchiveError('media_range_out_of_bounds');
    }
    const bytes = Buffer.alloc(
      Math.min(IO_CHUNK_BYTES, Math.max(1, reference.bytes)),
    );
    const checksum = createHash('sha256');
    let offset = 0;
    while (offset < reference.bytes) {
      const result = await file.read(
        bytes,
        0,
        Math.min(bytes.length, reference.bytes - offset),
        reference.byteOffset + offset,
      );
      if (!result.bytesRead)
        throw new ArchiveError('media_range_out_of_bounds');
      const chunk = bytes.subarray(0, result.bytesRead);
      checksum.update(chunk);
      await onChunk?.(chunk);
      offset += result.bytesRead;
    }
    if (checksum.digest('hex') !== reference.sha256.toLowerCase()) {
      throw new ArchiveError('media_hash_mismatch');
    }
  } finally {
    await file.close();
  }
}

function mediaKey(reference) {
  return JSON.stringify([
    reference.$media,
    reference.byteOffset,
    reference.bytes,
    reference.sha256,
    reference.encoding,
    reference.kind,
  ]);
}

function walk(value, visit) {
  if (Array.isArray(value)) return value.map((child) => walk(child, visit));
  if (!object(value)) return value;
  if (Object.hasOwn(value, '$media')) return visit(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, walk(child, visit)]),
  );
}

async function loadArchive(directory, retainConnectionId) {
  const root = await archiveRoot(directory);
  const manifestFile = await openArchiveFile(root, 'manifest.json');
  let manifest;
  let manifestBytes;
  try {
    if ((await manifestFile.stat()).size > MAX_JSON_BYTES) {
      throw new ArchiveError('manifest_too_large');
    }
    manifestBytes = await manifestFile.readFile();
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw new ArchiveError('manifest_invalid_json');
    }
  } finally {
    await manifestFile.close();
  }
  if (
    !object(manifest) ||
    manifest.format !== FORMAT ||
    !['recording', 'closed', 'incomplete'].includes(manifest.status) ||
    typeof manifest.incomplete !== 'boolean' ||
    manifest.files?.events !== 'events.jsonl' ||
    manifest.files?.media !== 'media'
  ) {
    throw new ArchiveError('unsupported_manifest');
  }

  let eventCount = 0;
  const eventChecksum = createHash('sha256');
  const issues = [];
  const connections = new Map();
  const media = new Map();
  const retainedMediaKeys = new Set();
  const attempts = new Map();
  let lastGlobalSeq = 0;
  const issue = (code, row, severity = 'error') => {
    issues.push({
      code,
      severity,
      ...(Number.isSafeInteger(row?.globalSeq)
        ? { globalSeq: row.globalSeq }
        : {}),
      ...(typeof row?.connectionId === 'string'
        ? { connectionId: row.connectionId }
        : {}),
    });
  };
  const file = await openArchiveFile(root, 'events.jsonl');
  try {
    const stream = file.createReadStream({ autoClose: false });
    stream.on('data', (chunk) => eventChecksum.update(chunk));
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_JSON_BYTES) {
        issue('event_line_too_large');
        continue;
      }
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        issue('event_invalid_json');
        continue;
      }
      if (
        !object(row) ||
        !object(row.event) ||
        !Number.isSafeInteger(row.globalSeq) ||
        row.globalSeq < 1 ||
        !Number.isSafeInteger(row.connectionSeq) ||
        row.connectionSeq < 1 ||
        typeof row.connectionId !== 'string' ||
        !/^(?:conn-\d+|runtime)$/u.test(row.connectionId) ||
        typeof row.kind !== 'string' ||
        !['local', 'in', 'out'].includes(row.direction)
      ) {
        issue('invalid_event_record');
        continue;
      }
      if (row.globalSeq <= lastGlobalSeq)
        issue('global_sequence_not_increasing', row);
      else if (row.globalSeq !== lastGlobalSeq + 1)
        issue('global_sequence_gap', row, 'warning');
      lastGlobalSeq = row.globalSeq;
      let connection = connections.get(row.connectionId);
      if (!connection) {
        connection = {
          connectionId: row.connectionId,
          kind: row.kind,
          registered: row.connectionId === 'runtime',
          state: row.connectionId === 'runtime' ? 'runtime' : 'observed',
          firstGlobalSeq: row.globalSeq,
          lastGlobalSeq: row.globalSeq,
          lastConnectionSeq: 0,
          outbound: 0,
          inbound: 0,
          local: 0,
          sent: 0,
          threw: 0,
          failedOrUncertain: 0,
          unconfirmed: 0,
          toolEvents: 0,
          mediaReferences: 0,
          providerSessionIds: [],
          responseIds: new Set(),
        };
        connections.set(row.connectionId, connection);
      }
      if (row.connectionSeq <= connection.lastConnectionSeq)
        issue('connection_sequence_not_increasing', row);
      else if (row.connectionSeq !== connection.lastConnectionSeq + 1)
        issue('connection_sequence_gap', row, 'warning');
      connection.lastConnectionSeq = row.connectionSeq;
      connection.lastGlobalSeq = row.globalSeq;
      if (row.kind !== connection.kind) issue('connection_kind_changed', row);
      if (row.event.type === 'archive.connection_registered') {
        if (connection.registered)
          issue('duplicate_connection_registration', row);
        connection.registered = true;
        connection.state = 'registered';
        connection.metadata = row.event;
      }
      if (row.event.type === 'transport.open') connection.state = 'open';
      if (row.event.type === 'transport.construct_failed')
        connection.state = 'construction_failed';
      if (row.event.type === 'transport.close')
        connection.state = 'transport_closed';
      if (row.event.type === 'archive.connection_closed')
        connection.state = 'closed';
      if (row.direction === 'local') connection.local += 1;
      else if (row.direction === 'in') connection.inbound += 1;
      else connection.outbound += 1;
      if (row.event.type === 'wire.send') {
        if (
          row.direction !== 'out' ||
          !Object.hasOwn(row.event, 'event') ||
          typeof row.event.attemptId !== 'string'
        ) {
          issue('invalid_wire_send', row);
        } else {
          const key = `${row.connectionId}:${row.event.attemptId}`;
          if (attempts.has(key)) issue('duplicate_send_attempt', row);
          else
            attempts.set(key, {
              row: { connectionId: row.connectionId, globalSeq: row.globalSeq },
              status: 'unconfirmed',
            });
        }
      } else if (row.event.type === 'wire.send_result') {
        const attempt = attempts.get(
          `${row.connectionId}:${row.event.attemptId}`,
        );
        if (
          row.direction !== 'local' ||
          !attempt ||
          attempt.status !== 'unconfirmed' ||
          !['sent', 'threw', 'failed_or_uncertain'].includes(row.event.status)
        ) {
          issue('invalid_send_result', row);
        } else attempt.status = row.event.status;
      } else if (row.event.type === 'wire.receive' && row.direction !== 'in') {
        issue('invalid_wire_receive', row);
      }
      if (
        ['wire.send', 'wire.receive'].includes(row.event.type) &&
        row.event.event?.raw?.truncated === true
      ) {
        issue('wire_frame_truncated', row, 'warning');
      }
      if (row.event.type === 'wire.receive') {
        const incoming = row.event.event;
        if (
          ['session.created', 'session.updated'].includes(incoming?.type) &&
          providerId(incoming.session?.id) &&
          !connection.providerSessionIds.includes(incoming.session.id)
        ) {
          if (connection.providerSessionIds.length < 16) {
            connection.providerSessionIds.push(incoming.session.id);
          } else issue('provider_session_id_limit', row, 'warning');
        }
        if (
          ['response.created', 'response.done'].includes(incoming?.type) &&
          providerId(incoming.response?.id)
        )
          connection.responseIds.add(incoming.response.id);
      }
      walk(row.event, (reference) => {
        connection.mediaReferences += 1;
        const key = mediaKey(reference);
        if (!media.has(key))
          media.set(key, {
            reference,
            row: { connectionId: row.connectionId, globalSeq: row.globalSeq },
          });
        if (row.connectionId === retainConnectionId) retainedMediaKeys.add(key);
        return reference;
      });
      let hasToolEvent = false;
      const findTool = (value) => {
        if (Array.isArray(value)) value.forEach(findTool);
        else if (object(value)) {
          if (
            typeof value.type === 'string' &&
            (value.type.includes('function_call') ||
              value.type.includes('tool_call'))
          )
            hasToolEvent = true;
          Object.values(value).forEach(findTool);
        }
      };
      findTool(row.event.event);
      if (hasToolEvent) connection.toolEvents += 1;
      eventCount += 1;
    }
  } finally {
    await file.close();
  }
  for (const attempt of attempts.values()) {
    const counter =
      attempt.status === 'failed_or_uncertain'
        ? 'failedOrUncertain'
        : attempt.status;
    connections.get(attempt.row.connectionId)[counter] += 1;
    if (attempt.status === 'unconfirmed')
      issue('send_outcome_unknown', attempt.row, 'warning');
  }
  for (const connection of connections.values()) {
    if (!connection.registered)
      issue('connection_registration_missing', connection, 'warning');
  }
  for (const entry of media.values()) {
    try {
      await readMedia(root, entry.reference);
      entry.verified = true;
    } catch (error) {
      issue(errorCode(error), entry.row);
    }
  }
  const counters = manifest.counters;
  if (object(counters)) {
    if (
      counters.writtenEvents !== eventCount ||
      counters.lastGlobalSeq !== lastGlobalSeq
    ) {
      issue('manifest_event_count_mismatch', undefined, 'warning');
    }
    if (counters.droppedEvents > 0)
      issue('archive_events_dropped', undefined, 'warning');
  } else issue('manifest_counters_missing', undefined, 'warning');
  const complete =
    manifest.status === 'closed' &&
    !manifest.incomplete &&
    issues.length === 0 &&
    (manifest.warnings?.length ?? 0) === 0;
  return {
    root,
    manifest,
    manifestHash: hash(manifestBytes),
    eventCount,
    eventHash: eventChecksum.digest('hex'),
    retainedMediaKeys,
    connections,
    media,
    attempts,
    issues,
    complete,
  };
}

function summary(archive, selectedId) {
  const connections = [...archive.connections.values()]
    .filter(
      (connection) => !selectedId || connection.connectionId === selectedId,
    )
    .map(({ metadata, responseIds, ...connection }) => ({
      ...connection,
      responseCount: responseIds.size,
      ...(typeof metadata?.model === 'string' ? { model: metadata.model } : {}),
    }));
  return {
    format: FORMAT,
    archiveStatus: archive.manifest.status,
    complete: archive.complete,
    ...(typeof archive.manifest.redacted === 'boolean'
      ? { redacted: archive.manifest.redacted }
      : {}),
    integrity: archive.issues.some((issue) => issue.severity === 'error')
      ? 'failed'
      : 'verified',
    eventCount: archive.eventCount,
    mediaSegmentsVerified: [...archive.media.values()].filter(
      (entry) => entry.verified,
    ).length,
    manifestWarningCount: archive.manifest.warnings?.length ?? 0,
    connections,
    issues: archive.issues,
    offlineOnly: true,
  };
}

export async function inspectArchive(directory) {
  return summary(await loadArchive(directory));
}

/** Small output buffers amortize punctuation writes, never whole-run JSON. */
function bufferedWriter(file) {
  let parts = [];
  let bytes = 0;
  const flush = async () => {
    if (!bytes) return;
    const text = parts.join('');
    parts = [];
    bytes = 0;
    await file.writeFile(text);
  };
  return {
    flush,
    async write(text) {
      const size = Buffer.byteLength(text);
      if (bytes + size > IO_CHUNK_BYTES) await flush();
      if (size >= IO_CHUNK_BYTES) await file.writeFile(text);
      else {
        parts.push(text);
        bytes += size;
      }
    },
  };
}

async function writeBase64(writer, root, reference) {
  await writer.write('"');
  let remainder = Buffer.alloc(0);
  await readMedia(root, reference, async (chunk) => {
    const data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    const complete = data.length - (data.length % 3);
    if (complete)
      await writer.write(data.subarray(0, complete).toString('base64'));
    remainder = Buffer.from(data.subarray(complete));
  });
  if (remainder.length) await writer.write(remainder.toString('base64'));
  await writer.write('"');
}

async function writeJsonValue(writer, value, writeMediaValue) {
  if (Array.isArray(value)) {
    await writer.write('[');
    for (let index = 0; index < value.length; index++) {
      if (index) await writer.write(',');
      await writeJsonValue(writer, value[index], writeMediaValue);
    }
    await writer.write(']');
  } else if (object(value)) {
    if (writeMediaValue && Object.hasOwn(value, '$media')) {
      await writeMediaValue(value);
      return;
    }
    await writer.write('{');
    let first = true;
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      if (!first) await writer.write(',');
      first = false;
      await writer.write(`${JSON.stringify(key)}:`);
      await writeJsonValue(writer, child, writeMediaValue);
    }
    await writer.write('}');
  } else await writer.write(JSON.stringify(value) ?? 'null');
}

async function streamConnectionExport(
  archive,
  connectionId,
  destination,
  exportedMedia,
) {
  const handles = [];
  let requests = 0,
    responses = 0;
  try {
    const output = async (name) => {
      const file = await open(path.join(destination, name), 'wx', 0o600);
      handles.push(file);
      return bufferedWriter(file);
    };
    const requestWriter = await output('requests.json');
    const responseWriter = await output('responses.json');
    const eventWriter = await output('events.jsonl');
    await requestWriter.write('[\n');
    await responseWriter.write('[\n');
    const file = await openArchiveFile(archive.root, 'events.jsonl');
    const checksum = createHash('sha256');
    const knownReference = (reference) => {
      const key = mediaKey(reference);
      if (!exportedMedia.has(key))
        throw new ArchiveError('archive_changed_during_export');
      return archive.media.get(key).reference;
    };
    const writeHydrated = (writer, value) =>
      writeJsonValue(writer, value, async (reference) => {
        const known = knownReference(reference);
        if (known.encoding === 'uint8array') await writer.write('{"$binary":');
        await writeBase64(writer, archive.root, known);
        if (known.encoding === 'uint8array')
          await writer.write(',"encoding":"base64"}');
      });
    try {
      const stream = file.createReadStream({ autoClose: false });
      stream.on('data', (chunk) => checksum.update(chunk));
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_JSON_BYTES)
          throw new ArchiveError('archive_changed_during_export');
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          throw new ArchiveError('archive_changed_during_export');
        }
        if (row.connectionId !== connectionId) continue;
        const redacted =
          typeof row.redacted === 'boolean'
            ? { redacted: row.redacted }
            : typeof row.event.redacted === 'boolean'
              ? { redacted: row.event.redacted }
              : {};
        const base = {
          globalSeq: row.globalSeq,
          connectionSeq: row.connectionSeq,
          wallTime: row.wallTime,
          monotonicNs: row.monotonicNs,
        };
        if (row.event.type === 'wire.send') {
          const attempt = archive.attempts.get(
            `${connectionId}:${row.event.attemptId}`,
          );
          if (!attempt) throw new ArchiveError('archive_changed_during_export');
          if (requests++) await requestWriter.write(',\n');
          await writeHydrated(requestWriter, {
            ...base,
            attemptId: row.event.attemptId,
            sendStatus: attempt.status,
            ...redacted,
            event: row.event.event,
          });
        } else if (row.event.type === 'wire.receive') {
          if (responses++) await responseWriter.write(',\n');
          await writeHydrated(responseWriter, {
            ...base,
            binary: row.event.binary === true,
            ...redacted,
            event: row.event.event,
          });
        }
        await writeJsonValue(
          eventWriter,
          walk(row, (reference) => {
            knownReference(reference);
            return exportedMedia.get(mediaKey(reference));
          }),
        );
        await eventWriter.write('\n');
      }
    } finally {
      await file.close();
    }
    if (checksum.digest('hex') !== archive.eventHash)
      throw new ArchiveError('archive_changed_during_export');
    await requestWriter.write('\n]\n');
    await responseWriter.write('\n]\n');
    await Promise.all([
      requestWriter.flush(),
      responseWriter.flush(),
      eventWriter.flush(),
    ]);
    return { requests, responses };
  } finally {
    await Promise.all(handles.map((file) => file.close()));
  }
}

export async function exportArchive(directory, connectionId, outputDirectory) {
  const archive = await loadArchive(directory, connectionId);
  const connection = archive.connections.get(connectionId);
  if (!connection) throw new ArchiveError('connection_not_found');
  if (archive.issues.some((issue) => issue.severity === 'error')) {
    throw new ArchiveError('archive_integrity_failed_inspect_first');
  }
  const output = path.resolve(outputDirectory);
  const parent = await realpath(path.dirname(output));
  const destination = path.join(parent, path.basename(output));
  if (
    destination === archive.root ||
    destination.startsWith(`${archive.root}${path.sep}`)
  ) {
    throw new ArchiveError('output_must_be_outside_archive');
  }
  await mkdir(destination, { mode: 0o700 });
  await mkdir(path.join(destination, 'media'), { mode: 0o700 });
  const write = (name, value) =>
    writeFile(path.join(destination, name), value, { mode: 0o600, flag: 'wx' });
  const exportedMedia = new Map();
  for (const key of archive.retainedMediaKeys) {
    const reference = archive.media.get(key).reference;
    const index = String(exportedMedia.size + 1).padStart(6, '0');
    const extension =
      reference.kind === 'audio'
        ? 'pcm'
        : reference.kind === 'image'
          ? 'image'
          : 'bin';
    const copied = {
      ...reference,
      $media: `media/${index}.${extension}`,
      byteOffset: 0,
    };
    exportedMedia.set(key, copied);
    const file = await open(path.join(destination, copied.$media), 'wx', 0o600);
    try {
      await readMedia(archive.root, reference, (chunk) =>
        file.writeFile(chunk),
      );
    } finally {
      await file.close();
    }
  }
  const counts = await streamConnectionExport(
    archive,
    connectionId,
    destination,
    exportedMedia,
  );
  await write(
    'manifest.json',
    `${JSON.stringify(
      {
        format: 'qwen-live-harness-debug-export-v1',
        sourceManifestSha256: archive.manifestHash,
        sourceEventsSha256: archive.eventHash,
        sourceStatus: archive.manifest.status,
        complete: archive.complete,
        ...(typeof archive.manifest.redacted === 'boolean'
          ? { redacted: archive.manifest.redacted }
          : {}),
        ...(object(archive.manifest.redaction)
          ? { redaction: archive.manifest.redaction }
          : {}),
        connectionId,
        connection: connection.metadata ?? { kind: connection.kind },
        offlineOnly: true,
        notes: [
          'Requests retain original order and send outcomes. Unconfirmed is not proof of delivery.',
          'Only wire sends are requests; registration and session snapshots are not replayed as new requests.',
          'Media references in events.jsonl point to verified, copied byte ranges. requests/responses restore base64.',
          'Original byte-array fields use explicit {$binary,encoding:"base64"} envelopes, not invented JSON provider messages.',
          'This export executes no tools or network calls. It cannot reproduce model randomness or server state.',
          'Files contain private prompts, transcripts, and media. Review before sharing.',
        ],
      },
      null,
      2,
    )}\n`,
  );
  const result = summary(archive, connectionId);
  await write('inspection.json', `${JSON.stringify(result, null, 2)}\n`);
  return {
    ...result,
    exported: true,
    requestCount: counts.requests,
    responseCount: counts.responses,
  };
}

export function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]))
    return { help: true };
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--connection' || argument === '--output') {
      const value = args[++index];
      if (!value || value.startsWith('--'))
        throw new ArchiveError('missing_option_value');
      const key = argument.slice(2);
      if (options[key]) throw new ArchiveError('duplicate_option');
      options[key] = value;
    } else if (argument.startsWith('-'))
      throw new ArchiveError('unsupported_option_offline_only');
    else if (!options.directory) options.directory = argument;
    else throw new ArchiveError('unexpected_argument');
  }
  if (!options.directory) throw new ArchiveError('archive_directory_required');
  if (Boolean(options.connection) !== Boolean(options.output))
    throw new ArchiveError('connection_and_output_required_together');
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(USAGE);
      return;
    }
    const result = options.output
      ? await exportArchive(
          options.directory,
          options.connection,
          options.output,
        )
      : await inspectArchive(options.directory);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.integrity === 'failed') process.exitCode = 1;
  } catch (error) {
    // Do not reflect provider text, raw JSON, credentials, or file contents.
    const code =
      error instanceof ArchiveError
        ? error.code
        : error?.code === 'EEXIST'
          ? 'output_already_exists'
          : errorCode(error);
    process.stderr.write(
      `Debug archive: ${code}. Use --help for offline usage.\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
