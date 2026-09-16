/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  QwenPeerDiscovery,
  type PeerDiscoveryEndpoint,
} from './qwen-peer-discovery.js';
import type { PeerSessionSummary } from '../vendor/qwen-code-peer/index.js';

const terminal: PeerSessionSummary = {
  sessionId: 'terminal-session',
  name: 'project',
  ref: 'abcdef',
  address: 'project [abcdef]',
  cwd: '/workspace/project',
  pid: 1234,
  kind: 'tui',
  startedAt: 1000,
};

function endpoint(
  peers: PeerSessionSummary[] = [terminal],
): PeerDiscoveryEndpoint {
  return { list: vi.fn(async () => peers), close: vi.fn(async () => {}) };
}

describe('Qwen peer discovery', () => {
  it('registers only during a call, exposes terminal records read-only, and omits other endpoint kinds', async () => {
    const peer = endpoint([
      terminal,
      { ...terminal, sessionId: 'managed', kind: 'serve' },
      { ...terminal, sessionId: 'acp', kind: 'headless' },
      { ...terminal, sessionId: 'external', kind: 'external' },
      terminal,
    ]);
    const open = vi.fn(async () => peer);
    const discovery = new QwenPeerDiscovery(
      { qwenHome: '/isolated/qwen' },
      'qwen',
      open,
    );
    expect(await discovery.list()).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    await discovery.start('call-1');
    expect(open).toHaveBeenCalledWith({
      name: 'live-qwen',
      qwenHome: '/isolated/qwen',
    });
    const rows = await discovery.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      handle: { adaptor: 'qwen', readOnly: true },
      state: 'unknown',
      label: terminal.address,
      discovery: { source: 'terminal', sessionId: terminal.sessionId },
    });
    expect(JSON.stringify(rows)).not.toMatch(/ipcToken|replyToken|ipcPath/);
    await discovery.stop('call-1');
    expect(await discovery.list()).toEqual([]);
    expect(peer.close).toHaveBeenCalledTimes(1);
  });

  it('keeps handles stable but scopes identical session ids to home and process incarnation', async () => {
    const peer = endpoint();
    const a = new QwenPeerDiscovery(
      { qwenHome: '/scope/a' },
      'qwen',
      async () => peer,
    );
    const b = new QwenPeerDiscovery(
      { qwenHome: '/scope/b' },
      'qwen',
      async () => endpoint(),
    );
    await a.start('a');
    await b.start('b');
    const first = (await a.list())[0]!.handle;
    expect((await a.list())[0]!.handle).toEqual(first);
    expect((await b.list())[0]!.handle.id).not.toEqual(first.id);
    vi.mocked(peer.list).mockResolvedValue([
      { ...terminal, pid: 5678, startedAt: 2000 },
    ]);
    expect((await a.list())[0]!.handle.id).not.toEqual(first.id);
    await a.close();
    await b.close();
  });

  it('does not confuse equal display names or expose control characters in names and directories', async () => {
    const discovery = new QwenPeerDiscovery(
      { qwenHome: '/scope/a' },
      'qwen',
      async () =>
        endpoint([
          {
            ...terminal,
            address: 'same\u202ename\n[abcdef]',
            cwd: '/path\u001b\n',
          },
          { ...terminal, sessionId: 'another', address: 'same name [123456]' },
          { ...terminal, sessionId: 'x'.repeat(257) },
          { ...terminal, sessionId: 'long-label', address: '😀'.repeat(150) },
        ]),
    );
    await discovery.start('call');
    const rows = await discovery.list();
    expect(rows).toHaveLength(3);
    expect(rows[0]!.handle.id).not.toEqual(rows[1]!.handle.id);
    expect(rows[0]!.label).toBe('same name [abcdef]');
    expect(rows[0]!.cwd).toBe('/path');
    expect(rows[2]!.label).toBe('😀'.repeat(120));
    await discovery.close();
  });

  it('closes a late endpoint if its call ended while binding', async () => {
    const peer = endpoint();
    let resolve!: (value: PeerDiscoveryEndpoint) => void;
    const binding = new Promise<PeerDiscoveryEndpoint>((r) => {
      resolve = r;
    });
    const open = vi.fn(() => binding);
    const discovery = new QwenPeerDiscovery(
      { qwenHome: '/scope/a' },
      'qwen',
      open,
    );
    const starting = discovery.start('old');
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    const stopped = discovery.stop('old');
    resolve(peer);
    await starting;
    await stopped;
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(await discovery.list()).toEqual([]);
  });

  it('does not let an old stop close the next call or publish a stale directory read', async () => {
    const old = endpoint();
    const next = endpoint();
    const open = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(next);
    const discovery = new QwenPeerDiscovery(
      { qwenHome: '/scope/a' },
      'qwen',
      open,
    );
    await discovery.start('old');
    let finish!: (peers: PeerSessionSummary[]) => void;
    vi.mocked(old.list).mockReturnValue(
      new Promise((r) => {
        finish = r;
      }),
    );
    const stale = discovery.list();
    await discovery.start('next');
    await discovery.stop('old');
    finish([terminal]);
    expect(await stale).toEqual([]);
    expect(next.close).not.toHaveBeenCalled();
    expect(await discovery.list()).toHaveLength(1);
    await discovery.close();
  });

  it('can retry a failed bind and retains failed close ownership for cleanup', async () => {
    const peer = endpoint();
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error('bind failed'))
      .mockResolvedValue(peer);
    const discovery = new QwenPeerDiscovery(
      { qwenHome: '/scope/a' },
      'qwen',
      open,
    );
    await expect(discovery.start('first')).rejects.toThrow('bind failed');
    await discovery.start('second');
    vi.mocked(peer.close).mockRejectedValueOnce(new Error('close failed'));
    await expect(discovery.stop('second')).rejects.toThrow('close failed');
    expect(await discovery.list()).toEqual([]);
    await discovery.close();
    expect(peer.close).toHaveBeenCalledTimes(2);
  });
});
