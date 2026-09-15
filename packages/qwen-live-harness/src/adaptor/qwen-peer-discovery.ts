/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PeerEndpoint,
  resolveQwenHome,
  type PeerSessionSummary,
} from '../vendor/qwen-code-peer/index.js';
import {
  QwenPeerController,
  qwenPeerHandleId,
  type QwenPeerControllerDependencies,
} from './qwen-peer-controller.js';
import type {
  BackendHandle,
  InstructionDelivery,
  InstructionReceipt,
  SessionSummary,
} from './types.js';

export interface PeerDiscoveryEndpoint {
  list(): Promise<PeerSessionSummary[]>;
  close(): Promise<void>;
}

export interface QwenPeerDiscoveryOptions {
  qwenHome: string;
  controllerToken?: string;
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

/** Call-scoped discovery with optional, separately tracked text instructions. */
export class QwenPeerDiscovery {
  private readonly qwenHome: string;
  private readonly controllerToken?: string;
  private requestedCall?: string;
  private current?: { callId: string; endpoint: PeerDiscoveryEndpoint };
  private controller?: QwenPeerController;
  private readonly listeners = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    options: QwenPeerDiscoveryOptions,
    private readonly adaptor: string,
    private readonly open: PeerEndpointFactory = (options) =>
      PeerEndpoint.start(options),
    private readonly controllerDependencies: QwenPeerControllerDependencies = {},
  ) {
    this.qwenHome = resolveQwenHome(options.qwenHome);
    this.controllerToken = options.controllerToken;
  }

  start(callId: string): Promise<void> {
    this.requestedCall = callId;
    return this.serialize(async () => {
      if (this.current?.callId === callId) return;
      await this.closeCurrent();
      if (this.requestedCall !== callId) return;
      this.controller = undefined;
      this.notify();
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
      if (this.controllerToken !== undefined) {
        const current = this.current;
        this.controller = new QwenPeerController(
          {
            qwenHome: this.qwenHome,
            adaptor: this.adaptor,
            name: `live-${this.adaptor}`,
            controllerToken: this.controllerToken,
            isActive: () =>
              this.current === current && this.requestedCall === callId,
            onChange: () => this.notify(),
          },
          this.controllerDependencies,
        );
        try {
          await this.controller.start();
        } catch {
          await this.closeCurrent();
          throw new Error(
            'Terminal instruction delivery could not be started. Check the controller configuration.',
          );
        }
        if (this.requestedCall !== callId) await this.closeCurrent();
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

  send(handle: BackendHandle, text: string): Promise<InstructionReceipt> {
    if (!this.controller) {
      return Promise.resolve({
        status: 'rejected',
        note: 'Terminal instructions require a configured controller token and an active voice call.',
      });
    }
    return this.controller.send(handle, text);
  }

  deliveries(): InstructionDelivery[] {
    return this.controller?.deliveries() ?? [];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
      const id = qwenPeerHandleId(this.qwenHome, peer);
      sessions.set(id, {
        handle: {
          id,
          adaptor: this.adaptor,
          instructionOnly: true,
          ...(this.controllerToken === undefined
            ? { readOnly: true as const }
            : {}),
        },
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
    await this.controller?.close();
    await current.endpoint.close();
    if (this.current === current) this.current = undefined;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* observers do not own the endpoint */
      }
    }
  }
}
