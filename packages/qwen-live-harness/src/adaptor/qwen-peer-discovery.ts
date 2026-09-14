/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  PeerEndpoint,
  resolveQwenHome,
  type PeerSessionSummary,
} from '../vendor/qwen-code-peer/index.js';
import type { SessionSummary } from './types.js';

export interface PeerDiscoveryEndpoint {
  list(): Promise<PeerSessionSummary[]>;
  close(): Promise<void>;
}

export interface QwenPeerDiscoveryOptions {
  qwenHome: string;
}

export type PeerEndpointFactory = (options: {
  name: string;
  qwenHome: string;
}) => Promise<PeerDiscoveryEndpoint>;

// Display labels remain untrusted text; remove terminal/bidi control codes.
function label(value: string, maxLength = 240): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim()
    .slice(0, maxLength)
    .replace(/[\uD800-\uDBFF]$/u, '');
}

/** A call-scoped, receive-disabled endpoint. No controller token or send API. */
export class QwenPeerDiscovery {
  private readonly qwenHome: string;
  private requestedCall?: string;
  private current?: { callId: string; endpoint: PeerDiscoveryEndpoint };
  private tail: Promise<void> = Promise.resolve();

  constructor(
    options: QwenPeerDiscoveryOptions,
    private readonly adaptor: string,
    private readonly open: PeerEndpointFactory = (options) =>
      PeerEndpoint.start(options),
  ) {
    this.qwenHome = resolveQwenHome(options.qwenHome);
  }

  start(callId: string): Promise<void> {
    this.requestedCall = callId;
    return this.serialize(async () => {
      if (this.current?.callId === callId) return;
      await this.closeCurrent();
      if (this.requestedCall !== callId) return;
      // Omitting onMessage makes the SDK answer application messages refused.
      const endpoint = await this.open({
        name: `live-${this.adaptor}`,
        qwenHome: this.qwenHome,
      });
      this.current = { callId, endpoint };
      if (this.requestedCall !== callId) {
        await this.closeCurrent();
        return;
      }
    });
  }

  stop(callId: string): Promise<void> {
    if (this.requestedCall === callId) this.requestedCall = undefined;
    return this.serialize(async () => {
      if (this.current?.callId === callId) await this.closeCurrent();
    });
  }

  close(): Promise<void> {
    this.requestedCall = undefined;
    return this.serialize(() => this.closeCurrent());
  }

  async list(): Promise<SessionSummary[]> {
    const current = this.current;
    if (!current || this.requestedCall !== current.callId) return [];
    const peers = await current.endpoint.list();
    if (this.current !== current || this.requestedCall !== current.callId)
      return [];
    const sessions = new Map<string, SessionSummary>();
    for (const peer of peers) {
      // kind is informational, not authentication. Only terminal records
      // belong in this catalog; serve/headless retain their control routes.
      if (peer.kind !== 'tui' || !peer.sessionId || peer.sessionId.length > 256)
        continue;
      const id = `qwen-peer:${createHash('sha256')
        .update(
          JSON.stringify([
            this.qwenHome,
            peer.sessionId,
            peer.pid,
            peer.startedAt,
          ]),
        )
        .digest('hex')}`;
      sessions.set(id, {
        handle: { id, adaptor: this.adaptor, readOnly: true },
        label: label(peer.address),
        cwd: label(peer.cwd, 4096),
        state: 'unknown',
        discovery: {
          source: 'terminal',
          sessionId: peer.sessionId,
          address: label(peer.address),
        },
      });
    }
    return [...sessions.values()];
  }

  private serialize(action: () => Promise<void>): Promise<void> {
    const operation = this.tail.then(action);
    this.tail = operation.catch(() => {});
    return operation;
  }

  private async closeCurrent(): Promise<void> {
    const current = this.current;
    if (!current) return;
    await current.endpoint.close();
    if (this.current === current) this.current = undefined;
  }
}
