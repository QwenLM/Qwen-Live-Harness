import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { liveText } from 'qwen-live-harness/i18n';
import {
  localizeUi,
  uiLabel,
  uiText,
  initialUiLanguage,
} from '../../renderer/ui-text.ts';
import { LiveView } from '../../renderer/live-view.ts';
import { SubagentsView } from '../../renderer/subagents-view.ts';
import type { LiveHostApi } from '../../shared/host-api.ts';
import type { SubagentsWindowApi } from '../../shared/subagents-api.ts';

describe('UI text localization', () => {
  it('uses system language for an initial load failure, then follows the acknowledged application language', () => {
    const dom = new JSDOM(
      '<!doctype html><html lang="en"><body><main></main><aside></aside></body></html>',
    );
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: dom.window.document,
    });
    Object.defineProperty(dom.window.navigator, 'languages', {
      configurable: true,
      value: ['zh-CN'],
    });
    Object.defineProperty(dom.window.navigator, 'language', {
      configurable: true,
      value: 'zh-CN',
    });
    const mainApi = {
      onSettingsDismiss: () => () => {},
      onOverlayOffset: () => () => {},
      dragOverlay: () => {},
      setOverlayLayout: () => {},
      setSettingsOpen: async () => {},
    } as unknown as LiveHostApi;
    const subApi = {
      setHover: () => {},
      setKeyboardHeld: () => {},
    } as unknown as SubagentsWindowApi;
    const root = dom.window.document.querySelector('main')!;
    const side = dom.window.document.querySelector('aside')!;
    const view = new LiveView(root, mainApi);
    const sub = new SubagentsView(side, subApi);
    try {
      assert.equal(initialUiLanguage(dom.window.document), 'zh-CN');
      assert.equal(
        root.querySelector('.setup-message')?.textContent,
        liveText('zh-CN', 'ui.connecting'),
      );
      view.showLoadFailure();
      sub.showLoadFailure();
      assert.equal(
        root.querySelector('.setup-message')?.textContent,
        liveText('zh-CN', 'ui.loadFailed'),
      );
      assert.equal(
        side.querySelector('.subagents-error')?.textContent,
        liveText('zh-CN', 'subagents.loadFailed'),
      );
      view.update({
        language: 'en',
        connection: 'ready',
        visualReady: false,
        live: {
          v: 1,
          available: false,
          state: 'unavailable',
          shortcut: 'Command+E',
        },
        permissions: {
          microphone: 'not_determined',
          camera: 'not_determined',
          screenRecording: 'not_determined',
          accessibility: 'not_determined',
        },
        selfChecks: {
          audioInput: false,
          audioOutput: false,
          appshot: false,
          globalShortcut: false,
        },
      });
      sub.update({ language: 'en', connected: false, mode: 'list' });
      assert.equal(
        root.querySelector('.setup-message')?.textContent,
        liveText('en', 'ui.allowRequired'),
      );
      assert.equal(
        root.querySelector('.setup-message')?.hasAttribute('role'),
        false,
      );
      assert.equal(
        side.querySelector('.subagents-error')?.textContent,
        liveText('en', 'subagents.loadFailed'),
      );
      assert.equal(dom.window.document.documentElement.lang, 'en');
    } finally {
      view.dispose();
      sub.dispose();
      dom.window.close();
      if (previous) Object.defineProperty(globalThis, 'document', previous);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('localizes the target itself and nested visible/accessibility text without replacing controls', () => {
    const dom = new JSDOM('<!doctype html><main></main>');
    try {
      const root = dom.window.document.querySelector('main')!;
      uiLabel(root, 'ui.controls');
      const button = uiLabel(
        uiText(dom.window.document.createElement('button'), 'ui.settings'),
        'ui.settings',
      );
      root.append(button);
      for (const language of ['zh-CN', 'en', 'zh-CN'] as const) {
        localizeUi(root, language);
        assert.equal(
          root.getAttribute('aria-label'),
          liveText(language, 'ui.controls'),
        );
        assert.equal(button.textContent, liveText(language, 'ui.settings'));
        assert.equal(button.title, liveText(language, 'ui.settings'));
        assert.equal(root.firstElementChild, button);
      }
      localizeUi(button, 'en');
      assert.equal(button.textContent, liveText('en', 'ui.settings'));
      assert.equal(
        button.getAttribute('aria-label'),
        liveText('en', 'ui.settings'),
      );
    } finally {
      dom.window.close();
    }
  });
});
