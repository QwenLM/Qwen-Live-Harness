/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  LIVE_MESSAGES,
  displayLiveError,
  displayLiveMessage,
  liveMessage,
  liveText,
} from './messages.js';

describe('Qwen Live Harness display text catalogue', () => {
  it('uses the new product and command names without decoding legacy markers', () => {
    for (const language of ['en', 'zh-CN'] as const) {
      expect(liveText(language, 'ui.appName')).toBe('Qwen Live Harness');
      expect(liveText(language, 'cli.usage')).toContain('qwen-live-harness');
      const legacy = 'qwen-live-ui:{"key":"ui.settings","params":{}}';
      expect(displayLiveMessage(language, legacy)).toBe(legacy);
    }
    expect(liveMessage('ui.settings')).toMatch(/^qwen-live-harness-ui:/u);
    expect(liveText('en', 'ui.liveFeed')).toBe('Live Feed');
    for (const pair of Object.values(LIVE_MESSAGES)) {
      for (const text of Object.values(pair)) {
        expect(text).not.toMatch(
          /Qwen Live(?! Harness)|qwen-live(?!-harness)/u,
        );
      }
    }
  });

  it('keeps English and Chinese placeholders in sync for every text', () => {
    for (const pair of Object.values(LIVE_MESSAGES)) {
      expect(pair.en.trim()).not.toBe('');
      expect(pair['zh-CN'].trim()).not.toBe('');
      const placeholders = (value: string) =>
        (value.match(/\{\w+\}/g) ?? []).sort();
      expect(placeholders(pair.en)).toEqual(placeholders(pair['zh-CN']));
    }
  });

  it('renders stable messages and safe Electron wrappers without translating user content', () => {
    const marker = liveMessage('host.device.fallback', { index: 2 });
    expect(displayLiveMessage('zh-CN', marker)).toBe('麦克风 2');
    expect(
      displayLiveMessage(
        'en',
        `Error invoking remote method 'live:set-language': Error: ${marker}`,
      ),
    ).toBe('Microphone 2');
    expect(displayLiveMessage('zh-CN', `My named library ${marker}`)).toBe(
      `My named library ${marker}`,
    );
    expect(displayLiveMessage('zh-CN', 'User-supplied library')).toBe(
      'User-supplied library',
    );
    expect(
      displayLiveMessage(
        'zh-CN',
        'qwen-live-harness-ui:{"key":"unknown","params":{}}',
      ),
    ).toContain('unknown');
    expect(
      displayLiveMessage('zh-CN', 'camera_snapshot_resolution_unavailable'),
    ).toBe(liveText('zh-CN', 'code.camera_snapshot_resolution_unavailable'));
  });

  it('points config-file recovery at the standalone Qwen Live Harness initializer', () => {
    for (const language of ['en', 'zh-CN'] as const) {
      expect(liveText(language, 'host.config.inaccessible')).toContain(
        'qwen-live-harness init',
      );
      expect(liveText(language, 'host.config.inaccessible')).not.toMatch(
        /\bqwen live init\b|\bqwen-live init\b/u,
      );
    }
  });

  it('warns about sensitive debug recordings in both languages', () => {
    expect(liveText('en', 'cli.usage')).toMatch(/recordings.*conversation/iu);
    expect(liveText('zh-CN', 'cli.usage')).toMatch(/录音.*对话/u);
    expect(liveText('en', 'cli.debugNotice')).toMatch(
      /microphone.*screen.*camera.*requests.*replies/iu,
    );
    expect(liveText('zh-CN', 'cli.debugNotice')).toMatch(
      /麦克风.*屏幕.*摄像头.*请求.*回复/u,
    );
    expect(liveText('en', 'cli.debugNotice')).toMatch(/private.*sharing/iu);
    expect(liveText('zh-CN', 'cli.debugNotice')).toMatch(/分享.*私人信息/u);
  });

  it('bounds encoded details without emitting truncated JSON', () => {
    for (const detail of [
      'large '.repeat(2000),
      '\u0000'.repeat(300),
      '\\"\n'.repeat(300),
    ]) {
      const message = liveMessage('host.error.requiredMessage', {
        messageType: detail,
      });
      expect(message.length).toBeLessThanOrEqual(512);
      const parsed = JSON.parse(message.slice('qwen-live-harness-ui:'.length));
      for (const language of ['en', 'zh-CN'] as const) {
        expect(displayLiveMessage(language, message)).toBe(
          liveText(language, 'host.error.requiredMessage', parsed.params),
        );
        expect(displayLiveMessage(language, message)).not.toContain(
          'qwen-live-harness-ui:',
        );
      }
    }
  });

  it('resolves a nested owned message while retaining external detail', () => {
    const message = liveMessage('host.error.requiredMessage', {
      messageType: liveMessage('ui.settings'),
    });
    expect(displayLiveMessage('zh-CN', message)).toContain('“设置”');
  });

  it('renders known errors and never exposes raw exceptions or malformed markers', () => {
    for (const language of ['en', 'zh-CN'] as const) {
      const fallback = liveText(language, 'host.theme.saveFailed');
      for (const error of [
        new Error('private-token /private/config.json EACCES'),
        'private-token /private/config.json',
        { message: 'Error invoking remote method: private-token' },
        'qwen-live-harness-ui:{"key":"missing","params":{}}',
        'qwen-live-harness-ui:{"key":"ui.settings","params":null}',
        'quoted qwen-live-harness-ui:{"key":"ui.settings","params":{}}',
        null,
        undefined,
        0,
        {
          get message() {
            throw new Error('unreadable error');
          },
        },
      ]) {
        expect(displayLiveError(language, error, 'host.theme.saveFailed')).toBe(
          fallback,
        );
      }
      const owned = liveMessage('host.device.fallback', { index: 2 });
      expect(
        displayLiveError(language, new Error(owned), 'host.theme.saveFailed'),
      ).toBe(liveText(language, 'host.device.fallback', { index: 2 }));
      expect(
        displayLiveError(
          language,
          {
            message: `Error invoking remote method 'live:example': Error: ${owned}`,
          },
          'host.theme.saveFailed',
        ),
      ).toBe(liveText(language, 'host.device.fallback', { index: 2 }));
      expect(
        displayLiveError(
          language,
          'camera_snapshot_resolution_unavailable',
          'host.theme.saveFailed',
        ),
      ).toBe(liveText(language, 'code.camera_snapshot_resolution_unavailable'));
    }
  });

  it('truncates translated parameters without splitting Unicode code points', () => {
    const value = '设备📷🎧'.repeat(500);
    const message = liveMessage('host.error.requiredMessage', {
      messageType: value,
    });
    expect(message.length).toBeLessThanOrEqual(512);
    for (const language of ['en', 'zh-CN'] as const) {
      const rendered = displayLiveMessage(language, message);
      expect(rendered).toContain('…');
      expect(
        Array.from(rendered).some((character) => {
          const point = character.codePointAt(0)!;
          return point >= 0xd800 && point <= 0xdfff;
        }),
      ).toBe(false);
    }
  });
});
