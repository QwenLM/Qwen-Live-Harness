/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { BackendRegistry } from './registry.js';
import type { BackendAdaptor } from './types.js';

function adaptor(name: string, failure?: Error): BackendAdaptor {
  return {
    name,
    preflight: vi.fn(async () => {
      if (failure) throw failure;
    }),
    close: vi.fn(async () => {}),
  } as unknown as BackendAdaptor;
}

describe('backend registry availability', () => {
  it('allows an explicitly empty registry without a placeholder or preflight work', async () => {
    const registry = new BackendRegistry([]);
    const log = vi.fn();
    const progress = vi.fn();
    expect(registry.hasBackends).toBe(false);
    expect(registry.names()).toEqual([]);
    expect(registry.all()).toEqual([]);
    expect(registry.byAdaptorName('default')).toBeUndefined();
    await expect(registry.preflight(log, progress)).resolves.toBeUndefined();
    await expect(registry.closeAll(log)).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    expect(() => registry.defaultAdaptor).toThrow(
      'no default backend configured',
    );
  });

  it('does not silently switch to no-backend mode when the configured default fails', async () => {
    const failure = new Error('configured coding agent unavailable');
    const backend = adaptor('configured', failure);
    const registry = new BackendRegistry([
      { adaptor: backend, isDefault: true },
    ]);
    expect(registry.hasBackends).toBe(true);
    await expect(registry.preflight(vi.fn())).rejects.toBe(failure);
    expect(registry.names()).toEqual(['configured']);
    expect(registry.defaultAdaptor).toBe(backend);
  });

  it('retains default-first preflight and optional-backend failure isolation', async () => {
    const first = adaptor('primary');
    const second = adaptor('secondary', new Error('missing executable'));
    const registry = new BackendRegistry([
      { adaptor: first, isDefault: true },
      { adaptor: second, isDefault: false },
    ]);
    const progress = vi.fn();
    const log = vi.fn();
    await registry.preflight(log, progress);
    expect(registry.hasBackends).toBe(true);
    expect(registry.defaultName).toBe('primary');
    await registry.whenReady('secondary');
    expect(progress.mock.calls.map(([event]) => event)).toEqual([
      { backend: 'primary', stage: 'starting' },
      { backend: 'primary', stage: 'ready' },
      { backend: 'secondary', stage: 'starting' },
      { backend: 'secondary', stage: 'unavailable' },
    ]);
    expect(registry.byAdaptorName('secondary')?.status).toBe('unavailable');
    expect(log).toHaveBeenCalledWith(
      "backend 'secondary' unavailable: missing executable",
    );
    await registry.closeAll(log);
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('does not hold the ready signal on a secondary warm-up', async () => {
    const primary = adaptor('primary');
    let release!: () => void;
    const warmUp = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startSlow = vi.fn(() => warmUp);
    const secondary = {
      name: 'secondary',
      preflight: startSlow,
      close: vi.fn(async () => {}),
    } as unknown as BackendAdaptor;
    const registry = new BackendRegistry([
      { adaptor: primary, isDefault: true },
      { adaptor: secondary, isDefault: false },
    ]);
    const progress = vi.fn();
    const log = vi.fn();

    // A slow secondary starts its handshake but never delays readiness.
    await expect(registry.preflight(log, progress)).resolves.toBeUndefined();
    expect(startSlow).toHaveBeenCalledOnce();
    const entry = registry.byAdaptorName('secondary');
    expect(entry?.status).toBe('starting');
    expect(entry?.lastError).toBeUndefined();

    let settled = false;
    const pending = registry.whenReady('secondary').then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await pending;
    expect(entry?.status).toBe('ready');
    expect(progress.mock.calls.map(([event]) => event)).toEqual([
      { backend: 'primary', stage: 'starting' },
      { backend: 'primary', stage: 'ready' },
      { backend: 'secondary', stage: 'starting' },
      { backend: 'secondary', stage: 'ready' },
    ]);
    expect(log).not.toHaveBeenCalled();
    await registry.closeAll(log);
    expect(secondary.close).toHaveBeenCalledOnce();
  });

  it('keeps a shutdown-interrupted warm-up out of the warnings', async () => {
    const primary = adaptor('primary');
    let refuse!: (error: Error) => void;
    const warmUp = new Promise<void>((_resolve, reject) => {
      refuse = reject;
    });
    const secondary = {
      name: 'secondary',
      preflight: vi.fn(() => warmUp),
      close: vi.fn(async () => {}),
    } as unknown as BackendAdaptor;
    const registry = new BackendRegistry([
      { adaptor: primary, isDefault: true },
      { adaptor: secondary, isDefault: false },
    ]);
    const progress = vi.fn();
    const log = vi.fn();
    await registry.preflight(log, progress);
    await registry.closeAll(log);

    refuse(new Error("acp backend 'secondary' is closed"));
    await registry.whenReady('secondary');
    expect(registry.byAdaptorName('secondary')?.status).toBe('unavailable');
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps a reporter fault out of the warm-up result', async () => {
    const primary = adaptor('primary');
    let refuse!: (error: Error) => void;
    const warmUp = new Promise<void>((_resolve, reject) => {
      refuse = reject;
    });
    const secondary = {
      name: 'secondary',
      preflight: vi.fn(() => warmUp),
      close: vi.fn(async () => {}),
    } as unknown as BackendAdaptor;
    const registry = new BackendRegistry([
      { adaptor: primary, isDefault: true },
      { adaptor: secondary, isDefault: false },
    ]);
    const log = vi.fn(() => {
      throw new Error('logger closed');
    });

    await registry.preflight(log, vi.fn());
    const waiting = registry.whenReady('secondary');
    refuse(new Error('missing executable'));
    // A reporter that throws must not reject the waiter the caller depends on:
    // the failure is already recorded on the entry, and an unhandled rejection
    // would take the daemon down with it.
    await expect(waiting).resolves.toBeUndefined();
    expect(registry.byAdaptorName('secondary')?.status).toBe('unavailable');
    expect(registry.byAdaptorName('secondary')?.lastError).toBe(
      'missing executable',
    );
  });
});
