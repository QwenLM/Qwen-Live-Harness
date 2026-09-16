/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendConfig, LiveConfig } from './config.js';
import { LIVE_HOST_PROTOCOL_VERSION } from './host/types.js';
import {
  diagnoseQwenPeers,
  formatPeerDiagnostics,
} from './peer-diagnostics.js';
import type { SessionRecord } from './vendor/qwen-code-peer/index.js';
import {
  readPidNamespaceId,
  readProcStartToken,
} from './vendor/qwen-code-peer/identity.js';

const FEATURES = [
  'session_create',
  'session_prompt',
  'session_events',
  'session_cancel',
  'session_permission_vote',
  'session_mid_turn_message_mutation',
];
const CONTROLLER_TOKEN = `qpc_${'a'.repeat(64)}`;
const SERVE_TOKEN = 'private-serve-token';
const LIVE_TOKEN = 'private-live-token';
const NONCE = 'a'.repeat(32);
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp('/tmp/qlh-peer-doctor-');
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'qwen');
  const discoveryDir = path.join(root, 'live');
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  const backend: Extract<BackendConfig, { kind: 'qwen-code' }> = {
    name: 'qwen',
    kind: 'qwen-code',
    baseUrl: 'http://127.0.0.1:4170',
    token: SERVE_TOKEN,
    isDefault: true,
    peerDiscovery: {
      qwenHome: home,
      controllerToken: CONTROLLER_TOKEN,
      reports: true,
    },
  };
  const config: Pick<LiveConfig, 'backends' | 'discoveryDir'> = {
    discoveryDir,
    backends: [backend],
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ features: FEATURES }),
  );
  return { root, home, discoveryDir, backend, config, fetch };
}

function record(index = 0): SessionRecord {
  return {
    schemaVersion: 1,
    pid: process.pid,
    procStart: readProcStartToken(process.pid),
    pidNs: readPidNamespaceId(),
    sessionId: `session-${index}`,
    cwd: '/private/workspace',
    name: 'private-session-name',
    startedAt: 1000 + index,
    qwenVersion: '0.23.3',
    kind: 'tui',
    ipcPath: `/tmp/doctor-peer-${index}.sock`,
    ipcToken: 'private-peer-token',
  };
}

async function discoveryFile(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
) {
  await mkdir(path.join(f.discoveryDir, 'run'), {
    recursive: true,
    mode: 0o700,
  });
  const file = path.join(f.discoveryDir, 'run', 'daemon.json');
  await writeFile(
    file,
    JSON.stringify({
      url: 'http://127.0.0.1:8123',
      token: LIVE_TOKEN,
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      pid: process.pid,
      instanceNonce: NONCE,
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return file;
}

describe('read-only Qwen peer diagnostics', () => {
  it('separates configuration, observed versions, socket reachability and unverified grant/call state', async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.home, 'settings.json'),
      '{"agents":{"crossSessionMessaging":true,"crossSessionInbound":"hold"}}',
    );
    const records = [
      record(0),
      record(1),
      { ...record(2), kind: 'serve' },
      { ...record(3), ipcPath: undefined, qwenVersion: 'secret-version-token' },
    ];
    const readRecords = vi.fn(async () => records);
    const probeSocket = vi.fn(async (socket: string) =>
      socket.endsWith('0.sock') ? ('alive' as const) : ('unknown' as const),
    );
    const result = await diagnoseQwenPeers(f.config, {
      fetch: f.fetch,
      readRecords,
      probeSocket,
    });
    expect(result).toMatchObject({
      hasErrors: false,
      daemon: { state: 'missing', call: 'unknown', outputMuted: 'unknown' },
    });
    expect(result.backends[0]).toMatchObject({
      name: 'qwen',
      serve: { state: 'ready', location: 'local' },
      peers: {
        home: 1,
        settings: 'enabled',
        inbound: 'hold',
        registry: 'ready',
        liveRecords: 4,
        terminals: 3,
        terminalInboxes: 2,
        probed: 2,
        reachable: 1,
        unknown: 1,
        controller: 'configured-unverified',
        reports: true,
        versions: ['0.23.3'],
      },
    });
    expect(probeSocket).toHaveBeenCalledTimes(2);
    expect(f.fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4170/capabilities'),
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        headers: { Authorization: `Bearer ${SERVE_TOKEN}` },
      }),
    );
    for (const language of ['en', 'zh-CN'] as const) {
      const formatted = formatPeerDiagnostics(result, language);
      expect(formatted).toContain(language === 'en' ? 'read-only' : '只读');
      expect(formatted).toContain(
        language === 'en' ? 'grant validity unverified' : '授权有效性未验证',
      );
      expect(formatted).toContain(
        language === 'en' ? 'do not automatically resend' : '不要自动重发',
      );
      expect(formatted).not.toMatch(/\{\w+\}/u);
      for (const secret of [
        CONTROLLER_TOKEN,
        SERVE_TOKEN,
        LIVE_TOKEN,
        f.home,
        f.backend.baseUrl,
        'private-peer-token',
        'private-session-name',
        '/private/workspace',
        'secret-version-token',
      ]) {
        expect(formatted).not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain(secret);
      }
    }
  });

  it('treats absent optional configuration and a never-started call as informational', async () => {
    const f = await fixture();
    f.backend.peerDiscovery = { qwenHome: path.join(f.root, 'not-created') };
    const before = await readdir(f.root);
    const result = await diagnoseQwenPeers(f.config, { fetch: f.fetch });
    expect(result.hasErrors).toBe(false);
    expect(result.backends[0]!.peers).toMatchObject({
      settings: 'missing',
      registry: 'missing',
      controller: 'missing',
      reports: false,
    });
    expect(await readdir(f.root)).toEqual(before);
    f.backend.peerDiscovery = undefined;
    const disabled = await diagnoseQwenPeers(f.config, { fetch: f.fetch });
    expect(disabled.backends[0]).not.toHaveProperty('peers');
    expect(disabled.hasErrors).toBe(false);
    f.config.backends = [
      {
        name: 'acp',
        kind: 'acp',
        command: 'not-executed',
        args: [],
        env: { SECRET: 'never-exposed' },
        isDefault: true,
      },
    ];
    f.fetch.mockClear();
    expect(
      (await diagnoseQwenPeers(f.config, { fetch: f.fetch })).backends,
    ).toEqual([{ name: 'acp', kind: 'acp' }]);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('reads Qwen JSON comments and settings symlinks while keeping overrides explicitly unverified', async () => {
    const f = await fixture();
    const source = path.join(f.root, 'settings-source.json');
    await writeFile(
      source,
      '{/* comment */"agents":{"crossSessionMessaging":false,"crossSessionInbound":"refuse"},"url":"http://example.invalid/*literal*/" // comment\n}',
    );
    await symlink(source, path.join(f.home, 'settings.json'));
    const result = await diagnoseQwenPeers(f.config, { fetch: f.fetch });
    expect(result.backends[0]!.peers).toMatchObject({
      settings: 'disabled',
      inbound: 'refuse',
    });
    expect(result.hints).toContain('settingsScope');
    expect(result.hasErrors).toBe(false);
  });

  it.each([401, 403])(
    'distinguishes HTTP %s authentication rejection without printing the response body',
    async (status) => {
      const f = await fixture();
      f.fetch.mockResolvedValue(
        new Response(`${SERVE_TOKEN} /private/error`, { status }),
      );
      const result = await diagnoseQwenPeers(f.config, { fetch: f.fetch });
      expect(result.backends[0]!.serve).toMatchObject({
        state: 'auth-rejected',
      });
      expect(result.hasErrors).toBe(true);
      expect(JSON.stringify(result)).not.toContain(SERVE_TOKEN);
      expect(formatPeerDiagnostics(result, 'en')).not.toContain(
        '/private/error',
      );
    },
  );

  it('distinguishes missing capabilities from an unreachable qwen serve', async () => {
    const f = await fixture();
    f.fetch.mockResolvedValueOnce(
      Response.json({
        features: FEATURES.slice(0, -1),
        qwenCodeVersion: '0.23.3',
      }),
    );
    let result = await diagnoseQwenPeers(f.config, { fetch: f.fetch });
    expect(result.backends[0]!.serve).toMatchObject({
      state: 'missing-features',
      missingFeatures: ['session_mid_turn_message_mutation'],
      version: '0.23.3',
    });
    expect(result.hasErrors).toBe(true);
    f.fetch.mockRejectedValueOnce(
      new Error(`${SERVE_TOKEN} ECONNREFUSED /private`),
    );
    result = await diagnoseQwenPeers(f.config, { fetch: f.fetch });
    expect(result.backends[0]!.serve).toMatchObject({ state: 'unreachable' });
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(result.hints).toContain('serveRequired');
  });

  it('does not contact remote services or follow redirects with configured credentials', async () => {
    const f = await fixture();
    f.backend.baseUrl = 'https://remote.invalid/prefix';
    let result = await diagnoseQwenPeers(f.config, { fetch: f.fetch });
    expect(result.backends[0]!.serve).toMatchObject({
      state: 'remote-unverified',
      location: 'remote',
    });
    expect(result.hasErrors).toBe(false);
    expect(f.fetch).not.toHaveBeenCalled();
    f.backend.baseUrl = 'http://127.0.0.1:4170/prefix/';
    f.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://remote.invalid/secret' },
      }),
    );
    result = await diagnoseQwenPeers(f.config, { fetch: f.fetch });
    expect(result.backends[0]!.serve).toMatchObject({ state: 'invalid' });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(String(f.fetch.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:4170/prefix/capabilities',
    );
    expect(f.fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
    f.backend.baseUrl = 'http://user:private-url-token@127.0.0.1:4170';
    result = await diagnoseQwenPeers(f.config, { fetch: f.fetch });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('private-url-token');
  });

  it('bounds HTTP body size and elapsed time, including a stalled body stream', async () => {
    const f = await fixture();
    f.fetch.mockResolvedValueOnce(new Response('x'.repeat(65_537)));
    expect(
      (await diagnoseQwenPeers(f.config, { fetch: f.fetch })).backends[0]!.serve
        ?.state,
    ).toBe('invalid');
    const cancelled = vi.fn();
    f.fetch.mockResolvedValueOnce(
      new Response(new ReadableStream({ start() {}, cancel: cancelled })),
    );
    const result = await diagnoseQwenPeers(f.config, {
      fetch: f.fetch,
      timeoutMs: 10,
    });
    expect(result.backends[0]!.serve?.state).toBe('unreachable');
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
    expect(f.fetch.mock.calls.at(-1)![1]!.signal!.aborted).toBe(true);
  });

  it('bounds registry reads before invoking the SDK and bounds probes globally', async () => {
    const f = await fixture();
    await Promise.all(
      Array.from({ length: 129 }, (_, index) =>
        writeFile(path.join(f.home, 'sessions', `entry-${index}`), ''),
      ),
    );
    const readRecords = vi.fn(async () =>
      Array.from({ length: 40 }, (_, index) => record(index)),
    );
    const probeSocket = vi.fn(async () => 'alive' as const);
    let result = await diagnoseQwenPeers(f.config, {
      fetch: f.fetch,
      readRecords,
      probeSocket,
    });
    expect(result.backends[0]!.peers?.registry).toBe('truncated');
    expect(readRecords).not.toHaveBeenCalled();
    expect(probeSocket).not.toHaveBeenCalled();
    await rm(path.join(f.home, 'sessions'), { recursive: true });
    await mkdir(path.join(f.home, 'sessions'));
    result = await diagnoseQwenPeers(f.config, {
      fetch: f.fetch,
      readRecords,
      probeSocket,
    });
    expect(probeSocket).toHaveBeenCalledTimes(32);
    expect(result.backends[0]!.peers).toMatchObject({
      terminalInboxes: 40,
      probed: 32,
      omitted: 8,
    });
    f.config.backends.push({
      ...f.backend,
      name: 'same-home',
      isDefault: false,
    });
    readRecords.mockClear();
    probeSocket.mockClear();
    result = await diagnoseQwenPeers(f.config, {
      fetch: f.fetch,
      readRecords,
      probeSocket,
    });
    expect(readRecords).toHaveBeenCalledTimes(1);
    expect(probeSocket).toHaveBeenCalledTimes(32);
    expect(result.backends[1]!.peers?.home).toBe(1);
  });

  it('limits backends and homes and avoids peer transport operations on Windows', async () => {
    const f = await fixture();
    f.config.backends = Array.from({ length: 17 }, (_, index) => ({
      ...f.backend,
      name: `qwen-${index}`,
      isDefault: index === 0,
      peerDiscovery: { qwenHome: path.join(f.root, `home-${index}`) },
    }));
    let result = await diagnoseQwenPeers(f.config, { fetch: f.fetch });
    expect(result.backends).toHaveLength(16);
    expect(result.omittedBackends).toBe(1);
    expect(result.backends[8]!.peers?.registry).toBe('truncated');
    const readRecords = vi.fn(async () => [record()]);
    const probeSocket = vi.fn(async () => 'alive' as const);
    f.config.backends = [f.backend];
    result = await diagnoseQwenPeers(f.config, {
      platform: 'win32',
      fetch: f.fetch,
      readRecords,
      probeSocket,
    });
    expect(result.platform).toBe('unsupported');
    expect(result.backends[0]!.peers?.registry).toBe('unsupported');
    expect(readRecords).not.toHaveBeenCalled();
    expect(probeSocket).not.toHaveBeenCalled();
  });

  it('reports malformed/unreadable configuration without inspecting or validating controller grants', async () => {
    const f = await fixture();
    await writeFile(path.join(f.home, 'settings.json'), '{broken');
    await writeFile(
      path.join(f.home, 'peer-controllers.json'),
      'not-read: private grant data',
    );
    const readRecords = vi.fn(async () => {
      throw new Error(`${CONTROLLER_TOKEN} /private/registry`);
    });
    const result = await diagnoseQwenPeers(f.config, {
      fetch: f.fetch,
      readRecords,
    });
    expect(result.backends[0]!.peers).toMatchObject({
      settings: 'invalid',
      registry: 'unreadable',
      controller: 'configured-unverified',
    });
    expect(result.hasErrors).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CONTROLLER_TOKEN);
    expect(
      await readFile(path.join(f.home, 'peer-controllers.json'), 'utf8'),
    ).toBe('not-read: private grant data');
  });

  it('verifies an existing daemon identity and only reads Host installation, never claiming call readiness', async () => {
    const f = await fixture();
    await discoveryFile(f);
    f.fetch.mockImplementation(async (url, options) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/capabilities')
        return Response.json({ features: FEATURES });
      expect(options?.headers).toEqual({
        Authorization: `Bearer ${LIVE_TOKEN}`,
        'x-qwen-live-harness-nonce': NONCE,
      });
      if (pathname === '/live/instance')
        return Response.json({
          pid: process.pid,
          instanceNonce: NONCE,
          protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
          version: '0.4.0',
          secret: LIVE_TOKEN,
        });
      if (pathname === '/live/setup')
        return Response.json({
          state: 'installed',
          message: 'private setup detail',
          version: '0.4.0',
        });
      throw new Error('Unexpected route');
    });
    const result = await diagnoseQwenPeers(f.config, { fetch: f.fetch });
    expect(result.daemon).toEqual({
      state: 'ready',
      host: 'installed',
      call: 'unknown',
      outputMuted: 'unknown',
      version: '0.4.0',
    });
    expect(result.hasErrors).toBe(false);
    expect(
      f.fetch.mock.calls.every(([, options]) => options?.method === 'GET'),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private setup detail');
  });

  it('rejects unsafe discovery routes, stale instances and mismatched protocols without a setup request', async () => {
    const f = await fixture();
    f.config.backends = [];
    await discoveryFile(f, { url: 'http://remote.invalid' });
    expect(
      (await diagnoseQwenPeers(f.config, { fetch: f.fetch })).daemon.state,
    ).toBe('invalid');
    expect(f.fetch).not.toHaveBeenCalled();
    await discoveryFile(f, { protocolVersion: LIVE_HOST_PROTOCOL_VERSION + 1 });
    expect(
      (await diagnoseQwenPeers(f.config, { fetch: f.fetch })).daemon.state,
    ).toBe('protocol-mismatch');
    expect(f.fetch).not.toHaveBeenCalled();
    await discoveryFile(f);
    f.fetch.mockResolvedValueOnce(
      Response.json({
        pid: process.pid,
        instanceNonce: 'stale',
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      }),
    );
    const stale = await diagnoseQwenPeers(f.config, { fetch: f.fetch });
    expect(stale.daemon.state).toBe('stale');
    expect(stale.hasErrors).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not use credentials from a public or symlinked discovery file', async () => {
    const f = await fixture();
    f.config.backends = [];
    const file = await discoveryFile(f);
    await chmod(file, 0o644);
    expect(
      (await diagnoseQwenPeers(f.config, { fetch: f.fetch, platform: 'linux' }))
        .daemon.state,
    ).toBe('invalid');
    expect(f.fetch).not.toHaveBeenCalled();
    await chmod(file, 0o600);
    const linked = path.join(f.root, 'linked-discovery');
    await mkdir(path.join(linked, 'run'), { recursive: true });
    await symlink(file, path.join(linked, 'run', 'daemon.json'));
    f.config.discoveryDir = linked;
    expect(
      (await diagnoseQwenPeers(f.config, { fetch: f.fetch })).daemon.state,
    ).toBe('invalid');
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('uses real public read endpoints and a socket dial without writing the home, registering, or sending frames', async () => {
    const f = await fixture();
    const requests: string[] = [];
    const server = createHttpServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('content-type', 'application/json');
      if (request.url === '/capabilities') {
        expect(request.headers.authorization).toBe(`Bearer ${SERVE_TOKEN}`);
        response.end(JSON.stringify({ features: FEATURES }));
      } else if (request.url === '/live/instance') {
        expect(request.headers.authorization).toBe(`Bearer ${LIVE_TOKEN}`);
        expect(request.headers['x-qwen-live-harness-nonce']).toBe(NONCE);
        response.end(
          JSON.stringify({
            pid: process.pid,
            instanceNonce: NONCE,
            protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
          }),
        );
      } else if (request.url === '/live/setup')
        response.end('{"state":"installed"}');
      else {
        response.statusCode = 404;
        response.end('{}');
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing server address');
    f.backend.baseUrl = `http://127.0.0.1:${address.port}`;
    const socketPath = path.join(f.root, 'peer.sock');
    const bytes = vi.fn();
    const socketServer = createSocketServer((socket) => {
      socket.on('data', bytes);
      socket.on('error', () => {});
      socket.on('end', () => socket.end());
    });
    await new Promise<void>((resolve) =>
      socketServer.listen(socketPath, resolve),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          socketServer.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const registryFile = path.join(f.home, 'sessions', `${process.pid}.json`);
    await writeFile(
      registryFile,
      JSON.stringify({ ...record(), ipcPath: socketPath }),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(f.home, 'settings.json'),
      '{"agents":{"crossSessionMessaging":true}}',
    );
    const discovery = await discoveryFile(f, { url: f.backend.baseUrl });
    const before = await Promise.all(
      [registryFile, discovery].map(async (file) => ({
        contents: await readFile(file, 'utf8'),
        mtime: (await stat(file)).mtimeMs,
      })),
    );
    const result = await diagnoseQwenPeers(f.config);
    expect(result.backends[0]!.peers).toMatchObject({
      reachable: 1,
      probed: 1,
      liveRecords: 1,
    });
    expect(result.daemon.state).toBe('ready');
    expect(result.hasErrors).toBe(false);
    expect(bytes).not.toHaveBeenCalled();
    expect(requests.sort()).toEqual([
      'GET /capabilities',
      'GET /live/instance',
      'GET /live/setup',
    ]);
    expect(await readdir(path.join(f.home, 'sessions'))).toEqual([
      `${process.pid}.json`,
    ]);
    expect(
      await Promise.all(
        [registryFile, discovery].map(async (file) => ({
          contents: await readFile(file, 'utf8'),
          mtime: (await stat(file)).mtimeMs,
        })),
      ),
    ).toEqual(before);
  });
});
