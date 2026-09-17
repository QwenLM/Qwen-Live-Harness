import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { resolveDiscoveryPath } from '../discovery.ts';
import type { DaemonBootstrapState } from '../daemon-bootstrap.ts';
import type { HostPublicState } from '../../shared/host-api.ts';
import { parseDaemonOwner } from '../daemon-lifecycle.ts';

function fixture() {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile(
    'index.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set([
    'openHost',
    'finishHostActivation',
    'activateHost',
    'retryDaemonStartup',
    'prepareDaemonLaunch',
    'rebuildTrayMenu',
    'publicState',
  ]);
  const functions = tree.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text),
  );
  assert.equal(functions.length, names.size);
  let launches = 0;
  const launchOptions: Array<{ startIfMissing?: boolean }> = [];
  let shows = 0;
  type TrayItem = { label?: string; enabled?: boolean; click?: () => void };
  let menu: TrayItem[] = [];
  const context = {
    audioError: undefined,
    audioRetryPending: false,
    activationGeneration: 0,
    pendingActivationGeneration: undefined as number | undefined,
    daemonLifecycle: undefined as
      | {
          acceptActivation: (owner: {
            pid: number;
            instanceNonce: string;
          }) => Promise<boolean>;
        }
      | undefined,
    parseDaemonOwner,
    activationConnectOnly: false,
    tray: {
      setContextMenu: (items: TrayItem[]) => {
        menu = items;
      },
      setToolTip: () => {},
    },
    Menu: { buildFromTemplate: (items: TrayItem[]) => items },
    liveText: (_language: string, key: string) => key,
    live: { state: 'idle' },
    isActiveLiveCall: () => false,
    toggleLive: () => {},
    newConversation: () => {},
    stopLive: () => {},
    quitHost: async () => {},
    daemonBootstrap: {
      snapshot: { phase: 'idle' } as DaemonBootstrapState,
      start: (options: { startIfMissing?: boolean }) => {
        launches++;
        launchOptions.push(options);
        return Promise.resolve();
      },
    },
    daemonDiscoveryPath: '/fixture/run/daemon.json',
    startupInvocationError: undefined as string | undefined,
    process: {
      env: { QWEN_LIVE_HARNESS_DISCOVERY_FILE: '/fixture/run/daemon.json' },
    },
    resolveDiscoveryPath,
    liveMessage: (key: string) => key,
    startupErrorMessage: (error: unknown) => `startup:${String(error)}`,
    daemon: { getConfigFilePath: () => undefined },
    appshotReadiness: { refresh: () => {} },
    publishState: () => {},
    writeLiveDiagnostic: () => {},
    showOverlay: () => {
      shows++;
    },
    quitting: false,
    quitState: undefined as HostPublicState['quitState'],
    connection: {
      phase: 'disconnected',
      error: undefined as string | undefined,
    },
    language: 'en',
    theme: 'system',
    themeColor: 'iris',
    resolvedTheme: () => 'light',
    overlayOffset: { x: 0, y: 0 },
    visualInput: undefined,
    screenDisplays: [],
    screenDisplaysError: undefined,
    permissions: {},
    selfChecks: {},
    visualReady: false,
    visualError: undefined,
    effectiveLiveStatus: () => ({
      v: 1,
      available: false,
      state: 'unavailable',
      shortcut: 'Command+E',
    }),
  };
  const code = `${functions.map((node) => node.getText(tree)).join('\n')}\n({ openHost, activateHost, retryDaemonStartup, rebuildTrayMenu, prepareDaemonLaunch, publicState });`;
  const controls = runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  ) as {
    openHost(argv?: string[]): void;
    activateHost(): void;
    retryDaemonStartup(): void;
    rebuildTrayMenu(): void;
    prepareDaemonLaunch(argv: string[]): { startIfMissing: boolean };
    publicState(): HostPublicState;
  };
  return {
    context,
    controls,
    launchOptions,
    launches: () => launches,
    shows: () => shows,
    menu: () => menu,
  };
}

describe('Host desktop launch presentation', () => {
  it('allows an explicit non-CLI second-instance launch to start a missing daemon', () => {
    const host = fixture();
    host.controls.openHost(['Host', '--qwen-live-harness-connect-only']);
    assert.equal(host.launchOptions[0]?.startIfMissing, false);
    host.controls.openHost(['Host']);
    assert.equal(host.launchOptions[1]?.startIfMissing, true);
  });

  it('keeps every later activation connect-only after initial or second-instance CLI launch', () => {
    for (const initial of [true, false]) {
      const host = fixture();
      if (initial) {
        const options = host.controls.prepareDaemonLaunch([
          'Host',
          '--qwen-live-harness-connect-only',
        ]);
        host.context.daemonBootstrap.start(options);
      } else {
        host.controls.openHost(['Host', '--qwen-live-harness-connect-only']);
      }
      assert.equal(host.launchOptions[0]?.startIfMissing, false);
      for (let iteration = 0; iteration < 10; iteration++) {
        host.controls.activateHost();
      }
      assert.equal(host.launches(), 11);
      assert(
        host.launchOptions.every((options) => options.startIfMissing === false),
      );
    }
  });

  it('lets Retry startup explicitly start a missing daemon after the CLI stopped', () => {
    const host = fixture();
    host.controls.openHost(['Host', '--qwen-live-harness-connect-only']);
    host.controls.rebuildTrayMenu();
    const retry = host.menu().find((item) => item.label === 'startup.retry');
    assert.equal(retry?.enabled, true);
    retry?.click?.();
    assert.equal(host.launchOptions[1]?.startIfMissing, true);
  });

  it('starts a missing daemon for a fresh desktop Host launch', () => {
    const host = fixture();
    const options = host.controls.prepareDaemonLaunch(['Host']);
    host.context.daemonBootstrap.start(options);
    assert.equal(host.launchOptions[0]?.startIfMissing, true);
  });

  it('disables Retry startup while ready, starting or quitting and rejects stale clicks', () => {
    for (const state of [
      'ready',
      'starting',
      'quitting',
      'quit-failed',
    ] as const) {
      const host = fixture();
      if (state === 'ready') host.context.connection.phase = 'ready';
      if (state === 'starting')
        host.context.daemonBootstrap.snapshot = { phase: 'starting' };
      if (state === 'quitting') host.context.quitting = true;
      if (state === 'quit-failed') host.context.quitState = 'failed';
      host.controls.rebuildTrayMenu();
      const retry = host.menu().find((item) => item.label === 'startup.retry');
      assert.equal(retry?.enabled, false, state);
      retry?.click?.();
      assert.equal(host.launches(), 0, state);
    }
  });

  it('starts only for explicit opening and reuses an already connected daemon', () => {
    const host = fixture();
    host.controls.openHost();
    assert.equal(host.launches(), 1);
    host.context.connection.phase = 'ready';
    host.controls.openHost();
    assert.equal(host.launches(), 1);
    assert.equal(host.shows(), 2);
    host.context.connection.phase = 'disconnected';
    host.controls.publicState();
    assert.equal(host.launches(), 1);
  });

  it('keeps actionable startup errors across unrelated discovery snapshots', () => {
    const host = fixture();
    host.context.daemonBootstrap.snapshot = {
      phase: 'failed',
      error: 'runtime_missing',
    };
    assert.equal(
      host.controls.publicState().connectionError,
      'startup:runtime_missing',
    );
    host.context.connection.phase = 'error';
    host.context.connection.error = 'discovery_unreadable';
    assert.equal(
      host.controls.publicState().connectionError,
      'startup:runtime_missing',
    );
    host.context.daemonBootstrap.snapshot = { phase: 'starting' };
    assert.equal(
      host.controls.publicState().connectionError,
      'startup.connecting',
    );
    host.context.daemonBootstrap.snapshot = { phase: 'ready' };
    host.context.connection.phase = 'ready';
    host.context.connection.error = undefined;
    assert.equal(host.controls.publicState().connectionError, undefined);
  });

  it('does not switch an existing Host to another discovery path', () => {
    const host = fixture();
    host.context.connection.phase = 'ready';
    host.controls.openHost([
      'Host',
      '--qwen-live-harness-discovery-file=/different/run/daemon.json',
    ]);
    assert.equal(host.launches(), 0);
    assert.equal(host.context.daemonDiscoveryPath, '/fixture/run/daemon.json');
    assert.equal(
      host.controls.publicState().connectionError,
      'startup.profileMismatch',
    );
    assert.equal(host.controls.publicState().connection, 'ready');
    host.controls.openHost([
      'Host',
      '--qwen-live-harness-discovery-file=/fixture/run/daemon.json',
    ]);
    assert.equal(host.controls.publicState().connectionError, undefined);
  });

  it('checks a second-instance owner before activating and does not let macOS focus bypass it', async () => {
    const host = fixture();
    let accept!: (accepted: boolean) => void;
    host.context.daemonLifecycle = {
      acceptActivation: () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    };
    host.controls.openHost([
      'Host',
      '--qwen-live-harness-connect-only',
      '--qwen-live-harness-owner=1234:fixture_daemon_nonce',
    ]);
    host.controls.activateHost();
    assert.equal(host.launches(), 0);
    accept(true);
    await Promise.resolve();
    assert.equal(host.launches(), 1);
    assert.equal(host.launchOptions[0]?.startIfMissing, false);
  });

  it('keeps an unrelated running instance untouched when a second owner is rejected', async () => {
    const host = fixture();
    host.context.connection.phase = 'ready';
    host.context.daemonLifecycle = { acceptActivation: async () => false };
    host.controls.openHost([
      'Host',
      '--qwen-live-harness-owner=1234:fixture_daemon_nonce',
    ]);
    await Promise.resolve();
    assert.equal(host.launches(), 0);
    assert.equal(host.controls.publicState().connection, 'ready');
    assert.equal(
      host.controls.publicState().connectionError,
      'startup.ownerMismatch',
    );
  });

  it('rejects malformed owners without invoking daemon startup', () => {
    const host = fixture();
    host.controls.openHost(['Host', '--qwen-live-harness-owner=1234:short']);
    assert.equal(host.launches(), 0);
    assert.equal(
      host.controls.publicState().connectionError,
      'startup.invalidOwner',
    );
  });

  it('rejects invalid desktop arguments and never starts while quitting or awaiting Quit retry', () => {
    const host = fixture();
    host.controls.openHost([
      'Host',
      '--qwen-live-harness-discovery-file=relative.json',
    ]);
    assert.equal(
      host.controls.publicState().connectionError,
      'startup.invalidDiscoveryPath',
    );
    assert.equal(host.launches(), 0);
    host.context.quitting = true;
    host.controls.openHost();
    host.context.quitting = false;
    host.context.quitState = 'failed';
    host.controls.openHost();
    assert.equal(host.launches(), 0);
  });
});
