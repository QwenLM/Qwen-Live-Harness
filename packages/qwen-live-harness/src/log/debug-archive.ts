/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const FORMAT = 'qwen-live-harness-debug-v1';
const RUN_NAME = /^run-(\d+)-([a-f0-9-]{36})$/u;
const MANIFEST_BUDGET = 8 * 1024;
const CONTROL_RESERVE = MANIFEST_BUDGET * 2;
const MAX_WARNINGS = 16;
const MAX_NODES = 100_000;
const MAX_DEPTH = 128;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_QUEUED_BYTES = 32 * 1024 * 1024;
const DEFAULT_RETAIN_RUNS = 10;
const READ_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_NOFOLLOW =
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_WRONLY |
  constants.O_NOFOLLOW;
const CREDENTIAL_KEY =
  /(?:api[_-]?key$|token$|^(?:authorization|proxy[-_]?authorization|secret|client[-_]?secret|password|passwd|cookie|set[-_]?cookie|credentials?|private[-_]?key)$)/iu;
const JSON_CREDENTIAL =
  /("(?:[\w-]*api[_-]?key|[\w-]*token|authorization|proxy[-_]?authorization|secret|client[-_]?secret|password|passwd|cookie|set[-_]?cookie|private[-_]?key)"\s*:\s*)"(?:\\.|[^"\\])*"/giu;
let lastCreatedAt = 0;

export type DebugConnectionKind =
  'main' | 'monitor' | 'search' | 'visual' | 'notification';
export type DebugArchiveDirection = 'out' | 'in' | 'local';
export interface DebugConnectionInfo {
  kind: DebugConnectionKind;
  id?: string;
  taskId?: string;
  callEpoch?: string | number;
  endpoint?: string;
  model?: string;
  voice?: string;
  [key: string]: unknown;
}
export interface DebugArchiveWarning {
  code: string;
  message: string;
  at: string;
  path: string;
  globalSeq?: number;
  connectionId?: string;
}
export interface DebugArchiveOptions {
  /** Dedicated, private archive root. Each instance creates a unique run below it. */
  directory: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  secrets?: readonly string[];
  onWarning?: (warning: DebugArchiveWarning) => void;
  /** Includes manifest and its atomic-write reserve; minimum 32 KiB. */
  maxBytes?: number;
  maxQueuedBytes?: number;
  /** Completed runs retained, in addition to runs whose owners are still active. */
  retainRuns?: number;
}
export interface DebugArchiveMediaRef {
  $media: string;
  byteOffset: number;
  bytes: number;
  sha256: string;
  encoding: 'base64' | 'uint8array';
  kind: 'audio' | 'image' | 'binary';
}
export interface DebugArchiveEventEnvelope {
  globalSeq: number;
  connectionSeq: number;
  wallTime: string;
  wallTimeMs: number;
  monotonicNs: string;
  direction: DebugArchiveDirection;
  connectionId: string;
  kind: DebugConnectionKind | 'runtime';
  redacted: boolean;
  event: unknown;
}
export interface DebugArchiveRecorder {
  readonly id: string;
  readonly path: string;
  record(direction: DebugArchiveDirection, event: unknown): void;
  close(reason?: unknown): void;
}

interface Identity {
  dev: number;
  ino: number;
}
interface AudioFile {
  handle: FileHandle;
  identity: Identity;
}
interface MediaWrite {
  ref: DebugArchiveMediaRef;
  data?: Buffer;
  append: boolean;
}
interface Prepared {
  event: unknown;
  media: MediaWrite[];
  mediaBytes: number;
  offsets: Map<string, number>;
  images: Set<string>;
  redacted: boolean;
}

class ArchiveIssue extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}
async function privateDirectory(
  path: string,
  expected?: Identity,
): Promise<Identity> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))
  )
    throw new ArchiveIssue('unsafe_directory');
  return { dev: stat.dev, ino: stat.ino };
}
async function privateFile(
  path: string,
  expected?: Identity,
): Promise<Identity> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))
  )
    throw new ArchiveIssue('unsafe_file');
  return { dev: stat.dev, ino: stat.ino };
}

/**
 * Construct only for debug runs. Recording never throws into the application.
 * All event/media writes share one FIFO; closing drains accepted writes even
 * after a capacity failure. No send success or missing media is fabricated.
 */
export class DebugArchive {
  readonly path: string;
  private readonly root: string;
  private readonly runId = randomUUID();
  private readonly createdAt: number;
  private readonly monotonicStart = process.hrtime.bigint();
  private readonly secrets: readonly string[];
  private readonly maxBytes: number;
  private readonly maxQueuedBytes: number;
  private readonly retainRuns: number;
  private readonly warnings: DebugArchiveWarning[] = [];
  private readonly warned = new Set<string>();
  private readonly recorders = new Map<
    string,
    { close(reason?: unknown): void }
  >();
  private readonly offsets = new Map<string, number>();
  private readonly imageFiles = new Set<string>();
  private readonly audioFiles = new Map<string, AudioFile>();
  private rootIdentity?: Identity;
  private runIdentity?: Identity;
  private mediaIdentity?: Identity;
  private eventIdentity?: Identity;
  private events?: FileHandle;
  private initialized = false;
  private stopped = false;
  private ioFailed = false;
  private closing = false;
  private incomplete = false;
  private closedAt?: string;
  private tail: Promise<void>;
  private closingPromise?: Promise<void>;
  private connectionCount = 0;
  private runtimeSeq = 0;
  private globalSeq = 0;
  private writtenEvents = 0;
  private droppedEvents = 0;
  private dataBytes = 0;
  private reservedBytes = 0;
  private queuedBytes = 0;
  private queuedHighWater = 0;
  private lastManifestAt = 0;
  private redactedValues = 0;
  private invalidMediaValues = 0;

  constructor(private readonly options: DebugArchiveOptions) {
    this.root = resolve(options.directory);
    this.createdAt = Math.max(Date.now(), lastCreatedAt + 1);
    lastCreatedAt = this.createdAt;
    this.path = join(this.root, `run-${this.createdAt}-${this.runId}`);
    this.secrets = [
      ...new Set(
        (options.secrets ?? []).filter(
          (secret) => typeof secret === 'string' && secret.length > 0,
        ),
      ),
    ].sort((a, b) => b.length - a.length);
    this.maxBytes = positive(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxQueuedBytes = positive(
      options.maxQueuedBytes,
      DEFAULT_QUEUED_BYTES,
    );
    this.retainRuns = positive(options.retainRuns, DEFAULT_RETAIN_RUNS);
    this.tail = this.initialize();
    if (options.metadata)
      this.recordRuntime('archive.run_metadata', options.metadata);
  }

  get isIncomplete(): boolean {
    return this.incomplete;
  }

  beginConnection(info: DebugConnectionInfo): DebugArchiveRecorder {
    const id = `conn-${String(++this.connectionCount).padStart(6, '0')}`;
    let sequence = 0;
    let closed = false;
    const kind = info.kind;
    const recorder: DebugArchiveRecorder = {
      id,
      path: this.path,
      record: (direction, event) => {
        if (closed) return;
        this.capture(id, kind, ++sequence, direction, event);
      },
      close: (reason) => {
        if (closed) return;
        closed = true;
        this.capture(
          id,
          kind,
          ++sequence,
          'local',
          {
            type: 'archive.connection_closed',
            ...(reason !== undefined ? { reason } : {}),
          },
          true,
        );
        this.enqueueControl(async () => {
          for (const [path, stream] of this.audioFiles) {
            if (!basename(path).startsWith(`${id}-`)) continue;
            await stream.handle.close();
            this.audioFiles.delete(path);
            this.offsets.delete(path);
          }
        });
        this.recorders.delete(id);
      },
    };
    if (
      !['main', 'monitor', 'search', 'visual', 'notification'].includes(kind)
    ) {
      closed = true;
      this.fail('invalid_connection_kind');
      return recorder;
    }
    if (!this.closing && !this.stopped && !this.ioFailed) {
      this.recorders.set(id, recorder);
      recorder.record('local', {
        ...info,
        type: 'archive.connection_registered',
      });
    } else closed = true;
    return recorder;
  }

  recordRuntime(type: string, payload: unknown): void {
    this.capture('runtime', 'runtime', ++this.runtimeSeq, 'local', {
      type,
      payload,
    });
  }

  /** Flush everything accepted before this call, without waiting for future traffic. */
  async flush(): Promise<void> {
    if (this.closingPromise) {
      await this.closingPromise;
      return;
    }
    await this.enqueueControl(async () => {
      await this.persistManifest();
      await this.events?.sync();
      for (const stream of this.audioFiles.values()) await stream.handle.sync();
    });
  }

  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closing = true;
    for (const recorder of [...this.recorders.values()])
      recorder.close('archive_closed');
    this.closingPromise = this.enqueueControl(async () => {
      this.closedAt = new Date().toISOString();
      await this.persistManifest();
      try {
        await this.events?.sync();
      } catch {
        this.fail('io_failure');
      }
      try {
        await this.events?.close();
      } catch {
        this.fail('io_failure');
      }
      this.events = undefined;
      for (const stream of this.audioFiles.values()) {
        try {
          await stream.handle.close();
        } catch {
          this.fail('io_failure');
        }
      }
      this.audioFiles.clear();
      this.offsets.clear();
      await this.persistManifest();
      await this.prune();
    });
    return this.closingPromise;
  }

  private async initialize(): Promise<void> {
    try {
      if (this.maxBytes < CONTROL_RESERVE * 2)
        throw new ArchiveIssue('invalid_limits');
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      this.rootIdentity = await privateDirectory(this.root);
      await mkdir(this.path, { mode: 0o700 });
      this.runIdentity = await privateDirectory(this.path);
      await mkdir(join(this.path, 'media'), { mode: 0o700 });
      this.mediaIdentity = await privateDirectory(join(this.path, 'media'));
      this.events = await open(
        join(this.path, 'events.jsonl'),
        CREATE_NOFOLLOW | constants.O_APPEND,
        0o600,
      );
      this.eventIdentity = await privateFile(join(this.path, 'events.jsonl'));
      this.initialized = true;
      await this.persistManifest();
      await this.prune();
    } catch (error) {
      this.ioFailed = true;
      this.fail(
        error instanceof ArchiveIssue ? error.code : 'initialization_failed',
      );
    }
  }

  private capture(
    connectionId: string,
    kind: DebugConnectionKind | 'runtime',
    connectionSeq: number,
    direction: DebugArchiveDirection,
    event: unknown,
    closingRecord = false,
  ): void {
    if (this.closing && !closingRecord) return;
    const globalSeq = ++this.globalSeq;
    if (this.stopped || this.ioFailed) {
      this.droppedEvents++;
      return;
    }
    let cost = 0;
    try {
      if (!['out', 'in', 'local'].includes(direction))
        throw new ArchiveIssue('invalid_direction');
      const prepared = this.prepare(event, connectionId, direction);
      const wallTimeMs = Date.now();
      const envelope: DebugArchiveEventEnvelope = {
        globalSeq,
        connectionSeq,
        wallTime: new Date(wallTimeMs).toISOString(),
        wallTimeMs,
        monotonicNs: (process.hrtime.bigint() - this.monotonicStart).toString(),
        direction,
        connectionId,
        kind,
        redacted: prepared.redacted,
        event: prepared.event,
      };
      const line = `${JSON.stringify(envelope)}\n`;
      cost = Buffer.byteLength(line) + prepared.mediaBytes;
      if (cost > this.maxQueuedBytes - this.queuedBytes)
        throw new ArchiveIssue('queue_limit');
      if (cost > this.maxBytes - CONTROL_RESERVE - this.reservedBytes)
        throw new ArchiveIssue('run_limit');
      this.reservedBytes += cost;
      this.queuedBytes += cost;
      this.queuedHighWater = Math.max(this.queuedHighWater, this.queuedBytes);
      for (const [path, offset] of prepared.offsets)
        this.offsets.set(path, offset);
      for (const path of prepared.images) this.imageFiles.add(path);
      this.tail = this.tail
        .then(async () => {
          try {
            if (this.ioFailed || !this.initialized || !this.events) {
              this.droppedEvents++;
              return;
            }
            await this.checkDirectories(true);
            for (const media of prepared.media) await this.writeMedia(media);
            await privateFile(
              join(this.path, 'events.jsonl'),
              this.eventIdentity,
            );
            await this.events.writeFile(line);
            this.dataBytes += Buffer.byteLength(line);
            this.writtenEvents++;
            if (Date.now() - this.lastManifestAt >= 1000)
              await this.persistManifest();
          } catch (error) {
            this.droppedEvents++;
            this.ioFailed = true;
            this.fail(
              error instanceof ArchiveIssue ? error.code : 'io_failure',
              globalSeq,
              connectionId,
            );
            await this.persistManifest();
          } finally {
            this.queuedBytes -= cost;
          }
        })
        .catch(() => {
          this.ioFailed = true;
          this.fail('io_failure', globalSeq, connectionId);
        });
    } catch (error) {
      this.droppedEvents++;
      this.fail(
        error instanceof ArchiveIssue ? error.code : 'serialization_failed',
        globalSeq,
        connectionId,
      );
      void this.enqueueControl(() => this.persistManifest());
    }
  }

  private cleanString(value: string): string {
    let text = value;
    for (const secret of this.secrets)
      text = text.split(secret).join('[REDACTED]');
    return text
      .replace(JSON_CREDENTIAL, '$1"[REDACTED]"')
      .replace(/\bBearer\s+[-A-Za-z0-9._~+/]+=*/giu, 'Bearer [REDACTED]')
      .replace(/\b((?:https?|wss?):\/\/)[^/\s?#@]+@/giu, '$1[REDACTED]@')
      .replace(
        /([?&](?:[\w-]*api[_-]?key|[\w-]*token|secret|signature)=)[^&#\s]*/giu,
        '$1[REDACTED]',
      );
  }

  private prepare(
    event: unknown,
    connectionId: string,
    direction: DebugArchiveDirection,
  ): Prepared {
    const media: MediaWrite[] = [];
    const offsets = new Map<string, number>();
    const images = new Set<string>();
    const ancestors = new Set<object>();
    let mediaBytes = 0,
      nodes = 0,
      stringBytes = 0;
    let redacted = false;
    const textValue = (value: string): string => {
      const text = this.cleanString(value);
      if (text !== value) {
        redacted = true;
        this.redactedValues++;
      }
      stringBytes += Buffer.byteLength(text);
      if (stringBytes > this.maxQueuedBytes - this.queuedBytes - mediaBytes)
        throw new ArchiveIssue('queue_limit');
      return text;
    };
    type Hint = {
      kind: DebugArchiveMediaRef['kind'];
      lane?: 'input' | 'output';
    };
    const externalize = (
      value: string | Uint8Array,
      hint: Hint,
    ): DebugArchiveMediaRef | string => {
      const estimated =
        typeof value === 'string'
          ? Math.floor(value.length / 4) * 3
          : value.byteLength;
      if (estimated > this.maxQueuedBytes - this.queuedBytes - mediaBytes)
        throw new ArchiveIssue('queue_limit');
      if (
        typeof value === 'string' &&
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
          value,
        )
      ) {
        this.invalidMediaValues++;
        return textValue(value);
      }
      const bytes =
        typeof value === 'string'
          ? Buffer.from(value, 'base64')
          : Buffer.from(value);
      if (typeof value === 'string' && bytes.toString('base64') !== value) {
        this.invalidMediaValues++;
        return textValue(value);
      }
      const sha256 = digest(bytes);
      const encoding = typeof value === 'string' ? 'base64' : 'uint8array';
      let path: string;
      let append: boolean;
      if (hint.kind === 'image') {
        const extension =
          bytes[0] === 0xff && bytes[1] === 0xd8
            ? 'jpg'
            : bytes
                  .subarray(0, 8)
                  .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
              ? 'png'
              : 'bin';
        path = `media/${sha256}.${extension}`;
        append = false;
      } else {
        path = `media/${connectionId}-${hint.kind === 'audio' ? (hint.lane ?? (direction === 'in' ? 'output' : 'input')) : 'binary'}.${hint.kind === 'audio' ? 'pcm' : 'bin'}`;
        append = true;
      }
      const byteOffset = append
        ? (offsets.get(path) ?? this.offsets.get(path) ?? 0)
        : 0;
      const ref: DebugArchiveMediaRef = {
        $media: path,
        byteOffset,
        bytes: bytes.length,
        sha256,
        encoding,
        kind: hint.kind,
      };
      const duplicate =
        !append && (this.imageFiles.has(path) || images.has(path));
      media.push({ ref, ...(duplicate ? {} : { data: bytes }), append });
      if (!duplicate) mediaBytes += bytes.length;
      if (append) offsets.set(path, byteOffset + bytes.length);
      else images.add(path);
      return ref;
    };
    const walk = (
      value: unknown,
      depth: number,
      hint?: Hint,
      schemaProperties = false,
    ): unknown => {
      if (++nodes > MAX_NODES || depth > MAX_DEPTH)
        throw new ArchiveIssue('event_complexity_limit');
      if (hint && (typeof value === 'string' || value instanceof Uint8Array))
        return externalize(value, hint);
      if (value instanceof Uint8Array)
        return externalize(value, { kind: 'binary' });
      if (typeof value === 'string') {
        return textValue(value);
      }
      if (
        value === null ||
        typeof value === 'boolean' ||
        typeof value === 'number'
      )
        return value;
      if (value === undefined) return undefined;
      if (typeof value !== 'object') throw new ArchiveIssue('non_json_value');
      if (ancestors.has(value)) throw new ArchiveIssue('circular_event');
      ancestors.add(value);
      try {
        if (Array.isArray(value))
          return value.map((item) => walk(item, depth + 1));
        const input =
          value instanceof Error
            ? {
                name: value.name,
                message: value.message,
                stack: value.stack,
                ...Object.fromEntries(Object.entries(value)),
              }
            : (value as Record<string, unknown>);
        const output: Record<string, unknown> = Object.create(null) as Record<
          string,
          unknown
        >;
        const type = typeof input['type'] === 'string' ? input['type'] : '';
        for (const [key, child] of Object.entries(input)) {
          const schemaField =
            schemaProperties &&
            object(child) &&
            (typeof child['type'] === 'string' ||
              '$ref' in child ||
              'anyOf' in child ||
              'oneOf' in child);
          if (CREDENTIAL_KEY.test(key) && !schemaField) {
            output[key] = '[REDACTED]';
            if (child !== '[REDACTED]') {
              redacted = true;
              this.redactedValues++;
            }
            continue;
          }
          if (
            /^(?:headers|requestHeaders|responseHeaders)$/iu.test(key) &&
            object(child) &&
            !schemaField
          ) {
            output[key] = Object.fromEntries(
              Object.keys(child).map((name) => [
                this.cleanString(name),
                '[REDACTED]',
              ]),
            );
            if (Object.values(child).some((value) => value !== '[REDACTED]')) {
              redacted = true;
              this.redactedValues++;
            }
            continue;
          }
          let mediaHint: Hint | undefined;
          if (
            key === 'jpegBase64' ||
            (key === 'image' &&
              ['screen', 'camera'].includes(String(input['source'])) &&
              Number.isSafeInteger(input['width']) &&
              Number(input['width']) > 0 &&
              Number.isSafeInteger(input['height']) &&
              Number(input['height']) > 0) ||
            (['input_image_buffer.append', 'input_image', 'image'].includes(
              type,
            ) &&
              ['image', 'data'].includes(key)) ||
            (key === 'data' &&
              typeof input['mimeType'] === 'string' &&
              input['mimeType'].startsWith('image/'))
          )
            mediaHint = { kind: 'image' };
          if (
            (type === 'input_audio_buffer.append' && key === 'audio') ||
            (type === 'input_audio' && ['audio', 'data'].includes(key)) ||
            key === 'pcm16'
          )
            mediaHint = { kind: 'audio', lane: 'input' };
          if (
            ['response.audio.delta', 'response.output_audio.delta'].includes(
              type,
            ) &&
            key === 'delta'
          )
            mediaHint = { kind: 'audio', lane: 'output' };
          if (type === 'audio' && ['audio', 'data'].includes(key))
            mediaHint = { kind: 'audio' };
          output[textValue(key)] = walk(
            child,
            depth + 1,
            mediaHint,
            key === 'properties',
          );
        }
        return output;
      } finally {
        ancestors.delete(value);
      }
    };
    const clean = walk(event, 0);
    return { event: clean, media, mediaBytes, offsets, images, redacted };
  }

  private async checkDirectories(media: boolean): Promise<void> {
    if (!this.initialized) throw new ArchiveIssue('initialization_failed');
    await privateDirectory(this.root, this.rootIdentity);
    await privateDirectory(this.path, this.runIdentity);
    if (media)
      await privateDirectory(join(this.path, 'media'), this.mediaIdentity);
  }

  private async writeMedia(write: MediaWrite): Promise<void> {
    const path = join(this.path, write.ref.$media);
    if (write.append) {
      let stream = this.audioFiles.get(write.ref.$media);
      if (!stream) {
        const handle = await open(
          path,
          CREATE_NOFOLLOW | constants.O_APPEND,
          0o600,
        );
        stream = { handle, identity: await privateFile(path) };
        this.audioFiles.set(write.ref.$media, stream);
      }
      await privateFile(path, stream.identity);
      if (
        (await stream.handle.stat()).size !== write.ref.byteOffset ||
        !write.data
      )
        throw new ArchiveIssue('media_integrity_failed');
      await stream.handle.writeFile(write.data);
      this.dataBytes += write.data.length;
      return;
    }
    if (write.data) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(path, CREATE_NOFOLLOW, 0o600);
        await handle.writeFile(write.data);
        this.dataBytes += write.data.length;
      } catch (error) {
        if (!object(error) || error['code'] !== 'EEXIST') throw error;
      } finally {
        await handle?.close();
      }
    }
    await privateFile(path);
    const handle = await open(path, READ_NOFOLLOW);
    try {
      if ((await handle.stat()).size !== write.ref.bytes)
        throw new ArchiveIssue('media_integrity_failed');
      const hash = createHash('sha256');
      const chunk = Buffer.alloc(
        Math.min(64 * 1024, Math.max(1, write.ref.bytes)),
      );
      for (let at = 0; at < write.ref.bytes;) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, write.ref.bytes - at),
          at,
        );
        if (!bytesRead) throw new ArchiveIssue('media_integrity_failed');
        hash.update(chunk.subarray(0, bytesRead));
        at += bytesRead;
      }
      if (hash.digest('hex') !== write.ref.sha256)
        throw new ArchiveIssue('media_integrity_failed');
    } finally {
      await handle.close();
    }
  }

  private fail(code: string, globalSeq?: number, connectionId?: string): void {
    this.incomplete = true;
    this.stopped = true;
    if (this.warned.has(code)) return;
    this.warned.add(code);
    const warning: DebugArchiveWarning = Object.freeze({
      code,
      message: `Debug archive is incomplete (${code}); application execution is unaffected.`,
      at: new Date().toISOString(),
      path: this.cleanString(this.path),
      ...(globalSeq !== undefined ? { globalSeq } : {}),
      ...(connectionId ? { connectionId } : {}),
    });
    if (this.warnings.length < MAX_WARNINGS) this.warnings.push(warning);
    try {
      this.options.onWarning?.(warning);
    } catch {
      /* never break the application */
    }
  }

  private enqueueControl(work: () => Promise<void>): Promise<void> {
    const pending = this.tail.then(work).catch((error) => {
      this.fail(error instanceof ArchiveIssue ? error.code : 'io_failure');
    });
    this.tail = pending;
    return pending;
  }

  private async persistManifest(): Promise<void> {
    if (!this.initialized) return;
    let temporary: string | undefined;
    try {
      await this.checkDirectories(false);
      const manifest = {
        format: FORMAT,
        owner: 'qwen-live-harness',
        runId: this.runId,
        pid: process.pid,
        createdAt: this.createdAt,
        startedAt: new Date(this.createdAt).toISOString(),
        ...(this.options.sessionId
          ? {
              sessionId: this.cleanString(this.options.sessionId).slice(0, 512),
            }
          : {}),
        status: this.incomplete
          ? 'incomplete'
          : this.closedAt
            ? 'closed'
            : 'recording',
        incomplete: this.incomplete,
        redacted: this.redactedValues > 0,
        redaction: {
          redactedValues: this.redactedValues,
          knownSecretsCount: this.secrets.length,
          media: 'not-inspected',
        },
        ...(this.closedAt ? { closedAt: this.closedAt } : {}),
        warnings: this.warnings,
        files: { events: 'events.jsonl', media: 'media' },
        connections: {
          count: this.connectionCount,
          index: 'events.jsonl',
          registrationType: 'archive.connection_registered',
        },
        counters: {
          recordedEvents: this.globalSeq,
          writtenEvents: this.writtenEvents,
          droppedEvents: this.droppedEvents,
          lastGlobalSeq: this.globalSeq,
          dataBytes: this.dataBytes,
          reservedBytes: this.reservedBytes,
          queuedBytes: this.queuedBytes,
          queuedHighWater: this.queuedHighWater,
          invalidMediaValues: this.invalidMediaValues,
        },
        limits: {
          maxBytes: this.maxBytes,
          maxQueuedBytes: this.maxQueuedBytes,
          retainRuns: this.retainRuns,
        },
        integrity:
          'Verify every referenced byte range with its sha256 before replay; send attempts are not proof of delivery.',
      };
      const json = `${JSON.stringify(manifest, null, 2)}\n`;
      if (Buffer.byteLength(json) > MANIFEST_BUDGET)
        throw new ArchiveIssue('manifest_limit');
      const destination = join(this.path, 'manifest.json');
      try {
        await privateFile(destination);
      } catch (error) {
        if (!object(error) || error['code'] !== 'ENOENT') throw error;
      }
      const candidate = join(this.path, `manifest-${randomUUID()}.tmp`);
      const handle = await open(candidate, CREATE_NOFOLLOW, 0o600);
      temporary = candidate;
      try {
        await handle.writeFile(json);
      } finally {
        await handle.close();
      }
      await rename(candidate, destination);
      temporary = undefined;
      this.lastManifestAt = Date.now();
    } catch (error) {
      this.fail(
        error instanceof ArchiveIssue ? error.code : 'manifest_write_failed',
      );
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
    }
  }

  private async prune(): Promise<void> {
    if (!this.rootIdentity) return;
    try {
      await privateDirectory(this.root, this.rootIdentity);
      const finished: Array<{ path: string; createdAt: number }> = [];
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        const name = RUN_NAME.exec(entry.name);
        if (!name || !entry.isDirectory()) continue;
        const path = join(this.root, entry.name);
        try {
          await privateDirectory(path);
          const marker = join(path, 'manifest.json');
          await privateFile(marker);
          const handle = await open(marker, READ_NOFOLLOW);
          let value: unknown;
          try {
            if ((await handle.stat()).size > MANIFEST_BUDGET) continue;
            value = JSON.parse(await handle.readFile('utf8'));
          } finally {
            await handle.close();
          }
          if (
            !object(value) ||
            value['format'] !== FORMAT ||
            value['owner'] !== 'qwen-live-harness' ||
            value['runId'] !== name[2] ||
            value['createdAt'] !== Number(name[1])
          )
            continue;
          let alive = true;
          const pid = value['pid'];
          if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
            continue;
          try {
            process.kill(pid, 0);
          } catch (error) {
            alive = !object(error) || error['code'] !== 'ESRCH';
          }
          if (!value['closedAt'] && alive) continue;
          finished.push({ path, createdAt: Number(value['createdAt']) });
        } catch {
          /* unrecognized or unsafe data is never deleted */
        }
      }
      finished.sort(
        (left, right) =>
          right.createdAt - left.createdAt ||
          right.path.localeCompare(left.path),
      );
      for (const entry of finished.slice(this.retainRuns)) {
        if (entry.path === this.path) continue;
        await privateDirectory(this.root, this.rootIdentity);
        await privateDirectory(entry.path);
        await rm(entry.path, { recursive: true, force: true });
      }
    } catch {
      /* retention failure must not interfere with capture or the app */
    }
  }
}
