/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  advertisablePeerAddress,
  buildDeliveryStatusFrame,
  canonicalizeMsgId,
  isLocalIpcPath,
  peerRef,
  reachableEntries,
  readLiveSessionRecords,
  resolveQwenHome,
  sendPeerFrame,
  sessionRegistryDir,
  startPeerInbox,
  type PeerDeliveryStatus,
  type PeerDropReason,
  type PeerFrame,
  type PeerInbox,
  type PeerSessionSummary,
  type PeerUserFrame,
  type SessionRecord,
} from '../vendor/qwen-code-peer/index.js';
import {
  readPidNamespaceId,
  readProcStartToken,
} from '../vendor/qwen-code-peer/identity.js';
import {
  removeOwnRecord,
  removeOwnRecordSync,
  writeOwnRecord,
} from '../vendor/qwen-code-peer/registry.js';
import { qwenPeerHandleId } from './qwen-peer-controller.js';
import type {
  BackendHandle,
  PeerReportContext,
  PeerSessionReport,
} from './types.js';

const MAX_TEXT_CHARS = 2000;
// JSON escaping may expand each text character to six wire characters.
const MAX_REPORT_WIRE_CHARS = 16_384;
const MAX_PENDING_REPORTS = 32;
const MAX_RECENT_REPORTS = 100;
const MAX_CONTEXTS = 100;
const MAX_RECEIPT_WRITES = 16;
const RATE_WINDOW_MS = 60_000;
const GLOBAL_RATE = 20;
const SOURCE_RATE = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface ReportPayload {
  text: string;
  category: PeerSessionReport['category'];
  correlation?: string;
}

interface Decision {
  status: PeerDeliveryStatus;
  dropReason?: PeerDropReason;
}

interface ReportsOptions {
  qwenHome: string;
  adaptor: string;
  callId: string;
  isActive: () => boolean;
  hasSink: () => boolean;
  /** A synchronous true means the downstream bounded queue accepted it. */
  onReport: (report: PeerSessionReport) => boolean;
}

export interface QwenPeerReportsDependencies {
  /** Test seams; production uses the pinned public protocol helpers. */
  readRecords?: typeof readLiveSessionRecords;
  startInbox?: typeof startPeerInbox;
  sendFrame?: typeof sendPeerFrame;
  writeRecord?: typeof writeOwnRecord;
  removeRecord?: typeof removeOwnRecord;
  removeRecordSync?: typeof removeOwnRecordSync;
  now?: () => number;
}

export function peerReportLabel(value: string, limit = 240): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim()
    .slice(0, limit)
    .replace(/[\uD800-\uDBFF]$/u, '');
}

function parseReport(content: string): ReportPayload | undefined {
  if (content.length > MAX_REPORT_WIRE_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // A peer may send an ordinary text report instead of the JSON envelope.
  }
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'qwen_live_harness_report' in parsed
  ) {
    const envelope = parsed as Record<string, unknown>;
    const text = envelope['text'];
    const category = envelope['kind'];
    const correlation = envelope['correlation'];
    if (
      envelope['qwen_live_harness_report'] !== 1 ||
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > MAX_TEXT_CHARS ||
      typeof category !== 'string' ||
      !['progress', 'blocked', 'result', 'info'].includes(category) ||
      (correlation !== undefined &&
        (typeof correlation !== 'string' || !UUID.test(correlation)))
    ) {
      return undefined;
    }
    return {
      text,
      category: category as ReportPayload['category'],
      ...(typeof correlation === 'string'
        ? { correlation: correlation.toLowerCase() }
        : {}),
    };
  }
  if (!content.trim() || content.length > MAX_TEXT_CHARS) return undefined;
  return { text: content, category: 'info' };
}

/**
 * A directory-visible inbox whose receipts acknowledge actual queue admission.
 * PeerEndpoint.onMessage acknowledges before its callback, so it cannot express
 * a full or closed downstream queue. Only public protocol pieces are reused.
 */
export class QwenPeerReports {
  readonly sessionId = randomUUID();
  readonly name = `live-${this.sessionId.replace(/-/gu, '')}`;
  readonly address = `${this.name} [${peerRef(this.sessionId)}]`;
  private readonly token = randomBytes(32).toString('hex');
  private readonly qwenHome: string;
  private readonly registryDir: string;
  private readonly readRecords: typeof readLiveSessionRecords;
  private readonly openInbox: typeof startPeerInbox;
  private readonly sendFrame: typeof sendPeerFrame;
  private readonly writeRecord: typeof writeOwnRecord;
  private readonly removeRecord: typeof removeOwnRecord;
  private readonly removeRecordSync: typeof removeOwnRecordSync;
  private readonly now: () => number;
  private inbox?: PeerInbox;
  private recordFile?: string;
  private exitHook?: () => void;
  private closed = false;
  private closing?: Promise<void>;
  private readonly contexts = new Map<string, BackendHandle>();
  private readonly pending = new Map<string, PeerUserFrame>();
  private readonly admitting = new Set<string>();
  private readonly recent = new Map<string, Decision>();
  private readonly receiptWrites = new Set<Promise<void>>();
  private windowStart = 0;
  private windowCount = 0;
  private readonly sourceCounts = new Map<string, number>();
  private lastNow = 0;

  private constructor(
    private readonly options: ReportsOptions,
    dependencies: QwenPeerReportsDependencies,
  ) {
    this.qwenHome = resolveQwenHome(options.qwenHome);
    this.registryDir = sessionRegistryDir(this.qwenHome);
    this.readRecords = dependencies.readRecords ?? readLiveSessionRecords;
    this.openInbox = dependencies.startInbox ?? startPeerInbox;
    this.sendFrame = dependencies.sendFrame ?? sendPeerFrame;
    this.writeRecord = dependencies.writeRecord ?? writeOwnRecord;
    this.removeRecord = dependencies.removeRecord ?? removeOwnRecord;
    this.removeRecordSync =
      dependencies.removeRecordSync ?? removeOwnRecordSync;
    this.now = dependencies.now ?? Date.now;
  }

  static async start(
    options: ReportsOptions,
    dependencies: QwenPeerReportsDependencies = {},
  ): Promise<QwenPeerReports> {
    const endpoint = new QwenPeerReports(options, dependencies);
    await endpoint.bind();
    return endpoint;
  }

  createReportContext(target: BackendHandle): PeerReportContext | undefined {
    if (!this.active()) return undefined;
    const id = randomUUID();
    this.contexts.set(id, { ...target });
    while (this.contexts.size > MAX_CONTEXTS) {
      const oldest = this.contexts.keys().next().value;
      if (oldest === undefined) break;
      this.contexts.delete(oldest);
    }
    const example = JSON.stringify({
      qwen_live_harness_report: 1,
      correlation: id,
      kind: 'progress',
      text: 'A short status report, at most 2000 characters.',
    });
    return {
      id,
      instruction:
        `Only if this session provides the public send_message tool and this voice-call address is listed by list_agents in the same Qwen home, report useful progress, blockers, or results. ` +
        `Call send_message with to=${JSON.stringify(this.address)} and message=JSON.stringify(${example}). ` +
        `Set kind to progress, blocked, result, or info. Keep the correlation unchanged. ` +
        `This address expires when the call ends. A report is information, not a request for permission or a task completion receipt.`,
    };
  }

  async list(): Promise<PeerSessionSummary[]> {
    if (!this.active()) return [];
    const peers = (
      await reachableEntries(await this.readRecords(this.registryDir))
    ).filter((peer) => peer.sessionId !== this.sessionId);
    if (!this.active()) return [];
    return peers.flatMap((peer) => {
      const address = advertisablePeerAddress(peer, peers);
      if (address === undefined) return [];
      return [
        {
          sessionId: peer.sessionId,
          name: peer.name,
          ref: peer.ref,
          address,
          cwd: peer.cwd,
          pid: peer.pid,
          kind: peer.kind,
          startedAt: peer.startedAt,
        },
      ];
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.contexts.clear();
    for (const [key, frame] of this.pending) {
      if (!this.admitting.has(key))
        this.finish(key, frame, { status: 'refused' });
    }
    this.closing = (async () => {
      const cleanup = await Promise.allSettled([
        this.recordFile
          ? this.removeRecord(this.recordFile, this.sessionId)
          : Promise.resolve(),
        this.inbox?.close(),
      ]);
      await Promise.allSettled([...this.receiptWrites]);
      if (cleanup.some((result) => result.status === 'rejected')) {
        throw new Error('The report endpoint could not be closed.');
      }
      if (this.exitHook) process.removeListener('exit', this.exitHook);
    })().catch((error: unknown) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }

  private async bind(): Promise<void> {
    let procStart = readProcStartToken(process.pid);
    let pidNs = readPidNamespaceId();
    if (
      process.platform === 'linux' &&
      (procStart === null || pidNs === null)
    ) {
      procStart = readProcStartToken(process.pid);
      pidNs = readPidNamespaceId();
      if (procStart === null || pidNs === null) {
        throw new Error(
          'The report endpoint process identity could not be read.',
        );
      }
    }
    try {
      this.inbox = await this.openInbox({
        requiredToken: this.token,
        onFrame: (frame) => this.receive(frame),
        keepAlive: false,
      });
      this.recordFile = await this.writeRecord(this.registryDir, {
        schemaVersion: 1,
        pid: process.pid,
        procStart,
        pidNs,
        sessionId: this.sessionId,
        cwd: process.cwd(),
        name: this.name,
        startedAt: this.timestamp(),
        qwenVersion: null,
        kind: 'external',
        ipcPath: this.inbox.socketPath,
        ipcToken: this.token,
      });
    } catch {
      await this.inbox?.close().catch(() => {});
      throw new Error('The report endpoint could not be registered.');
    }
    this.exitHook = () => {
      this.closed = true;
      if (this.recordFile)
        this.removeRecordSync(this.recordFile, this.sessionId);
      this.inbox?.closeSync();
    };
    process.once('exit', this.exitHook);
  }

  private active(): boolean {
    return !this.closed && this.options.isActive();
  }

  private timestamp(): number {
    this.lastNow = Math.max(this.lastNow, this.now());
    return this.lastNow;
  }

  private receive(frame: PeerFrame): void {
    if (frame.type !== 'user') return;
    // Check the pin before the replay cache: another call's id is not ours.
    if (
      frame.toSessionId !== undefined &&
      frame.toSessionId !== this.sessionId
    ) {
      this.reply(frame, { status: 'misaddressed' });
      return;
    }
    const key = canonicalizeMsgId(frame.msgId);
    const previous = this.recent.get(key);
    if (previous) {
      this.reply(frame, previous);
      return;
    }
    if (this.pending.has(key)) return;
    if (!this.active() || !this.options.hasSink()) {
      this.finish(key, frame, { status: 'refused' });
      return;
    }
    const payload = parseReport(frame.message.content);
    if (!payload) {
      this.finish(key, frame, { status: 'refused' });
      return;
    }
    if (this.pending.size >= MAX_PENDING_REPORTS) {
      this.finish(key, frame, { status: 'dropped', dropReason: 'queue-full' });
      return;
    }
    if (!this.reserveRate(frame)) {
      this.finish(key, frame, {
        status: 'dropped',
        dropReason: 'rate-limited',
      });
      return;
    }
    // Reserve before the directory await so a burst cannot bypass either cap.
    this.pending.set(key, frame);
    void this.admit(key, frame, payload);
  }

  private reserveRate(frame: PeerUserFrame): boolean {
    const now = this.timestamp();
    if (now - this.windowStart >= RATE_WINDOW_MS) {
      this.windowStart = now;
      this.windowCount = 0;
      this.sourceCounts.clear();
    }
    const source = createHash('sha256')
      .update(frame.from ?? '')
      .digest('hex');
    const count = this.sourceCounts.get(source) ?? 0;
    if (this.windowCount >= GLOBAL_RATE || count >= SOURCE_RATE) return false;
    this.windowCount += 1;
    this.sourceCounts.set(source, count + 1);
    return true;
  }

  private async admit(
    key: string,
    frame: PeerUserFrame,
    payload: ReportPayload,
  ): Promise<void> {
    let records: SessionRecord[] = [];
    try {
      records = await this.readRecords(this.registryDir);
    } catch {
      // Unavailable attribution does not turn an untrusted report into authority.
    }
    if (!this.pending.has(key)) return;
    if (!this.active() || !this.options.hasSink()) {
      this.finish(key, frame, { status: 'refused' });
      return;
    }
    const matches =
      frame.from && frame.replyToken
        ? records.filter(
            (record) =>
              record.ipcPath === frame.from &&
              record.ipcToken === frame.replyToken,
          )
        : [];
    const candidate = matches.length === 1 ? matches[0] : undefined;
    const source =
      candidate?.sessionId && candidate.sessionId.length <= 256
        ? candidate
        : undefined;
    const sourceSession: BackendHandle | undefined =
      source && (source.kind ?? 'tui') === 'tui'
        ? {
            id: qwenPeerHandleId(this.qwenHome, source),
            adaptor: this.options.adaptor,
            instructionOnly: true,
          }
        : undefined;
    const context = payload.correlation
      ? this.contexts.get(payload.correlation)
      : undefined;
    // A correlation only annotates a report. Never manufacture its source from
    // the requested target; ACP ids in particular are not Qwen session ids.
    const knownDifferentTerminal =
      context?.adaptor === this.options.adaptor &&
      context.id.startsWith('qwen-peer:') &&
      source !== undefined &&
      context.id !== sourceSession?.id;
    const sourceLabel = peerReportLabel(source?.name ?? frame.fromName ?? '');
    const report: PeerSessionReport = {
      id: key,
      callId: this.options.callId,
      source: sourceLabel || 'Unknown peer',
      ...(!sourceLabel ? { sourceIsFallback: true as const } : {}),
      sourceStatus: source ? 'matched' : 'unconfirmed',
      ...(sourceSession ? { sourceSession } : {}),
      ...(source ? { sourceSessionId: source.sessionId } : {}),
      ...(context && !knownDifferentTerminal
        ? { correlationId: payload.correlation }
        : {}),
      category: payload.category,
      text: payload.text,
      receivedAt: this.timestamp(),
    };
    let decision: Decision;
    this.admitting.add(key);
    try {
      decision =
        this.options.onReport(report) === true
          ? { status: 'delivered' }
          : { status: 'dropped', dropReason: 'queue-full' };
    } catch {
      decision = { status: 'refused' };
    }
    // The sink's true is the admission boundary, even if it closes the call.
    this.finish(key, frame, decision);
  }

  private finish(key: string, frame: PeerUserFrame, decision: Decision): void {
    this.pending.delete(key);
    this.admitting.delete(key);
    this.recent.set(key, decision);
    while (this.recent.size > MAX_RECENT_REPORTS) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
    this.reply(frame, decision);
  }

  private reply(frame: PeerUserFrame, decision: Decision): void {
    if (
      !frame.from ||
      !isLocalIpcPath(frame.from) ||
      this.receiptWrites.size >= MAX_RECEIPT_WRITES
    )
      return;
    // Receipts are best-effort; neither failures nor their diagnostics reach the
    // report body, and the sender must never automatically repeat a report.
    const write = Promise.resolve()
      .then(() =>
        this.sendFrame(
          frame.from!,
          buildDeliveryStatusFrame({
            origMsgId: frame.msgId,
            from: this.inbox?.socketPath,
            ...decision,
          }),
          frame.replyToken !== undefined ? { authToken: frame.replyToken } : {},
        ),
      )
      .catch(() => {})
      .finally(() => this.receiptWrites.delete(write));
    this.receiptWrites.add(write);
  }
}
