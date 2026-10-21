/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  openGptLiveSession,
  type GptLiveConfig,
  type GptLiveSession,
  type LiveTranscriptFragment,
  type LiveDelegation,
  type LiveResponsesConfig,
} from '../realtime/gpt-live-session.js';
import { ContinuousAudio } from '../realtime/continuous-audio.js';

export interface FdUserInput {
  /** Application evidence identity; never a provider turn or voice response ID. */
  id: string;
  version: number;
  text: string;
  transcript: readonly LiveTranscriptFragment[];
}

export interface FdToolCall {
  delegationId: string;
  responseId: string;
  callId: string;
  name: string;
  arguments: string;
  input?: FdUserInput;
  isCurrent(): boolean;
}

export interface FdCallOptions {
  config: GptLiveConfig;
  sendAudio(audio: Uint8Array): boolean;
  finishAudio(): void;
  transcript(fragment: LiveTranscriptFragment): void;
  tool(call: FdToolCall): Promise<string>;
  backendUsage?(usage: Record<string, unknown>): void;
  error(error: Error, fatal?: boolean): void;
  appended?(id: string, channel: string): void;
  usage(seconds: number, final: boolean): void;
  closed(confirmed: boolean): void;
  open?: typeof openGptLiveSession;
}

interface Response {
  delegationId: string;
  calls: Array<{ callId: string; name: string; arguments: string }>;
  complete: boolean;
  running: boolean;
  outputs?: Array<{ callId: string; output: string }>;
  submitted?: boolean;
}

interface Delegation {
  offsetMs: number;
  input?: FdUserInput;
  bound: boolean;
}

/** Voice has no response lock. Responses IDs belong only to backend operations. */
export class FdCall {
  private session?: GptLiveSession;
  private ended = false;
  private audioSuppressed = false;
  private opening?: Promise<void>;
  private fragments: LiveTranscriptFragment[] = [];
  private inputVersion = 0;
  private delegations = new Map<string, Delegation>();
  private responses = new Map<string, Response>();
  private activeResponse = new Map<string, string>();
  private seenCalls = new Set<string>();
  private timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  private readonly audio: ContinuousAudio;

  constructor(private readonly options: FdCallOptions) {
    this.audio = new ContinuousAudio({
      send: options.sendAudio,
      finish: options.finishAudio,
    });
  }

  start(): Promise<void> {
    return (this.opening ??= this.connect());
  }

  private async connect(): Promise<void> {
    const session = await (this.options.open ?? openGptLiveSession)(
      this.options.config,
      {
        onAudio: (audio) => {
          if (!this.ended && !this.audioSuppressed && !this.audio.push(audio))
            this.options.error(
              new Error('FD audio could not be delivered to the Host.'),
              false,
            );
        },
        onTranscript: (fragment) => {
          if (this.ended) return;
          this.fragments.push(fragment);
          this.fragments = this.fragments.slice(-256);
          if (fragment.role === 'user') this.inputVersion++;
          this.options.transcript(fragment);
        },
        onDelegation: (event) => this.delegated(event),
        onResponse: (event) => this.responseEvent(event),
        onUsage: this.options.usage,
        onAppend: ({ id, channel }) => this.options.appended?.(id, channel),
        onError: this.options.error,
        onClose: (confirmed) => {
          this.audio.finish();
          this.dispose();
          this.options.closed(confirmed);
        },
      },
    );
    this.session = session;
    if (this.ended) await session.close();
  }

  pushAudio(audio: Uint8Array): boolean {
    return this.ended ? true : (this.session?.pushAudio(audio) ?? true);
  }

  setInputMuted(muted: boolean): void {
    this.session?.setInputMuted(muted);
  }

  append(
    channel: 'thinking' | 'commentary' | 'instructions',
    text: string,
  ): boolean {
    return !this.ended && this.session?.append(channel, text) === true;
  }

  configureResponses(
    config: Pick<LiveResponsesConfig, 'instructions' | 'tools'>,
  ): boolean {
    return !this.ended && this.session?.configureResponses(config) === true;
  }

  clearAudio(): void {
    this.audio.clear();
  }

  stopSpeaking(): void {
    this.audioSuppressed = true;
    this.audio.clear();
  }

  resumeAudio(): void {
    this.audioSuppressed = false;
  }

  private delegated(event: LiveDelegation): void {
    if (this.ended || this.delegations.has(event.id)) return;
    if (this.delegations.size >= 256) {
      this.options.error(
        new Error('FD backend delegation capacity reached.'),
        false,
      );
      return;
    }
    this.delegations.set(event.id, { offsetMs: event.offsetMs, bound: false });
    if (event.responseId) this.registerResponse(event.id, event.responseId);
  }

  private registerResponse(delegationId: string, id: string): void {
    if (!this.delegations.has(delegationId) || this.responses.has(id)) return;
    if (this.responses.size >= 512) {
      this.options.error(
        new Error('FD backend response capacity reached.'),
        false,
      );
      return;
    }
    this.responses.set(id, {
      delegationId,
      calls: [],
      complete: false,
      running: false,
    });
    this.activeResponse.set(delegationId, id);
  }

  private responseEvent({
    delegationId,
    event,
  }: {
    delegationId: string;
    event: Record<string, unknown>;
  }): void {
    if (this.ended || !this.delegations.has(delegationId)) return;
    const snapshot = event['response'];
    if (
      event['type'] === 'response.created' &&
      snapshot &&
      typeof snapshot === 'object' &&
      'id' in snapshot &&
      typeof snapshot.id === 'string'
    ) {
      this.registerResponse(delegationId, snapshot.id);
      return;
    }
    const id =
      typeof event['response_id'] === 'string'
        ? event['response_id']
        : snapshot &&
            typeof snapshot === 'object' &&
            'id' in snapshot &&
            typeof snapshot.id === 'string'
          ? snapshot.id
          : this.activeResponse.get(delegationId);
    const response = id ? this.responses.get(id) : undefined;
    if (
      !response ||
      response.delegationId !== delegationId ||
      response.complete
    )
      return;
    if (event['type'] === 'response.output_item.done') {
      const item = event['item'];
      if (
        !item ||
        typeof item !== 'object' ||
        !('type' in item) ||
        item.type !== 'function_call'
      )
        return;
      if (
        !('call_id' in item) ||
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        item.call_id.length > 256 ||
        !('name' in item) ||
        typeof item.name !== 'string' ||
        item.name.length > 128 ||
        !('arguments' in item) ||
        typeof item.arguments !== 'string' ||
        item.arguments.length > 16000
      ) {
        this.options.error(
          new Error('FD backend sent an invalid function call.'),
          false,
        );
        return;
      }
      if (this.seenCalls.has(item.call_id)) return;
      if (this.seenCalls.size >= 2048 || response.calls.length >= 32) {
        this.options.error(
          new Error('FD backend tool capacity reached.'),
          false,
        );
        return;
      }
      this.seenCalls.add(item.call_id);
      response.calls.push({
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    } else if (
      [
        'response.completed',
        'response.failed',
        'response.incomplete',
        'response.cancelled',
      ].includes(String(event['type']))
    ) {
      response.complete = true;
      if (
        snapshot &&
        typeof snapshot === 'object' &&
        'usage' in snapshot &&
        snapshot.usage &&
        typeof snapshot.usage === 'object'
      )
        this.options.backendUsage?.(snapshot.usage as Record<string, unknown>);
      if (event['type'] !== 'response.completed') {
        response.submitted = true;
        this.flushOutputs();
        this.options.error(
          new Error(
            'FD backend response did not complete; no tool actions were executed.',
          ),
          false,
        );
        return;
      }
      if (response.calls.length) void this.runCalls(id!, response);
      else this.flushOutputs();
    }
  }

  private inputFor(delegation: Delegation): FdUserInput | undefined {
    const users = this.fragments.filter(
      (f) => f.role === 'user' && f.text.trim(),
    );
    const near = users.filter(
      (f) =>
        f.endMs >= delegation.offsetMs - 10000 &&
        f.startMs <= delegation.offsetMs,
    );
    const last = near.at(-1);
    if (
      !last ||
      last.endMs < delegation.offsetMs - 1500 ||
      users.at(-1)!.endMs > last.endMs
    )
      return;
    let first = near.length - 1;
    while (first > 0 && near[first]!.startMs - near[first - 1]!.endMs <= 1500)
      first--;
    const parts = near.slice(first);
    return {
      id: `fd-input:${parts[0]!.startMs}:${last.endMs}`,
      version: this.inputVersion,
      text: parts
        .map((f) => f.text)
        .join('')
        .trim(),
      transcript: [...this.fragments],
    };
  }

  private async runCalls(
    responseId: string,
    response: Response,
  ): Promise<void> {
    if (this.ended || response.running) return;
    response.running = true;
    const delegation = this.delegations.get(response.delegationId)!;
    // Only associate user evidence with model-selected calls. This grouping
    // delay never creates a turn, infers intent or starts an action from ASR.
    if (!delegation.bound) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          this.timers.delete(timer);
          resolve();
        };
        const timer = setTimeout(finish, 600);
        timer.unref?.();
        this.timers.set(timer, finish);
      });
      delegation.input = this.inputFor(delegation);
      delegation.bound = true;
    }
    const input = delegation.input;
    const isCurrent = () =>
      !this.ended && !!input && input.version === this.inputVersion;
    const outputs: Array<{ callId: string; output: string }> = [];
    for (const call of response.calls) {
      if (this.ended) return;
      let output: string;
      try {
        output = await this.options.tool({
          ...call,
          responseId,
          delegationId: response.delegationId,
          input,
          isCurrent,
        });
      } catch {
        output = JSON.stringify({
          status: 'uncertain',
          note: 'The operation could not be confirmed. Do not retry automatically; side effects may have occurred.',
        });
      }
      outputs.push({ callId: call.callId, output });
    }
    response.outputs = outputs;
    this.flushOutputs();
  }

  private flushOutputs(): void {
    if (this.ended) return;
    const awaiting = [...this.responses.values()].filter(
      (r) => r.calls.length && !r.submitted,
    );
    // Continuation is global to the managed Responses queue: return every
    // known pending call before one continuation, including overlapping work.
    if (!awaiting.length || awaiting.some((r) => !r.outputs)) return;
    const outputs = awaiting.flatMap((r) => r.outputs!);
    for (const response of awaiting) response.submitted = true;
    if (this.session?.submitToolOutputs(outputs) !== true)
      this.options.error(
        new Error(
          'FD backend tool results could not be submitted. Do not replay the actions.',
        ),
        false,
      );
  }

  async close(): Promise<boolean> {
    this.dispose();
    try {
      await this.opening;
    } catch {
      return false;
    }
    return this.session?.close() ?? true;
  }

  dispose(): void {
    this.ended = true;
    this.audio.clear();
    for (const [timer, finish] of this.timers) {
      clearTimeout(timer);
      finish();
    }
    this.timers.clear();
  }
}
