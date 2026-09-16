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
  buildDeliveryStatusFrame,
  buildUserFrame,
  PeerSendError,
  sendPeerFrame,
  sessionRegistryDir,
  startPeerInbox,
  type PeerDeliveryStatus,
  type PeerFrame,
  type PeerInboxOptions,
  type SessionRecord,
} from '../vendor/qwen-code-peer/index.js';
import {
  readPidNamespaceId,
  readProcStartToken,
} from '../vendor/qwen-code-peer/identity.js';
import { writeOwnRecord } from '../vendor/qwen-code-peer/registry.js';
import {
  QwenPeerController,
  qwenPeerHandleId,
} from './qwen-peer-controller.js';

const TOKEN = `qpc_${'a'.repeat(64)}`;
const HOME = '/isolated/qwen';
const record: SessionRecord = {
  schemaVersion: 1,
  pid: 1234,
  procStart: null,
  pidNs: null,
  sessionId: 'terminal-1',
  name: 'same name',
  cwd: '/workspace',
  startedAt: 1000,
  qwenVersion: '0.23.3',
  kind: 'tui',
  ipcPath: '/selected-terminal.sock',
  ipcToken: 'ordinary-peer-token',
};
const handle = {
  id: qwenPeerHandleId(HOME, record),
  adaptor: 'qwen',
  instructionOnly: true as const,
};
const controllers: QwenPeerController[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(
    controllers.splice(0).map((controller) => controller.close()),
  );
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

async function setup(timeout = 30_000) {
  let active = true;
  let receive!: PeerInboxOptions['onFrame'];
  const inbox = {
    socketPath: '/receipt-only.sock',
    close: vi.fn(async () => {}),
    closeSync: vi.fn(),
  };
  const readRecords = vi.fn(async () => [record]);
  const sendFrame = vi.fn<typeof sendPeerFrame>(async () => {});
  const onChange = vi.fn();
  const startInbox = vi.fn(async (options: PeerInboxOptions) => {
    receive = options.onFrame;
    return inbox;
  });
  const controller = new QwenPeerController(
    {
      qwenHome: HOME,
      adaptor: 'qwen',
      name: 'Live',
      controllerToken: TOKEN,
      isActive: () => active,
      onChange,
    },
    { readRecords, sendFrame, startInbox, receiptTimeoutMs: timeout },
  );
  controllers.push(controller);
  await controller.start();
  const receipt = (id: string, status: PeerDeliveryStatus) =>
    receive(
      buildDeliveryStatusFrame({
        origMsgId: id,
        status,
        reason: `${TOKEN} /private/internal-error`,
      }),
    );
  return {
    controller,
    readRecords,
    sendFrame,
    startInbox,
    inbox,
    onChange,
    receive: (frame: PeerFrame) => receive(frame),
    receipt,
    deactivate: () => {
      active = false;
    },
  };
}

describe('pinned peer controller', () => {
  it('uses the exact fresh record, controller auth and full session pin without name resolution', async () => {
    const h = await setup();
    h.readRecords.mockResolvedValue([
      {
        ...record,
        sessionId: 'another-session',
        pid: 9999,
        ipcPath: '/other.sock',
      },
      record,
    ]);
    const sent = await h.controller.send(handle, 'continue the task');
    expect(sent.status).toBe('sent');
    expect(h.sendFrame).toHaveBeenCalledWith(
      '/selected-terminal.sock',
      expect.objectContaining({
        type: 'user',
        toSessionId: record.sessionId,
        priority: 'next',
        from: '/receipt-only.sock',
        fromName: 'Live',
        message: { role: 'user', content: 'continue the task' },
      }),
      { authToken: TOKEN },
    );
    const frame = h.sendFrame.mock.calls[0]![1];
    expect(frame).not.toHaveProperty('fromMode');
    expect(frame).toHaveProperty(
      'replyToken',
      h.startInbox.mock.calls[0]![0].requiredToken,
    );
    expect(h.controller.deliveries()[0]).toMatchObject({
      target: handle,
      status: 'pending',
      tracking: true,
    });
    const snapshot = h.controller.deliveries();
    snapshot[0]!.target = { id: 'changed', adaptor: 'wrong' };
    expect(h.controller.deliveries()[0]!.target).toEqual(handle);
  });

  it.each([
    ['restarted', [{ ...record, pid: 8888, startedAt: 9000 }]],
    ['different home/identity', [{ ...record, sessionId: 'different-id' }]],
    [
      'duplicate incarnation',
      [record, { ...record, pid: 8888, startedAt: 9000 }],
    ],
    ['duplicate exact record', [record, record]],
    ['no longer terminal', [{ ...record, kind: 'serve' }]],
    ['missing inbox', [{ ...record, ipcPath: undefined }]],
  ] as const)(
    'rejects %s without presenting a token',
    async (_name, records) => {
      const h = await setup();
      h.readRecords.mockResolvedValue([...records]);
      expect(await h.controller.send(handle, 'instruction')).toMatchObject({
        status: 'rejected',
      });
      expect(h.sendFrame).not.toHaveBeenCalled();
      expect(h.controller.deliveries()).toEqual([]);
    },
  );

  it('fences a call stopped while reading the directory and one stopped by a listener', async () => {
    const h = await setup();
    let finish!: (records: SessionRecord[]) => void;
    h.readRecords.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const sending = h.controller.send(handle, 'instruction');
    h.deactivate();
    await h.controller.close();
    finish([record]);
    expect(await sending).toMatchObject({ status: 'rejected' });
    expect(h.sendFrame).not.toHaveBeenCalled();

    const second = await setup();
    second.onChange.mockImplementation(second.deactivate);
    expect(await second.controller.send(handle, 'instruction')).toMatchObject({
      status: 'rejected',
    });
    expect(second.sendFrame).not.toHaveBeenCalled();
    expect(second.controller.deliveries()[0]).toMatchObject({
      status: 'failed',
      tracking: false,
    });
  });

  it('registers receipts before sending, preserves valid transitions and ignores unknown/repeated receipts', async () => {
    const h = await setup();
    h.sendFrame.mockImplementation(async (_path, frame) => {
      h.receipt(frame.msgId, 'held');
      h.receipt(frame.msgId, 'delivered');
    });
    const sent = await h.controller.send(handle, 'instruction');
    expect(sent).toMatchObject({
      status: 'sent',
      delivery: { status: 'delivered', tracking: true },
    });
    const id = h.controller.deliveries()[0]!.id;
    h.receipt(id, 'held');
    h.receipt('not-our-message', 'expired');
    expect(h.controller.deliveries()[0]!.status).toBe('delivered');
    h.receipt(id, 'expired');
    h.receipt(id, 'delivered');
    expect(h.controller.deliveries()[0]).toMatchObject({
      status: 'expired',
      tracking: false,
    });
    expect(JSON.stringify(h.controller.deliveries())).not.toMatch(
      /qpc_|private|internal-error/,
    );
  });

  it('times out as unknown, accepts a late receipt, and never retries', async () => {
    vi.useFakeTimers();
    const h = await setup(20);
    await h.controller.send(handle, 'instruction');
    await vi.advanceTimersByTimeAsync(21);
    expect(h.controller.deliveries()[0]).toMatchObject({
      status: 'unknown',
      tracking: true,
    });
    h.receipt(h.controller.deliveries()[0]!.id, 'held');
    await vi.advanceTimersByTimeAsync(500);
    expect(h.controller.deliveries()[0]).toMatchObject({
      status: 'held',
      tracking: true,
    });
    h.receipt(h.controller.deliveries()[0]!.id, 'denied');
    expect(h.controller.deliveries()[0]).toMatchObject({
      status: 'denied',
      tracking: false,
    });
    expect(h.sendFrame).toHaveBeenCalledTimes(1);
  });

  it('keeps possibly written failures trackable but marks proved no-write errors failed, with safe notes', async () => {
    const h = await setup();
    h.sendFrame.mockRejectedValueOnce(
      new PeerSendError(`${TOKEN} /secret/path`, 'ETIMEDOUT'),
    );
    expect(await h.controller.send(handle, 'instruction')).toMatchObject({
      status: 'unknown',
      delivery: { status: 'unknown', tracking: true },
    });
    h.receipt(h.controller.deliveries()[0]!.id, 'delivered');
    expect(h.controller.deliveries()[0]!.status).toBe('delivered');
    h.sendFrame.mockRejectedValueOnce(
      new PeerSendError(`${TOKEN} /secret/path`, 'ENOENT'),
    );
    const failed = await h.controller.send(handle, 'another instruction');
    expect(failed).toMatchObject({ status: 'rejected' });
    expect(h.controller.deliveries()[1]).toMatchObject({
      status: 'failed',
      tracking: false,
    });
    expect(JSON.stringify([failed, h.controller.deliveries()])).not.toMatch(
      /qpc_|secret/,
    );
  });

  it('settles folded drops and refuses ordinary reports on the receipt inbox', async () => {
    const h = await setup();
    await h.controller.send(handle, 'one');
    await h.controller.send(handle, 'two');
    const [one, two] = h.controller.deliveries();
    h.receive(
      buildDeliveryStatusFrame({
        origMsgId: one!.id,
        status: 'dropped',
        dropReason: 'queue-full',
        droppedMsgIds: [two!.id],
      }),
    );
    expect(
      h.controller.deliveries().map((delivery) => delivery.status),
    ).toEqual(['dropped', 'dropped']);
    const report = buildUserFrame({
      content: 'run this',
      from: '/reporter.sock',
      replyToken: 'reporter-token',
    });
    h.receive(report);
    expect(h.sendFrame).toHaveBeenLastCalledWith(
      '/reporter.sock',
      expect.objectContaining({
        type: 'control',
        status: 'refused',
        origMsgId: report.msgId,
      }),
      { authToken: 'reporter-token' },
    );
    expect(h.controller.deliveries()).toHaveLength(2);
  });

  it('ends tracking without claiming cancellation, including when close overlaps a send', async () => {
    const h = await setup();
    await h.controller.send(handle, 'pending');
    await h.controller.send(handle, 'held');
    await h.controller.send(handle, 'delivered');
    const before = h.controller.deliveries();
    h.receipt(before[1]!.id, 'held');
    h.receipt(before[2]!.id, 'delivered');
    let sent!: () => void;
    h.sendFrame.mockReturnValueOnce(
      new Promise((resolve) => {
        sent = resolve;
      }),
    );
    const sending = h.controller.send(handle, 'in-flight');
    await vi.waitFor(() => expect(h.sendFrame).toHaveBeenCalledTimes(4));
    h.deactivate();
    await h.controller.close();
    sent();
    expect(await sending).toMatchObject({
      status: 'unknown',
      delivery: { tracking: false },
    });
    expect(
      h.controller.deliveries().map((delivery) => delivery.status),
    ).toEqual(['unknown', 'unknown', 'delivered', 'unknown']);
    h.receipt(before[0]!.id, 'delivered');
    expect(h.controller.deliveries()[0]!.status).toBe('unknown');
    expect(
      h.controller.deliveries().every((delivery) => !delivery.tracking),
    ).toBe(true);
    expect(await h.controller.send(handle, 'too late')).toMatchObject({
      status: 'rejected',
    });
  });

  it('bounds history without evicting instructions that still need receipts', async () => {
    const h = await setup();
    for (let i = 0; i < 100; i++)
      await h.controller.send(handle, `instruction ${i}`);
    expect(await h.controller.send(handle, 'over limit')).toMatchObject({
      status: 'rejected',
    });
    h.receipt(h.controller.deliveries()[0]!.id, 'refused');
    expect(await h.controller.send(handle, 'replacement')).toMatchObject({
      status: 'sent',
    });
    expect(h.controller.deliveries()).toHaveLength(100);
    expect(h.sendFrame).toHaveBeenCalledTimes(101);
  });

  it('exchanges authenticated frames and receipts using only the pinned helpers in an isolated home', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'qpc-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const frames: PeerFrame[] = [];
    const terminal = await startPeerInbox({
      socketPath: path.join(directory, 't.sock'),
      requiredToken: TOKEN,
      keepAlive: false,
      onFrame: (frame) => {
        frames.push(frame);
        if (frame.type === 'user' && frame.from) {
          void sendPeerFrame(
            frame.from,
            buildDeliveryStatusFrame({
              origMsgId: frame.msgId,
              status: 'delivered',
            }),
            { authToken: frame.replyToken },
          );
        }
      },
    });
    cleanups.unshift(() => terminal.close());
    const liveRecord = {
      ...record,
      pid: process.pid,
      procStart: readProcStartToken(process.pid),
      pidNs: readPidNamespaceId(),
      ipcPath: terminal.socketPath,
    };
    await writeOwnRecord(sessionRegistryDir(directory), liveRecord);
    const controller = new QwenPeerController({
      qwenHome: directory,
      adaptor: 'qwen',
      name: 'Live',
      controllerToken: TOKEN,
      isActive: () => true,
      onChange: () => {},
    });
    controllers.push(controller);
    await controller.start();
    expect(
      await controller.send(
        {
          ...handle,
          id: qwenPeerHandleId(directory, liveRecord),
        },
        'real socket instruction',
      ),
    ).toMatchObject({ status: 'sent' });
    await vi.waitFor(() =>
      expect(controller.deliveries()[0]!.status).toBe('delivered'),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      toSessionId: record.sessionId,
      priority: 'next',
    });
  });
});
