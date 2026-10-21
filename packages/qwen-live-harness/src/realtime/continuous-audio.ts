/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** Streaming 16 -> 24 kHz PCM conversion. Chunk edges retain the last sample. */
export class LivePcmResampler {
  private samples: number[] = [];
  private inputCount = 0;
  private outputCount = 0;
  private bufferStart = 0;

  push(bytes: Uint8Array, final = false): Uint8Array {
    if (bytes.length % 2) throw new Error('PCM must contain complete samples.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < bytes.length; i += 2)
      this.samples.push(view.getInt16(i, true));
    this.inputCount += bytes.length / 2;
    const output: number[] = [];
    const target = final ? Math.round(this.inputCount * 1.5) : Infinity;
    while (this.outputCount < target) {
      const numerator = this.outputCount * 2;
      const index = Math.floor(numerator / 3);
      if (index >= this.inputCount || (!final && index + 1 >= this.inputCount))
        break;
      const fraction = (numerator % 3) / 3;
      output.push(
        Math.round(
          this.samples[index - this.bufferStart]! * (1 - fraction) +
            this.samples[
              Math.min(index + 1, this.inputCount - 1) - this.bufferStart
            ]! *
              fraction,
        ),
      );
      this.outputCount++;
    }
    const discard = Math.max(
      0,
      Math.floor((this.outputCount * 2) / 3) - this.bufferStart,
    );
    this.samples.splice(0, discard);
    this.bufferStart += discard;
    const result = new Uint8Array(output.length * 2);
    const converted = new DataView(result.buffer);
    output.forEach((sample, i) => converted.setInt16(i * 2, sample, true));
    if (final) {
      this.samples = [];
      this.inputCount = 0;
      this.outputCount = 0;
      this.bufferStart = 0;
    }
    return result;
  }
}

/** Audio-defined playback segments, never model response or tool boundaries. */
export class ContinuousAudio {
  private resampler = new LivePcmResampler();
  private silentSamples = 0;
  private active = false;
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly sink: {
      send(audio: Uint8Array): boolean;
      finish(): void;
    },
  ) {}

  push(audio: Uint8Array): boolean {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
    let audible = false;
    for (let i = 0; i < audio.length; i += 2) {
      if (Math.abs(view.getInt16(i, true)) > 96) {
        audible = true;
        break;
      }
    }
    if (!this.active && !audible) return true;
    this.active = true;
    this.silentSamples = audible ? 0 : this.silentSamples + audio.length / 2;
    const output = this.resampler.push(audio);
    if (output.length && !this.sink.send(output)) return false;
    if (this.silentSamples >= 4_800) this.finish();
    else {
      // A local playback segment can close after an empty receive queue.
      // A delayed continuation starts another segment; no response, task or
      // announcement is marked complete by this receive-gap heuristic.
      this.idleTimer = setTimeout(() => this.finish(), 800);
      this.idleTimer.unref?.();
    }
    return true;
  }

  finish(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (!this.active) return;
    const tail = this.resampler.push(new Uint8Array(), true);
    if (tail.length) this.sink.send(tail);
    this.sink.finish();
    this.active = false;
    this.silentSamples = 0;
  }

  clear(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.active = false;
    this.silentSamples = 0;
    this.resampler = new LivePcmResampler();
  }
}
