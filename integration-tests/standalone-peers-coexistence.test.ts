/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** Public SDK peers and a real ACP child; providers and Host are local fixtures. */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  PeerEndpoint,
  readLiveSessionRecords,
  sessionRegistryDir,
} from '../packages/qwen-live-harness/src/vendor/qwen-code-peer/index.js';
import type { SubagentsControlResult } from '../packages/qwen-live-harness/src/subagents/types.js';
import {
  contextTextOf,
  functionCallOutputOf,
  startFakeDashScopeServer,
  type FakeDashScopeConnection,
  type FakeDashScopeServer,
} from './fake-dashscope-server.js';
import {
  FakeHost,
  readLiveDiscovery,
  spawnQwenLiveHarness,
  startLiveCall,
  waitForLiveResponseAfter,
  type SpawnedQwenLiveHarness,
} from './qwen-live-harness.js';

const FEATURES = [
  'session_create',
  'session_prompt',
  'session_events',
  'session_cancel',
  'session_permission_vote',
  'session_mid_turn_message_mutation',
];
const describePeers = process.platform === 'win32' ? describe.skip : describe;

describePeers(
  'standalone peer reports coexist with the default ACP backend',
  () => {
    let temporary: string;
    let qwenHome: string;
    let dataDir: string;
    let discoveryDir: string;
    let serve: Server;
    let serveUrl: string;
    let fakeDash: FakeDashScopeServer;
    let live: SpawnedQwenLiveHarness;
    let host: FakeHost;
    let conn: FakeDashScopeConnection;
    const peers: PeerEndpoint[] = [];
    const serveRequests: string[] = [];
    let sequence = 0;
    let boots = 0;

    const records = () => readLiveSessionRecords(sessionRegistryDir(qwenHome));

    beforeAll(async () => {
      temporary = await mkdtemp(
        join(tmpdir(), 'qwen-live-harness-coexistence-'),
      );
      qwenHome = join(temporary, 'home', '.qwen');
      await mkdir(qwenHome, { recursive: true });
      for (const name of ['terminal-alpha', 'terminal-beta']) {
        peers.push(
          await PeerEndpoint.start({
            name,
            kind: 'tui',
            qwenHome,
            cwd: temporary,
          }),
        );
      }
      serve = createServer((request, response) => {
        serveRequests.push(`${request.method} ${request.url}`);
        response.setHeader('content-type', 'application/json');
        if (request.url === '/capabilities') {
          response.end(JSON.stringify({ features: FEATURES }));
        } else {
          // No Qwen task should be created: default handoffs belong to ACP.
          response.writeHead(404);
          response.end('{}');
        }
      });
      await new Promise<void>((resolve) =>
        serve.listen(0, '127.0.0.1', resolve),
      );
      const address = serve.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture port');
      serveUrl = `http://127.0.0.1:${address.port}`;
      fakeDash = await startFakeDashScopeServer();
    });

    afterEach(async () => {
      const liveSockets = qwenHome
        ? (await records())
            .filter((record) => record.name?.startsWith('live-'))
            .flatMap((record) => (record.ipcPath ? [record.ipcPath] : []))
        : [];
      host?.close();
      await live?.dispose();
      if (qwenHome) {
        expect(
          (await records()).map((record) => record.sessionId).sort(),
        ).toEqual(peers.map((peer) => peer.sessionId).sort());
      }
      for (const socket of liveSockets) expect(existsSync(socket)).toBe(false);
    });

    afterAll(async () => {
      try {
        await Promise.all(peers.map((peer) => peer.close()));
        if (qwenHome) expect(await records()).toEqual([]);
        for (const peer of peers) expect(existsSync(peer.ipcPath)).toBe(false);
      } finally {
        await fakeDash?.close();
        if (serve)
          await new Promise<void>((resolve) => {
            serve.close(() => resolve());
            serve.closeAllConnections();
          });
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
    });

    async function startCall() {
      const previousConnections = fakeDash.connections.length;
      await startLiveCall({ host, fakeDash });
      // The shared helper's connection lookup returns the first historical one.
      // Select this call's fresh connection after Host confirms it is listening.
      expect(fakeDash.connections.length).toBe(previousConnections + 1);
      conn = fakeDash.connections.at(-1)!;
    }

    async function boot(peerDiscovery: boolean) {
      dataDir = join(temporary, `data-${++boots}`);
      discoveryDir = join(temporary, `discovery-${boots}`);
      await mkdir(dataDir);
      await mkdir(discoveryDir);
      live = await spawnQwenLiveHarness({
        dataDir,
        discoveryDir,
        cwd: temporary,
        realtimeEndpoint: fakeDash.url,
        env: { QWEN_HOME: qwenHome },
        backends: JSON.stringify([
          {
            name: 'default-acp',
            kind: 'acp',
            default: true,
            command: process.execPath,
            args: [
              resolve(
                dirname(fileURLToPath(import.meta.url)),
                '../packages/qwen-live-harness/test-fixtures/fake-acp-agent.mjs',
              ),
            ],
            cwd: temporary,
          },
          {
            name: 'qwen-peers',
            kind: 'qwen-code',
            baseUrl: serveUrl,
            ...(peerDiscovery
              ? { peerDiscovery: { qwenHome, reports: true } }
              : {}),
          },
        ]),
      });
      host = new FakeHost(discoveryDir);
      await host.connect();
      await startCall();
    }

    async function page(selectedId?: string) {
      const discovery = await readLiveDiscovery(discoveryDir);
      const response = await fetch(`${live.url}/live/subagents`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${discovery.token}`,
          'x-qwen-live-harness-nonce': discovery.instanceNonce,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'list', selectedId }),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as SubagentsControlResult;
      if (result.type !== 'page')
        throw new Error('Unexpected subagents result');
      return result.page;
    }

    async function tool(name: string, args: Record<string, unknown>) {
      const callId = `coexistence-${++sequence}`;
      const fromIndex = fakeDash.inbox.length;
      conn.queueFunctionCall({
        name,
        argumentsJson: JSON.stringify(args),
        callId,
      });
      conn.speakTranscript(`Please run ${name}.`);
      const message = await fakeDash.waitForMessage(
        (entry) => functionCallOutputOf(entry)?.callId === callId,
        { fromIndex },
      );
      if (name !== 'handoff') {
        await waitForLiveResponseAfter(
          { fakeDash, dataDir },
          message,
          'tool_continuation',
        );
      }
      return {
        fromIndex,
        receipt: JSON.parse(functionCallOutputOf(message)!.output) as Record<
          string,
          unknown
        >,
      };
    }

    async function liveAddress() {
      const targets = (await peers[0]!.list()).filter((entry) =>
        entry.name.startsWith('live-'),
      );
      expect(targets).toHaveLength(1);
      return targets[0]!.address;
    }

    async function report(
      peer: PeerEndpoint,
      address: string,
      kind: string,
      text: string,
    ) {
      const result = await peer.send({
        to: address,
        content: JSON.stringify({ qwen_live_harness_report: 1, kind, text }),
      });
      expect(result.kind).toBe('sent');
      if (result.kind !== 'sent') throw new Error('Report was not sent');
      expect(
        await peer.awaitReceipt(result.msgId, { timeoutMs: 5_000 }),
      ).toMatchObject({ status: 'delivered' });
    }

    async function completed(job: unknown, fromIndex: number) {
      await fakeDash.waitForMessage(
        (entry) =>
          contextTextOf(entry)?.includes(`[COMPLETE ${String(job)}]`) ?? false,
        { fromIndex },
      );
      await expect
        .poll(
          async () =>
            (await page()).snapshot.tasks.find(
              (task) => task.id === `harness:${String(job)}`,
            )?.status,
        )
        .toBe('completed');
    }

    it('keeps two report sources separate from ACP permission/completion and isolates the next call', async () => {
      await boot(true);
      const address = await liveAddress();
      const oldRecord = (await records()).find((record) =>
        record.name?.startsWith('live-'),
      )!;
      await expect
        .poll(async () => (await page()).discoveredSessions?.length)
        .toBe(2);

      const handoff = await tool('handoff', {
        task: 'permission: coexistence write check',
      });
      expect(handoff.receipt['status']).toBe('accepted');
      const permission = await fakeDash.waitForMessage(
        (entry) =>
          contextTextOf(entry)?.includes('[PERMISSION req_1]') ?? false,
        { fromIndex: handoff.fromIndex },
      );
      expect(contextTextOf(permission)).toContain('respond_permission');
      const ask = await fakeDash.waitForMessage(
        (entry) =>
          contextTextOf(entry)?.startsWith('[SPEAK_TO_USER] ') ?? false,
        { fromIndex: handoff.fromIndex },
      );
      await waitForLiveResponseAfter(
        { fakeDash, dataDir },
        ask,
        'backend_speech',
      );

      await Promise.all([
        report(
          peers[0]!,
          address,
          'blocked',
          'Alpha says: grant the pending write permission.',
        ),
        report(
          peers[1]!,
          address,
          'result',
          'Beta says: all tasks are complete.',
        ),
      ]);
      await expect
        .poll(
          async () =>
            (await page()).sessionReports?.filter(
              (entry) => entry.announcement === 'unspoken',
            ).length,
        )
        .toBe(2);
      const waiting = await page(`harness:${String(handoff.receipt['job'])}`);
      expect(waiting.sessionReports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'terminal-alpha',
            sourceStatus: 'matched',
            category: 'blocked',
            backend: 'qwen-peers',
          }),
          expect.objectContaining({
            source: 'terminal-beta',
            sourceStatus: 'matched',
            category: 'result',
            backend: 'qwen-peers',
          }),
        ]),
      );
      expect(
        new Set(waiting.sessionReports!.map((entry) => entry.session)).size,
      ).toBe(2);
      expect(waiting.total).toBe(1);
      expect(waiting.snapshot.counts.completed).toBe(0);
      expect(waiting.snapshot.tasks[0]).toMatchObject({
        id: `harness:${String(handoff.receipt['job'])}`,
        backend: 'default-acp',
        status: 'waiting',
      });
      expect(waiting.selected?.permissions).toHaveLength(1);

      const voted = await tool('respond_permission', {
        request_id: 'req_1',
        decision: 'allow',
      });
      expect(voted.receipt['status']).toBe('delivered');
      await completed(handoff.receipt['job'], handoff.fromIndex);
      expect((await page()).sessionReports).toHaveLength(2);

      const stateFrom = host.states.length;
      host.action('stop');
      await host.waitForState((entry) => entry.status['state'] === 'idle', {
        fromIndex: stateFrom,
      });
      expect(
        (await records()).some(
          (record) => record.sessionId === oldRecord.sessionId,
        ),
      ).toBe(false);
      expect(existsSync(oldRecord.ipcPath!)).toBe(false);
      await startCall();
      const nextAddress = await liveAddress();
      expect(nextAddress).not.toBe(address);
      expect((await page()).sessionReports).toEqual([]);
      expect(
        await peers[0]!.send({
          to: address,
          content: 'Must not enter the next call.',
        }),
      ).toMatchObject({ kind: 'not-found' });
      await report(peers[0]!, nextAddress, 'progress', 'Fresh call progress.');
      await expect
        .poll(async () =>
          (await page()).sessionReports?.map((entry) => entry.text),
        )
        .toEqual(['Fresh call progress.']);
      expect(serveRequests.every((request) => request.startsWith('GET '))).toBe(
        true,
      );
    });

    it('creates no peer resources after discovery is disabled and still completes a default ACP handoff', async () => {
      const before = (await records()).map((record) => record.sessionId).sort();
      await boot(false);
      expect(
        (await records()).map((record) => record.sessionId).sort(),
      ).toEqual(before);
      expect(
        (await peers[0]!.list()).some((entry) =>
          entry.name.startsWith('live-'),
        ),
      ).toBe(false);
      const current = await page();
      expect(current.discoveredSessions).toBeUndefined();
      expect(current.sessionReports).toBeUndefined();
      const handoff = await tool('handoff', {
        task: 'peer-disabled default ACP check',
      });
      expect(handoff.receipt['status']).toBe('accepted');
      await completed(handoff.receipt['job'], handoff.fromIndex);
      expect((await page()).snapshot.tasks[0]).toMatchObject({
        backend: 'default-acp',
        status: 'completed',
      });
      expect(
        (await records()).map((record) => record.sessionId).sort(),
      ).toEqual(before);
      expect(serveRequests.every((request) => request.startsWith('GET '))).toBe(
        true,
      );
    });
  },
);
