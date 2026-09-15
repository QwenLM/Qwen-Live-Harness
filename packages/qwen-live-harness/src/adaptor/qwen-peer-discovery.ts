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
import { QwenPeerReports, peerReportLabel } from './qwen-peer-reports.js';
import type {
  BackendHandle,
  InstructionDelivery,
  InstructionReceipt,
  PeerReportContext,
  PeerSessionReport,
  SessionSummary,
} from './types.js';

export interface PeerDiscoveryEndpoint {
  readonly name?: string;
  list(): Promise<PeerSessionSummary[]>;
  close(): Promise<void>;
  createReportContext?(target: BackendHandle): PeerReportContext | undefined;
}

export interface QwenPeerDiscoveryOptions {
  qwenHome: string;
  controllerToken?: string;
  reports?: boolean;
}

export type PeerEndpointFactory = (options: {
  name: string;
  qwenHome: string;
}) => Promise<PeerDiscoveryEndpoint>;

/** Call-scoped discovery with optional, separately tracked text instructions. */
export class QwenPeerDiscovery {
  private readonly qwenHome: string;
  private readonly controllerToken?: string;
  private readonly reportsEnabled: boolean;
  private requestedCall?: string;
  private current?: {
    callId: string;
    endpoint: PeerDiscoveryEndpoint;
    owner: object;
  };
  private controller?: QwenPeerController;
  private readonly listeners = new Set<() => void>();
  private readonly reportListeners = new Set<
    (report: PeerSessionReport) => boolean
  >();
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
    this.reportsEnabled = options.reports ?? false;
  }

  start(callId: string): Promise<void> {
    this.requestedCall = callId;
    return this.serialize(async () => {
      if (this.current?.callId === callId) return;
      await this.closeCurrent();
      if (this.requestedCall !== callId) return;
      this.controller = undefined;
      this.notify();
      const owner = { ready: false };
      const endpoint = this.reportsEnabled
        ? await QwenPeerReports.start({
            qwenHome: this.qwenHome,
            adaptor: this.adaptor,
            callId,
            isActive: () =>
              owner.ready &&
              this.current?.owner === owner &&
              this.requestedCall === callId,
            hasSink: () => this.reportListeners.size > 0,
            onReport: (report) => {
              const projected =
                report.sourceSession && this.controllerToken === undefined
                  ? {
                      ...report,
                      sourceSession: {
                        ...report.sourceSession,
                        readOnly: true as const,
                      },
                    }
                  : report;
              for (const listener of this.reportListeners) {
                if (listener(projected) === true) return true;
              }
              return false;
            },
          })
        : // Omitting onMessage makes the SDK refuse reports unless opted in.
          await this.open({
            name: `live-${this.adaptor}`,
            qwenHome: this.qwenHome,
          });
      this.current = { callId, endpoint, owner };
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
            name: endpoint.name ?? `live-${this.adaptor}`,
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
      owner.ready =
        this.current?.owner === owner && this.requestedCall === callId;
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

  subscribeReports(
    listener: (report: PeerSessionReport) => boolean,
  ): () => void {
    this.reportListeners.add(listener);
    return () => this.reportListeners.delete(listener);
  }

  createReportContext(target: BackendHandle): PeerReportContext | undefined {
    const current = this.current;
    if (!current || current.callId !== this.requestedCall) return undefined;
    return current.endpoint.createReportContext?.(target);
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
        label: peerReportLabel(peer.address),
        cwd: peerReportLabel(peer.cwd, 4096),
        state: 'unknown',
        discovery: {
          source: 'terminal',
          sessionId: peer.sessionId,
          address: peerReportLabel(peer.address),
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
