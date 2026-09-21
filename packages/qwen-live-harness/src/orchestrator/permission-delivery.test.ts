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
  PermissionDecision,
  PermissionDetails,
  PermissionOption,
} from '../adaptor/types.js';
import type { SessionLog } from '../log/session-log.js';
import type {
  NotificationSpeechOptions,
  NotificationSpeechResult,
} from '../realtime/notification-speech.js';
import type {
  QwenRealtimeCallbacks,
  QwenRealtimeSession,
  RealtimeCloseInfo,
  RealtimeFunctionCallRef,
} from '../realtime/realtime-session.js';
import { LiveSession, type LiveHostControl } from './live-session.js';

const ONCE: readonly PermissionOption[] = [
  { optionId: 'once', kind: 'proceed', escalation: 'once' },
  { optionId: 'deny', kind: 'reject', escalation: 'once' },
];
const BACKEND: BackendHandle = { id: 'backend-session', adaptor: 'fake' };
const cleanup: LiveSession[] = [];
afterEach(() => {
  for (const session of cleanup.splice(0)) session.dispose();
});

async function createRig(initialMode: 'ask' | 'allow-all' = 'ask') {
  const directory = '/workspace/permission-fixture';
  const modeState = { mode: initialMode };
  const queue = new AsyncEventQueue<BackendEvent>();
  const queues = new Map([[BACKEND.id, queue]]);
  const queueFor = (backend: BackendHandle) => {
    let existing = queues.get(backend.id);
    if (!existing) {
      existing = new AsyncEventQueue<BackendEvent>();
      queues.set(backend.id, existing);
    }
    return existing;
  };
  let sessionSequence = 0;
  const respondPermission = vi.fn(
    async (
      _backend: BackendHandle,
      _requestId: string,
      _decision: PermissionDecision,
    ): Promise<'delivered' | 'already_resolved'> => 'delivered',
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
    createSession: async () =>
      ++sessionSequence === 1
        ? BACKEND
        : { ...BACKEND, id: `backend-session-${sessionSequence}` },
    listSessions: async () => [],
    prompt: vi.fn(async (backend: BackendHandle) => ({
      status: 'accepted' as const,
      jobRef: backend.id === BACKEND.id ? 'p1' : 'p2',
    })),
    events: (backend, options) => queueFor(backend).subscribe(options),
    isBusy: () => true,
    cancel: async () => {},
    respondPermission,
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
    isOutputMuted: () => false,
    isInputMuted: () => false,
    captureVisualContext: vi.fn(async () => {
      throw new Error('No capture in permission tests.');
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
      (_ref: RealtimeFunctionCallRef, _output: string) => true,
    ),
    sendBackendContext: vi.fn((_text: string) => true),
    speakToUser: vi.fn(() => true),
    askPermission: vi.fn((_text: string) => true),
    respondToProactiveEvent: vi.fn(() => true),
    requestProactiveRepair: vi.fn(() => true),
    takeTranscriptTail: vi.fn(() => []),
    close: vi.fn(),
  };
  const notificationSpeech = vi.fn(
    async (
      _options: NotificationSpeechOptions,
    ): Promise<NotificationSpeechResult> => ({
      audio: new Uint8Array([1, 0, 2, 0]),
      sampleRate: 24000,
      transcript: _options.fixedAnnouncement ?? '后台请求已取消。',
      sessionId: 'fake-notification',
      responseId: 'fake-speech',
    }),
  );
  const log = { write: vi.fn(), close: async () => {} };
  let callbacks: QwenRealtimeCallbacks = {};
  const session = new LiveSession({
    host,
    getPermissionMode: () => modeState.mode,
    registry: new BackendRegistry([{ adaptor, isDefault: true }]),
    realtime: {
      endpoint: 'https://no-network.invalid',
      model: 'test-model',
      voice: 'Tina',
    },
    log: log as unknown as SessionLog,
    getLanguage: () => 'zh-CN',
    notificationSpeech,
    openRealtime: async (_config, supplied = {}) => {
      callbacks = supplied;
      return realtime as unknown as QwenRealtimeSession;
    },
  });
  cleanup.push(session);
  await session.start({
    epoch: 1,
    callId: 'permission-test-call',
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
  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    request?: string,
  ) => {
    const count = realtime.submitFunctionOutput.mock.calls.length;
    const id = `tool-${++sequence}`;
    if (request)
      callbacks.onResponseCreated?.({
        callEpoch: 1,
        responseId: `response-${sequence}`,
        inputItemId: `input-${sequence}`,
        authority: 'direct',
      });
    callbacks.onFunctionCall?.({
      callEpoch: 1,
      responseId: `response-${sequence}`,
      callId: id,
      name,
      arguments: JSON.stringify(args),
      activeTranscript: [],
      ...(request
        ? { inputItemId: `input-${sequence}`, inputTranscript: request }
        : {}),
    });
    if (request)
      callbacks.onResponseDone?.({
        callEpoch: 1,
        responseId: `response-${sequence}`,
        authority: 'direct',
        status: 'completed',
      });
    await vi.waitFor(() =>
      expect(realtime.submitFunctionOutput).toHaveBeenCalledTimes(count + 1),
    );
    return JSON.parse(
      realtime.submitFunctionOutput.mock.calls.at(-1)![1],
    ) as Record<string, unknown>;
  };
  await callTool(
    'handoff',
    {
      task: 'Prepare the requested report',
      cwd: directory,
    },
    'Create a report in the project.',
  );
  const details = (
    toolCallId: string,
    command = 'printf "%s" "a  b"',
  ): PermissionDetails => ({
    toolCallId,
    toolName: 'shell',
    operation: 'execute',
    command,
    rawInput: { command, cwd: directory },
    cwd: directory,
    cwdVerified: true,
  });
  const permission = async (
    requestId: string,
    metadata = details(requestId),
    options = ONCE,
    backend = BACKEND,
    jobRef = 'p1',
  ) => {
    const count = log.write.mock.calls.filter(
      ([type]) => type === 'permission.request',
    ).length;
    queueFor(backend).push({
      type: 'permission_request',
      requestId,
      jobRef,
      title: 'Run command',
      details: metadata,
      options,
    });
    await vi.waitFor(() =>
      expect(
        log.write.mock.calls.filter(([type]) => type === 'permission.request')
          .length,
      ).toBe(count + 1),
    );
  };
  const page = async (selectedId = 'harness:job_1') => {
    const result = await session.handleSubagentsRequest({
      action: 'list',
      selectedId,
    });
    if (result.type !== 'page' || !result.page.selected)
      throw new Error('Expected managed task details.');
    return result.page;
  };
  const settleAsk = () => {
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: `permission-ask-${sequence}`,
      authority: 'permission',
    });
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: `permission-ask-${sequence}`,
      authority: 'permission',
      status: 'completed',
    });
  };
  const runtimeStates = () =>
    realtime.sendBackendContext.mock.calls.flatMap(([text]) =>
      text.startsWith('[TASK_RUNTIME_STATE] ')
        ? [
            JSON.parse(text.slice('[TASK_RUNTIME_STATE] '.length)) as {
              pending_count: number;
              pending_permissions: Array<{
                request_id: string;
                status: string;
              }>;
            },
          ]
        : [],
    );
  return {
    directory,
    modeState,
    log,
    session,
    queue,
    queueFor,
    respondPermission,
    host,
    realtime,
    notificationSpeech,
    callbacks,
    callTool,
    permission,
    page,
    details,
    settleAsk,
    runtimeStates,
  };
}

describe('permission delivery across LiveSession, Subagents and global permission mode', () => {
  it('defaults to ask and publishes action details without a persistent-grant choice before the user speaks', async () => {
    const rig = await createRig();
    await rig.permission('r1');
    const row = (await rig.page()).selected!;
    expect(row.status).toBe('waiting');
    expect(row.permissions).toHaveLength(1);
    const pending = row.permissions![0]!;
    expect(pending.details).toContain('printf');
    expect(pending.details).toContain('a  b');
    expect(pending.details).toContain(rig.directory);
    expect(pending.choices).toEqual([
      { decision: 'allow', scope: 'once' },
      { decision: 'deny' },
    ]);
    expect(pending).not.toHaveProperty('alwaysScope');
    expect(rig.runtimeStates().at(-1)).toMatchObject({
      pending_count: 1,
      permission_mode: 'ask',
      pending_permissions: [
        { request_id: 'req_1', status: 'waiting_for_permission' },
      ],
    });
    expect(rig.respondPermission).not.toHaveBeenCalled();
    expect(rig.notificationSpeech).not.toHaveBeenCalled();
  });

  it('sends an explicit current-operation vote without changing mode or announcing automatic approval', async () => {
    const rig = await createRig();
    await rig.permission('r1');
    const outcome = await rig.session.handleSubagentsRequest({
      action: 'permission',
      requestHandle: 'req_1',
      decision: 'allow',
      scope: 'once',
    });
    expect(outcome).toMatchObject({
      type: 'outcome',
      outcome: 'allowed',
      scope: 'once',
    });
    expect(rig.respondPermission).toHaveBeenCalledExactlyOnceWith(
      BACKEND,
      'r1',
      'allow',
    );
    expect(rig.runtimeStates().at(-1)?.pending_count).toBe(0);
    expect(rig.modeState.mode).toBe('ask');
    rig.queue.push({
      type: 'activity',
      kind: 'tool',
      text: 'Executing the command',
      jobRef: 'p1',
      toolCallId: 'r1',
      toolStatus: 'in_progress',
      details: rig.details('r1'),
    });
    rig.settleAsk();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rig.notificationSpeech).not.toHaveBeenCalled();
  });

  it('uses a one-time vote in allow-all and announces an important automatic approval once', async () => {
    const rig = await createRig('allow-all');
    await rig.permission('r1', rig.details('r1', 'mkdir reports'), [
      { optionId: 'native-always', kind: 'proceed', escalation: 'always' },
      ...ONCE,
    ]);
    await vi.waitFor(
      () => expect(rig.notificationSpeech).toHaveBeenCalledOnce(),
      { timeout: 2000 },
    );
    expect(rig.respondPermission).toHaveBeenLastCalledWith(
      BACKEND,
      'r1',
      'allow',
    );
    const options = rig.notificationSpeech.mock.calls[0]![0];
    expect(options.purpose).toBe('permission_execution');
    expect(options.language).toBe('zh-CN');
    expect(options.summary).toContain('"status":"approved"');
    expect(options.summary).toContain('"evidence":"approval_delivered"');
    expect(options.summary).not.toContain('"status":"in_progress"');
    expect(options.fixedAnnouncement).toMatch(
      /^已自动授权后台智能体执行.{0,12}命令。$/,
    );
    expect(options.summary).not.toMatch(/reports|cwd|rawInput|incomplete/);
    await vi.waitFor(() => expect(rig.host.sendOutputAudio).toHaveBeenCalled());
    rig.session.playbackStarted({ epoch: 1 });
    rig.session.playbackCompleted({ epoch: 1 });
    const event: BackendEvent = {
      type: 'activity',
      kind: 'tool',
      text: 'Execution began',
      jobRef: 'p1',
      toolCallId: 'r1',
      toolStatus: 'in_progress',
      details: rig.details('r1', 'mkdir reports'),
    };
    rig.queue.push(event);
    rig.queue.push(event);
    // Allow the Injector's 800ms quiet gap to expire: a duplicate queued
    // announcement must not merely hide behind the playback barrier.
    await new Promise<void>((resolve) => setTimeout(resolve, 900));
    expect(rig.notificationSpeech).toHaveBeenCalledOnce();
    expect((await rig.page()).selected?.permissions).toEqual([]);
  });

  it('retains a pending tool name through sparse updates and uses only the same backend, job and call', async () => {
    const rig = await createRig('allow-all');
    rig.queue.push({
      type: 'activity',
      kind: 'tool',
      text: 'Inspecting the interface',
      jobRef: 'p1',
      toolCallId: 'cua-1',
      toolStatus: 'pending',
      details: { toolName: 'mcp.cua_repl.js', operation: 'execute' },
    });
    rig.queue.push({
      type: 'activity',
      kind: 'tool',
      text: 'Waiting for approval',
      jobRef: 'p1',
      toolCallId: 'cua-1',
      toolStatus: 'in_progress',
    });
    await rig.permission('r1', {
      toolCallId: 'cua-1',
      operation: 'execute',
      incomplete: true,
      cwd: '/private/not-for-speech',
    });
    await vi.waitFor(() =>
      expect(rig.notificationSpeech).toHaveBeenCalledOnce(),
    );
    const options = rig.notificationSpeech.mock.calls[0]![0];
    expect(options.fixedAnnouncement).toBe(
      '已自动授权后台智能体调用界面操作工具。',
    );
    expect(options.summary).not.toMatch(/incomplete|private|cwd/);
    rig.session.playbackStarted({ epoch: 1 });
    rig.session.playbackCompleted({ epoch: 1 });
    await rig.permission('r2', {
      toolCallId: 'different-call',
      incomplete: true,
    });
    await vi.waitFor(
      () => expect(rig.notificationSpeech).toHaveBeenCalledTimes(2),
      { timeout: 2000 },
    );
    expect(rig.notificationSpeech.mock.calls[1]![0].fixedAnnouncement).toBe(
      '已自动授权后台智能体调用工具。',
    );
  });

  it('does not borrow a tool name from another job with the same call id', async () => {
    const rig = await createRig('allow-all');
    rig.queue.push({
      type: 'activity',
      kind: 'tool',
      text: 'Editing a file',
      jobRef: 'unrelated-job',
      toolCallId: 'same-call',
      toolStatus: 'in_progress',
      details: { toolName: 'apply_patch', operation: 'edit' },
    });
    await rig.permission('r1', { toolCallId: 'same-call', incomplete: true });
    await vi.waitFor(() =>
      expect(rig.notificationSpeech).toHaveBeenCalledOnce(),
    );
    expect(rig.notificationSpeech.mock.calls[0]![0].fixedAnnouncement).toBe(
      '已自动授权后台智能体调用工具。',
    );
  });

  it('rejects an old scope-always UI request even when the backend offers native persistence', async () => {
    const rig = await createRig();
    const scope = 'Allow all edits in this project';
    await rig.permission('r1', rig.details('r1'), [
      {
        optionId: 'native',
        kind: 'proceed',
        escalation: 'always',
        persistentScope: scope,
      },
      ...ONCE,
    ]);
    expect((await rig.page()).selected?.permissions?.[0]).not.toHaveProperty(
      'alwaysScope',
    );
    const result = await rig.session.handleSubagentsRequest({
      action: 'permission',
      requestHandle: 'req_1',
      decision: 'allow',
      scope: 'always',
    });
    expect(result).toEqual({ type: 'error', code: 'permission_unavailable' });
    expect(rig.respondPermission).not.toHaveBeenCalled();
    expect(rig.modeState.mode).toBe('ask');
    expect(rig.notificationSpeech).not.toHaveBeenCalled();
  });

  it('limits a legacy allow_always tool request to the current operation without changing global mode', async () => {
    const rig = await createRig();
    await rig.permission('r1');
    const result = await rig.callTool('respond_permission', {
      request_id: 'req_1',
      decision: 'allow_always',
    });
    expect(result).toMatchObject({
      status: 'delivered',
      effective_decision: 'allow',
      permission_mode: 'ask',
      automatic_saved: false,
    });
    expect(result['note']).toContain('Only this operation');
    expect(rig.modeState.mode).toBe('ask');
    expect(rig.respondPermission).toHaveBeenLastCalledWith(
      BACKEND,
      'r1',
      'allow',
    );
    await rig.permission('r2');
    expect((await rig.page()).selected?.permissions).toHaveLength(1);
    expect(rig.respondPermission).toHaveBeenCalledOnce();
  });

  it('does not label a once request as allowed when the backend offers only always', async () => {
    const rig = await createRig();
    await rig.permission('r1', rig.details('r1'), [
      { optionId: 'all', kind: 'proceed', escalation: 'always' },
      { optionId: 'deny', kind: 'reject', escalation: 'once' },
    ]);
    expect((await rig.page()).selected?.permissions?.[0]?.choices).toEqual([
      { decision: 'deny' },
    ]);
    expect(
      await rig.session.handleSubagentsRequest({
        action: 'permission',
        requestHandle: 'req_1',
        decision: 'allow',
        scope: 'once',
      }),
    ).toEqual({ type: 'error', code: 'permission_unavailable' });
    expect(rig.respondPermission).not.toHaveBeenCalled();
    const receipt = await rig.callTool('respond_permission', {
      request_id: 'req_1',
      decision: 'allow',
    });
    expect(rig.respondPermission).toHaveBeenLastCalledWith(
      BACKEND,
      'r1',
      'cancel',
    );
    expect(receipt).toMatchObject({
      status: 'delivered',
      effective_decision: 'cancel',
      automatic_saved: false,
    });
    expect(receipt['note']).toContain('cancelled');
    expect(rig.notificationSpeech).not.toHaveBeenCalled();
  });

  it('keeps a job waiting until every outstanding permission for that job is resolved', async () => {
    const rig = await createRig();
    await rig.permission('r1');
    await rig.permission('r2', rig.details('r2', 'printf second'));
    expect((await rig.page()).selected?.permissions).toHaveLength(2);
    await rig.session.handleSubagentsRequest({
      action: 'permission',
      requestHandle: 'req_1',
      decision: 'allow',
      scope: 'once',
    });
    expect((await rig.page()).selected).toMatchObject({
      status: 'waiting',
      permissions: [{ requestHandle: 'req_2' }],
    });
    expect(rig.runtimeStates().at(-1)).toMatchObject({
      pending_count: 1,
      pending_permissions: [
        { request_id: 'req_2', status: 'waiting_for_permission' },
      ],
    });
    rig.queue.push({ type: 'turn_started', jobRef: 'p1' });
    rig.queue.push({
      type: 'permission_resolved',
      requestId: 'r1',
      byUs: true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await rig.page()).selected?.status).toBe('waiting');
    rig.queue.push({
      type: 'permission_resolved',
      requestId: 'r2',
      byUs: false,
    });
    await vi.waitFor(() =>
      expect(rig.runtimeStates().at(-1)?.pending_count).toBe(0),
    );
    expect((await rig.page()).selected?.status).toBe('running');
  });

  it('does not retract another session permission when one adaptor reuses a request id', async () => {
    const rig = await createRig();
    const created = await rig.callTool(
      'session_create',
      {
        cwd: rig.directory,
        label: 'Second task session',
      },
      'Create a new background task.',
    );
    await rig.callTool(
      'handoff',
      {
        session: created['handle'],
        task: 'Prepare another report',
      },
      'Create a second report.',
    );
    const second: BackendHandle = { ...BACKEND, id: 'backend-session-2' };
    rig.callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'foreground',
      authority: 'direct',
    });
    await rig.permission('shared-request');
    await rig.permission(
      'shared-request',
      rig.details('second-tool', 'printf second'),
      ONCE,
      second,
      'p2',
    );
    expect(rig.runtimeStates().at(-1)?.pending_count).toBe(2);
    expect(rig.realtime.askPermission).not.toHaveBeenCalled();
    await rig.session.handleSubagentsRequest({
      action: 'permission',
      requestHandle: 'req_1',
      decision: 'allow',
      scope: 'once',
    });
    expect(rig.respondPermission).toHaveBeenCalledExactlyOnceWith(
      BACKEND,
      'shared-request',
      'allow',
    );
    expect(
      (await rig.page('harness:job_2')).selected?.permissions,
    ).toMatchObject([{ requestHandle: 'req_2' }]);
    rig.callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'foreground',
      authority: 'direct',
      status: 'completed',
    });
    await vi.waitFor(() =>
      expect(rig.realtime.askPermission).toHaveBeenCalledOnce(),
    );
    expect(rig.realtime.askPermission.mock.calls[0]![0]).toContain(
      '"request_id":"req_2"',
    );
    expect(rig.runtimeStates().at(-1)?.pending_count).toBe(1);
  });

  it('retracts queued permission questions and clears main-model state when a backend session closes', async () => {
    const rig = await createRig();
    rig.callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'foreground',
      authority: 'direct',
    });
    await rig.permission('r1');
    expect(rig.runtimeStates().at(-1)?.pending_count).toBe(1);
    expect(rig.realtime.askPermission).not.toHaveBeenCalled();
    // Qwen Serve can close a session without preceding per-request resolution.
    rig.queue.push({ type: 'session_closed' });
    await vi.waitFor(() =>
      expect(rig.runtimeStates().at(-1)).toMatchObject({
        pending_count: 0,
        pending_permissions: [],
      }),
    );
    rig.callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'foreground',
      authority: 'direct',
      status: 'completed',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rig.realtime.askPermission).not.toHaveBeenCalled();
    expect((await rig.page()).selected?.permissions).toEqual([]);
    expect(rig.respondPermission).not.toHaveBeenCalled();
  });

  it('does not claim permission or a mode change when another client already resolved a legacy request', async () => {
    const rig = await createRig();
    await rig.permission('r1');
    rig.respondPermission.mockResolvedValueOnce('already_resolved');
    const receipt = await rig.callTool('respond_permission', {
      request_id: 'req_1',
      decision: 'allow_always',
    });
    expect(receipt).toMatchObject({
      status: 'already_resolved',
      automatic_saved: false,
      permission_mode: 'ask',
    });
    expect(receipt['note']).toContain('no new permission');
    expect(rig.modeState.mode).toBe('ask');
    await rig.permission('r2');
    expect((await rig.page()).selected?.permissions).toMatchObject([
      { requestHandle: 'req_2' },
    ]);
    expect(rig.respondPermission).toHaveBeenCalledOnce();
    expect(rig.notificationSpeech).not.toHaveBeenCalled();
  });

  it.each(['pwd', 'ls -la', 'git status'])(
    'automatically approves routine %s without a speech notification',
    async (command) => {
      const rig = await createRig('allow-all');
      await rig.permission('r1', rig.details('r1', command));
      await vi.waitFor(() =>
        expect(rig.respondPermission).toHaveBeenCalledExactlyOnceWith(
          BACKEND,
          'r1',
          'allow',
        ),
      );
      rig.queue.push({
        type: 'activity',
        kind: 'tool',
        text: `Running ${command}`,
        jobRef: 'p1',
        toolCallId: 'r1',
        toolStatus: 'in_progress',
        details: rig.details('r1', command),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rig.notificationSpeech).not.toHaveBeenCalled();
      expect(rig.host.sendOutputAudio).not.toHaveBeenCalled();
      expect(rig.log.write).toHaveBeenCalledWith(
        'permission.decision',
        expect.objectContaining({
          requestId: 'r1',
          auto: true,
          outcome: 'delivered',
          permissionMode: 'allow-all',
        }),
      );
    },
  );

  it('applies a saved allow-all mode to existing and future requests, then asks again after switching back', async () => {
    const rig = await createRig();
    await rig.permission('r1', rig.details('r1', 'pwd'));
    await rig.permission('r2', rig.details('r2', 'ls'));
    expect(rig.respondPermission).not.toHaveBeenCalled();
    rig.callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'active-permission',
      authority: 'permission',
    });
    rig.modeState.mode = 'allow-all';
    rig.session.permissionModeChanged();
    await vi.waitFor(() =>
      expect(rig.respondPermission).toHaveBeenCalledTimes(2),
    );
    expect(rig.realtime.cancelResponse).toHaveBeenCalledOnce();
    expect(rig.runtimeStates().at(-1)).toMatchObject({
      permission_mode: 'allow-all',
      pending_count: 0,
    });
    rig.callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'active-permission',
      authority: 'permission',
      status: 'cancelled',
    });
    await rig.permission('r3', rig.details('r3', 'git status'));
    await vi.waitFor(() =>
      expect(rig.respondPermission).toHaveBeenCalledTimes(3),
    );
    rig.modeState.mode = 'ask';
    rig.session.permissionModeChanged();
    await rig.permission('r4');
    expect(rig.respondPermission).toHaveBeenCalledTimes(3);
    expect((await rig.page()).selected?.permissions).toMatchObject([
      { requestHandle: 'req_4' },
    ]);
    expect(rig.runtimeStates().at(-1)).toMatchObject({
      permission_mode: 'ask',
      pending_count: 1,
    });
    expect(rig.notificationSpeech).not.toHaveBeenCalled();
  });

  it('processes waiting and new allow-all approvals while no call is active, without starting speech', async () => {
    const rig = await createRig();
    await rig.session.stop({ epoch: 1, callId: 'permission-test-call' });
    await rig.permission('r1', rig.details('r1', 'mkdir reports'));
    expect(rig.respondPermission).not.toHaveBeenCalled();
    rig.modeState.mode = 'allow-all';
    rig.session.permissionModeChanged();
    await vi.waitFor(() =>
      expect(rig.respondPermission).toHaveBeenCalledTimes(1),
    );
    await rig.permission('r2', rig.details('r2', 'curl https://example.test'));
    await vi.waitFor(() =>
      expect(rig.respondPermission).toHaveBeenCalledTimes(2),
    );
    expect(rig.log.write).toHaveBeenCalledWith(
      'permission.decision',
      expect.objectContaining({
        requestId: 'r2',
        auto: true,
        permissionMode: 'allow-all',
      }),
    );
    expect(rig.notificationSpeech).not.toHaveBeenCalled();
    expect(rig.host.sendOutputAudio).not.toHaveBeenCalled();
    expect(rig.realtime.askPermission).not.toHaveBeenCalled();
    expect((await rig.page()).selected?.permissions).toEqual([]);
  });

  it('leaves failed automatic votes available for review instead of inventing approval', async () => {
    const rig = await createRig('allow-all');
    rig.respondPermission.mockRejectedValueOnce(
      new Error('Temporary backend failure'),
    );
    await rig.permission('r1');
    await vi.waitFor(() =>
      expect(
        rig.log.write.mock.calls.filter(
          ([type]) => type === 'permission.decision',
        ),
      ).toHaveLength(1),
    );
    expect((await rig.page()).selected?.permissions).toMatchObject([
      { requestHandle: 'req_1' },
    ]);
    expect(rig.notificationSpeech).not.toHaveBeenCalled();
    expect(rig.log.write).toHaveBeenCalledWith(
      'permission.decision',
      expect.objectContaining({ auto: true, outcome: 'delivery_failed' }),
    );
    expect(rig.realtime.askPermission).toHaveBeenCalledWith(
      expect.stringContaining('"automatic_delivery_failed":true'),
      expect.anything(),
    );
  });
});
