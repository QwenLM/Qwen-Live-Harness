import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startFakeDashScopeServer,
  contextTextOf,
  functionCallOutputOf,
  type FakeDashScopeServer,
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import {
  FakeHost,
  spawnQwenLiveHarness,
  startLiveCall,
  waitForLiveResponseAfter,
  type SpawnedQwenLiveHarness,
} from './qwen-live-harness.js';

describe('standalone daemon with an external ACP process', () => {
  let temporary: string;
  let dataDir: string;
  let fakeDash: FakeDashScopeServer;
  let live: SpawnedQwenLiveHarness;
  let host: FakeHost;
  let conn: FakeDashScopeConnection;

  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'qwen-live-harness-standalone-'));
    dataDir = join(temporary, 'data');
    const discoveryDir = join(temporary, 'discovery');
    await mkdir(dataDir);
    await mkdir(discoveryDir);
    fakeDash = await startFakeDashScopeServer();
    const agent = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../packages/qwen-live-harness/test-fixtures/fake-acp-agent.mjs',
    );
    live = await spawnQwenLiveHarness({
      dataDir,
      discoveryDir,
      cwd: temporary,
      realtimeEndpoint: fakeDash.url,
      backends: JSON.stringify([
        {
          name: 'external-acp',
          kind: 'acp',
          command: process.execPath,
          args: [agent],
          cwd: temporary,
          default: true,
        },
      ]),
    });
    host = new FakeHost(discoveryDir);
    await host.connect();
    conn = (await startLiveCall({ host, fakeDash })).conn;
  });

  afterAll(async () => {
    host?.close();
    await live?.dispose();
    await fakeDash?.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  async function tool(
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ) {
    const fromIndex = fakeDash.inbox.length;
    conn.queueFunctionCall({
      name,
      argumentsJson: JSON.stringify(args),
      callId,
    });
    conn.speakTranscript(`Please run ${name}.`);
    const message = await fakeDash.waitForMessage(
      (m) => functionCallOutputOf(m)?.callId === callId,
      { fromIndex },
    );
    return {
      message,
      fromIndex,
      receipt: JSON.parse(functionCallOutputOf(message)!.output) as Record<
        string,
        unknown
      >,
    };
  }

  it('delegates and proactively delivers completion without a Qwen installation or serve process', async () => {
    const { receipt, fromIndex } = await tool(
      'handoff',
      { task: 'standalone portability check' },
      'portable-handoff',
    );
    expect(receipt['status']).toBe('accepted');
    const complete = await fakeDash.waitForMessage(
      (m) =>
        contextTextOf(m)?.includes(`[COMPLETE ${String(receipt['job'])}]`) ??
        false,
      { fromIndex },
    );
    expect(contextTextOf(complete)).toContain('standalone portability check');
    const spoken = await fakeDash.waitForMessage(
      (m) => contextTextOf(m)?.startsWith('[SPEAK_TO_USER] ') ?? false,
      { fromIndex },
    );
    await waitForLiveResponseAfter(
      { fakeDash, dataDir },
      spoken,
      'backend_speech',
    );
  });

  it('lists the independent backend and continues after the tool receipt', async () => {
    const { receipt, message } = await tool(
      'session_list',
      {},
      'portable-list',
    );
    expect(receipt['status']).toBe('ok');
    expect(receipt['sessions']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ backend: 'external-acp' }),
      ]),
    );
    await waitForLiveResponseAfter(
      { fakeDash, dataDir },
      message,
      'tool_continuation',
    );
  });

  it('announces a blocked permission and resumes only after an explicit vote', async () => {
    const { receipt, fromIndex } = await tool(
      'handoff',
      { task: 'permission: standalone write check' },
      'portable-permission',
    );
    expect(receipt['status']).toBe('accepted');
    const permission = await fakeDash.waitForMessage(
      (m) => contextTextOf(m)?.includes('[PERMISSION req_1]') ?? false,
      { fromIndex },
    );
    expect(contextTextOf(permission)).toContain('respond_permission');
    const ask = await fakeDash.waitForMessage(
      (m) => contextTextOf(m)?.startsWith('[SPEAK_TO_USER] ') ?? false,
      { fromIndex },
    );
    await waitForLiveResponseAfter(
      { fakeDash, dataDir },
      ask,
      'backend_speech',
    );
    expect(
      fakeDash.inbox
        .slice(fromIndex)
        .some((m) =>
          contextTextOf(m)?.includes(`[COMPLETE ${String(receipt['job'])}]`),
        ),
    ).toBe(false);
    const voted = await tool(
      'respond_permission',
      { request_id: 'req_1', decision: 'allow' },
      'portable-vote',
    );
    expect(voted.receipt['status']).toBe('delivered');
    await waitForLiveResponseAfter(
      { fakeDash, dataDir },
      voted.message,
      'tool_continuation',
    );
    const completed = await fakeDash.waitForMessage(
      (m) =>
        contextTextOf(m)?.includes(`[COMPLETE ${String(receipt['job'])}]`) ??
        false,
      { fromIndex },
    );
    expect(contextTextOf(completed)).toContain('permission granted');
  });
});
