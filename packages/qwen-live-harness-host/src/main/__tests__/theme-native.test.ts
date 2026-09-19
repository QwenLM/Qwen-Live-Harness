import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { liveMessage, type LiveMessageKey } from 'qwen-live-harness/i18n';
import type { HostPublicState } from '../../shared/host-api.ts';
import {
  isLiveTheme,
  isLiveThemeColor,
  LIVE_THEME_COLORS,
  type LiveTheme,
  type LiveThemeColor,
  type ResolvedTheme,
} from '../../shared/theme.ts';
import {
  readHostTheme,
  readHostThemeColor,
  saveHostTheme,
  saveHostThemeColor,
} from '../theme-store.ts';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile(
  'index.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
const names = new Set([
  'resolvedTheme',
  'publicState',
  'publishState',
  'publishOverlayState',
  'registerIpc',
  'isTrustedSender',
]);
const functions = tree.statements.filter(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text),
);
assert.equal(functions.length, names.size);
let initialization = '';
function findThemeStartup(node: ts.Node): void {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'then' &&
    node.expression.expression.getText(tree) === 'app.whenReady()'
  ) {
    const callback = node.arguments[0];
    assert(
      callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body),
    );
    const statements = callback.body.statements;
    const languageIndex = statements.findIndex((statement) =>
      statement.getText(tree).includes('readHostLanguage'),
    );
    assert(languageIndex > 0);
    initialization = statements
      .slice(0, languageIndex)
      .map((statement) => statement.getText(tree))
      .join('\n');
  }
  ts.forEachChild(node, findThemeStartup);
}
findThemeStartup(tree);
assert.match(initialization, /readHostTheme/);
assert.match(initialization, /nativeTheme\.themeSource/);
assert.match(initialization, /nativeTheme\.on/);

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
type Handler = (...args: unknown[]) => unknown;
const errorCode = (key: LiveMessageKey) => (error: unknown) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'message' in error &&
    error.message === liveMessage(key),
  );

function fixture(saved?: LiveTheme, systemDark = false) {
  const directory = mkdtempSync(join(tmpdir(), 'live-theme-native-'));
  directories.push(directory);
  const path = join(directory, 'theme.json');
  if (saved) saveHostTheme(path, saved);
  const handlers = new Map<string, Handler>();
  const states: HostPublicState[] = [];
  const subagentThemes: Array<[LiveTheme, ResolvedTheme]> = [];
  const subagentColors: LiveThemeColor[] = [];
  const subagentUpdates: unknown[][] = [];
  const writes: LiveTheme[] = [];
  const paletteWrites: LiveThemeColor[] = [];
  const flags = {
    failSave: false,
    destroyed: false,
    webContentsDestroyed: false,
    configPath: undefined as string | undefined,
    beforePaletteCommit: undefined as (() => void) | undefined,
  };
  class NativeTheme extends EventEmitter {
    private source: LiveTheme = 'system';
    systemDark = systemDark;
    get themeSource() {
      return this.source;
    }
    set themeSource(value: LiveTheme) {
      this.source = value;
    }
    get shouldUseDarkColors() {
      return this.source === 'system'
        ? this.systemDark
        : this.source === 'dark';
    }
    systemAppearance(dark: boolean) {
      this.systemDark = dark;
      this.emit('updated');
    }
  }
  const nativeTheme = new NativeTheme();
  const overlay = {
    isDestroyed: () => flags.destroyed,
    webContents: {
      isDestroyed: () => flags.webContentsDestroyed,
      send: (channel: string, state: HostPublicState) => {
        assert.equal(channel, 'live:state');
        states.push(JSON.parse(JSON.stringify(state)) as HostPublicState);
      },
    },
  };
  const context = {
    diagnosticsEnabled: false,
    hostDiagnostics: undefined,
    createHostDiagnosticsLogger: () => ({ write: () => {} }),
    audioError: undefined,
    audioRetryPending: false,
    daemonBootstrap: undefined,
    startupInvocationError: undefined,
    app: {
      getPath: (name: string) => {
        assert.equal(name, 'userData');
        return directory;
      },
    },
    join,
    readHostTheme,
    saveHostTheme: (savePath: string, theme: LiveTheme) => {
      assert.equal(savePath, path);
      if (flags.failSave) throw new Error('private-filesystem-detail');
      saveHostTheme(savePath, theme);
      writes.push(theme);
    },
    saveHostThemeColor: (
      savePath: string,
      color: LiveThemeColor,
      isCurrent: () => boolean,
    ) => {
      if (flags.failSave) throw new Error('private-filesystem-detail');
      let checks = 0;
      saveHostThemeColor(savePath, color, () => {
        if (++checks === 2) flags.beforePaletteCommit?.();
        return isCurrent();
      });
      paletteWrites.push(color);
    },
    isLiveTheme,
    isLiveThemeColor,
    liveMessage,
    nativeTheme,
    overlay,
    daemon: { getConfigFilePath: () => flags.configPath },
    overlayReady: true,
    rendererEventsEnabled: true,
    screenDisplays: [],
    screenDisplaysError: undefined,
    theme: 'system',
    language: 'zh-CN',
    quitApproved: false,
    quitting: false,
    quitState: undefined as HostPublicState['quitState'],
    overlayOffset: { x: 0, y: 0 },
    connection: {
      phase: 'ready',
      instanceId: 'one',
      memory: { enabled: true },
    },
    permissions: {
      microphone: 'granted',
      camera: 'granted',
      screenRecording: 'granted',
      accessibility: 'granted',
    },
    selfChecks: {
      audioInput: true,
      audioOutput: true,
      globalShortcut: true,
      appshot: true,
    },
    visualInput: {
      source: 'camera',
      mode: 'on-demand',
      fps: 1,
      liveWidth: 1280,
      liveHeight: 720,
    },
    visualReady: true,
    visualError: undefined,
    effectiveLiveStatus: () => ({
      v: 1,
      available: true,
      state: 'listening',
      shortcut: 'Command+E',
      callId: 'call-1',
    }),
    themeColor: 'iris',
    subagents: {
      setTheme: (
        theme: LiveTheme,
        appearance: ResolvedTheme,
        color: LiveThemeColor,
      ) => {
        subagentThemes.push([theme, appearance]);
        subagentColors.push(color);
      },
      update: (...args: unknown[]) => subagentUpdates.push(args),
    },
    rebuildTrayMenu: () => {},
    maybeStartStartupInteraction: () => {},
    ipcMain: {
      on: (channel: string, callback: Handler) =>
        handlers.set(channel, callback),
      handle: (channel: string, callback: Handler) =>
        handlers.set(channel, callback),
    },
  };
  const code = `${functions.map((node) => node.getText(tree)).join('\n')}
${initialization}
registerIpc();
({ publishState, publicState });`;
  const controls = runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  ) as { publishState: () => void; publicState: () => HostPublicState };
  const setTheme = handlers.get('live:set-theme');
  assert(setTheme);
  const setThemeColor = handlers.get('live:set-theme-color');
  assert(setThemeColor);
  return {
    context,
    controls,
    states,
    subagentThemes,
    subagentColors,
    subagentUpdates,
    nativeTheme,
    flags,
    writes,
    paletteWrites,
    path,
    setTheme: (theme: unknown, sender: unknown = overlay.webContents) =>
      setTheme({ sender }, theme),
    setThemeColor: (color: unknown, sender: unknown = overlay.webContents) =>
      setThemeColor({ sender }, color),
    connectConfig: (
      contents = '{"themeColor":"iris","realtimeApiKey":"test-only","memory":{"enabled":true}}',
    ) => {
      const configPath = join(directory, 'config.json');
      writeFileSync(configPath, contents, { mode: 0o600 });
      flags.configPath = configPath;
      return configPath;
    },
  };
}

describe('native theme ownership and broadcast', () => {
  it('loads the saved preference before publishing and defaults to current system appearance', () => {
    for (const saved of [undefined, 'system', 'light', 'dark'] as const) {
      const h = fixture(saved, true);
      assert.equal(h.nativeTheme.listenerCount('updated'), 1);
      h.controls.publishState();
      const theme = saved ?? 'system';
      const appearance = saved === 'light' ? 'light' : 'dark';
      assert.equal(h.nativeTheme.themeSource, theme);
      assert.equal(h.states.at(-1)?.theme, theme);
      assert.equal(h.states.at(-1)?.resolvedTheme, appearance);
      assert.deepEqual(h.subagentThemes.at(-1), [theme, appearance]);
      assert.deepEqual(h.writes, []);
    }
  });

  it('rejects unknown values, foreign or stale renderers, and requests during reload or Quit', () => {
    const h = fixture('dark');
    for (const value of [undefined, null, 'auto', 'Dark', 1, true, {}, []])
      assert.throws(() => h.setTheme(value), errorCode('host.theme.invalid'));
    assert.throws(
      () => h.setTheme('light', {}),
      errorCode('host.theme.invalid'),
    );
    const stale = h.context.overlay.webContents;
    h.context.overlay = { ...h.context.overlay, webContents: { ...stale } };
    assert.throws(
      () => h.setTheme('light', stale),
      errorCode('host.theme.invalid'),
    );
    const current = h.context.overlay.webContents;
    h.context.rendererEventsEnabled = false;
    assert.throws(
      () => h.setTheme('light', current),
      errorCode('host.theme.invalid'),
    );
    h.context.rendererEventsEnabled = true;
    h.flags.destroyed = true;
    assert.throws(
      () => h.setTheme('light', current),
      errorCode('host.theme.invalid'),
    );
    h.flags.destroyed = false;
    for (const quitState of ['pending', 'failed'] as const) {
      h.context.quitState = quitState;
      assert.throws(
        () => h.setTheme('light', current),
        errorCode('host.theme.unavailable'),
      );
    }
    assert.equal(readHostTheme(h.path), 'dark');
    assert.equal(h.nativeTheme.themeSource, 'dark');
    assert.deepEqual(h.writes, []);
    assert.equal(h.states.length, 0);
    assert.deepEqual(h.subagentThemes, []);
  });

  it('publishes a saved preference to both surfaces without changing language, media or connection state', () => {
    const h = fixture('dark');
    const before = JSON.parse(
      JSON.stringify(h.controls.publicState()),
    ) as HostPublicState;
    h.setTheme('light');
    assert.deepEqual(h.writes, ['light']);
    assert.equal(readHostTheme(h.path), 'light');
    assert.equal(h.nativeTheme.themeSource, 'light');
    assert.deepEqual(h.states.at(-1), {
      ...before,
      theme: 'light',
      resolvedTheme: 'light',
    });
    assert.deepEqual(h.subagentThemes.at(-1), ['light', 'light']);
    assert.deepEqual(h.subagentUpdates.at(-1), [
      'zh-CN',
      true,
      undefined,
      'one',
      false,
    ]);
  });

  it('keeps all current state and the old file intact when saving fails', () => {
    const h = fixture('dark');
    h.flags.failSave = true;
    const before = JSON.stringify(h.controls.publicState());
    assert.throws(
      () => h.setTheme('light'),
      errorCode('host.theme.saveFailed'),
    );
    assert.equal(JSON.stringify(h.controls.publicState()), before);
    assert.equal(readHostTheme(h.path), 'dark');
    assert.equal(h.nativeTheme.themeSource, 'dark');
    assert.deepEqual(h.states, []);
    assert.deepEqual(h.subagentThemes, []);
  });

  it('follows system updates in System mode and preserves explicit Light or Dark choices', () => {
    const h = fixture('system', false);
    h.nativeTheme.systemAppearance(true);
    assert.equal(h.states.at(-1)?.resolvedTheme, 'dark');
    assert.deepEqual(h.subagentThemes.at(-1), ['system', 'dark']);
    h.nativeTheme.systemAppearance(false);
    assert.equal(h.states.at(-1)?.resolvedTheme, 'light');
    assert.deepEqual(h.subagentThemes.at(-1), ['system', 'light']);
    assert.deepEqual(h.writes, []);
    h.setTheme('dark');
    h.nativeTheme.systemAppearance(false);
    assert.equal(h.states.at(-1)?.resolvedTheme, 'dark');
    assert.deepEqual(h.subagentThemes.at(-1), ['dark', 'dark']);
    h.setTheme('light');
    h.nativeTheme.systemAppearance(true);
    assert.equal(h.states.at(-1)?.resolvedTheme, 'light');
    assert.deepEqual(h.subagentThemes.at(-1), ['light', 'light']);
    h.setTheme('system');
    assert.equal(h.states.at(-1)?.resolvedTheme, 'dark');
    assert.deepEqual(h.subagentThemes.at(-1), ['system', 'dark']);
    assert.deepEqual(h.writes, ['dark', 'light', 'system']);
  });

  it('updates Subagents while the main renderer reloads and stays quiet after approved Quit', () => {
    const h = fixture();
    h.context.overlayReady = false;
    h.nativeTheme.systemAppearance(true);
    assert.equal(h.states.length, 0);
    assert.deepEqual(h.subagentThemes.at(-1), ['system', 'dark']);
    assert.equal(h.controls.publicState().resolvedTheme, 'dark');
    h.context.overlayReady = true;
    h.controls.publishState();
    assert.equal(h.states.at(-1)?.resolvedTheme, 'dark');
    h.context.quitApproved = true;
    h.states.length = h.subagentThemes.length = 0;
    h.nativeTheme.systemAppearance(false);
    assert.deepEqual(h.states, []);
    assert.deepEqual(h.subagentThemes, []);
  });
});

describe('connected config palette IPC', () => {
  it('saves all seven palettes and publishes to main and Subagents without changing appearance, language or media', () => {
    const h = fixture('dark');
    const configPath = h.connectConfig();
    const before = JSON.parse(
      JSON.stringify(h.controls.publicState()),
    ) as HostPublicState;
    assert.equal(before.canSetThemeColor, true);
    for (const color of LIVE_THEME_COLORS) {
      h.setThemeColor(color);
      assert.equal(readHostThemeColor(configPath), color);
      assert.equal(h.context.themeColor, color);
      assert.deepEqual(h.states.at(-1), { ...before, themeColor: color });
      assert.deepEqual(h.subagentThemes.at(-1), ['dark', 'dark']);
      assert.equal(h.subagentColors.at(-1), color);
      assert.equal(h.nativeTheme.themeSource, 'dark');
      assert.equal(readHostTheme(h.path), 'dark');
    }
    assert.deepEqual(h.paletteWrites, [...LIVE_THEME_COLORS]);
    assert.deepEqual(h.writes, []);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(config.realtimeApiKey, 'test-only');
    assert.deepEqual(config.memory, { enabled: true });
  });

  it('rejects invalid values, foreign and stale senders, reloads and destroyed renderers before writing', () => {
    const h = fixture('light');
    const configPath = h.connectConfig();
    const before = readFileSync(configPath, 'utf8');
    for (const value of [
      undefined,
      null,
      true,
      1,
      'Iris',
      ' iris ',
      'auto',
      [],
      {},
    ])
      assert.throws(
        () => h.setThemeColor(value),
        errorCode('host.themeColor.invalid'),
      );
    assert.throws(
      () => h.setThemeColor('sage', {}),
      errorCode('host.themeColor.invalid'),
    );
    const stale = h.context.overlay.webContents;
    h.context.overlay = { ...h.context.overlay, webContents: { ...stale } };
    assert.throws(
      () => h.setThemeColor('sage', stale),
      errorCode('host.themeColor.invalid'),
    );
    const current = h.context.overlay.webContents;
    h.context.rendererEventsEnabled = false;
    assert.throws(
      () => h.setThemeColor('sage', current),
      errorCode('host.themeColor.invalid'),
    );
    h.context.rendererEventsEnabled = true;
    h.flags.destroyed = true;
    assert.throws(
      () => h.setThemeColor('sage', current),
      errorCode('host.themeColor.invalid'),
    );
    h.flags.destroyed = false;
    h.flags.webContentsDestroyed = true;
    assert.throws(
      () => h.setThemeColor('sage', current),
      errorCode('host.themeColor.invalid'),
    );
    assert.equal(readFileSync(configPath, 'utf8'), before);
    assert.deepEqual(h.paletteWrites, []);
    assert.deepEqual(h.states, []);
  });

  it('disables and rejects unavailable configurations, disconnected daemons and pending or failed Quit', () => {
    const h = fixture();
    assert.equal(h.controls.publicState().canSetThemeColor, false);
    assert.throws(
      () => h.setThemeColor('tide'),
      errorCode('host.themeColor.unavailable'),
    );
    const configPath = h.connectConfig();
    const before = readFileSync(configPath, 'utf8');
    for (const phase of ['connecting', 'disconnected', 'error']) {
      h.context.connection.phase = phase;
      assert.equal(h.controls.publicState().canSetThemeColor, false);
      assert.throws(
        () => h.setThemeColor('tide'),
        errorCode('host.themeColor.unavailable'),
      );
    }
    h.context.connection.phase = 'ready';
    for (const quitState of ['pending', 'failed'] as const) {
      h.context.quitState = quitState;
      assert.equal(h.controls.publicState().canSetThemeColor, false);
      assert.throws(
        () => h.setThemeColor('tide'),
        errorCode('host.themeColor.unavailable'),
      );
    }
    h.context.quitState = undefined;
    h.context.quitting = true;
    assert.equal(h.controls.publicState().canSetThemeColor, false);
    assert.throws(
      () => h.setThemeColor('tide'),
      errorCode('host.themeColor.unavailable'),
    );
    h.context.quitting = false;
    h.context.connection.instanceId = '';
    assert.throws(
      () => h.setThemeColor('tide'),
      errorCode('host.themeColor.unavailable'),
    );
    assert.equal(readFileSync(configPath, 'utf8'), before);
    assert.deepEqual(h.paletteWrites, []);
  });

  it('revalidates daemon instance, path and renderer identity before committing', () => {
    for (const change of [
      'instance',
      'path',
      'renderer',
      'quitting',
    ] as const) {
      const h = fixture();
      const configPath = h.connectConfig();
      const before = readFileSync(configPath, 'utf8');
      h.flags.beforePaletteCommit = () => {
        if (change === 'instance')
          h.context.connection.instanceId = 'next-daemon';
        if (change === 'path') h.flags.configPath = `${configPath}.other`;
        if (change === 'renderer')
          h.context.overlay = {
            ...h.context.overlay,
            webContents: { ...h.context.overlay.webContents },
          };
        if (change === 'quitting') h.context.quitting = true;
      };
      assert.throws(
        () => h.setThemeColor('rose'),
        errorCode('host.themeColor.unavailable'),
      );
      assert.equal(readFileSync(configPath, 'utf8'), before);
      assert.equal(h.context.themeColor, 'iris');
      assert.deepEqual(h.paletteWrites, []);
      assert.deepEqual(h.states, []);
      assert.deepEqual(h.subagentColors, []);
    }
  });

  it('returns localized failures without exposing private data or optimistically publishing failed writes', () => {
    const h = fixture();
    const configPath = h.connectConfig();
    const before = JSON.stringify(h.controls.publicState());
    const contents = readFileSync(configPath, 'utf8');
    h.flags.failSave = true;
    assert.throws(
      () => h.setThemeColor('berry'),
      errorCode('host.themeColor.saveFailed'),
    );
    assert.equal(JSON.stringify(h.controls.publicState()), before);
    assert.equal(readFileSync(configPath, 'utf8'), contents);
    h.flags.failSave = false;
    writeFileSync(configPath, '{"realtimeApiKey":"test-secret",');
    assert.throws(
      () => h.setThemeColor('berry'),
      errorCode('host.themeColor.saveFailed'),
    );
    assert.equal(
      readFileSync(configPath, 'utf8'),
      '{"realtimeApiKey":"test-secret",',
    );
    assert.deepEqual(h.paletteWrites, []);
    assert.deepEqual(h.states, []);
    assert.deepEqual(h.subagentColors, []);
  });
});
