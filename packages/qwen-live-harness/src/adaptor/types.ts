/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The seam between the live orchestrator and a coding-agent backend.
 *
 * An adaptor owns one backend (a qwen serve daemon, an ACP agent, ...) and
 * exposes the small primitive set the orchestrator needs. Capability bits
 * describe what the backend can actually do so the orchestrator can degrade
 * per feature instead of branching on adaptor names.
 */

/** Opaque backend session identity, scoped to the owning adaptor. */
export interface BackendHandle {
  /** Adaptor-scoped stable id (for qwen serve: the session id). */
  readonly id: string;
  /** Identifies the owning adaptor (e.g. 'qwen-code'). */
  readonly adaptor: string;
  /** Discovery-only targets must never enter an execution/control path. */
  readonly readOnly?: true;
  /** Text delivery only: no execution stream, images, stop or permission votes. */
  readonly instructionOnly?: true;
}

export type InstructionDeliveryStatus =
  | 'pending'
  | 'held'
  | 'delivered'
  | 'denied'
  | 'refused'
  | 'expired'
  | 'misaddressed'
  | 'dropped'
  | 'unknown'
  | 'failed';

/** A message receipt, independent of managed prompts and task completion. */
export interface InstructionDelivery {
  id: string;
  target: BackendHandle;
  status: InstructionDeliveryStatus;
  /** Whether later receipts can still update this record. */
  tracking: boolean;
  createdAt: number;
  updatedAt: number;
  note?: string;
}

export type InstructionReceipt =
  | { status: 'rejected'; note: string }
  | { status: 'sent' | 'unknown'; delivery: InstructionDelivery };

/** Untrusted report data. Source matching is attribution, never authority. */
export interface PeerSessionReport {
  id: string;
  callId: string;
  source: string;
  sourceStatus: 'matched' | 'unconfirmed';
  sourceSession?: BackendHandle;
  sourceSessionId?: string;
  correlationId?: string;
  category: 'progress' | 'blocked' | 'result' | 'info';
  text: string;
  receivedAt: number;
}

export interface PeerReportContext {
  id: string;
  instruction: string;
}

export interface BackendCapabilities {
  /** Whether an in-flight turn can accept an appended instruction. */
  steering: 'native' | 'queued' | 'none';
  /** Whether handoff prompts may carry image attachments. */
  imageInput: boolean;
  /** Whether permission requests surface as events and accept votes. */
  permissionForwarding: boolean;
  /** Whether the backend can push speech-worthy messages mid-turn. */
  proactiveSpeak: boolean;
  /** Whether the backend enumerates existing sessions. */
  sessionList: boolean;
  eventDelivery: 'stream' | 'per-turn' | 'poll' | 'reply-only';
}

export interface SessionSummary {
  handle: BackendHandle;
  label?: string;
  cwd?: string;
  state: 'idle' | 'busy' | 'closed' | 'unknown';
  /** Informational peer identity; never grants authority. */
  discovery?: { source: 'terminal'; sessionId: string; address: string };
}

/** Receipt returned by prompt(): the task was accepted, not completed. */
export interface PromptReceipt {
  status: 'accepted' | 'queued' | 'rejected';
  /** Correlates later turn events with this prompt (qwen serve: promptId). */
  jobRef?: string;
  /** Human note for the realtime model to relay ("queue full", ...). */
  note?: string;
  /** For steering: the instruction joined the currently running turn. */
  joinedActiveTurn?: boolean;
  /** Exact acknowledgement id later associated by a turn_joined event. */
  joinedMessageId?: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: Uint8Array; name?: string };

export type PermissionOptionKind = 'proceed' | 'reject' | 'other';

export interface PermissionOption {
  optionId: string;
  label?: string;
  kind: PermissionOptionKind;
  /**
   * Grant breadth, from the wire's structured kind (`allow_once` vs
   * `allow_always`, `reject_once` vs `reject_always`). A bare voice
   * "allow" must take the narrowest ('once') option on offer instead of
   * persisting an always-allow rule. Absent when the backend gave no
   * signal.
   */
  escalation?: 'once' | 'always';
}

export type BackendEvent =
  | { type: 'turn_started'; jobRef?: string }
  | { type: 'turn_joined'; messageId: string; jobRef: string }
  | {
      type: 'activity';
      jobRef?: string;
      kind: 'message' | 'plan' | 'tool';
      text: string;
    }
  | { type: 'progress'; jobRef?: string; summary: string }
  | { type: 'speak'; text: string }
  | {
      type: 'permission_request';
      /** Backend turn that is blocked on this vote, when known. */
      jobRef?: string;
      requestId: string;
      title: string;
      options: readonly PermissionOption[];
      payload?: unknown;
    }
  | {
      type: 'permission_resolved';
      requestId: string;
      /** True when this daemon's own vote settled it (vs WebShell etc.). */
      byUs: boolean;
    }
  | { type: 'turn_complete'; jobRef?: string; summary: string; detail?: string }
  | { type: 'turn_error'; jobRef?: string; error: string }
  | { type: 'session_closed' };

/**
 * `allow` is a one-shot grant. `allow_always` asks the backend to remember
 * the grant itself — the agent knows each tool's real scope ("all edits",
 * "this command in this project") far better than any key the harness
 * could derive from a title string. Backends that offer no always-option
 * must degrade to a one-shot allow, never to a cancel.
 */
export type PermissionDecision = 'allow' | 'allow_always' | 'deny' | 'cancel';

export type CancelJobResult = 'stopping' | 'stopped' | 'not_found';

export interface BackendAdaptor {
  readonly name: string;

  capabilities(): BackendCapabilities;

  /**
   * Verify the backend is reachable and supports what this adaptor needs.
   * Throws a descriptive error when it does not — fail fast at daemon start.
   */
  preflight(): Promise<void>;

  createSession(opts?: {
    cwd?: string;
    label?: string;
  }): Promise<BackendHandle>;

  listSessions(): Promise<SessionSummary[]>;

  /** Optional discovery lifetime; ordinary ACP adaptors need no hooks. */
  listDiscoveredSessions?(): Promise<SessionSummary[]>;
  startDiscovery?(callId: string): Promise<void>;
  stopDiscovery?(callId: string): Promise<void>;
  /** Optional text-only controller channel. Never creates a managed job. */
  sendInstruction?(
    handle: BackendHandle,
    text: string,
  ): Promise<InstructionReceipt>;
  listInstructionDeliveries?(): InstructionDelivery[];
  subscribeInstructionDeliveries?(listener: () => void): () => void;
  /** Returns current-call public send_message addressing instructions. */
  createReportContext?(target: BackendHandle): PeerReportContext | undefined;
  /** True acknowledges admission into the caller's bounded report queue. */
  subscribeReports?(
    listener: (report: PeerSessionReport) => boolean,
  ): () => void;

  /**
   * Submit one turn. Resolves as soon as the backend admits the prompt.
   * When `steer` is set and the session is busy, the adaptor attempts a
   * mid-turn injection first and reports the outcome in the receipt.
   */
  prompt(
    handle: BackendHandle,
    blocks: readonly ContentBlock[],
    opts?: { steer?: boolean },
  ): Promise<PromptReceipt>;

  /** Long-lived normalized event stream for one session. */
  events(
    handle: BackendHandle,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<BackendEvent>;

  /** True when the session currently has an active turn. */
  isBusy(handle: BackendHandle): boolean;

  cancel(handle: BackendHandle): Promise<void>;

  /** Cancel only this ref; unknown refs must never cancel a different turn. */
  cancelJob?(handle: BackendHandle, jobRef: string): Promise<CancelJobResult>;

  respondPermission(
    handle: BackendHandle,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<'delivered' | 'already_resolved'>;

  close(): Promise<void>;
}
