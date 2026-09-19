/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted to TypeScript from qwen-omni-realtime-agent; modified for Qwen Live Harness.
 */

import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  deriveQwenOmniRealtimeUrl,
  QwenRealtimeError,
  QWEN_REALTIME_INPUT_SAMPLE_RATE,
  QWEN_REALTIME_LIMITS,
} from '../realtime/realtime-session.js';
import type { SocketLike } from '../realtime/socket.js';
import type { DebugArchive } from '../log/debug-archive.js';
import { createDebugSocket } from '../log/debug-socket.js';
import {
  PROACTIVE_MONITOR_CHUNK_DURATION_SEC,
  PROACTIVE_MONITOR_FPS,
} from './media-cadence.js';
import type {
  MonitorAudioOrigin,
  MonitorDebugRecorder,
  MonitorDebugStore,
} from './monitor-debug-store.js';
import {
  parseMonitorAction,
  PROACTIVE_MONITOR_SYSTEM_PROMPT,
  type MonitorEvaluationResult,
  type ProactiveMonitorMode,
} from './monitor-protocol.js';

const CONNECT_TIMEOUT_MS = 8_000;
const EVALUATION_TIMEOUT_MS = 30_000;
const MAX_RECENT_INPUTS = 4_096;
const MAX_PROVIDER_METADATA_CHARS = 256;
const PCM_BYTES_PER_SECOND = QWEN_REALTIME_INPUT_SAMPLE_RATE * 2;
const MAX_CAPTURE_GAP_MS = 250;

type MonitorModality = 'audio' | 'vision';

interface RecentAudio {
  sequence: number;
  capturedAt: number;
  modality: 'audio';
  payload: Uint8Array;
  origin?: MonitorAudioOrigin;
}

interface RecentImage {
  sequence: number;
  capturedAt: number;
  modality: 'vision';
  payload: string;
}

type RecentInput = RecentAudio | RecentImage;

interface CaptureChunk {
  inputs: RecentInput[];
  consumedAudio: Map<number, number>;
  consumedImages: Set<number>;
  startAt: number;
  endAt: number;
}

interface ProviderMessage extends Record<string, unknown> {
  type?: unknown;
}

export interface DashScopeRealtimeMonitorOptions {
  endpoint: string;
  apiKey?: string;
  model: string;
  taskId: string;
  taskGeneration: number;
  instruction: string;
  monitorMode: ProactiveMonitorMode;
  modalities: readonly MonitorModality[];
  contextWindowSec: Record<MonitorModality, number>;
  sessionRecycleEvals: number;
  representationCompact: 'none' | 'normal';
  monitorDebug?: MonitorDebugStore;
  debugArchive?: DebugArchive;
  debugContext?: Record<string, unknown>;
}

export interface DashScopeRealtimeMonitorCallbacks {
  onReady?: (taskGeneration: number) => void;
  onResult: (result: MonitorEvaluationResult, taskGeneration: number) => void;
  onLifecycleError?: (error: Error, taskGeneration: number) => void;
  onDebug?: (event: string, details: Record<string, unknown>) => void;
}

export interface DashScopeRealtimeMonitorDeps {
  /** Deterministic test fixture only; never supplied from product config/options. */
  mediaCadenceForTesting?: Readonly<{
    chunkDurationSec: number;
    visionFps: number;
  }>;
  createWebSocket?: (
    url: string,
    options: {
      headers: Record<string, string>;
      maxPayload: number;
      perMessageDeflate: false;
      handshakeTimeout: number;
    },
  ) => SocketLike;
  now?: () => number;
  connectTimeoutMs?: number;
  evaluationTimeoutMs?: number;
  maxQueuedInputs?: number;
}

export interface ProactiveRealtimeMonitor {
  start(): Promise<void>;
  feedAudio(pcm16: Uint8Array): boolean;
  feedImage(jpegBase64: string, capturedAt?: number): boolean;
  requestEvaluation(): boolean;
  resetPendingCapture(): void;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseIdOf(message: ProviderMessage): string | undefined {
  if (typeof message['response_id'] === 'string') {
    return message['response_id'];
  }
  const response = isRecord(message['response']) ? message['response'] : {};
  return typeof response['id'] === 'string' ? response['id'] : undefined;
}

function providerMetadata(value: unknown, apiKey?: string): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PROVIDER_METADATA_CHARS ||
    (apiKey !== undefined && apiKey.length > 0 && value.includes(apiKey)) ||
    !/^[A-Za-z0-9_.:/-]+$/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

function providerStatus(value: unknown): number | undefined {
  const status =
    typeof value === 'string' && /^\d{3}$/u.test(value)
      ? Number(value)
      : typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : undefined;
  return status !== undefined && status >= 100 && status <= 599
    ? status
    : undefined;
}

function monitorError(
  message: string,
  code: string,
  kind: 'configuration' | 'transient' | 'protocol',
  status?: number,
): QwenRealtimeError {
  return new QwenRealtimeError(message, code, true, {
    kind,
    ...(status !== undefined ? { status } : {}),
  });
}

function providerError(
  message: ProviderMessage,
  apiKey?: string,
): QwenRealtimeError {
  const detail = isRecord(message['error']) ? message['error'] : {};
  const code =
    providerMetadata(detail['code'], apiKey) ?? 'monitor_provider_error';
  const status = providerStatus(detail['status'] ?? message['status']);
  const providerType = providerMetadata(detail['type'], apiKey);
  const param = providerMetadata(detail['param'], apiKey);
  return new QwenRealtimeError(
    'DashScope monitor provider request failed.',
    code,
    true,
    {
      ...(status !== undefined ? { status } : {}),
      ...(providerType ? { providerType } : {}),
      ...(param ? { param } : {}),
    },
  );
}

function failureDebugDetails(
  error: QwenRealtimeError,
): Record<string, unknown> {
  return {
    error: true,
    kind: error.kind,
    ...(error.code ? { code: error.code } : {}),
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.providerType ? { providerType: error.providerType } : {}),
    ...(error.param ? { param: error.param } : {}),
  };
}

function isBoundedJpegBase64(value: string): boolean {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(QWEN_REALTIME_LIMITS.maxInputImageBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) {
    return false;
  }
  const image = Buffer.from(value, 'base64');
  return (
    image.byteLength >= 4 &&
    image.byteLength <= QWEN_REALTIME_LIMITS.maxInputImageBytes &&
    image[0] === 0xff &&
    image[1] === 0xd8 &&
    image[image.byteLength - 2] === 0xff &&
    image[image.byteLength - 1] === 0xd9 &&
    image.toString('base64') === value
  );
}

export class DashScopeRealtimeMonitor implements ProactiveRealtimeMonitor {
  private readonly createWebSocket: NonNullable<
    DashScopeRealtimeMonitorDeps['createWebSocket']
  >;
  private readonly now: () => number;
  private readonly connectTimeoutMs: number;
  private readonly evaluationTimeoutMs: number;
  private readonly maxQueuedInputs: number;
  private readonly modalities: ReadonlySet<MonitorModality>;
  private readonly representationCompact: 'none' | 'normal';
  private readonly chunkDurationSec: number;
  private readonly visionFps: number;
  private readonly chunkAudioBytes: number;
  private readonly chunkImageFrames: number;
  private socket: SocketLike | undefined;
  private debugRecorder: MonitorDebugRecorder | undefined;
  private transportGeneration = 0;
  private ready = false;
  private closed = false;
  private recycling = false;
  private needsRecycle = false;
  private evaluationPhase:
    'idle' | 'commit_pending' | 'response_requested' | 'responding' = 'idle';
  private initialTaskPending = true;
  private activeResponseId: string | undefined;
  private providerSessionId: string | undefined;
  private responseEventId: string | undefined;
  private responseUsage: Record<string, unknown> | undefined;
  private deltaText = '';
  private finalText = '';
  private evaluationCount = 0;
  private evaluationTimer: ReturnType<typeof setTimeout> | undefined;
  private recentInputs: RecentInput[] = [];
  private writerQueue: RecentInput[] = [];
  private pendingChunk: CaptureChunk | undefined;
  private readonly inputDrops = new Map<
    string,
    {
      count: number;
      audioBytes: number;
      imageFrames: number;
      firstCapturedAt: number;
      lastCapturedAt: number;
      firstSequence: number;
      lastSequence: number;
    }
  >();
  private nextSequence = 0;
  private audioInCurrentBuffer = false;
  private inputImageFrames = 0;
  private inputAudioBytes = 0;
  private lastInputFrameHash: string | undefined;
  private evaluationSequence = 0;
  private failureSeenTransportGeneration: number | undefined;
  private failureDeliveredTransportGeneration: number | undefined;
  private pendingConnect:
    | {
        generation: number;
        finish: (error?: QwenRealtimeError) => void;
      }
    | undefined;

  constructor(
    private readonly options: DashScopeRealtimeMonitorOptions,
    private readonly callbacks: DashScopeRealtimeMonitorCallbacks,
    deps: DashScopeRealtimeMonitorDeps = {},
  ) {
    this.modalities = new Set(options.modalities);
    // Provider video settings are fixed for the monitor, including recycles.
    this.representationCompact = options.representationCompact;
    this.chunkDurationSec =
      deps.mediaCadenceForTesting?.chunkDurationSec ??
      PROACTIVE_MONITOR_CHUNK_DURATION_SEC;
    this.visionFps =
      deps.mediaCadenceForTesting?.visionFps ?? PROACTIVE_MONITOR_FPS;
    if (
      !Number.isFinite(this.chunkDurationSec) ||
      !Number.isFinite(this.visionFps) ||
      this.chunkDurationSec <= 0 ||
      this.chunkDurationSec > 60 ||
      this.visionFps <= 0 ||
      this.visionFps > 60
    ) {
      throw new Error('Invalid injected test media cadence.');
    }
    this.chunkAudioBytes = Math.max(
      2,
      Math.round(this.chunkDurationSec * QWEN_REALTIME_INPUT_SAMPLE_RATE) * 2,
    );
    // A video grid requires at least two actual frames, never duplicated images.
    this.chunkImageFrames = Math.max(
      2,
      Math.ceil(this.chunkDurationSec * this.visionFps),
    );
    this.now = deps.now ?? Date.now;
    this.connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.evaluationTimeoutMs =
      deps.evaluationTimeoutMs ?? EVALUATION_TIMEOUT_MS;
    this.maxQueuedInputs = Math.max(
      1,
      Math.floor(deps.maxQueuedInputs ?? MAX_RECENT_INPUTS),
    );
    this.createWebSocket =
      deps.createWebSocket ??
      ((url, socketOptions) =>
        new WebSocket(url, {
          headers: socketOptions.headers,
          maxPayload: socketOptions.maxPayload,
          perMessageDeflate: socketOptions.perMessageDeflate,
          handshakeTimeout: socketOptions.handshakeTimeout,
        }) as unknown as SocketLike);
  }

  start(): Promise<void> {
    if (this.closed) {
      return Promise.reject(
        monitorError('Monitor is closed.', 'monitor_closed', 'protocol'),
      );
    }
    this.debugRecorder ??= this.options.monitorDebug?.create(
      {
        taskId: this.options.taskId,
        taskGeneration: this.options.taskGeneration,
        model: this.options.model,
        modalities: this.options.modalities,
      },
      this.options.apiKey,
    );
    return this.connect();
  }

  feedAudio(pcm16: Uint8Array): boolean {
    if (this.closed) return false;
    if (!this.modalities.has('audio')) return true;
    if (
      pcm16.byteLength === 0 ||
      pcm16.byteLength % 2 !== 0 ||
      pcm16.byteLength > QWEN_REALTIME_LIMITS.maxInputAudioFrameBytes
    ) {
      return false;
    }
    const input: RecentAudio = {
      sequence: ++this.nextSequence,
      capturedAt: this.now(),
      modality: 'audio',
      payload: Uint8Array.from(pcm16),
    };
    this.remember(input);
    return true;
  }

  feedImage(jpegBase64: string, capturedAt = this.now()): boolean {
    if (this.closed) return false;
    if (!this.modalities.has('vision')) return true;
    if (!isBoundedJpegBase64(jpegBase64)) return false;
    const input: RecentImage = {
      sequence: ++this.nextSequence,
      capturedAt,
      modality: 'vision',
      payload: jpegBase64,
    };
    this.remember(input);
    return true;
  }

  requestEvaluation(): boolean {
    if (this.closed) return false;
    this.pruneRecentInputs();
    this.flushInputDrops();
    if (this.needsRecycle) {
      this.beginRecycle();
      return false;
    }
    if (!this.ready || this.recycling || this.evaluationPhase !== 'idle') {
      return false;
    }
    if (this.socketIsBackpressured()) return false;
    if (!this.pendingChunk) {
      const chunk = this.prepareChunk();
      if (!chunk) return false;
      this.pendingChunk = chunk;
      this.writerQueue = [...chunk.inputs];
      this.debug('proactive.monitor_chunk_prepared', {
        chunkStartAt: chunk.startAt,
        chunkEndAt: chunk.endAt,
        chunkDurationSec: this.chunkDurationSec,
        imageFrames: chunk.inputs.filter((input) => input.modality === 'vision')
          .length,
        audioBytes: this.chunkAudioBytes,
        audioOrigin: this.modalities.has('audio')
          ? 'microphone'
          : 'protocol_silence',
      });
    }
    if (!this.drainWriterQueue() || this.writerQueue.length > 0) return false;
    if (this.socketIsBackpressured()) return false;
    this.evaluationPhase = 'commit_pending';
    this.evaluationSequence += 1;
    this.activeResponseId = undefined;
    this.responseEventId = undefined;
    this.responseUsage = undefined;
    this.deltaText = '';
    this.finalText = '';
    // A send exception cannot prove that the provider did not receive a
    // commit. Retire the clip before the attempt, never replay uncertain
    // evidence as a new cough/event when recovering the transport.
    const committedChunk = this.pendingChunk;
    this.consumeChunk(committedChunk);
    this.pendingChunk = undefined;
    if (!this.send({ type: 'input_audio_buffer.commit' })) {
      this.debug('proactive.monitor_chunk_dropped', {
        reason: 'commit_delivery_uncertain',
        chunkStartAt: committedChunk.startAt,
        chunkEndAt: committedChunk.endAt,
        audioBytes: this.chunkAudioBytes,
      });
      const error = monitorError(
        'Monitor could not commit its input buffer.',
        'monitor_commit_failed',
        'transient',
      );
      this.finishEvaluation(
        {
          triggered: false,
          summary: '',
          currentState: '',
          error: error.message,
        },
        error,
      );
      return true;
    }
    this.debug('proactive.monitor_commit', {
      evaluation: this.evaluationSequence,
      imageFrames: this.inputImageFrames,
      audioBytes: this.inputAudioBytes,
      audioMs:
        (this.inputAudioBytes / (QWEN_REALTIME_INPUT_SAMPLE_RATE * 2)) * 1_000,
      ...(this.lastInputFrameHash
        ? { lastFrameHash: this.lastInputFrameHash }
        : {}),
    });
    this.resetInputDiagnostics();
    this.audioInCurrentBuffer = false;
    this.armEvaluationTimeout();
    return true;
  }

  resetPendingCapture(): void {
    this.flushInputDrops();
    // Preserve the resident conversation and its Reply/wait action history.
    this.recentInputs = [];
    this.writerQueue = [];
    this.pendingChunk = undefined;
    this.audioInCurrentBuffer = false;
    this.resetInputDiagnostics();
    if (this.ready && !this.send({ type: 'input_audio_buffer.clear' })) {
      this.failCurrentTransport(
        monitorError(
          'Monitor could not clear its pending input buffer.',
          'monitor_clear_failed',
          'transient',
        ),
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.flushInputDrops();
    this.debugRecorder?.close();
    const pendingConnect = this.pendingConnect;
    this.closed = true;
    this.ready = false;
    this.transportGeneration += 1;
    this.clearEvaluationTimer();
    this.evaluationPhase = 'idle';
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
    this.recentInputs = [];
    this.writerQueue = [];
    this.pendingChunk = undefined;
    this.initialTaskPending = true;
    this.resetInputDiagnostics();
    pendingConnect?.finish(
      monitorError(
        'Monitor was closed while connecting.',
        'monitor_connection_closed',
        'transient',
      ),
    );
  }

  private connect(): Promise<void> {
    this.pendingConnect?.finish(
      monitorError(
        'Monitor connection was superseded.',
        'monitor_connection_superseded',
        'transient',
      ),
    );
    const old = this.socket;
    this.ready = false;
    this.audioInCurrentBuffer = false;
    this.resetInputDiagnostics();
    this.writerQueue = [];
    this.pendingChunk = undefined;
    this.initialTaskPending = true;
    const generation = ++this.transportGeneration;
    this.debugRecorder?.beginTransport(generation);
    this.providerSessionId = undefined;
    this.socket = undefined;
    try {
      old?.close();
    } catch {
      /* old generation is already fenced */
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let sessionUpdateSent = false;
      const timeout: {
        timer: ReturnType<typeof setTimeout> | undefined;
      } = { timer: undefined };
      let socket: SocketLike;
      const finishConnect = (error?: QwenRealtimeError): void => {
        if (settled) return;
        settled = true;
        if (timeout.timer !== undefined) clearTimeout(timeout.timer);
        if (this.pendingConnect?.generation === generation) {
          this.pendingConnect = undefined;
        }
        if (error) reject(error);
        else resolve();
      };
      this.pendingConnect = { generation, finish: finishConnect };
      try {
        socket = createDebugSocket(
          () =>
            this.createWebSocket(
              deriveQwenOmniRealtimeUrl(
                this.options.endpoint,
                this.options.model,
              ),
              {
                headers: this.options.apiKey
                  ? { Authorization: `Bearer ${this.options.apiKey}` }
                  : {},
                maxPayload: QWEN_REALTIME_LIMITS.maxIncomingMessageBytes,
                perMessageDeflate: false,
                handshakeTimeout: this.connectTimeoutMs,
              },
            ),
          {
            debugArchive: this.options.debugArchive,
            info: {
              ...this.options.debugContext,
              kind: 'monitor',
              model: this.options.model,
              endpoint: this.options.endpoint,
              taskId: this.options.taskId,
              taskGeneration: this.options.taskGeneration,
              transportGeneration: generation,
            },
          },
        );
      } catch {
        finishConnect(
          monitorError(
            'Monitor connection could not be created.',
            'monitor_connection_failed',
            'configuration',
          ),
        );
        return;
      }
      this.socket = socket;

      const current = (): boolean =>
        !this.closed &&
        generation === this.transportGeneration &&
        this.socket === socket;

      const failConnection = (error: QwenRealtimeError): void => {
        if (!current()) return;
        if (this.failureSeenTransportGeneration === generation) return;
        this.failureSeenTransportGeneration = generation;
        this.ready = false;
        this.needsRecycle = true;
        this.resetInputDiagnostics();
        if (!settled) {
          finishConnect(error);
          return;
        }
        if (this.evaluationPhase !== 'idle') {
          this.failureDeliveredTransportGeneration = generation;
          this.finishEvaluation(
            {
              triggered: false,
              summary: '',
              currentState: '',
              error: error.message,
            },
            error,
          );
        } else {
          this.deliverLifecycleFailure(error, generation);
        }
      };

      socket.on('message', (...args: unknown[]) => {
        if (
          !current() ||
          this.failureSeenTransportGeneration === generation ||
          args[1] === true
        )
          return;
        let parsed: unknown;
        try {
          const raw = String(args[0]);
          if (
            Buffer.byteLength(raw) >
            QWEN_REALTIME_LIMITS.maxIncomingMessageBytes
          ) {
            failConnection(
              monitorError(
                'Monitor provider message was too large.',
                'monitor_message_too_large',
                'protocol',
              ),
            );
            return;
          }
          parsed = JSON.parse(raw) as unknown;
        } catch {
          failConnection(
            monitorError(
              'Monitor provider message was invalid JSON.',
              'monitor_invalid_json',
              'protocol',
            ),
          );
          return;
        }
        if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
          failConnection(
            monitorError(
              'Monitor provider message was invalid.',
              'monitor_invalid_message',
              'protocol',
            ),
          );
          return;
        }
        const message = parsed as ProviderMessage;
        const type = message.type as string;
        if (type === 'session.created' || type === 'session.updated') {
          const session = isRecord(message['session'])
            ? message['session']
            : {};
          this.providerSessionId ??= providerMetadata(
            session['id'],
            this.options.apiKey,
          );
          if (this.providerSessionId)
            this.debugRecorder?.setProviderSessionId(this.providerSessionId);
        }
        if (type === 'session.created' && !sessionUpdateSent) {
          sessionUpdateSent = true;
          if (!this.sendSessionUpdate()) {
            failConnection(
              monitorError(
                'Monitor session update was rejected.',
                'monitor_session_update_failed',
                'transient',
              ),
            );
          }
          return;
        }
        if (type === 'session.updated' && !this.ready) {
          // An unsolicited update cannot authorize media before our initial
          // session settings (including video compression) have been sent.
          if (!sessionUpdateSent) return;
          if (!this.options.instruction.trim()) {
            failConnection(
              monitorError(
                'Monitor initialization was rejected.',
                'monitor_initialization_failed',
                'transient',
              ),
            );
            return;
          }
          this.ready = true;
          this.needsRecycle = false;
          this.evaluationCount = 0;
          this.pruneRecentInputs();
          this.debug('proactive.monitor_ready', {
            generation,
            model: providerMetadata(this.options.model, this.options.apiKey),
            inputTransport: 'streaming_buffers',
            chunkDurationSec: this.chunkDurationSec,
            ...(this.modalities.has('vision')
              ? { visionFps: this.visionFps }
              : {}),
          });
          finishConnect();
          this.callbacks.onReady?.(this.options.taskGeneration);
          return;
        }
        if (
          type === 'input_audio_buffer.committed' &&
          this.evaluationPhase === 'commit_pending'
        ) {
          this.debug('proactive.monitor_committed', {
            evaluation: this.evaluationSequence,
            inputItemId: providerMetadata(
              message['item_id'],
              this.options.apiKey,
            ),
          });
          this.evaluationPhase = 'response_requested';
          // In DashScope manual mode this per-response field adds text to the
          // committed multimodal user turn; it is not the session system
          // prompt. Supply the task only with the first clip of each transport.
          const taskText = this.initialTaskPending
            ? this.options.instruction.trim()
            : undefined;
          if (
            !this.send({
              type: 'response.create',
              ...(taskText ? { response: { instructions: taskText } } : {}),
            })
          ) {
            const error = monitorError(
              'Monitor response request was rejected.',
              'monitor_response_request_failed',
              'transient',
            );
            this.finishEvaluation(
              {
                triggered: false,
                summary: '',
                currentState: '',
                error: error.message,
              },
              error,
            );
          } else {
            this.initialTaskPending = false;
            this.debug('proactive.monitor_response_requested', {
              evaluation: this.evaluationSequence,
              taskTextIncluded: taskText !== undefined,
              taskTextChars: taskText?.length ?? 0,
            });
          }
          return;
        }
        if (type === 'response.created') {
          this.acceptResponse(message);
          return;
        }
        if (
          type === 'response.text.delta' ||
          type === 'response.output_text.delta' ||
          type === 'response.audio_transcript.delta'
        ) {
          if (!this.acceptResponse(message)) return;
          if (typeof message['delta'] === 'string') {
            this.deltaText = `${this.deltaText}${message['delta']}`.slice(
              0,
              QWEN_REALTIME_LIMITS.maxTranscriptChars,
            );
          }
          return;
        }
        if (
          type === 'response.text.done' ||
          type === 'response.output_text.done' ||
          type === 'response.audio_transcript.done'
        ) {
          if (!this.acceptResponse(message)) return;
          const text = message['text'] ?? message['transcript'];
          if (typeof text === 'string') {
            this.finalText = text.slice(
              0,
              QWEN_REALTIME_LIMITS.maxTranscriptChars,
            );
          }
          return;
        }
        if (type === 'response.done') {
          if (!this.acceptResponse(message)) return;
          const response = isRecord(message['response'])
            ? message['response']
            : {};
          this.responseEventId = providerMetadata(
            message['event_id'],
            this.options.apiKey,
          );
          if (this.debugRecorder && isRecord(response['usage']))
            this.responseUsage = response['usage'];
          if (
            response['status'] !== undefined &&
            response['status'] !== 'completed'
          ) {
            const error = monitorError(
              'Monitor response did not complete successfully.',
              'monitor_response_incomplete',
              'protocol',
            );
            this.finishEvaluation(
              {
                triggered: false,
                summary: '',
                currentState: '',
                error: error.message,
              },
              error,
            );
            return;
          }
          this.completeResponse();
          return;
        }
        if (type === 'error') {
          failConnection(providerError(message, this.options.apiKey));
        }
      });

      socket.on('error', () => {
        failConnection(
          monitorError(
            'Monitor WebSocket failed.',
            'monitor_socket_error',
            'transient',
          ),
        );
      });
      socket.on('close', () => {
        if (!current()) return;
        failConnection(
          monitorError(
            'Monitor WebSocket closed.',
            'monitor_connection_closed',
            'transient',
          ),
        );
      });
      socket.on('unexpected-response', () => {
        failConnection(
          monitorError(
            'Monitor WebSocket upgrade was rejected.',
            'monitor_upgrade_rejected',
            'configuration',
          ),
        );
      });

      timeout.timer = setTimeout(() => {
        failConnection(
          monitorError(
            'Monitor connection timed out.',
            'monitor_connection_timeout',
            'transient',
          ),
        );
      }, this.connectTimeoutMs);
      timeout.timer.unref?.();
    });
  }

  private sendSessionUpdate(): boolean {
    return this.send({
      type: 'session.update',
      session: {
        modalities: ['text'],
        // Text-only inference still validates voice; avoid the unsupported server default.
        voice: 'Tina',
        audio: {
          input: {
            format: {
              type: 'pcm',
              sample_rate: QWEN_REALTIME_INPUT_SAMPLE_RATE,
            },
          },
          output: { format: { type: 'pcm', sample_rate: 24_000 } },
        },
        input_audio_transcription: null,
        // This must precede all chunk media, including visual-only carrier audio.
        ...(this.modalities.has('vision')
          ? {
              video: {
                input: { representation_compact: this.representationCompact },
              },
            }
          : {}),
        turn_detection: null,
        instructions: PROACTIVE_MONITOR_SYSTEM_PROMPT,
        smooth_output: false,
        tools: [],
        tool_choice: 'none',
      },
    });
  }

  private prepareChunk(): CaptureChunk | undefined {
    this.pruneRecentInputs();
    const consumedAudio = new Map<number, number>();
    const consumedImages = new Set<number>();
    const hasAudio = this.modalities.has('audio');
    let startAt = 0;
    let endAt = 0;
    let audio: Buffer;
    if (hasAudio) {
      const parts: Uint8Array[] = [];
      let bytes = 0;
      for (const input of this.recentInputs) {
        if (input.modality !== 'audio') continue;
        const inputStartAt =
          input.capturedAt -
          (input.payload.byteLength / PCM_BYTES_PER_SECOND) * 1_000;
        if (bytes > 0 && inputStartAt > endAt + MAX_CAPTURE_GAP_MS) {
          for (const image of this.recentInputs) {
            if (image.modality === 'vision' && image.capturedAt <= endAt)
              consumedImages.add(image.sequence);
          }
          this.consumeChunk({
            inputs: [],
            consumedAudio,
            consumedImages,
            startAt,
            endAt,
          });
          this.debug('proactive.monitor_chunk_dropped', {
            reason: 'audio_capture_gap',
            chunkStartAt: startAt,
            chunkEndAt: endAt,
            nextCaptureAt: inputStartAt,
            audioBytes: bytes,
          });
          return undefined;
        }
        const take = Math.min(
          input.payload.byteLength,
          this.chunkAudioBytes - bytes,
        );
        if (bytes === 0) {
          startAt = inputStartAt;
        }
        parts.push(input.payload.subarray(0, take));
        consumedAudio.set(input.sequence, take);
        bytes += take;
        endAt =
          input.capturedAt -
          ((input.payload.byteLength - take) / PCM_BYTES_PER_SECOND) * 1_000;
        if (bytes === this.chunkAudioBytes) break;
      }
      // Do not run on historical evidence or fabricate microphone samples.
      if (bytes !== this.chunkAudioBytes) return undefined;
      audio = Buffer.concat(parts, bytes);
    } else {
      // DashScope's image buffer shares the manual audio commit lifecycle.
      // Visual-only clips carry exactly one clip of explicitly marked silence.
      audio = Buffer.alloc(this.chunkAudioBytes);
    }

    let images: RecentImage[] = [];
    if (this.modalities.has('vision')) {
      images = this.recentInputs.filter(
        (input): input is RecentImage => input.modality === 'vision',
      );
      if (hasAudio) {
        images = images.filter(
          (input) => input.capturedAt > startAt && input.capturedAt <= endAt,
        );
        if (images.length < this.chunkImageFrames) {
          // An image captured in the next second must not be paired with old
          // audio merely to reach the grid size. Allow one capture period for
          // arrival ordering, then discard the incomplete multimodal clip.
          if (this.now() > endAt + 1_000 / this.visionFps) {
            const chunk = {
              inputs: [],
              consumedAudio,
              consumedImages,
              startAt,
              endAt,
            };
            for (const input of this.recentInputs) {
              if (input.modality === 'vision' && input.capturedAt <= endAt) {
                consumedImages.add(input.sequence);
              }
            }
            this.consumeChunk(chunk);
            this.debug('proactive.monitor_chunk_dropped', {
              reason: 'incomplete_visual_grid',
              chunkStartAt: startAt,
              chunkEndAt: endAt,
              audioBytes: this.chunkAudioBytes,
              imageFrames: images.length,
              requiredImageFrames: this.chunkImageFrames,
            });
          }
          return undefined;
        }
        // Retain both edges when a capture burst contains extra frames.
        const available = images;
        images = Array.from(
          { length: this.chunkImageFrames },
          (_, index) =>
            available[
              Math.round(
                (index * (available.length - 1)) / (this.chunkImageFrames - 1),
              )
            ]!,
        );
        for (const input of this.recentInputs) {
          if (input.modality === 'vision' && input.capturedAt <= endAt) {
            consumedImages.add(input.sequence);
          }
        }
      } else {
        if (images.length < this.chunkImageFrames) return undefined;
        images = images.slice(0, this.chunkImageFrames);
        endAt = images.at(-1)!.capturedAt;
        startAt = images[0]!.capturedAt - 1_000 / this.visionFps;
        for (const input of images) consumedImages.add(input.sequence);
      }
    }

    const inputs: RecentInput[] = [];
    let offset = 0;
    const appendAudioThrough = (end: number): void => {
      while (offset < end) {
        const limit = Math.min(
          end,
          offset + QWEN_REALTIME_LIMITS.maxInputAudioFrameBytes,
        );
        inputs.push({
          sequence: 0,
          capturedAt: endAt,
          modality: 'audio',
          payload: audio.subarray(offset, limit),
          origin: hasAudio ? 'microphone' : 'protocol_silence',
        });
        offset = limit;
      }
    };
    for (const [index, image] of images.entries()) {
      // Put images on an even clip timeline instead of encoding capture
      // callback jitter into the wire format. At the default 2 s / 1 fps this
      // is exactly 1 s PCM, image, 1 s PCM, image for vision and audiovisual.
      const fraction = (index + 1) / images.length;
      const through = Math.max(
        2,
        Math.min(
          audio.byteLength,
          Math.round((fraction * audio.byteLength) / 2) * 2,
        ),
      );
      appendAudioThrough(through);
      inputs.push(image);
    }
    appendAudioThrough(audio.byteLength);
    return { inputs, consumedAudio, consumedImages, startAt, endAt };
  }

  private consumeChunk(chunk: CaptureChunk): void {
    this.recentInputs = this.recentInputs.flatMap<RecentInput>((input) => {
      if (input.modality === 'vision') {
        return chunk.consumedImages.has(input.sequence) ? [] : [input];
      }
      const consumed = chunk.consumedAudio.get(input.sequence) ?? 0;
      if (consumed === 0) return [input];
      if (consumed === input.payload.byteLength) return [];
      return [{ ...input, payload: input.payload.slice(consumed) }];
    });
  }

  private remember(input: RecentInput): void {
    this.recentInputs.push(input);
    this.pruneRecentInputs();
    while (this.recentInputs.length > this.maxQueuedInputs) {
      if (this.isPendingInput(this.recentInputs[0]!)) {
        this.discardPendingChunk('capture_queue_full');
        continue;
      }
      const dropped = this.recentInputs.shift();
      if (dropped) this.dropQueuedInput(dropped, 'capture_queue_full');
    }
  }

  private isPendingInput(input: RecentInput): boolean {
    return input.modality === 'audio'
      ? (this.pendingChunk?.consumedAudio.has(input.sequence) ?? false)
      : (this.pendingChunk?.consumedImages.has(input.sequence) ?? false);
  }

  private discardPendingChunk(reason: string): void {
    const chunk = this.pendingChunk;
    if (!chunk) return;
    this.consumeChunk(chunk);
    this.pendingChunk = undefined;
    this.writerQueue = [];
    this.audioInCurrentBuffer = false;
    this.resetInputDiagnostics();
    this.debug('proactive.monitor_chunk_dropped', {
      reason,
      chunkStartAt: chunk.startAt,
      chunkEndAt: chunk.endAt,
      audioBytes: this.chunkAudioBytes,
    });
    // Some of the frozen clip may already be on the wire. Clear that partial
    // provider buffer before admitting any newer clip, never commit both.
    if (
      this.ready &&
      !this.needsRecycle &&
      !this.send({ type: 'input_audio_buffer.clear' })
    ) {
      this.failCurrentTransport(
        monitorError(
          'Monitor could not discard an expired partial clip.',
          'monitor_clear_failed',
          'transient',
        ),
      );
    }
  }

  private dropQueuedInput(input: RecentInput, reason: string): void {
    const summary = this.inputDrops.get(reason) ?? {
      count: 0,
      audioBytes: 0,
      imageFrames: 0,
      firstCapturedAt: input.capturedAt,
      lastCapturedAt: input.capturedAt,
      firstSequence: input.sequence,
      lastSequence: input.sequence,
    };
    summary.count += 1;
    if (input.modality === 'audio')
      summary.audioBytes += input.payload.byteLength;
    else summary.imageFrames += 1;
    summary.lastCapturedAt = input.capturedAt;
    summary.lastSequence = input.sequence;
    this.inputDrops.set(reason, summary);
  }

  private flushInputDrops(): void {
    for (const [reason, summary] of this.inputDrops) {
      this.debug('proactive.monitor_input_dropped', { reason, ...summary });
    }
    this.inputDrops.clear();
  }

  private pruneRecentInputs(): void {
    const now = this.now();
    const inWindow = (input: RecentInput): boolean =>
      input.capturedAt >=
      now - this.options.contextWindowSec[input.modality] * 1_000;
    if (
      this.recentInputs.some(
        (input) => this.isPendingInput(input) && !inWindow(input),
      )
    ) {
      this.discardPendingChunk('capture_window_expired');
    }
    this.recentInputs = this.recentInputs.filter((input) => {
      if (inWindow(input)) return true;
      this.dropQueuedInput(input, 'capture_window_expired');
      return false;
    });
  }

  /**
   * Only a frozen, complete clip may enter the provider buffer. New capture is
   * queued locally while the preceding assistant turn is being generated.
   */
  private drainWriterQueue(reportFailure = true): boolean {
    if (!this.ready || this.needsRecycle) return true;
    while (this.writerQueue.length > 0) {
      if (this.socketIsBackpressured()) return true;
      const input = this.writerQueue[0]!;
      if (!this.appendInput(input)) {
        if (this.socketIsBackpressured()) return true;
        if (reportFailure) {
          this.failCurrentTransport(
            monitorError(
              'Monitor media writer failed.',
              'monitor_media_writer_failed',
              'transient',
            ),
          );
        }
        return false;
      }
      this.writerQueue.shift();
    }
    return true;
  }

  private appendInput(input: RecentInput): boolean {
    if (input.modality === 'audio') {
      const sent = this.send(
        {
          type: 'input_audio_buffer.append',
          audio: Buffer.from(input.payload).toString('base64'),
        },
        true,
        input.origin ?? 'microphone',
      );
      if (sent) {
        this.audioInCurrentBuffer = true;
        this.inputAudioBytes += input.payload.byteLength;
      }
      return sent;
    }
    if (!this.audioInCurrentBuffer) return false;
    const sent = this.send(
      { type: 'input_image_buffer.append', image: input.payload },
      true,
    );
    if (sent) {
      const image = Buffer.from(input.payload, 'base64');
      this.inputImageFrames += 1;
      this.lastInputFrameHash = createHash('sha256')
        .update(image)
        .digest('hex')
        .slice(0, 16);
      this.debug('proactive.monitor_image_sent', {
        sequence: input.sequence,
        bytes: image.byteLength,
        frameHash: this.lastInputFrameHash,
      });
    }
    return sent;
  }

  private resetInputDiagnostics(): void {
    this.inputImageFrames = 0;
    this.inputAudioBytes = 0;
    this.lastInputFrameHash = undefined;
  }

  private acceptResponse(message: ProviderMessage): boolean {
    if (
      this.evaluationPhase !== 'response_requested' &&
      this.evaluationPhase !== 'responding'
    ) {
      return false;
    }
    const responseId = responseIdOf(message);
    if (
      this.activeResponseId !== undefined &&
      responseId !== undefined &&
      responseId !== this.activeResponseId
    ) {
      return false;
    }
    if (this.activeResponseId === undefined && responseId !== undefined) {
      this.activeResponseId = responseId;
    }
    this.evaluationPhase = 'responding';
    return true;
  }

  private completeResponse(): void {
    const raw = this.finalText || this.deltaText;
    this.evaluationCount += 1;
    if (this.evaluationCount >= this.options.sessionRecycleEvals) {
      this.needsRecycle = true;
    }
    try {
      const result = parseMonitorAction(raw, this.options.monitorMode);
      this.debug('proactive.monitor_action', {
        evaluation: this.evaluationSequence,
        action:
          raw.trim() === 'wait'
            ? 'wait'
            : result.ignoredAction
              ? 'function_call'
              : 'reply',
        responseChars: raw.length,
      });
      this.finishEvaluation(result);
    } catch {
      this.debug('proactive.monitor_action', {
        evaluation: this.evaluationSequence,
        action: 'invalid',
        responseChars: raw.length,
      });
      this.needsRecycle = true;
      const error = monitorError(
        'Monitor returned an invalid action.',
        'monitor_invalid_action',
        'protocol',
      );
      this.finishEvaluation(
        {
          triggered: false,
          summary: '',
          currentState: '',
          error: error.message,
        },
        error,
      );
    }
  }

  private finishEvaluation(
    result: MonitorEvaluationResult,
    failure?: QwenRealtimeError,
  ): void {
    if (this.evaluationPhase === 'idle') return;
    this.debugRecorder?.result({
      evaluation: this.evaluationSequence,
      transportGeneration: this.transportGeneration,
      responseId: this.activeResponseId,
      ...(this.responseEventId ? { eventId: this.responseEventId } : {}),
      ...(this.responseUsage ? { usage: this.responseUsage } : {}),
      status: failure || result.error ? 'failed' : 'completed',
      text: this.finalText || this.deltaText,
      result,
      ...(failure ? { failure: failureDebugDetails(failure) } : {}),
    });
    this.clearEvaluationTimer();
    this.evaluationPhase = 'idle';
    const responseId = providerMetadata(
      this.activeResponseId,
      this.options.apiKey,
    );
    const eventId = this.responseEventId;
    this.activeResponseId = undefined;
    this.responseEventId = undefined;
    this.responseUsage = undefined;
    this.deltaText = '';
    this.finalText = '';
    const safeResult = failure
      ? { ...result, error: failure.message }
      : result.error
        ? { ...result, error: 'Monitor evaluation failed.' }
        : result;
    const safeFailure =
      failure ??
      (safeResult.error
        ? monitorError(
            safeResult.error,
            'monitor_evaluation_failed',
            'protocol',
          )
        : undefined);
    if (safeResult.error) {
      this.needsRecycle = true;
      this.resetInputDiagnostics();
    }
    this.debug('proactive.monitor_result', {
      evaluation: this.evaluationSequence,
      ...(responseId ? { responseId } : {}),
      ...(eventId ? { eventId } : {}),
      triggered: safeResult.triggered,
      ...(safeResult.ignoredAction
        ? { ignoredAction: safeResult.ignoredAction }
        : {}),
      ...(safeFailure ? failureDebugDetails(safeFailure) : {}),
    });
    this.callbacks.onResult(safeResult, this.options.taskGeneration);
  }

  private armEvaluationTimeout(): void {
    this.clearEvaluationTimer();
    this.evaluationTimer = setTimeout(() => {
      this.evaluationTimer = undefined;
      const error = monitorError(
        'Monitor evaluation timed out.',
        'monitor_evaluation_timeout',
        'transient',
      );
      this.finishEvaluation(
        {
          triggered: false,
          summary: '',
          currentState: '',
          error: error.message,
        },
        error,
      );
    }, this.evaluationTimeoutMs);
    this.evaluationTimer.unref?.();
  }

  private clearEvaluationTimer(): void {
    if (this.evaluationTimer !== undefined) {
      clearTimeout(this.evaluationTimer);
      this.evaluationTimer = undefined;
    }
  }

  private beginRecycle(): void {
    if (this.recycling || this.closed) return;
    this.recycling = true;
    this.ready = false;
    const connecting = this.connect();
    const generation = this.transportGeneration;
    void connecting
      .catch((error: unknown) => {
        this.needsRecycle = true;
        if (!this.closed && generation === this.transportGeneration) {
          this.deliverLifecycleFailure(
            error instanceof QwenRealtimeError
              ? error
              : monitorError(
                  'Monitor recycle failed.',
                  'monitor_recycle_failed',
                  'transient',
                ),
            generation,
          );
        }
      })
      .finally(() => {
        this.recycling = false;
      });
  }

  private socketIsBackpressured(): boolean {
    const socket = this.socket;
    return Boolean(
      socket &&
      socket.readyState === socket.OPEN &&
      (socket.bufferedAmount ?? 0) >
        QWEN_REALTIME_LIMITS.maxBufferedSocketBytes,
    );
  }

  private failCurrentTransport(error: QwenRealtimeError): void {
    const generation = this.transportGeneration;
    if (this.closed || this.failureSeenTransportGeneration === generation) {
      return;
    }
    this.failureSeenTransportGeneration = generation;
    this.ready = false;
    this.needsRecycle = true;
    this.resetInputDiagnostics();
    if (this.evaluationPhase !== 'idle') {
      this.failureDeliveredTransportGeneration = generation;
      this.finishEvaluation(
        {
          triggered: false,
          summary: '',
          currentState: '',
          error: error.message,
        },
        error,
      );
      return;
    }
    this.deliverLifecycleFailure(error, generation);
  }

  private deliverLifecycleFailure(
    error: QwenRealtimeError,
    generation: number,
  ): void {
    if (
      this.closed ||
      generation !== this.transportGeneration ||
      this.failureDeliveredTransportGeneration === generation
    ) {
      return;
    }
    this.failureDeliveredTransportGeneration = generation;
    this.callbacks.onLifecycleError?.(error, this.options.taskGeneration);
  }

  private send(
    body: Record<string, unknown>,
    enforceBackpressure = false,
    audioOrigin?: MonitorAudioOrigin,
  ): boolean {
    const socket = this.socket;
    if (
      this.closed ||
      !socket ||
      socket.readyState !== socket.OPEN ||
      (enforceBackpressure &&
        (socket.bufferedAmount ?? 0) >
          QWEN_REALTIME_LIMITS.maxBufferedSocketBytes)
    ) {
      return false;
    }
    const payload = { event_id: randomUUID(), ...body };
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      return false;
    }
    this.debugRecorder?.sent(payload, { origin: audioOrigin });
    return true;
  }

  private debug(event: string, details: Record<string, unknown>): void {
    try {
      this.callbacks.onDebug?.(event, {
        taskId: this.options.taskId,
        taskGeneration: this.options.taskGeneration,
        transportGeneration: this.transportGeneration,
        ...(this.providerSessionId
          ? { providerSessionId: this.providerSessionId }
          : {}),
        ...details,
      });
    } catch {
      // Diagnostics must not interrupt media delivery or evaluation.
    }
  }
}
