/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * M3 discovery crosses the real daemon, Host and realtime protocol boundaries.
 * Qwen serve runs against a fake OpenAI provider. The terminal-shaped peers use
 * the official SDK protocol in an isolated Qwen home; they are not CLI TUI or
 * real audio fixtures, and this suite does not claim those evidence levels.
 */

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PeerEndpoint,
  readLiveSessionRecords,
  sessionRegistryDir,
} from '../packages/qwen-live-harness/src/vendor/qwen-code-peer/index.js';
import type { SubagentsControlResult } from '../packages/qwen-live-harness/src/subagents/types.js';
import {
  contextTextOf,
  functionCallOutputOf,
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import {
  bootLiveStack,
  readLiveDiscovery,
  startLiveCall,
  waitForLiveResponseAfter,
  type LiveStack,
} from './qwen-live-harness.js';

const SKIP =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
    process.env['QWEN_SANDBOX'].toLowerCase() !== 'false',
  );
const describeE2E = SKIP ? describe.skip : describe;

describeE2E('qwen-live-harness M3 — read-only terminal discovery', () => {
  let stack: LiveStack;
  let conn: FakeDashScopeConnection;
  let qwenHome: string;
  let first: PeerEndpoint;
  let second: PeerEndpoint;
  let excluded: PeerEndpoint;
  let terminalHandle: string;
  let liveSessionId: string;
  const received: string[] = [];
  const peers: PeerEndpoint[] = [];

  beforeAll(async () => {
    stack = await bootLiveStack({
      peerDiscovery: true,
      makeOpenAIHandler: () => () => ({ content: 'unexpected model request' }),
    });
    qwenHome = path.join(stack.homeDir, '.qwen');
    for (const kind of ['tui', 'tui', 'acp']) {
      peers.push(
        await PeerEndpoint.start({
          name: 'same-project',
          kind,
          qwenHome,
          cwd: stack.workspaceDir,
          onMessage: (message) => {
            received.push(message.content);
          },
        }),
      );
    }
    [first, second, excluded] = peers;
  });

  afterAll(async () => {
    for (const peer of peers) await peer.close();
    await stack?.dispose();
  }, 60_000);

  const liveRecords = async () =>
    (await readLiveSessionRecords(sessionRegistryDir(qwenHome))).filter(
      (record) => record.name === 'live-qwen-code',
    );

  const page = async () => {
    const discovery = await readLiveDiscovery(stack.discoveryDir);
    const response = await fetch(`${stack.live.url}/live/subagents`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${discovery.token}`,
        'x-qwen-live-harness-nonce': discovery.instanceNonce,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'list' }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as SubagentsControlResult;
    if (result.type !== 'page') {
      throw new Error(
        `Expected Host subagents page: ${JSON.stringify(result)}`,
      );
    }
    return result.page;
  };

  const toolCall = async (
    name: string,
    callId: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const fromIndex = stack.fakeDash.inbox.length;
    conn.queueFunctionCall({
      name,
      argumentsJson: JSON.stringify(args),
      callId,
    });
    conn.speakTranscript(`Please ${name}: ${JSON.stringify(args)}`);
    const receipt = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === callId,
      { fromIndex, timeoutMs: 30_000, description: `${name} ${callId}` },
    );
    if (name !== 'handoff') {
      await waitForLiveResponseAfter(stack, receipt, 'tool_continuation');
    }
    return JSON.parse(functionCallOutputOf(receipt)!.output) as Record<
      string,
      unknown
    >;
  };

  it('registers only during a call and discovers distinct terminal sessions', async () => {
    expect(await liveRecords()).toEqual([]);
    expect((await page()).discoveredSessions ?? []).toEqual([]);
    conn = (await startLiveCall(stack)).conn;
    await expect.poll(async () => (await liveRecords()).length).toBe(1);
    liveSessionId = (await liveRecords())[0].sessionId;

    const listed = await toolCall('session_list', 'm3-list-first');
    expect(listed['status']).toBe('ok');
    const terminals = (
      listed['sessions'] as Array<Record<string, unknown>>
    ).filter((row) => row['source'] === 'terminal');
    expect(
      (listed['sessions'] as Array<Record<string, unknown>>).some(
        (row) => row['source'] !== 'terminal' && row['read_only'] !== true,
      ),
    ).toBe(true);
    expect(terminals).toHaveLength(2);
    expect(new Set(terminals.map((row) => row['label'])).size).toBe(2);
    expect(new Set(terminals.map((row) => row['handle'])).size).toBe(2);
    for (const row of terminals) {
      expect(row).toMatchObject({
        backend: 'qwen-code',
        source: 'terminal',
        read_only: true,
        state: 'unknown',
        cwd: stack.workspaceDir,
      });
      expect(row['job']).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain(first.ipcToken);
      expect(JSON.stringify(row)).not.toContain(second.ipcToken);
      expect(JSON.stringify(row)).not.toContain(excluded.sessionId);
    }
    terminalHandle = String(terminals[0]['handle']);

    const again = await toolCall('session_list', 'm3-list-again');
    expect(
      (again['sessions'] as Array<Record<string, unknown>>).filter(
        (row) => row['source'] === 'terminal',
      ),
    ).toEqual(terminals);
  });

  it('refuses terminal actions without creating tasks or model requests', async () => {
    const beforeRequests = stack.fakeOpenAI.requests.length;
    expect(
      await toolCall('handoff', 'm3-handoff', {
        session: terminalHandle,
        task: 'This instruction must never be delivered.',
      }),
    ).toMatchObject({ status: 'rejected', session: terminalHandle });
    expect(
      await toolCall('session_stop', 'm3-stop', { session: terminalHandle }),
    ).toMatchObject({ status: 'unsupported', session: terminalHandle });
    expect(
      await toolCall('session_monitor', 'm3-monitor', {
        session: terminalHandle,
      }),
    ).toMatchObject({ status: 'ok', state: 'unknown', read_only: true });

    const hostPage = await page();
    expect(hostPage.discoveredSessions).toHaveLength(2);
    expect(hostPage.discoveredSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: terminalHandle,
          backend: 'qwen-code',
          source: 'terminal',
          status: 'unknown',
          readOnly: true,
        }),
      ]),
    );
    expect(hostPage.total).toBe(0);
    expect(hostPage.snapshot.tasks).toEqual([]);
    expect(
      Object.values(hostPage.snapshot.counts).every((value) => value === 0),
    ).toBe(true);
    expect(received).toEqual([]);
    expect(stack.fakeOpenAI.requests).toHaveLength(beforeRequests);
  });

  it('refuses peer reports until the later inbound-report stage', async () => {
    const live = (await first.list()).find(
      (peer) => peer.sessionId === liveSessionId,
    );
    expect(live).toBeDefined();
    const sent = await first.send({
      to: live!.address,
      content: 'm3-report-must-not-be-spoken',
    });
    expect(sent.kind).toBe('sent');
    if (sent.kind !== 'sent') throw new Error('Fixture failed to send report');
    expect(
      await first.awaitReceipt(sent.msgId, { final: true, timeoutMs: 5_000 }),
    ).toMatchObject({ status: 'refused' });
    expect(
      stack.fakeDash.inbox.some((message) =>
        contextTextOf(message)?.includes('m3-report-must-not-be-spoken'),
      ),
    ).toBe(false);
  });

  it('removes a closed terminal from both catalogs without a phantom task', async () => {
    await second.close();
    const listed = await toolCall('session_list', 'm3-list-after-exit');
    expect(
      (listed['sessions'] as Array<Record<string, unknown>>).filter(
        (row) => row['source'] === 'terminal',
      ),
    ).toHaveLength(1);
    const hostPage = await page();
    expect(hostPage.discoveredSessions).toHaveLength(1);
    expect(hostPage.snapshot.tasks).toEqual([]);
  });

  it('cleans up on call stop and registers a fresh endpoint on the next call', async () => {
    const stateIndex = stack.host.states.length;
    stack.host.action('stop');
    await stack.host.waitForState((entry) => entry.status['state'] === 'idle', {
      fromIndex: stateIndex,
    });
    await expect.poll(async () => (await liveRecords()).length).toBe(0);
    expect((await page()).discoveredSessions ?? []).toEqual([]);

    conn = (await startLiveCall(stack)).conn;
    await expect.poll(async () => (await liveRecords()).length).toBe(1);
    expect((await liveRecords())[0].sessionId).not.toBe(liveSessionId);
    expect((await page()).discoveredSessions).toHaveLength(1);
    await stack.live.dispose();
    await expect.poll(async () => (await liveRecords()).length).toBe(0);
  });
});
