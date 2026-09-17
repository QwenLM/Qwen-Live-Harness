/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  refreshHost: vi.fn(),
  installHost: vi.fn(),
  registerCurrentRuntime: vi.fn(),
  detectAgents: vi.fn(),
}));

vi.mock('prompts', () => ({ default: mocks.prompt }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
    mkdirSync: mocks.mkdirSync,
    writeFileSync: mocks.writeFileSync,
    renameSync: mocks.renameSync,
  };
});
vi.mock('./agent-detector.js', () => ({
  detectAgents: mocks.detectAgents,
}));
vi.mock('./host/qwen-live-harness-host-installer.js', () => ({
  LiveHostInstaller: class {
    refresh() {
      return mocks.refreshHost();
    }
    ensureInstalled(...args: unknown[]) {
      return mocks.installHost(...args);
    }
  },
}));
vi.mock('./startup-registration.js', () => ({
  registerCurrentRuntime: mocks.registerCurrentRuntime,
}));

import { runInit } from './init.js';
import { liveText } from './i18n/messages.js';

const originalApiKey = process.env['DASHSCOPE_API_KEY'];
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function answerSetupPrompts(
  cwd = '/tmp/harness-init-project',
  international = false,
): void {
  mocks.prompt.mockImplementation(async (question: { message: string }) => {
    const answers = new Map<string, unknown>([
      [liveText('en', 'language.choose'), true],
      [liveText('en', 'init.overwrite'), true],
      [liveText('en', 'init.defaultAgent'), 'qwen'],
      [liveText('en', 'init.qwenMode'), 'acp'],
      [liveText('en', 'init.addAgent', { count: 1 }), false],
      [liveText('en', 'init.endpoint'), international],
      [liveText('en', 'init.useEnv', { name: 'DASHSCOPE_API_KEY' }), true],
      [liveText('en', 'init.apiName'), 'qwen3.5-omni-plus-realtime'],
      [liveText('en', 'init.memoryEnabled'), false],
      [liveText('en', 'init.cwd'), cwd],
      [liveText('en', 'init.hostInstall'), true],
    ]);
    if (!answers.has(question.message))
      throw new Error(`Unexpected prompt: ${question.message}`);
    return { value: answers.get(question.message) };
  });
}

function answerWithoutBackend(language: 'en' | 'zh-CN' = 'en'): void {
  mocks.prompt.mockImplementation(async (question: { message: string }) => {
    const answers = new Map<string, unknown>([
      [liveText('en', 'language.choose'), language === 'en'],
      [liveText(language, 'init.noAgentAction'), 'continue'],
      [liveText(language, 'init.defaultAgent'), null],
      [liveText(language, 'init.endpoint'), false],
      [liveText(language, 'init.useEnv', { name: 'DASHSCOPE_API_KEY' }), true],
      [liveText(language, 'init.apiName'), 'fixture-realtime'],
      [liveText(language, 'init.memoryEnabled'), true],
      [liveText(language, 'init.memoryModel'), 'fixture-memory'],
      [liveText(language, 'init.hostInstall'), true],
    ]);
    if (!answers.has(question.message))
      throw new Error(`Unexpected no-backend prompt: ${question.message}`);
    return { value: answers.get(question.message) };
  });
}

function enableAllYesNoPrompts(): void {
  mocks.existsSync.mockReturnValue(true);
  mocks.readFileSync.mockReturnValue('{"language":"en"}');
  mocks.refreshHost.mockResolvedValue({ state: 'missing' });
  mocks.detectAgents.mockReturnValue([
    {
      label: 'Qwen Code',
      name: 'qwen',
      command: '/synthetic/qwen',
      args: ['--acp'],
      version: '1.0',
    },
    {
      label: 'Gemini CLI',
      name: 'gemini',
      command: '/synthetic/gemini',
      args: ['--experimental-acp'],
      version: '1.0',
    },
  ]);
  answerSetupPrompts();
}

beforeEach(() => {
  mocks.prompt.mockReset();
  mocks.mkdirSync.mockReset();
  mocks.writeFileSync.mockReset();
  mocks.renameSync.mockReset();
  mocks.existsSync.mockReset().mockReturnValue(false);
  mocks.readFileSync.mockReset();
  mocks.refreshHost
    .mockReset()
    .mockResolvedValue({ state: 'installed', version: '0.3.0' });
  mocks.installHost
    .mockReset()
    .mockResolvedValue({ state: 'installed', version: '0.3.0' });
  mocks.registerCurrentRuntime.mockReset().mockResolvedValue(undefined);
  mocks.detectAgents.mockReset().mockReturnValue([
    {
      label: 'Qwen Code',
      name: 'qwen',
      command: '/usr/local/bin/qwen',
      args: ['--acp'],
      version: '1.0.0',
    },
  ]);
  Object.defineProperty(process, 'platform', {
    ...originalPlatform,
    value: 'darwin',
  });
  vi.stubEnv('QWEN_LIVE_HARNESS_DATA_DIR', '/synthetic/harness-init');
  vi.stubEnv('QWEN_LIVE_HARNESS_DISCOVERY_DIR', undefined);
  vi.stubEnv('QWEN_HOME', undefined);
  process.env['DASHSCOPE_API_KEY'] = 'sk-test';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', originalPlatform);
  if (originalApiKey === undefined) delete process.env['DASHSCOPE_API_KEY'];
  else process.env['DASHSCOPE_API_KEY'] = originalApiKey;
});

describe('runInit', () => {
  it.each(['managed', 'existing', 'acp'] as const)(
    'saves the selected Qwen connection mode %s as the sole default backend',
    async (mode) => {
      answerSetupPrompts();
      const normal = mocks.prompt.getMockImplementation()!;
      mocks.prompt.mockImplementation(async (question) => {
        if (question.message === liveText('en', 'init.qwenMode'))
          return { value: mode };
        if (question.message === liveText('en', 'init.localServeUrl'))
          return { value: ' http://127.0.0.1:5123 ' };
        if (question.message === liveText('en', 'peerSetup.serveToken'))
          return { value: ' test-token ' };
        return normal(question);
      });
      await runInit();
      const config = JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1]));
      const expected =
        mode === 'managed'
          ? {
              kind: 'qwen-code',
              managedServe: { command: '/usr/local/bin/qwen' },
              peerDiscovery: {
                qwenHome: join(homedir(), '.qwen'),
                reports: false,
              },
            }
          : mode === 'existing'
            ? {
                kind: 'qwen-code',
                baseUrl: 'http://127.0.0.1:5123',
                token: 'test-token',
                peerDiscovery: {
                  qwenHome: join(homedir(), '.qwen'),
                  reports: false,
                },
              }
            : { kind: 'acp', command: '/usr/local/bin/qwen', args: ['--acp'] };
      expect(config.backends).toEqual([
        { name: 'qwen', default: true, ...expected },
      ]);
      const prompts = mocks.prompt.mock.calls.map(
        ([question]) => question.message,
      );
      expect(prompts.includes(liveText('en', 'init.localServeUrl'))).toBe(
        mode === 'existing',
      );
      for (const key of [
        'optIn',
        'home',
        'reports',
        'controller',
        'backend',
      ] as const) {
        expect(prompts).not.toContain(liveText('en', `peerSetup.${key}`));
      }
      expect(config.backends[0].peerDiscovery?.controllerId).toBeUndefined();
      expect(config.backends[0].peerDiscovery?.controllerToken).toBeUndefined();
      expect(
        mocks.prompt.mock.calls.find(
          ([question]) => question.message === liveText('en', 'init.qwenMode'),
        )?.[0],
      ).toMatchObject({
        initial: 0,
        choices: [
          { value: 'managed' },
          { value: 'existing' },
          { value: 'acp' },
        ],
      });
    },
  );

  it.each(['init.localServeUrl', 'peerSetup.serveToken'] as const)(
    'does not save when existing serve %s is cancelled',
    async (field) => {
      answerSetupPrompts();
      const normal = mocks.prompt.getMockImplementation()!;
      mocks.prompt.mockImplementation(async (question) => {
        if (question.message === liveText('en', 'init.qwenMode'))
          return { value: 'existing' };
        if (question.message === liveText('en', field)) return {};
        if (question.message === liveText('en', 'init.localServeUrl'))
          return { value: 'http://127.0.0.1:5123' };
        return normal(question);
      });
      await runInit();
      expect(mocks.writeFileSync).not.toHaveBeenCalled();
      expect(mocks.registerCurrentRuntime).not.toHaveBeenCalled();
    },
  );

  it.each(['managed', 'existing'] as const)(
    'uses QWEN_HOME for read-only discovery in %s mode',
    async (mode) => {
      vi.stubEnv('QWEN_HOME', '/isolated/qwen-home');
      answerSetupPrompts();
      const normal = mocks.prompt.getMockImplementation()!;
      mocks.prompt.mockImplementation(async (question) => {
        if (question.message === liveText('en', 'init.qwenMode'))
          return { value: mode };
        if (question.message === liveText('en', 'init.localServeUrl'))
          return { value: 'http://localhost:4170' };
        if (question.message === liveText('en', 'peerSetup.serveToken'))
          return { value: '' };
        return normal(question);
      });
      await runInit();
      const config = JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1]));
      expect(config.backends[0].peerDiscovery).toEqual({
        qwenHome: '/isolated/qwen-home',
        reports: false,
      });
    },
  );

  it.each([
    'http://localhost:4170',
    'https://127.0.0.1:4170',
    'http://127.12.34.56:4170',
    'http://[::1]:4170',
  ])('accepts a local Qwen Serve URL %s', async (url) => {
    answerSetupPrompts();
    const normal = mocks.prompt.getMockImplementation()!;
    mocks.prompt.mockImplementation(async (question) => {
      if (question.message === liveText('en', 'init.qwenMode'))
        return { value: 'existing' };
      if (question.message === liveText('en', 'init.localServeUrl')) {
        expect(question.validate(url)).toBe(true);
        return { value: url };
      }
      if (question.message === liveText('en', 'peerSetup.serveToken'))
        return { value: '' };
      return normal(question);
    });
    await runInit();
    const config = JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1]));
    expect(config.backends[0].baseUrl).toBe(url);
  });

  it.each([
    'http://example.com:4170',
    'http://192.168.1.2:4170',
    'http://localhost.example.com:4170',
    'http://[::2]:4170',
    'ftp://localhost:4170',
    'http://user:password@localhost:4170',
    'http://localhost:4170?token=private',
    'http://localhost:4170#private',
    'not-a-url',
  ])(
    'rejects nonlocal or unsafe Qwen Serve URL %s without saving',
    async (url) => {
      answerSetupPrompts();
      const normal = mocks.prompt.getMockImplementation()!;
      mocks.prompt.mockImplementation(async (question) => {
        if (question.message === liveText('en', 'init.qwenMode'))
          return { value: 'existing' };
        if (question.message === liveText('en', 'init.localServeUrl')) {
          expect(question.validate(url)).toBe(
            liveText('en', 'init.invalidLocalServeUrl'),
          );
          return { value: url };
        }
        return normal(question);
      });
      await expect(runInit()).rejects.toThrow(
        liveText('en', 'init.invalidLocalServeUrl'),
      );
      expect(mocks.writeFileSync).not.toHaveBeenCalled();
      expect(mocks.renameSync).not.toHaveBeenCalled();
      expect(mocks.registerCurrentRuntime).not.toHaveBeenCalled();
    },
  );

  it('leaves other agents on ACP and does not offer Qwen-specific options', async () => {
    mocks.detectAgents.mockReturnValue([
      {
        label: 'Qoder',
        name: 'qoder',
        command: '/usr/local/bin/qodercli',
        args: ['--acp'],
        version: '1.0.0',
      },
    ]);
    answerSetupPrompts();
    const normal = mocks.prompt.getMockImplementation()!;
    mocks.prompt.mockImplementation(async (question) => {
      if (question.message === liveText('en', 'init.defaultAgent'))
        return { value: 'qoder' };
      return normal(question);
    });
    await runInit();
    const config = JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1]));
    expect(config.backends).toEqual([
      {
        name: 'qoder',
        kind: 'acp',
        command: '/usr/local/bin/qodercli',
        args: ['--acp'],
        default: true,
      },
    ]);
    expect(
      mocks.prompt.mock.calls.some(([question]) =>
        [
          liveText('en', 'init.qwenMode'),
          liveText('en', 'peerSetup.optIn'),
        ].includes(question.message),
      ),
    ).toBe(false);
  });

  it.each([
    [false, 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'],
    [true, 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime'],
  ] as const)(
    'asks for the agent, API key and model before saving its region (international: %s)',
    async (international, expected) => {
      answerSetupPrompts('/tmp/endpoint-test', international);
      await runInit({ source: true });
      const saved = JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1]));
      expect(saved.realtimeEndpoint).toBe(expected);
      const endpointIndex = mocks.prompt.mock.calls.findIndex(
        ([question]) => question.message === liveText('en', 'init.endpoint'),
      );
      const agentIndex = mocks.prompt.mock.calls.findIndex(
        ([question]) =>
          question.message === liveText('en', 'init.defaultAgent'),
      );
      const keyIndex = mocks.prompt.mock.calls.findIndex(
        ([question]) =>
          question.message ===
          liveText('en', 'init.useEnv', { name: 'DASHSCOPE_API_KEY' }),
      );
      const modelIndex = mocks.prompt.mock.calls.findIndex(
        ([question]) => question.message === liveText('en', 'init.apiName'),
      );
      expect(agentIndex).toBeGreaterThanOrEqual(0);
      expect(agentIndex).toBeLessThan(keyIndex);
      expect(keyIndex).toBeLessThan(modelIndex);
      expect(modelIndex).toBeLessThan(endpointIndex);
      expect(mocks.prompt.mock.calls[endpointIndex]?.[0]).toMatchObject({
        type: 'toggle',
        inactive: liveText('en', 'init.endpointBeijing'),
        active: liveText('en', 'init.endpointSingapore'),
        initial: false,
      });
      expect(console.log).toHaveBeenCalledWith(
        `\n  ${liveText('en', 'init.endpointKeyHint')}\n`,
      );
      expect(mocks.installHost).not.toHaveBeenCalled();
      expect(mocks.registerCurrentRuntime).not.toHaveBeenCalled();
    },
  );

  it.each(['en', 'zh-CN'] as const)(
    'keeps manual API key entry before the model and service-region questions in %s',
    async (language) => {
      vi.stubEnv('DASHSCOPE_API_KEY', undefined);
      vi.stubEnv('QWEN_LIVE_HARNESS_REALTIME_API_KEY', undefined);
      const t = (key: Parameters<typeof liveText>[1]) =>
        liveText(language, key);
      const answers = new Map<string, unknown>([
        [liveText('en', 'language.choose'), language === 'en'],
        [t('init.defaultAgent'), 'qwen'],
        [t('init.qwenMode'), 'acp'],
        [t('init.apiKey'), 'synthetic-region-test-key'],
        [t('init.apiName'), 'qwen3.5-omni-plus-realtime'],
        [t('init.endpoint'), true],
        [t('init.memoryEnabled'), false],
        [t('init.cwd'), '/tmp/region-order-test'],
      ]);
      mocks.prompt.mockImplementation(async (question: { message: string }) => {
        if (!answers.has(question.message))
          throw new Error(`Unexpected prompt: ${question.message}`);
        return { value: answers.get(question.message) };
      });
      await runInit({ source: true });
      expect(
        mocks.prompt.mock.calls.map(([question]) => question.message),
      ).toEqual([
        liveText('en', 'language.choose'),
        t('init.defaultAgent'),
        t('init.qwenMode'),
        t('init.apiKey'),
        t('init.apiName'),
        t('init.endpoint'),
        t('init.memoryEnabled'),
        t('init.cwd'),
      ]);
      expect(t('init.endpoint')).toContain('DASHSCOPE_API_KEY');
      expect(t('init.apiName')).toContain('DashScope Qwen Omni Realtime API');
      expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain(
        language === 'en'
          ? 'Applies to Realtime voice/vision'
          : '用于 Realtime 语音／视觉',
      );
      expect(
        JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1]))
          .realtimeEndpoint,
      ).toBe('wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime');
      expect(mocks.installHost).not.toHaveBeenCalled();
      expect(mocks.registerCurrentRuntime).not.toHaveBeenCalled();
    },
  );

  it.each([
    'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
    'https://dashscope-intl.aliyuncs.com',
  ])(
    'preserves Singapore as the initial selection for %s',
    async (endpoint) => {
      mocks.existsSync.mockReturnValue(true);
      mocks.readFileSync.mockReturnValue(
        JSON.stringify({ language: 'en', realtimeEndpoint: endpoint }),
      );
      answerSetupPrompts(undefined, true);
      await runInit({ source: true });
      const question = mocks.prompt.mock.calls.find(
        ([entry]) => entry.message === liveText('en', 'init.endpoint'),
      )?.[0];
      expect(question).toMatchObject({ type: 'toggle', initial: true });
      expect(
        JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1]))
          .realtimeEndpoint,
      ).toBe('wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime');
    },
  );

  it('warns before replacing a custom endpoint without printing its credentials', async () => {
    const endpoint = 'wss://private.example/realtime?token=private-token';
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({ language: 'en', realtimeEndpoint: endpoint }),
    );
    answerSetupPrompts();
    await runInit({ source: true });
    expect(console.log).toHaveBeenCalledWith(
      `\n  ${liveText('en', 'init.customEndpointHint')}\n`,
    );
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
      'private-token',
    );
    expect(
      JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1]))
        .realtimeEndpoint,
    ).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/realtime');
  });

  it('warns that an endpoint environment override takes precedence without exposing or changing its value', async () => {
    const override = 'wss://private.example/realtime?token=private-env-token';
    vi.stubEnv('QWEN_LIVE_HARNESS_REALTIME_ENDPOINT', override);
    answerSetupPrompts(undefined, true);
    await runInit({ source: true });
    expect(console.log).toHaveBeenCalledWith(
      `\n  ${liveText('en', 'init.endpointEnvOverride')}\n`,
    );
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
      'private-env-token',
    );
    expect(process.env['QWEN_LIVE_HARNESS_REALTIME_ENDPOINT']).toBe(override);
    expect(
      JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1]))
        .realtimeEndpoint,
    ).toBe('wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime');
  });

  it('uses left/right Yes/No toggles defaulting to Yes for every boolean confirmation', async () => {
    enableAllYesNoPrompts();
    await runInit();
    const keys = [
      liveText('en', 'init.overwrite'),
      liveText('en', 'init.addAgent', { count: 1 }),
      liveText('en', 'init.useEnv', { name: 'DASHSCOPE_API_KEY' }),
      liveText('en', 'init.memoryEnabled'),
      liveText('en', 'init.hostInstall'),
    ];
    for (const message of keys) {
      const question = mocks.prompt.mock.calls.find(
        ([entry]) => entry.message === message,
      )?.[0];
      expect(question).toMatchObject({
        type: 'toggle',
        active: 'Yes',
        inactive: 'No',
        initial: true,
      });
    }
    expect(
      mocks.prompt.mock.calls.some(([question]) => question.type === 'confirm'),
    ).toBe(false);
  });

  it.each([
    'overwrite',
    'addAgent',
    'endpoint',
    'useEnv',
    'memoryEnabled',
    'hostInstall',
  ] as const)(
    'does not write config or install Host when the %s toggle is cancelled',
    async (cancelAt) => {
      enableAllYesNoPrompts();
      const message =
        cancelAt === 'addAgent'
          ? liveText('en', 'init.addAgent', { count: 1 })
          : cancelAt === 'useEnv'
            ? liveText('en', 'init.useEnv', { name: 'DASHSCOPE_API_KEY' })
            : liveText('en', `init.${cancelAt}`);
      const answer = mocks.prompt.getMockImplementation()!;
      mocks.prompt.mockImplementation(async (question) =>
        question.message === message ? {} : answer(question),
      );
      await runInit();
      expect(
        mocks.prompt.mock.calls.some(
          ([question]) => question.message === message,
        ),
      ).toBe(true);
      expect(mocks.writeFileSync).not.toHaveBeenCalled();
      expect(mocks.renameSync).not.toHaveBeenCalled();
      expect(mocks.registerCurrentRuntime).not.toHaveBeenCalled();
      expect(mocks.installHost).not.toHaveBeenCalled();
    },
  );

  it.each(['en', 'zh-CN'] as const)(
    'configures source-only mode in %s without touching the installed Host or runtime registration',
    async (language) => {
      mocks.detectAgents.mockReturnValue([]);
      answerWithoutBackend(language);
      await runInit({ source: true });
      expect(
        JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1])),
      ).toMatchObject({
        language,
        backends: [],
        realtimeModel: 'fixture-realtime',
        memory: { enabled: true },
      });
      expect(mocks.refreshHost).not.toHaveBeenCalled();
      expect(mocks.installHost).not.toHaveBeenCalled();
      expect(mocks.registerCurrentRuntime).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        `\n  ${liveText(language, 'init.sourceHostHint')}`,
      );
      expect(console.log).toHaveBeenCalledWith(
        `\n  ${liveText(language, 'init.sourceRun')}\n`,
      );
      expect(console.log).not.toHaveBeenCalledWith(
        `\n  ${liveText(language, 'init.run')}\n`,
      );
    },
  );

  it('configures managed Qwen Serve in source setup without registering or installing Host', async () => {
    answerSetupPrompts();
    const normal = mocks.prompt.getMockImplementation()!;
    mocks.prompt.mockImplementation(async (question) => {
      if (question.message === liveText('en', 'init.qwenMode'))
        return { value: 'managed' };
      return normal(question);
    });
    await runInit({ source: true });
    expect(
      JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1])).backends,
    ).toEqual([
      {
        name: 'qwen',
        kind: 'qwen-code',
        managedServe: { command: '/usr/local/bin/qwen' },
        peerDiscovery: { qwenHome: join(homedir(), '.qwen'), reports: false },
        default: true,
      },
    ]);
    expect(mocks.refreshHost).not.toHaveBeenCalled();
    expect(mocks.installHost).not.toHaveBeenCalled();
    expect(mocks.registerCurrentRuntime).not.toHaveBeenCalled();
  });

  it('preserves backend selection in source setup without checking or installing Host', async () => {
    answerSetupPrompts();
    await runInit({ source: true });
    expect(
      JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1])).backends,
    ).toMatchObject([
      {
        name: 'qwen',
        kind: 'acp',
        command: '/usr/local/bin/qwen',
        default: true,
      },
    ]);
    expect(mocks.refreshHost).not.toHaveBeenCalled();
    expect(mocks.installHost).not.toHaveBeenCalled();
    expect(mocks.registerCurrentRuntime).not.toHaveBeenCalled();
  });

  it('keeps existing source config and gives the npm start instruction', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue('{"language":"en"}');
    mocks.prompt
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValueOnce({ value: false });
    await runInit({ source: true });
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.refreshHost).not.toHaveBeenCalled();
    expect(mocks.registerCurrentRuntime).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      `\n  ${liveText('en', 'init.sourceKeep')}\n`,
    );
  });

  it.each(['en', 'zh-CN'] as const)(
    'continues setup without any detected coding agent in %s',
    async (language) => {
      mocks.detectAgents.mockReturnValue([]);
      mocks.refreshHost.mockResolvedValue({ state: 'missing' });
      answerWithoutBackend(language);

      await runInit();

      const config = JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1]));
      expect(config).toMatchObject({
        language,
        backends: [],
        realtimeApiKey: 'sk-test',
        realtimeModel: 'fixture-realtime',
        memory: { enabled: true, updater: { model: 'fixture-memory' } },
        proactive: { enabled: true },
        visualInput: { mode: 'on-demand', source: 'screen' },
        defaultCwd: process.cwd(),
      });
      expect(mocks.installHost).toHaveBeenCalledExactlyOnceWith(false, {
        launch: false,
      });
      expect(mocks.registerCurrentRuntime).toHaveBeenCalledExactlyOnceWith({
        dataDir: '/synthetic/harness-init',
        discoveryDir: join(homedir(), '.qwen-live-harness'),
        cwd: process.cwd(),
      });
      const question = mocks.prompt.mock.calls.find(
        ([prompt]) =>
          prompt.message === liveText(language, 'init.noAgentAction'),
      )?.[0];
      expect(question).toMatchObject({
        type: 'select',
        initial: 0,
        choices: [
          {
            title: liveText(language, 'init.noBackendOption'),
            value: 'continue',
          },
          {
            title: liveText(language, 'init.installAgentFirst'),
            value: 'install',
          },
        ],
      });
      expect(console.log).toHaveBeenCalledWith(
        `\n  ${liveText(language, 'init.noBackendHint')}\n`,
      );
      expect(console.log).toHaveBeenCalledWith(
        `  ✓ ${liveText(language, 'init.noBackendSummary')}`,
      );
      expect(console.log).toHaveBeenCalledWith(
        `\n  ${liveText(language, 'init.run')}\n`,
      );
    },
  );

  it('allows declining a detected agent without asking for extra agents or a coding workspace', async () => {
    answerWithoutBackend();
    await runInit();
    const question = mocks.prompt.mock.calls.find(
      ([prompt]) => prompt.message === liveText('en', 'init.defaultAgent'),
    )?.[0];
    expect(question.choices).toEqual([
      { title: 'Qwen Code (1.0.0)', value: 'qwen' },
      {
        title: liveText('en', 'init.noBackendOption'),
        value: null,
        description: liveText('en', 'init.noBackendHint'),
      },
    ]);
    expect(
      JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1])).backends,
    ).toEqual([]);
  });

  it.each(['install', undefined])(
    'leaves setup untouched when the missing-agent action is %s',
    async (action) => {
      mocks.detectAgents.mockReturnValue([]);
      mocks.prompt
        .mockResolvedValueOnce({ value: true })
        .mockResolvedValueOnce({ value: action });
      await runInit();
      expect(mocks.prompt).toHaveBeenCalledTimes(2);
      expect(mocks.refreshHost).not.toHaveBeenCalled();
      expect(mocks.installHost).not.toHaveBeenCalled();
      expect(mocks.writeFileSync).not.toHaveBeenCalled();
      expect(mocks.renameSync).not.toHaveBeenCalled();
      expect(mocks.registerCurrentRuntime).not.toHaveBeenCalled();
      if (action === 'install')
        expect(console.log).toHaveBeenCalledWith(
          `\n  ${liveText('en', 'init.installAgent')}\n`,
        );
    },
  );

  it('installs without launching and registers desktop startup only after saving config', async () => {
    answerSetupPrompts();
    mocks.refreshHost.mockResolvedValue({ state: 'missing' });

    await runInit();

    expect(mocks.installHost).toHaveBeenCalledExactlyOnceWith(false, {
      launch: false,
    });
    expect(mocks.registerCurrentRuntime).toHaveBeenCalledExactlyOnceWith({
      dataDir: '/synthetic/harness-init',
      discoveryDir: join(homedir(), '.qwen-live-harness'),
      cwd: '/tmp/harness-init-project',
    });
    expect(mocks.renameSync.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.registerCurrentRuntime.mock.invocationCallOrder[0]!,
    );
  });

  it('registers the configured discovery directory independently of the data directory', async () => {
    answerSetupPrompts();
    vi.stubEnv('QWEN_LIVE_HARNESS_DISCOVERY_DIR', ' ~/harness-discovery ');

    await runInit();

    expect(mocks.registerCurrentRuntime).toHaveBeenCalledWith({
      dataDir: '/synthetic/harness-init',
      discoveryDir: join(homedir(), 'harness-discovery'),
      cwd: '/tmp/harness-init-project',
    });
    expect(mocks.installHost).not.toHaveBeenCalled();
  });

  it('expands the selected working directory before saving config and desktop registration', async () => {
    answerSetupPrompts(' ~/workspace/project ');

    await runInit();

    const expected = join(homedir(), 'workspace/project');
    expect(
      JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1])).defaultCwd,
    ).toBe(expected);
    expect(mocks.registerCurrentRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: expected }),
    );
  });

  it('does not register a runtime when the atomic config save fails', async () => {
    answerSetupPrompts();
    mocks.renameSync.mockImplementation(() => {
      throw new Error('rename failed');
    });

    await expect(runInit()).rejects.toThrow('rename failed');

    expect(mocks.registerCurrentRuntime).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalledWith(
      `\n  ${liveText('en', 'init.run')}\n`,
    );
  });

  it('does not report setup complete when runtime registration fails', async () => {
    answerSetupPrompts();
    mocks.registerCurrentRuntime.mockRejectedValue(
      new Error('registration failed'),
    );

    await expect(runInit()).rejects.toThrow('registration failed');

    expect(mocks.renameSync).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalledWith(
      `\n  ${liveText('en', 'init.run')}\n`,
    );
  });

  it('resolves the new data directory per invocation and ignores the legacy one', async () => {
    mocks.prompt.mockResolvedValue({});
    vi.stubEnv('QWEN_LIVE_DATA_DIR', '/synthetic/legacy-init');
    vi.stubEnv('QWEN_LIVE_HARNESS_DATA_DIR', ' ~/custom-harness-init ');
    await runInit();
    expect(mocks.existsSync).toHaveBeenCalledWith(
      join(homedir(), 'custom-harness-init', 'config.json'),
    );
    mocks.existsSync.mockClear();
    vi.stubEnv('QWEN_LIVE_HARNESS_DATA_DIR', undefined);
    await runInit();
    expect(mocks.existsSync).toHaveBeenCalledWith(
      join(homedir(), '.qwen-live-harness', 'config.json'),
    );
    expect(mocks.existsSync).not.toHaveBeenCalledWith(
      '/synthetic/legacy-init/config.json',
    );
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'asks for a consolidation model only when Memory is enabled (%s)',
    async (enabled) => {
      mocks.prompt.mockImplementation(
        async (question: { message?: string }) => {
          switch (question.message) {
            case liveText('en', 'language.choose'):
              return { value: true };
            case 'Which agent should be the default backend?':
              return { value: 'qwen' };
            case liveText('en', 'init.qwenMode'):
              return { value: 'acp' };
            case liveText('en', 'init.endpoint'):
              return { value: false };
            case 'Use DASHSCOPE_API_KEY from the environment?':
              return { value: true };
            case liveText('en', 'init.apiName'):
              return { value: 'qwen3.5-omni-plus-realtime' };
            case 'Enable Memory for cross-call recall?':
              return { value: enabled };
            case 'DashScope Memory consolidation model:':
              return { value: 'custom-memory-model' };
            case 'Default working directory for coding sessions:':
              return { value: '/tmp/memory-init' };
            default:
              throw new Error(`Unexpected prompt: ${question.message}`);
          }
        },
      );
      await runInit();
      expect(mocks.mkdirSync).toHaveBeenCalledWith('/synthetic/harness-init', {
        recursive: true,
        mode: 0o700,
      });
      expect(mocks.renameSync).toHaveBeenCalledWith(
        join('/synthetic/harness-init', 'config.json.tmp'),
        join('/synthetic/harness-init', 'config.json'),
      );
      const questions = mocks.prompt.mock.calls.map(
        ([question]) => question as Record<string, unknown>,
      );
      expect(
        questions.find(
          (question) =>
            question['message'] === 'Enable Memory for cross-call recall?',
        ),
      ).toMatchObject({ initial: true });
      const modelQuestion = questions.find(
        (question) =>
          question['message'] === 'DashScope Memory consolidation model:',
      );
      if (enabled)
        expect(modelQuestion).toMatchObject({ initial: 'qwen3.7-plus' });
      else expect(modelQuestion).toBeUndefined();
      const saved = JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1]));
      expect(saved.memory.enabled).toBe(enabled);
      expect(saved.memory.updater.model).toBe(
        enabled ? 'custom-memory-model' : 'qwen3.7-plus',
      );
      expect(saved.memory.observer).not.toHaveProperty('model');
    },
  );

  it('writes the selected API name without prompting for visual settings', async () => {
    mocks.prompt.mockImplementation(
      async (question: { message?: string }): Promise<{ value: unknown }> => {
        switch (question.message) {
          case liveText('en', 'language.choose'):
            return { value: true };
          case 'Which agent should be the default backend?':
            return { value: 'qwen' };
          case liveText('en', 'init.qwenMode'):
            return { value: 'acp' };
          case liveText('en', 'init.endpoint'):
            return { value: false };
          case 'Use DASHSCOPE_API_KEY from the environment?':
            return { value: true };
          case liveText('en', 'init.apiName'):
            return { value: 'qwen3.5-omni-plus-realtime' };
          case 'Enable Memory for cross-call recall?':
            return { value: true };
          case 'DashScope Memory consolidation model:':
            return { value: 'qwen3.7-plus' };
          case 'Default working directory for coding sessions:':
            return { value: '/tmp/qwen-live-harness-project' };
          default:
            throw new Error(`Unexpected prompt: ${question.message}`);
        }
      },
    );

    await runInit();

    const modelQuestion = mocks.prompt.mock.calls
      .map(([question]) => question as Record<string, unknown>)
      .find(
        (question) => question['message'] === liveText('en', 'init.apiName'),
      );
    expect(modelQuestion).toMatchObject({
      type: 'text',
      initial: 'qwen3.5-omni-plus-realtime',
    });

    const serialized = mocks.writeFileSync.mock.calls[0]?.[1];
    expect(typeof serialized).toBe('string');
    expect(JSON.parse(String(serialized))).toMatchObject({
      language: 'en',
      themeColor: 'iris',
      realtimeApiKey: 'sk-test',
      realtimeModel: 'qwen3.5-omni-plus-realtime',
      memory: {
        enabled: true,
        updater: { model: 'qwen3.7-plus' },
        observer: { enabled: false },
      },
      visualInput: {
        source: 'screen',
        mode: 'on-demand',
        fps: 1,
        cameraResolution: { width: 1280, height: 720 },
        cameraSnapshotResolution: 'native',
        liveResolution: { width: 1280, height: 720 },
        snapshotResolution: 'native',
      },
      proactive: {
        enabled: true,
        monitor: { sessionRecycleEvals: 60 },
        scheduler: {
          evalIntervalSec: 2,
          maxFailuresPerTask: 3,
          repeat: {
            cooldownSec: 3,
            maxWaitTtsSec: 30,
            clearBufferOnResume: true,
          },
        },
        vision: {
          fps: 1,
          windowSizeSec: 10,
          minEvalDurationSec: 0,
        },
        audio: { windowSizeSec: 60, minEvalDurationSec: 0 },
      },
      defaultCwd: '/tmp/qwen-live-harness-project',
    });
  });

  it.each(['en', 'zh-CN'] as const)(
    'localizes every fixed wizard prompt and saves %s after choosing language first',
    async (language) => {
      mocks.prompt.mockImplementation(
        async (question: { type: string; message: string }) => {
          if (question.message === liveText('en', 'language.choose')) {
            expect(console.log).not.toHaveBeenCalled();
            return { value: language === 'en' };
          }
          const choices = new Map<string, string | boolean>([
            [liveText(language, 'init.defaultAgent'), 'qwen'],
            [liveText(language, 'init.qwenMode'), 'acp'],
            [liveText(language, 'init.endpoint'), false],
            [
              liveText(language, 'init.useEnv', { name: 'DASHSCOPE_API_KEY' }),
              true,
            ],
            [liveText(language, 'init.apiName'), 'fixture-realtime'],
            [liveText(language, 'init.memoryEnabled'), true],
            [liveText(language, 'init.memoryModel'), 'fixture-memory'],
            [liveText(language, 'init.cwd'), '/tmp/live-language'],
          ]);
          expect(choices.has(question.message)).toBe(true);
          return { value: choices.get(question.message) };
        },
      );
      await runInit();
      expect(mocks.prompt.mock.calls[0]?.[0]).toMatchObject({
        type: 'toggle',
        inactive: '简体中文',
        active: 'English',
        initial: false,
      });
      const questions = mocks.prompt.mock.calls.map(
        ([question]) => question as Record<string, unknown>,
      );
      for (const question of questions.filter(
        (entry) =>
          entry['type'] === 'toggle' &&
          entry['message'] !== liveText('en', 'language.choose') &&
          entry['message'] !== liveText(language, 'init.endpoint'),
      )) {
        expect(question['active']).toBe(liveText(language, 'init.yes'));
        expect(question['inactive']).toBe(liveText(language, 'init.no'));
        expect(question['initial']).toBe(true);
      }
      expect(questions.some((question) => question['type'] === 'confirm')).toBe(
        false,
      );
      expect(
        questions.find((entry) => entry['type'] === 'select')?.['hint'],
      ).toBe(liveText(language, 'init.selectHint'));
      expect(
        JSON.parse(String(mocks.writeFileSync.mock.calls[0]?.[1])).language,
      ).toBe(language);
      expect(console.log).toHaveBeenCalledWith(
        `\n  ${liveText(language, 'init.run')}\n`,
      );
    },
  );

  it('uses the saved language for the initial choice and leaves existing config intact when overwrite is declined', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(
      '{"language":"en","realtimeApiKey":"private"}',
    );
    mocks.prompt
      .mockResolvedValueOnce({ value: false })
      .mockResolvedValueOnce({ value: false });
    await runInit();
    expect(mocks.prompt.mock.calls[0]?.[0]).toMatchObject({
      type: 'toggle',
      initial: true,
    });
    expect(mocks.prompt.mock.calls[1]?.[0]).toMatchObject({
      message: liveText('zh-CN', 'init.overwrite'),
    });
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.renameSync).not.toHaveBeenCalled();
    expect(mocks.registerCurrentRuntime).not.toHaveBeenCalled();
    expect(mocks.refreshHost).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])(
    'does not write config if prompt %s is cancelled',
    async (cancelAt) => {
      const answers = [
        [liveText('en', 'language.choose'), true],
        [liveText('en', 'init.defaultAgent'), 'qwen'],
        [liveText('en', 'init.qwenMode'), 'acp'],
        [liveText('en', 'init.useEnv', { name: 'DASHSCOPE_API_KEY' }), true],
        [liveText('en', 'init.apiName'), 'fixture-model'],
        [liveText('en', 'init.endpoint'), false],
        [liveText('en', 'init.memoryEnabled'), true],
        [liveText('en', 'init.memoryModel'), 'fixture-memory'],
        [liveText('en', 'init.cwd'), '/tmp/live-language'],
      ];
      let index = 0;
      mocks.prompt.mockImplementation(async (question: { message: string }) => {
        const current = index++;
        expect(question.message).toBe(answers[current]?.[0]);
        return current === cancelAt ? {} : { value: answers[current]?.[1] };
      });
      await runInit();
      expect(mocks.writeFileSync).not.toHaveBeenCalled();
      expect(mocks.registerCurrentRuntime).not.toHaveBeenCalled();
      expect(index).toBe(cancelAt + 1);
    },
  );
});
