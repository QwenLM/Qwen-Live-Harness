/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export type RecoveryInput =
  | { kind: 'text'; itemId: string; text: string }
  | { kind: 'audio'; audio: Uint8Array; stopped: boolean }
  | { kind: 'none'; reason: 'completed' | 'tool_dispatched' | 'unavailable' };

const BYTES_PER_MS = 32;
export const MAX_RECOVERY_AUDIO_BYTES = 60_000 * BYTES_PER_MS;

/** Bounded real-microphone history, never protocol-silence replay. */
export class RecoveryInputBuffer {
  private position = 0;
  private bytes = 0;
  private frames: Array<{ start: number; audio: Uint8Array }> = [];
  private latest:
    | {
        itemId: string;
        start?: number;
        text?: string;
        completed?: boolean;
        dispatched?: boolean;
        stopped?: boolean;
      }
    | undefined;

  audio(audio: Uint8Array): void {
    this.frames.push({ start: this.position, audio: Uint8Array.from(audio) });
    this.position += audio.byteLength;
    this.bytes += audio.byteLength;
    while (this.bytes > MAX_RECOVERY_AUDIO_BYTES) {
      this.bytes -= this.frames.shift()!.audio.byteLength;
    }
  }

  protocolSilence(bytes: number): void {
    this.position += bytes;
  }

  speech(itemId: string, startMs?: number): void {
    const reported =
      startMs === undefined
        ? undefined
        : Math.round((startMs * BYTES_PER_MS) / 2) * 2;
    const start =
      reported !== undefined && reported >= 0 && reported <= this.position
        ? reported
        : undefined;
    this.latest = { itemId, start };
  }

  committed(itemId: string): void {
    if (this.latest?.itemId !== itemId) this.latest = { itemId };
  }

  transcript(itemId: string, text: string): void {
    if (this.latest?.itemId === itemId) this.latest.text = text;
  }

  stopped(itemId: string | undefined): void {
    if (this.latest && (itemId === undefined || this.latest.itemId === itemId))
      this.latest.stopped = true;
  }

  completed(itemId: string): void {
    if (this.latest?.itemId === itemId) this.latest.completed = true;
  }

  dispatched(itemId: string | undefined): void {
    if (
      this.latest &&
      (itemId === undefined || this.latest.itemId === itemId)
    ) {
      this.latest.dispatched = true;
    }
  }

  restored(itemId: string, text: string): void {
    this.latest = { itemId, text, start: this.position };
  }

  snapshot(): RecoveryInput {
    const input = this.latest;
    if (!input || input.completed) return { kind: 'none', reason: 'completed' };
    if (input.dispatched) return { kind: 'none', reason: 'tool_dispatched' };
    if (input.text?.trim())
      return { kind: 'text', itemId: input.itemId, text: input.text };
    const first = this.frames[0];
    if (!first || input.start === undefined || input.start < first.start)
      return { kind: 'none', reason: 'unavailable' };
    const start = input.start;
    const audio = Buffer.concat(
      this.frames.flatMap((frame) => {
        const offset = Math.max(0, start - frame.start);
        return offset < frame.audio.byteLength
          ? [frame.audio.subarray(offset)]
          : [];
      }),
    );
    return audio.byteLength > 0
      ? { kind: 'audio', audio, stopped: input.stopped === true }
      : { kind: 'none', reason: 'unavailable' };
  }

  clear(): void {
    this.frames = [];
    this.bytes = 0;
  }
}
