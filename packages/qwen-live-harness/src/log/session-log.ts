/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Append-only JSONL log for one live session. Records conversation/control
 * metadata; opt-in Monitor debug media lives in separate archives. It also
 * serves as a timing-bug forensics source for the orchestrator state machine.
 *
 * Redaction rules: never log API keys or raw audio; screenshots are logged
 * as asset ids, not bytes.
 */

import {
  createWriteStream,
  mkdirSync,
  openSync,
  renameSync,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export type SessionLogEventType =
  | 'session.start'
  | 'session.end'
  | 'vad.speech_started'
  | 'vad.speech_stopped'
  | 'audio.input_mute_changed'
  | 'audio.input_heartbeat'
  | 'transcript.user'
  | 'transcript.assistant'
  | 'response.created'
  | 'response.done'
  | 'response.cancelled'
  | 'realtime.protocol'
  | 'tool.call'
  | 'tool.result'
  | 'backend.event'
  | 'proactive.debug'
  | 'failure'
  | 'instruction.delivery'
  | 'session.report'
  | 'search.delivery'
  | 'visual.analysis'
  | 'inject.context'
  | 'inject.speech'
  | 'permission.request'
  | 'permission.decision'
  | 'playback.started'
  | 'playback.cleared'
  | 'error';

export interface SessionLogOptions {
  directory: string;
  liveSessionId: string;
  maxBytes?: number;
  now?: () => number;
  /** Optional opt-in debug timeline mirror; never affects the normal log. */
  onEvent?: (event: Record<string, unknown>) => void;
}

export class SessionLog {
  private stream: WriteStream | undefined;
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private seq = 0;
  private bytes = 0;
  private rotations = 0;
  private failed = false;
  private closed = false;

  constructor(private readonly options: SessionLogOptions) {
    this.path = join(options.directory, `${options.liveSessionId}.jsonl`);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  /**
   * Logging must never take the call down: failures flip to no-op mode, and
   * writes after close() are dropped (a reopened stream would only lose its
   * buffer at process.exit).
   */
  write(type: SessionLogEventType, payload: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      const event = {
        ts: this.now(),
        seq: ++this.seq,
        type,
        payload,
      };
      try {
        this.options.onEvent?.(event);
      } catch {
        // A diagnostic observer must never disable the normal session log.
      }
      if (this.failed) return;
      const line = `${JSON.stringify(event)}\n`;
      const bytes = Buffer.byteLength(line);
      if (this.bytes + bytes > this.maxBytes) {
        this.rotate();
      }
      this.ensureStream().write(line);
      this.bytes += bytes;
    } catch {
      this.failed = true;
    }
  }

  /** Terminal: later write() calls are documented no-ops. */
  async close(): Promise<void> {
    this.closed = true;
    const stream = this.stream;
    this.stream = undefined;
    if (!stream) return;
    await new Promise<void>((resolve) => {
      stream.end(() => {
        resolve();
      });
    });
  }

  get filePath(): string {
    return this.path;
  }

  private ensureStream(): WriteStream {
    if (!this.stream) {
      mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
      // Open synchronously so the file exists on disk before write() returns;
      // rotate() relies on a synchronous rename of an existing path.
      const fd = openSync(this.path, 'a', 0o600);
      this.stream = createWriteStream(this.path, { fd });
      this.stream.on('error', () => {
        this.failed = true;
      });
    }
    return this.stream;
  }

  /**
   * Rotation must complete before the next line is written, or the freshly
   * reopened stream would share the old inode and the rename would drag it
   * along (observed as reordered lines in the rotated file and a missing
   * main file). Rename synchronously first, then let the old stream flush
   * its remaining buffer into the rotated file it already points at.
   */
  private rotate(): void {
    const stream = this.stream;
    this.stream = undefined;
    this.bytes = 0;
    const rotatedTo = `${this.path}.${++this.rotations}`;
    try {
      renameSync(this.path, rotatedTo);
    } catch {
      /* nothing to rotate */
    }
    stream?.end();
  }
}
