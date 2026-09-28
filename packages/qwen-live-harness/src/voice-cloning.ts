/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID, createHash } from 'node:crypto';
import { liveMessage } from './i18n/messages.js';
import { isVoiceId } from './voice-catalog.js';
import {
  voiceSampleSeconds,
  VOICE_CLONE_TIMEOUT_MS,
  type VoiceCloneOutcome,
} from './voice-sample.js';

export function voiceEnrollmentUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (
    url.username ||
    url.password ||
    !['https:', 'wss:', 'http:', 'ws:'].includes(url.protocol)
  )
    throw new Error(liveMessage('voice.cloneEndpoint'));
  // Keep credentials on the configured service origin; never follow redirects.
  const secure = ['https:', 'wss:'].includes(url.protocol);
  if (!secure && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error(liveMessage('voice.cloneEndpoint'));
  url.protocol = secure ? 'https:' : 'http:';
  url.pathname = '/api/v1/services/audio/tts/customization';
  url.search = '';
  url.hash = '';
  return url.href;
}

export async function createClonedVoice(
  options: {
    endpoint: string;
    apiKey: string;
    model: string;
    audio: Uint8Array;
    signal?: AbortSignal;
  },
  request: typeof fetch = fetch,
): Promise<{ voice: string; warning?: string }> {
  if (voiceSampleSeconds(options.audio) === undefined)
    throw new Error(liveMessage('voice.sampleInvalid'));
  const url = voiceEnrollmentUrl(options.endpoint);
  let response: Response;
  let body: unknown;
  try {
    response = await request(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen-voice-enrollment',
        input: {
          action: 'create',
          target_model: options.model,
          preferred_name: `live_${randomUUID().slice(0, 8)}`,
          audio: {
            data: `data:audio/wav;base64,${Buffer.from(options.audio).toString('base64')}`,
          },
        },
      }),
      signal: AbortSignal.any([
        AbortSignal.timeout(VOICE_CLONE_TIMEOUT_MS),
        ...(options.signal ? [options.signal] : []),
      ]),
    });
    if (!response.body) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(part.value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // A transport failure after upload cannot prove that no voice was created.
    throw new Error(liveMessage('voice.cloneUncertain'));
  }
  const result =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new Error(liveMessage('voice.cloneAccess'));
    if (
      response.status === 404 ||
      /target_model|not support/iu.test(String(result['message'] ?? ''))
    )
      throw new Error(liveMessage('voice.cloneUnsupported'));
    if (/Audio\.|InvalidParameter/iu.test(String(result['code'] ?? '')))
      throw new Error(liveMessage('voice.cloneAudioRejected'));
    throw new Error(liveMessage('voice.cloneFailed'));
  }
  const output = result['output'] as Record<string, unknown> | undefined;
  if (
    !output ||
    !isVoiceId(output['voice']) ||
    (output['target_model'] !== undefined &&
      output['target_model'] !== options.model)
  )
    throw new Error(liveMessage('voice.cloneUncertain'));
  return {
    voice: output['voice'],
    ...(output['fallback_mode'] === true
      ? { warning: liveMessage('voice.cloneQuality') }
      : {}),
  };
}

/** No mutation retries. Duplicate deliveries share one result; samples are not cached. */
export class VoiceCloneRequests {
  private entries = new Map<
    string,
    { fingerprint: string; result: Promise<VoiceCloneOutcome> }
  >();
  busy = false;
  run(
    id: string,
    identity: string,
    audio: Uint8Array,
    action: () => Promise<VoiceCloneOutcome>,
  ): Promise<VoiceCloneOutcome> {
    const fingerprint = createHash('sha256')
      .update(identity)
      .update(audio)
      .digest('hex');
    const existing = this.entries.get(id);
    if (existing)
      return existing.fingerprint === fingerprint
        ? existing.result
        : Promise.resolve({ ok: false, error: liveMessage('voice.invalid') });
    if (this.busy)
      return Promise.resolve({
        ok: false,
        error: liveMessage('voice.creating'),
      });
    this.busy = true;
    const result = Promise.resolve()
      .then(action)
      .catch((): VoiceCloneOutcome => ({
        ok: false,
        error: liveMessage('voice.cloneFailed'),
      }))
      .finally(() => {
        this.busy = false;
      });
    this.entries.set(id, { fingerprint, result });
    if (this.entries.size > 16)
      this.entries.delete(this.entries.keys().next().value!);
    return result;
  }
}
