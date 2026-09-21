/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendRegistry } from '../adaptor/registry.js';
import type { BackendAdaptor } from '../adaptor/types.js';
import { DEFAULT_PROACTIVE_CONFIG } from '../config.js';
import { displayLiveMessage } from '../i18n/messages.js';
import type { SessionLog } from '../log/session-log.js';
import { ProactiveScheduler } from '../proactive/scheduler.js';
import {
  openQwenRealtimeSession,
  type QwenRealtimeCallbacks,
  type QwenRealtimeSession,
  type RealtimeCloseInfo,
  type RealtimeFunctionCallRef,
} from '../realtime/realtime-session.js';
import { PROACTIVE_SESSION_TOOLS } from '../tools/definitions.js';
import { LiveSession, type LiveHostControl } from './live-session.js';

const active: LiveSession[] = [];

afterEach(() => {
  for (const session of active.splice(0)) session.dispose();
});

function harness(openOverride?: typeof openQwenRealtimeSession) {
  const host = {
    setCallState: vi.fn(() => true),
    setCoordinator: vi.fn(() => true),
    sendOutputAudio: vi.fn(() => true),
    finishOutputAudio: vi.fn(),
    clearOutput: vi.fn(),
    setCaption: vi.fn(() => true),
    setStatusText: vi.fn(() => true),
    failCall: vi.fn((_epoch: number, _message?: string) => true),
    setProviderReachability: vi.fn(),
    captureVisualContext: vi.fn(async () => {
      throw new Error('No real capture is allowed in review reproduction.');
    }),
  } satisfies LiveHostControl;
  const outputs: string[] = [];
  const realtime = {
    callEpoch: 1,
    closed: new Promise<RealtimeCloseInfo>(() => {}),
    flushDialogue: vi.fn(),
    configure: vi.fn(() => true),
    pushAudio: vi.fn(() => true),
    setInputMuted: vi.fn(),
    pushImage: vi.fn(() => true),
    commitInputAudio: vi.fn(() => true),
    clearInputAudio: vi.fn(() => true),
    cancelResponse: vi.fn(() => true),
    submitFunctionOutput: vi.fn(
      (_ref: RealtimeFunctionCallRef, output: string) => {
        outputs.push(output);
        return true;
      },
    ),
    sendBackendContext: vi.fn(() => true),
    speakToUser: vi.fn(() => true),
    respondToProactiveEvent: vi.fn(() => true),
    requestProactiveRepair: vi.fn(() => true),
    takeTranscriptTail: vi.fn(() => []),
    close: vi.fn(),
  } satisfies QwenRealtimeSession;
  let callbacks: QwenRealtimeCallbacks = {};
  let scheduler: ProactiveScheduler | undefined;
  let nextCallId = 0;
  const log = { write: vi.fn() };
  // Only registry names are used: no backend session or external process runs.
  const adaptor = { name: 'synthetic-review-backend' } as BackendAdaptor;
  const session = new LiveSession({
    host,
    registry: new BackendRegistry([{ adaptor, isDefault: true }]),
    log: log as unknown as SessionLog,
    realtime: { endpoint: 'https://review.example.test', model: 'test' },
    proactive: structuredClone(DEFAULT_PROACTIVE_CONFIG),
    openRealtime: (config, events = {}) => {
      callbacks = events;
      return openOverride
        ? openOverride(config, events)
        : Promise.resolve(realtime);
    },
    createProactiveScheduler: (options) => {
      scheduler = new ProactiveScheduler({
        ...options,
        captureVision: async () => undefined,
        createMonitor: (config, events) => ({
          start: async () => events.onReady?.(config.taskGeneration),
          feedAudio: () => true,
          feedImage: () => true,
          requestEvaluation: () => true,
          resetPendingCapture: () => {},
          close: () => {},
        }),
      });
      return scheduler;
    },
  });
  active.push(session);
  return {
    session,
    host,
    log,
    outputs,
    get scheduler() {
      if (!scheduler) throw new Error('Expected the scheduler to start.');
      return scheduler;
    },
    start: () =>
      session.start({
        epoch: 1,
        callId: 'review-call',
        mode: 'new',
        visualInput: {
          source: 'screen',
          mode: 'on-demand',
          fps: 1,
          liveWidth: 1280,
          liveHeight: 720,
        },
      }),
    begin: (responseId: string) =>
      callbacks.onResponseCreated?.({
        callEpoch: 1,
        responseId,
        authority: 'direct',
        inputItemId: `input-${responseId}`,
      }),
    done: (responseId: string) =>
      callbacks.onResponseDone?.({
        callEpoch: 1,
        responseId,
        authority: 'direct',
        status: 'completed',
      }),
    call: (
      responseId: string,
      name: string,
      args: Record<string, unknown> | string,
      request?: string,
    ) =>
      callbacks.onFunctionCall?.({
        callEpoch: 1,
        responseId,
        callId: `review-call-${++nextCallId}`,
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
        inputItemId: `input-${responseId}`,
        inputTranscript:
          request ??
          (name === 'cancel_proactive_task'
            ? 'Cancel the current task.'
            : 'Change the current monitor task to repeat every time.'),
        activeTranscript: [],
      }),
  };
}

describe('PR #11369 proactive diagnostics review reproduction', () => {
  it.each([
    ['invalid JSON', 'update_proactive_task', '{oops', '有效的 JSON'],
    ['non-object JSON', 'update_proactive_task', '[]', 'JSON 对象'],
    [
      'selector-less update arguments',
      'update_proactive_task',
      { title: 'Changed task' },
      '仅对紧邻刚创建的任务设置 repeat=true 时可省略目标',
    ],
    [
      'selector-less update without adjacency',
      'update_proactive_task',
      { repeat: true },
      '没有紧邻刚创建的活动任务；请提供 target_title 或 target_title_contains',
    ],
    [
      'selector-less cancel arguments',
      'cancel_proactive_task',
      { all: false },
      '无目标取消必须使用空参数对象',
    ],
    [
      'selector-less cancel without adjacency',
      'cancel_proactive_task',
      {},
      '没有紧邻刚创建的活动任务；请提供 target_title 或 target_title_contains，停止全部任务请使用 all=true',
    ],
  ] as const)(
    'R2-5 keeps the repair hint for %s through the real dispatcher',
    async (_label, toolName, args, hint) => {
      const observed = harness();
      await observed.start();
      observed.begin('invalid');
      observed.call('invalid', toolName, args);
      await vi.waitFor(() => expect(observed.outputs).toHaveLength(1));
      expect(observed.outputs[0]).toContain(hint);
      expect(observed.outputs[0]).not.toContain('提交的信息未通过校验');
      expect(observed.scheduler.listTasks()).toEqual([]);
    },
  );

  it('R1-22: classifies the actual oversized-instruction guard as configuration', async () => {
    const createWebSocket = vi.fn(() => {
      throw new Error('Oversized instructions must not create a socket.');
    });
    const observed = harness((config, callbacks) =>
      openQwenRealtimeSession(
        { ...config, instructions: 'x'.repeat(100_001) },
        callbacks,
        { createWebSocket },
      ),
    );
    const error: unknown = await observed
      .start()
      .catch((error: unknown) => error);
    expect(createWebSocket).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(Error);
    const userMessage = observed.host.failCall.mock.lastCall?.[1] ?? '';
    expect(error).toMatchObject({ kind: 'configuration' });
    expect(displayLiveMessage('en', userMessage)).toContain(
      'Realtime configuration failed:',
    );
    expect(observed.host.setProviderReachability).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'unavailable',
        blocker: 'provider_config',
      }),
    );
  });

  it('R1-29: exposes the selector-less-update rule in its failure receipt', async () => {
    const observed = harness();
    await observed.start();
    observed.begin('create');
    observed.call(
      'create',
      'create_proactive_timer',
      {
        title: 'Tea timer',
        duration_sec: 300,
        reminder_text: 'Tea is ready.',
      },
      'Set a five-minute tea timer.',
    );
    await vi.waitFor(() =>
      expect(observed.scheduler.listTasks()).toHaveLength(1),
    );
    observed.done('create');
    observed.begin('rename');
    observed.call(
      'rename',
      'update_proactive_task',
      {
        title: 'Kitchen timer',
      },
      'Rename the Tea timer to Kitchen timer.',
    );
    await vi.waitFor(() => expect(observed.outputs).toHaveLength(2));
    const failureReceipt = observed.outputs.at(-1)!;
    const failureLog = observed.log.write.mock.calls.find(
      ([, details]) =>
        details?.message ===
        'An adjacent selector-less update may only set repeat=true.',
    );
    expect(failureLog).toBeDefined();
    expect(observed.scheduler.listTasks()[0]?.title).toBe('Tea timer');
    observed.call(
      'rename',
      'update_proactive_task',
      {
        target_title: 'Tea timer',
        title: 'Kitchen timer',
      },
      'Rename the Tea timer to Kitchen timer.',
    );
    await vi.waitFor(() =>
      expect(observed.scheduler.listTasks()[0]?.title).toBe('Kitchen timer'),
    );
    expect(failureReceipt).toContain('repeat=true');
  });

  it('R1-23 location 2: accepts all 25 current schema keys and rejects extra keys', async () => {
    const observed = harness();
    await observed.start();
    let properties = 0;
    const requests: Record<string, string> = {
      create_proactive_monitor: 'Watch the window and remind me if it opens.',
      create_live_narration: 'Keep narrating the screen.',
      create_proactive_timer: 'Set a five-minute tea timer.',
      update_proactive_task: 'Rename the Tea timer to Kitchen timer.',
      cancel_proactive_task: 'Cancel the Tea timer.',
      list_proactive_tasks: 'List the current tasks.',
    };
    for (const tool of PROACTIVE_SESSION_TOOLS) {
      const response = `schema-${tool.function.name}`;
      observed.begin(response);
      const schema = tool.function.parameters['properties'] as Record<
        string,
        unknown
      >;
      const args = Object.fromEntries(
        Object.keys(schema).map((key) => [key, null]),
      );
      properties += Object.keys(args).length;
      observed.log.write.mockClear();
      const before = observed.outputs.length;
      observed.call(
        response,
        tool.function.name,
        args,
        requests[tool.function.name],
      );
      await vi.waitFor(() => expect(observed.outputs).toHaveLength(before + 1));
      const logs = JSON.stringify(observed.log.write.mock.calls);
      expect(logs).not.toContain('Unknown Proactive argument');
      observed.log.write.mockClear();
      observed.call(
        response,
        tool.function.name,
        {
          extra_review_key: true,
        },
        requests[tool.function.name],
      );
      await vi.waitFor(() => expect(observed.outputs).toHaveLength(before + 2));
      expect(JSON.stringify(observed.log.write.mock.calls)).toContain(
        'Unknown Proactive argument: extra_review_key.',
      );
    }
    expect(properties).toBe(25);
  });
});
