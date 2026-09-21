/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * qwen-live-harness M4 — permission relay over the ACP backend: a write_file tool
 * call raises session/request_permission on the ACP child; the ask must
 * reach the voice model, the spoken allow must resolve the parked RPC
 * with the least-escalating offered optionId, and the file must land.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeToolCall } from './fake-openai-server.js';
import {
  contextTextOf,
  permissionPayloadOf,
  functionCallOutputOf,
  taskResultPayloadOf,
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

const PERM_FILE_NAME = 'perm-acp-e2e.txt';
const PERM_FILE_CONTENT = 'acp-permission-granted';

describeE2E('qwen-live-harness M4 — ACP permission relay', () => {
  let stack: AcpLiveStack;
  let conn: FakeDashScopeConnection;
  let permFilePath = '';

  beforeAll(async () => {
    stack = await bootAcpLiveStack({
      mode: 'acp',
      makeOpenAIHandler: ({ workspaceDir }) => {
        permFilePath = path.join(workspaceDir, PERM_FILE_NAME);
        return ({ body }) => {
          const messages = JSON.stringify(body['messages'] ?? []);
          const hasToolResult =
            messages.includes('"role":"tool"') ||
            messages.includes('"tool_call_id"');
          if (messages.includes('perm-acp-task')) {
            if (!hasToolResult) {
              return {
                toolCalls: [
                  fakeToolCall('write_file', {
                    file_path: permFilePath,
                    content: PERM_FILE_CONTENT,
                  }),
                ],
              };
            }
            return { content: 'acp permission turn complete' };
          }
          return { content: 'ok' };
        };
      },
    });
    conn = (await startLiveCall(stack)).conn;
  }, 180_000);

  afterAll(async () => {
    await stack?.dispose();
  }, 60_000);

  it('relays the ask to voice and the allow vote resolves the RPC', async () => {
    const inboxIndex = stack.fakeDash.inbox.length;
    conn.queueFunctionCall({
      name: 'handoff',
      argumentsJson: JSON.stringify({ task: 'perm-acp-task' }),
      callId: 'call-p',
    });
    conn.speakTranscript('Please write the project report to a file.');
    const receiptMessage = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === 'call-p',
      {
        timeoutMs: 30_000,
        fromIndex: inboxIndex,
        description: 'the perm handoff receipt',
      },
    );
    const receipt = JSON.parse(
      functionCallOutputOf(receiptMessage)!.output,
    ) as Record<string, unknown>;
    expect(receipt['status']).toBe('accepted');
    const job = String(receipt['job']);

    // Structured permission facts drive a dedicated model-authored question.
    const permissionMessage = await stack.fakeDash.waitForMessage(
      (message) => permissionPayloadOf(message)?.request_id === 'req_1',
      {
        timeoutMs: 30_000,
        fromIndex: inboxIndex,
        description: 'the [PERMISSION] JSON context injection for req_1',
      },
    );
    expect(permissionPayloadOf(permissionMessage)).toMatchObject({
      request_id: 'req_1',
      action: expect.any(String),
    });
    expect(contextTextOf(permissionMessage)).not.toContain('[SPEAK_TO_USER]');
    await waitForLiveResponseAfter(stack, permissionMessage, 'permission');

    // The user says yes: the vote must resolve the parked RPC.
    conn.queueFunctionCall({
      name: 'respond_permission',
      argumentsJson: '{"request_id":"req_1","decision":"allow"}',
      callId: 'call-v',
    });
    conn.speakTranscript('Yes, allow it.');
    const voteReceiptMessage = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === 'call-v',
      {
        timeoutMs: 15_000,
        fromIndex: inboxIndex,
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

    // The turn completes and the file landed.
    const complete = await stack.fakeDash.waitForMessage(
      (message) =>
        taskResultPayloadOf(message)?.status === 'completed' &&
        taskResultPayloadOf(message)?.job === job,
      {
        timeoutMs: 60_000,
        fromIndex: inboxIndex,
        description: `[COMPLETE ${job}] after the allow vote`,
      },
    );
    expect(contextTextOf(complete)).toContain('acp permission turn complete');
    expect(readFileSync(permFilePath, 'utf8')).toBe(PERM_FILE_CONTENT);
    await waitForLiveResponseAfter(stack, complete, 'task_result');
  });
});
