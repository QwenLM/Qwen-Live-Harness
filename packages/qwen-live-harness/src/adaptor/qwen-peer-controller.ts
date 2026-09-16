/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  buildDeliveryStatusFrame,
  buildUserFrame,
  canonicalizeMsgId,
  isLocalIpcPath,
  PeerSendError,
  readLiveSessionRecords,
  sendPeerFrame,
  sessionRegistryDir,
  startPeerInbox,
  toDirectoryEntry,
  type PeerControlFrame,
  type PeerDeliveryStatus,
  type PeerFrame,
  type PeerInbox,
  type PeerSessionSummary,
} from '../vendor/qwen-code-peer/index.js';
import type {
  BackendHandle,
  InstructionDelivery,
  InstructionReceipt,
} from './types.js';

const MAX_DELIVERIES = 100;
const RECEIPT_TIMEOUT_MS = 30_000;
const TRANSITIONS: Record<
  PeerDeliveryStatus | 'pending',
  ReadonlySet<PeerDeliveryStatus>
> = {
  pending: new Set([
    'held',
    'delivered',
    'denied',
    'refused',
    'expired',
    'misaddressed',
    'dropped',
  ]),
  held: new Set(['delivered', 'denied', 'expired', 'misaddressed']),
  delivered: new Set(['expired', 'misaddressed']),
  denied: new Set(),
  refused: new Set(),
  expired: new Set(),
  misaddressed: new Set(),
  dropped: new Set(),
};
const NEVER_WRITTEN = new Set([
  undefined,
  'ENOENT',
  'ECONNREFUSED',
  'EMSGSIZE',
  'EAGAIN',
  'EBUSY',
]);

interface TrackedDelivery {
  delivery: InstructionDelivery;
  /** Timeout does not replace the last wire state: a receipt can still arrive. */
  wireState: PeerDeliveryStatus | 'pending';
  timeout?: ReturnType<typeof setTimeout>;
}

export interface QwenPeerControllerDependencies {
  /** Test seams only; normal operation uses the pinned SDK's Node helpers. */
  readRecords?: typeof readLiveSessionRecords;
  startInbox?: typeof startPeerInbox;
  sendFrame?: typeof sendPeerFrame;
  receiptTimeoutMs?: number;
}

interface ControllerOptions {
  qwenHome: string;
  adaptor: string;
  name: string;
  controllerToken: string;
  isActive: () => boolean;
  onChange: () => void;
}

/** Identity is scoped to the home and the process incarnation, never a label. */
export function qwenPeerHandleId(
  qwenHome: string,
  peer: Pick<PeerSessionSummary, 'sessionId' | 'pid' | 'startedAt'>,
): string {
  return `qwen-peer:${createHash('sha256')
    .update(
      JSON.stringify([qwenHome, peer.sessionId, peer.pid, peer.startedAt]),
    )
    .digest('hex')}`;
}

/**
 * Fixed-socket controller delivery, separate from the discovery SDK endpoint.
 * PeerEndpoint.send resolves names again and cannot pin the selected record;
 * its private receipt ledger also cannot track frames sent by this transport.
 * The extra inbox receives receipts only and is not published in the registry.
 */
export class QwenPeerController {
  private readonly records = new Map<string, TrackedDelivery>();
  private readonly replyToken = randomBytes(32).toString('hex');
  private inbox?: PeerInbox;
  private closed = false;
  private exitHook?: () => void;
  private readonly readRecords: typeof readLiveSessionRecords;
  private readonly openInbox: typeof startPeerInbox;
  private readonly sendFrame: typeof sendPeerFrame;
  private readonly receiptTimeoutMs: number;

  constructor(
    private readonly options: ControllerOptions,
    dependencies: QwenPeerControllerDependencies = {},
  ) {
    this.readRecords = dependencies.readRecords ?? readLiveSessionRecords;
    this.openInbox = dependencies.startInbox ?? startPeerInbox;
    this.sendFrame = dependencies.sendFrame ?? sendPeerFrame;
    this.receiptTimeoutMs = dependencies.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    const token = this.options.controllerToken;
    if (
      !token.startsWith('qpc_') ||
      token.length <= 4 ||
      token.length > 256 ||
      /\s/u.test(token)
    ) {
      throw new Error('The peer controller token is invalid.');
    }
    this.inbox = await this.openInbox({
      requiredToken: this.replyToken,
      onFrame: (frame) => this.receive(frame),
      keepAlive: false,
    });
    if (!this.options.isActive() || this.closed) {
      await this.close();
      return;
    }
    this.exitHook = () => this.inbox?.closeSync();
    process.once('exit', this.exitHook);
  }

  deliveries(): InstructionDelivery[] {
    return [...this.records.values()].map((entry) => this.snapshot(entry));
  }

  async send(
    handle: BackendHandle,
    content: string,
  ): Promise<InstructionReceipt> {
    const rejected = (note: string): InstructionReceipt => ({
      status: 'rejected',
      note,
    });
    if (!this.active())
      return rejected('Terminal instructions require an active voice call.');
    if (
      handle.adaptor !== this.options.adaptor ||
      !handle.id.startsWith('qwen-peer:')
    ) {
      return rejected('This is not a discovered terminal session.');
    }
    if (!content.trim()) return rejected('The instruction is empty.');

    let records;
    try {
      records = await this.readRecords(
        sessionRegistryDir(this.options.qwenHome),
      );
    } catch {
      return rejected(
        'The terminal directory could not be read. Refresh the session list.',
      );
    }
    const matches = records.filter(
      (record) => qwenPeerHandleId(this.options.qwenHome, record) === handle.id,
    );
    if (matches.length !== 1) {
      return rejected(
        'This terminal session has changed or exited. Refresh the session list.',
      );
    }
    const record = matches[0]!;
    if (
      records.filter((candidate) => candidate.sessionId === record.sessionId)
        .length !== 1
    ) {
      return rejected(
        'This session is registered more than once. Close the duplicate terminal before sending.',
      );
    }
    const peer = toDirectoryEntry(record);
    if (!peer || peer.kind !== 'tui' || !isLocalIpcPath(peer.ipcPath)) {
      return rejected(
        'This terminal is no longer available for instructions. Refresh the session list.',
      );
    }
    // Last call fence before writing. Once a frame is written, ending the call
    // can stop receipt tracking but cannot withdraw the instruction.
    if (!this.active())
      return rejected('The voice call ended before the instruction was sent.');
    if (!this.makeRoom()) {
      return rejected(
        'This call already has 100 instructions still being tracked. Start a new call before sending more.',
      );
    }
    const inbox = this.inbox!;
    const frame = buildUserFrame({
      content,
      from: inbox.socketPath,
      replyToken: this.replyToken,
      fromName: this.options.name,
      toSessionId: record.sessionId,
      priority: 'next',
    });
    const now = Date.now();
    const entry: TrackedDelivery = {
      delivery: {
        id: frame.msgId,
        target: {
          id: handle.id,
          adaptor: this.options.adaptor,
          instructionOnly: true,
        },
        status: 'pending',
        tracking: true,
        createdAt: now,
        updatedAt: now,
      },
      wireState: 'pending',
    };
    // A recipient may reply before sendFrame settles. Register the id first.
    this.records.set(canonicalizeMsgId(frame.msgId), entry);
    entry.timeout = setTimeout(() => {
      if (!entry.delivery.tracking || entry.wireState !== 'pending') return;
      this.update(entry, {
        status: 'unknown',
        note: 'No receipt arrived in time. The instruction may still be received; do not resend automatically.',
      });
    }, this.receiptTimeoutMs);
    entry.timeout.unref?.();
    this.notify();
    // onChange is external code and may synchronously end the call.
    if (!this.active()) {
      this.finish(
        entry,
        'failed',
        'The voice call ended before the instruction was sent.',
      );
      return rejected(entry.delivery.note!);
    }
    try {
      // Do not resolve a display name or ref again here. The complete session id
      // also fences a /clear or /resume at the receiver. The protocol does not
      // atomically attest pid/startedAt; the snapshot check above is pre-dispatch.
      await this.sendFrame(peer.ipcPath, frame, {
        authToken: this.options.controllerToken,
      });
    } catch (error) {
      if (entry.delivery.tracking && entry.wireState === 'pending') {
        if (error instanceof PeerSendError && NEVER_WRITTEN.has(error.code)) {
          this.finish(
            entry,
            'failed',
            'The instruction could not be sent. Refresh the session list before trying again.',
          );
          return rejected(entry.delivery.note!);
        }
        this.update(entry, {
          status: 'unknown',
          note: 'The send result is uncertain. The instruction may still be received; do not resend automatically.',
        });
      }
    }
    return {
      status: entry.delivery.status === 'unknown' ? 'unknown' : 'sent',
      delivery: this.snapshot(entry),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.exitHook) process.removeListener('exit', this.exitHook);
    this.exitHook = undefined;
    for (const entry of this.records.values()) {
      clearTimeout(entry.timeout);
      if (!entry.delivery.tracking) continue;
      this.update(entry, {
        ...(entry.wireState === 'pending' || entry.wireState === 'held'
          ? { status: 'unknown' as const }
          : {}),
        tracking: false,
        note: 'The call ended and receipt tracking stopped. Sent instructions were not cancelled.',
      });
    }
    await this.inbox?.close();
  }

  private active(): boolean {
    return !this.closed && this.inbox !== undefined && this.options.isActive();
  }

  private receive(frame: PeerFrame): void {
    if (!this.active()) return;
    if (frame.type === 'user') {
      if (frame.from) {
        void this.sendFrame(
          frame.from,
          buildDeliveryStatusFrame({
            status: 'refused',
            origMsgId: frame.msgId,
            from: this.inbox!.socketPath,
          }),
          frame.replyToken ? { authToken: frame.replyToken } : {},
        ).catch(() => {});
      }
      return;
    }
    this.settle(frame.origMsgId, frame);
    if (frame.status === 'dropped') {
      for (const id of frame.droppedMsgIds ?? []) this.settle(id, frame);
    }
  }

  private settle(msgId: string, frame: PeerControlFrame): void {
    const entry = this.records.get(canonicalizeMsgId(msgId));
    if (
      !entry?.delivery.tracking ||
      !TRANSITIONS[entry.wireState].has(frame.status)
    )
      return;
    clearTimeout(entry.timeout);
    entry.wireState = frame.status;
    this.update(entry, {
      status: frame.status,
      tracking: frame.status === 'held' || frame.status === 'delivered',
      // Receipt reason is untrusted free text, never a diagnostic or authority.
      note: undefined,
    });
  }

  private finish(entry: TrackedDelivery, status: 'failed', note: string): void {
    clearTimeout(entry.timeout);
    this.update(entry, { status, tracking: false, note });
  }

  private update(
    entry: TrackedDelivery,
    fields: Partial<InstructionDelivery>,
  ): void {
    Object.assign(entry.delivery, fields, {
      updatedAt: Math.max(entry.delivery.updatedAt, Date.now()),
    });
    this.notify();
  }

  private makeRoom(): boolean {
    if (this.records.size < MAX_DELIVERIES) return true;
    for (const [id, entry] of this.records) {
      if (!entry.delivery.tracking) {
        this.records.delete(id);
        return true;
      }
    }
    return false;
  }

  private snapshot(entry: TrackedDelivery): InstructionDelivery {
    return { ...entry.delivery, target: { ...entry.delivery.target } };
  }

  private notify(): void {
    try {
      this.options.onChange();
    } catch {
      /* observers do not own delivery */
    }
  }
}
