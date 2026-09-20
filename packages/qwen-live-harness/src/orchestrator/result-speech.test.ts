/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendRegistry } from '../adaptor/registry.js';
import { displayLiveMessage, liveText } from '../i18n/messages.js';
import type { SessionLog } from '../log/session-log.js';
import type { LiveVisualCapture } from '../host/qwen-live-harness-host-coordinator.js';
import type {
  NotificationSpeechResult,
  synthesizeNotificationSpeech,
} from '../realtime/notification-speech.js';
import type {
  QwenRealtimeCallbacks,
  QwenRealtimeSession,
  RealtimeCloseInfo,
  openQwenRealtimeSession,
} from '../realtime/realtime-session.js';
import type { analyzeQwenRealtimeImage } from '../realtime/visual-analysis.js';
import type { searchQwenRealtime } from '../realtime/web-search.js';
import { LiveSession, type LiveHostControl } from './live-session.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const ANSWER = 'The snapshot shows a terminal and its test results.';
const SPEECH: NotificationSpeechResult = {
  audio: Uint8Array.from([1, 0, 2, 0, 3, 0]),
  sampleRate: 24000,
  transcript: '画面中有终端和测试结果。',
  sessionId: 'sess-isolated-fixture',
  responseId: 'resp-isolated-fixture',
};
const sessions: LiveSession[] = [];

beforeEach(() => vi.useRealTimers());
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.useRealTimers();
});

async function flush() {
  for (let n = 0; n < 10; n++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

async function rig() {
  let outputMuted = false;
  let mainReadyForSpeech = true;
  const speech = deferred<NotificationSpeechResult>();
  const notificationSpeech = vi
    .fn<typeof synthesizeNotificationSpeech>()
    .mockReturnValue(speech.promise);
  const analyze = vi
    .fn<typeof analyzeQwenRealtimeImage>()
    .mockResolvedValue({ answer: ANSWER });
  const search = vi
    .fn<typeof searchQwenRealtime>()
    .mockResolvedValue({ answer: ANSWER, searchStatus: 'performed' });
  const host = {
    setCallState: vi.fn<LiveHostControl['setCallState']>(() => true),
    setCoordinator: vi.fn<LiveHostControl['setCoordinator']>(() => true),
    sendOutputAudio: vi.fn<LiveHostControl['sendOutputAudio']>(() => true),
    finishOutputAudio: vi.fn<LiveHostControl['finishOutputAudio']>(),
    clearOutput: vi.fn<LiveHostControl['clearOutput']>(),
    setCaption: vi.fn<LiveHostControl['setCaption']>(() => true),
    setStatusText: vi.fn<LiveHostControl['setStatusText']>(() => true),
    failCall: vi.fn<LiveHostControl['failCall']>(() => true),
    isInputMuted: () => false,
    isOutputMuted: () => outputMuted,
    captureVisualContext: vi
      .fn<LiveHostControl['captureVisualContext']>()
      .mockResolvedValue({
        source: 'screen',
        image: IMAGE,
        width: 1280,
        height: 720,
      } satisfies LiveVisualCapture),
  };
  const realtime = {
    callEpoch: 1,
    closed: new Promise<RealtimeCloseInfo>(() => {}),
    flushDialogue: vi.fn(),
    configure: vi.fn<QwenRealtimeSession['configure']>(() => true),
    pushAudio: vi.fn<QwenRealtimeSession['pushAudio']>(() => true),
    pushImage: vi.fn<QwenRealtimeSession['pushImage']>(() => true),
    setInputMuted: vi.fn<QwenRealtimeSession['setInputMuted']>(),
    commitInputAudio: vi.fn(() => true),
    clearInputAudio: vi.fn(() => true),
    cancelResponse: vi.fn(() => true),
    canStartExternalSpeech: vi.fn(() => mainReadyForSpeech),
    canDeliverExternalAudio: vi.fn(() => mainReadyForSpeech),
    submitFunctionOutput: vi.fn<QwenRealtimeSession['submitFunctionOutput']>(
      () => true,
    ),
    sendBackendContext: vi.fn<QwenRealtimeSession['sendBackendContext']>(
      () => true,
    ),
    speakToUser: vi.fn<QwenRealtimeSession['speakToUser']>(() => true),
    askPermission: vi.fn<NonNullable<QwenRealtimeSession['askPermission']>>(
      () => true,
    ),
    respondToTaskResult: vi.fn<
      NonNullable<QwenRealtimeSession['respondToTaskResult']>
    >(() => true),
    speakPeerReport: vi.fn<NonNullable<QwenRealtimeSession['speakPeerReport']>>(
      () => true,
    ),
    respondToSearchResult: vi.fn<
      NonNullable<QwenRealtimeSession['respondToSearchResult']>
    >(() => true),
    respondToVisualResult: vi.fn<
      NonNullable<QwenRealtimeSession['respondToVisualResult']>
    >(() => true),
    respondToProactiveEvent: vi.fn<
      QwenRealtimeSession['respondToProactiveEvent']
    >(() => true),
    requestProactiveRepair: vi.fn<
      QwenRealtimeSession['requestProactiveRepair']
    >(() => true),
    takeTranscriptTail: vi.fn<QwenRealtimeSession['takeTranscriptTail']>(
      () => [],
    ),
    close: vi.fn<QwenRealtimeSession['close']>(),
  } satisfies QwenRealtimeSession;
  let callbacks: QwenRealtimeCallbacks = {};
  const openRealtime = vi.fn<typeof openQwenRealtimeSession>(
    async (_config, supplied = {}) => {
      callbacks = supplied;
      return realtime;
    },
  );
  const log = { write: vi.fn(), close: async () => {} };
  const session = new LiveSession({
    host,
    registry: new BackendRegistry([]),
    log: log as unknown as SessionLog,
    realtime: {
      endpoint: 'wss://fixture.invalid/realtime',
      model: 'fixture-realtime',
      voice: 'Tina',
    },
    openRealtime,
    analyzeRealtimeImage: analyze,
    searchRealtime: search,
    notificationSpeech,
    getLanguage: () => 'zh-CN',
    gracefulStopDrainMs: 0,
  });
  sessions.push(session);
  await session.start({
    epoch: 1,
    callId: 'fixture-call',
    mode: 'new',
    visualInput: {
      source: 'screen',
      mode: 'on-demand',
      fps: 1,
      liveWidth: 1280,
      liveHeight: 720,
    },
  });
  vi.useFakeTimers();
  await flush();

  async function lookup(kind: 'visual' | 'search' = 'visual') {
    callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'lookup-turn',
      authority: 'direct',
    });
    callbacks.onFunctionCall?.({
      callEpoch: 1,
      responseId: 'lookup-turn',
      callId: 'lookup-call',
      name: kind === 'visual' ? 'appshot' : 'web_search',
      arguments: JSON.stringify({
        query:
          kind === 'visual' ? 'What is on screen?' : 'What is the weather?',
      }),
      activeTranscript: [],
    });
    await flush();
    expect(realtime.submitFunctionOutput).toHaveBeenCalledOnce();
    const receipt = JSON.parse(
      realtime.submitFunctionOutput.mock.calls[0]![1],
    ) as { status: string; taskId: string };
    expect(receipt.status).toBe('accepted');
    expect(notificationSpeech).not.toHaveBeenCalled();
    callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'lookup-turn',
      authority: 'direct',
      status: 'completed',
    });
    await flush();
    return receipt.taskId;
  }
  const task = (id: string) =>
    session.getSubagentsSnapshot().tasks.find((entry) => entry.id === id);
  const mute = () => {
    outputMuted = true;
    session.outputMuted({ epoch: 1 });
  };
  return {
    session,
    host,
    realtime,
    callbacks,
    speech,
    notificationSpeech,
    analyze,
    search,
    log,
    openRealtime,
    lookup,
    task,
    mute,
    setMainReady: (ready: boolean) => {
      mainReadyForSpeech = ready;
    },
  };
}

describe('isolated asynchronous result speech', () => {
  it('shows a child retry without recapturing or announcing partial failure, then replaces it with the successful result', async () => {
    const r = await rig();
    const analysis =
      deferred<Awaited<ReturnType<typeof analyzeQwenRealtimeImage>>>();
    r.analyze.mockImplementation((options) => {
      options.onDebug?.('visual_analysis.retrying', {
        attempt: 1,
        nextAttempt: 2,
        errorCode: 'COMMON_ERROR',
        providerSessionId: 'sess-first-attempt',
      });
      return analysis.promise;
    });
    const id = await r.lookup();
    expect(displayLiveMessage('zh-CN', r.task(id)!.activity!)).toBe(
      liveText('zh-CN', 'visual.retrying'),
    );
    expect(r.log.write).toHaveBeenCalledWith(
      'visual.analysis',
      expect.objectContaining({
        event: 'visual_analysis.retrying',
        taskId: id,
        nextAttempt: 2,
      }),
    );
    expect(r.host.captureVisualContext).toHaveBeenCalledOnce();
    expect(r.analyze).toHaveBeenCalledOnce();
    expect(r.notificationSpeech).not.toHaveBeenCalled();
    analysis.resolve({ answer: ANSWER, providerSessionId: 'sess-retry' });
    await flush();
    expect(r.notificationSpeech).toHaveBeenCalledOnce();
    r.speech.resolve(SPEECH);
    await flush();
    r.session.playbackStarted({ epoch: 1 });
    r.session.playbackCompleted({ epoch: 1 });
    expect(r.task(id)).toMatchObject({
      status: 'completed',
      notification: 'delivered',
      output: ANSWER,
    });
    expect(r.host.captureVisualContext).toHaveBeenCalledOnce();
  });
  it.each(['visual', 'search'] as const)(
    'delivers %s through the independent helper and waits for actual playback receipts',
    async (kind) => {
      const r = await rig();
      const id = await r.lookup(kind);
      expect(r.notificationSpeech).toHaveBeenCalledOnce();
      const options = r.notificationSpeech.mock.calls[0]![0];
      expect(options).toMatchObject({
        purpose: `${kind}_result`,
        model: 'fixture-realtime',
        voice: 'Tina',
        language: 'zh-CN',
      });
      expect(JSON.parse(options.summary)).toMatchObject({ answer: ANSWER });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(r.realtime.respondToVisualResult).not.toHaveBeenCalled();
      expect(r.realtime.respondToSearchResult).not.toHaveBeenCalled();
      expect(r.realtime.respondToTaskResult).not.toHaveBeenCalled();
      expect(r.realtime.speakPeerReport).not.toHaveBeenCalled();
      expect(r.realtime.pushImage).not.toHaveBeenCalled();
      expect(r.host.sendOutputAudio).not.toHaveBeenCalled();
      expect(r.task(id)).toMatchObject({
        status: 'delivering',
        output: ANSWER,
      });

      r.speech.resolve(SPEECH);
      await flush();
      expect(r.host.sendOutputAudio).toHaveBeenCalledExactlyOnceWith(
        1,
        SPEECH.audio,
      );
      expect(r.task(id)?.notification).not.toBe('delivered');
      r.session.playbackStarted({ epoch: 0 });
      r.session.playbackCompleted({ epoch: 0 });
      expect(r.task(id)?.notification).not.toBe('delivered');
      r.session.playbackStarted({ epoch: 1 });
      expect(r.task(id)).toMatchObject({
        status: 'delivering',
        notification: 'speaking',
      });
      r.session.playbackCompleted({ epoch: 1 });
      expect(r.task(id)).toMatchObject({
        status: 'completed',
        notification: 'delivered',
        output: ANSWER,
      });
      const history = r.realtime.sendBackendContext.mock.calls.map(
        ([text]) => text,
      );
      expect(
        history.some((text) => text.startsWith('[RESULT_AVAILABLE] ')),
      ).toBe(true);
      expect(
        history.some(
          (text) =>
            text.startsWith('[RESULT_DELIVERY] ') && text.includes('"played"'),
        ),
      ).toBe(true);
      expect(r.openRealtime).toHaveBeenCalledOnce();
      expect(r.host.failCall).not.toHaveBeenCalled();
    },
  );

  it('does not count generation or a completion-only receipt as a heard announcement', async () => {
    const r = await rig();
    const id = await r.lookup();
    r.speech.resolve(SPEECH);
    await flush();
    r.session.playbackCompleted({ epoch: 1 });
    expect(r.task(id)?.notification).not.toBe('delivered');
    expect(
      r.realtime.sendBackendContext.mock.calls.some(
        ([text]) =>
          text.startsWith('[RESULT_DELIVERY] ') && text.includes('"played"'),
      ),
    ).toBe(false);
    expect(r.task(id)?.output).toBe(ANSWER);
    expect(r.host.failCall).not.toHaveBeenCalled();
  });

  it.each(['speech', 'task-stop', 'end-call', 'mute'] as const)(
    'cancels pending generation on %s and fences its late audio',
    async (action) => {
      const r = await rig();
      const id = await r.lookup();
      expect(r.notificationSpeech).toHaveBeenCalledOnce();
      const signal = r.notificationSpeech.mock.calls[0]![0].signal!;
      if (action === 'speech')
        r.callbacks.onSpeechStarted?.({ callEpoch: 1, itemId: 'new-user' });
      else if (action === 'task-stop')
        await r.session.handleSubagentsRequest({ action: 'stop', taskId: id });
      else if (action === 'end-call') {
        const stopping = r.session.stop({ epoch: 1, callId: 'fixture-call' });
        await vi.advanceTimersByTimeAsync(0);
        await stopping;
      } else r.mute();
      expect(signal.aborted).toBe(true);
      const sentBefore = r.host.sendOutputAudio.mock.calls.length;
      r.speech.resolve(SPEECH);
      await flush();
      expect(r.host.sendOutputAudio).toHaveBeenCalledTimes(sentBefore);
      expect(r.task(id)?.notification).not.toBe('delivered');
      if (action === 'task-stop' || action === 'end-call')
        expect(r.task(id)?.status).toBe('cancelled');
      expect(r.notificationSpeech).toHaveBeenCalledOnce();
      expect(r.host.failCall).not.toHaveBeenCalled();
    },
  );

  it.each(['end-call', 'new-call'] as const)(
    'keeps a ready lookup cancelled when %s stops its playback',
    async (action) => {
      const r = await rig();
      const id = await r.lookup();
      r.speech.resolve(SPEECH);
      await flush();
      r.session.playbackStarted({ epoch: 1 });
      const stopping =
        action === 'end-call'
          ? r.session.stop({ epoch: 1, callId: 'fixture-call' })
          : r.session.start({
              epoch: 2,
              callId: 'next-call',
              mode: 'new',
              visualInput: {
                source: 'screen',
                mode: 'on-demand',
                fps: 1,
                liveWidth: 1280,
                liveHeight: 720,
              },
            });
      await vi.advanceTimersByTimeAsync(0);
      await stopping;
      expect(r.task(id)?.status).toBe('cancelled');
      expect(r.task(id)?.notification).not.toBe('delivered');
      r.session.playbackCompleted({ epoch: 1 });
      expect(r.task(id)?.status).toBe('cancelled');
    },
  );

  it('does not overtake an unsettled main confirmation and starts after the barrier opens', async () => {
    const r = await rig();
    r.setMainReady(false);
    const id = await r.lookup();
    await vi.advanceTimersByTimeAsync(1200);
    expect(r.notificationSpeech).not.toHaveBeenCalled();
    expect(r.host.sendOutputAudio).not.toHaveBeenCalled();
    expect(r.task(id)?.output).toBe(ANSWER);
    r.setMainReady(true);
    await vi.advanceTimersByTimeAsync(1200);
    expect(r.notificationSpeech).toHaveBeenCalledOnce();
    r.speech.resolve(SPEECH);
    await flush();
    expect(r.host.sendOutputAudio).toHaveBeenCalledOnce();
    expect(r.realtime.respondToVisualResult).not.toHaveBeenCalled();
  });

  it('preserves the completed evidence when helper generation fails, without ending the call or rerunning the lookup', async () => {
    const r = await rig();
    const id = await r.lookup();
    r.speech.reject(new Error('Synthetic speech generation failed.'));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.task(id)).toMatchObject({ status: 'completed', output: ANSWER });
    expect(r.task(id)?.notification).not.toBe('delivered');
    expect(r.analyze).toHaveBeenCalledOnce();
    expect(r.host.captureVisualContext).toHaveBeenCalledOnce();
    expect(r.notificationSpeech).toHaveBeenCalledOnce();
    expect(r.realtime.submitFunctionOutput).toHaveBeenCalledOnce();
    expect(r.realtime.close).not.toHaveBeenCalled();
    expect(r.host.failCall).not.toHaveBeenCalled();
    expect(r.host.sendOutputAudio).not.toHaveBeenCalled();
    expect(
      r.session.pushAudio({
        epoch: 1,
        callId: 'fixture-call',
        pcm16: Buffer.from([1, 0]),
      }),
    ).toBe(true);
  });

  it('fences a pending helper as soon as a foreground response starts and preserves foreground audio and captions', async () => {
    const r = await rig();
    const id = await r.lookup();
    r.host.finishOutputAudio.mockClear();
    r.setMainReady(false);
    r.callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'foreground',
      authority: 'direct',
    });
    r.callbacks.onOutputTextDelta?.({
      callEpoch: 1,
      responseId: 'foreground',
      source: 'audio_transcript',
      text: '主对话继续。',
    });
    const foregroundAudio = Uint8Array.from([9, 0, 8, 0]);
    r.callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'foreground',
      audio: foregroundAudio,
    });
    expect(r.notificationSpeech.mock.calls[0]![0].signal?.aborted).toBe(true);
    r.speech.resolve(SPEECH);
    await flush();
    expect(r.host.sendOutputAudio).toHaveBeenCalledExactlyOnceWith(
      1,
      foregroundAudio,
    );
    expect(r.host.setCaption).toHaveBeenLastCalledWith(1, '主对话继续。');
    expect(r.host.finishOutputAudio).not.toHaveBeenCalled();
    expect(r.task(id)?.notification).not.toBe('delivered');
    expect(r.host.failCall).not.toHaveBeenCalled();
  });

  it('stops partially forwarded helper audio before a newer foreground output instead of appending the remaining chunks', async () => {
    const r = await rig();
    const id = await r.lookup();
    const firstChunk = deferred<void>();
    r.host.sendOutputAudio.mockImplementation(() => {
      firstChunk.resolve();
      return true;
    });
    r.host.finishOutputAudio.mockClear();
    r.speech.resolve({ ...SPEECH, audio: new Uint8Array(150000) });
    await firstChunk.promise;
    expect(r.host.sendOutputAudio).toHaveBeenCalledOnce();
    r.callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'new-foreground',
      authority: 'direct',
    });
    const foregroundAudio = Uint8Array.from([7, 0]);
    r.callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'new-foreground',
      audio: foregroundAudio,
    });
    await flush();
    expect(r.host.clearOutput).toHaveBeenCalledWith(1);
    expect(r.host.sendOutputAudio).toHaveBeenCalledTimes(2);
    expect(r.host.sendOutputAudio).toHaveBeenLastCalledWith(1, foregroundAudio);
    expect(r.host.finishOutputAudio).not.toHaveBeenCalled();
    expect(r.task(id)?.notification).not.toBe('delivered');
  });
});
