/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { SocketLike } from './socket.js';
import type { RealtimeToolDefinition } from './realtime-session.js';

export interface LiveResponsesConfig {
  model: string;
  instructions: string;
  tools: readonly RealtimeToolDefinition[];
}

export interface LiveDelegation {
  id: string;
  offsetMs: number;
  responseId?: string;
}

export interface GptLiveConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  voice?: string;
  instructions: string;
  responses: LiveResponsesConfig;
}

export interface LiveTranscriptFragment {
  role: 'user' | 'assistant';
  text: string;
  startMs: number;
  endMs: number;
}

export interface GptLiveCallbacks {
  onAudio(audio: Uint8Array): void;
  onTranscript(fragment: LiveTranscriptFragment): void;
  onDelegation(event: LiveDelegation): void;
  onResponse(event: {
    delegationId: string;
    event: Record<string, unknown>;
  }): void;
  onAppend?(event: { id: string; channel: string }): void;
  onUsage?(seconds: number, final: boolean): void;
  onError(error: Error, fatal?: boolean): void;
  onClose(confirmed: boolean): void;
}

export interface GptLiveSession {
  readonly sessionId: string;
  pushAudio(audio: Uint8Array): boolean;
  append(
    channel: 'thinking' | 'commentary' | 'instructions',
    text: string,
    delegationId?: string,
  ): boolean;
  setInputMuted(muted: boolean): void;
  submitToolOutputs(
    outputs: readonly { callId: string; output: string }[],
  ): boolean;
  configureResponses(
    config: Pick<LiveResponsesConfig, 'instructions' | 'tools'>,
  ): boolean;
  close(): Promise<boolean>;
}

export interface GptLiveDeps {
  createSocket?: (url: string, headers: Record<string, string>) => SocketLike;
  timeoutMs?: number;
}

export function gptLiveUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (!['https:', 'wss:', 'http:', 'ws:'].includes(url.protocol))
    throw new Error('Invalid GPT Live endpoint protocol.');
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      'GPT Live endpoint must not contain credentials or query parameters.',
    );
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && ['http:', 'ws:'].includes(url.protocol))
    throw new Error('GPT Live requires an encrypted connection.');
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '' || path === '/v1') url.pathname = '/v1/live/sessions';
  else if (path !== '/v1/live/sessions')
    throw new Error(
      'GPT Live endpoint must be an API origin or /v1/live/sessions.',
    );
  return url.toString();
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// UTF-8 bytes bound tokens conservatively, including Chinese. Each append is
// a small independent piece of quoted data rather than a raw tool transcript.
function pieces(text: string): string[] {
  if (Buffer.byteLength(text) <= 480) return [text];
  const result: string[] = [];
  let part = '';
  for (const char of text) {
    if (Buffer.byteLength(JSON.stringify(part + char)) > 300) {
      result.push(part);
      part = '';
    }
    part += char;
  }
  if (part) result.push(part);
  const messageId = randomUUID();
  return result.map((content, index) =>
    JSON.stringify({
      multipart: messageId,
      part: index + 1,
      total: result.length,
      content,
    }),
  );
}

export function openGptLiveSession(
  config: GptLiveConfig,
  callbacks: GptLiveCallbacks,
  deps: GptLiveDeps = {},
): Promise<GptLiveSession> {
  return new Promise((resolve, reject) => {
    const timeoutMs = deps.timeoutMs ?? 10_000;
    const socket = deps.createSocket
      ? deps.createSocket(gptLiveUrl(config.endpoint), {
          Authorization: `Bearer ${config.apiKey}`,
        })
      : new WebSocket(gptLiveUrl(config.endpoint), {
          headers: { Authorization: `Bearer ${config.apiKey}` },
          maxPayload: 1024 * 1024,
          perMessageDeflate: false,
          handshakeTimeout: timeoutMs,
        });
    let ready = false;
    let ended = false;
    let closing = false;
    let confirmed = false;
    let closeResolve: ((value: boolean) => void) | undefined;
    let closePromise: Promise<boolean> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let silenceTimer: ReturnType<typeof setInterval> | undefined;
    const outgoing: Array<{
      id: string;
      channel: string;
      delegationId?: string;
      content: string;
    }> = [];
    const pending = new Map<
      string,
      { channel: string; timer: ReturnType<typeof setTimeout> }
    >();
    const delegations = new Set<string>();
    const commands = new Map<string, string>();
    const seenEvents = new Set<string>();
    const connectTimer = setTimeout(
      () => fail('GPT Live startup timed out.'),
      timeoutMs,
    );
    connectTimer.unref?.();

    function finish(): void {
      if (ended) return;
      ended = true;
      clearTimeout(connectTimer);
      if (closeTimer) clearTimeout(closeTimer);
      if (silenceTimer) clearInterval(silenceTimer);
      outgoing.length = 0;
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      commands.clear();
      if (!ready) reject(new Error('GPT Live closed before session.started.'));
      closeResolve?.(confirmed);
      callbacks.onClose(confirmed);
    }

    function fail(message: string): void {
      if (ended) return;
      const error = new Error(message);
      if (!ready) reject(error);
      else callbacks.onError(error, true);
      finish();
      socket.close();
    }

    function send(body: Record<string, unknown>): boolean {
      if (
        ended ||
        socket.readyState !== socket.OPEN ||
        (socket.bufferedAmount ?? 0) > 1024 * 1024
      )
        return false;
      try {
        socket.send(JSON.stringify(body));
        return true;
      } catch {
        return false;
      }
    }

    function flushAppends(): void {
      while (outgoing.length && ready && !ended && !closing) {
        const next = outgoing[0]!;
        const timer = setTimeout(() => {
          pending.delete(next.id);
          if (!ended && !closing)
            callbacks.onError(
              new Error('GPT Live context append was not acknowledged.'),
              false,
            );
          flushAppends();
        }, 30_000);
        timer.unref?.();
        pending.set(next.id, { channel: next.channel, timer });
        if (
          !send({
            type: `session.${next.channel}.append`,
            event_id: next.id,
            delegation_id: next.delegationId ?? null,
            content: next.content,
          })
        ) {
          clearTimeout(timer);
          pending.delete(next.id);
          break;
        }
        outgoing.shift();
      }
    }

    function command(body: Record<string, unknown>): boolean {
      const id = randomUUID();
      if (!send({ ...body, event_id: id })) return false;
      commands.set(id, String(body['type']));
      while (commands.size > 512)
        commands.delete(commands.keys().next().value!);
      return true;
    }

    function responses(
      config:
        | LiveResponsesConfig
        | Pick<LiveResponsesConfig, 'instructions' | 'tools'>,
    ) {
      return {
        ...('model' in config ? { model: config.model } : {}),
        instructions: config.instructions,
        tools: config.tools.map(({ function: fn }) => ({
          type: 'function',
          ...fn,
          strict: false,
        })),
        tool_choice: 'auto',
        parallel_tool_calls: false,
      };
    }

    socket.on('open', () => {
      if (
        !send({
          type: 'session.start',
          event_id: randomUUID(),
          session: {
            model: config.model,
            instructions: config.instructions,
            store: false,
            audio: {
              format: { type: 'audio/pcm', rate: 16000 },
              output: { voice: config.voice ?? 'marin' },
            },
            delegation: {
              type: 'responses',
              responses: responses(config.responses),
            },
          },
        })
      )
        fail('GPT Live startup could not be sent.');
    });
    socket.on('error', () => fail('GPT Live connection failed.'));
    socket.on('close', finish);
    socket.on('message', (data, binary) => {
      if (ended) return;
      if (binary) {
        fail('GPT Live sent unexpected binary data.');
        return;
      }
      let event: unknown;
      try {
        const raw =
          typeof data === 'string'
            ? data
            : Buffer.from(data as Uint8Array).toString();
        if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error();
        event = JSON.parse(raw);
      } catch {
        fail('GPT Live sent invalid JSON.');
        return;
      }
      if (!record(event) || typeof event['type'] !== 'string') {
        fail('GPT Live sent an invalid event.');
        return;
      }
      const id = event['event_id'];
      if (typeof id === 'string') {
        if (seenEvents.has(id)) return;
        seenEvents.add(id);
        if (seenEvents.size > 512)
          seenEvents.delete(seenEvents.values().next().value!);
      }
      const type = event['type'];
      if (type === 'session.started' && !ready) {
        const session = event['session'];
        if (!record(session) || typeof session['id'] !== 'string') {
          fail('GPT Live startup omitted its session ID.');
          return;
        }
        const audio = session['audio'];
        if (
          !record(audio) ||
          !record(audio['format']) ||
          audio['format']['type'] !== 'audio/pcm' ||
          audio['format']['rate'] !== 16000
        ) {
          fail('GPT Live did not accept 16 kHz PCM.');
          return;
        }
        ready = true;
        clearTimeout(connectTimer);
        resolve({
          sessionId: session['id'],
          pushAudio: (audio) => {
            flushAppends();
            return (
              ready &&
              !closing &&
              audio.length > 0 &&
              audio.length % 2 === 0 &&
              audio.length <= 64 * 1024 &&
              send({
                type: 'session.input_audio.append',
                audio: Buffer.from(audio).toString('base64'),
              })
            );
          },
          append: (channel, text, delegationId) => {
            if (
              ended ||
              closing ||
              !text.trim() ||
              Buffer.byteLength(text) > 16 * 1024 ||
              delegationId !== undefined
            )
              return false;
            const chunks = pieces(text);
            if (pending.size + outgoing.length + chunks.length > 128)
              return false;
            for (const content of chunks)
              outgoing.push({
                id: randomUUID(),
                channel,
                delegationId,
                content,
              });
            flushAppends();
            return true;
          },
          setInputMuted: (muted) => {
            if (ended || closing) return;
            if (silenceTimer) clearInterval(silenceTimer);
            silenceTimer = undefined;
            if (muted && !closing) {
              const silence = Buffer.alloc(640).toString('base64');
              silenceTimer = setInterval(() => {
                flushAppends();
                send({ type: 'session.input_audio.append', audio: silence });
              }, 20);
              silenceTimer.unref?.();
            }
            if (
              !closing &&
              !command({
                type: `session.input_audio.${muted ? 'mute' : 'unmute'}`,
              })
            )
              callbacks.onError(
                new Error('GPT Live microphone command could not be sent.'),
                false,
              );
          },
          submitToolOutputs: (outputs) => {
            if (ended || closing || !outputs.length) return false;
            for (const output of outputs) {
              if (
                !command({
                  type: 'response.item.create',
                  item: {
                    type: 'function_call_output',
                    call_id: output.callId,
                    output: output.output,
                  },
                })
              )
                return false;
            }
            return command({ type: 'response.create' });
          },
          configureResponses: (settings) =>
            !ended &&
            !closing &&
            command({
              type: 'session.update',
              session: { delegation: { responses: responses(settings) } },
            }),
          close: () => {
            if (ended) return Promise.resolve(confirmed);
            if (closePromise) return closePromise;
            closing = true;
            if (silenceTimer) clearInterval(silenceTimer);
            closePromise = new Promise<boolean>((done) => {
              closeResolve = done;
            });
            closeTimer = setTimeout(() => {
              finish();
              socket.close();
            }, timeoutMs);
            closeTimer.unref?.();
            if (!send({ type: 'session.close', event_id: randomUUID() })) {
              finish();
              socket.close();
            }
            return closePromise;
          },
        });
      } else if (type === 'session.closed') {
        confirmed = true;
        const usage = event['usage'];
        if (
          record(usage) &&
          typeof usage['seconds'] === 'number' &&
          Number.isFinite(usage['seconds'])
        )
          callbacks.onUsage?.(usage['seconds'], true);
        finish();
        socket.close();
      } else if (type === 'error') {
        const error = event['error'];
        const clientId = record(error) ? error['client_event_id'] : undefined;
        if (typeof clientId === 'string' && pending.has(clientId)) {
          clearTimeout(pending.get(clientId)!.timer);
          pending.delete(clientId);
          callbacks.onError(
            new Error('GPT Live rejected a context append.'),
            false,
          );
        } else if (!closing) {
          const code = record(error) ? error['code'] : undefined;
          const kind =
            typeof clientId === 'string' ? commands.get(clientId) : undefined;
          if (code === 'responses_validation_failed' || kind) {
            if (typeof clientId === 'string') commands.delete(clientId);
            callbacks.onError(
              new Error(
                code === 'responses_validation_failed'
                  ? 'GPT Live Responses configuration was rejected. Check the backend model and tool settings.'
                  : 'GPT Live rejected a backend or microphone command; do not retry actions automatically.',
              ),
              false,
            );
          } else if (!ready) fail('GPT Live rejected a session command.');
          else
            callbacks.onError(
              new Error(
                'GPT Live reported a session error; no action outcome was confirmed.',
              ),
              false,
            );
        }
      } else if (!ready) {
        return;
      } else if (
        type === 'session.output_audio.delta' &&
        typeof event['delta'] === 'string'
      ) {
        const delta = event['delta'];
        if (
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
            delta,
          )
        ) {
          fail('GPT Live sent invalid audio.');
          return;
        }
        const audio = Buffer.from(delta, 'base64');
        if (audio.length % 2 || audio.length > 256 * 1024) {
          fail('GPT Live sent invalid PCM.');
          return;
        }
        if (!closing && audio.length) callbacks.onAudio(audio);
      } else if (
        type === 'session.input_transcript.delta' ||
        type === 'session.output_transcript.delta'
      ) {
        const startMs = event['start_ms'];
        const endMs = event['end_ms'];
        const text = event['delta'];
        if (
          typeof text !== 'string' ||
          text.length > 16 * 1024 ||
          typeof startMs !== 'number' ||
          typeof endMs !== 'number' ||
          !Number.isFinite(startMs) ||
          !Number.isFinite(endMs) ||
          startMs < 0 ||
          endMs < startMs
        ) {
          fail('GPT Live sent an invalid transcript.');
          return;
        }
        if (!closing)
          callbacks.onTranscript({
            role:
              type === 'session.input_transcript.delta' ? 'user' : 'assistant',
            text,
            startMs,
            endMs,
          });
      } else if (type === 'session.delegation.created' && !closing) {
        const delegation = event['delegation'];
        const offsetMs = event['offset_ms'];
        if (
          !record(delegation) ||
          delegation['target'] !== 'responses' ||
          typeof delegation['id'] !== 'string' ||
          delegation['id'].length > 256 ||
          typeof offsetMs !== 'number' ||
          !Number.isFinite(offsetMs) ||
          offsetMs < 0
        )
          return;
        if (delegations.has(delegation['id'])) return;
        if (delegations.size >= 256) {
          callbacks.onError(
            new Error('GPT Live delegation capacity reached.'),
            false,
          );
          return;
        }
        delegations.add(delegation['id']);
        callbacks.onDelegation({
          id: delegation['id'],
          offsetMs,
          ...(typeof (delegation['response_id'] ?? event['response_id']) ===
          'string'
            ? {
                responseId: String(
                  delegation['response_id'] ?? event['response_id'],
                ),
              }
            : {}),
        });
      } else if (type === 'response.event' && !closing) {
        const delegationId = event['delegation_id'];
        const inner = event['event'];
        if (
          typeof delegationId !== 'string' ||
          !delegations.has(delegationId) ||
          !record(inner) ||
          typeof inner['type'] !== 'string'
        )
          return;
        callbacks.onResponse({ delegationId, event: inner });
      } else if (
        /^session\.(thinking|commentary|instructions)\.appended$/u.test(type)
      ) {
        const clientId = event['client_event_id'];
        if (typeof clientId === 'string') {
          const entry = pending.get(clientId);
          if (entry) {
            clearTimeout(entry.timer);
            pending.delete(clientId);
            callbacks.onAppend?.({ id: clientId, channel: entry.channel });
            flushAppends();
          }
        }
      } else if (type === 'session.usage.updated') {
        const usage = event['usage'];
        if (
          record(usage) &&
          typeof usage['seconds'] === 'number' &&
          Number.isFinite(usage['seconds']) &&
          usage['seconds'] >= 0
        )
          callbacks.onUsage?.(usage['seconds'], false);
      }
    });
  });
}
