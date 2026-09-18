import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startFakeDashScopeServer,
  contextTextOf,
  permissionPayloadOf,
  functionCallOutputOf,
  type FakeDashScopeConnection,
  type FakeDashScopeServer,
} from './fake-dashscope-server.js';
import {
  FakeHost,
  spawnQwenLiveHarness,
  startLiveCall,
  type SpawnedQwenLiveHarness,
} from './qwen-live-harness.js';

const AGENT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../packages/qwen-live-harness/test-fixtures/fake-acp-agent.mjs',
);

const RECEIPT_TIMEOUT_MS = 30_000;

interface ModeStack {
  fakeDash: FakeDashScopeServer;
  conn: FakeDashScopeConnection;
  live: SpawnedQwenLiveHarness;
  dispose: () => Promise<void>;
}

/**
 * Boot a daemon whose only backend is the scripted ACP agent advertising
 * `default,yolo`. The agent only raises session/request_permission while its
 * current mode is the asking one, so what the daemon selects after
 * session/new is observable through the permission traffic alone.
 */
async function bootModeStack(sessionMode?: string): Promise<ModeStack> {
  const temporary = await mkdtemp(join(tmpdir(), 'qwen-live-harness-mode-'));
  const dataDir = join(temporary, 'data');
  const discoveryDir = join(temporary, 'discovery');
  await mkdir(dataDir);
  await mkdir(discoveryDir);
  const fakeDash = await startFakeDashScopeServer();
  const live = await spawnQwenLiveHarness({
    dataDir,
    discoveryDir,
    cwd: temporary,
    realtimeEndpoint: fakeDash.url,
    backends: JSON.stringify([
      {
        name: 'fixture',
        kind: 'acp',
        command: process.execPath,
        args: [AGENT],
        env: { FAKE_ACP_MODES: 'default,yolo' },
        cwd: temporary,
        ...(sessionMode ? { sessionMode } : {}),
        default: true,
      },
    ]),
  });
  const host = new FakeHost(discoveryDir);
  await host.connect();
  try {
    const { conn } = await startLiveCall({ host, fakeDash });
    return {
      fakeDash,
      conn,
      live,
      dispose: async () => {
        host.close();
        await live.dispose();
        await fakeDash.close();
        await rm(temporary, { recursive: true, force: true });
      },
    };
  } catch (error) {
    host.close();
    await live.dispose();
    await fakeDash.close();
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function handoff(stack: ModeStack, task: string, callId: string) {
  const fromIndex = stack.fakeDash.inbox.length;
  stack.conn.queueFunctionCall({
    name: 'handoff',
    argumentsJson: JSON.stringify({ task }),
    callId,
  });
  stack.conn.speakTranscript('Please run handoff.');
  const message = await stack.fakeDash.waitForMessage(
    (entry) => functionCallOutputOf(entry)?.callId === callId,
    { fromIndex, timeoutMs: RECEIPT_TIMEOUT_MS },
  );
  return {
    fromIndex,
    receipt: JSON.parse(functionCallOutputOf(message)!.output) as Record<
      string,
      unknown
    >,
  };
}

function injectedContext(stack: ModeStack, fromIndex: number): string[] {
  return stack.fakeDash.inbox
    .slice(fromIndex)
    .map((entry) => contextTextOf(entry) ?? '');
}

describe('ACP backend sessionMode', () => {
  it('asks for approval unless the backend config overrides the mode', async () => {
    const stack = await bootModeStack();
    try {
      const { fromIndex, receipt } = await handoff(
        stack,
        'permission: default mode check',
        'mode-ask',
      );
      expect(receipt['status']).toBe('accepted');

      const permission = await stack.fakeDash.waitForMessage(
        (entry) => permissionPayloadOf(entry) !== undefined,
        { fromIndex, timeoutMs: RECEIPT_TIMEOUT_MS },
      );
      expect(permissionPayloadOf(permission)).toMatchObject({
        request_id: 'req_1',
        action: expect.stringContaining('default mode check'),
      });
      expect(contextTextOf(permission)).not.toContain('[SPEAK_TO_USER]');
    } finally {
      await stack.dispose();
    }
  });

  it('runs the delegated task end to end without a permission round trip when sessionMode is configured', async () => {
    const stack = await bootModeStack('yolo');
    try {
      const { fromIndex, receipt } = await handoff(
        stack,
        'permission: yolo mode check',
        'mode-yolo',
      );
      expect(receipt['status']).toBe('accepted');

      const complete = await stack.fakeDash.waitForMessage(
        (entry) =>
          contextTextOf(entry)?.includes(
            `[COMPLETE ${String(receipt['job'])}]`,
          ) ?? false,
        { fromIndex, timeoutMs: RECEIPT_TIMEOUT_MS },
      );
      expect(contextTextOf(complete)).toContain('yolo mode check');
      expect(
        injectedContext(stack, fromIndex).some((text) =>
          text.includes('[PERMISSION]'),
        ),
      ).toBe(false);
      expect(stack.live.stderrBuf.value).toContain('approval mode "yolo"');
    } finally {
      await stack.dispose();
    }
  });

  it('falls back to the asking mode when the configured mode is not advertised', async () => {
    const stack = await bootModeStack('turbo');
    try {
      const { fromIndex, receipt } = await handoff(
        stack,
        'permission: fallback mode check',
        'mode-fallback',
      );
      expect(receipt['status']).toBe('accepted');

      const permission = await stack.fakeDash.waitForMessage(
        (entry) => permissionPayloadOf(entry) !== undefined,
        { fromIndex, timeoutMs: RECEIPT_TIMEOUT_MS },
      );
      expect(permissionPayloadOf(permission)).toMatchObject({
        request_id: 'req_1',
        action: expect.stringContaining('fallback mode check'),
      });
      expect(contextTextOf(permission)).not.toContain('[SPEAK_TO_USER]');
      expect(stack.live.stderrBuf.value).toContain(
        'configured sessionMode "turbo" is not advertised',
      );
    } finally {
      await stack.dispose();
    }
  });
});
