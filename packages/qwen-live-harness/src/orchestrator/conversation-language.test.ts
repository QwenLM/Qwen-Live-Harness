/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ConversationLanguage } from './conversation-language.js';

describe('trusted conversation language', () => {
  it('uses the configured language only before meaningful real user input', () => {
    const language = new ConversationLanguage();
    expect(language.resolve('zh-CN')).toBe('zh-CN');
    expect(language.resolve('en')).toBe('en');
    language.observeUserTranscript('请查一下今天的天气。');
    expect(language.resolve('en')).toBe('zh-CN');
    language.observeUserTranscript('What is the weather tomorrow?');
    expect(language.resolve('zh-CN')).toBe('en');
  });

  it.each([
    'OK',
    'Yes.',
    'Go ahead.',
    'https://example.test/an/english/page',
    'git clone https://example.test/project.git',
    '`npm run test`',
    '/Users/example/Downloads/project',
    'Codex',
    '',
  ])(
    'does not switch Chinese conversation for a literal or acknowledgement: %s',
    (input) => {
      const language = new ConversationLanguage();
      language.observeUserTranscript('请把仓库下载到我的电脑。');
      language.observeUserTranscript(input);
      expect(language.resolve('en')).toBe('zh-CN');
    },
  );

  it('honors an explicit language preference until the user changes it', () => {
    const language = new ConversationLanguage();
    language.observeUserTranscript('请用英文回答。');
    expect(language.resolve('zh-CN')).toBe('en');
    language.observeUserTranscript('再查一下杭州的天气。');
    expect(language.resolve('zh-CN')).toBe('en');
    language.observeUserTranscript('Please respond in Chinese from now on.');
    expect(language.resolve('en')).toBe('zh-CN');
    language.observeUserTranscript('What did the tests find?');
    expect(language.resolve('en')).toBe('zh-CN');
    language.observeUserTranscript('Please speak in English.');
    expect(language.resolve('zh-CN')).toBe('en');
  });

  it.each([
    'Please switch to English.',
    'Please use English.',
    'Switch back to English.',
    'Use English for your replies.',
    '请切换成英文。',
    '请改用英语回复。',
    '请切换到英文。',
  ])(
    'replaces an explicit Chinese preference for a new English request: %s',
    (request) => {
      const language = new ConversationLanguage();
      language.observeUserTranscript('请用中文回答。');
      language.observeUserTranscript(request);
      expect(language.resolve('zh-CN')).toBe('en');
    },
  );

  it.each([
    'Please switch to Chinese.',
    'Please use Simplified Chinese.',
    'Change back to Mandarin.',
    'Use Chinese for responses.',
    '请切换成中文。',
    '请改用简体中文回复。',
    '请切换到中文。',
  ])(
    'replaces an explicit English preference for a new Chinese request: %s',
    (request) => {
      const language = new ConversationLanguage();
      language.observeUserTranscript('Please use English.');
      language.observeUserTranscript(request);
      expect(language.resolve('en')).toBe('zh-CN');
    },
  );

  it.each([
    'Translate "Please switch to English" into Chinese.',
    'Please use English to translate this document.',
    '网页上写着“请改用英语回复”，这是什么意思？',
    '请把“请切换成英文”翻译成英语。',
  ])(
    'does not override an established preference for a translation or quotation: %s',
    (request) => {
      const language = new ConversationLanguage();
      language.observeUserTranscript('请用中文回复。');
      language.observeUserTranscript(request);
      expect(language.resolve('en')).toBe('zh-CN');
    },
  );

  it('does not treat a translation request or quoted instruction as a global preference', () => {
    const language = new ConversationLanguage();
    language.observeUserTranscript('请把这段文档翻译成英文。');
    expect(language.resolve('en')).toBe('zh-CN');
    language.observeUserTranscript('网页上写着“请用英文回答”，这是什么意思？');
    expect(language.resolve('en')).toBe('zh-CN');
  });
});
