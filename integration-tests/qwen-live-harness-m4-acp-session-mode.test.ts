/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * qwen-live-harness M4 — a real Qwen Code ACP child and the configured
 * approval mode. The sidecar advertises plan/default/auto-edit/auto/yolo; the
 * harness must put a configured mode in force, so a file write the agent
 * performs runs with no session/request_permission, and must fall back to the
 * advertised asking mode when the configured id is not on offer.
 *
 * Both arms drive the same task against the real CLI: the mode is the only
 * difference.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeToolCall } from './fake-openai-server.js';
import {
  contextTextOf,
  permissionPayloadOf,
  functionCallOutputOf,
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import {
  bootAcpLiveStack,
  startLiveCall,
  waitForLiveResponseAfter,
  type AcpLiveStack,
} from './qwen-live-harness.js';

const SKIP =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
    process.env['QWEN_SANDBOX'].toLowerCase() !== 'false',
  );
const describeE2E = SKIP ? describe.skip : describe;

const FILE_NAME = 'mode-e2e.txt';
const FILE_CONTENT = 'mode-selection-granted';
const TASK = 'mode-e2e-task';

/**
 * Boots the real ACP child behind a fake model, hands off the shared task, and
 * returns once the handoff is accepted. The caller waits for whatever the mode
 * is supposed to produce.
 */
async function handOffWriteTask(
  stack: AcpLiveStack,
  conn: FakeDashScopeConnection,
  callId: string,
): Promise<{ fromIndex: number; job: string }> {
  const fromIndex = stack.fakeDash.inbox.length;
  conn.queueFunctionCall({
    name: 'handoff',
    argumentsJson: JSON.stringify({ task: TASK }),
    callId,
  });
  conn.speakTranscript(`Run ${TASK}.`);
  const receiptMessage = await stack.fakeDash.waitForMessage(
    (message) => functionCallOutputOf(message)?.callId === callId,
    {
      timeoutMs: 60_000,
      fromIndex,
      description: 'the handoff receipt',
    },
  );
  const receipt = JSON.parse(
    functionCallOutputOf(receiptMessage)!.output,
  ) as Record<string, unknown>;
  expect(receipt['status']).toBe('accepted');
  return { fromIndex, job: String(receipt['job']) };
}

/** The model writes one file on the first turn and settles on the second. */
function writeThenSettle(filePath: string) {
  return ({ body }: { body: Record<string, unknown> }) => {
    const messages = JSON.stringify(body['messages'] ?? []);
    const hasToolResult =
      messages.includes('"role":"tool"') || messages.includes('"tool_call_id"');
    if (messages.includes(TASK)) {
      if (!hasToolResult) {
        return {
          toolCalls: [
            fakeToolCall('write_file', {
              file_path: filePath,
              content: FILE_CONTENT,
            }),
          ],
        };
      }
      return { content: 'mode e2e turn complete' };
    }
    return { content: 'ok' };
  };
}

function injectedContext(stack: AcpLiveStack, fromIndex: number): string[] {
  return stack.fakeDash.inbox
    .slice(fromIndex)
    .map((entry) => contextTextOf(entry) ?? '');
}

describeE2E('qwen-live-harness M4 — ACP approval mode selection', () => {
  it('runs a real ACP file write with no permission round trip when sessionMode is set', async () => {
    let filePath = '';
    const stack = await bootAcpLiveStack({
      mode: 'acp',
      sessionMode: 'yolo',
      makeOpenAIHandler: ({ workspaceDir }) => {
        filePath = path.join(workspaceDir, FILE_NAME);
        return writeThenSettle(filePath);
      },
    });
    try {
      const conn = (await startLiveCall(stack)).conn;
      const { fromIndex, job } = await handOffWriteTask(stack, conn, 'call-y');

      await stack.fakeDash.waitForMessage(
        (message) =>
          contextTextOf(message)?.includes(`[COMPLETE ${job}]`) ?? false,
        {
          timeoutMs: 120_000,
          fromIndex,
          description: `[COMPLETE ${job}] with no approval round trip`,
        },
      );
      expect(readFileSync(filePath, 'utf8')).toBe(FILE_CONTENT);
      expect(
        injectedContext(stack, fromIndex).some((text) =>
          text.includes('[PERMISSION]'),
        ),
      ).toBe(false);
      expect(stack.live.stderrBuf.value).toContain(
        'approval mode "yolo": actions run without per-action approval',
      );
    } finally {
      await stack.dispose();
    }
  }, 300_000);

  it('falls back to the asking mode when the configured mode is not advertised', async () => {
    let filePath = '';
    const stack = await bootAcpLiveStack({
      mode: 'acp',
      sessionMode: 'turbo',
      makeOpenAIHandler: ({ workspaceDir }) => {
        filePath = path.join(workspaceDir, FILE_NAME);
        return writeThenSettle(filePath);
      },
    });
    try {
      const conn = (await startLiveCall(stack)).conn;
      const { fromIndex, job } = await handOffWriteTask(stack, conn, 'call-f');

      const permissionMessage = await stack.fakeDash.waitForMessage(
        (message) => permissionPayloadOf(message) !== undefined,
        {
          timeoutMs: 120_000,
          fromIndex,
          description: 'the [PERMISSION] context injection after the fallback',
        },
      );
      const permission = permissionPayloadOf(permissionMessage)!;
      expect(permission.action).toBeTruthy();
      expect(contextTextOf(permissionMessage)).not.toContain('[SPEAK_TO_USER]');
      expect(stack.live.stderrBuf.value).toContain(
        'configured sessionMode "turbo" is not advertised',
      );
      expect(stack.live.stderrBuf.value).toContain(
        'approval mode "default": every action needs approval',
      );

      // The daemon must have handed the ask to the voice model before the vote
      // lands, exactly as the asking-mode relay test drives it.
      await waitForLiveResponseAfter(stack, permissionMessage, 'permission');

      // The fallback session is a working asking session, not a stalled one:
      // the vote still resolves the ask and the task completes.
      const requestId = permission.request_id;
      expect(requestId).toBeDefined();
      conn.queueFunctionCall({
        name: 'respond_permission',
        argumentsJson: JSON.stringify({
          request_id: requestId,
          decision: 'allow',
        }),
        callId: 'call-v',
      });
      conn.speakTranscript('Yes, allow it.');
      const voteReceiptMessage = await stack.fakeDash.waitForMessage(
        (message) => functionCallOutputOf(message)?.callId === 'call-v',
        {
          timeoutMs: 30_000,
          fromIndex,
          description: 'the respond_permission receipt',
        },
      );
      const voteReceipt = JSON.parse(
        functionCallOutputOf(voteReceiptMessage)!.output,
      ) as Record<string, unknown>;
      expect(voteReceipt['status']).toBe('delivered');
      await waitForLiveResponseAfter(
        stack,
        voteReceiptMessage,
        'tool_continuation',
      );

      await stack.fakeDash.waitForMessage(
        (message) =>
          contextTextOf(message)?.includes(`[COMPLETE ${job}]`) ?? false,
        {
          timeoutMs: 120_000,
          fromIndex,
          description: `[COMPLETE ${job}] after the allow vote`,
        },
      );
      expect(readFileSync(filePath, 'utf8')).toBe(FILE_CONTENT);
    } finally {
      await stack.dispose();
    }
  }, 300_000);
});
