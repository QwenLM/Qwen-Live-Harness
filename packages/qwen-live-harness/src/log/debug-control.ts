/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { DebugArchive } from './debug-archive.js';

/** Observe existing calls only. This never starts a device or a backend job. */
export function observeDebugControl<T extends object>(
  target: T,
  archive: DebugArchive | undefined,
  scope: string,
  methods: readonly string[],
): T {
  if (!archive) return target;
  let sequence = 0;
  const wrappers = new Map<PropertyKey, unknown>();
  const record = (type: string, payload: Record<string, unknown>) => {
    try {
      archive.recordRuntime(type, { scope, ...payload });
    } catch {
      // Diagnostics must not alter control flow, even with an injected sink.
    }
  };
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key, object);
      if (typeof value !== 'function') return value;
      if (wrappers.has(key)) return wrappers.get(key);
      const wrapped = (...args: unknown[]) => {
        const observed = typeof key === 'string' && methods.includes(key);
        const operationId = `${scope}:${++sequence}`;
        if (observed) {
          let savedArgs = args;
          // Output PCM already has exact chunk boundaries in the socket log.
          // Correlate Host acceptance without storing it a second time.
          if (key === 'sendOutputAudio' && args[1] instanceof Uint8Array) {
            savedArgs = [
              args[0],
              {
                bytes: args[1].byteLength,
                sha256: createHash('sha256').update(args[1]).digest('hex'),
              },
            ];
          }
          record('control.call', { operationId, method: key, args: savedArgs });
        }
        try {
          const result: unknown = Reflect.apply(value, object, args);
          if (observed) {
            if (result instanceof Promise) {
              void result.then(
                (resolved: unknown) =>
                  record('control.result', {
                    operationId,
                    status: 'fulfilled',
                    result: resolved,
                  }),
                (error: unknown) =>
                  record('control.result', {
                    operationId,
                    status: 'rejected',
                    error: errorDetails(error),
                  }),
              );
            } else {
              record('control.result', {
                operationId,
                status: 'returned',
                result,
              });
            }
          }
          return result;
        } catch (error) {
          if (observed)
            record('control.result', {
              operationId,
              status: 'threw',
              error: errorDetails(error),
            });
          throw error;
        }
      };
      wrappers.set(key, wrapped);
      return wrapped;
    },
  });
}

function errorDetails(error: unknown): unknown {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : error;
}

export const DEBUG_HOST_METHODS = [
  'setCallState',
  'setCoordinator',
  'sendOutputAudio',
  'finishOutputAudio',
  'clearOutput',
  'setCaption',
  'setStatusText',
  'setTranscript',
  'failCall',
  'setProviderReachability',
  'captureVisualContext',
] as const;

export const DEBUG_BACKEND_METHODS = [
  'createSession',
  'prompt',
  'sendInstruction',
  'cancel',
  'cancelJob',
  'respondPermission',
  'vote',
  'closeSession',
] as const;
