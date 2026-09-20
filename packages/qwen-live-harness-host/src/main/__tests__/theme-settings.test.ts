import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { liveMessage, liveText } from 'qwen-live-harness/i18n';
import { LiveView } from '../../renderer/live-view.ts';
import { SubagentsView } from '../../renderer/subagents-view.ts';
import { applyTheme } from '../../renderer/theme.ts';
import type { HostPublicState, LiveHostApi } from '../../shared/host-api.ts';
import type { SubagentsWindowState } from '../../shared/subagents-api.ts';
import {
  LIVE_THEME_COLORS,
  type LiveTheme,
  type LiveThemeColor,
} from '../../shared/theme.ts';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

function documentRoot() {
  const dom = new JSDOM('<!doctype html><main id="app"></main>');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  cleanup.push(() => {
    dom.window.close();
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  return {
    dom,
    app: dom.window.document.querySelector<HTMLElement>('#app')!,
  };
}

function host(overrides: Partial<LiveHostApi> = {}) {
  const { dom, app } = documentRoot();
  const state: HostPublicState = {
    language: 'en',
    connection: 'ready',
    canSetThemeColor: true,
    live: { v: 1, available: true, state: 'idle', shortcut: 'Command+E' },
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
      source: 'camera',
      mode: 'on-demand',
      fps: 1,
      liveWidth: 1280,
      liveHeight: 720,
    },
    memory: {
      enabled: true,
      visualEnabled: false,
      libraryId: 'default',
      model: 'qwen3.7-plus',
      libraries: [{ id: 'default', name: 'Default' }],
      locked: false,
    },
    visualReady: true,
  };
  const themes: LiveTheme[] = [];
  const colors: LiveThemeColor[] = [];
  let previews = 0;
  const api: LiveHostApi = {
    toggle: async () => {},
    stop: async () => {},
    quit: async () => {},
    newConversation: async () => {},
    setInputMuted: async () => {},
    setOutputMuted: async () => {},
    setVisualSource: async () => {},
    setVisualMode: async () => {},
    setScreenDisplay: async () => {},
    memoryAction: async () => {
      throw new Error('Theme updates must not change memory');
    },
    setLanguage: async () => {
      throw new Error('Theme updates must not change language');
    },
    setTheme: async (theme) => {
      themes.push(theme);
    },
    setThemeColor: async (color) => {
      colors.push(color);
    },
    setSettingsOpen: async () => {},
    openSubagents: async () => {},
    openConfig: async () => {},
    setOverlayLayout: () => {},
    onSettingsDismiss: () => () => {},
    onOverlayOffset: () => () => {},
    dragOverlay: () => {},
    attachCameraPreview: () => {
      previews++;
    },
    requestPermission: async () => {},
    listInputDevices: async () => [],
    setInputDevice: async () => {},
    openWebShellForPermission: async () => {},
    getState: async () => state,
    onInputLevel: () => () => {},
    onState: () => () => {},
    ...overrides,
  };
  const view = new LiveView(app, api);
  cleanup.push(() => view.dispose());
  view.update(state);
  const get = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const node = app.querySelector<T>(selector);
    assert(node, `Missing ${selector}`);
    return node;
  };
  const update = (next: Partial<HostPublicState>) => {
    Object.assign(state, next);
    view.update({ ...state });
  };
  return { dom, app, get, update, themes, colors, previews: () => previews };
}

describe('Qwen Live Harness Host theme settings', () => {
  it('offers global ask/allow-all modes but changes the selection only after a confirmed save', async () => {
    let finish: () => void = () => {};
    const calls: string[] = [];
    const h = host({
      setPermissionMode: (next) => {
        calls.push(next);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    h.update({ permissionModeV1: { mode: 'ask' } });
    h.get<HTMLButtonElement>('.settings-control').click();
    await settled();
    const select = h.get<HTMLSelectElement>(
      'select[data-live-label="permissionMode.label"]',
    );
    assert.equal(select.value, 'ask');
    assert.equal(select.disabled, false);
    assert.deepEqual(
      [...select.options].map((option) => option.value),
      ['ask', 'allow-all'],
    );
    select.value = 'allow-all';
    select.dispatchEvent(new h.dom.window.Event('change'));
    assert.equal(select.value, 'ask');
    assert.equal(select.disabled, true);
    assert.deepEqual(calls, ['allow-all']);
    h.update({ permissionModeV1: { mode: 'allow-all' } });
    finish();
    await settled();
    assert.equal(select.value, 'allow-all');
    assert.equal(select.disabled, false);
    h.update({ language: 'zh-CN' });
    assert.equal(
      select.options[1]!.textContent,
      liveText('zh-CN', 'permissionMode.allowAll'),
    );
    assert.equal(
      h.get('#permission-mode-hint').textContent,
      liveText('zh-CN', 'permissionMode.allowAllHint'),
    );
  });
  it('restores global permission selection after save failure and disables legacy or disconnected settings', async () => {
    const h = host({
      setPermissionMode: async () => {
        throw new Error(liveMessage('permissionMode.saveFailed'));
      },
    });
    h.get<HTMLButtonElement>('.settings-control').click();
    await settled();
    const select = h.get<HTMLSelectElement>(
      'select[data-live-label="permissionMode.label"]',
    );
    assert.equal(select.value, 'ask');
    assert.equal(select.disabled, true);
    h.update({ permissionModeV1: { mode: 'ask' } });
    select.value = 'allow-all';
    select.dispatchEvent(new h.dom.window.Event('change'));
    await settled();
    assert.equal(select.value, 'ask');
    assert.equal(select.disabled, false);
    assert(
      h.app.textContent?.includes(liveText('en', 'permissionMode.saveFailed')),
    );
    h.update({ connection: 'disconnected' });
    assert.equal(select.disabled, true);
  });
  it('offers seven named color choices with a visible selection indicator and bilingual labels', async () => {
    const h = host();
    h.get<HTMLButtonElement>('.settings-control').click();
    await settled();
    const choices = h.app.querySelectorAll<HTMLButtonElement>(
      '.theme-palette-option',
    );
    assert.deepEqual(
      Array.from(choices, (choice) => choice.dataset.color),
      [...LIVE_THEME_COLORS],
    );
    assert.equal(
      h.get('.theme-palette-options').getAttribute('aria-label'),
      'Color palette',
    );
    for (const color of LIVE_THEME_COLORS) {
      const choice = h.get<HTMLButtonElement>(`[data-color="${color}"]`);
      assert.equal(
        choice.getAttribute('aria-pressed'),
        String(color === 'iris'),
      );
      assert(
        choice.querySelector('.theme-palette-swatch .theme-palette-check'),
      );
      assert(choice.querySelector('.theme-palette-name')?.textContent);
      assert.equal(choice.disabled, false);
    }
    h.update({ language: 'zh-CN', themeColor: 'sage' });
    assert.equal(
      h.get('[data-color="sage"]').getAttribute('aria-label'),
      '鼠尾草',
    );
    assert.equal(
      h.get('[data-color="sage"] .theme-palette-name').textContent,
      '鼠尾草',
    );
    assert.equal(
      h.get('[data-color="sage"]').getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      h.get('[data-color="iris"]').getAttribute('aria-pressed'),
      'false',
    );
    assert.equal(
      h.get('.theme-palette-options').getAttribute('aria-label'),
      '配色',
    );
  });

  it('applies only confirmed palette state and preserves the open settings, preview and drafts', async () => {
    const h = host();
    h.get<HTMLButtonElement>('.settings-control').click();
    await settled();
    const panel = h.get('.settings-panel');
    const body = h.get('.settings-body');
    const camera = h.get('.camera-preview-slot');
    const video = h.dom.window.document.createElement('video');
    camera.append(video);
    const draft = h.get<HTMLInputElement>('.memory-model-form input');
    draft.value = 'Unsubmitted model draft';
    draft.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    body.scrollTop = 87;
    h.get<HTMLButtonElement>('[data-color="iris"]').click();
    assert.deepEqual(h.colors, []);
    const tide = h.get<HTMLButtonElement>('[data-color="tide"]');
    tide.focus();
    tide.click();
    await settled();
    assert.deepEqual(h.colors, ['tide']);
    assert.equal(tide.getAttribute('aria-pressed'), 'false');
    h.update({ themeColor: 'tide', resolvedTheme: 'light' });
    assert.equal(
      h.dom.window.document.documentElement.dataset.themeColor,
      'tide',
    );
    assert.equal(h.get('.settings-panel'), panel);
    assert.equal(h.get('.settings-layer').hidden, false);
    assert.equal(h.get('.settings-body').scrollTop, 87);
    assert.equal(h.get('.camera-preview-slot').firstChild, video);
    assert.equal(draft.value, 'Unsubmitted model draft');
    assert.equal(h.dom.window.document.activeElement, tide);
    assert.equal(tide.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(h.themes, []);
    assert.equal(h.previews(), 1);
  });

  it('restores controls and the saved selection when a palette cannot be saved', async () => {
    const h = host({
      setThemeColor: async () => {
        throw new Error(liveMessage('host.themeColor.saveFailed'));
      },
    });
    h.update({ language: 'zh-CN', themeColor: 'berry' });
    h.get<HTMLButtonElement>('.settings-control').click();
    await settled();
    const clay = h.get<HTMLButtonElement>('[data-color="clay"]');
    clay.click();
    assert.equal(clay.disabled, true);
    await settled();
    assert.equal(clay.disabled, false);
    assert.equal(
      h.get('[data-color="berry"]').getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      h.get('.settings-status.error').textContent,
      liveText('zh-CN', 'host.themeColor.saveFailed'),
    );
    assert.equal(h.get('.settings-status').hidden, false);
    assert.equal(
      h.dom.window.document.documentElement.dataset.themeColor,
      'berry',
    );
  });

  it('requires a connected writable configuration and blocks palette actions during Quit', async () => {
    const h = host();
    for (const state of [
      { canSetThemeColor: false },
      { canSetThemeColor: true, connection: 'disconnected' as const },
      { connection: 'ready' as const, quitState: 'pending' as const },
    ]) {
      h.update(state);
      const clay = h.get<HTMLButtonElement>('[data-color="clay"]');
      assert.equal(clay.disabled, true);
      clay.click();
    }
    assert.deepEqual(h.colors, []);
  });

  it('supports keyboard navigation without changing the palette until activation', async () => {
    const h = host();
    h.get<HTMLButtonElement>('.settings-control').click();
    await settled();
    const iris = h.get<HTMLButtonElement>('[data-color="iris"]');
    iris.focus();
    iris.dispatchEvent(
      new h.dom.window.KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }),
    );
    const clay = h.get<HTMLButtonElement>('[data-color="clay"]');
    assert.equal(h.dom.window.document.activeElement, clay);
    clay.dispatchEvent(
      new h.dom.window.KeyboardEvent('keydown', {
        key: 'End',
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(
      h.dom.window.document.activeElement,
      h.get('[data-color="berry"]'),
    );
    assert.deepEqual(h.colors, []);
    assert.equal(
      h.get('[data-color="iris"]').getAttribute('aria-pressed'),
      'true',
    );
  });

  it('offers a persistent display choice without changing Camera or init and retains unavailable selections', async () => {
    const selections: string[] = [];
    const h = host({
      setScreenDisplay: async (id) => {
        selections.push(id);
      },
    });
    const id = '11223344-5566-7788-99aa-bbccddeeff00';
    const settings = {
      source: 'screen',
      mode: 'live-feed',
      fps: 1,
      liveWidth: 1280,
      liveHeight: 720,
      screenDisplayId: 'primary',
    } as const;
    h.update({
      visualInput: settings,
      canSelectScreenDisplay: true,
      screenDisplays: [
        {
          id,
          name: 'Studio Display',
          width: 5120,
          height: 2880,
          primary: true,
        },
      ],
    });
    h.get<HTMLButtonElement>('.settings-control').click();
    await settled();
    const display = h.get<HTMLSelectElement>('select[aria-label="Display"]');
    assert.equal(display.value, 'primary');
    assert.equal(display.options[0]?.textContent, 'Primary display');
    assert.match(display.options[1]?.textContent ?? '', /Studio Display.*5120/);
    display.value = id;
    display.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
    await settled();
    assert.deepEqual(selections, [id]);
    assert.equal(display.value, 'primary');
    h.update({
      visualInput: { ...settings, screenDisplayId: id },
      language: 'zh-CN',
    });
    assert.equal(display.value, id);
    assert.equal(display.getAttribute('aria-label'), '显示器');
    h.update({ screenDisplays: [] });
    h.update({ visualSettingsError: liveMessage('runtime.displaySaveFailed') });
    assert.match(
      h.get('.settings-status').textContent ?? '',
      /无法保存显示器选择/,
    );
    assert.equal(display.value, id);
    assert.match(display.selectedOptions[0]?.textContent ?? '', /不可用/);
    h.update({ visualInput: { ...settings, source: 'camera' } });
    assert.equal(display.closest<HTMLElement>('.settings-field')?.hidden, true);
  });

  it('places Appearance and Color palette after Language and sends each appearance preference', async () => {
    const h = host();
    h.get<HTMLButtonElement>('.settings-control').click();
    await settled();
    const fields = h.app.querySelectorAll('.settings-group > .settings-field');
    assert.equal(
      fields[fields.length - 3]?.firstChild?.textContent,
      'Language',
    );
    assert.equal(
      fields[fields.length - 2]?.firstChild?.textContent,
      'Appearance',
    );
    assert.equal(
      fields[fields.length - 1]?.firstChild?.textContent,
      'Color palette',
    );
    assert.equal(
      h.get('[data-theme="system"]').getAttribute('aria-pressed'),
      'true',
    );
    for (const theme of ['light', 'dark', 'system'] as const) {
      h.get<HTMLButtonElement>(`[data-theme="${theme}"]`).click();
      await settled();
    }
    assert.deepEqual(h.themes, ['light', 'dark', 'system']);
    assert.equal(
      h.get('[data-theme="system"]').getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(h.dom.window.document.documentElement.dataset.theme, 'dark');
    h.update({ theme: 'system', resolvedTheme: 'light', language: 'zh-CN' });
    assert.equal(h.get('[data-theme="system"]').textContent, '跟随系统');
    assert.equal(h.get('[data-theme="light"]').textContent, '浅色');
    assert.equal(h.get('[data-theme="dark"]').textContent, '深色');
    assert.equal(
      h.get('[data-theme="system"]').getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      h.get('select[data-live-label="language.label"] option[value="en"]')
        .textContent,
      'English',
    );
    assert.equal(
      h.get('select[data-live-label="language.label"] option[value="zh-CN"]')
        .textContent,
      '简体中文',
    );
  });

  it('keeps the saved preference selected when saving fails and restores controls', async () => {
    const h = host({
      setTheme: async () => {
        throw new Error(liveMessage('host.theme.saveFailed'));
      },
    });
    h.update({ theme: 'dark', resolvedTheme: 'dark', language: 'zh-CN' });
    h.get<HTMLButtonElement>('.settings-control').click();
    await settled();
    const light = h.get<HTMLButtonElement>('[data-theme="light"]');
    light.click();
    assert.equal(light.disabled, true);
    await settled();
    assert.equal(light.disabled, false);
    assert.equal(
      h.get('[data-theme="dark"]').getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      h.get('.settings-status.error').textContent,
      liveText('zh-CN', 'host.theme.saveFailed'),
    );
    assert.equal(h.dom.window.document.documentElement.dataset.theme, 'dark');
  });

  it('applies the same resolved appearance to every surface without replacing media or task nodes', () => {
    const h = host();
    const orb = h.get('.voice-orb');
    const slot = h.get('.camera-preview-slot');
    const video = h.dom.window.document.createElement('video');
    slot.append(video);
    const model = h.get<HTMLInputElement>('.memory-model-form input');
    model.value = 'Keep my model draft';
    model.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    const { dom, app } = documentRoot();
    const view = new SubagentsView(app, {
      getState: async () => ({ language: 'en', connected: true, mode: 'list' }),
      onState: () => () => {},
      setHover: () => {},
      back: async () => {},
      expand: async () => {},
      close: () => {},
      openDetail: async () => {},
      control: async () => ({ type: 'error', code: 'unsupported' }),
    });
    cleanup.push(() => view.dispose());
    for (const mode of ['summary', 'list', 'detail'] as const) {
      for (const resolvedTheme of ['light', 'dark'] as const) {
        h.update({ theme: 'system', resolvedTheme });
        const state: SubagentsWindowState = {
          language: 'en',
          connected: true,
          mode,
          theme: 'system',
          resolvedTheme,
          selectedId: 'theme-task',
          snapshot: {
            revision: 1,
            counts: {
              running: 1,
              completed: 0,
              needsAttention: 0,
              failed: 0,
              cancelled: 0,
              interrupted: 0,
            },
            omitted: 0,
            tasks: [
              {
                id: 'theme-task',
                kind: 'harness',
                title: 'Keep task nodes',
                status: 'running',
                createdAt: 1,
                updatedAt: 1,
                request: 'Original request',
                output: 'Original output',
                activity: 'Still running',
                events: [],
              },
            ],
          },
        };
        view.update(state);
        const children = Array.from(app.children);
        const task = app.querySelector('.subagent-task');
        const output = app.querySelector('.subagent-output');
        view.update({
          ...state,
          resolvedTheme: resolvedTheme === 'light' ? 'dark' : 'light',
        });
        view.update(state);
        assert.equal(
          dom.window.document.documentElement.dataset.theme,
          resolvedTheme,
        );
        assert.equal(
          h.dom.window.document.documentElement.dataset.theme,
          resolvedTheme,
        );
        assert.deepEqual(Array.from(app.children), children);
        assert.equal(app.querySelector('.subagent-task'), task);
        assert.equal(app.querySelector('.subagent-output'), output);
        assert.equal(h.get('.voice-orb'), orb);
        assert.equal(h.get('.camera-preview-slot').firstChild, video);
        assert.equal(model.value, 'Keep my model draft');
        assert.equal(h.get('.memory-model-form input'), model);
      }
    }
    assert.equal(h.previews(), 1);
  });

  it('does not mutate the document for an unchanged appearance', () => {
    const { dom } = documentRoot();
    const document = dom.window.document;
    applyTheme(document);
    const observer = new dom.window.MutationObserver(() => {});
    observer.observe(document.documentElement, { attributes: true });
    applyTheme(document, 'dark');
    assert.equal(observer.takeRecords().length, 0);
    applyTheme(document, 'light');
    assert.equal(observer.takeRecords().length, 1);
    observer.disconnect();
  });
});

describe('shared theme palette', () => {
  const read = (file: string) =>
    readFileSync(new URL(`../../renderer/${file}`, import.meta.url), 'utf8');
  const theme = read('theme.css');
  const tokens = (body: string) => {
    const values: Record<string, string> = Object.fromEntries(
      Array.from(body.matchAll(/(--live-[\w-]+):\s*([^;]+);/g), (match) => [
        match[1]!,
        match[2]!,
      ]),
    );
    const resolve = (value: string): string =>
      value.replace(/var\((--live-[\w-]+)\)/g, (_, key: string) =>
        resolve(values[key]!),
      );
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, resolve(value)]),
    );
  };
  const dark = tokens(theme.match(/:root\s*\{([^}]+)\}/)![1]!);
  const light = tokens(
    theme.match(/:root\[data-theme='light'\]\s*\{([^}]+)\}/)![1]!,
  );

  it('defines both appearances for every semantic token and keeps every palette color centralized', () => {
    assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
    for (const name of ['style.css', 'subagents.css']) {
      const css = read(name);
      assert.match(css, /@import '\.\/theme\.css'/);
      for (const match of css.matchAll(/var\((--live-[\w-]+)/g))
        assert(match[1]! in dark, `Undefined ${match[1]}`);
      assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(/i);
    }
    for (const name of ['clay', 'sage', 'tide', 'graphite', 'rose', 'berry']) {
      for (const mode of ['light', 'dark'])
        assert(
          theme.includes(`[data-theme-color='${name}'][data-theme='${mode}']`),
        );
    }
  });

  it('keeps light text, errors, statuses and primary buttons readable', () => {
    const rgb = (hex: string) =>
      hex
        .replace('#', '')
        .match(/../g)!
        .map((v) => parseInt(v, 16));
    const luminance = (color: number[]) =>
      color
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce(
          (sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!,
          0,
        );
    const contrast = (fg: number[], bg: number[]) => {
      const [a, b] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      return (a! + 0.05) / (b! + 0.05);
    };
    for (const color of [
      'text',
      'muted',
      'subtle',
      'error',
      'success',
      'warning',
    ]) {
      assert(
        contrast(
          rgb(light[`--live-${color}`]!),
          rgb(light['--live-surface']!),
        ) >= 4.5,
        color,
      );
    }
    for (const desktop of [0, 255]) {
      const surface = light['--live-panel-bg']!.match(/[\d.]+/g)!.map(Number);
      const alpha = surface[3]!;
      const background = surface
        .slice(0, 3)
        .map((v) => v * alpha + desktop * (1 - alpha));
      assert(contrast(rgb(light['--live-text']!), background) >= 4.5);
      assert(contrast(rgb(light['--live-error']!), background) >= 4.5);
    }
    assert(
      contrast(
        rgb(light['--live-primary-text']!),
        rgb(light['--live-primary-bg']!),
      ) >= 4.5,
    );
  });
});
