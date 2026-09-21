import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startFakeDashScopeServer,
  contextTextOf,
  taskResultPayloadOf,
  permissionPayloadOf,
  notificationOf,
  functionCallOutputOf,
  type FakeDashScopeServer,
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import {
  FakeHost,
  spawnQwenLiveHarness,
  startLiveCall,
  readLiveDiscovery,
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
    request: string,
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
    conn.speakTranscript(request);
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
      'Please check whether this project runs without a Qwen installation.',
      'handoff',
      { task: 'standalone portability check' },
      'portable-handoff',
    );
    expect(receipt['status']).toBe('accepted');
    const complete = await fakeDash.waitForMessage(
      (m) => taskResultPayloadOf(m)?.job === receipt['job'],
      { fromIndex },
    );
    expect(contextTextOf(complete)).toContain('standalone portability check');
    expect(taskResultPayloadOf(complete)).toMatchObject({
      status: 'completed',
      job: receipt['job'],
      summary: expect.stringContaining('standalone portability check'),
    });
    expect(contextTextOf(complete)).not.toContain('[SPEAK_TO_USER]');
    await waitForLiveResponseAfter(
      { fakeDash, dataDir },
      complete,
      'task_result',
    );
  });

  it('lists the independent backend and continues after the tool receipt', async () => {
    const { receipt, message } = await tool(
      'List the available background sessions.',
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
      'Please create a test file in the workspace.',
      'handoff',
      { task: 'permission: standalone write check' },
      'portable-permission',
    );
    expect(receipt['status']).toBe('accepted');
    const permission = await fakeDash.waitForMessage(
      (m) => permissionPayloadOf(m)?.request_id === 'req_1',
      { fromIndex },
    );
    expect(permissionPayloadOf(permission)).toMatchObject({
      request_id: 'req_1',
      session: 'session_1',
      action: expect.stringContaining('standalone write check'),
      fallback_language: 'en',
    });
    expect(contextTextOf(permission)).not.toContain('[SPEAK_TO_USER]');
    await waitForLiveResponseAfter(
      { fakeDash, dataDir },
      permission,
      'permission',
    );
    const request = await fakeDash.waitForMessage(
      (message) => message['type'] === 'response.create',
      { fromIndex: fakeDash.inbox.indexOf(permission) + 1 },
    );
    expect(request['response']).not.toHaveProperty('instructions');
    expect(notificationOf(permission)).toMatchObject({
      kind: 'permission',
      output_language: 'en',
      payload: expect.stringContaining('standalone write check'),
    });
    const initial = conn.inbox.find(
      (message) => message['type'] === 'session.update',
    );
    const instructions = (initial?.['session'] as Record<string, unknown>)[
      'instructions'
    ];
    expect(instructions).toContain(
      'Only a subsequent real user answer can authorize a vote',
    );
    expect(instructions).not.toContain('standalone write check');
    expect(
      fakeDash.inbox
        .slice(fromIndex)
        .some((m) =>
          contextTextOf(m)?.includes(`[COMPLETE ${String(receipt['job'])}]`),
        ),
    ).toBe(false);
    const voted = await tool(
      'Allow this operation once.',
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

  it('keeps a UI permission waiting after an unavailable persistent scope and confirms an explicit once-only vote', async () => {
    const accepted = await tool(
      'Please edit the project file.',
      'handoff',
      { task: 'permission: approve one synthetic edit from the task page' },
      'scoped-ui-permission',
    );
    const taskId = `harness:${String(accepted.receipt['job'])}`;
    const discovery = await readLiveDiscovery(join(temporary, 'discovery'));
    const control = async (action: Record<string, unknown>) => {
      const response = await fetch(`${live.url}/live/subagents`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${discovery.token}`,
          'x-qwen-live-harness-nonce': discovery.instanceNonce,
        },
        body: JSON.stringify(action),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };
    type Selected = {
      status: string;
      permissions: Array<{
        requestHandle: string;
        choices: Array<{ decision: string; scope?: string }>;
      }>;
    };
    let selected: Selected | undefined;
    await expect
      .poll(async () => {
        const result = await control({
          action: 'list',
          selectedId: taskId,
          filter: 'needsAttention',
        });
        const page = result['page'] as { filter: string; selected?: Selected };
        expect(page.filter).toBe('needsAttention');
        selected = page.selected;
        return selected?.permissions?.length;
      })
      .toBe(1);
    expect(selected?.status).toBe('waiting');
    const permission = selected!.permissions[0]!;
    // This fixture has no verified executable/target, so a generic edit title
    // must not create a future auto-allow rule.
    expect(permission.choices).not.toContainEqual({
      decision: 'allow',
      scope: 'always',
    });
    expect(
      await control({
        action: 'permission',
        requestHandle: permission.requestHandle,
        decision: 'allow',
        scope: 'always',
      }),
    ).toMatchObject({ type: 'error', code: 'permission_unavailable' });
    const pending = await control({ action: 'list', selectedId: taskId });
    expect((pending['page'] as { selected: Selected }).selected.status).toBe(
      'waiting',
    );
    expect(
      await control({
        action: 'permission',
        requestHandle: permission.requestHandle,
        decision: 'allow',
        scope: 'once',
      }),
    ).toMatchObject({
      type: 'outcome',
      outcome: 'allowed',
      requestHandle: permission.requestHandle,
      scope: 'once',
    });
    await expect
      .poll(async () => {
        const result = await control({ action: 'list', selectedId: taskId });
        return (result['page'] as { selected: Selected }).selected.status;
      })
      .toBe('completed');
  });
});
