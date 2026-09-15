/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QwenPeerDiscovery,
  type PeerDiscoveryEndpoint,
} from './qwen-peer-discovery.js';
import {
  PeerEndpoint,
  peerRef,
  readLiveSessionRecords,
  sessionRegistryDir,
  type PeerSessionSummary,
} from '../vendor/qwen-code-peer/index.js';
import { QwenPeerReports } from './qwen-peer-reports.js';
import { qwenPeerHandleId } from './qwen-peer-controller.js';
import type { PeerSessionReport } from './types.js';

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function sendReport(
  sender: PeerEndpoint,
  address: string,
  content: string,
) {
  const sent = await sender.send({ to: address, content });
  if (sent.kind !== 'sent') throw new Error('Report was not written');
  return sender.awaitReceipt(sent.msgId, { timeoutMs: 2000 });
}

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

  it('enables only text instructions with a grant and notifies when the next call clears deliveries', async () => {
    const token = `qpc_${'a'.repeat(64)}`;
    const readRecords = vi.fn(async () => [
      {
        ...terminal,
        schemaVersion: 1,
        procStart: null,
        pidNs: null,
        qwenVersion: null,
        ipcPath: '/selected.sock',
      },
    ]);
    const sendFrame = vi.fn(async () => {});
    const open = vi.fn(async () => endpoint());
    const discovery = new QwenPeerDiscovery(
      { qwenHome: '/scope/a', controllerToken: token },
      'qwen',
      open,
      {
        readRecords,
        sendFrame,
        startInbox: async () => ({
          socketPath: '/receipts.sock',
          close: async () => {},
          closeSync: () => {},
        }),
      },
    );
    const sizes: number[] = [];
    const unsubscribe = discovery.subscribe(() =>
      sizes.push(discovery.deliveries().length),
    );
    await discovery.start('first');
    const target = (await discovery.list())[0]!.handle;
    expect(target).toMatchObject({ instructionOnly: true });
    expect(target).not.toHaveProperty('readOnly');
    expect(await discovery.send(target, 'continue')).toMatchObject({
      status: 'sent',
    });
    expect(discovery.deliveries()).toHaveLength(1);
    await discovery.stop('first');
    expect(discovery.deliveries()[0]).toMatchObject({
      status: 'unknown',
      tracking: false,
    });
    await discovery.start('second');
    expect(discovery.deliveries()).toEqual([]);
    expect(sizes.at(-1)).toBe(0);
    expect(open).toHaveBeenCalledWith({
      name: 'live-qwen',
      qwenHome: '/scope/a',
    });
    unsubscribe();
    await discovery.close();
  });

  it('rolls back discovery if the receipt inbox fails and hides its sensitive diagnostic', async () => {
    const token = `qpc_${'a'.repeat(64)}`;
    const peer = endpoint();
    const discovery = new QwenPeerDiscovery(
      { qwenHome: '/scope/a', controllerToken: token },
      'qwen',
      async () => peer,
      {
        startInbox: async () => {
          throw new Error(`${token} /sensitive/path`);
        },
      },
    );
    await expect(discovery.start('call')).rejects.toThrow(
      'Terminal instruction delivery could not be started.',
    );
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(await discovery.list()).toEqual([]);
    expect(
      await discovery.send(
        { id: 'qwen-peer:old', adaptor: 'qwen' },
        'continue',
      ),
    ).toMatchObject({ status: 'rejected' });
    await discovery.close();
  });

  it.each([undefined, `qpc_${'a'.repeat(64)}`])(
    'receives call-scoped reports and preserves terminal control capabilities (token: %s)',
    async (controllerToken) => {
      const home = await mkdtemp(
        path.join(tmpdir(), 'qwen-discovery-reports-'),
      );
      cleanups.push(() => rm(home, { recursive: true, force: true }));
      const discovery = new QwenPeerDiscovery(
        { qwenHome: home, reports: true, controllerToken },
        'qwen',
      );
      cleanups.push(() => discovery.close());
      const sender = await PeerEndpoint.start({
        qwenHome: home,
        name: 'terminal',
        kind: 'tui',
        keepAlive: false,
      });
      cleanups.push(() => sender.close());
      const targetRecord = (
        await readLiveSessionRecords(sessionRegistryDir(home))
      ).find((entry) => entry.sessionId === sender.sessionId)!;
      const target = {
        id: qwenPeerHandleId(home, targetRecord),
        adaptor: 'qwen',
      };
      expect(discovery.createReportContext(target)).toBeUndefined();
      await discovery.start('call-one');
      const context = discovery.createReportContext(target)!;
      const registered = (await sender.list()).find(
        (entry) => entry.kind === 'external',
      )!;
      const address = `${registered.name} [${registered.ref}]`;
      expect(context.instruction).toContain(address);
      expect(await sendReport(sender, address, 'No sink yet')).toMatchObject({
        status: 'refused',
      });
      const received: PeerSessionReport[] = [];
      const unsubscribe = discovery.subscribeReports((report) => {
        received.push(report);
        return true;
      });
      const content = JSON.stringify({
        qwen_live_harness_report: 1,
        correlation: context.id,
        kind: 'result',
        text: 'Result report',
      });
      expect(await sendReport(sender, address, content)).toMatchObject({
        status: 'delivered',
      });
      expect(received[0]).toMatchObject({
        callId: 'call-one',
        sourceStatus: 'matched',
        correlationId: context.id,
        sourceSession: { ...target, instructionOnly: true },
      });
      expect(received[0]!.sourceSession?.readOnly).toBe(
        controllerToken === undefined ? true : undefined,
      );
      expect((await discovery.list())[0]!.handle.readOnly).toBe(
        controllerToken === undefined ? true : undefined,
      );
      await discovery.start('call-two');
      await discovery.stop('call-one');
      const next = (await sender.list()).find(
        (entry) => entry.kind === 'external',
      )!;
      const nextAddress = `${next.name} [${next.ref}]`;
      expect(nextAddress).not.toBe(address);
      expect(
        (await sender.list()).some(
          (entry) => entry.sessionId === registered.sessionId,
        ),
      ).toBe(false);
      expect(await sendReport(sender, nextAddress, content)).toMatchObject({
        status: 'delivered',
      });
      expect(received[1]).toMatchObject({ callId: 'call-two' });
      expect(received[1]).not.toHaveProperty('correlationId');
      unsubscribe();
      expect(await sendReport(sender, nextAddress, 'Sink gone')).toMatchObject({
        status: 'refused',
      });
      await discovery.stop('call-two');
      expect(discovery.createReportContext(target)).toBeUndefined();
      expect(await discovery.list()).toEqual([]);
    },
  );

  it('refuses reports during a late startup and removes that endpoint if its call stops before startup finishes', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'qwen-report-start-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const sender = await PeerEndpoint.start({
      qwenHome: home,
      name: 'terminal',
      kind: 'tui',
      keepAlive: false,
    });
    cleanups.push(() => sender.close());
    let registered!: () => void;
    const hasRegistered = new Promise<void>((resolve) => {
      registered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalStart = QwenPeerReports.start.bind(QwenPeerReports);
    let late!: QwenPeerReports;
    vi.spyOn(QwenPeerReports, 'start').mockImplementation(async (...args) => {
      late = await originalStart(...args);
      registered();
      await gate;
      return late;
    });
    const discovery = new QwenPeerDiscovery(
      { qwenHome: home, reports: true },
      'qwen',
    );
    cleanups.push(async () => {
      release();
      await discovery.close();
    });
    const received = vi.fn(() => true);
    discovery.subscribeReports(received);
    const starting = discovery.start('old-call');
    await hasRegistered;
    const address = `${late.name} [${peerRef(late.sessionId)}]`;
    expect(await sendReport(sender, address, 'While starting')).toMatchObject({
      status: 'refused',
    });
    const stopping = discovery.stop('old-call');
    release();
    await starting;
    await stopping;
    expect(received).not.toHaveBeenCalled();
    expect(
      (await sender.list()).some((entry) => entry.sessionId === late.sessionId),
    ).toBe(false);
    expect(await discovery.list()).toEqual([]);
  });
});
