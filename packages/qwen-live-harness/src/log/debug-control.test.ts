/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { DebugArchive } from './debug-archive.js';
import { observeDebugControl } from './debug-control.js';

function fixture() {
  const recordRuntime = vi.fn();
  return {
    recordRuntime,
    archive: { recordRuntime } as unknown as DebugArchive,
  };
}

describe('debug control observation', () => {
  it('leaves disabled controls identical and never invokes unrequested actions', () => {
    const target = { capture: vi.fn(), prompt: vi.fn() };
    expect(observeDebugControl(target, undefined, 'host', ['capture'])).toBe(
      target,
    );
    const { archive, recordRuntime } = fixture();
    observeDebugControl(target, archive, 'host', ['capture']);
    expect(target.capture).not.toHaveBeenCalled();
    expect(target.prompt).not.toHaveBeenCalled();
    expect(recordRuntime).not.toHaveBeenCalled();
  });

  it('preserves receivers, synchronous values and unlogged polling', () => {
    const { archive, recordRuntime } = fixture();
    const target = {
      ready: true,
      isReady() {
        return this.ready;
      },
      set(value: boolean) {
        this.ready = value;
        return this.ready;
      },
    };
    const observed = observeDebugControl(target, archive, 'host', ['set']);
    expect(observed.isReady()).toBe(true);
    expect(recordRuntime).not.toHaveBeenCalled();
    expect(observed.set(false)).toBe(false);
    expect(recordRuntime.mock.calls[0]).toEqual([
      'control.call',
      { scope: 'host', operationId: 'host:2', method: 'set', args: [false] },
    ]);
    expect(recordRuntime.mock.calls[1]?.[1]).toMatchObject({
      status: 'returned',
      result: false,
    });
    expect(observed.set).toBe(observed.set);
  });

  it('keeps the original promise and reports completion or failure without swallowing it', async () => {
    const { archive, recordRuntime } = fixture();
    const error = new Error('backend failed');
    const success = Promise.resolve({ status: 'accepted' });
    const failure = Promise.reject(error);
    const observed = observeDebugControl(
      { prompt: () => success, cancel: () => failure },
      archive,
      'backend',
      ['prompt', 'cancel'],
    );
    expect(observed.prompt()).toBe(success);
    expect(observed.cancel()).toBe(failure);
    await expect(failure).rejects.toBe(error);
    await success;
    expect(
      recordRuntime.mock.calls.some(
        ([, payload]) => payload.status === 'fulfilled',
      ),
    ).toBe(true);
    expect(
      recordRuntime.mock.calls.some(
        ([, payload]) =>
          payload.status === 'rejected' &&
          payload.error.message === 'backend failed',
      ),
    ).toBe(true);
  });

  it('logs output acceptance and PCM hash without duplicating audio bytes', () => {
    const { archive, recordRuntime } = fixture();
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const sendOutputAudio = vi.fn((_epoch: number, _pcm: Uint8Array) => false);
    const observed = observeDebugControl({ sendOutputAudio }, archive, 'host', [
      'sendOutputAudio',
    ]);
    expect(observed.sendOutputAudio(7, pcm)).toBe(false);
    expect(sendOutputAudio).toHaveBeenCalledWith(7, pcm);
    const args = recordRuntime.mock.calls[0]?.[1].args;
    expect(args).toEqual([
      7,
      { bytes: 4, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    ]);
    expect(recordRuntime.mock.calls[1]?.[1].result).toBe(false);
  });

  it('preserves synchronous failures even if the diagnostic sink throws', () => {
    const { archive, recordRuntime } = fixture();
    recordRuntime.mockImplementation(() => {
      throw new Error('disk full');
    });
    const error = new Error('device missing');
    const observed = observeDebugControl(
      {
        capture() {
          throw error;
        },
      },
      archive,
      'host',
      ['capture'],
    );
    expect(() => observed.capture()).toThrow(error);
  });
});
