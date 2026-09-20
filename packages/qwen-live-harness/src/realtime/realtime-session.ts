/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DashScope qwen-omni realtime client, ported from
 * packages/cli/src/serve/live/qwen-realtime-session.ts.
 *
 * The transport, response-arbitration, and defensive-validation layers are
 * unchanged from the port. What changed for the standalone live daemon is the
 * tool surface: instead of a single hardcoded `background_agent` handoff tool
 * whose call stays open for the whole backend turn, the session accepts an
 * arbitrary tool list via config and dispatches every function call through
 * `onFunctionCall`, expecting a prompt receipt-style output for each call via
 * `submitFunctionOutput`.
 */
import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { SocketLike } from './socket.js';
import type { DebugArchive } from '../log/debug-archive.js';
import { createDebugSocket } from '../log/debug-socket.js';
import { deriveWebSocketBase } from './socket.js';
import { escapeAnsiCtrlCodes } from './sanitize.js';
import { RecoveryInputBuffer, type RecoveryInput } from './recovery-input.js';
import {
  notificationContext,
  type RealtimeNotificationLanguage,
} from './notification-context.js';
import {
  isSuccessfulTaskAdmission,
  isAcceptedTaskAdmission,
  taskRequestKey,
  type RealtimeFunctionOutputOptions,
} from './tool-confirmation.js';
export type { RealtimeFunctionOutputOptions } from './tool-confirmation.js';

export type RealtimeCallEpoch = string | number;

export const QWEN_REALTIME_INPUT_SAMPLE_RATE = 16_000;
export const QWEN_REALTIME_OUTPUT_SAMPLE_RATE = 24_000;
export const MAX_REALTIME_INSTRUCTIONS_CHARS = 100_000;

export const QWEN_REALTIME_LIMITS = {
  maxInputAudioFrameBytes: 64 * 1024,
  maxInputImageBytes: 190 * 1024,
  maxOutputAudioFrameBytes: 256 * 1024,
  maxBufferedSocketBytes: 1024 * 1024,
  maxIncomingMessageBytes: 1024 * 1024,
  maxTranscriptChars: 256 * 1024,
  maxTextDeltaChars: 64 * 1024,
  maxFunctionArgumentsChars: 32 * 1024,
  maxFunctionOutputChars: 64 * 1024,
  maxContextChars: 640 * 1024,
  maxPendingFunctionCalls: 8,
  maxIdentifierChars: 256,
} as const;

const CONNECT_TIMEOUT_MS = 8000;
const NON_DIRECT_RESPONSE_CREATED_TIMEOUT_MS = 15_000;
const NON_DIRECT_RESPONSE_DONE_TIMEOUT_MS = 120_000;
const CANCELLATION_GRACE_MS = 2_000;
const FUNCTION_OUTPUT_ACK_TIMEOUT_MS = 10_000;
const NOTIFICATION_ITEM_ACK_TIMEOUT_MS = 10_000;
const NOTIFICATION_PROVENANCE_TIMEOUT_MS = 5_000;
const MAX_NOTIFICATION_QUARANTINE_BYTES = 1024 * 1024;
const MUTED_INPUT_HEARTBEAT_INTERVAL_MS = 30_000;
const MUTED_INPUT_HEARTBEAT_DURATION_MS = 1_000;
const MUTED_INPUT_HEARTBEAT_AUDIO = Buffer.alloc(
  QWEN_REALTIME_INPUT_SAMPLE_RATE * 2,
).toString('base64');
const MAX_ERROR_MESSAGE_CHARS = 300;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;
const MAX_RECENT_EVENT_IDS = 512;
const MAX_TRACKED_INPUT_ITEMS = 32;
const MAX_RETAINED_TRANSCRIPT_ENTRIES = 512;
const PROTOCOL_DEBUG_EVENT_TYPES = new Set([
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
  'conversation.item.created',
  'conversation.item.input_audio_transcription.completed',
  'conversation.item.input_audio_transcription.failed',
  'response.created',
  'response.done',
  'response.output_item.added',
  'response.output_item.done',
  'response.function_call_arguments.done',
  'error',
]);
export const REMAIN_SILENT_TOOL_NAME = 'remain_silent';
const REALTIME_BACKEND_TEXT_PREFIX = '[BACKEND] ';
const REALTIME_SPEAK_TO_USER_PREFIX = '[SPEAK_TO_USER] ';
const REALTIME_MERGED_SPEECH_PREFIX = '[MERGE_WITH_USER] ';
const PROACTIVE_REPAIR_REJECTION_OUTPUT = JSON.stringify({
  status: 'error',
  note: 'This tool is not authorized for the Proactive repair turn.',
});
const RESPONSE_TOOL_REJECTION_OUTPUT = JSON.stringify({
  status: 'error',
  note: 'This response is not authorized to call tools.',
});

export type { RealtimeNotificationLanguage } from './notification-context.js';

/**
 * OpenAI-style function tool declaration forwarded to the realtime provider.
 *
 * `capturesTranscript` marks handoff-style tools: when the model calls one,
 * the session captures the live transcript tail (so the orchestrator can pack
 * the recent voice context into the backend prompt) and marks the response as
 * delegated, which keeps the same user turn out of the direct-answer
 * transcript collection.
 *
 * `continuesResponse` marks receipt tools whose result needs another model
 * response. Async admissions also consume their receipt response before later
 * results are injected; only the duplicate confirmation audio may be suppressed.
 */
export interface RealtimeToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  capturesTranscript?: boolean;
  continuesResponse?: boolean;
}
export interface QwenRealtimeConfig {
  endpoint: string;
  apiKey?: string;
  model: string;
  callEpoch: RealtimeCallEpoch;
  voice?: string;
  instructions: string;
  tools: readonly RealtimeToolDefinition[];
  debugArchive?: DebugArchive;
  debugContext?: Record<string, unknown>;
}

export interface QwenRealtimeDeps {
  createWebSocket?: (
    url: string,
    options: {
      headers: Record<string, string>;
      maxPayload: number;
      perMessageDeflate: false;
      handshakeTimeout: number;
    },
  ) => SocketLike;
  abortSignal?: AbortSignal;
  connectTimeoutMs?: number;
  responseCreatedTimeoutMs?: number;
  responseDoneTimeoutMs?: number;
  cancellationGraceMs?: number;
  functionOutputAckTimeoutMs?: number;
  notificationItemAckTimeoutMs?: number;
  notificationProvenanceTimeoutMs?: number;
}

export interface RealtimeEventContext {
  callEpoch: RealtimeCallEpoch;
  eventId?: string;
  /** Provider-issued session identifier; never the local call epoch. */
  sessionId?: string;
}

export interface RealtimeSpeechEvent extends RealtimeEventContext {
  itemId?: string;
  audioStartMs?: number;
  audioEndMs?: number;
}

export interface RealtimeInputTranscriptEvent extends RealtimeEventContext {
  itemId?: string;
  text: string;
  stash?: string;
  language?: string;
  emotion?: string;
}

export interface RealtimeResponseEvent extends RealtimeEventContext {
  responseId: string;
  inputItemId?: string;
  status?: string;
}

export type RealtimeResponseAuthority =
  | 'direct'
  | 'tool_continuation'
  | 'backend_speech'
  | 'permission'
  | 'task_result'
  | 'peer_report'
  | 'search_result'
  | 'visual_result'
  | 'proactive'
  | 'proactive_repair';

type RealtimeToolCapability = 'none' | 'direct';

export type RealtimeResponseCancellationReason =
  'user_interrupted' | 'client_cancelled' | 'superseded';

export interface RealtimeResponseDoneEvent extends RealtimeResponseEvent {
  authority?: RealtimeResponseAuthority;
  cancellationReason?: RealtimeResponseCancellationReason;
}

export interface RealtimeResponseCreatedEvent extends RealtimeResponseEvent {
  authority: RealtimeResponseAuthority;
}

export interface RealtimeOutputTextEvent extends RealtimeResponseEvent {
  itemId?: string;
  text: string;
  source: 'text' | 'audio_transcript';
  /** Receipt-only text remains diagnostic/history, not user-heard dialogue. */
  audioSuppressed?: boolean;
}

export interface RealtimeOutputAudioEvent extends RealtimeResponseEvent {
  itemId?: string;
  audio: Uint8Array;
}

export interface RealtimeFunctionArgumentsEvent extends RealtimeResponseEvent {
  itemId?: string;
  callId: string;
  delta: string;
}

export interface RealtimeTranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface RealtimeDirectTranscriptEvent extends RealtimeEventContext {
  responseId?: string;
  inputItemId?: string;
  entries: readonly RealtimeTranscriptEntry[];
}

export interface RealtimeImageDroppedEvent extends RealtimeEventContext {
  reason:
    'audio_not_started' | 'connection_unavailable' | 'socket_backpressure';
  bufferedBytes: number;
}

export interface RealtimeFunctionCall extends RealtimeResponseEvent {
  itemId?: string;
  callId: string;
  name: string;
  /** Raw JSON argument string as sent by the model; parsing is the caller's job. */
  arguments: string;
  /** Final real-user transcript from this call's bound input item, when available. */
  inputTranscript?: string;
  /** Transcript tail captured at call time for `capturesTranscript` tools; empty otherwise. */
  activeTranscript: readonly RealtimeTranscriptEntry[];
}

export interface RealtimeIgnoredEvent extends RealtimeEventContext {
  type: string;
  reason:
    | 'duplicate_event'
    | 'stale_response'
    | 'stale_input'
    | 'stale_call'
    | 'cancelled_response';
}

export interface RealtimeCloseInfo {
  reason: 'client' | 'remote' | 'error';
  error?: QwenRealtimeError;
}

export interface RealtimeRecoveryRequest extends RealtimeEventContext {
  code:
    | 'response_created_timeout'
    | 'response_done_timeout'
    | 'response_cancel_timeout'
    | 'silent_receipt_tool_loop';
  responseId: string;
  authority: RealtimeResponseAuthority;
  input: RecoveryInput;
}

export interface RealtimeTransportRecoveryEvent extends RealtimeEventContext {
  phase: 'started' | 'restoring' | 'completed';
  inputKind: RecoveryInput['kind'];
  inputReason?: 'completed' | 'tool_dispatched' | 'unavailable';
  code: RealtimeRecoveryRequest['code'];
  responseId: string;
  authority: RealtimeResponseAuthority;
}

export interface QwenRealtimeCallbacks {
  onDialogue?: (
    event: RealtimeEventContext & {
      inputItemId: string;
      role: 'user' | 'assistant';
      text: string;
      source?: 'normal' | 'filler';
      interrupted?: boolean;
    },
  ) => void;
  onReady?: (event: RealtimeEventContext) => void;
  onSpeechStarted?: (event: RealtimeSpeechEvent) => void;
  onSpeechStopped?: (event: RealtimeSpeechEvent) => void;
  onInputCommitted?: (
    event: RealtimeSpeechEvent & { responsePending: boolean },
  ) => void;
  /** An uncommitted VAD candidate was discarded, not a completed user turn. */
  onInputRejected?: (
    event: RealtimeEventContext & { itemId: string; reason: 'semantic_vad' },
  ) => void;
  onInputTranscriptDelta?: (event: RealtimeInputTranscriptEvent) => void;
  onInputTranscriptDone?: (event: RealtimeInputTranscriptEvent) => void;
  onOutputTextDelta?: (event: RealtimeOutputTextEvent) => void;
  onOutputTextDone?: (event: RealtimeOutputTextEvent) => void;
  onOutputAudioDelta?: (event: RealtimeOutputAudioEvent) => void;
  onOutputAudioDone?: (
    event: RealtimeResponseEvent & { itemId?: string },
  ) => void;
  onFunctionArgumentsDelta?: (event: RealtimeFunctionArgumentsEvent) => void;
  onFunctionCall?: (event: RealtimeFunctionCall) => void;
  onResponseCreated?: (event: RealtimeResponseCreatedEvent) => void;
  onResponseDone?: (event: RealtimeResponseDoneEvent) => void;
  onDirectTranscript?: (event: RealtimeDirectTranscriptEvent) => void;
  onBargeIn?: (event: RealtimeResponseEvent) => void;
  onIgnoredEvent?: (event: RealtimeIgnoredEvent) => void;
  onProtocolDebug?: (details: Record<string, unknown>) => void;
  /** A fenced transport may be replaced without replaying dispatched tools. */
  onRecoveryNeeded?: (request: RealtimeRecoveryRequest) => void;
  onTransportRecovery?: (event: RealtimeTransportRecoveryEvent) => void;
  onInputHeartbeat?: (
    event: RealtimeEventContext & {
      bytes: number;
      durationMs: number;
      intervalMs: number;
    },
  ) => void;
  onAudioDropped?: (event: RealtimeEventContext) => void;
  onImageDropped?: (event: RealtimeImageDroppedEvent) => void;
  onError?: (error: QwenRealtimeError) => void;
  onClose?: (info: RealtimeCloseInfo) => void;
}

export interface RealtimeFunctionCallRef {
  callEpoch: RealtimeCallEpoch;
  callId: string;
}

export interface RealtimeCloseOptions {
  discardPendingInput?: boolean;
}

export interface QwenRealtimeSession {
  readonly callEpoch: RealtimeCallEpoch;
  readonly closed: Promise<RealtimeCloseInfo>;
  /** True only while no input, response or tool receipt is awaiting settlement. */
  canDeliverExternalAudio?: () => boolean;
  /** Read-only admission check for an independent result/permission narrator. */
  canStartExternalSpeech?: () => boolean;
  flushDialogue: () => void;
  configure: (update: { tools: readonly RealtimeToolDefinition[] }) => boolean;
  pushAudio: (pcm16: Uint8Array) => boolean;
  /** Keep only the foreground transport alive while its microphone is muted. */
  setInputMuted: (muted: boolean) => void;
  resumeUserText?: (input: { itemId: string; text: string }) => boolean;
  finishRecoveredAudio?: () => boolean;
  pushImage: (jpegBase64: string) => boolean;
  commitInputAudio: () => boolean;
  clearInputAudio: () => boolean;
  cancelResponse: () => boolean;
  /** Submit the (receipt-style) output for a dispatched function call. */
  submitFunctionOutput: (
    ref: RealtimeFunctionCallRef,
    output: string,
    options?: RealtimeFunctionOutputOptions,
  ) => boolean;
  sendBackendContext: (text: string) => boolean;
  speakToUser: (message: string) => boolean;
  /** Ask about an untrusted pending action in the user's conversation language. */
  askPermission?: (
    message: string,
    language?: RealtimeNotificationLanguage,
  ) => boolean;
  /** Summarize the runtime-confirmed outcome without any tool authority. */
  respondToTaskResult?: (
    message: string,
    language?: RealtimeNotificationLanguage,
  ) => boolean;
  /** Read an external quotation in a separate response with no tool authority. */
  speakPeerReport?: (
    message: string,
    language?: RealtimeNotificationLanguage,
  ) => boolean;
  /** Answer from asynchronous search evidence in a response without tool authority. */
  respondToSearchResult?: (
    message: string,
    language?: RealtimeNotificationLanguage,
  ) => boolean;
  /** Answer from a read-only snapshot analysis, never granting tool authority. */
  respondToVisualResult?: (
    message: string,
    language?: RealtimeNotificationLanguage,
  ) => boolean;
  respondToProactiveEvent: (event: string) => boolean;
  requestProactiveRepair: (
    instruction: string,
    allowedToolNames: readonly string[],
  ) => boolean;
  takeTranscriptTail: () => readonly RealtimeTranscriptEntry[];
  close: (options?: RealtimeCloseOptions) => void;
}

export type QwenRealtimeErrorKind =
  'configuration' | 'quota' | 'transient' | 'protocol';

export interface QwenRealtimeErrorOptions {
  kind?: QwenRealtimeErrorKind;
  status?: number;
  providerType?: string;
  param?: string;
  closeCode?: number;
}

function classifyRealtimeErrorKind(
  code: string | undefined,
  message: string,
  status?: number,
): QwenRealtimeErrorKind {
  const normalized = `${code ?? ''} ${message}`.toLowerCase();
  if (/insufficient[ _.-]?quota|quota[ _.-]?exceeded/.test(normalized)) {
    return 'quota';
  }
  if (
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599) ||
    [
      'connection_closed',
      'connection_failed',
      'connection_timeout',
      'socket_error',
      'send_failed',
    ].includes(code ?? '') ||
    /\b429\b|rate[ _.-]?limit|throttl|limit_requests|limitrequests|resourceexhausted|resource_exhausted|limit_burst_rate|service_unavailable|internal[ _.-]?error|system[ _.-]?error|modelservicefailed|timeout|temporar/.test(
      normalized,
    )
  ) {
    return 'transient';
  }
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    /invalid[ _.-]?(api[ _.-]?key|endpoint|model|request)|authentication|unauthori[sz]ed|forbidden|permission|model[ _.-]?(not[ _.-]?found|not[ _.-]?supported)/.test(
      normalized,
    )
  ) {
    return 'configuration';
  }
  return 'protocol';
}

export class QwenRealtimeError extends Error {
  readonly code?: string;
  readonly fatal: boolean;
  readonly kind: QwenRealtimeErrorKind;
  readonly status?: number;
  readonly providerType?: string;
  readonly param?: string;
  readonly closeCode?: number;

  constructor(
    message: string,
    code?: string,
    fatal = true,
    options: QwenRealtimeErrorOptions = {},
  ) {
    super(message);
    this.name = 'QwenRealtimeError';
    this.code = code;
    this.fatal = fatal;
    this.kind =
      options.kind ?? classifyRealtimeErrorKind(code, message, options.status);
    this.status = options.status;
    this.providerType = options.providerType;
    this.param = options.param;
    this.closeCode = options.closeCode;
  }
}

interface PendingFunctionCall {
  responseId: string;
  itemId?: string;
  callId: string;
  name?: string;
  arguments: string;
  dispatched: boolean;
  outputSubmitted: boolean;
  responseCompleted: boolean;
  argumentsFinal?: boolean;
  invalidCompletion?: boolean;
  argumentsEventId?: string;
  confirmation?: ToolConfirmationBatch;
  outputOptions?: RealtimeFunctionOutputOptions;
  reusedAdmission?: boolean;
  speechGeneration: number;
  repairDeferred?: boolean;
  repairEventId?: string;
  pendingOutput?: {
    output: string;
  };
}

interface ResponseCreateRequest {
  requestId: string;
  /** Outbound wire ID, used only to correlate an explicit provider rejection. */
  eventId?: string;
  authority: RealtimeResponseAuthority;
  speechMessage?: string;
  notificationLanguage?: RealtimeNotificationLanguage;
  inputItemId?: string;
  speechGeneration: number;
  cancelled: boolean;
  cancellationReason?: RealtimeResponseCancellationReason;
  repairAllowedToolNames?: ReadonlySet<string>;
  toolCapability: RealtimeToolCapability;
  suppressAudio?: boolean;
  silentReceiptDrain?: boolean;
  admissionReceipts?: ReadonlyMap<string, AdmissionReceipt>;
  /** Provider-assigned user item, acknowledged by its exact echoed contents. */
  notificationItemId?: string;
}

interface NotificationResponse {
  request: ResponseCreateRequest;
  created: ProviderMessage;
  firstOutputItemId?: string;
  state: 'pending' | 'verified' | 'rejected';
  queued: Array<{ message: ProviderMessage; type: string }>;
  queuedBytes: number;
  timer?: ReturnType<typeof setTimeout>;
  failureReported?: boolean;
}

interface AdmissionReceipt {
  output: string;
  options?: RealtimeFunctionOutputOptions;
}

interface ToolConfirmationBatch {
  parentHadAudio: boolean;
  admissionsOnly: boolean;
  duplicatesOnly: boolean;
  receipts: Map<string, AdmissionReceipt>;
}

interface ToolContinuationState {
  speechGeneration: number;
  toolCapability: RealtimeToolCapability;
  inputItemId?: string;
  confirmation?: ToolConfirmationBatch;
  silentReceiptDrain?: boolean;
}

interface ProviderMessage extends Record<string, unknown> {
  type?: unknown;
  event_id?: unknown;
}

export function deriveQwenOmniRealtimeUrl(
  endpoint: string,
  model: string,
): string {
  const parsed = new URL(endpoint);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error('Realtime endpoint must use HTTP or WebSocket.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Realtime endpoint must not contain credentials.');
  }
  for (const name of parsed.searchParams.keys()) {
    if (/api.?key|authorization|token/i.test(name)) {
      throw new Error('Realtime endpoint must not contain credentials.');
    }
  }

  let url: URL;
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const base = deriveWebSocketBase(parsed.toString());
    url = new URL(
      parsed.pathname.replace(/\/+$/, '').endsWith('/api-ws/v1/realtime')
        ? base
        : `${base}/api-ws/v1/realtime`,
    );
    for (const [name, value] of parsed.searchParams) {
      url.searchParams.append(name, value);
    }
  } else {
    url = parsed;
    if (!url.pathname.replace(/\/+$/, '').endsWith('/api-ws/v1/realtime')) {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/api-ws/v1/realtime`;
    }
  }
  url.searchParams.set('model', model);
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(
  value: unknown,
  maxChars: number = QWEN_REALTIME_LIMITS.maxIdentifierChars,
): string | undefined {
  return typeof value === 'string' && value.length <= maxChars
    ? value
    : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function sanitizeErrorText(raw: unknown, apiKey?: string): string {
  let text =
    typeof raw === 'string'
      ? raw
      : Buffer.isBuffer(raw) || raw instanceof Uint8Array
        ? Buffer.from(raw).toString('utf8')
        : 'Qwen Realtime request failed.';
  if (apiKey) text = text.split(apiKey).join('[REDACTED]');
  return escapeAnsiCtrlCodes(text).slice(0, MAX_ERROR_MESSAGE_CHARS);
}

function optionalHttpStatus(value: unknown): number | undefined {
  const status =
    typeof value === 'string' && /^\d{3}$/.test(value)
      ? Number(value)
      : optionalFiniteNumber(value);
  return status !== undefined && status >= 100 && status <= 599
    ? Math.trunc(status)
    : undefined;
}

function responseFailureError(
  response: Record<string, unknown> | undefined,
  apiKey?: string,
): QwenRealtimeError {
  const details = isRecord(response?.['status_details'])
    ? response['status_details']
    : undefined;
  const providerError = isRecord(details?.['error'])
    ? details['error']
    : undefined;
  const code = optionalString(providerError?.['code']) ?? 'response_failed';
  const status = optionalHttpStatus(
    providerError?.['status'] ?? details?.['status'],
  );
  const providerType = optionalString(providerError?.['type']);
  const param = optionalString(providerError?.['param']);
  const message = sanitizeErrorText(
    providerError?.['message'] ??
      details?.['reason'] ??
      'Realtime response failed.',
    apiKey,
  );
  return new QwenRealtimeError(message, code, false, {
    kind: classifyRealtimeErrorKind(code, message, status),
    ...(status !== undefined ? { status } : {}),
    ...(providerType ? { providerType } : {}),
    ...(param ? { param } : {}),
  });
}

function upgradeFailureError(
  status: number | undefined,
  body: string,
  apiKey?: string,
): QwenRealtimeError {
  let payload: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    payload = isRecord(parsed) ? parsed : undefined;
  } catch {
    payload = undefined;
  }
  const providerError = isRecord(payload?.['error'])
    ? payload['error']
    : payload;
  const code =
    optionalString(providerError?.['code']) ??
    (status ? `http_${status}` : 'connection_failed');
  const fallback = status
    ? `Realtime provider rejected the WebSocket upgrade (${status}).`
    : 'Realtime provider rejected the WebSocket upgrade.';
  const message =
    typeof providerError?.['message'] === 'string'
      ? sanitizeErrorText(providerError['message'], apiKey)
      : fallback;
  return new QwenRealtimeError(message, code, true, {
    kind: classifyRealtimeErrorKind(code, message, status),
    ...(status !== undefined ? { status } : {}),
  });
}

function parseAudioDelta(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const maxBase64Chars =
    Math.ceil(QWEN_REALTIME_LIMITS.maxOutputAudioFrameBytes / 3) * 4 + 4;
  if (value.length > maxBase64Chars || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.length === 0 ||
    decoded.length % 2 !== 0 ||
    decoded.length > QWEN_REALTIME_LIMITS.maxOutputAudioFrameBytes
  ) {
    return undefined;
  }
  return new Uint8Array(decoded);
}

function isBoundedJpegBase64(value: string): boolean {
  const maxBase64Chars =
    Math.ceil(QWEN_REALTIME_LIMITS.maxInputImageBytes / 3) * 4;
  if (
    value.length === 0 ||
    value.length > maxBase64Chars ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return false;
  }
  const jpeg = Buffer.from(value, 'base64');
  return (
    jpeg.byteLength >= 4 &&
    jpeg.byteLength <= QWEN_REALTIME_LIMITS.maxInputImageBytes &&
    jpeg[0] === 0xff &&
    jpeg[1] === 0xd8 &&
    jpeg[jpeg.byteLength - 2] === 0xff &&
    jpeg[jpeg.byteLength - 1] === 0xd9 &&
    jpeg.toString('base64') === value
  );
}

export function openQwenRealtimeSession(
  config: QwenRealtimeConfig,
  callbacks: QwenRealtimeCallbacks = {},
  deps: QwenRealtimeDeps = {},
): Promise<QwenRealtimeSession> {
  const connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const responseCreatedTimeoutMs =
    deps.responseCreatedTimeoutMs ?? NON_DIRECT_RESPONSE_CREATED_TIMEOUT_MS;
  const responseDoneTimeoutMs =
    deps.responseDoneTimeoutMs ?? NON_DIRECT_RESPONSE_DONE_TIMEOUT_MS;
  const createWebSocket =
    deps.createWebSocket ??
    ((url, options) =>
      new WebSocket(url, {
        headers: options.headers,
        maxPayload: options.maxPayload,
        perMessageDeflate: options.perMessageDeflate,
        handshakeTimeout: options.handshakeTimeout,
      }) as unknown as SocketLike);

  return new Promise<QwenRealtimeSession>((resolve, reject) => {
    if (
      typeof config.instructions !== 'string' ||
      config.instructions.length > MAX_REALTIME_INSTRUCTIONS_CHARS
    ) {
      reject(
        new QwenRealtimeError(
          'Realtime instructions exceed the supported size.',
          'instructions_too_large',
          true,
          { kind: 'configuration' },
        ),
      );
      return;
    }
    if (deps.abortSignal?.aborted) {
      reject(new QwenRealtimeError('Realtime connection was aborted.'));
      return;
    }

    let realtimeUrl: string;
    try {
      realtimeUrl = deriveQwenOmniRealtimeUrl(config.endpoint, config.model);
    } catch (error) {
      reject(
        new QwenRealtimeError(
          sanitizeErrorText(
            error instanceof Error ? error.message : error,
            config.apiKey,
          ),
          'invalid_endpoint',
          true,
          { kind: 'configuration' },
        ),
      );
      return;
    }

    let ws: SocketLike;
    try {
      ws = createDebugSocket(
        () =>
          createWebSocket(realtimeUrl, {
            headers: config.apiKey
              ? { Authorization: `Bearer ${config.apiKey}` }
              : {},
            maxPayload: QWEN_REALTIME_LIMITS.maxIncomingMessageBytes,
            perMessageDeflate: false,
            handshakeTimeout: connectTimeoutMs,
          }),
        {
          debugArchive: config.debugArchive,
          info: {
            ...config.debugContext,
            kind: 'main',
            model: config.model,
            endpoint: config.endpoint,
            epoch: config.callEpoch,
          },
        },
      );
    } catch (error) {
      reject(
        new QwenRealtimeError(
          sanitizeErrorText(
            error instanceof Error ? error.message : error,
            config.apiKey,
          ),
          'connection_failed',
          true,
          { kind: 'transient' },
        ),
      );
      return;
    }

    let ready = false;
    let settled = false;
    let terminal = false;
    let closedByClient = false;
    let sessionUpdateSent = false;
    let providerSessionId: string | undefined;
    let activeResponseId: string | undefined;
    let lastCompletedResponseId: string | undefined;
    let activeAudioResponseId: string | undefined;
    let pendingResponseCreate: ResponseCreateRequest | undefined;
    let pendingNotificationItem:
      | {
          request: ResponseCreateRequest;
          text: string;
          afterItemOrder: number;
          timer?: ReturnType<typeof setTimeout>;
        }
      | undefined;
    const retiredNotificationTexts = new Set<string>();
    const notificationResponses = new Map<string, NotificationResponse>();
    const conversationItems = new Map<
      string,
      { previous?: string | null; order: number; userMedia?: boolean }
    >();
    let conversationItemOrder = 0;
    let hasNotificationHistory = false;
    let responseCreateQueue: ResponseCreateRequest[] = [];
    let speechGeneration = 0;
    let speechGenerationAdvancedForInput = false;
    let directResponsePending = false;
    let activeResponseAuthority: RealtimeResponseAuthority | undefined;
    const effectiveInstructions = config.instructions;
    let effectiveTools = [...config.tools];
    let configurationDirty = false;
    let configurationUpdatesPending = 0;
    const toolsByName = new Map<string, RealtimeToolDefinition>(
      config.tools.map((tool) => [tool.function.name, tool]),
    );
    let backpressureWarned = false;
    let hasSentInputAudio = false;
    let inputMuted = false;
    let inputHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let speechInputInProgress = false;
    let speechCommitPending = false;
    let responseCreatedInProgress = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let responseCreatedTimer: ReturnType<typeof setTimeout> | undefined;
    let responseDoneTimer: ReturnType<typeof setTimeout> | undefined;
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    let cancellationTarget: string | undefined;
    const recoveryInput = new RecoveryInputBuffer();
    const retiredResponseIds = new Set<string>();
    let abortListener: (() => void) | undefined;
    const cancelledResponseIds = new Set<string>();
    const cancelledResponseReasons = new Map<
      string,
      RealtimeResponseCancellationReason
    >();
    const recentEventIds = new Set<string>();
    const pendingCalls = new Map<string, PendingFunctionCall>();
    const pendingFunctionOutputs = new Map<
      string,
      {
        call: PendingFunctionCall;
        eventId: string;
        output: string;
        timer?: ReturnType<typeof setTimeout>;
      }
    >();
    const toolContinuationStates = new Map<string, ToolContinuationState>();
    const pendingSpeechItemIds = new Set<string>();
    const committedInputItemIds = new Set<string>();
    const completedInputTranscripts = new Map<string, string>();
    const responseInputItemIds = new Map<string, string>();
    const consumedInputItemIds = new Set<string>();
    const rejectedInputItemIds = new Set<string>();
    const transcriptEntries: RealtimeTranscriptEntry[] = [];
    const pendingDirectTranscriptEntries: RealtimeTranscriptEntry[] = [];
    const collectedDirectResponseIds = new Set<string>();
    const collectedDirectInputItemIds = new Set<string>();
    const responseAuthorities = new Map<string, RealtimeResponseAuthority>();
    const responseToolCapabilities = new Map<string, RealtimeToolCapability>();
    const responseWithTools = new Set<string>();
    const responsesWithAudio = new Set<string>();
    const audioSuppressedResponses = new Set<string>();
    const silentReceiptDrains = new Set<string>();
    const responseAdmissionReceipts = new Map<
      string,
      ReadonlyMap<string, AdmissionReceipt>
    >();
    const dialogueInputs = new Set<string>();
    const dialogueResponses = new Set<string>();
    const dialoguePrefixes = new Map<string, string>();
    const repairToolAllowlists = new Map<string, ReadonlySet<string>>();
    const delegatedResponseIds = new Set<string>();
    const responseOutputText = new Map<
      string,
      { text: string; audioTranscript: string }
    >();
    let newInputEntry = false;
    let newOutputEntry = false;
    let resolveClosed: (info: RealtimeCloseInfo) => void = () => undefined;
    const closed = new Promise<RealtimeCloseInfo>((res) => {
      resolveClosed = res;
    });
    let closedSettled = false;

    const identifier = (value: unknown): string | undefined => {
      const id = optionalString(value);
      return id &&
        /^[A-Za-z0-9_.:-]+$/.test(id) &&
        (!config.apiKey || !id.includes(config.apiKey))
        ? id
        : undefined;
    };

    const eventContext = (message?: ProviderMessage): RealtimeEventContext => ({
      callEpoch: config.callEpoch,
      ...(message ? { eventId: optionalString(message.event_id) } : {}),
      ...(providerSessionId ? { sessionId: providerSessionId } : {}),
    });

    const protocolDebug = (message: ProviderMessage, type: string): void => {
      if (!callbacks.onProtocolDebug || !PROTOCOL_DEBUG_EVENT_TYPES.has(type))
        return;
      try {
        const enumeration = (value: unknown, allowed: readonly string[]) =>
          typeof value === 'string' && allowed.includes(value)
            ? value
            : undefined;
        const item = isRecord(message['item']) ? message['item'] : undefined;
        const response = isRecord(message['response'])
          ? message['response']
          : undefined;
        const details = isRecord(response?.['status_details'])
          ? response['status_details']
          : undefined;
        const error = isRecord(message['error']) ? message['error'] : undefined;
        const itemId = optionalString(item?.['id'] ?? message['item_id']);
        const responseId = optionalString(
          response?.['id'] ?? message['response_id'],
        );
        const contentKinds = Array.isArray(item?.['content'])
          ? [
              ...new Set(
                item['content'].flatMap((part) => {
                  const kind = isRecord(part)
                    ? enumeration(part['type'], [
                        'input_audio',
                        'input_text',
                        'input_image',
                        'audio',
                        'text',
                      ])
                    : undefined;
                  return kind ? [kind] : [];
                }),
              ),
            ]
          : undefined;
        const outputCalls = Array.isArray(response?.['output'])
          ? response['output'].filter(
              (entry) => isRecord(entry) && entry['type'] === 'function_call',
            )
          : undefined;
        callbacks.onProtocolDebug({
          type,
          direction: 'in',
          ...(providerSessionId ? { sessionId: providerSessionId } : {}),
          eventId: identifier(message.event_id),
          ...(type === 'error'
            ? {
                rejectedEventId: identifier(error?.['event_id']),
                providerErrorCode: identifier(error?.['code']),
                providerErrorType: identifier(error?.['type']),
                providerErrorParam: identifier(error?.['param']),
                pendingRequestEventId: identifier(
                  pendingResponseCreate?.eventId,
                ),
              }
            : {}),
          itemId: identifier(itemId),
          responseId: identifier(responseId),
          callId: identifier(item?.['call_id'] ?? message['call_id']),
          functionName: identifier(item?.['name'] ?? message['name']),
          argumentChars:
            typeof (item?.['arguments'] ?? message['arguments']) === 'string'
              ? String(item?.['arguments'] ?? message['arguments']).length
              : undefined,
          ...(outputCalls
            ? {
                outputFunctionCallCount: outputCalls.length,
                outputFunctionCalls: outputCalls
                  .slice(0, QWEN_REALTIME_LIMITS.maxPendingFunctionCalls)
                  .map((entry) => ({
                    itemId: identifier(entry['id']),
                    callId: identifier(entry['call_id']),
                    name: identifier(entry['name']),
                    status: enumeration(entry['status'], [
                      'in_progress',
                      'completed',
                      'cancelled',
                      'failed',
                    ]),
                    argumentChars:
                      typeof entry['arguments'] === 'string'
                        ? entry['arguments'].length
                        : undefined,
                  })),
              }
            : {}),
          activeResponseId: identifier(activeResponseId),
          pendingRequestId: identifier(pendingResponseCreate?.requestId),
          pendingNotificationRequestId: identifier(
            pendingNotificationItem?.request.requestId,
          ),
          pendingAuthority: pendingResponseCreate?.authority,
          activeResponseAuthority,
          responseCancelled:
            responseId !== undefined && cancelledResponseIds.has(responseId),
          cancellationReason:
            responseId === undefined
              ? undefined
              : cancelledResponseReasons.get(responseId),
          itemType: enumeration(item?.['type'], [
            'message',
            'function_call',
            'function_call_output',
          ]),
          role: enumeration(item?.['role'], ['user', 'assistant', 'system']),
          contentKinds,
          responseStatus: enumeration(response?.['status'], [
            'in_progress',
            'completed',
            'cancelled',
            'failed',
            'incomplete',
          ]),
          statusType: enumeration(details?.['type'], [
            'completed',
            'cancelled',
            'failed',
            'incomplete',
          ]),
          statusReason: enumeration(details?.['reason'], [
            'turn_detected',
            'client_cancelled',
            'user_interrupted',
            'superseded',
            'max_output_tokens',
            'content_filter',
          ]),
          pendingSpeechItems: pendingSpeechItemIds.size,
          committedInputItems: committedInputItemIds.size,
          completedInputTranscripts: completedInputTranscripts.size,
          consumedInputItems: consumedInputItemIds.size,
          hasPendingSpeechItem:
            itemId !== undefined && pendingSpeechItemIds.has(itemId),
          hasCommittedInputItem:
            itemId !== undefined && committedInputItemIds.has(itemId),
          hasCompletedInputTranscript:
            itemId !== undefined && completedInputTranscripts.has(itemId),
          hasConsumedInputItem:
            itemId !== undefined && consumedInputItemIds.has(itemId),
          hasPendingResponseCreate: pendingResponseCreate !== undefined,
          queuedResponseCreates: responseCreateQueue.length,
          hasSentInputAudio,
          speechInputInProgress,
          speechCommitPending,
          directResponsePending,
        });
      } catch {
        // Diagnostics must not change the call's protocol or lifecycle.
      }
    };

    const callback = (fn: (() => void) | undefined): boolean => {
      if (!fn) return true;
      try {
        fn();
        return true;
      } catch (error) {
        fail(
          new QwenRealtimeError(
            sanitizeErrorText(
              error instanceof Error ? error.message : error,
              config.apiKey,
            ),
            'callback_failed',
          ),
        );
        return false;
      }
    };

    const settleClosed = (info: RealtimeCloseInfo) => {
      if (closedSettled) return;
      closedSettled = true;
      resolveClosed(info);
      try {
        callbacks.onClose?.(info);
      } catch {
        /* ignore observer failures after shutdown */
      }
    };

    const clearConnectTimer = () => {
      if (!connectTimer) return;
      clearTimeout(connectTimer);
      connectTimer = undefined;
    };

    const clearInputHeartbeat = () => {
      if (inputHeartbeatTimer === undefined) return;
      clearInterval(inputHeartbeatTimer);
      inputHeartbeatTimer = undefined;
    };

    const clearResponseCreatedTimer = () => {
      if (!responseCreatedTimer) return;
      clearTimeout(responseCreatedTimer);
      responseCreatedTimer = undefined;
    };

    const clearResponseDoneTimer = () => {
      if (!responseDoneTimer) return;
      clearTimeout(responseDoneTimer);
      responseDoneTimer = undefined;
    };

    const clearResponseTimers = () => {
      clearResponseCreatedTimer();
      clearResponseDoneTimer();
      if (cancellationTimer !== undefined) clearTimeout(cancellationTimer);
      cancellationTimer = undefined;
      cancellationTarget = undefined;
      for (const output of pendingFunctionOutputs.values()) {
        if (output.timer) clearTimeout(output.timer);
      }
      pendingFunctionOutputs.clear();
      responsesWithAudio.clear();
      audioSuppressedResponses.clear();
      silentReceiptDrains.clear();
      responseAdmissionReceipts.clear();
      if (pendingNotificationItem?.timer)
        clearTimeout(pendingNotificationItem.timer);
      pendingNotificationItem = undefined;
      for (const response of notificationResponses.values()) {
        if (response.timer) clearTimeout(response.timer);
      }
      notificationResponses.clear();
      retiredNotificationTexts.clear();
    };

    const removeAbortListener = () => {
      if (!abortListener) return;
      deps.abortSignal?.removeEventListener('abort', abortListener);
      abortListener = undefined;
    };

    const closeSocket = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };

    const notifyError = (error: QwenRealtimeError) => {
      try {
        callbacks.onError?.(error);
      } catch {
        /* ignore error observer failures */
      }
    };

    const unrecoverableInputError = (): QwenRealtimeError =>
      new QwenRealtimeError(
        'Realtime connection ended before accepted speech finished transcribing.',
        'unrecoverable_input',
        true,
        { kind: 'protocol' },
      );

    const pendingInputLossError = (): QwenRealtimeError | undefined => {
      const hasUnresolvedCommittedInput = [...committedInputItemIds].some(
        (itemId) => !completedInputTranscripts.has(itemId),
      );
      return speechInputInProgress ||
        speechCommitPending ||
        hasUnresolvedCommittedInput
        ? unrecoverableInputError()
        : undefined;
    };

    function fail(error: QwenRealtimeError): void {
      if (terminal) return;
      const inputLossError = pendingInputLossError();
      const reportedError =
        error.kind === 'transient' && inputLossError ? inputLossError : error;
      // Preserve the original transport failure for diagnostics without changing
      // the existing conservative unrecoverable-input behavior.
      if (reportedError !== error) reportedError.cause = error;
      terminal = true;
      recoveryInput.clear();
      if (activeResponseId) collectDialogueResponse(activeResponseId, true);
      clearConnectTimer();
      clearResponseTimers();
      clearInputHeartbeat();
      removeAbortListener();
      closeSocket();
      if (!settled) {
        settled = true;
        reject(reportedError);
      } else {
        notifyError(reportedError);
      }
      settleClosed({ reason: 'error', error: reportedError });
    }

    const protocolError = (message: string, code: string) => {
      fail(new QwenRealtimeError(message, code));
    };

    const sendJson = (body: Record<string, unknown>): boolean => {
      if (terminal || closedByClient || ws.readyState !== ws.OPEN) return false;
      try {
        const payload = { event_id: randomUUID(), ...body };
        ws.send(JSON.stringify(payload));
        const item = isRecord(body['item']) ? body['item'] : undefined;
        if (
          body['type'] === 'response.create' ||
          body['type'] === 'response.cancel' ||
          item?.['type'] === 'function_call_output'
        ) {
          try {
            callbacks.onProtocolDebug?.({
              type: `client.${String(body['type'])}`,
              direction: 'out',
              ...eventContext(),
              eventId: payload.event_id,
              itemType: item?.['type'],
              callId: identifier(item?.['call_id']),
              activeResponseId: identifier(activeResponseId),
              pendingRequestId: identifier(pendingResponseCreate?.requestId),
              pendingAuthority: pendingResponseCreate?.authority,
              outputChars:
                typeof item?.['output'] === 'string'
                  ? item['output'].length
                  : undefined,
            });
          } catch {
            /* diagnostic only */
          }
        }
        return true;
      } catch (error) {
        fail(
          new QwenRealtimeError(
            sanitizeErrorText(
              error instanceof Error ? error.message : error,
              config.apiKey,
            ),
            'send_failed',
          ),
        );
        return false;
      }
    };

    const sendMutedInputHeartbeat = (): void => {
      if (!inputMuted || !ready || terminal || closedByClient) return;
      if (
        (ws.bufferedAmount ?? 0) > QWEN_REALTIME_LIMITS.maxBufferedSocketBytes
      ) {
        // A skipped silence packet loses no user speech. Record it without
        // turning a temporary backlog into a call-ending audio-drop failure.
        notifyError(
          new QwenRealtimeError(
            'Muted input heartbeat was skipped because the socket buffer is full.',
            'input_heartbeat_backpressure',
            false,
            { kind: 'transient' },
          ),
        );
        return;
      }
      const eventId = randomUUID();
      const sent = sendJson({
        event_id: eventId,
        type: 'input_audio_buffer.append',
        audio: MUTED_INPUT_HEARTBEAT_AUDIO,
      });
      if (!sent) {
        if (!terminal && !closedByClient) {
          fail(
            new QwenRealtimeError(
              'Muted input heartbeat could not be sent.',
              'input_heartbeat_send_failed',
              true,
              { kind: 'transient' },
            ),
          );
        }
        return;
      }
      // Deliberately bypass pushAudio and all microphone/Memory/Monitor
      // consumers. Silence is only a transport append, never a commit, a
      // response request, or a playback cancellation.
      hasSentInputAudio = true;
      recoveryInput.protocolSilence(QWEN_REALTIME_INPUT_SAMPLE_RATE * 2);
      try {
        callbacks.onInputHeartbeat?.({
          ...eventContext(),
          eventId,
          bytes: QWEN_REALTIME_INPUT_SAMPLE_RATE * 2,
          durationMs: MUTED_INPUT_HEARTBEAT_DURATION_MS,
          intervalMs: MUTED_INPUT_HEARTBEAT_INTERVAL_MS,
        });
      } catch {
        // Heartbeat metadata is diagnostic only, not a protocol callback.
      }
    };

    const reportResponseTimeout = (
      request: ResponseCreateRequest,
      responseId: string,
      phase: 'created' | 'done',
    ): void => {
      if (callbacks.onRecoveryNeeded) {
        requestRecovery(
          `response_${phase}_timeout`,
          request.authority,
          responseId,
        );
        return;
      }
      callback(() =>
        callbacks.onResponseDone?.({
          ...eventContext(),
          responseId,
          status: 'failed',
          authority: request.authority,
          ...(request.cancellationReason
            ? { cancellationReason: request.cancellationReason }
            : {}),
        }),
      );
      fail(
        new QwenRealtimeError(
          `Realtime ${request.authority} response timed out waiting for response.${phase}.`,
          `response_${phase}_timeout`,
          true,
          { kind: 'transient' },
        ),
      );
    };

    const requestRecovery = (
      code: RealtimeRecoveryRequest['code'],
      authority: RealtimeResponseAuthority,
      responseId: string,
    ): void => {
      if (terminal || closedByClient) return;
      if (!callbacks.onRecoveryNeeded) {
        fail(
          new QwenRealtimeError(
            'Realtime response cancellation was not acknowledged.',
            code,
            true,
            { kind: 'transient' },
          ),
        );
        return;
      }
      const input = recoveryInput.snapshot();
      terminal = true;
      clearConnectTimer();
      clearResponseTimers();
      clearInputHeartbeat();
      removeAbortListener();
      recoveryInput.clear();
      // Fence all callbacks before replacing the socket. A late old ACK can
      // never be associated with a new direct request or gain tool authority.
      callbacks.onRecoveryNeeded({
        ...eventContext(),
        code,
        authority,
        responseId,
        input,
      });
      closeSocket();
      settleClosed({ reason: 'client' });
    };

    const armCancellationGrace = (
      authority: RealtimeResponseAuthority,
      responseId: string,
      pending?: ResponseCreateRequest,
    ): void => {
      if (cancellationTimer !== undefined) return;
      cancellationTarget = responseId;
      cancellationTimer = setTimeout(() => {
        cancellationTimer = undefined;
        cancellationTarget = undefined;
        if (
          pending
            ? pendingResponseCreate !== pending
            : activeResponseId !== responseId
        )
          return;
        requestRecovery('response_cancel_timeout', authority, responseId);
      }, deps.cancellationGraceMs ?? CANCELLATION_GRACE_MS);
      cancellationTimer.unref?.();
    };

    const retireResponse = (responseId: string): void => {
      retiredResponseIds.add(responseId);
      if (retiredResponseIds.size > 64)
        retiredResponseIds.delete(retiredResponseIds.values().next().value!);
      if (cancellationTarget === responseId) {
        if (cancellationTimer !== undefined) clearTimeout(cancellationTimer);
        cancellationTimer = undefined;
        cancellationTarget = undefined;
      }
    };

    const flushConfiguration = (): boolean => {
      if (
        !configurationDirty ||
        !ready ||
        activeResponseId ||
        pendingResponseCreate ||
        pendingNotificationItem ||
        responseCreatedInProgress
      )
        return true;
      if (
        !sendJson({
          type: 'session.update',
          session: {
            tools: effectiveTools.map((tool) => ({
              type: tool.type,
              function: tool.function,
            })),
          },
        })
      )
        return false;
      configurationDirty = false;
      configurationUpdatesPending += 1;
      return true;
    };

    const armResponseCreatedTimer = (request: ResponseCreateRequest): void => {
      clearResponseCreatedTimer();
      responseCreatedTimer = setTimeout(() => {
        responseCreatedTimer = undefined;
        if (pendingResponseCreate !== request || terminal || closedByClient) {
          return;
        }
        pendingResponseCreate = undefined;
        reportResponseTimeout(
          request,
          `unacknowledged-${request.requestId}`,
          'created',
        );
      }, responseCreatedTimeoutMs);
      responseCreatedTimer.unref?.();
    };

    const armResponseDoneTimer = (
      request: ResponseCreateRequest,
      responseId: string,
    ): void => {
      clearResponseDoneTimer();
      if (request.authority === 'direct') return;
      responseDoneTimer = setTimeout(() => {
        responseDoneTimer = undefined;
        if (activeResponseId !== responseId || terminal || closedByClient) {
          return;
        }
        sendJson({ type: 'response.cancel' });
        reportResponseTimeout(request, responseId, 'done');
      }, responseDoneTimeoutMs);
      responseDoneTimer.unref?.();
    };

    const markResponseCancelled = (
      responseId: string,
      retainActive = false,
      reason: RealtimeResponseCancellationReason = 'superseded',
    ): void => {
      if (cancelledResponseIds.has(responseId)) {
        if (!cancelledResponseReasons.has(responseId)) {
          cancelledResponseReasons.set(responseId, reason);
        }
        return;
      }
      cancelledResponseIds.add(responseId);
      cancelledResponseReasons.set(responseId, reason);
      const notification = notificationResponses.get(responseId);
      if (notification) {
        if (notification.timer) clearTimeout(notification.timer);
        notification.timer = undefined;
        notification.state = 'rejected';
        notification.queued = [];
        notification.queuedBytes = 0;
      }
      for (const [callId, call] of pendingCalls) {
        if (
          call.responseId === responseId &&
          (!call.dispatched || call.repairDeferred)
        ) {
          pendingCalls.delete(callId);
        }
      }
      if (!retainActive && activeResponseId === responseId) {
        activeResponseId = undefined;
        activeResponseAuthority = undefined;
      }
      if (activeAudioResponseId === responseId) {
        activeAudioResponseId = undefined;
      }
      if (cancelledResponseIds.size > 16) {
        const oldest = cancelledResponseIds.values().next().value;
        if (typeof oldest === 'string') {
          cancelledResponseIds.delete(oldest);
          cancelledResponseReasons.delete(oldest);
        }
      }
    };

    const reportDroppedImage = (
      reason: RealtimeImageDroppedEvent['reason'],
    ): void => {
      callback(() =>
        callbacks.onImageDropped?.({
          ...eventContext(),
          reason,
          bufferedBytes: ws.bufferedAmount ?? 0,
        }),
      );
    };

    const dropImage = (reason: RealtimeImageDroppedEvent['reason']): false => {
      reportDroppedImage(reason);
      return false;
    };

    const rejectFunctionOutput = (
      callId: string,
      code: 'tool_output_rejected' | 'tool_output_ack_timeout',
      providerEventId?: string,
    ): void => {
      const pending = pendingFunctionOutputs.get(callId);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      pendingFunctionOutputs.delete(callId);
      // This is an uncertain delivery, not permission to execute the tool again.
      toolContinuationStates.delete(pending.call.responseId);
      try {
        callbacks.onProtocolDebug?.({
          type: 'tool.output_delivery_failed',
          ...eventContext(),
          code,
          callId: identifier(callId),
          responseId: identifier(pending.call.responseId),
          outboundEventId: identifier(pending.eventId),
          eventId: identifier(providerEventId),
        });
      } catch {
        /* diagnostics cannot change delivery handling */
      }
      sendBackendConversationItem(
        `[TOOL_OUTPUT_STATUS] ${JSON.stringify({
          status:
            code === 'tool_output_rejected' ? 'rejected' : 'unacknowledged',
          tool: pending.call.name,
          call_id: callId,
          local_result: pending.output,
        })}`,
      );
      notifyError(
        new QwenRealtimeError(
          code === 'tool_output_rejected'
            ? 'The service rejected a tool result. The operation was not retried; the conversation remains open.'
            : 'The service did not acknowledge a tool result. The operation was not retried; the conversation remains open.',
          code,
          false,
          { kind: 'protocol' },
        ),
      );
      queueMicrotask(flushResponseCreate);
    };

    const sendFunctionCallOutput = (
      call: PendingFunctionCall,
      output: string,
    ): boolean => {
      if (call.confirmation) {
        call.confirmation.admissionsOnly &&= isSuccessfulTaskAdmission(
          call.name ?? '',
          output,
          call.outputOptions,
        );
        call.confirmation.duplicatesOnly &&= call.reusedAdmission === true;
        const key = taskRequestKey(call.name ?? '', call.arguments);
        if (
          key &&
          isAcceptedTaskAdmission(call.name ?? '', output, call.outputOptions)
        ) {
          call.confirmation.receipts.set(key, {
            output,
            options: call.outputOptions,
          });
        }
      }
      const eventId = randomUUID();
      const pending: {
        call: PendingFunctionCall;
        eventId: string;
        output: string;
        timer?: ReturnType<typeof setTimeout>;
      } = { call, eventId, output };
      pendingFunctionOutputs.set(call.callId, pending);
      if (
        !sendJson({
          event_id: eventId,
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: call.callId,
            output,
          },
        })
      ) {
        pendingFunctionOutputs.delete(call.callId);
        return false;
      }
      call.outputSubmitted = true;
      call.pendingOutput = undefined;
      pendingCalls.delete(call.callId);
      if (
        terminal ||
        closedByClient ||
        pendingFunctionOutputs.get(call.callId) !== pending
      )
        return true;
      pending.timer = setTimeout(
        () => rejectFunctionOutput(call.callId, 'tool_output_ack_timeout'),
        deps.functionOutputAckTimeoutMs ?? FUNCTION_OUTPUT_ACK_TIMEOUT_MS,
      );
      pending.timer.unref?.();
      return true;
    };

    const responseMessage = (
      request: Pick<
        ResponseCreateRequest,
        'authority' | 'speechMessage' | 'notificationLanguage'
      >,
    ): string => {
      const message = request.speechMessage ?? '';
      if (
        request.authority === 'peer_report' ||
        request.authority === 'search_result' ||
        request.authority === 'visual_result' ||
        request.authority === 'permission' ||
        request.authority === 'task_result'
      ) {
        return notificationContext(
          request.authority,
          message,
          request.notificationLanguage,
        );
      }
      return request.authority === 'proactive' ||
        request.authority === 'proactive_repair'
        ? message
        : `${REALTIME_SPEAK_TO_USER_PREFIX}${message}`;
    };

    const hasToolReceiptBarrier = (): boolean =>
      pendingCalls.size > 0 ||
      pendingFunctionOutputs.size > 0 ||
      toolContinuationStates.size > 0 ||
      activeResponseAuthority === 'tool_continuation' ||
      pendingResponseCreate?.authority === 'tool_continuation' ||
      responseCreateQueue.some(
        (queued) => queued.authority === 'tool_continuation',
      );

    const enqueueResponseCreate = (
      request: ResponseCreateRequest,
      priority = request.authority === 'direct',
    ): void => {
      if (request.authority === 'tool_continuation' || priority) {
        // Even replacement direct replies must wait for outstanding receipt
        // continuations, or the provider can answer a stale admission instead.
        const index = responseCreateQueue.findIndex(
          (queued) => queued.authority !== 'tool_continuation',
        );
        if (index >= 0) {
          responseCreateQueue.splice(index, 0, request);
          return;
        }
      }
      responseCreateQueue.push(request);
    };

    const notificationDiagnostic = (
      type: string,
      request: ResponseCreateRequest,
      details: Record<string, unknown> = {},
    ): void => {
      try {
        callbacks.onProtocolDebug?.({
          type,
          ...eventContext(),
          requestId: request.requestId,
          authority: request.authority,
          notificationItemId: request.notificationItemId,
          ...details,
        });
      } catch {
        // Correlation failures are diagnostics, not fatal provider failures.
      }
    };

    const finishNotificationAdmission = (
      request: ResponseCreateRequest,
      reason: 'ack_timeout' | 'user_interrupted' | 'ambiguous_repeated_content',
    ): void => {
      if (terminal || closedByClient) return;
      notificationDiagnostic('notification.admission_failed', request, {
        reason,
      });
      callback(() =>
        callbacks.onResponseDone?.({
          ...eventContext(),
          responseId: `unacknowledged-${request.requestId}`,
          authority: request.authority,
          status: reason === 'user_interrupted' ? 'cancelled' : 'failed',
          ...(reason === 'user_interrupted'
            ? { cancellationReason: 'user_interrupted' as const }
            : {}),
        }),
      );
    };

    const retireNotificationItem = (
      reason: 'ack_timeout' | 'user_interrupted',
    ): void => {
      const pending = pendingNotificationItem;
      if (!pending) return;
      pendingNotificationItem = undefined;
      if (pending.timer) clearTimeout(pending.timer);
      // A late echoed ACK must not authorize another identical notification.
      retiredNotificationTexts.add(
        createHash('sha256').update(pending.text).digest('hex'),
      );
      finishNotificationAdmission(pending.request, reason);
      queueMicrotask(flushResponseCreate);
    };

    const sendNotificationItem = (request: ResponseCreateRequest): boolean => {
      const text = responseMessage(request);
      // Bound tombstones without forgetting an ambiguous, still-unacknowledged
      // duplicate. New calls get a fresh transport and correlation state.
      if (
        retiredNotificationTexts.has(
          createHash('sha256').update(text).digest('hex'),
        ) ||
        retiredNotificationTexts.size >= 64
      ) {
        queueMicrotask(() =>
          finishNotificationAdmission(request, 'ambiguous_repeated_content'),
        );
        return true;
      }
      const pending: NonNullable<typeof pendingNotificationItem> = {
        request,
        text,
        afterItemOrder: conversationItemOrder,
      };
      pendingNotificationItem = pending;
      hasNotificationHistory = true;
      if (!sendBackendConversationItem(text, '')) {
        if (pendingNotificationItem === pending)
          pendingNotificationItem = undefined;
        return false;
      }
      if (pendingNotificationItem !== pending || terminal || closedByClient)
        return true;
      pending.timer = setTimeout(() => {
        if (pendingNotificationItem === pending)
          retireNotificationItem('ack_timeout');
      }, deps.notificationItemAckTimeoutMs ?? NOTIFICATION_ITEM_ACK_TIMEOUT_MS);
      pending.timer.unref?.();
      return true;
    };

    const acknowledgeNotificationItem = (
      item: Record<string, unknown>,
    ): void => {
      if (
        item['type'] !== 'message' ||
        item['role'] !== 'user' ||
        !Array.isArray(item['content'])
      )
        return;
      // Do not match a text prefix, client-supplied ID, or another user item.
      // The service may replace client IDs but echoes notification text.
      const parts = item['content'];
      if (
        parts.length !== 1 ||
        !isRecord(parts[0]) ||
        !['input_text', 'text'].includes(String(parts[0]['type'])) ||
        typeof parts[0]['text'] !== 'string'
      )
        return;
      const text = parts[0]['text'];
      if (
        retiredNotificationTexts.delete(
          createHash('sha256').update(text).digest('hex'),
        )
      )
        return;
      const pending = pendingNotificationItem;
      const itemId = identifier(item['id']);
      if (
        !pending ||
        !itemId ||
        (conversationItems.get(itemId)?.order ?? 0) <= pending.afterItemOrder ||
        text !== pending.text ||
        (item['status'] !== undefined && item['status'] !== 'completed')
      )
        return;
      pendingNotificationItem = undefined;
      if (pending.timer) clearTimeout(pending.timer);
      pending.request.notificationItemId = itemId;
      notificationDiagnostic('notification.item_acknowledged', pending.request);
      if (activeResponseId || pendingResponseCreate)
        enqueueResponseCreate(pending.request);
      else sendResponseCreate(pending.request);
    };

    const sendResponseCreate = (request: ResponseCreateRequest): boolean => {
      if (request.speechGeneration !== speechGeneration) {
        if (request.authority !== 'tool_continuation') return true;
        // A late result still has to consume its provider receipt response.
        // Superseded user intent must not regain tool authority or speak over
        // a newer turn merely to complete this protocol step.
        request.speechGeneration = speechGeneration;
        request.inputItemId = undefined;
        request.toolCapability = 'none';
        request.suppressAudio = true;
      }
      if (!flushConfiguration()) return false;
      if (configurationUpdatesPending > 0 || pendingFunctionOutputs.size > 0) {
        enqueueResponseCreate(request);
        return true;
      }
      if (
        request.authority !== 'tool_continuation' &&
        request.authority !== 'direct' &&
        (pendingCalls.size > 0 ||
          toolContinuationStates.size > 0 ||
          speechInputInProgress ||
          speechCommitPending ||
          directResponsePending)
      ) {
        enqueueResponseCreate(request);
        return true;
      }
      if (pendingNotificationItem) {
        enqueueResponseCreate(request);
        return true;
      }
      if (request.speechMessage !== undefined && !request.notificationItemId)
        return sendNotificationItem(request);
      pendingResponseCreate = request;
      request.eventId = randomUUID();
      if (
        sendJson({
          event_id: request.eventId,
          type: 'response.create',
          response: {
            modalities:
              request.authority === 'proactive_repair'
                ? ['text']
                : ['text', 'audio'],
          },
        })
      ) {
        armResponseCreatedTimer(request);
        return true;
      }
      pendingResponseCreate = undefined;
      clearResponseCreatedTimer();
      return false;
    };

    const requestResponseCreate = (
      authority: RealtimeResponseAuthority,
      speechMessage?: string,
      inputItemId?: string,
      repairAllowedToolNames?: ReadonlySet<string>,
      toolCapability: RealtimeToolCapability = authority === 'direct' &&
      inputItemId !== undefined
        ? 'direct'
        : 'none',
      notificationLanguage?: RealtimeNotificationLanguage,
      suppressAudio = false,
      admissionReceipts?: ReadonlyMap<string, AdmissionReceipt>,
      silentReceiptDrain = false,
    ): boolean => {
      if (
        (authority === 'peer_report' ||
          authority === 'search_result' ||
          authority === 'visual_result') &&
        (!ready ||
          speechInputInProgress ||
          speechCommitPending ||
          responseCreatedInProgress ||
          directResponsePending ||
          configurationDirty ||
          configurationUpdatesPending > 0 ||
          pendingFunctionOutputs.size > 0 ||
          pendingResponseCreate !== undefined ||
          pendingNotificationItem !== undefined ||
          activeResponseId !== undefined ||
          toolContinuationStates.size > 0 ||
          responseCreateQueue.length > 0)
      ) {
        // Only Injector may queue/retry these results. Never merge their data
        // into a foreground response, or inherit a direct tool capability.
        return false;
      }
      if (
        authority !== 'direct' &&
        authority !== 'tool_continuation' &&
        directResponsePending &&
        !hasToolReceiptBarrier()
      ) {
        // Do not inject a real notification into a pending receipt response:
        // that response may be audio-suppressed. Queue it independently until
        // all receipt continuations have completed instead.
        if (
          speechMessage !== undefined &&
          !sendBackendConversationItem(
            responseMessage({ authority, speechMessage, notificationLanguage }),
            REALTIME_MERGED_SPEECH_PREFIX,
          )
        ) {
          return false;
        }
        // The direct request has left the socket but has not been accepted by
        // the provider yet. Cancel and replace it so the merged item, which is
        // ordered after that first request on the wire, is guaranteed to be in
        // the response context instead of becoming a second spoken turn.
        if (
          pendingResponseCreate?.authority === 'direct' &&
          !pendingResponseCreate.cancelled
        ) {
          const pendingDirect = pendingResponseCreate;
          pendingDirect.cancelled = true;
          pendingDirect.cancellationReason = 'superseded';
          clearResponseCreatedTimer();
          armCancellationGrace(
            'direct',
            `unacknowledged-${pendingDirect.requestId}`,
            pendingDirect,
          );
          enqueueResponseCreate(
            {
              requestId: randomUUID(),
              authority: 'direct',
              ...(pendingDirect.inputItemId
                ? { inputItemId: pendingDirect.inputItemId }
                : {}),
              speechGeneration,
              cancelled: false,
              toolCapability: pendingDirect.toolCapability,
            },
            true,
          );
        }
        return true;
      }
      const request = {
        requestId: randomUUID(),
        authority,
        ...(speechMessage !== undefined ? { speechMessage } : {}),
        ...(notificationLanguage ? { notificationLanguage } : {}),
        ...(inputItemId !== undefined ? { inputItemId } : {}),
        ...(repairAllowedToolNames !== undefined
          ? { repairAllowedToolNames }
          : {}),
        speechGeneration,
        cancelled: false,
        toolCapability,
        suppressAudio,
        admissionReceipts,
        silentReceiptDrain,
      };
      if (
        pendingResponseCreate ||
        pendingNotificationItem ||
        activeResponseId ||
        responseCreateQueue.some(
          (queued) => queued.authority === 'tool_continuation',
        )
      ) {
        enqueueResponseCreate(request);
        if (!pendingResponseCreate && !activeResponseId)
          queueMicrotask(flushResponseCreate);
        return true;
      }
      return sendResponseCreate(request);
    };

    const flushResponseCreate = (): void => {
      if (
        pendingResponseCreate ||
        pendingNotificationItem ||
        activeResponseId
      ) {
        return;
      }
      if (!flushConfiguration()) return;
      if (configurationUpdatesPending > 0 || pendingFunctionOutputs.size > 0)
        return;
      const next = responseCreateQueue.shift();
      if (!next) return;
      if (next.cancelled) {
        queueMicrotask(flushResponseCreate);
        return;
      }
      sendResponseCreate(next);
    };

    const maybeRequestToolContinuation = (responseId: string): void => {
      if (
        [...pendingCalls.values()].some(
          (call) => call.responseId === responseId,
        ) ||
        [...pendingFunctionOutputs.values()].some(
          ({ call }) => call.responseId === responseId,
        )
      ) {
        return;
      }
      const continuation = toolContinuationStates.get(responseId);
      if (!continuation) return;
      toolContinuationStates.delete(responseId);
      const superseded = continuation.speechGeneration !== speechGeneration;
      const protocolOnly =
        superseded ||
        continuation.silentReceiptDrain === true ||
        continuation.confirmation?.duplicatesOnly === true;
      requestResponseCreate(
        'tool_continuation',
        undefined,
        protocolOnly ? undefined : continuation.inputItemId,
        undefined,
        protocolOnly ? 'none' : continuation.toolCapability,
        undefined,
        superseded ||
          continuation.silentReceiptDrain === true ||
          (continuation.confirmation?.parentHadAudio === true &&
            continuation.confirmation.admissionsOnly),
        continuation.confirmation?.receipts,
        continuation.silentReceiptDrain,
      );
    };

    const sendBackendConversationItem = (
      text: string,
      prefix = REALTIME_BACKEND_TEXT_PREFIX,
    ): boolean =>
      sendJson({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `${prefix}${text}`,
            },
          ],
        },
      });

    const queueFunctionCallOutput = (
      call: PendingFunctionCall,
      output: string,
      options?: RealtimeFunctionOutputOptions,
    ): boolean => {
      if (call.outputSubmitted || call.pendingOutput) return false;
      call.outputOptions =
        options?.taskAdmission === true ? { taskAdmission: true } : undefined;
      if (!call.responseCompleted && activeResponseId === call.responseId) {
        call.pendingOutput = { output };
        return true;
      }
      if (!sendFunctionCallOutput(call, output)) return false;
      return true;
    };

    const completePendingCallsForResponse = (
      responseId: string,
      status: string | undefined,
    ): void => {
      if (status === 'failed' || status === 'cancelled') {
        toolContinuationStates.delete(responseId);
      }
      for (const [callId, call] of [...pendingCalls]) {
        if (call.responseId !== responseId) continue;
        call.responseCompleted = true;
        if (status !== 'completed' || !call.dispatched || call.repairDeferred) {
          pendingCalls.delete(callId);
          continue;
        }
        const pendingOutput = call.pendingOutput;
        if (!pendingOutput) continue;
        call.pendingOutput = undefined;
        if (!sendFunctionCallOutput(call, pendingOutput.output) && !terminal) {
          fail(
            new QwenRealtimeError(
              'Realtime function output could not be sent.',
              'function_output_send_failed',
              true,
              { kind: 'transient' },
            ),
          );
          return;
        }
      }
      maybeRequestToolContinuation(responseId);
    };

    const rememberCompletedInputTranscript = (
      itemId: string,
      transcript: string,
    ): boolean => {
      if (consumedInputItemIds.has(itemId)) return false;
      const existing = completedInputTranscripts.get(itemId);
      if (existing !== undefined) {
        protocolError(
          'Realtime provider supplied multiple final transcripts for one input.',
          'ambiguous_final_transcript',
        );
        return false;
      }
      if (
        completedInputTranscripts.size >= MAX_TRACKED_INPUT_ITEMS &&
        !completedInputTranscripts.has(itemId)
      ) {
        protocolError(
          'Realtime provider created too many pending final transcripts.',
          'too_many_pending_inputs',
        );
        return false;
      }
      completedInputTranscripts.set(itemId, transcript);
      return true;
    };

    const consumeInputItem = (itemId: string): void => {
      recoveryInput.completed(itemId);
      completedInputTranscripts.delete(itemId);
      committedInputItemIds.delete(itemId);
      collectedDirectInputItemIds.delete(itemId);
      consumedInputItemIds.add(itemId);
      while (consumedInputItemIds.size > MAX_TRACKED_INPUT_ITEMS) {
        const oldest = consumedInputItemIds.values().next().value;
        if (typeof oldest !== 'string') break;
        consumedInputItemIds.delete(oldest);
      }
    };

    const consumeResponseInput = (responseId: string): string | undefined => {
      responseWithTools.delete(responseId);
      dialoguePrefixes.delete(responseId);
      const itemId = responseInputItemIds.get(responseId);
      responseInputItemIds.delete(responseId);
      if (itemId) consumeInputItem(itemId);
      return itemId;
    };

    const pushTranscriptEntry = (entry: RealtimeTranscriptEntry): void => {
      transcriptEntries.push(entry);
      // Long stretches without a capturing handoff must not grow the
      // retained transcript without bound: evict the oldest entries past a
      // fixed cap.
      while (transcriptEntries.length > MAX_RETAINED_TRANSCRIPT_ENTRIES) {
        transcriptEntries.shift();
      }
    };

    const appendTranscriptDelta = (
      role: RealtimeTranscriptEntry['role'],
      delta: string,
      forceNew: boolean,
    ): void => {
      if (!delta) return;
      const last = transcriptEntries.at(-1);
      if (!forceNew && last?.role === role) {
        last.text += delta;
        return;
      }
      pushTranscriptEntry({ role, text: delta });
    };

    const applyTranscriptDone = (
      role: RealtimeTranscriptEntry['role'],
      text: string,
      forceNew: boolean,
    ): void => {
      if (!text) return;
      const last = transcriptEntries.at(-1);
      if (!forceNew && last?.role === role) {
        last.text = text;
        return;
      }
      pushTranscriptEntry({ role, text });
    };

    const deliverDirectTranscript = (
      entries: readonly RealtimeTranscriptEntry[],
      responseId?: string,
      inputItemId?: string,
    ): void => {
      if (entries.length === 0) return;
      const copiedEntries = entries.map((entry) => ({ ...entry }));
      if (!callbacks.onDirectTranscript) {
        pendingDirectTranscriptEntries.push(...copiedEntries);
        return;
      }
      if (
        !callback(() =>
          callbacks.onDirectTranscript?.({
            ...eventContext(),
            ...(responseId ? { responseId } : {}),
            ...(inputItemId ? { inputItemId } : {}),
            entries: copiedEntries,
          }),
        )
      ) {
        pendingDirectTranscriptEntries.push(...copiedEntries);
      }
    };

    const collectDirectTranscript = (responseId: string): void => {
      if (
        collectedDirectResponseIds.has(responseId) ||
        responseAuthorities.get(responseId) !== 'direct' ||
        delegatedResponseIds.has(responseId)
      ) {
        return;
      }
      const inputItemId = responseInputItemIds.get(responseId);
      const input = inputItemId
        ? completedInputTranscripts.get(inputItemId)
        : undefined;
      const output = responseOutputText.get(responseId);
      const assistant = output?.audioTranscript || output?.text;
      const entries: RealtimeTranscriptEntry[] = [];
      if (inputItemId && input?.trim()) {
        collectedDirectInputItemIds.add(inputItemId);
        entries.push({ role: 'user', text: input });
      }
      if (assistant?.trim()) {
        entries.push({ role: 'assistant', text: assistant });
      }
      if (entries.length === 0) return;
      collectedDirectResponseIds.add(responseId);
      deliverDirectTranscript(entries, responseId, inputItemId);
    };

    const collectDialogueResponse = (
      responseId: string,
      interrupted = false,
    ): void => {
      if (
        audioSuppressedResponses.has(responseId) ||
        dialogueResponses.has(responseId) ||
        responseToolCapabilities.get(responseId) !== 'direct'
      )
        return;
      const inputItemId = responseInputItemIds.get(responseId);
      const output = responseOutputText.get(responseId);
      const text = [
        dialoguePrefixes.get(responseId),
        output?.audioTranscript || output?.text,
      ]
        .filter(Boolean)
        .join('\n');
      if (!inputItemId || !text) return;
      dialogueResponses.add(responseId);
      if (dialogueResponses.size > MAX_TRACKED_INPUT_ITEMS)
        dialogueResponses.delete(dialogueResponses.values().next().value!);
      callback(() =>
        callbacks.onDialogue?.({
          ...eventContext(),
          inputItemId,
          role: 'assistant',
          text,
          source:
            responseWithTools.has(responseId) && !interrupted
              ? 'filler'
              : 'normal',
          interrupted,
        }),
      );
    };

    const collectDialogueInput = (itemId: string, text: string): void => {
      if (dialogueInputs.has(itemId)) return;
      dialogueInputs.add(itemId);
      if (dialogueInputs.size > MAX_TRACKED_INPUT_ITEMS)
        dialogueInputs.delete(dialogueInputs.values().next().value!);
      callback(() =>
        callbacks.onDialogue?.({
          ...eventContext(),
          inputItemId: itemId,
          role: 'user',
          text,
        }),
      );
    };

    const takeTranscriptTail = (): readonly RealtimeTranscriptEntry[] => {
      for (const responseId of responseAuthorities.keys()) {
        collectDirectTranscript(responseId);
      }
      const delegatedInputItemIds = new Set(
        [...delegatedResponseIds]
          .map((responseId) => responseInputItemIds.get(responseId))
          .filter((itemId): itemId is string => itemId !== undefined),
      );
      for (const [itemId, text] of completedInputTranscripts) {
        if (
          collectedDirectInputItemIds.has(itemId) ||
          delegatedInputItemIds.has(itemId) ||
          !text.trim()
        ) {
          continue;
        }
        collectedDirectInputItemIds.add(itemId);
        deliverDirectTranscript([{ role: 'user', text }]);
      }
      return pendingDirectTranscriptEntries.splice(0).map((entry) => ({
        ...entry,
      }));
    };

    const takeHandoffTranscriptTail =
      (): readonly RealtimeTranscriptEntry[] => {
        const tail = transcriptEntries.map((entry) => ({ ...entry }));
        // Everything up to here has now been handed off and is never read
        // again; drop the consumed entries (instead of only advancing a
        // cursor) so retention and the dedup scan in takeHandoffTranscript
        // stay bounded by one capture window, not the whole call history.
        transcriptEntries.length = 0;
        return tail;
      };

    const updateResponseOutputText = (
      responseId: string,
      source: RealtimeOutputTextEvent['source'],
      text: string,
      done: boolean,
    ): void => {
      const current = responseOutputText.get(responseId) ?? {
        text: '',
        audioTranscript: '',
      };
      const key = source === 'audio_transcript' ? 'audioTranscript' : 'text';
      current[key] = done ? text : `${current[key]}${text}`;
      responseOutputText.set(responseId, current);
    };

    const takeHandoffTranscript = (
      input: string,
    ): readonly RealtimeTranscriptEntry[] => {
      const trimmed = input.trim();
      if (
        trimmed &&
        !transcriptEntries.some(
          (entry) => entry.role === 'user' && entry.text.trim() === trimmed,
        )
      ) {
        pushTranscriptEntry({ role: 'user', text: trimmed });
      }
      const transcript = takeHandoffTranscriptTail();
      newInputEntry = true;
      newOutputEntry = true;
      return transcript;
    };

    const bindResponseInput = (responseId: string): boolean => {
      if (responseInputItemIds.has(responseId)) return true;
      const boundInputItemIds = new Set(responseInputItemIds.values());
      const candidates = [...committedInputItemIds].filter(
        (itemId) =>
          !boundInputItemIds.has(itemId) && !consumedInputItemIds.has(itemId),
      );
      if (candidates.length > 1) {
        protocolError(
          'Realtime response could not be associated with one unique input.',
          'ambiguous_input_transcript',
        );
        return false;
      }
      const itemId = candidates[0];
      if (!itemId) return false;
      responseInputItemIds.set(responseId, itemId);
      return true;
    };

    const finalizeCancelledResponse = (responseId: string): void => {
      retireResponse(responseId);
      if (activeResponseId === responseId) clearResponseDoneTimer();
      if (!cancelledResponseIds.has(responseId)) {
        markResponseCancelled(responseId);
      }
      const authority =
        responseAuthorities.get(responseId) ??
        (activeResponseId === responseId
          ? activeResponseAuthority
          : undefined) ??
        'direct';
      const cancellationReason = cancelledResponseReasons.get(responseId);
      const responseInputItemId = responseInputItemIds.get(responseId);
      collectDialogueResponse(responseId, true);
      collectDirectTranscript(responseId);
      completePendingCallsForResponse(responseId, 'cancelled');
      consumeResponseInput(responseId);
      if (activeResponseId === responseId) {
        activeResponseId = undefined;
        activeResponseAuthority = undefined;
      }
      if (activeAudioResponseId === responseId) {
        activeAudioResponseId = undefined;
      }
      lastCompletedResponseId = responseId;
      cancelledResponseIds.delete(responseId);
      const notificationFailureReported =
        notificationResponses.get(responseId)?.failureReported;
      disposeNotificationResponse(responseId);
      if (!notificationFailureReported)
        callback(() =>
          callbacks.onResponseDone?.({
            ...eventContext(),
            responseId,
            ...(responseInputItemId
              ? { inputItemId: responseInputItemId }
              : {}),
            status: 'cancelled',
            authority,
            ...(cancellationReason ? { cancellationReason } : {}),
          }),
        );
      cancelledResponseReasons.delete(responseId);
      responseAuthorities.delete(responseId);
      responseToolCapabilities.delete(responseId);
      repairToolAllowlists.delete(responseId);
      delegatedResponseIds.delete(responseId);
      responseOutputText.delete(responseId);
      responsesWithAudio.delete(responseId);
      audioSuppressedResponses.delete(responseId);
      silentReceiptDrains.delete(responseId);
      responseAdmissionReceipts.delete(responseId);
      collectedDirectResponseIds.delete(responseId);
      queueMicrotask(flushResponseCreate);
    };

    const ignoreEvent = (
      message: ProviderMessage,
      type: string,
      reason: RealtimeIgnoredEvent['reason'],
    ) => {
      callback(() =>
        callbacks.onIgnoredEvent?.({
          ...eventContext(message),
          type,
          reason,
        }),
      );
    };

    const readResponseId = (
      message: ProviderMessage,
      fromResponseObject = false,
    ): string | undefined => {
      const response = isRecord(message['response'])
        ? message['response']
        : undefined;
      return optionalString(
        fromResponseObject ? response?.['id'] : message['response_id'],
      );
    };

    const isCurrentResponse = (
      message: ProviderMessage,
      type: string,
      responseId: string,
    ): boolean => {
      if (cancelledResponseIds.has(responseId)) {
        ignoreEvent(message, type, 'cancelled_response');
        return false;
      }
      if (activeResponseId !== responseId) {
        ignoreEvent(message, type, 'stale_response');
        return false;
      }
      return true;
    };

    const isProactiveRepairResponse = (responseId: string): boolean =>
      responseAuthorities.get(responseId) === 'proactive_repair';

    const commitInputItem = (
      message: ProviderMessage,
      type: string,
      itemId: string,
    ): void => {
      if (
        committedInputItemIds.has(itemId) ||
        consumedInputItemIds.has(itemId) ||
        rejectedInputItemIds.has(itemId)
      ) {
        pendingSpeechItemIds.delete(itemId);
        ignoreEvent(message, type, 'duplicate_event');
        return;
      }
      if (committedInputItemIds.size >= MAX_TRACKED_INPUT_ITEMS) {
        protocolError(
          'Realtime provider created too many pending input items.',
          'too_many_pending_inputs',
        );
        return;
      }
      pendingSpeechItemIds.delete(itemId);
      speechInputInProgress = false;
      speechCommitPending = false;
      if (!speechGenerationAdvancedForInput) speechGeneration += 1;
      speechGenerationAdvancedForInput = false;
      const activeDirectResponse =
        activeResponseId !== undefined &&
        activeResponseAuthority === 'direct' &&
        !cancelledResponseIds.has(activeResponseId);
      if (!activeDirectResponse) {
        directResponsePending = true;
      }
      lastCompletedResponseId = undefined;
      committedInputItemIds.add(itemId);
      recoveryInput.committed(itemId);
      // A committed real utterance can arrive without speech_started. It still
      // supersedes a notification; missing VAD metadata must not release old audio.
      retireNotificationItem('user_interrupted');
      if (
        pendingResponseCreate?.notificationItemId &&
        !pendingResponseCreate.cancelled
      ) {
        pendingResponseCreate.cancelled = true;
        pendingResponseCreate.cancellationReason = 'user_interrupted';
        clearResponseCreatedTimer();
        armCancellationGrace(
          pendingResponseCreate.authority,
          `unacknowledged-${pendingResponseCreate.requestId}`,
          pendingResponseCreate,
        );
      }
      if (
        activeResponseId &&
        notificationResponses.has(activeResponseId) &&
        !cancelledResponseIds.has(activeResponseId)
      ) {
        const interrupted = activeResponseId;
        callback(() =>
          callbacks.onBargeIn?.({
            ...eventContext(message),
            responseId: interrupted,
          }),
        );
        markResponseCancelled(interrupted, true, 'user_interrupted');
        sendJson({ type: 'response.cancel' });
        armCancellationGrace(activeResponseAuthority ?? 'direct', interrupted);
      }
      if (
        activeDirectResponse &&
        activeResponseId &&
        !bindResponseInput(activeResponseId)
      ) {
        return;
      }
      callback(() =>
        callbacks.onInputCommitted?.({
          ...eventContext(message),
          itemId,
          responsePending: !activeDirectResponse,
        }),
      );
      if (terminal) return;
      if (activeDirectResponse) {
        directResponsePending = false;
        if (activeResponseId) {
          responseToolCapabilities.set(activeResponseId, 'direct');
        }
      } else if (directResponsePending) {
        requestResponseCreate('direct', undefined, itemId);
      }
    };

    /**
     * Best-effort extraction of the user-request text from a tool-call
     * argument payload. Only used to augment the captured transcript for
     * `capturesTranscript` tools (ASR may lag behind the model's call); the
     * raw argument string is always handed to the orchestrator untouched.
     */
    const extractInputTranscript = (rawArguments: string): string => {
      if (rawArguments.length === 0) return '';
      try {
        const parsed = JSON.parse(rawArguments) as unknown;
        if (isRecord(parsed)) {
          for (const key of [
            'task',
            'input_transcript',
            'input',
            'text',
            'prompt',
            'query',
          ]) {
            const value = parsed[key];
            if (typeof value === 'string' && value.trim()) {
              return value.trim();
            }
          }
        }
      } catch {
        /* match the Codex V2 parser: use raw arguments when JSON is invalid */
      }
      return '';
    };

    const dispatchFunctionCall = (
      message: ProviderMessage,
      call: PendingFunctionCall,
      rawArguments: string,
    ): void => {
      if (call.dispatched) {
        if (call.arguments !== rawArguments) {
          protocolError(
            'Realtime model changed a function call after dispatch.',
            'ambiguous_handoff',
          );
        }
        return;
      }
      if (repairToolAllowlists.has(call.responseId)) {
        call.arguments = rawArguments;
        call.dispatched = true;
        call.repairDeferred = true;
        call.repairEventId = optionalString(message.event_id);
        return;
      }
      if (silentReceiptDrains.has(call.responseId)) {
        // A receipt-only response must terminate the protocol, not open an
        // unbounded sequence of generated calls. No tool from it may execute.
        requestRecovery(
          'silent_receipt_tool_loop',
          'tool_continuation',
          call.responseId,
        );
        return;
      }
      if (
        call.name === REMAIN_SILENT_TOOL_NAME &&
        responseAuthorities.get(call.responseId) !== 'peer_report' &&
        responseAuthorities.get(call.responseId) !== 'search_result' &&
        responseAuthorities.get(call.responseId) !== 'visual_result' &&
        responseAuthorities.get(call.responseId) !== 'permission' &&
        responseAuthorities.get(call.responseId) !== 'task_result'
      ) {
        call.arguments = rawArguments;
        call.dispatched = true;
        toolContinuationStates.set(call.responseId, {
          speechGeneration: call.speechGeneration,
          toolCapability: 'none',
          silentReceiptDrain: true,
        });
        queueFunctionCallOutput(call, '');
        return;
      }
      const toolCapability =
        responseToolCapabilities.get(call.responseId) ?? 'none';
      const tool = call.name ? toolsByName.get(call.name) : undefined;
      if (toolCapability !== 'direct') {
        call.arguments = rawArguments;
        call.dispatched = true;
        queueFunctionCallOutput(call, RESPONSE_TOOL_REJECTION_OUTPUT);
        return;
      }
      const admissionKey = taskRequestKey(call.name ?? '', rawArguments);
      const previousAdmission = admissionKey
        ? responseAdmissionReceipts.get(call.responseId)?.get(admissionKey)
        : undefined;
      if (tool && previousAdmission) {
        // A receipt continuation may echo the same request. Reuse its actual
        // admission, never create a second task behind a hidden confirmation.
        call.arguments = rawArguments;
        call.dispatched = true;
        call.reusedAdmission = true;
        toolContinuationStates.set(call.responseId, {
          speechGeneration: call.speechGeneration,
          toolCapability,
          inputItemId: responseInputItemIds.get(call.responseId),
          confirmation: call.confirmation,
        });
        queueFunctionCallOutput(
          call,
          previousAdmission.output,
          previousAdmission.options,
        );
        try {
          callbacks.onProtocolDebug?.({
            type: 'tool.duplicate_admission_reused',
            ...eventContext(message),
            responseId: identifier(call.responseId),
            callId: identifier(call.callId),
            toolName: call.name,
          });
        } catch {
          /* diagnostic only */
        }
        return;
      }
      responseWithTools.add(call.responseId);
      if (!tool) {
        // A tool the config never declared: answer with an error receipt so
        // the model can recover aloud instead of waiting on a call that no
        // handler will ever complete.
        call.arguments = rawArguments;
        call.dispatched = true;
        toolContinuationStates.set(call.responseId, {
          speechGeneration: call.speechGeneration,
          toolCapability,
          inputItemId: responseInputItemIds.get(call.responseId),
          confirmation: call.confirmation,
        });
        queueFunctionCallOutput(
          call,
          JSON.stringify({
            status: 'error',
            note: `Unknown tool: ${call.name ?? '(unnamed)'}`,
          }),
        );
        return;
      }
      call.arguments = rawArguments;
      call.dispatched = true;
      recoveryInput.dispatched(responseInputItemIds.get(call.responseId));
      if (tool.continuesResponse) {
        toolContinuationStates.set(call.responseId, {
          speechGeneration: call.speechGeneration,
          toolCapability,
          inputItemId: responseInputItemIds.get(call.responseId),
          confirmation: call.confirmation,
        });
      }
      let activeTranscript: readonly RealtimeTranscriptEntry[] = [];
      if (tool.capturesTranscript) {
        activeTranscript = takeHandoffTranscript(
          extractInputTranscript(rawArguments),
        );
        delegatedResponseIds.add(call.responseId);
      }
      callback(() =>
        callbacks.onFunctionCall?.({
          ...eventContext(message),
          responseId: call.responseId,
          inputItemId: responseInputItemIds.get(call.responseId),
          itemId: call.itemId,
          callId: call.callId,
          name: call.name ?? '',
          arguments: rawArguments,
          ...(responseInputItemIds.get(call.responseId) &&
          completedInputTranscripts.get(
            responseInputItemIds.get(call.responseId)!,
          )
            ? {
                inputTranscript: completedInputTranscripts.get(
                  responseInputItemIds.get(call.responseId)!,
                ),
              }
            : {}),
          activeTranscript,
        }),
      );
    };

    const dispatchCompletedRepairCalls = (responseId: string): void => {
      const allowlist = repairToolAllowlists.get(responseId);
      if (!allowlist) return;
      let authorizedCallDispatched = false;
      for (const call of pendingCalls.values()) {
        if (call.responseId !== responseId || !call.repairDeferred) continue;
        call.repairDeferred = false;
        const name = call.name ?? '';
        const authorized =
          !authorizedCallDispatched &&
          allowlist.has(name) &&
          toolsByName.has(name);
        if (!authorized) {
          queueFunctionCallOutput(call, PROACTIVE_REPAIR_REJECTION_OUTPUT);
          continue;
        }
        authorizedCallDispatched = true;
        toolContinuationStates.set(responseId, {
          speechGeneration: call.speechGeneration,
          toolCapability: 'none',
          confirmation: call.confirmation,
        });
        callback(() =>
          callbacks.onFunctionCall?.({
            ...eventContext(),
            ...(call.repairEventId ? { eventId: call.repairEventId } : {}),
            responseId,
            itemId: call.itemId,
            callId: call.callId,
            name,
            arguments: call.arguments,
            activeTranscript: [],
          }),
        );
        if (terminal) return;
      }
    };

    const dispatchFinalFunctionCalls = (
      message: ProviderMessage,
      responseId: string,
      response: Record<string, unknown>,
    ): void => {
      const output = Array.isArray(response['output'])
        ? response['output']
        : [];
      const valid: PendingFunctionCall[] = [];
      const finalIds = new Set<string>();
      let invalid = false;
      for (const item of output) {
        if (!isRecord(item) || item['type'] !== 'function_call') continue;
        const callId = optionalString(item['call_id']);
        const name = optionalString(item['name']);
        const args = optionalString(
          item['arguments'],
          QWEN_REALTIME_LIMITS.maxFunctionArgumentsChars,
        );
        const existing = callId ? pendingCalls.get(callId) : undefined;
        if (
          !callId ||
          !name ||
          args === undefined ||
          item['status'] !== 'completed' ||
          finalIds.has(callId) ||
          pendingFunctionOutputs.has(callId) ||
          (existing &&
            (existing.responseId !== responseId ||
              (existing.name !== undefined && existing.name !== name) ||
              existing.invalidCompletion ||
              (existing.argumentsFinal && existing.arguments !== args)))
        ) {
          invalid = true;
          continue;
        }
        finalIds.add(callId);
        const call: PendingFunctionCall = existing ?? {
          responseId,
          itemId: optionalString(item['id']),
          callId,
          arguments: args,
          dispatched: false,
          outputSubmitted: false,
          responseCompleted: false,
          speechGeneration,
        };
        call.name = name;
        call.arguments = args;
        call.argumentsFinal = true;
        pendingCalls.set(callId, call);
        valid.push(call);
      }
      for (const [callId, call] of pendingCalls) {
        if (call.responseId === responseId && !finalIds.has(callId)) {
          pendingCalls.delete(callId);
          invalid = true;
        }
      }
      if (
        invalid ||
        pendingCalls.size + pendingFunctionOutputs.size >
          QWEN_REALTIME_LIMITS.maxPendingFunctionCalls
      ) {
        // A contradictory/partial final must not execute any sibling operation.
        for (const call of valid) pendingCalls.delete(call.callId);
        toolContinuationStates.delete(responseId);
        notifyError(
          new QwenRealtimeError(
            'The final tool-call snapshot was incomplete or inconsistent. No tools from this response were executed.',
            'invalid_function_completion',
            false,
            { kind: 'protocol' },
          ),
        );
        return;
      }
      const confirmation: ToolConfirmationBatch = {
        parentHadAudio:
          responsesWithAudio.has(responseId) ||
          (audioSuppressedResponses.has(responseId) &&
            responseToolCapabilities.get(responseId) === 'direct'),
        admissionsOnly: true,
        duplicatesOnly: true,
        receipts: new Map(),
      };
      for (const call of valid) call.confirmation = confirmation;
      for (const call of valid) {
        dispatchFunctionCall(
          { ...message, event_id: call.argumentsEventId ?? message.event_id },
          call,
          call.arguments,
        );
        if (terminal || closedByClient) return;
      }
    };

    const canStartExternalSpeech = (): boolean =>
      ready &&
      !terminal &&
      !closedByClient &&
      !speechInputInProgress &&
      !speechCommitPending &&
      !directResponsePending &&
      !responseCreatedInProgress &&
      !pendingResponseCreate &&
      !pendingNotificationItem &&
      !activeResponseId &&
      !configurationDirty &&
      configurationUpdatesPending === 0 &&
      pendingCalls.size === 0 &&
      pendingFunctionOutputs.size === 0 &&
      toolContinuationStates.size === 0 &&
      responseCreateQueue.length === 0;

    const session: QwenRealtimeSession = {
      callEpoch: config.callEpoch,
      closed,
      canDeliverExternalAudio: canStartExternalSpeech,
      canStartExternalSpeech,
      flushDialogue: () => {
        if (activeResponseId) collectDialogueResponse(activeResponseId, true);
      },
      configure: (update) => {
        if (terminal || closedByClient) return false;
        const changed =
          JSON.stringify(effectiveTools) !== JSON.stringify(update.tools);
        effectiveTools = [...update.tools];
        toolsByName.clear();
        for (const tool of effectiveTools)
          toolsByName.set(tool.function.name, tool);
        configurationDirty ||= changed;
        return flushConfiguration();
      },
      pushAudio: (pcm16) => {
        if (pcm16.length === 0) return false;
        if (
          pcm16.length % 2 !== 0 ||
          pcm16.length > QWEN_REALTIME_LIMITS.maxInputAudioFrameBytes
        ) {
          throw new RangeError(
            'Realtime input must be a bounded PCM16 audio frame.',
          );
        }
        if (
          terminal ||
          closedByClient ||
          ws.readyState !== ws.OPEN ||
          (ws.bufferedAmount ?? 0) > QWEN_REALTIME_LIMITS.maxBufferedSocketBytes
        ) {
          if (!backpressureWarned) {
            backpressureWarned = true;
            callback(() => callbacks.onAudioDropped?.(eventContext()));
          }
          return false;
        }
        backpressureWarned = false;
        const sent = sendJson({
          type: 'input_audio_buffer.append',
          audio: Buffer.from(pcm16).toString('base64'),
        });
        if (sent) {
          hasSentInputAudio = true;
          recoveryInput.audio(pcm16);
        }
        return sent;
      },
      resumeUserText: (input) => {
        if (terminal || closedByClient || !input.text.trim()) return false;
        if (
          !sendJson({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: input.text }],
            },
          })
        )
          return false;
        recoveryInput.restored(input.itemId, input.text);
        committedInputItemIds.add(input.itemId);
        completedInputTranscripts.set(input.itemId, input.text);
        dialogueInputs.add(input.itemId);
        pushTranscriptEntry({ role: 'user', text: input.text });
        directResponsePending = true;
        return requestResponseCreate('direct', undefined, input.itemId);
      },
      finishRecoveredAudio: () => {
        if (!hasSentInputAudio) return false;
        const sent = sendJson({
          type: 'input_audio_buffer.append',
          audio: MUTED_INPUT_HEARTBEAT_AUDIO,
        });
        if (sent) {
          recoveryInput.protocolSilence(QWEN_REALTIME_INPUT_SAMPLE_RATE * 2);
          try {
            callbacks.onProtocolDebug?.({
              type: 'recovery.audio_tail',
              ...eventContext(),
              bytes: 32_000,
              durationMs: 1000,
              origin: 'protocol_silence',
            });
          } catch {
            /* diagnostic only */
          }
        }
        return sent;
      },
      setInputMuted: (muted) => {
        if (terminal || closedByClient || inputMuted === muted) return;
        inputMuted = muted;
        clearInputHeartbeat();
        if (!muted) return;
        inputHeartbeatTimer = setInterval(
          sendMutedInputHeartbeat,
          MUTED_INPUT_HEARTBEAT_INTERVAL_MS,
        );
        inputHeartbeatTimer.unref?.();
      },
      pushImage: (jpegBase64) => {
        if (!isBoundedJpegBase64(jpegBase64)) {
          throw new RangeError(
            'Realtime image input must be a bounded JPEG base64 frame.',
          );
        }
        if (!hasSentInputAudio) return dropImage('audio_not_started');
        if (terminal || closedByClient || ws.readyState !== ws.OPEN) {
          return dropImage('connection_unavailable');
        }
        if (
          (ws.bufferedAmount ?? 0) > QWEN_REALTIME_LIMITS.maxBufferedSocketBytes
        ) {
          return dropImage('socket_backpressure');
        }
        return sendJson({
          type: 'input_image_buffer.append',
          image: jpegBase64,
        });
      },
      commitInputAudio: () => sendJson({ type: 'input_audio_buffer.commit' }),
      clearInputAudio: () => {
        const sent = sendJson({ type: 'input_audio_buffer.clear' });
        if (sent) {
          speechInputInProgress = false;
          speechCommitPending = false;
          speechGenerationAdvancedForInput = false;
          directResponsePending = false;
          pendingSpeechItemIds.clear();
        }
        return sent;
      },
      cancelResponse: () => {
        if (!activeResponseId || cancelledResponseIds.has(activeResponseId)) {
          return false;
        }
        const responseId = activeResponseId;
        const inputItemId = responseInputItemIds.get(responseId);
        if (inputItemId) recoveryInput.completed(inputItemId);
        collectDialogueResponse(responseId, true);
        collectDirectTranscript(responseId);
        clearResponseDoneTimer();
        markResponseCancelled(responseId, true, 'client_cancelled');
        const sent = sendJson({ type: 'response.cancel' });
        armCancellationGrace(activeResponseAuthority ?? 'direct', responseId);
        return sent;
      },
      submitFunctionOutput: (ref, output, options) => {
        const call = pendingCalls.get(ref.callId);
        if (
          ref.callEpoch !== config.callEpoch ||
          !call ||
          !call.dispatched ||
          call.outputSubmitted ||
          terminal ||
          closedByClient
        ) {
          callback(() =>
            callbacks.onIgnoredEvent?.({
              ...eventContext(),
              type: 'conversation.item.create',
              reason: 'stale_call',
            }),
          );
          return false;
        }
        if (
          typeof output !== 'string' ||
          output.trim().length === 0 ||
          output.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime function output exceeded the allowed size.',
          );
        }
        return queueFunctionCallOutput(call, output, options);
      },
      sendBackendContext: (text) => {
        if (
          typeof text !== 'string' ||
          text.trim().length === 0 ||
          text.length > QWEN_REALTIME_LIMITS.maxContextChars
        ) {
          throw new RangeError(
            'Realtime backend context exceeded the allowed size.',
          );
        }
        if (terminal || closedByClient) return false;
        return sendBackendConversationItem(text);
      },
      speakToUser: (message) => {
        if (
          typeof message !== 'string' ||
          message.trim().length === 0 ||
          message.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime speech request exceeded the allowed size.',
          );
        }
        if (terminal || closedByClient) return false;
        return requestResponseCreate('backend_speech', message);
      },
      askPermission: (message, language) => {
        if (
          typeof message !== 'string' ||
          message.trim().length === 0 ||
          message.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime permission request exceeded the allowed size.',
          );
        }
        if (terminal || closedByClient) return false;
        return requestResponseCreate(
          'permission',
          message,
          undefined,
          undefined,
          'none',
          language,
        );
      },
      respondToTaskResult: (message, language) => {
        if (
          typeof message !== 'string' ||
          message.trim().length === 0 ||
          message.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime task result exceeded the allowed size.',
          );
        }
        if (terminal || closedByClient) return false;
        return requestResponseCreate(
          'task_result',
          message,
          undefined,
          undefined,
          'none',
          language,
        );
      },
      speakPeerReport: (message, language) => {
        if (
          typeof message !== 'string' ||
          message.trim().length === 0 ||
          message.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime peer report exceeded the allowed size.',
          );
        }
        if (terminal || closedByClient) return false;
        return requestResponseCreate(
          'peer_report',
          message,
          undefined,
          undefined,
          'none',
          language,
        );
      },
      respondToSearchResult: (message, language) => {
        if (
          typeof message !== 'string' ||
          message.trim().length === 0 ||
          message.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars ||
          notificationContext('search_result', message, language).length >
            QWEN_REALTIME_LIMITS.maxContextChars
        )
          throw new RangeError(
            'Realtime search result exceeded the allowed size.',
          );
        if (terminal || closedByClient) return false;
        return requestResponseCreate(
          'search_result',
          message,
          undefined,
          undefined,
          'none',
          language,
        );
      },
      respondToVisualResult: (message, language) => {
        if (
          typeof message !== 'string' ||
          !message.trim() ||
          message.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars ||
          notificationContext('visual_result', message, language).length >
            QWEN_REALTIME_LIMITS.maxContextChars
        )
          throw new RangeError(
            'Realtime visual result exceeded the allowed size.',
          );
        if (terminal || closedByClient) return false;
        return requestResponseCreate(
          'visual_result',
          message,
          undefined,
          undefined,
          'none',
          language,
        );
      },
      respondToProactiveEvent: (event) => {
        if (
          typeof event !== 'string' ||
          event.trim().length === 0 ||
          event.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime Proactive event exceeded the allowed size.',
          );
        }
        if (terminal || closedByClient) return false;
        // Injector owns Proactive retry/FIFO ordering. Never admit one into
        // Realtime's private response queue: queued requests can be discarded
        // by a later speech_started event without a response.done callback,
        // which would leave Injector waiting forever for that delivery.
        if (
          responseCreatedInProgress ||
          directResponsePending ||
          pendingResponseCreate !== undefined ||
          pendingNotificationItem !== undefined ||
          activeResponseId !== undefined ||
          toolContinuationStates.size > 0 ||
          responseCreateQueue.length > 0
        ) {
          return false;
        }
        return requestResponseCreate('proactive', event);
      },
      requestProactiveRepair: (instruction, allowedToolNames) => {
        if (
          typeof instruction !== 'string' ||
          instruction.trim().length === 0 ||
          instruction.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime Proactive repair instruction exceeded the allowed size.',
          );
        }
        const allowlist = new Set(allowedToolNames);
        if (
          allowlist.size === 0 ||
          allowlist.size > QWEN_REALTIME_LIMITS.maxPendingFunctionCalls ||
          [...allowlist].some(
            (name) =>
              typeof name !== 'string' ||
              name.length === 0 ||
              name.length > QWEN_REALTIME_LIMITS.maxIdentifierChars ||
              !toolsByName.has(name),
          )
        ) {
          throw new RangeError(
            'Realtime Proactive repair tools must be a bounded allowlist of declared tools.',
          );
        }
        if (
          terminal ||
          closedByClient ||
          speechInputInProgress ||
          speechCommitPending ||
          directResponsePending ||
          pendingResponseCreate !== undefined ||
          pendingNotificationItem !== undefined ||
          activeResponseId !== undefined ||
          toolContinuationStates.size > 0 ||
          responseCreateQueue.length > 0
        ) {
          return false;
        }
        return requestResponseCreate(
          'proactive_repair',
          instruction,
          undefined,
          allowlist,
        );
      },
      takeTranscriptTail,
      close: (options) => {
        if (closedByClient || terminal) return;
        if (!options?.discardPendingInput) {
          const inputLossError = pendingInputLossError();
          if (inputLossError) {
            fail(inputLossError);
            return;
          }
        }
        closedByClient = true;
        recoveryInput.clear();
        if (activeResponseId) collectDialogueResponse(activeResponseId, true);
        clearConnectTimer();
        clearResponseTimers();
        clearInputHeartbeat();
        removeAbortListener();
        closeSocket();
        settleClosed({ reason: 'client' });
      },
    };

    const sendSessionUpdate = () => {
      if (sessionUpdateSent) return;
      sessionUpdateSent = true;
      sendJson({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          smooth_output: false,
          ...(config.voice ? { voice: config.voice } : {}),
          audio: {
            input: {
              format: {
                type: 'pcm',
                sample_rate: QWEN_REALTIME_INPUT_SAMPLE_RATE,
              },
            },
            output: {
              format: {
                type: 'pcm',
                sample_rate: QWEN_REALTIME_OUTPUT_SAMPLE_RATE,
              },
            },
          },
          input_audio_transcription: {
            model: 'qwen3-asr-flash-realtime',
          },
          instructions: effectiveInstructions,
          turn_detection: {
            type: 'semantic_vad',
            create_response: false,
            interrupt_response: true,
          },
          // Strip local-only behavior flags from the wire shape.
          tools: effectiveTools.map((tool) => ({
            type: tool.type,
            function: tool.function,
          })),
          tool_choice: 'auto',
        },
      });
    };

    const disposeNotificationResponse = (responseId: string): void => {
      const notification = notificationResponses.get(responseId);
      if (notification?.timer) clearTimeout(notification.timer);
      notificationResponses.delete(responseId);
    };

    const rejectNotificationResponse = (
      responseId: string,
      reason: string,
    ): void => {
      const notification = notificationResponses.get(responseId);
      if (!notification || notification.state === 'rejected') return;
      if (notification.timer) clearTimeout(notification.timer);
      notification.timer = undefined;
      notification.state = 'rejected';
      const done = notification.queued.find(
        (entry) => entry.type === 'response.done',
      );
      notification.queued = [];
      notification.queuedBytes = 0;
      notificationDiagnostic(
        'notification.response_unverified',
        notification.request,
        {
          responseId,
          firstOutputItemId: notification.firstOutputItemId,
          reason,
        },
      );
      // Release the caller's delivery queue, but keep the server response fenced
      // until its terminal event. Never guess that a different task was delivered.
      notification.failureReported = true;
      callback(() =>
        callbacks.onResponseDone?.({
          ...eventContext(),
          responseId,
          authority: notification.request.authority,
          status: 'failed',
        }),
      );
      if (done) processProviderMessage(done.message, done.type, true);
    };

    const verifyNotificationResponse = (responseId: string): void => {
      const notification = notificationResponses.get(responseId);
      if (
        !notification ||
        notification.state !== 'pending' ||
        !notification.firstOutputItemId
      )
        return;
      const expected = notification.request.notificationItemId!;
      const expectedOrder = conversationItems.get(expected)?.order;
      let itemId: string | null | undefined = notification.firstOutputItemId;
      const visited = new Set<string>();
      while (itemId !== expected) {
        if (itemId === null || (itemId && visited.has(itemId))) {
          rejectNotificationResponse(responseId, 'different_ancestry');
          return;
        }
        if (!itemId) return;
        visited.add(itemId);
        if (visited.size > 32) {
          rejectNotificationResponse(responseId, 'ancestry_limit');
          return;
        }
        const item = conversationItems.get(itemId);
        if (!item) return;
        if (item.userMedia) {
          rejectNotificationResponse(responseId, 'intervening_user_media');
          return;
        }
        if (expectedOrder !== undefined && item.order < expectedOrder) {
          rejectNotificationResponse(responseId, 'older_item_ancestry');
          return;
        }
        itemId = item.previous;
      }
      notification.state = 'verified';
      if (notification.timer) clearTimeout(notification.timer);
      notification.timer = undefined;
      notificationDiagnostic(
        'notification.response_verified',
        notification.request,
        {
          responseId,
          firstOutputItemId: notification.firstOutputItemId,
        },
      );
      const response = isRecord(notification.created['response'])
        ? notification.created['response']
        : undefined;
      if (
        !callback(() =>
          callbacks.onResponseCreated?.({
            ...eventContext(notification.created),
            responseId,
            authority: notification.request.authority,
            status: optionalString(response?.['status']),
          }),
        )
      )
        return;
      const queued = notification.queued;
      notification.queued = [];
      notification.queuedBytes = 0;
      for (const entry of queued) {
        if (
          terminal ||
          closedByClient ||
          activeResponseId !== responseId ||
          cancelledResponseIds.has(responseId)
        )
          break;
        processProviderMessage(entry.message, entry.type, true);
      }
    };

    const observeNotificationProvenance = (
      message: ProviderMessage,
      type: string,
    ): void => {
      const item = isRecord(message['item']) ? message['item'] : undefined;
      if (type === 'conversation.item.created' && item) {
        const itemId = identifier(item['id']);
        if (itemId) {
          const previous =
            message['previous_item_id'] === null
              ? null
              : identifier(message['previous_item_id']);
          const existing = conversationItems.get(itemId);
          conversationItems.set(itemId, {
            ...existing,
            order: existing?.order ?? ++conversationItemOrder,
            ...(previous !== undefined ? { previous } : {}),
            ...(item['role'] === 'user' &&
            Array.isArray(item['content']) &&
            item['content'].some(
              (part) =>
                isRecord(part) &&
                ['input_audio', 'input_image'].includes(String(part['type'])),
            )
              ? { userMedia: true }
              : {}),
          });
          while (conversationItems.size > MAX_RECENT_EVENT_IDS)
            conversationItems.delete(conversationItems.keys().next().value!);
          for (const responseId of notificationResponses.keys())
            verifyNotificationResponse(responseId);
        }
      }
      const responseId =
        readResponseId(message, type === 'response.done') ??
        readResponseId(message) ??
        (type === 'response.done' ? activeResponseId : undefined);
      if (!responseId) return;
      const notification = notificationResponses.get(responseId);
      if (!notification || notification.state !== 'pending') return;
      let itemId = identifier(item?.['id'] ?? message['item_id']);
      if (type === 'response.done') {
        const response = isRecord(message['response'])
          ? message['response']
          : undefined;
        const first = Array.isArray(response?.['output'])
          ? response['output'][0]
          : undefined;
        itemId = isRecord(first) ? identifier(first['id']) : itemId;
      }
      if (
        itemId &&
        (message['output_index'] === undefined || message['output_index'] === 0)
      )
        notification.firstOutputItemId ??= itemId;
      verifyNotificationResponse(responseId);
    };

    const processProviderMessage = (
      message: ProviderMessage,
      type: string,
      replayed = false,
    ): void => {
      if (terminal || closedByClient) return;
      if (type === 'session.created' || type === 'session.updated') {
        const providerSession = isRecord(message['session'])
          ? message['session']
          : undefined;
        // Keep the exact safe identifier; do not manufacture a truncated or
        // sanitized ID that the provider's support team cannot look up.
        providerSessionId =
          identifier(providerSession?.['id']) ?? providerSessionId;
      }
      if (!replayed) protocolDebug(message, type);
      if (!replayed) observeNotificationProvenance(message, type);
      const outputResponseId =
        readResponseId(message, type === 'response.done') ??
        readResponseId(message) ??
        (type === 'response.done' ? activeResponseId : undefined);
      const notification = outputResponseId
        ? notificationResponses.get(outputResponseId)
        : undefined;
      if (
        !replayed &&
        notification &&
        type.startsWith('response.') &&
        type !== 'response.created'
      ) {
        if (notification.state === 'pending') {
          const bytes = Buffer.byteLength(JSON.stringify(message));
          if (
            notification.queuedBytes + bytes >
            MAX_NOTIFICATION_QUARANTINE_BYTES
          ) {
            rejectNotificationResponse(outputResponseId!, 'quarantine_limit');
            if (type !== 'response.done') return;
          } else {
            notification.queuedBytes += bytes;
            notification.queued.push({ message, type });
            return;
          }
        }
        if (notification.state === 'rejected' && type !== 'response.done')
          return;
      }
      switch (type) {
        case 'session.created': {
          sendSessionUpdate();
          break;
        }
        case 'session.updated': {
          const providerSession = isRecord(message['session'])
            ? message['session']
            : undefined;
          const audio = providerSession?.['audio'];
          const output = isRecord(audio) ? audio['output'] : undefined;
          const format = isRecord(output) ? output['format'] : undefined;
          const acknowledgedRate = isRecord(format)
            ? format['sample_rate']
            : undefined;
          if (
            acknowledgedRate !== undefined &&
            acknowledgedRate !== QWEN_REALTIME_OUTPUT_SAMPLE_RATE
          ) {
            fail(
              new QwenRealtimeError(
                `Realtime provider did not accept the requested ${QWEN_REALTIME_OUTPUT_SAMPLE_RATE} Hz output audio format.`,
                'output_sample_rate_mismatch',
                true,
                { kind: 'configuration' },
              ),
            );
            break;
          }
          if (configurationUpdatesPending > 0) configurationUpdatesPending -= 1;
          if (ready) {
            queueMicrotask(flushResponseCreate);
            break;
          }
          ready = true;
          clearConnectTimer();
          if (!callback(() => callbacks.onReady?.(eventContext(message)))) {
            break;
          }
          settled = true;
          resolve(session);
          break;
        }
        case 'input_audio_buffer.speech_started': {
          const deferNotifications = hasToolReceiptBarrier();
          const itemId = optionalString(message['item_id']);
          if (itemId && rejectedInputItemIds.has(itemId)) {
            ignoreEvent(message, type, 'stale_input');
            break;
          }
          if (itemId)
            recoveryInput.speech(
              itemId,
              optionalFiniteNumber(message['audio_start_ms']),
            );
          const supersededInputItemIds = new Set<string>();
          pendingSpeechItemIds.clear();
          if (itemId) pendingSpeechItemIds.add(itemId);
          newInputEntry = true;
          speechInputInProgress = true;
          speechCommitPending = true;
          directResponsePending = true;
          if (!speechGenerationAdvancedForInput) {
            speechGeneration += 1;
            speechGenerationAdvancedForInput = true;
          }
          retireNotificationItem('user_interrupted');
          const pendingReceiptContinuations: ResponseCreateRequest[] = [];
          const pendingNotifications: ResponseCreateRequest[] = [];
          for (const request of responseCreateQueue) {
            if (request.cancelled) continue;
            if (request.authority === 'tool_continuation') {
              pendingReceiptContinuations.push({
                ...request,
                speechGeneration,
                inputItemId: undefined,
                toolCapability: 'none',
                suppressAudio: true,
              });
              continue;
            }
            if (request.authority === 'direct' && request.inputItemId) {
              supersededInputItemIds.add(request.inputItemId);
            }
            if (
              request.speechMessage !== undefined &&
              request.authority !== 'peer_report' &&
              request.authority !== 'search_result' &&
              request.authority !== 'visual_result'
            ) {
              if (deferNotifications) {
                // Keep these facts out of a silent receipt response. The new
                // direct turn goes first; this notification is injected only
                // when its own response can be requested afterward.
                pendingNotifications.push({ ...request, speechGeneration });
              } else {
                sendBackendConversationItem(
                  responseMessage(request),
                  REALTIME_MERGED_SPEECH_PREFIX,
                );
              }
            }
          }
          responseCreateQueue = [
            ...pendingReceiptContinuations,
            ...pendingNotifications,
          ];
          if (pendingResponseCreate) {
            if (
              pendingResponseCreate.authority === 'direct' &&
              pendingResponseCreate.inputItemId
            ) {
              supersededInputItemIds.add(pendingResponseCreate.inputItemId);
            }
            pendingResponseCreate.cancelled = true;
            pendingResponseCreate.cancellationReason = 'user_interrupted';
            clearResponseCreatedTimer();
            armCancellationGrace(
              pendingResponseCreate.authority,
              `unacknowledged-${pendingResponseCreate.requestId}`,
              pendingResponseCreate,
            );
          }
          for (const supersededInputItemId of supersededInputItemIds) {
            consumeInputItem(supersededInputItemId);
          }
          if (
            !callback(() =>
              callbacks.onSpeechStarted?.({
                ...eventContext(message),
                itemId,
                audioStartMs: optionalFiniteNumber(message['audio_start_ms']),
              }),
            )
          ) {
            break;
          }
          if (activeResponseId && !cancelledResponseIds.has(activeResponseId)) {
            const interruptedResponseId = activeResponseId;
            collectDialogueResponse(interruptedResponseId, true);
            callback(() =>
              callbacks.onBargeIn?.({
                ...eventContext(message),
                responseId: interruptedResponseId,
              }),
            );
            markResponseCancelled(
              interruptedResponseId,
              true,
              'user_interrupted',
            );
            armCancellationGrace(
              activeResponseAuthority ?? 'direct',
              interruptedResponseId,
            );
          }
          break;
        }
        case 'input_audio_buffer.speech_stopped': {
          const itemId = optionalString(message['item_id']);
          if (itemId && rejectedInputItemIds.has(itemId)) {
            ignoreEvent(message, type, 'stale_input');
            break;
          }
          recoveryInput.stopped(itemId);
          speechInputInProgress = false;
          callback(() =>
            callbacks.onSpeechStopped?.({
              ...eventContext(message),
              itemId,
              audioEndMs: optionalFiniteNumber(message['audio_end_ms']),
            }),
          );
          break;
        }
        case 'conversation.item.created': {
          const item = isRecord(message['item']) ? message['item'] : undefined;
          if (item) acknowledgeNotificationItem(item);
          if (item?.['type'] === 'function_call_output') {
            const callId = optionalString(item['call_id']);
            const pending = callId
              ? pendingFunctionOutputs.get(callId)
              : undefined;
            if (pending && item['status'] === 'completed') {
              if (pending.timer) clearTimeout(pending.timer);
              pendingFunctionOutputs.delete(pending.call.callId);
              maybeRequestToolContinuation(pending.call.responseId);
              queueMicrotask(flushResponseCreate);
            }
            break;
          }
          // Semantic VAD can create the user audio item while the person is
          // still speaking. Creation is not acceptance of the completed turn;
          // only input_audio_buffer.committed may schedule its response.
          break;
        }
        case 'input_audio_buffer.committed': {
          const itemId = optionalString(message['item_id']);
          if (!itemId) {
            protocolError(
              'Realtime committed input omitted its identifier.',
              'invalid_input_item',
            );
            break;
          }
          commitInputItem(message, type, itemId);
          break;
        }
        case 'conversation.item.input_audio_transcription.delta':
        case 'conversation.item.input_audio_transcription.text': {
          const itemId = optionalString(message['item_id']);
          if (itemId && rejectedInputItemIds.has(itemId)) {
            ignoreEvent(message, type, 'stale_input');
            break;
          }
          const text = optionalString(
            message['text'] ?? message['delta'] ?? '',
            QWEN_REALTIME_LIMITS.maxTranscriptChars,
          );
          const stash = optionalString(
            message['stash'] ?? '',
            QWEN_REALTIME_LIMITS.maxTranscriptChars,
          );
          if (
            text === undefined ||
            stash === undefined ||
            text.length + stash.length > QWEN_REALTIME_LIMITS.maxTranscriptChars
          ) {
            protocolError(
              'Realtime input transcript exceeded the allowed size.',
              'transcript_too_large',
            );
            break;
          }
          const transcriptText = `${text}${stash}`;
          if (type === 'conversation.item.input_audio_transcription.delta') {
            appendTranscriptDelta('user', transcriptText, newInputEntry);
          } else {
            applyTranscriptDone('user', transcriptText, newInputEntry);
          }
          newInputEntry = false;
          callback(() =>
            callbacks.onInputTranscriptDelta?.({
              ...eventContext(message),
              itemId,
              text: `${text}${stash}`,
              stash,
              language: optionalString(message['language']),
              emotion: optionalString(message['emotion']),
            }),
          );
          break;
        }
        case 'conversation.item.input_audio_transcription.completed': {
          const itemId = optionalString(message['item_id']);
          if (itemId && rejectedInputItemIds.has(itemId)) {
            ignoreEvent(message, type, 'stale_input');
            break;
          }
          if (itemId && consumedInputItemIds.has(itemId)) {
            const transcript = optionalString(
              message['transcript'],
              QWEN_REALTIME_LIMITS.maxTranscriptChars,
            );
            if (transcript !== undefined)
              collectDialogueInput(itemId, transcript);
            // A benign late final: barge-in or response.done already consumed
            // this input before the ASR stream delivered its transcript. Drop
            // it instead of treating a healthy call as a protocol violation.
            ignoreEvent(message, type, 'stale_input');
            break;
          }
          if (!itemId || !committedInputItemIds.has(itemId)) {
            protocolError(
              'Realtime final transcript had no committed input item.',
              'unattributed_final_transcript',
            );
            break;
          }
          const transcript = optionalString(
            message['transcript'],
            QWEN_REALTIME_LIMITS.maxTranscriptChars,
          );
          if (transcript === undefined) {
            protocolError(
              'Realtime input transcript exceeded the allowed size.',
              'transcript_too_large',
            );
            break;
          }
          if (!rememberCompletedInputTranscript(itemId, transcript)) break;
          recoveryInput.transcript(itemId, transcript);
          collectDialogueInput(itemId, transcript);
          applyTranscriptDone('user', transcript, newInputEntry);
          newInputEntry = false;
          callback(() =>
            callbacks.onInputTranscriptDone?.({
              ...eventContext(message),
              itemId,
              text: transcript,
            }),
          );
          break;
        }
        case 'conversation.item.input_audio_transcription.failed': {
          const itemId = optionalString(message['item_id']);
          if (itemId && rejectedInputItemIds.has(itemId)) {
            ignoreEvent(message, type, 'stale_input');
            break;
          }
          if (
            itemId &&
            (committedInputItemIds.has(itemId) ||
              consumedInputItemIds.has(itemId))
          )
            collectDialogueInput(itemId, '');
          const error = isRecord(message['error'])
            ? message['error']
            : undefined;
          const inputLossError = pendingInputLossError();
          if (inputLossError) {
            fail(inputLossError);
          } else {
            notifyError(
              new QwenRealtimeError(
                sanitizeErrorText(
                  error?.['message'] ??
                    error?.['code'] ??
                    'Realtime input transcription failed.',
                  config.apiKey,
                ),
                optionalString(error?.['code']),
                false,
              ),
            );
          }
          break;
        }
        case 'response.created': {
          const responseId = readResponseId(message, true);
          if (!responseId) {
            protocolError(
              'Realtime response omitted its identifier.',
              'invalid_response',
            );
            break;
          }
          if (
            retiredResponseIds.has(responseId) ||
            cancelledResponseIds.has(responseId)
          ) {
            ignoreEvent(message, type, 'stale_response');
            break;
          }
          responseCreatedInProgress = true;
          try {
            let responseRequest = pendingResponseCreate;
            if (
              !responseRequest &&
              (pendingNotificationItem || hasNotificationHistory) &&
              ![...committedInputItemIds].some(
                (id) => !consumedInputItemIds.has(id),
              ) &&
              !(
                activeResponseId &&
                responseToolCapabilities.get(activeResponseId) === 'direct'
              )
            ) {
              // An unsolicited late receipt cannot borrow a newly queued result
              // or become an audible direct answer without a real user turn.
              responseRequest = {
                requestId: randomUUID(),
                authority: 'tool_continuation',
                speechGeneration,
                cancelled: false,
                toolCapability: 'none',
                suppressAudio: true,
                silentReceiptDrain: true,
              };
              notificationDiagnostic(
                'notification.unowned_response_drained',
                responseRequest,
                { responseId },
              );
            }
            let splitResponseInputItemId: string | undefined;
            let splitDialogueText: string | undefined;
            let splitSuppressAudio = false;
            let splitSilentReceiptDrain = false;
            let splitAdmissionReceipts:
              ReadonlyMap<string, AdmissionReceipt> | undefined;
            let supersededResponseId: string | undefined;
            if (activeResponseId && activeResponseId !== responseId) {
              supersededResponseId = activeResponseId;
              const supersededInputItemId =
                responseInputItemIds.get(supersededResponseId);
              if (
                responseRequest === undefined &&
                !cancelledResponseIds.has(supersededResponseId)
              ) {
                const boundInputItemIds = new Set(
                  responseInputItemIds.values(),
                );
                const hasNewUnboundInput = [...committedInputItemIds].some(
                  (itemId) =>
                    itemId !== supersededInputItemId &&
                    !boundInputItemIds.has(itemId),
                );
                if (!hasNewUnboundInput) {
                  // A provider-created segment remains in the same receipt
                  // lane: splitting must not unmute it, rerun an admission or
                  // turn a protocol-only drain into an executable tool turn.
                  splitSuppressAudio =
                    audioSuppressedResponses.has(supersededResponseId) ||
                    isProactiveRepairResponse(supersededResponseId);
                  splitSilentReceiptDrain =
                    silentReceiptDrains.has(supersededResponseId);
                  splitAdmissionReceipts =
                    responseAdmissionReceipts.get(supersededResponseId);
                  if (
                    responseToolCapabilities.get(supersededResponseId) ===
                      'direct' &&
                    supersededInputItemId !== undefined
                  ) {
                    // Providers can split a real user turn, including a tool
                    // continuation whose original microphone input is already
                    // consumed. Only an existing verified capability transfers.
                    splitResponseInputItemId = supersededInputItemId;
                    const priorOutput =
                      responseOutputText.get(supersededResponseId);
                    splitDialogueText = [
                      dialoguePrefixes.get(supersededResponseId),
                      priorOutput?.audioTranscript || priorOutput?.text,
                    ]
                      .filter(Boolean)
                      .join('\n');
                    responseInputItemIds.delete(supersededResponseId);
                  }
                }
              }
              clearResponseDoneTimer();
              markResponseCancelled(supersededResponseId, false, 'superseded');
            }
            clearResponseCreatedTimer();
            if (cancellationTimer !== undefined)
              clearTimeout(cancellationTimer);
            cancellationTimer = undefined;
            cancellationTarget = undefined;
            const responseAuthority: RealtimeResponseAuthority =
              responseRequest?.authority ?? 'direct';
            activeResponseId = responseId;
            activeResponseAuthority = responseAuthority;
            responseAuthorities.set(responseId, responseAuthority);
            const admissionReceipts =
              responseRequest?.admissionReceipts ?? splitAdmissionReceipts;
            if (admissionReceipts?.size) {
              responseAdmissionReceipts.set(responseId, admissionReceipts);
            }
            if (responseRequest?.suppressAudio || splitSuppressAudio) {
              audioSuppressedResponses.add(responseId);
              try {
                callbacks.onProtocolDebug?.({
                  type: 'tool.confirmation_audio_suppressed',
                  ...eventContext(message),
                  responseId,
                  authority: responseAuthority,
                });
              } catch {
                /* diagnostic only */
              }
            }
            if (responseRequest?.silentReceiptDrain || splitSilentReceiptDrain)
              silentReceiptDrains.add(responseId);
            if (splitDialogueText)
              dialoguePrefixes.set(responseId, splitDialogueText);
            newOutputEntry = true;
            pendingResponseCreate = undefined;
            activeAudioResponseId = undefined;
            if (responseRequest) {
              armResponseDoneTimer(responseRequest, responseId);
            }
            // Register the replacement before notifying observers that the
            // prior response ended. Those callbacks may synchronously enqueue
            // another response, which must queue behind this provider-created
            // response instead of being mistaken for it.
            if (supersededResponseId) {
              finalizeCancelledResponse(supersededResponseId);
              if (terminal || closedByClient) break;
            }
            if (responseRequest?.cancelled) {
              markResponseCancelled(
                responseId,
                true,
                responseRequest.cancellationReason ?? 'superseded',
              );
              sendJson({ type: 'response.cancel' });
              armCancellationGrace(responseAuthority, responseId);
              break;
            }
            if (
              responseAuthority === 'proactive_repair' &&
              responseRequest?.repairAllowedToolNames
            ) {
              repairToolAllowlists.set(
                responseId,
                responseRequest.repairAllowedToolNames,
              );
            }
            if (
              responseAuthority === 'tool_continuation' &&
              responseRequest?.toolCapability === 'direct' &&
              responseRequest.inputItemId
            ) {
              responseInputItemIds.set(responseId, responseRequest.inputItemId);
            } else if (activeResponseAuthority === 'direct') {
              if (responseRequest?.inputItemId) {
                responseInputItemIds.set(
                  responseId,
                  responseRequest.inputItemId,
                );
              } else if (splitResponseInputItemId) {
                responseInputItemIds.set(responseId, splitResponseInputItemId);
              } else {
                bindResponseInput(responseId);
              }
              if (terminal) break;
            }
            const responseInputItemId = responseInputItemIds.get(responseId);
            const hasDirectInput =
              responseAuthority === 'direct' &&
              responseInputItemId !== undefined &&
              (committedInputItemIds.has(responseInputItemId) ||
                splitResponseInputItemId !== undefined);
            responseToolCapabilities.set(
              responseId,
              hasDirectInput
                ? 'direct'
                : responseRequest?.toolCapability === 'direct' &&
                    responseAuthority === 'tool_continuation'
                  ? 'direct'
                  : 'none',
            );
            if (responseAuthority === 'direct') directResponsePending = false;
            const response = isRecord(message['response'])
              ? message['response']
              : undefined;
            if (responseRequest?.notificationItemId) {
              const pending: NotificationResponse = {
                request: responseRequest,
                created: message,
                state: 'pending',
                queued: [],
                queuedBytes: 0,
              };
              notificationResponses.set(responseId, pending);
              pending.timer = setTimeout(
                () =>
                  rejectNotificationResponse(responseId, 'ancestry_timeout'),
                deps.notificationProvenanceTimeoutMs ??
                  NOTIFICATION_PROVENANCE_TIMEOUT_MS,
              );
              pending.timer.unref?.();
            } else
              callback(() =>
                callbacks.onResponseCreated?.({
                  ...eventContext(message),
                  responseId,
                  ...(responseInputItemId
                    ? { inputItemId: responseInputItemId }
                    : {}),
                  authority: responseAuthority,
                  status: optionalString(response?.['status']),
                }),
              );
            break;
          } finally {
            responseCreatedInProgress = false;
          }
        }
        case 'response.audio.delta':
        case 'response.output_audio.delta': {
          const responseId = readResponseId(message);
          if (!responseId || !isCurrentResponse(message, type, responseId)) {
            break;
          }
          const audio = parseAudioDelta(message['delta']);
          if (!audio) {
            protocolError(
              'Realtime output audio frame was invalid or too large.',
              'invalid_audio_frame',
            );
            break;
          }
          if (
            isProactiveRepairResponse(responseId) ||
            audioSuppressedResponses.has(responseId)
          )
            break;
          responsesWithAudio.add(responseId);
          activeAudioResponseId = responseId;
          callback(() =>
            callbacks.onOutputAudioDelta?.({
              ...eventContext(message),
              responseId,
              itemId: optionalString(message['item_id']),
              audio,
            }),
          );
          break;
        }
        case 'response.audio.done':
        case 'response.output_audio.done': {
          const responseId = readResponseId(message);
          if (!responseId || !isCurrentResponse(message, type, responseId)) {
            break;
          }
          if (activeAudioResponseId === responseId) {
            activeAudioResponseId = undefined;
          }
          if (
            isProactiveRepairResponse(responseId) ||
            audioSuppressedResponses.has(responseId)
          )
            break;
          callback(() =>
            callbacks.onOutputAudioDone?.({
              ...eventContext(message),
              responseId,
              itemId: optionalString(message['item_id']),
            }),
          );
          break;
        }
        case 'response.text.delta':
        case 'response.output_text.delta':
        case 'response.audio_transcript.delta': {
          const responseId = readResponseId(message);
          if (!responseId || !isCurrentResponse(message, type, responseId)) {
            break;
          }
          const delta = optionalString(
            message['delta'],
            QWEN_REALTIME_LIMITS.maxTextDeltaChars,
          );
          if (delta === undefined) {
            protocolError(
              'Realtime output text delta exceeded the allowed size.',
              'text_delta_too_large',
            );
            break;
          }
          if (isProactiveRepairResponse(responseId)) break;
          if (!audioSuppressedResponses.has(responseId))
            appendTranscriptDelta('assistant', delta, newOutputEntry);
          newOutputEntry = false;
          updateResponseOutputText(
            responseId,
            type.includes('audio_transcript') ? 'audio_transcript' : 'text',
            delta,
            false,
          );
          callback(() =>
            callbacks.onOutputTextDelta?.({
              ...eventContext(message),
              responseId,
              itemId: optionalString(message['item_id']),
              text: delta,
              ...(audioSuppressedResponses.has(responseId)
                ? { audioSuppressed: true }
                : {}),
              source: type.includes('audio_transcript')
                ? 'audio_transcript'
                : 'text',
            }),
          );
          break;
        }
        case 'response.text.done':
        case 'response.output_text.done':
        case 'response.audio_transcript.done': {
          const responseId = readResponseId(message);
          if (!responseId || !isCurrentResponse(message, type, responseId)) {
            break;
          }
          const text = optionalString(
            message['text'] ?? message['transcript'],
            QWEN_REALTIME_LIMITS.maxTranscriptChars,
          );
          if (text === undefined) {
            protocolError(
              'Realtime output text exceeded the allowed size.',
              'transcript_too_large',
            );
            break;
          }
          if (isProactiveRepairResponse(responseId)) break;
          if (!audioSuppressedResponses.has(responseId))
            applyTranscriptDone('assistant', text, newOutputEntry);
          newOutputEntry = false;
          updateResponseOutputText(
            responseId,
            type.includes('audio_transcript') ? 'audio_transcript' : 'text',
            text,
            true,
          );
          callback(() =>
            callbacks.onOutputTextDone?.({
              ...eventContext(message),
              responseId,
              itemId: optionalString(message['item_id']),
              text,
              ...(audioSuppressedResponses.has(responseId)
                ? { audioSuppressed: true }
                : {}),
              source: type.includes('audio_transcript')
                ? 'audio_transcript'
                : 'text',
            }),
          );
          break;
        }
        case 'response.function_call_arguments.delta': {
          const responseId = readResponseId(message);
          if (!responseId || !isCurrentResponse(message, type, responseId)) {
            break;
          }
          const callId = optionalString(message['call_id']);
          const delta = optionalString(
            message['delta'],
            QWEN_REALTIME_LIMITS.maxFunctionArgumentsChars,
          );
          if (!callId || delta === undefined) {
            protocolError(
              'Realtime function argument event was invalid.',
              'invalid_function_arguments',
            );
            break;
          }
          const existing = pendingCalls.get(callId);
          if (existing && existing.responseId !== responseId) {
            ignoreEvent(message, type, 'stale_call');
            break;
          }
          if (existing?.dispatched) {
            protocolError(
              'Realtime model changed a handoff call after dispatch.',
              'ambiguous_handoff',
            );
            break;
          }
          if (
            !existing &&
            pendingCalls.size >= QWEN_REALTIME_LIMITS.maxPendingFunctionCalls
          ) {
            protocolError(
              'Realtime provider created too many pending function calls.',
              'too_many_function_calls',
            );
            break;
          }
          const call: PendingFunctionCall = existing ?? {
            responseId,
            itemId: optionalString(message['item_id']),
            callId,
            arguments: '',
            dispatched: false,
            outputSubmitted: false,
            responseCompleted: false,
            speechGeneration,
          };
          if (
            call.arguments.length + delta.length >
            QWEN_REALTIME_LIMITS.maxFunctionArgumentsChars
          ) {
            protocolError(
              'Realtime function arguments exceeded the allowed size.',
              'function_arguments_too_large',
            );
            break;
          }
          call.arguments += delta;
          pendingCalls.set(callId, call);
          if (isProactiveRepairResponse(responseId)) break;
          callback(() =>
            callbacks.onFunctionArgumentsDelta?.({
              ...eventContext(message),
              responseId,
              itemId: call.itemId,
              callId,
              delta,
            }),
          );
          break;
        }
        case 'response.function_call_arguments.done': {
          const responseId = readResponseId(message);
          if (!responseId || !isCurrentResponse(message, type, responseId)) {
            break;
          }
          const callId = optionalString(message['call_id']);
          const name = optionalString(message['name']);
          const args = optionalString(
            message['arguments'],
            QWEN_REALTIME_LIMITS.maxFunctionArgumentsChars,
          );
          if (!callId || !name || args === undefined) {
            protocolError(
              'Realtime function completion was invalid.',
              'invalid_function_arguments',
            );
            break;
          }
          const existing = pendingCalls.get(callId);
          if (existing && existing.responseId !== responseId) {
            ignoreEvent(message, type, 'stale_call');
            break;
          }
          if (existing?.dispatched) {
            if (existing.name !== name || existing.arguments !== args) {
              protocolError(
                'Realtime model changed a handoff call after dispatch.',
                'ambiguous_handoff',
              );
            }
            break;
          }
          if (
            !existing &&
            pendingCalls.size >= QWEN_REALTIME_LIMITS.maxPendingFunctionCalls
          ) {
            protocolError(
              'Realtime provider created too many pending function calls.',
              'too_many_function_calls',
            );
            break;
          }
          const call: PendingFunctionCall = existing ?? {
            responseId,
            itemId: optionalString(message['item_id']),
            callId,
            arguments: '',
            dispatched: false,
            outputSubmitted: false,
            responseCompleted: false,
            speechGeneration,
          };
          if (
            call.argumentsFinal &&
            (call.name !== name || call.arguments !== args)
          ) {
            call.invalidCompletion = true;
            break;
          }
          call.name = name;
          call.arguments = args;
          call.argumentsFinal = true;
          call.argumentsEventId = optionalString(message.event_id);
          pendingCalls.set(callId, call);
          break;
        }
        case 'response.output_item.done': {
          const responseId = readResponseId(message);
          if (!responseId || !isCurrentResponse(message, type, responseId)) {
            break;
          }
          const item = isRecord(message['item']) ? message['item'] : undefined;
          if (item?.['type'] !== 'function_call') break;
          const callId = optionalString(item['call_id']);
          const name = optionalString(item['name']);
          const args = optionalString(
            item['arguments'],
            QWEN_REALTIME_LIMITS.maxFunctionArgumentsChars,
          );
          if (!callId || !name || args === undefined) break;
          const existing = pendingCalls.get(callId);
          if (existing && existing.responseId !== responseId) {
            ignoreEvent(message, type, 'stale_call');
            break;
          }
          if (existing?.dispatched) {
            if (existing.name !== name || existing.arguments !== args) {
              protocolError(
                'Realtime model changed a handoff call after dispatch.',
                'ambiguous_handoff',
              );
            }
            break;
          }
          if (
            !existing &&
            pendingCalls.size >= QWEN_REALTIME_LIMITS.maxPendingFunctionCalls
          ) {
            protocolError(
              'Realtime provider created too many pending function calls.',
              'too_many_function_calls',
            );
            break;
          }
          const call: PendingFunctionCall = existing ?? {
            responseId,
            itemId: optionalString(item['id']),
            callId,
            arguments: '',
            dispatched: false,
            outputSubmitted: false,
            responseCompleted: false,
            speechGeneration,
          };
          if (
            call.argumentsFinal &&
            (call.name !== name || call.arguments !== args)
          ) {
            // Keep the first completed snapshot so response.done detects disagreement.
            call.invalidCompletion = true;
            break;
          }
          call.name = name;
          call.arguments = args;
          call.argumentsFinal = true;
          call.argumentsEventId ??= optionalString(message.event_id);
          pendingCalls.set(callId, call);
          break;
        }
        case 'response.done': {
          const responseId =
            readResponseId(message, true) ??
            readResponseId(message) ??
            activeResponseId;
          if (!responseId) {
            if (lastCompletedResponseId || !pendingResponseCreate) {
              ignoreEvent(message, type, 'stale_response');
              break;
            }
            protocolError(
              'Realtime response completion omitted its identifier.',
              'invalid_response',
            );
            break;
          }
          if (cancelledResponseIds.has(responseId)) {
            retireResponse(responseId);
            if (activeResponseId === responseId) clearResponseDoneTimer();
            const authority =
              responseAuthorities.get(responseId) ??
              activeResponseAuthority ??
              'direct';
            const cancellationReason = cancelledResponseReasons.get(responseId);
            const responseInputItemId = responseInputItemIds.get(responseId);
            collectDialogueResponse(responseId, true);
            collectDirectTranscript(responseId);
            cancelledResponseIds.delete(responseId);
            completePendingCallsForResponse(responseId, 'cancelled');
            consumeResponseInput(responseId);
            if (activeResponseId === responseId) {
              activeResponseId = undefined;
              activeResponseAuthority = undefined;
            }
            if (activeAudioResponseId === responseId) {
              activeAudioResponseId = undefined;
            }
            lastCompletedResponseId = responseId;
            const notificationFailureReported =
              notificationResponses.get(responseId)?.failureReported;
            disposeNotificationResponse(responseId);
            if (!notificationFailureReported)
              callback(() =>
                callbacks.onResponseDone?.({
                  ...eventContext(message),
                  responseId,
                  ...(responseInputItemId
                    ? { inputItemId: responseInputItemId }
                    : {}),
                  status: 'cancelled',
                  authority,
                  ...(cancellationReason ? { cancellationReason } : {}),
                }),
              );
            cancelledResponseReasons.delete(responseId);
            queueMicrotask(flushResponseCreate);
            responseAuthorities.delete(responseId);
            responseToolCapabilities.delete(responseId);
            repairToolAllowlists.delete(responseId);
            delegatedResponseIds.delete(responseId);
            responseOutputText.delete(responseId);
            responsesWithAudio.delete(responseId);
            audioSuppressedResponses.delete(responseId);
            silentReceiptDrains.delete(responseId);
            responseAdmissionReceipts.delete(responseId);
            collectedDirectResponseIds.delete(responseId);
            break;
          }
          if (!isCurrentResponse(message, type, responseId)) break;
          retireResponse(responseId);
          clearResponseDoneTimer();
          const response = isRecord(message['response'])
            ? message['response']
            : undefined;
          const providerStatus = optionalString(response?.['status']);
          const notification = notificationResponses.get(responseId);
          const status =
            notification && notification.state !== 'verified'
              ? 'failed'
              : providerStatus;
          const notificationFailureReported = notification?.failureReported;
          const responseAuthority =
            responseAuthorities.get(responseId) ??
            activeResponseAuthority ??
            'direct';
          const responseInputItemId = responseInputItemIds.get(responseId);
          if (activeResponseAuthority === 'direct' && status === 'failed') {
            const inputLossError = pendingInputLossError();
            if (inputLossError) fail(inputLossError);
            if (terminal) break;
          }
          if (status === 'completed') {
            dispatchFinalFunctionCalls(message, responseId, response ?? {});
            if (terminal) break;
            dispatchCompletedRepairCalls(responseId);
            if (terminal) break;
          }
          completePendingCallsForResponse(responseId, status);
          collectDialogueResponse(
            responseId,
            status === 'cancelled' || status === 'failed',
          );
          collectDirectTranscript(responseId);
          lastCompletedResponseId = responseId;
          activeResponseId = undefined;
          activeResponseAuthority = undefined;
          activeAudioResponseId = undefined;
          consumeResponseInput(responseId);
          responseAuthorities.delete(responseId);
          responseToolCapabilities.delete(responseId);
          repairToolAllowlists.delete(responseId);
          delegatedResponseIds.delete(responseId);
          responseOutputText.delete(responseId);
          responsesWithAudio.delete(responseId);
          audioSuppressedResponses.delete(responseId);
          silentReceiptDrains.delete(responseId);
          responseAdmissionReceipts.delete(responseId);
          collectedDirectResponseIds.delete(responseId);
          disposeNotificationResponse(responseId);
          if (!notificationFailureReported)
            callback(() =>
              callbacks.onResponseDone?.({
                ...eventContext(message),
                responseId,
                ...(responseInputItemId
                  ? { inputItemId: responseInputItemId }
                  : {}),
                status,
                authority: responseAuthority,
              }),
            );
          if (providerStatus === 'failed') {
            notifyError(responseFailureError(response, config.apiKey));
          }
          queueMicrotask(flushResponseCreate);
          break;
        }
        case 'rate_limits.updated':
        case 'rate_limit.updated': {
          break;
        }
        case 'error': {
          const providerError = isRecord(message['error'])
            ? message['error']
            : undefined;
          const code = optionalString(providerError?.['code']);
          const providerType = optionalString(providerError?.['type']);
          const param = optionalString(providerError?.['param']);
          const status = optionalHttpStatus(
            providerError?.['status'] ?? message['status'],
          );
          const errorMessage = sanitizeErrorText(
            providerError?.['message'] ??
              providerError?.['code'] ??
              'Qwen Realtime request failed.',
            config.apiKey,
          );
          const unknownCall = /^Unknown function call id(?::\s*(.*))?$/i.exec(
            errorMessage,
          );
          const rejectedCallId = unknownCall?.[1];
          const rejectedEventId = optionalString(providerError?.['event_id']);
          if (
            ready &&
            (status === undefined || status === 400) &&
            (code === undefined || code === 'invalid_request_error') &&
            (providerType === undefined ||
              providerType === 'invalid_request_error') &&
            errorMessage.trim() === 'Error append image before append audio.'
          ) {
            // The provider rejects this image, not the logical call. Real API
            // probes confirmed the same socket still accepts audio and images.
            // Keep this diagnostic-only: no user-visible failure, fabricated
            // audio, retry of a captured frame, buffer reset, or reconnection.
            try {
              callbacks.onProtocolDebug?.({
                type: 'input_image_buffer.rejected',
                ...eventContext(message),
                code: 'image_audio_prerequisite',
                message: 'Error append image before append audio.',
                rejectedEventId: identifier(rejectedEventId),
                fatal: false,
              });
            } catch {
              /* diagnostic only */
            }
            break;
          }
          if (
            ready &&
            (status === undefined || status === 400) &&
            (providerType === undefined ||
              providerType === 'invalid_request_error') &&
            /^Input speech was not accepted by semantic turn detection\.?$/i.test(
              errorMessage.trim(),
            )
          ) {
            const request = pendingResponseCreate;
            const matchesPending =
              request !== undefined &&
              activeResponseId === undefined &&
              (!rejectedEventId || rejectedEventId === request.eventId);
            try {
              callbacks.onProtocolDebug?.({
                type: 'response.semantic_turn_rejected',
                ...eventContext(message),
                rejectedEventId: identifier(rejectedEventId),
                requestId: identifier(request?.requestId),
                requestEventId: identifier(request?.eventId),
                authority: request?.authority,
                inputItemId: identifier(request?.inputItemId),
                matchedPendingRequest: matchesPending,
              });
            } catch {
              /* diagnostic only */
            }
            if (matchesPending && request) {
              pendingResponseCreate = undefined;
              clearResponseCreatedTimer();
              // This ID is explicitly local: the provider rejected the request
              // before creating a response, so it has no provider response ID.
              const localResponseId = `unacknowledged-${request.requestId}`;
              retireResponse(localResponseId);
              if (request.authority === 'direct') {
                if (request.inputItemId) consumeInputItem(request.inputItemId);
                if (request.speechGeneration === speechGeneration) {
                  directResponsePending =
                    speechInputInProgress ||
                    speechCommitPending ||
                    responseCreateQueue.some(
                      (queued) =>
                        queued.authority === 'direct' && !queued.cancelled,
                    );
                }
              }
              // In particular, a rejected tool continuation does not reject
              // the already-accepted user turn or undo its executed tools.
              // Do not clear microphone buffers, resend receipts, or retry
              // tools merely because their follow-up speech was refused.
              callback(() =>
                callbacks.onResponseDone?.({
                  ...eventContext(message),
                  responseId: localResponseId,
                  status: 'failed',
                  authority: request.authority,
                  ...(request.inputItemId
                    ? { inputItemId: request.inputItemId }
                    : {}),
                  ...(request.cancellationReason
                    ? { cancellationReason: request.cancellationReason }
                    : {}),
                }),
              );
              queueMicrotask(flushResponseCreate);
            } else if (
              !rejectedEventId &&
              !request &&
              !activeResponseId &&
              committedInputItemIds.size === 0 &&
              pendingSpeechItemIds.size === 1
            ) {
              // A discarded VAD candidate may have no response request at
              // all. Only release a uniquely identified, uncommitted input;
              // never mislabel an accepted tool's original turn as rejected.
              const itemId = pendingSpeechItemIds.values().next().value!;
              pendingSpeechItemIds.delete(itemId);
              rejectedInputItemIds.add(itemId);
              while (rejectedInputItemIds.size > MAX_TRACKED_INPUT_ITEMS)
                rejectedInputItemIds.delete(
                  rejectedInputItemIds.values().next().value!,
                );
              consumeInputItem(itemId);
              speechInputInProgress = false;
              speechCommitPending = false;
              speechGenerationAdvancedForInput = false;
              directResponsePending = false;
              callback(() =>
                callbacks.onInputRejected?.({
                  ...eventContext(message),
                  itemId,
                  reason: 'semantic_vad',
                }),
              );
              queueMicrotask(flushResponseCreate);
            }
            notifyError(
              new QwenRealtimeError(
                errorMessage,
                'semantic_turn_rejected',
                false,
                {
                  kind: 'protocol',
                  providerType,
                  status,
                  param,
                },
              ),
            );
            break;
          }
          const byCall = rejectedCallId
            ? pendingFunctionOutputs.get(rejectedCallId)
            : undefined;
          const byEvent = rejectedEventId
            ? [...pendingFunctionOutputs.values()].find(
                (pending) => pending.eventId === rejectedEventId,
              )
            : undefined;
          // Explicit references must agree; never guess which operation failed.
          const receipt =
            unknownCall &&
            (!rejectedCallId || byCall) &&
            (!rejectedEventId || byEvent) &&
            (!byCall || !byEvent || byCall === byEvent)
              ? (byCall ?? byEvent)
              : undefined;
          if (receipt) {
            rejectFunctionOutput(
              receipt.call.callId,
              'tool_output_rejected',
              optionalString(message['event_id']),
            );
            break;
          }
          const kind = classifyRealtimeErrorKind(code, errorMessage, status);
          fail(
            new QwenRealtimeError(errorMessage, code, true, {
              kind,
              status,
              providerType,
              param,
            }),
          );
          break;
        }
        default:
          break;
      }
    };

    ws.on('message', (...args: unknown[]) => {
      if (terminal || closedByClient) return;
      if (args[1] === true) {
        protocolError(
          'Realtime provider sent an unexpected binary message.',
          'unexpected_binary_message',
        );
        return;
      }
      const raw = String(args[0]);
      if (
        Buffer.byteLength(raw) > QWEN_REALTIME_LIMITS.maxIncomingMessageBytes
      ) {
        protocolError(
          'Realtime provider message exceeded the allowed size.',
          'message_too_large',
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        protocolError(
          'Realtime provider sent invalid JSON.',
          'invalid_provider_message',
        );
        return;
      }
      if (!isRecord(parsed)) {
        protocolError(
          'Realtime provider message must be an object.',
          'invalid_provider_message',
        );
        return;
      }
      const message = parsed as ProviderMessage;
      const type = optionalString(message.type);
      if (!type) {
        protocolError(
          'Realtime provider message omitted its type.',
          'invalid_provider_message',
        );
        return;
      }
      const eventId = optionalString(message.event_id);
      if (eventId) {
        if (recentEventIds.has(eventId)) {
          ignoreEvent(message, type, 'duplicate_event');
          return;
        }
        recentEventIds.add(eventId);
        if (recentEventIds.size > MAX_RECENT_EVENT_IDS) {
          const oldest = recentEventIds.values().next().value;
          if (typeof oldest === 'string') recentEventIds.delete(oldest);
        }
      }
      processProviderMessage(message, type);
    });

    ws.on('unexpected-response', (...args: unknown[]) => {
      const response = isRecord(args[1]) ? args[1] : undefined;
      const status = optionalHttpStatus(response?.['statusCode']);
      const on = response?.['on'];
      if (typeof on !== 'function') {
        fail(upgradeFailureError(status, '', config.apiKey));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let complete = false;
      const finish = () => {
        if (complete) return;
        complete = true;
        fail(
          upgradeFailureError(
            status,
            Buffer.concat(chunks).toString('utf8'),
            config.apiKey,
          ),
        );
      };
      on.call(response, 'data', (chunk: unknown) => {
        if (bytes >= MAX_ERROR_RESPONSE_BYTES) return;
        const data =
          typeof chunk === 'string'
            ? Buffer.from(chunk)
            : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
              ? Buffer.from(chunk)
              : undefined;
        if (!data) return;
        const bounded = data.subarray(0, MAX_ERROR_RESPONSE_BYTES - bytes);
        chunks.push(bounded);
        bytes += bounded.byteLength;
      });
      on.call(response, 'end', finish);
      on.call(response, 'aborted', finish);
      on.call(response, 'error', finish);
    });

    ws.on('error', (rawError: unknown) => {
      const errorText = sanitizeErrorText(
        rawError instanceof Error ? rawError.message : rawError,
        config.apiKey,
      );
      const statusMatch = /unexpected server response:\s*(\d{3})/i.exec(
        errorText,
      );
      const status = optionalHttpStatus(statusMatch?.[1]);
      fail(
        new QwenRealtimeError(
          errorText,
          status ? `http_${status}` : 'socket_error',
          true,
          { status },
        ),
      );
    });

    ws.on('close', (...args: unknown[]) => {
      clearConnectTimer();
      clearResponseTimers();
      clearInputHeartbeat();
      removeAbortListener();
      if (closedByClient || terminal) return;
      const reason = sanitizeErrorText(args[1], config.apiKey);
      const reasonKind = classifyRealtimeErrorKind(undefined, reason);
      const inputLossError = pendingInputLossError();
      if (inputLossError && reasonKind !== 'quota') {
        fail(inputLossError);
        return;
      }
      const code = optionalFiniteNumber(args[0]);
      terminal = true;
      if (activeResponseId) collectDialogueResponse(activeResponseId, true);
      const suffix = code ? ` (${code}${reason ? `: ${reason}` : ''})` : '';
      const error = new QwenRealtimeError(
        `Realtime connection closed unexpectedly${suffix}.`,
        'connection_closed',
        true,
        {
          kind:
            reasonKind !== 'quota' &&
            code !== undefined &&
            [1001, 1006, 1011, 1012, 1013].includes(code)
              ? 'transient'
              : reasonKind,
          closeCode: code,
        },
      );
      if (!settled) {
        settled = true;
        reject(error);
      } else {
        notifyError(error);
      }
      settleClosed({ reason: 'remote', error });
    });

    abortListener = () => {
      fail(new QwenRealtimeError('Realtime connection was aborted.'));
    };
    deps.abortSignal?.addEventListener('abort', abortListener, { once: true });
    if (deps.abortSignal?.aborted) abortListener();

    connectTimer = setTimeout(() => {
      if (!ready) {
        fail(
          new QwenRealtimeError(
            'Realtime connection timed out.',
            'connection_timeout',
          ),
        );
      }
    }, connectTimeoutMs);
  });
}
