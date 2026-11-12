/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerOptions, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MobileError, MobileTasks } from './tasks.js';

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new MobileError(415, 'json_required');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 32_768) throw new MobileError(413, 'request_too_large');
    chunks.push(Buffer.from(chunk));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MobileError(400, 'invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new MobileError(400, 'invalid_json');
  return parsed as Record<string, unknown>;
}

/** Separate HTTPS listener. Never exposes desktop Host, config, quit or shell routes. */
export class MobileServer {
  private code = randomBytes(32).toString('base64url');
  readonly deviceToken: string;
  private readonly server: Server;
  private pairingDeadline: number;
  private readonly pairingLifetimeMs: number;
  private paired = false;
  private stopping = false;

  constructor(
    private readonly tasks: MobileTasks,
    tls: Pick<ServerOptions, 'key' | 'cert'>,
    options: {
      token?: string;
      saveToken?: (token: string) => void;
      pairingLifetimeMs?: number;
      onTransportEvent?: (code: string) => void;
    } = {},
  ) {
    // Test fixtures may span a cold Xcode build; the CLI uses fifteen minutes.
    this.pairingLifetimeMs = options.pairingLifetimeMs ?? 15 * 60_000;
    this.pairingDeadline = Date.now() + this.pairingLifetimeMs;
    this.deviceToken = options.token ?? randomBytes(32).toString('base64url');
    this.server = createServer(
      { ...tls, minVersion: 'TLSv1.2' },
      (req, res) => {
        void this.route(req, res, options.saveToken).catch((error: unknown) => {
          this.reply(res, error instanceof MobileError ? error.status : 502, {
            error:
              error instanceof MobileError
                ? error.code
                : 'agent_operation_failed',
          });
        });
      },
    );
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
    this.server.maxHeadersCount = 32;
    const transport = (code: string) => {
      try {
        options.onTransportEvent?.(code);
      } catch {
        /* diagnostic only */
      }
    };
    this.server.on('secureConnection', () => transport('tls_ready'));
    this.server.on('tlsClientError', (error: NodeJS.ErrnoException) =>
      transport(error.code ?? 'tls_failed'),
    );
  }

  private reply(res: ServerResponse, status: number, data: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(data));
  }

  get pairingCode(): string {
    return this.code;
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    saveToken?: (token: string) => void,
  ): Promise<void> {
    if (this.stopping) throw new MobileError(503, 'service_stopping');
    // This is a native client API, never a browser API. No CORS or redirects.
    if (req.headers.origin || req.headers['sec-fetch-site'])
      throw new MobileError(403, 'browser_not_allowed');
    if (req.url?.includes('?')) throw new MobileError(400, 'query_not_allowed');
    if (req.method === 'POST' && req.url === '/v1/pair') {
      const input = await body(req);
      if (this.paired || Date.now() > this.pairingDeadline)
        throw new MobileError(410, 'pairing_expired');
      if (
        typeof input['code'] !== 'string' ||
        !equal(input['code'], this.pairingCode)
      )
        throw new MobileError(401, 'pairing_denied');
      saveToken?.(this.deviceToken);
      this.paired = true;
      this.reply(res, 200, {
        token: this.deviceToken,
        runId: this.tasks.runId,
      });
      return;
    }
    const authorization = req.headers.authorization;
    if (
      !authorization?.startsWith('Bearer ') ||
      !equal(authorization.slice(7), this.deviceToken)
    )
      throw new MobileError(401, 'unauthorized');
    if (req.method === 'GET' && req.url === '/v1/state') {
      this.reply(res, 200, this.tasks.snapshot());
      return;
    }
    // Mutations are bound to the Mac process that the phone actually observed.
    if (req.headers['x-live-run-id'] !== this.tasks.runId)
      throw new MobileError(409, 'server_restarted');
    if (req.method === 'POST' && req.url === '/v1/pairing') {
      const address = req.socket.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? ''))
        throw new MobileError(403, 'local_only');
      await body(req);
      this.code = randomBytes(32).toString('base64url');
      this.pairingDeadline = Date.now() + this.pairingLifetimeMs;
      this.paired = false;
      this.reply(res, 200, { code: this.code });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/tasks') {
      const input = await body(req);
      if (
        !['id', 'backend', 'project', 'text'].every(
          (key) => typeof input[key] === 'string',
        )
      )
        throw new MobileError(400, 'invalid_task');
      this.reply(
        res,
        202,
        this.tasks.submit({
          id: input['id'] as string,
          backend: input['backend'] as string,
          project: input['project'] as string,
          text: input['text'] as string,
        }),
      );
      return;
    }
    const match = /^\/v1\/tasks\/([a-f0-9-]{36})\/(cancel|permission)$/u.exec(
      req.url ?? '',
    );
    if (req.method === 'POST' && match) {
      const input = await body(req);
      const id = match[1]!;
      if (match[2] === 'cancel')
        this.reply(res, 200, await this.tasks.cancel(id));
      else {
        if (
          typeof input['requestId'] !== 'string' ||
          (input['decision'] !== 'allow' && input['decision'] !== 'deny')
        )
          throw new MobileError(400, 'invalid_permission');
        this.reply(
          res,
          200,
          await this.tasks.permission(
            id,
            input['requestId'],
            input['decision'],
          ),
        );
      }
      return;
    }
    throw new MobileError(404, 'not_found');
  }

  async listen(port = 0, host = '0.0.0.0'): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Mobile listener unavailable');
    return address.port;
  }

  async close(): Promise<void> {
    this.stopping = true;
    try {
      await this.tasks.close();
    } finally {
      this.server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        this.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}
