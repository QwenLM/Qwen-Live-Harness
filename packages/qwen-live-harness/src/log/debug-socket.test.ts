/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { DebugArchive } from './debug-archive.js';
import { createDebugSocket } from './debug-socket.js';

class Socket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly frames: unknown[][] = [];
  sendError?: Error;
  closeCalls = 0;
  terminateCalls = 0;
  get stateAlias(): number {
    return this.readyState;
  }
  send(...args: unknown[]): string {
    if (this.sendError) throw this.sendError;
    this.frames.push(args);
    return 'locally-accepted';
  }
  close(): void {
    this.closeCalls++;
    this.readyState = 2;
  }
  terminate(): void {
    this.terminateCalls++;
    this.readyState = 3;
  }
}

function fixture() {
  const entries: Array<{ direction: string; event: Record<string, unknown> }> =
    [];
  const connection = {
    id: 'connection-1',
    path: '/synthetic/connection-1',
    record: vi.fn((direction: string, event: Record<string, unknown>) =>
      entries.push({ direction, event }),
    ),
    close: vi.fn(),
  };
  const beginConnection = vi.fn(() => connection);
  const debugArchive = { beginConnection } as unknown as DebugArchive;
  const raw = new Socket();
  const socket = createDebugSocket(() => raw, {
    debugArchive,
    info: {
      kind: 'main',
      model: 'test-model',
      endpoint: 'wss://user:password@example.test/realtime?api_key=secret',
      epoch: 7,
    },
  });
  return { entries, connection, beginConnection, debugArchive, raw, socket };
}

describe('debug socket observer', () => {
  it('returns the original socket with no listeners or wrappers when disabled', () => {
    const raw = new Socket();
    const socket = createDebugSocket(() => raw, {
      info: { kind: 'main', model: 'test', endpoint: 'wss://example.test' },
    });
    expect(socket).toBe(raw);
    expect(raw.eventNames()).toEqual([]);
  });

  it('records attempted sends before the actual send and preserves arguments, return values and getters', () => {
    const f = fixture();
    expect(f.beginConnection).toHaveBeenCalledWith({
      kind: 'main',
      model: 'test-model',
      endpoint: 'wss://example.test/realtime',
      epoch: 7,
    });
    const body = JSON.stringify({
      type: 'session.update',
      session: { instructions: 'keep\nnewlines', tools: [] },
    });
    const original = f.raw.send.bind(f.raw);
    f.raw.send = (...args) => {
      expect(f.entries.at(-1)).toMatchObject({
        direction: 'out',
        event: {
          type: 'wire.send',
          attemptId: 'send-1',
          event: JSON.parse(body),
        },
      });
      return original(...args);
    };
    expect(f.socket.send(body)).toBe('locally-accepted');
    expect(f.raw.frames).toEqual([[body]]);
    expect(f.entries.at(-1)).toEqual({
      direction: 'local',
      event: { type: 'wire.send_result', attemptId: 'send-1', status: 'sent' },
    });
    f.raw.bufferedAmount = 1234;
    expect(f.socket.bufferedAmount).toBe(1234);
    f.socket.readyState = 3;
    expect(f.raw.readyState).toBe(3);
    expect(f.socket.stateAlias).toBe(3);
    expect(f.socket.send).toBe(f.socket.send);
  });

  it('records provider data before the parser and preserves listener chaining and callback errors', () => {
    const f = fixture();
    const failure = new Error('parser failed');
    expect(
      f.socket.on('message', (raw, binary) => {
        expect(raw).toBe('not-json');
        expect(binary).toBe(false);
        expect(f.entries.at(-1)).toMatchObject({
          direction: 'in',
          event: {
            type: 'wire.receive',
            binary: false,
            event: { raw: { data: 'not-json' } },
          },
        });
        throw failure;
      }),
    ).toBe(f.raw);
    expect(() => f.raw.emit('message', 'not-json', false)).toThrow(failure);
  });

  it('keeps full malformed and binary payloads for the archive budget to accept or mark incomplete', () => {
    const f = fixture();
    const text = 'malformed '.repeat(20_000);
    f.raw.emit('message', Buffer.from(text), false);
    expect(f.entries.at(-1)?.event).toEqual({
      type: 'wire.receive',
      binary: false,
      event: {
        raw: {
          kind: 'text',
          encoding: 'utf8',
          data: text,
          bytes: Buffer.byteLength(text),
        },
      },
    });
    const binary = Buffer.alloc(80_000, 123);
    f.raw.emit('message', binary, true);
    expect(f.entries.at(-1)?.event).toEqual({
      type: 'wire.receive',
      binary: true,
      event: {
        raw: {
          kind: 'binary',
          encoding: 'base64',
          data: binary.toString('base64'),
          bytes: binary.length,
        },
      },
    });
  });

  it('records failure or uncertainty and rethrows the identical send error without copying sensitive error text', () => {
    const f = fixture();
    const error = Object.assign(new Error('Authorization: Bearer PRIVATE'), {
      code: 'ECONNRESET',
    });
    f.raw.sendError = error;
    expect(() => f.socket.send('{"type":"response.create"}')).toThrow(error);
    expect(f.entries.at(-1)).toMatchObject({
      direction: 'local',
      event: {
        type: 'wire.send_result',
        attemptId: 'send-1',
        status: 'failed_or_uncertain',
        code: 'ECONNRESET',
      },
    });
    expect(JSON.stringify(f.entries)).not.toContain('PRIVATE');
  });

  it('records construction failure and preserves the original thrown object', () => {
    const f = fixture();
    const error = new Error('https://secret@provider.test');
    expect(() =>
      createDebugSocket(
        () => {
          throw error;
        },
        {
          debugArchive: f.debugArchive,
          info: {
            kind: 'search',
            model: 'test',
            endpoint: 'wss://example.test',
          },
        },
      ),
    ).toThrow(error);
    expect(f.entries.at(-1)?.event).toMatchObject({
      type: 'transport.construct_failed',
      name: 'Error',
    });
    expect(f.connection.close).toHaveBeenCalledWith('construction_failed');
    expect(JSON.stringify(f.entries)).not.toContain('secret@');
  });

  it('records transport events without reading HTTP request headers and preserves close/terminate calls', () => {
    const f = fixture();
    f.raw.emit('open');
    f.raw.emit(
      'error',
      Object.assign(new Error('private endpoint'), { code: 'ETIMEDOUT' }),
    );
    const request = {
      get headers() {
        throw new Error('must not inspect headers');
      },
    };
    f.raw.emit('unexpected-response', request, {
      statusCode: 403,
      headers: { authorization: 'PRIVATE' },
    });
    f.socket.close();
    f.socket.terminate();
    f.raw.emit('close', 1011, Buffer.from('internal error'));
    expect(f.raw.closeCalls).toBe(1);
    expect(f.raw.terminateCalls).toBe(1);
    expect(f.entries.map(({ event }) => event['type'])).toEqual([
      'transport.construct',
      'transport.open',
      'transport.error',
      'transport.unexpected_response',
      'transport.close_requested',
      'transport.terminate_requested',
      'transport.close',
    ]);
    expect(f.entries[3]?.event).toEqual({
      type: 'transport.unexpected_response',
      status: 403,
    });
    expect(JSON.stringify(f.entries)).not.toContain('PRIVATE');
    expect(f.connection.close).toHaveBeenCalledWith('transport_closed');
  });

  it('does not turn archive failures into transport failures', () => {
    const raw = new Socket();
    const beginningFails = {
      beginConnection() {
        throw new Error('disk');
      },
    } as unknown as DebugArchive;
    expect(
      createDebugSocket(() => raw, {
        debugArchive: beginningFails,
        info: { kind: 'main', model: 'test', endpoint: 'wss://example.test' },
      }),
    ).toBe(raw);
    const f = fixture();
    f.connection.record.mockImplementation(() => {
      throw new Error('disk');
    });
    f.connection.close.mockImplementation(() => {
      throw new Error('disk');
    });
    expect(f.socket.send('{"type":"response.create"}')).toBe(
      'locally-accepted',
    );
    expect(() =>
      f.raw.emit('message', '{"type":"response.done"}', false),
    ).not.toThrow();
    expect(() => f.raw.emit('close', 1000)).not.toThrow();
  });

  it('does not swallow or replace a transport close failure', () => {
    const f = fixture();
    const error = new Error('close failed');
    f.raw.close = () => {
      throw error;
    };
    expect(() => f.socket.close()).toThrow(error);
    expect(f.entries.at(-1)?.event).toMatchObject({
      type: 'transport.close_failed',
      name: 'Error',
    });
  });
});
