/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildUserFrame,
  PeerEndpoint,
  readLiveSessionRecords,
  sendPeerFrame,
  sessionRegistryDir,
  type PeerControlFrame,
  type PeerFrame,
  type PeerInboxOptions,
  type SessionRecord,
} from '../vendor/qwen-code-peer/index.js';
import { qwenPeerHandleId } from './qwen-peer-controller.js';
import { QwenPeerReports } from './qwen-peer-reports.js';
import type { PeerSessionReport } from './types.js';

const HOME = '/isolated/reports';
const record: SessionRecord = {
  schemaVersion: 1,
  sessionId: 'terminal-session',
  pid: 1234,
  procStart: null,
  pidNs: null,
  name: 'terminal',
  cwd: '/workspace',
  startedAt: 1000,
  qwenVersion: '0.23.3',
  kind: 'tui',
  ipcPath: '/terminal.sock',
  ipcToken: 'private-reply-token',
};
const target = {
  id: qwenPeerHandleId(HOME, record),
  adaptor: 'qwen',
  instructionOnly: true as const,
};
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  let active = true;
  let hasSink = true;
  let now = 1000;
  let receive!: PeerInboxOptions['onFrame'];
  const inbox = {
    socketPath: '/report-inbox.sock',
    close: vi.fn(async () => {}),
    closeSync: vi.fn(),
  };
  const startInbox = vi.fn(async (options: PeerInboxOptions) => {
    receive = options.onFrame;
    return inbox;
  });
  const sendFrame = vi.fn<typeof sendPeerFrame>(async () => {});
  const readRecords = vi.fn(async () => [record]);
  const writeRecord = vi.fn(async () => '/record.json');
  const removeRecord = vi.fn(async () => {});
  const onReport = vi.fn<(report: PeerSessionReport) => boolean>(() => true);
  const reports = await QwenPeerReports.start(
    {
      qwenHome: HOME,
      adaptor: 'qwen',
      callId: 'call-one',
      isActive: () => active,
      hasSink: () => hasSink,
      onReport,
    },
    {
      startInbox,
      sendFrame,
      readRecords,
      writeRecord,
      removeRecord,
      removeRecordSync: () => {},
      now: () => now,
    },
  );
  cleanups.push(() => reports.close());
  const frame = (content = 'Progress report') =>
    buildUserFrame({
      content,
      from: record.ipcPath,
      replyToken: record.ipcToken,
      fromName: 'sender claim',
      toSessionId: reports.sessionId,
    });
  const waitReplies = async (count: number) => {
    await vi.waitFor(() => expect(sendFrame).toHaveBeenCalledTimes(count), {
      interval: 1,
      timeout: 1000,
    });
    return sendFrame.mock.calls.at(-1)![1] as PeerControlFrame;
  };
  return {
    reports,
    frame,
    receive: (value: PeerFrame) => receive(value),
    inbox,
    startInbox,
    sendFrame,
    readRecords,
    writeRecord,
    removeRecord,
    onReport,
    waitReplies,
    setActive: (value: boolean) => {
      active = value;
    },
    setSink: (value: boolean) => {
      hasSink = value;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

function envelope(
  correlation: string = randomUUID(),
  text = 'Task progress',
  kind = 'progress',
) {
  return JSON.stringify({
    qwen_live_harness_report: 1,
    correlation,
    kind,
    text,
  });
}

describe('Qwen peer reports', () => {
  it('acknowledges only after synchronous admission and attributes a fresh terminal without exposing routes', async () => {
    const h = await setup();
    const context = h.reports.createReportContext(target)!;
    h.onReport.mockImplementation(() => {
      expect(h.sendFrame).not.toHaveBeenCalled();
      return true;
    });
    const frame = h.frame(envelope(context.id));
    h.receive(frame);
    expect(await h.waitReplies(1)).toMatchObject({
      status: 'delivered',
      origMsgId: frame.msgId,
    });
    const report = h.onReport.mock.calls[0]![0];
    expect(report).toMatchObject({
      callId: 'call-one',
      source: 'terminal',
      sourceStatus: 'matched',
      sourceSession: target,
      sourceSessionId: record.sessionId,
      correlationId: context.id,
      category: 'progress',
      text: 'Task progress',
      receivedAt: 1000,
    });
    expect(h.sendFrame).toHaveBeenCalledWith(
      record.ipcPath,
      expect.anything(),
      { authToken: record.ipcToken },
    );
    expect(JSON.stringify(report)).not.toMatch(
      /ipcPath|replyToken|private-reply-token|terminal\.sock/,
    );
    expect(context.instruction).toContain(h.reports.address);
    expect(context.instruction).toContain(context.id);
    expect(context.instruction).not.toContain('report-inbox.sock');
  });

  it('refuses absent/throwing sinks and reports a full sink as dropped', async () => {
    const h = await setup();
    h.setSink(false);
    h.receive(h.frame());
    expect(await h.waitReplies(1)).toMatchObject({ status: 'refused' });
    expect(h.readRecords).not.toHaveBeenCalled();
    h.setSink(true);
    h.onReport.mockReturnValueOnce(false).mockImplementationOnce(() => {
      throw new Error('private diagnostic');
    });
    h.receive(h.frame());
    expect(await h.waitReplies(2)).toMatchObject({
      status: 'dropped',
      dropReason: 'queue-full',
    });
    h.receive(h.frame());
    expect(await h.waitReplies(3)).toMatchObject({ status: 'refused' });
    expect(JSON.stringify(h.sendFrame.mock.calls)).not.toContain(
      'private diagnostic',
    );
  });

  it('uses plain text as info, ignores sender priority and refuses invalid/oversized envelopes without truncation', async () => {
    const h = await setup();
    h.receive({ ...h.frame('x'.repeat(2000)), priority: 'now' });
    expect(await h.waitReplies(1)).toMatchObject({ status: 'delivered' });
    expect(h.onReport.mock.calls[0]![0]).toMatchObject({
      category: 'info',
      text: 'x'.repeat(2000),
    });
    expect(h.onReport.mock.calls[0]![0]).not.toHaveProperty('priority');
    const invalid = [
      'x'.repeat(2001),
      envelope(randomUUID(), 'x'.repeat(2001)),
      envelope(randomUUID(), 'status', 'permission'),
      envelope('not-a-uuid'),
      JSON.stringify({ qwen_live_harness_report: 2, kind: 'info', text: 'hi' }),
      JSON.stringify({
        qwen_live_harness_report: 1,
        kind: ['progress'],
        text: 'hi',
      }),
      ' '.repeat(100),
      'x'.repeat(16_385),
    ];
    for (const [index, value] of invalid.entries()) {
      h.receive(h.frame(value));
      expect(await h.waitReplies(index + 2)).toMatchObject({
        status: 'refused',
      });
    }
    expect(h.onReport).toHaveBeenCalledTimes(1);
    // Escaping is overhead, so a valid 2000-character JSON body still fits.
    h.receive(h.frame(envelope(randomUUID(), '\u0001'.repeat(1999) + 'x')));
    expect(await h.waitReplies(invalid.length + 2)).toMatchObject({
      status: 'delivered',
    });
  });

  it('deduplicates canonical ids while pending and after admission, but keeps equal text with different ids', async () => {
    const h = await setup();
    let resolve!: (records: SessionRecord[]) => void;
    h.readRecords.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const frame = { ...h.frame(), msgId: 'Ab-Cd-01' };
    h.receive(frame);
    h.receive({ ...frame, msgId: 'aBCD01' });
    expect(h.readRecords).toHaveBeenCalledTimes(1);
    expect(h.sendFrame).not.toHaveBeenCalled();
    resolve([record]);
    expect(await h.waitReplies(1)).toMatchObject({ status: 'delivered' });
    h.receive({ ...frame, msgId: 'ABC-D01' });
    expect(await h.waitReplies(2)).toMatchObject({
      status: 'delivered',
      origMsgId: 'ABC-D01',
    });
    expect(h.onReport).toHaveBeenCalledTimes(1);
    h.receive(h.frame());
    expect(await h.waitReplies(3)).toMatchObject({ status: 'delivered' });
    expect(h.onReport).toHaveBeenCalledTimes(2);
  });

  it('checks the target pin before replay and never turns another call frame into a report', async () => {
    const h = await setup();
    const frame = h.frame();
    h.receive(frame);
    await h.waitReplies(1);
    h.receive({ ...frame, toSessionId: 'old-call' });
    expect(await h.waitReplies(2)).toMatchObject({ status: 'misaddressed' });
    expect(h.onReport).toHaveBeenCalledTimes(1);
  });

  it('retains known correlation without elevating unknown sources and strips only provable target mismatches', async () => {
    const h = await setup();
    const context = h.reports.createReportContext(target)!;
    h.readRecords.mockResolvedValue([]);
    h.receive({
      ...h.frame(envelope(context.id)),
      fromName: '\u202eclaim\n\u001b' + 'x'.repeat(300),
    });
    await h.waitReplies(1);
    let report = h.onReport.mock.calls.at(-1)![0];
    expect(report).toMatchObject({
      correlationId: context.id,
      sourceStatus: 'unconfirmed',
    });
    expect(report).not.toHaveProperty('sourceSession');
    expect(report.source.length).toBeLessThanOrEqual(240);
    expect(report.source).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    h.readRecords.mockResolvedValue([
      { ...record, sessionId: 'other', startedAt: 2000 },
    ]);
    h.receive(h.frame(envelope(context.id)));
    await h.waitReplies(2);
    report = h.onReport.mock.calls.at(-1)![0];
    expect(report).toMatchObject({
      sourceStatus: 'matched',
      sourceSessionId: 'other',
    });
    expect(report).not.toHaveProperty('correlationId');
    const acp = h.reports.createReportContext({
      id: 'opaque-acp-id',
      adaptor: 'other',
    })!;
    h.receive(h.frame(envelope(acp.id)));
    await h.waitReplies(3);
    expect(h.onReport.mock.calls.at(-1)![0]).toHaveProperty(
      'correlationId',
      acp.id,
    );
    h.receive(h.frame(envelope(randomUUID())));
    await h.waitReplies(4);
    expect(h.onReport.mock.calls.at(-1)![0]).not.toHaveProperty(
      'correlationId',
    );
  });

  it('does not select a source by display name or shared socket and does not invent terminal handles for serve', async () => {
    const h = await setup();
    h.readRecords.mockResolvedValue([
      record,
      { ...record, sessionId: 'second', name: 'different' },
    ]);
    h.receive(h.frame());
    await h.waitReplies(1);
    expect(h.onReport.mock.calls.at(-1)![0]).toMatchObject({
      sourceStatus: 'unconfirmed',
    });
    expect(h.onReport.mock.calls.at(-1)![0]).not.toHaveProperty(
      'sourceSessionId',
    );
    h.readRecords.mockResolvedValue([
      { ...record, ipcToken: 'different-token' },
    ]);
    h.receive({ ...h.frame(), fromName: record.name });
    await h.waitReplies(2);
    expect(h.onReport.mock.calls.at(-1)![0]).toMatchObject({
      sourceStatus: 'unconfirmed',
    });
    h.readRecords.mockResolvedValue([{ ...record, kind: 'serve' }]);
    const context = h.reports.createReportContext({
      id: 'opaque-managed-id',
      adaptor: 'qwen',
    })!;
    h.receive(h.frame(envelope(context.id)));
    await h.waitReplies(3);
    expect(h.onReport.mock.calls.at(-1)![0]).toMatchObject({
      sourceStatus: 'matched',
      sourceSessionId: record.sessionId,
      correlationId: context.id,
    });
    expect(h.onReport.mock.calls.at(-1)![0]).not.toHaveProperty(
      'sourceSession',
    );
  });

  it('limits a source to six reports per minute, counts in-flight admissions and resets the window', async () => {
    const h = await setup();
    for (let index = 0; index < 6; index += 1) {
      h.receive(h.frame());
      expect(await h.waitReplies(index + 1)).toMatchObject({
        status: 'delivered',
      });
    }
    h.receive({ ...h.frame(), replyToken: 'a-new-token-is-not-a-new-source' });
    expect(await h.waitReplies(7)).toMatchObject({
      status: 'dropped',
      dropReason: 'rate-limited',
    });
    h.setNow(61_001);
    h.receive(h.frame());
    expect(await h.waitReplies(8)).toMatchObject({ status: 'delivered' });
    h.setNow(1);
    h.receive(h.frame());
    await h.waitReplies(9);
    expect(h.onReport.mock.calls.at(-1)![0].receivedAt).toBe(61_001);
  });

  it('bounds total admissions even when a sender changes its claimed socket', async () => {
    const h = await setup();
    for (let index = 0; index < 20; index += 1) {
      h.receive({ ...h.frame(), from: `/sender-${index}.sock` });
      expect(await h.waitReplies(index + 1)).toMatchObject({
        status: 'delivered',
      });
    }
    h.receive({ ...h.frame(), from: '/another-sender.sock' });
    expect(await h.waitReplies(21)).toMatchObject({
      status: 'dropped',
      dropReason: 'rate-limited',
    });
    expect(h.onReport).toHaveBeenCalledTimes(20);
  });

  it('caps pending directory lookups and rejects unresolved reports when the call closes', async () => {
    const h = await setup();
    let resolve!: (records: SessionRecord[]) => void;
    h.readRecords.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    for (let index = 0; index < 32; index += 1) {
      if (index === 20) h.setNow(61_001);
      h.receive({ ...h.frame(), from: `/pending-${index}.sock` });
    }
    expect(h.readRecords).toHaveBeenCalledTimes(32);
    h.receive(h.frame());
    expect(await h.waitReplies(1)).toMatchObject({
      status: 'dropped',
      dropReason: 'queue-full',
    });
    await h.reports.close();
    resolve([record]);
    await Promise.resolve();
    expect(h.onReport).not.toHaveBeenCalled();
    expect(
      h.sendFrame.mock.calls.every(
        ([, frame]) => (frame as PeerControlFrame).status !== 'delivered',
      ),
    ).toBe(true);
    expect(h.inbox.close).toHaveBeenCalledTimes(1);
    expect(h.removeRecord).toHaveBeenCalledWith(
      '/record.json',
      h.reports.sessionId,
    );
    expect(h.reports.createReportContext(target)).toBeUndefined();
  });

  it('fences a call switch during source lookup and preserves an admission made synchronously before close', async () => {
    const h = await setup();
    let resolve!: (records: SessionRecord[]) => void;
    h.readRecords.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    h.receive(h.frame());
    h.setActive(false);
    resolve([record]);
    expect(await h.waitReplies(1)).toMatchObject({ status: 'refused' });
    expect(h.onReport).not.toHaveBeenCalled();
    h.setActive(true);
    h.onReport.mockImplementation(() => {
      void h.reports.close();
      return true;
    });
    h.receive(h.frame());
    expect(await h.waitReplies(2)).toMatchObject({ status: 'delivered' });
    expect(
      h.sendFrame.mock.calls.map(
        ([, frame]) => (frame as PeerControlFrame).status,
      ),
    ).toEqual(['refused', 'delivered']);
  });

  it('bounds contexts and recent replay history to one call', async () => {
    const h = await setup();
    const oldest = h.reports.createReportContext(target)!;
    for (let index = 0; index < 99; index += 1)
      expect(h.reports.createReportContext(target)).toBeDefined();
    const newest = h.reports.createReportContext(target)!;
    expect(newest).toBeDefined();
    h.setSink(false);
    const first = h.frame();
    h.receive(first);
    await h.waitReplies(1);
    for (let index = 0; index < 100; index += 1) {
      h.receive(h.frame());
      await h.waitReplies(index + 2);
    }
    h.setSink(true);
    h.receive(first);
    expect(await h.waitReplies(102)).toMatchObject({ status: 'delivered' });
    h.receive(h.frame(envelope(oldest.id)));
    await h.waitReplies(103);
    expect(h.onReport.mock.calls.at(-1)![0]).not.toHaveProperty(
      'correlationId',
    );
    h.receive(h.frame(envelope(newest.id)));
    await h.waitReplies(104);
    expect(h.onReport.mock.calls.at(-1)![0]).toHaveProperty(
      'correlationId',
      newest.id,
    );
  });

  it('caps receipt writes and swallows transport diagnostics without changing accepted reports', async () => {
    const h = await setup();
    const finishes: Array<() => void> = [];
    h.sendFrame.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishes.push(resolve);
        }),
    );
    h.setSink(false);
    for (let index = 0; index < 20; index += 1) h.receive(h.frame());
    await vi.waitFor(() => expect(h.sendFrame).toHaveBeenCalledTimes(16));
    for (const finish of finishes) finish();
    await h.reports.close();
  });

  it('closes a bound inbox on publication failure without leaking sensitive diagnostics', async () => {
    const close = vi.fn(async () => {});
    await expect(
      QwenPeerReports.start(
        {
          qwenHome: HOME,
          adaptor: 'qwen',
          callId: 'call',
          isActive: () => true,
          hasSink: () => true,
          onReport: () => true,
        },
        {
          startInbox: async () => ({
            socketPath: '/private/socket',
            close,
            closeSync: () => {},
          }),
          writeRecord: async () => {
            throw new Error('private-token /private/home');
          },
        },
      ),
    ).rejects.toThrow('The report endpoint could not be registered.');
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('Qwen report public IPC', () => {
  it('round-trips SDK sends and receipts through a discoverable, isolated report endpoint', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'qwen-reports-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const received: PeerSessionReport[] = [];
    let accept = true;
    const reports = await QwenPeerReports.start({
      qwenHome: home,
      adaptor: 'qwen',
      callId: 'real-call',
      isActive: () => true,
      hasSink: () => true,
      onReport: (report) => {
        if (accept) received.push(report);
        return accept;
      },
    });
    cleanups.push(() => reports.close());
    const sender = await PeerEndpoint.start({
      name: 'actual-terminal',
      kind: 'tui',
      qwenHome: home,
      keepAlive: false,
    });
    cleanups.push(() => sender.close());
    expect(
      (await sender.list()).some(
        (peer) =>
          peer.sessionId === reports.sessionId && peer.kind === 'external',
      ),
    ).toBe(true);
    expect(
      (await reports.list()).some(
        (peer) => peer.sessionId === sender.sessionId,
      ),
    ).toBe(true);
    const senderRecord = (
      await readLiveSessionRecords(sessionRegistryDir(home))
    ).find((entry) => entry.sessionId === sender.sessionId)!;
    const context = reports.createReportContext({
      id: qwenPeerHandleId(home, senderRecord),
      adaptor: 'qwen',
      instructionOnly: true,
    })!;
    const sent = await sender.send({
      to: reports.address,
      content: envelope(context.id, 'Build finished', 'result'),
    });
    expect(sent.kind).toBe('sent');
    if (sent.kind !== 'sent') throw new Error('Report was not written');
    expect(
      await sender.awaitReceipt(sent.msgId, { timeoutMs: 2000 }),
    ).toMatchObject({ status: 'delivered' });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      callId: 'real-call',
      source: 'actual-terminal',
      sourceStatus: 'matched',
      sourceSessionId: sender.sessionId,
      correlationId: context.id,
      category: 'result',
      text: 'Build finished',
    });
    accept = false;
    const full = await sender.send({
      to: reports.address,
      content: 'Another progress report',
    });
    if (full.kind !== 'sent') throw new Error('Report was not written');
    expect(
      await sender.awaitReceipt(full.msgId, { timeoutMs: 2000 }),
    ).toMatchObject({ status: 'dropped', dropReason: 'queue-full' });
    const oversized = await sender.send({
      to: reports.address,
      content: 'x'.repeat(2001),
    });
    if (oversized.kind !== 'sent') throw new Error('Report was not written');
    expect(
      await sender.awaitReceipt(oversized.msgId, { timeoutMs: 2000 }),
    ).toMatchObject({ status: 'refused' });
    await reports.close();
    expect(
      (await sender.list()).some(
        (peer) => peer.sessionId === reports.sessionId,
      ),
    ).toBe(false);
    await sender.close();
    expect(await readdir(sessionRegistryDir(home))).toEqual([]);
  });
});
