/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { ContinuousAudio, LivePcmResampler } from './continuous-audio.js';

afterEach(() => vi.useRealTimers());

it('produces identical continuous samples across arbitrary input chunks', () => {
  const input = Buffer.alloc(6400);
  for (let i = 0; i < input.length / 2; i++)
    input.writeInt16LE(Math.round(Math.sin(i / 10) * 15000), i * 2);
  const whole = new LivePcmResampler().push(input, true);
  const stream = new LivePcmResampler();
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < input.length; i += 74)
    chunks.push(stream.push(input.subarray(i, i + 74)));
  chunks.push(stream.push(new Uint8Array(), true));
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(whole));
  expect(whole.length).toBe(input.length * 1.5);
});

it('closes playback segments from silence and keeps delayed speech as a new segment', async () => {
  vi.useFakeTimers();
  const sink = { send: vi.fn(() => true), finish: vi.fn() };
  const audio = new ContinuousAudio(sink);
  const speech = Buffer.alloc(640);
  for (let i = 0; i < 640; i += 2) speech.writeInt16LE(1200, i);
  audio.push(speech);
  for (let i = 0; i < 15; i++) audio.push(Buffer.alloc(640));
  expect(sink.finish).toHaveBeenCalledOnce();
  audio.push(speech);
  await vi.advanceTimersByTimeAsync(800);
  expect(sink.finish).toHaveBeenCalledTimes(2);
  audio.clear();
});

it('cancels local audio timers when output is discarded', async () => {
  vi.useFakeTimers();
  const sink = { send: vi.fn(() => true), finish: vi.fn() };
  const audio = new ContinuousAudio(sink);
  const bytes = Buffer.alloc(640, 20);
  audio.push(bytes);
  audio.clear();
  await vi.advanceTimersByTimeAsync(1000);
  expect(sink.finish).not.toHaveBeenCalled();
});
