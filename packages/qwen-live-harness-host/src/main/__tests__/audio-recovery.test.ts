import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { liveMessage, liveText } from 'qwen-live-harness/i18n';
import * as policy from '../live-state-policy.ts';
import type { HostPublicState } from '../../shared/host-api.ts';

function fixture() {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile(
    'index.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set([
    'handleAudioFailure',
    'failRecoverableAudio',
    'failAudioAndRecheck',
    'cancelAudioRetry',
    'retryAudio',
    'finishAudioRetryIfReady',
    'stopLive',
    'stopLocalAudio',
    'toggleLive',
    'registerIpc',
    'scheduleReadinessReconnect',
    'hostReadinessBlocker',
    'isHostReady',
    'effectiveLiveStatus',
    'publicState',
    'newConversation',
    'rebuildTrayMenu',
  ]);
  const declarations = tree.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text),
  );
  assert.equal(declarations.length, names.size);
  type Handler = (...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const commands: Array<[string, unknown]> = [];
  const actions: string[] = [];
  const diagnostics: string[] = [];
  let menu: Array<{ label?: string; enabled?: boolean }> = [];
  const timers: Array<{
    callback: () => void;
    delay: number;
    cancelled: boolean;
    unref: () => void;
  }> = [];
  const context = {
    ...policy,
    liveMessage,
    liveText,
    tray: {
      setContextMenu: (items: typeof menu) => {
        menu = items;
      },
      setToolTip: () => {},
    },
    Menu: { buildFromTemplate: (items: typeof menu) => items },
    retryDaemonStartup: () => {},
    quitHost: async () => {},
    quitting: false,
    nativeServicesActive: true,
    rendererEventsEnabled: true,
    quitState: undefined,
    audioError: undefined as string | undefined,
    audioTransportFailed: false,
    audioRetryPending: false,
    audioRetryChecked: false,
    audioRetryTimer: undefined,
    readinessReconnectTimer: undefined,
    readinessReconnectReason: undefined,
    captureReadyEpoch: 7 as number | undefined,
    liveStartPending: false,
    live: { state: 'listening', available: true, inputMuted: false },
    connection: { phase: 'ready' },
    permissions: {
      microphone: 'granted',
      camera: 'granted',
      accessibility: 'granted',
      screenRecording: 'granted',
    },
    selfChecks: {
      audioInput: true,
      audioOutput: true,
      globalShortcut: true,
      appshot: true,
    },
    visualInput: {
      source: 'screen' as 'screen' | 'camera',
      mode: 'on-demand' as 'on-demand' | 'live-feed',
    },
    daemonBootstrap: undefined,
    startupInvocationError: undefined,
    theme: 'system',
    themeColor: 'iris',
    resolvedTheme: () => 'light',
    language: 'en',
    overlayOffset: { x: 0, y: 0 },
    screenDisplays: [],
    screenDisplaysError: undefined,
    visualReady: true,
    visualError: undefined,
    daemon: {
      getEpoch: () => 7,
      getConfigFilePath: () => undefined,
      reconnectNow: () => actions.push('reconnect'),
    },
    startupInteraction: { cancel: () => {} },
    captureReadiness: {
      cancel: () => commands.push(['cancel capture deadline', undefined]),
    },
    isHostReady: () => true,
    isTrustedSender: () => true,
    publishState: () => {},
    showOverlay: () => {},
    stopLocalVisual: () => {},
    sendRendererCommand: (name: string, value: unknown) => {
      commands.push([name, value]);
    },
    sendRequiredAction: (value: { action: string }) => {
      actions.push(value.action);
      return true;
    },
    failClosedForReadinessLoss: () => {
      controls.stopLive();
    },
    writeLiveDiagnostic: (name: string) => diagnostics.push(name),
    setTimeout: (callback: () => void, delay: number) => {
      const timer = { callback, delay, cancelled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer: { cancelled: boolean }) => {
      timer.cancelled = true;
    },
    ipcMain: {
      handle: (name: string, handler: Handler) => handlers.set(name, handler),
      on: (name: string, handler: Handler) => handlers.set(name, handler),
    },
    READINESS_RECONNECT_DEBOUNCE_MS: 2500,
  };
  const controls = runInNewContext(
    ts.transpileModule(
      `${declarations.map((node) => node.getText(tree)).join('\n')}\n({ handleAudioFailure, failRecoverableAudio, toggleLive, stopLive, registerIpc, publicState, scheduleReadinessReconnect, newConversation, rebuildTrayMenu });`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  ) as {
    handleAudioFailure: (value: unknown, fallback: string) => void;
    failRecoverableAudio: (code: string, stage?: string) => void;
    toggleLive: () => void;
    stopLive: () => void;
    registerIpc: () => void;
    publicState: () => HostPublicState;
    scheduleReadinessReconnect: () => void;
    newConversation: () => void;
    rebuildTrayMenu: () => void;
  };
  controls.registerIpc();
  return {
    context,
    controls,
    commands,
    actions,
    diagnostics,
    timers,
    handlers,
    menu: () => menu,
  };
}

describe('recoverable Host audio failures', () => {
  it('disables New conversation and rejects stale menu actions until audio recovery completes', () => {
    const f = fixture();
    f.controls.rebuildTrayMenu();
    assert.equal(
      f.menu().find((item) => item.label === liveText('en', 'tray.new'))
        ?.enabled,
      true,
    );
    for (const pending of [false, true]) {
      f.context.audioError = pending
        ? undefined
        : liveMessage('host.audio.timeout');
      f.context.audioRetryPending = pending;
      f.controls.rebuildTrayMenu();
      assert.equal(
        f.menu().find((item) => item.label === liveText('en', 'tray.new'))
          ?.enabled,
        false,
      );
      f.controls.newConversation();
      assert(!f.actions.includes('new'));
    }
  });
  it('prioritizes real permission revocation over a retained audio error in main publicState and retry', () => {
    for (const [permission, source, blocker, message] of [
      [
        'microphone',
        'screen',
        'microphone_permission',
        'runtime.microphonePermission',
      ],
      ['camera', 'camera', 'camera_permission', 'runtime.cameraPermission'],
      [
        'accessibility',
        'screen',
        'accessibility_permission',
        'runtime.accessibilityPermission',
      ],
      [
        'screenRecording',
        'screen',
        'screen_recording_permission',
        'runtime.screenPermission',
      ],
    ] as const) {
      const f = fixture();
      f.controls.failRecoverableAudio('audio_capture_start_timeout');
      f.context.visualInput.source = source;
      f.context.permissions[permission] = 'denied';
      const state = f.controls.publicState();
      assert.equal(state.live.available, false, permission);
      assert.equal(state.live.state, 'unavailable', permission);
      assert.equal(state.live.blocker, blocker, permission);
      assert.equal(state.live.message, liveMessage(message), permission);
      assert.equal(state.audioError, undefined, permission);
      assert.equal(
        policy.shouldRenderSetup(state.live, true),
        true,
        permission,
      );
      f.controls.toggleLive();
      assert.equal(f.context.audioRetryPending, false, permission);
      assert(
        !f.commands.some(([name]) => name === 'live:audio:recheck'),
        permission,
      );
      f.controls.scheduleReadinessReconnect();
      assert.equal(f.timers.length, 1, permission);
      f.timers[0]!.callback();
      assert(f.actions.includes('reconnect'), permission);
      f.context.permissions[permission] = 'granted';
      const restored = f.controls.publicState();
      assert.equal(
        restored.audioError,
        liveMessage('host.audio.timeout'),
        permission,
      );
      assert.equal(restored.live.state, 'error', permission);
    }
  });

  it('keeps technical audio errors recoverable and ignores permissions not required by the selected source', () => {
    const f = fixture();
    f.controls.failRecoverableAudio('audio_capture_start_timeout');
    f.context.selfChecks.audioInput = false;
    f.context.visualInput.mode = 'live-feed';
    f.context.permissions.camera = 'denied';
    f.context.permissions.accessibility = 'denied';
    const state = f.controls.publicState();
    assert.equal(state.audioError, liveMessage('host.audio.timeout'));
    assert.equal(state.live.state, 'error');
    f.controls.scheduleReadinessReconnect();
    assert.equal(f.timers.length, 0);
    f.context.live.state = 'idle';
    f.controls.toggleLive();
    assert.equal(f.context.audioRetryPending, true);
  });
  it('stops the failed call once without rechecking, reconnecting, or revoking permissions', () => {
    const f = fixture();
    const permissions = { ...f.context.permissions };
    f.controls.failRecoverableAudio(
      'audio_capture_start_timeout',
      'first_frame',
    );
    f.controls.failRecoverableAudio(
      'audio_capture_start_timeout',
      'first_frame',
    );
    assert.deepEqual(f.actions, ['stop']);
    assert.deepEqual(f.context.permissions, permissions);
    assert.equal(f.context.audioTransportFailed, true);
    assert.equal(f.context.audioError, liveMessage('host.audio.timeout'));
    assert(!f.commands.some(([name]) => name === 'live:audio:recheck'));
    assert.equal(f.timers.length, 0);
    assert.deepEqual(f.diagnostics, ['audio_capture_timeout']);
  });

  it('ignores stale capture/output failures before changing the current call', () => {
    const f = fixture();
    for (const channel of [
      'live:audio:capture-error',
      'live:audio:output-error',
    ])
      f.handlers.get(channel)!(
        {},
        { epoch: 6, code: 'audio_capture_start_timeout' },
      );
    assert.equal(f.context.audioError, undefined);
    assert.deepEqual(f.actions, []);
    f.context.live.state = 'idle';
    f.controls.handleAudioFailure(
      { epoch: 7, code: 'audio_capture_start_timeout' },
      'audio_capture_error',
    );
    assert.equal(f.context.audioError, undefined);
  });

  it('makes Start perform one bounded retry and waits for a new successful self-check', () => {
    const f = fixture();
    f.controls.failRecoverableAudio('audio_capture_start_timeout');
    f.context.live.state = 'idle';
    f.controls.toggleLive();
    assert.equal(f.context.audioRetryPending, true);
    assert.equal(f.timers[0]?.delay, 10_000);
    assert.equal(
      f.commands.filter(([name]) => name === 'live:audio:recheck').length,
      1,
    );
    const selfCheck = f.handlers.get('live:audio:self-check')!;
    selfCheck(
      {},
      {
        audioInput: false,
        audioOutput: false,
        inputError: 'audio_manual_retry',
      },
    );
    assert.deepEqual(f.actions, ['stop']);
    selfCheck({}, { audioInput: true, audioOutput: true });
    assert.deepEqual(f.actions, ['stop', 'toggle']);
    assert.equal(f.context.audioError, undefined);
    assert.equal(f.context.audioRetryPending, false);
    assert.equal(f.timers[0]?.cancelled, true);
  });

  it('keeps a failed retry recoverable and lets Command+E stop a pending retry', () => {
    const f = fixture();
    f.controls.failRecoverableAudio('audio_capture_start_timeout');
    f.context.live.state = 'idle';
    f.controls.toggleLive();
    f.timers[0]!.callback();
    assert.equal(f.context.audioRetryPending, false);
    assert(f.context.audioError);
    assert(!f.actions.includes('toggle'));
    f.controls.toggleLive();
    f.controls.toggleLive();
    assert.equal(f.context.audioRetryPending, false);
    assert.equal(f.timers[1]?.cancelled, true);
  });
});
