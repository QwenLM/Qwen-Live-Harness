/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * qwen-live-harness M2 — permission forwarding across the voice boundary:
 *
 * A real `qwen serve` session (approval mode `default`) hits a `write_file`
 * tool call, which raises a daemon permission_request. The qwen-live-harness
 * orchestrator must inject quoted `[PERMISSION]` facts and request a dedicated
 * model-authored question in the user's language; the voice model's
 * `respond_permission {decision:"allow"}` call must be delivered back to
 * serve as a vote, after which the tool runs and the turn completes.
 *
 * A warmup handoff first materializes the orchestrator's default session so
 * the test can pin its approval mode deterministically before the
 * permission-triggering turn.
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
  bootLiveStack,
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

const PERM_FILE_NAME = 'perm-e2e.txt';
const PERM_FILE_CONTENT = 'permission-granted';

describeE2E('qwen-live-harness M2 — permission relay', () => {
  let stack: LiveStack;
  let conn: FakeDashScopeConnection;
  let permFilePath = '';

  beforeAll(async () => {
    stack = await bootLiveStack({
      makeOpenAIHandler: ({ workspaceDir }) => {
        permFilePath = path.join(workspaceDir, PERM_FILE_NAME);
        return ({ body }) => {
          const messages = JSON.stringify(body['messages'] ?? []);
          const hasToolResult =
            messages.includes('"role":"tool"') ||
            messages.includes('"tool_call_id"');
          if (messages.includes('perm-write-task')) {
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
            return { content: 'permission turn complete' };
          }
          if (messages.includes('perm-warmup')) {
            return { content: 'warmup done' };
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

  it('relays the permission ask to voice and delivers the allow vote', async () => {
    // Warmup: materialize the orchestrator's default serve session.
    const warmupIndex = stack.fakeDash.inbox.length;
    conn.queueFunctionCall({
      name: 'handoff',
      argumentsJson: JSON.stringify({ task: 'perm-warmup' }),
      callId: 'call-w',
    });
    conn.speakTranscript('Please inspect the project workspace.');
    const warmupReceiptMessage = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === 'call-w',
      {
        fromIndex: warmupIndex,
        timeoutMs: 30_000,
        description: 'the warmup handoff receipt',
      },
    );
    const warmupReceipt = JSON.parse(
      functionCallOutputOf(warmupReceiptMessage)!.output,
    ) as Record<string, unknown>;
    expect(warmupReceipt['status']).toBe('accepted');
    const warmupJob = String(warmupReceipt['job']);
    const warmupComplete = await stack.fakeDash.waitForMessage(
      (message) =>
        taskResultPayloadOf(message)?.status === 'completed' &&
        taskResultPayloadOf(message)?.job === warmupJob,
      {
        fromIndex: warmupIndex,
        timeoutMs: 30_000,
        description: 'the warmup [COMPLETE] injection',
      },
    );
    await waitForLiveResponseAfter(stack, warmupComplete, 'task_result');

    // Pin the approval mode of the orchestrator-created session so the
    // write below deterministically raises a permission_request.
    const sessions = await stack.serve.client.listWorkspaceSessions(
      stack.workspaceDir,
    );
    const target = sessions.find(
      (session) => session.sessionId !== stack.prewarmSessionId,
    );
    expect(target).toBeDefined();
    await stack.serve.client.setSessionApprovalMode(
      target!.sessionId,
      'default',
    );

    // The permission-triggering handoff.
    const inboxIndex = stack.fakeDash.inbox.length;
    conn.queueFunctionCall({
      name: 'handoff',
      argumentsJson: JSON.stringify({ task: 'perm-write-task' }),
      callId: 'call-p',
    });
    conn.speakTranscript('Please create a report file in the project.');
    const receiptMessage = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === 'call-p',
      {
        timeoutMs: 30_000,
        fromIndex: inboxIndex,
        description: 'the perm-write-task handoff receipt',
      },
    );
    const receipt = JSON.parse(
      functionCallOutputOf(receiptMessage)!.output,
    ) as Record<string, unknown>;
    expect(receipt['status']).toBe('accepted');
    const job = String(receipt['job']);

    // The ask carries structured facts into a dedicated permission response.
    const permissionMessage = await stack.fakeDash.waitForMessage(
      (message) => permissionPayloadOf(message)?.request_id === 'req_1',
      {
        timeoutMs: 30_000,
        fromIndex: inboxIndex,
        description: 'the [PERMISSION] JSON context injection for req_1',
      },
    );
    const permissionText = contextTextOf(permissionMessage)!;
    expect(permissionPayloadOf(permissionMessage)).toMatchObject({
      request_id: 'req_1',
      action: expect.any(String),
    });
    expect(permissionText).not.toContain('[SPEAK_TO_USER]');
    await waitForLiveResponseAfter(stack, permissionMessage, 'permission');

    // The user says yes: respond_permission must deliver the vote to serve.
    const voteIndex = stack.fakeDash.inbox.length;
    conn.queueFunctionCall({
      name: 'respond_permission',
      argumentsJson: '{"request_id":"req_1","decision":"allow"}',
      callId: 'call-2',
    });
    conn.speakTranscript('Yes, allow it.');
    const voteReceiptMessage = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === 'call-2',
      {
        timeoutMs: 15_000,
        fromIndex: voteIndex,
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

    // Serve accepted the vote: the tool ran and the turn completed.
    const completeMessage = await stack.fakeDash.waitForMessage(
      (message) =>
        taskResultPayloadOf(message)?.status === 'completed' &&
        taskResultPayloadOf(message)?.job === job,
      {
        timeoutMs: 60_000,
        fromIndex: inboxIndex,
        description: `[COMPLETE ${job}] after the allow vote`,
      },
    );
    expect(contextTextOf(completeMessage)).toContain(
      'permission turn complete',
    );
    expect(readFileSync(permFilePath, 'utf8')).toBe(PERM_FILE_CONTENT);
    await waitForLiveResponseAfter(stack, completeMessage, 'task_result');
  });
});
