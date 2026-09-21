/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncEventQueue } from '../adaptor/async-event-queue.js';
import { BackendRegistry } from '../adaptor/registry.js';
import type {
  BackendAdaptor,
  BackendEvent,
  BackendHandle,
} from '../adaptor/types.js';
import { DEFAULT_PROACTIVE_CONFIG } from '../config.js';
import type { SessionLog } from '../log/session-log.js';
import type {
  ProactiveSchedulerControl,
  ProactiveSchedulerOptions,
} from '../proactive/scheduler.js';
import {
  ProactiveTaskManager,
  type ProactiveTask,
} from '../proactive/task-manager.js';
import type {
  QwenRealtimeCallbacks,
  QwenRealtimeSession,
  RealtimeCloseInfo,
  RealtimeFunctionCall,
  RealtimeFunctionCallRef,
  RealtimeResponseAuthority,
} from '../realtime/realtime-session.js';
import type { RealtimeFunctionOutputOptions } from '../realtime/tool-confirmation.js';
import { LiveSession, type LiveHostControl } from './live-session.js';

type Json = Record<string, unknown>;
type Turn = {
  inputId?: string;
  responseId: string;
  authority: RealtimeResponseAuthority;
};
const CALL = { epoch: 1, callId: 'task-boundary-call' };
const MONITOR_REQUEST = '你听到我敲三下桌子，就提醒我。';
const MONITOR_ARGS = {
  title: '敲桌子提醒',
  modalities: ['audio'],
  condition: '听到用户敲击桌子三下',
  trigger_response: '告诉用户听到了三下敲击',
  repeat: false,
};
const VISION_MONITOR_ARGS = {
  title: '网页使用提醒',
  modalities: ['vision'],
  condition: '屏幕出现用户指定的非工作网页',
  trigger_response: '提醒用户回去工作',
  repeat: false,
};
const NARRATION_ARGS = {
  title: '画面实时描述',
  modalities: ['vision'],
  narration_focus: '当前屏幕画面内容及其变化',
};
const cleanup: LiveSession[] = [];
afterEach(() => {
  for (const session of cleanup.splice(0)) session.dispose();
});

/** Fake media scheduler with real public task validation/state transitions. */
class TaskScheduler implements ProactiveSchedulerControl {
  readonly manager: ProactiveTaskManager;
  constructor(options: ProactiveSchedulerOptions) {
    this.manager = new ProactiveTaskManager(undefined, (task) =>
      options.onTaskChanged?.(task),
    );
  }
  private running(task: ProactiveTask): ProactiveTask {
    return this.manager.mutate(task.taskId, task.generation, (current) => {
      current.status = 'running';
      return true;
    })!;
  }
  readonly createPerceptionMonitor = vi.fn(
    (
      input: Parameters<
        ProactiveSchedulerControl['createPerceptionMonitor']
      >[0],
    ) => this.running(this.manager.createMonitor(input)),
  );
  readonly createLiveNarration = vi.fn(
    (input: Parameters<ProactiveSchedulerControl['createLiveNarration']>[0]) =>
      this.running(this.manager.createNarration(input)),
  );
  readonly createTimer = vi.fn(
    (input: Parameters<ProactiveSchedulerControl['createTimer']>[0]) =>
      this.running(this.manager.createTimer(input)),
  );
  readonly updateTask = vi.fn(
    (input: Parameters<ProactiveSchedulerControl['updateTask']>[0]) =>
      this.manager.update(input),
  );
  readonly cancelTasks = vi.fn(
    (selector: Parameters<ProactiveSchedulerControl['cancelTasks']>[0]) =>
      this.manager.cancel(selector),
  );
  readonly cancelTaskById = vi.fn((id: string) => this.manager.cancelById(id));
  listTasks = () => this.manager.listActive();
  feedAudio = vi.fn();
  feedImage = vi.fn();
  resetVisualSource = vi.fn();
  announcementStarted = vi.fn();
  playbackStarted = vi.fn();
  deferDelivery = vi.fn(() => true);
  acknowledgeDelivery = vi.fn();
  failDelivery = vi.fn();
  undeliverDelivery = vi.fn();
  dispose = vi.fn();

  finish(id: string): void {
    const task = this.manager.get(id)!;
    this.manager.mutate(id, task.generation, (current) => {
      current.status = 'completed';
      current.triggerCount++;
      return true;
    });
  }
}

async function rig() {
  const queues = new Map<string, AsyncEventQueue<BackendEvent>>();
  const queueFor = (handle: BackendHandle) => {
    let queue = queues.get(handle.id);
    if (!queue) {
      queue = new AsyncEventQueue<BackendEvent>();
      queues.set(handle.id, queue);
    }
    return queue;
  };
  let backendSequence = 0;
  let jobSequence = 0;
  const createSession = vi.fn(async () => ({
    id: 'backend-' + ++backendSequence,
    adaptor: 'fake',
  }));
  const prompt = vi.fn(async (_handle: BackendHandle) => ({
    status: 'accepted' as const,
    jobRef: 'provider-job-' + ++jobSequence,
  }));
  const cancel = vi.fn(async (_handle: BackendHandle) => {});
  const cancelJob = vi.fn(
    async (_handle: BackendHandle, _jobRef: string): Promise<'stopping'> =>
      'stopping',
  );
  const adaptor: BackendAdaptor = {
    name: 'fake',
    capabilities: () => ({
      steering: 'native',
      imageInput: false,
      permissionForwarding: true,
      proactiveSpeak: false,
      sessionList: true,
      eventDelivery: 'stream',
    }),
    preflight: async () => {},
    createSession,
    listSessions: async () => [],
    prompt,
    events: (handle, options) => queueFor(handle).subscribe(options),
    isBusy: () => true,
    cancel,
    cancelJob,
    respondPermission: async () => 'delivered',
    close: async () => {},
  };
  const host: LiveHostControl = {
    setCallState: vi.fn(() => true),
    setCoordinator: vi.fn(() => true),
    sendOutputAudio: vi.fn(() => true),
    finishOutputAudio: vi.fn(),
    clearOutput: vi.fn(),
    setCaption: vi.fn(() => true),
    setStatusText: vi.fn(() => true),
    failCall: vi.fn(() => true),
    isOutputMuted: () => true,
    isInputMuted: () => false,
    captureVisualContext: vi.fn(async () => {
      throw new Error('No device capture in task-boundary fixtures');
    }),
  };
  const realtime = {
    callEpoch: 1,
    closed: new Promise<RealtimeCloseInfo>(() => {}),
    canDeliverExternalAudio: () => true,
    canStartExternalSpeech: () => true,
    flushDialogue: vi.fn(),
    configure: vi.fn(() => true),
    pushAudio: vi.fn(() => true),
    setInputMuted: vi.fn(),
    pushImage: vi.fn(() => true),
    commitInputAudio: vi.fn(() => true),
    clearInputAudio: vi.fn(() => true),
    cancelResponse: vi.fn(() => true),
    submitFunctionOutput: vi.fn(
      (
        _ref: RealtimeFunctionCallRef,
        _output: string,
        _options?: RealtimeFunctionOutputOptions,
      ) => true,
    ),
    sendBackendContext: vi.fn(() => true),
    speakToUser: vi.fn(() => true),
    askPermission: vi.fn(() => true),
    respondToProactiveEvent: vi.fn(() => true),
    requestProactiveRepair: vi.fn(
      (_instruction: string, _tools: readonly string[]) => true,
    ),
    takeTranscriptTail: vi.fn(() => []),
    close: vi.fn(),
  };
  const log = {
    write: vi.fn((_type: string, _payload: Json) => {}),
    close: async () => {},
  };
  let callbacks: QwenRealtimeCallbacks = {};
  let scheduler: TaskScheduler | undefined;
  const session = new LiveSession({
    host,
    registry: new BackendRegistry([{ adaptor, isDefault: true }]),
    realtime: {
      endpoint: 'https://no-network.invalid',
      model: 'task-fixture',
      voice: 'Tina',
    },
    proactive: DEFAULT_PROACTIVE_CONFIG,
    createProactiveScheduler: (options) =>
      (scheduler = new TaskScheduler(options)),
    log: log as unknown as SessionLog,
    getLanguage: () => 'zh-CN',
    notificationSpeech: async () => {
      throw new Error('No speech model in task-boundary fixtures');
    },
    openRealtime: async (_config, supplied = {}) => {
      callbacks = supplied;
      return realtime as unknown as QwenRealtimeSession;
    },
  });
  cleanup.push(session);
  await session.start({
    ...CALL,
    mode: 'new',
    visualInput: {
      source: 'screen',
      mode: 'on-demand',
      fps: 1,
      liveWidth: 1280,
      liveHeight: 720,
    },
  });
  let sequence = 0;
  const begin = (
    source?: string,
    options: {
      authority?: RealtimeResponseAuthority;
      inputId?: string;
      noInput?: boolean;
    } = {},
  ): Turn => {
    const id = ++sequence;
    const authority = options.authority ?? 'direct';
    const inputId =
      options.noInput || authority === 'proactive_repair'
        ? undefined
        : (options.inputId ?? 'user-' + id);
    if (authority === 'direct' && inputId) {
      callbacks.onSpeechStarted?.({ callEpoch: 1, itemId: inputId });
      callbacks.onInputCommitted?.({
        callEpoch: 1,
        itemId: inputId,
        responsePending: true,
      });
    }
    if (source !== undefined && inputId)
      callbacks.onInputTranscriptDone?.({
        callEpoch: 1,
        itemId: inputId,
        text: source,
      });
    const turn = { inputId, responseId: 'response-' + id, authority };
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: turn.responseId,
      inputItemId: inputId,
      authority,
    });
    return turn;
  };
  const done = (turn: Turn, status = 'completed', assistant?: string) => {
    if (assistant)
      callbacks.onDirectTranscript?.({
        callEpoch: 1,
        responseId: turn.responseId,
        inputItemId: turn.inputId,
        entries: [{ role: 'assistant', text: assistant }],
      });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: turn.responseId,
      inputItemId: turn.inputId,
      authority: turn.authority,
      status,
    });
  };
  const dispatch = (
    turn: Turn,
    name: string,
    args: Json,
    extra: Partial<RealtimeFunctionCall> = {},
  ) => {
    const callId = 'call-' + ++sequence;
    callbacks.onFunctionCall?.({
      callEpoch: 1,
      responseId: turn.responseId,
      inputItemId: turn.inputId,
      callId,
      name,
      arguments: JSON.stringify(args),
      activeTranscript: [],
      ...extra,
    });
    return callId;
  };
  const result = async (callId: string) => {
    await vi.waitFor(
      () =>
        expect(
          log.write.mock.calls.some(
            ([type, payload]) =>
              type === 'tool.result' && payload['callId'] === callId,
          ),
        ).toBe(true),
      { timeout: 3500 },
    );
    return log.write.mock.calls.find(
      ([type, payload]) =>
        type === 'tool.result' && payload['callId'] === callId,
    )![1];
  };
  const invoke = async (
    turn: Turn,
    name: string,
    args: Json,
    extra?: Partial<RealtimeFunctionCall>,
  ) => {
    const id = dispatch(turn, name, args, extra);
    done(turn);
    return result(id);
  };
  const createMonitor = async (
    source = MONITOR_REQUEST,
    args: Json = MONITOR_ARGS,
  ) => {
    const turn = begin(source);
    expect((await invoke(turn, 'create_proactive_monitor', args))['ok']).toBe(
      true,
    );
    return {
      turn,
      task: scheduler!.createPerceptionMonitor.mock.results.at(-1)!
        .value as ProactiveTask,
    };
  };
  const createBackend = async (
    source = 'Create the PPT presentation',
    separate = false,
  ) => {
    let sessionHandle: string | undefined;
    if (separate) {
      const created = await invoke(
        begin('Create a new coding session'),
        'session_create',
        { label: source },
      );
      expect(created['ok']).toBe(true);
      const receipt = JSON.parse(String(created['receipt'])) as Json;
      expect(receipt).toMatchObject({
        status: 'ok',
        handle: expect.any(String),
      });
      sessionHandle = String(receipt['handle']);
    }
    const admitted = await invoke(begin(source), 'handoff', {
      task: source,
      ...(sessionHandle ? { session: sessionHandle } : {}),
    });
    expect(admitted['ok']).toBe(true);
    const receipt = JSON.parse(String(admitted['receipt'])) as {
      session: string;
      job: string;
      status: string;
    };
    expect(receipt).toMatchObject({
      status: 'accepted',
      session: expect.any(String),
      job: expect.any(String),
    });
    return receipt;
  };
  return {
    session,
    callbacks,
    scheduler: scheduler!,
    realtime,
    host,
    log,
    createSession,
    prompt,
    cancel,
    cancelJob,
    begin,
    done,
    dispatch,
    result,
    invoke,
    createMonitor,
    createBackend,
  };
}

function rejected(result: Json): void {
  expect(result['ok']).toBe(false);
  expect(JSON.parse(String(result['receipt']))).toMatchObject({
    status: 'clarification_required',
    code: 'task_authorization_required',
  });
}

describe('task lifecycle boundaries through LiveSession callbacks', () => {
  it.each([
    '你要是看见我打开知乎，就让我别玩，别玩了。',
    '要是看见我打开视频网页，就叫我回去工作。',
    '如果发现我在浏览购物网站，就让我回去工作。',
    '帮我留意着屏幕，看到我刷知乎就喊我。',
  ])(
    'starts a conditional monitor from the first genuine request: %s',
    async (source) => {
      const r = await rig();
      const result = await r.invoke(
        r.begin(source),
        'create_proactive_monitor',
        VISION_MONITOR_ARGS,
      );
      expect(result['ok']).toBe(true);
      expect(r.realtime.submitFunctionOutput).toHaveBeenLastCalledWith(
        { callEpoch: 1, callId: result['callId'] },
        result['receipt'],
        { taskAdmission: true },
      );
      expect(r.scheduler.createPerceptionMonitor).toHaveBeenCalledTimes(1);
      expect(r.scheduler.listTasks()).toEqual([
        expect.objectContaining({
          title: VISION_MONITOR_ARGS.title,
          status: 'running',
          monitorMode: 'event',
          taskDescription: VISION_MONITOR_ARGS.condition,
        }),
      ]);
      expect(r.log.write).not.toHaveBeenCalledWith(
        'task.authorization_rejected',
        expect.anything(),
      );
      expect(r.host.captureVisualContext).not.toHaveBeenCalled();
    },
  );

  it('accepts both genuine screen-narration requests without requiring a different phrasing', async () => {
    const r = await rig();
    const source = '你对我的画面进行不断的描述。';
    const taskIds: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await r.invoke(
        r.begin(source),
        'create_live_narration',
        NARRATION_ARGS,
      );
      expect(result['ok']).toBe(true);
      expect(r.realtime.submitFunctionOutput).toHaveBeenLastCalledWith(
        { callEpoch: 1, callId: result['callId'] },
        result['receipt'],
        { taskAdmission: true },
      );
      expect(r.scheduler.listTasks()).toEqual([
        expect.objectContaining({
          title: NARRATION_ARGS.title,
          status: 'running',
          monitorMode: 'always',
          narrationPreferences: expect.objectContaining({
            sourceRequest: source,
          }),
        }),
      ]);
      const task = r.scheduler.listTasks()[0]!;
      taskIds.push(task.taskId);
      // A new explicit input may recreate a task after its earlier run ended.
      // Keep the real manager's same-title active-task protection in place.
      r.scheduler.finish(task.taskId);
    }
    expect(new Set(taskIds).size).toBe(2);
    expect(r.scheduler.createLiveNarration).toHaveBeenCalledTimes(2);
    expect(r.realtime.requestProactiveRepair).not.toHaveBeenCalled();
    expect(r.host.captureVisualContext).not.toHaveBeenCalled();
  });

  it.each([
    '请对我的屏幕进行持续的讲解。',
    '你一直给我描述画面的变化。',
    '接下来边看屏幕边给我讲讲变化。',
  ])(
    'starts narration for an explicit continuous description: %s',
    async (source) => {
      const r = await rig();
      const result = await r.invoke(
        r.begin(source),
        'create_live_narration',
        NARRATION_ARGS,
      );
      expect(result['ok']).toBe(true);
      expect(r.realtime.submitFunctionOutput).toHaveBeenLastCalledWith(
        { callEpoch: 1, callId: result['callId'] },
        result['receipt'],
        { taskAdmission: true },
      );
      expect(r.scheduler.createLiveNarration).toHaveBeenCalledTimes(1);
      expect(r.scheduler.listTasks()).toEqual([
        expect.objectContaining({
          status: 'running',
          monitorMode: 'always',
          narrationPreferences: expect.objectContaining({
            sourceRequest: source,
          }),
        }),
      ]);
    },
  );

  it('does not turn a missed-reminder complaint into creation or repair of an old monitor', async () => {
    const r = await rig();
    const { task } = await r.createMonitor(
      '看到我打开非工作网页，就提醒我回去工作。',
      VISION_MONITOR_ARGS,
    );
    r.scheduler.finish(task.taskId);
    r.done(
      r.begin('你怎么不喊我？'),
      'completed',
      '刚才没喊成，我这就重新设好监控。',
    );
    expect(r.realtime.requestProactiveRepair).not.toHaveBeenCalled();
    const denied = await r.invoke(
      r.begin('你怎么不喊我？'),
      'create_proactive_monitor',
      VISION_MONITOR_ARGS,
    );
    rejected(denied);
    expect(r.realtime.submitFunctionOutput).toHaveBeenLastCalledWith(
      { callEpoch: 1, callId: denied['callId'] },
      denied['receipt'],
      { taskAuthorizationRejected: true },
    );
    rejected(
      await r.invoke(
        r.begin(undefined, { authority: 'proactive_repair' }),
        'create_proactive_monitor',
        VISION_MONITOR_ARGS,
      ),
    );
    expect(r.scheduler.createPerceptionMonitor).toHaveBeenCalledTimes(1);
    expect(r.scheduler.listTasks()).toEqual([]);
    expect(r.realtime.requestProactiveRepair).not.toHaveBeenCalled();
  });

  it.each([
    '描述一下当前屏幕。',
    '你看看我现在的画面上有什么。',
    '请描述一次当前画面。',
  ])(
    'does not promote a one-shot screen request into continuous narration: %s',
    async (source) => {
      const r = await rig();
      const result = await r.invoke(
        r.begin(source),
        'create_live_narration',
        NARRATION_ARGS,
      );
      rejected(result);
      expect(r.realtime.submitFunctionOutput).toHaveBeenLastCalledWith(
        { callEpoch: 1, callId: result['callId'] },
        result['receipt'],
        { taskAuthorizationRejected: true },
      );
      expect(r.scheduler.createLiveNarration).not.toHaveBeenCalled();
      expect(r.scheduler.listTasks()).toEqual([]);
      expect(r.host.captureVisualContext).not.toHaveBeenCalled();
    },
  );

  it('does not recreate a completed knock monitor after conversation criticism or forged repair', async () => {
    const r = await rig();
    const { task } = await r.createMonitor();
    r.scheduler.finish(task.taskId);
    expect(r.scheduler.listTasks()).toEqual([]);
    r.done(r.begin('你胡说。'), 'completed', '我帮你纠正。');
    expect(r.realtime.requestProactiveRepair).not.toHaveBeenCalled();
    rejected(
      await r.invoke(
        r.begin('你胡说。'),
        'create_proactive_monitor',
        MONITOR_ARGS,
      ),
    );
    rejected(
      await r.invoke(
        r.begin(undefined, { authority: 'proactive_repair' }),
        'create_proactive_monitor',
        MONITOR_ARGS,
      ),
    );
    expect(r.scheduler.createPerceptionMonitor).toHaveBeenCalledTimes(1);
  });

  it('refuses a hallucinated stop during chat, then accepts an explicit PPT cancellation', async () => {
    const r = await rig();
    const job = await r.createBackend();
    rejected(
      await r.invoke(r.begin('你觉得我现在看上去怎么样？'), 'session_stop', {
        session: job.session,
        job: job.job,
      }),
    );
    expect(r.cancel).not.toHaveBeenCalled();
    expect(r.cancelJob).not.toHaveBeenCalled();
    const stop = await r.invoke(r.begin('取消PPT任务'), 'session_stop', {
      session: job.session,
      job: job.job,
    });
    expect(stop['ok']).toBe(true);
    expect(JSON.parse(String(stop['receipt']))).toMatchObject({
      status: 'cancelling',
      session: job.session,
    });
    expect(r.cancelJob).toHaveBeenCalledTimes(1);
  });

  it.each([
    '别说了。',
    '他说“取消PPT任务”。',
    '不要取消PPT任务。',
    'PPT任务已经取消了吗？',
  ])('does not cancel work for %s', async (source) => {
    const r = await rig();
    const job = await r.createBackend();
    rejected(await r.invoke(r.begin(source), 'session_stop', { job: job.job }));
    expect(r.cancelJob).not.toHaveBeenCalled();
    expect(r.cancel).not.toHaveBeenCalled();
  });

  it('rejects a mismatched session/job even for an explicit cancellation', async () => {
    const r = await rig();
    const ppt = await r.createBackend();
    const build = await r.createBackend('Build the project', true);
    rejected(
      await r.invoke(r.begin('取消PPT任务'), 'session_stop', {
        session: build.session,
        job: ppt.job,
      }),
    );
    expect(r.cancelJob).not.toHaveBeenCalled();
    expect(r.cancel).not.toHaveBeenCalled();
  });

  it('does not pick a task for an ambiguous reference or broaden it to all', async () => {
    const r = await rig();
    const ppt = await r.createBackend();
    await r.createBackend('Build the project', true);
    rejected(
      await r.invoke(r.begin('取消刚才那个任务'), 'session_stop', {
        job: ppt.job,
      }),
    );
    await r.createMonitor();
    rejected(
      await r.invoke(r.begin('取消刚才那个任务'), 'cancel_proactive_task', {
        all: true,
      }),
    );
    expect(r.cancelJob).not.toHaveBeenCalled();
    expect(r.scheduler.cancelTasks).not.toHaveBeenCalled();
  });

  it('preserves the explicit UI stop entry independently of speech authorization', async () => {
    const r = await rig();
    const job = await r.createBackend();
    r.done(r.begin('随便聊聊吧。'));
    const result = await r.session.handleSubagentsRequest({
      action: 'stop',
      taskId: 'harness:' + job.job,
    });
    expect(result).toMatchObject({
      type: 'outcome',
      taskId: 'harness:' + job.job,
    });
    expect(r.cancelJob).toHaveBeenCalledTimes(1);
  });

  it('allows a named Proactive cancellation and an explicitly requested all-task cancellation', async () => {
    const r = await rig();
    await r.createMonitor();
    expect(
      (
        await r.invoke(
          r.begin('取消敲桌子提醒任务。'),
          'cancel_proactive_task',
          { target_title: MONITOR_ARGS.title },
        )
      )['ok'],
    ).toBe(true);
    expect(r.scheduler.cancelTasks).toHaveBeenCalledTimes(1);
    expect(r.scheduler.listTasks()).toEqual([]);
    await r.createMonitor();
    await r.createMonitor('监控门的变化，有变化就提醒我。', {
      ...MONITOR_ARGS,
      title: '门监控',
      modalities: ['vision'],
      condition: '门被打开',
    });
    expect(
      (
        await r.invoke(r.begin('取消全部任务。'), 'cancel_proactive_task', {
          all: true,
        })
      )['ok'],
    ).toBe(true);
    expect(r.scheduler.cancelTasks).toHaveBeenCalledTimes(2);
    expect(r.scheduler.listTasks()).toEqual([]);
  });

  it('does not use a model-supplied activeTranscript when the input identity is absent', async () => {
    const r = await rig();
    rejected(
      await r.invoke(
        r.begin(undefined, { noInput: true }),
        'create_proactive_monitor',
        MONITOR_ARGS,
        { activeTranscript: [{ role: 'user', text: MONITOR_REQUEST }] },
      ),
    );
    expect(r.scheduler.createPerceptionMonitor).not.toHaveBeenCalled();
  });

  it('does not use a model-supplied activeTranscript instead of missing bound ASR', async () => {
    const r = await rig();
    rejected(
      await r.invoke(r.begin(), 'create_proactive_monitor', MONITOR_ARGS, {
        activeTranscript: [{ role: 'user', text: MONITOR_REQUEST }],
      }),
    );
    expect(r.scheduler.createPerceptionMonitor).not.toHaveBeenCalled();
  });

  it('accepts a matching late final ASR after the completed response callback', async () => {
    const r = await rig();
    const turn = r.begin();
    const call = r.dispatch(turn, 'create_proactive_monitor', MONITOR_ARGS);
    r.done(turn);
    r.callbacks.onDialogue?.({
      callEpoch: 1,
      inputItemId: turn.inputId!,
      role: 'user',
      text: MONITOR_REQUEST,
    });
    expect((await r.result(call))['ok']).toBe(true);
    expect(r.scheduler.createPerceptionMonitor).toHaveBeenCalledTimes(1);
  });

  it('rejects a tool whose input ID differs from the response-bound genuine request', async () => {
    const r = await rig();
    rejected(
      await r.invoke(
        r.begin(MONITOR_REQUEST),
        'create_proactive_monitor',
        MONITOR_ARGS,
        { inputItemId: 'unrelated-input' },
      ),
    );
    expect(r.scheduler.createPerceptionMonitor).not.toHaveBeenCalled();
  });

  it('revokes a waiting task call when another user starts speaking', async () => {
    const r = await rig();
    const turn = r.begin();
    const call = r.dispatch(turn, 'create_proactive_monitor', MONITOR_ARGS);
    r.done(turn);
    r.callbacks.onSpeechStarted?.({ callEpoch: 1, itemId: 'newer-user' });
    r.callbacks.onDialogue?.({
      callEpoch: 1,
      inputItemId: turn.inputId!,
      role: 'user',
      text: MONITOR_REQUEST,
    });
    rejected(await r.result(call));
    expect(r.scheduler.createPerceptionMonitor).not.toHaveBeenCalled();
  });

  it('revokes pending ASR authorization across transport recovery', async () => {
    const r = await rig();
    const turn = r.begin();
    const call = r.dispatch(turn, 'create_proactive_monitor', MONITOR_ARGS);
    r.done(turn);
    const recovery = {
      callEpoch: 1,
      inputKind: 'none' as const,
      code: 'response_created_timeout' as const,
      responseId: turn.responseId,
      authority: 'direct' as const,
    };
    r.callbacks.onTransportRecovery?.({ ...recovery, phase: 'started' });
    r.callbacks.onTransportRecovery?.({ ...recovery, phase: 'completed' });
    r.callbacks.onDialogue?.({
      callEpoch: 1,
      inputItemId: turn.inputId!,
      role: 'user',
      text: MONITOR_REQUEST,
    });
    rejected(await r.result(call));
    expect(r.scheduler.createPerceptionMonitor).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'failed'])(
    'does not admit a late-ASR task after response %s',
    async (status) => {
      const r = await rig();
      const turn = r.begin();
      const call = r.dispatch(turn, 'create_proactive_monitor', MONITOR_ARGS);
      r.done(turn, status);
      // The transport can retire the old call before its late ASR arrives.
      r.realtime.submitFunctionOutput.mockReturnValue(false);
      r.callbacks.onDialogue?.({
        callEpoch: 1,
        inputItemId: turn.inputId!,
        role: 'user',
        text: MONITOR_REQUEST,
      });
      rejected(await r.result(call));
      expect(r.scheduler.createPerceptionMonitor).not.toHaveBeenCalled();
      expect(r.host.failCall).not.toHaveBeenCalled();
    },
  );

  it('deduplicates identical creation arguments in the same input continuation', async () => {
    const r = await rig();
    const { turn } = await r.createMonitor();
    const repeat = r.begin(undefined, {
      inputId: turn.inputId,
      authority: 'tool_continuation',
    });
    const reordered = Object.fromEntries(
      Object.entries(MONITOR_ARGS).reverse(),
    );
    expect(
      (await r.invoke(repeat, 'create_proactive_monitor', reordered))['ok'],
    ).toBe(true);
    expect(r.scheduler.createPerceptionMonitor).toHaveBeenCalledTimes(1);
  });

  it('allows the same explicit request from a new input after its earlier task completed', async () => {
    const r = await rig();
    const first = await r.createMonitor();
    r.scheduler.finish(first.task.taskId);
    const second = await r.createMonitor();
    expect(second.task.taskId).not.toBe(first.task.taskId);
    expect(r.scheduler.createPerceptionMonitor).toHaveBeenCalledTimes(2);
  });

  it('allows distinct requested monitors and a timer within one genuine user input', async () => {
    const r = await rig();
    const turn = r.begin(
      '监控水杯是否被移动，同时监控门是否打开，有变化就提醒我；5分钟后提醒我喝水。',
    );
    const first = r.dispatch(turn, 'create_proactive_monitor', {
      ...MONITOR_ARGS,
      title: '水杯监控',
      modalities: ['vision'],
      condition: '水杯被移动',
      trigger_response: '告诉用户水杯被移动',
    });
    const second = r.dispatch(turn, 'create_proactive_monitor', {
      ...MONITOR_ARGS,
      title: '门监控',
      modalities: ['vision'],
      condition: '门被打开',
      trigger_response: '告诉用户门被打开',
    });
    const timer = r.dispatch(turn, 'create_proactive_timer', {
      title: '喝水提醒',
      duration_sec: 300,
      reminder_text: '喝点水',
    });
    r.done(turn);
    expect((await r.result(first))['ok']).toBe(true);
    expect((await r.result(second))['ok']).toBe(true);
    expect((await r.result(timer))['ok']).toBe(true);
    expect(r.scheduler.createPerceptionMonitor).toHaveBeenCalledTimes(2);
    expect(r.scheduler.createTimer).toHaveBeenCalledTimes(1);
  });

  it('starts one legal repair only for an unfulfilled explicit current request', async () => {
    const r = await rig();
    const turn = r.begin(MONITOR_REQUEST);
    r.done(turn, 'completed', '我会监听敲桌子的声音并提醒你。');
    expect(r.realtime.requestProactiveRepair).toHaveBeenCalledTimes(1);
    expect(r.realtime.requestProactiveRepair.mock.calls[0]![1]).toContain(
      'create_proactive_monitor',
    );
    expect(
      (
        await r.invoke(
          r.begin(undefined, { authority: 'proactive_repair' }),
          'create_proactive_monitor',
          MONITOR_ARGS,
        )
      )['ok'],
    ).toBe(true);
    expect(r.scheduler.createPerceptionMonitor).toHaveBeenCalledTimes(1);
  });

  it('does not repair handled requests, ordinary chat, or an assistant-only promise', async () => {
    const r = await rig();
    const turn = r.begin(MONITOR_REQUEST);
    const call = r.dispatch(turn, 'create_proactive_monitor', MONITOR_ARGS);
    r.done(turn, 'completed', '我会监听敲桌子的声音并提醒你。');
    expect((await r.result(call))['ok']).toBe(true);
    r.done(
      r.begin(undefined, { noInput: true }),
      'completed',
      '我会监听敲桌子的声音并提醒你。',
    );
    r.done(
      r.begin('你今天心情怎么样？'),
      'completed',
      '我会监听敲桌子的声音并提醒你。',
    );
    expect(r.realtime.requestProactiveRepair).not.toHaveBeenCalled();
  });

  it('does not escalate creation repair into cancellation of an existing task', async () => {
    const r = await rig();
    await r.createMonitor();
    r.done(
      r.begin('监控屏幕是否变红，有变化就提醒我。'),
      'completed',
      '我会监控屏幕并提醒你。',
    );
    expect(r.realtime.requestProactiveRepair).toHaveBeenCalledTimes(1);
    expect(r.realtime.requestProactiveRepair.mock.calls[0]![1]).not.toContain(
      'cancel_proactive_task',
    );
    rejected(
      await r.invoke(
        r.begin(undefined, { authority: 'proactive_repair' }),
        'cancel_proactive_task',
        { target_title: MONITOR_ARGS.title },
      ),
    );
    expect(r.scheduler.cancelTasks).not.toHaveBeenCalled();
  });

  it('does not reuse repair after a newer real input', async () => {
    const r = await rig();
    r.done(
      r.begin(MONITOR_REQUEST),
      'completed',
      '我会监听敲桌子的声音并提醒你。',
    );
    expect(r.realtime.requestProactiveRepair).toHaveBeenCalledTimes(1);
    r.done(r.begin('聊点别的吧。'));
    rejected(
      await r.invoke(
        r.begin(undefined, { authority: 'proactive_repair' }),
        'create_proactive_monitor',
        MONITOR_ARGS,
      ),
    );
    expect(r.scheduler.createPerceptionMonitor).not.toHaveBeenCalled();
  });

  it('does not cancel a same-title replacement through an older repair target lease', async () => {
    const r = await rig();
    const { task } = await r.createMonitor();
    r.done(
      r.begin('取消敲桌子提醒任务。'),
      'completed',
      '好的，已取消敲桌子提醒任务。',
    );
    expect(r.realtime.requestProactiveRepair).toHaveBeenCalledTimes(1);
    r.scheduler.finish(task.taskId);
    const replacement = r.scheduler.createPerceptionMonitor({
      title: MONITOR_ARGS.title,
      modalities: ['audio'],
      condition: MONITOR_ARGS.condition,
      triggerResponse: MONITOR_ARGS.trigger_response,
      repeat: false,
    });
    expect(replacement.taskId).not.toBe(task.taskId);
    rejected(
      await r.invoke(
        r.begin(undefined, { authority: 'proactive_repair' }),
        'cancel_proactive_task',
        { target_title: MONITOR_ARGS.title },
      ),
    );
    expect(r.scheduler.cancelTasks).not.toHaveBeenCalled();
    expect(r.scheduler.listTasks().map((entry) => entry.taskId)).toContain(
      replacement.taskId,
    );
  });

  it('does not update a different task from the one named by the current user', async () => {
    const r = await rig();
    await r.createMonitor('监控水杯变化，有变化就提醒我。', {
      ...MONITOR_ARGS,
      title: '水杯监控',
      modalities: ['vision'],
      condition: '水杯被移动',
    });
    await r.createMonitor('监控门的变化，有变化就提醒我。', {
      ...MONITOR_ARGS,
      title: '门监控',
      modalities: ['vision'],
      condition: '门被打开',
    });
    rejected(
      await r.invoke(
        r.begin('把水杯监控任务的条件改成杯子被拿走。'),
        'update_proactive_task',
        { target_title: '门监控', condition: '杯子被拿走' },
      ),
    );
    expect(r.scheduler.updateTask).not.toHaveBeenCalled();
    expect(
      (
        await r.invoke(
          r.begin('把水杯监控任务的条件改成杯子被拿走。'),
          'update_proactive_task',
          { target_title: '水杯监控', condition: '杯子被拿走' },
        )
      )['ok'],
    ).toBe(true);
    expect(r.scheduler.updateTask).toHaveBeenCalledTimes(1);
    expect(
      r.scheduler.listTasks().find((task) => task.title === '水杯监控'),
    ).toMatchObject({ taskDescription: '杯子被拿走' });
  });

  it('does not apply a pending direct cancellation or update to a same-title replacement after late ASR', async () => {
    for (const name of ['cancel_proactive_task', 'update_proactive_task']) {
      const r = await rig();
      const { task } = await r.createMonitor();
      const turn = r.begin();
      const args = {
        target_title: MONITOR_ARGS.title,
        ...(name === 'update_proactive_task'
          ? { condition: '听到两下敲击' }
          : {}),
      };
      const pending = r.dispatch(turn, name, args);
      r.done(turn);
      // External task-state events replace the target while this genuine input
      // is still waiting for its final ASR. The visible title is unchanged.
      r.scheduler.finish(task.taskId);
      const replacement = r.scheduler.createPerceptionMonitor({
        title: MONITOR_ARGS.title,
        modalities: ['audio'],
        condition: MONITOR_ARGS.condition,
        triggerResponse: MONITOR_ARGS.trigger_response,
        repeat: false,
      });
      expect(replacement.taskId).not.toBe(task.taskId);
      r.callbacks.onDialogue?.({
        callEpoch: 1,
        inputItemId: turn.inputId!,
        role: 'user',
        text:
          name === 'cancel_proactive_task'
            ? '取消敲桌子提醒任务。'
            : '把敲桌子提醒任务的条件改成听到两下敲击。',
      });
      rejected(await r.result(pending));
      expect(r.scheduler.cancelTasks).not.toHaveBeenCalled();
      expect(r.scheduler.updateTask).not.toHaveBeenCalled();
      expect(r.scheduler.listTasks()).toEqual([
        expect.objectContaining({
          taskId: replacement.taskId,
          status: 'running',
          taskDescription: MONITOR_ARGS.condition,
        }),
      ]);
    }
  });

  it('does not update a same-title replacement through an older authorized update repair', async () => {
    const r = await rig();
    const { task } = await r.createMonitor();
    r.done(
      r.begin('把敲桌子提醒任务的条件改成听到两下敲击。'),
      'completed',
      '我会继续监听敲桌子的声音并提醒你。',
    );
    expect(r.realtime.requestProactiveRepair).toHaveBeenCalledTimes(1);
    expect(r.realtime.requestProactiveRepair.mock.calls[0]![1]).toEqual([
      'update_proactive_task',
    ]);
    r.scheduler.finish(task.taskId);
    const replacement = r.scheduler.createPerceptionMonitor({
      title: MONITOR_ARGS.title,
      modalities: ['audio'],
      condition: MONITOR_ARGS.condition,
      triggerResponse: MONITOR_ARGS.trigger_response,
      repeat: false,
    });
    expect(replacement.taskId).not.toBe(task.taskId);
    rejected(
      await r.invoke(
        r.begin(undefined, { authority: 'proactive_repair' }),
        'update_proactive_task',
        { target_title: MONITOR_ARGS.title, condition: '听到两下敲击' },
      ),
    );
    expect(r.scheduler.updateTask).not.toHaveBeenCalled();
    expect(r.scheduler.listTasks()).toEqual([
      expect.objectContaining({
        taskId: replacement.taskId,
        status: 'running',
        taskDescription: MONITOR_ARGS.condition,
      }),
    ]);
  });
});
