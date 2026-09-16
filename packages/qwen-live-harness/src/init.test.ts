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
  detectAgents: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  refreshHost: vi.fn(),
  installHost: vi.fn(),
  registerCurrentRuntime: vi.fn(),
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
vi.mock('./agent-detector.js', () => ({ detectAgents: mocks.detectAgents }));
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

function answerSetupPrompts(cwd = '/tmp/harness-init-project'): void {
  mocks.prompt.mockImplementation(async (question: { message: string }) => {
    const answers = new Map<string, unknown>([
      [liveText('en', 'language.choose'), true],
      [liveText('en', 'init.defaultAgent'), 'qwen'],
      [liveText('en', 'init.qwenMode'), 'managed'],
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

beforeEach(() => {
  mocks.detectAgents.mockReset().mockReturnValue([
    {
      label: 'Qwen Code',
      name: 'qwen',
      command: '/usr/local/bin/qwen',
      args: ['--acp'],
      version: '1.0.0',
    },
  ]);
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
            case liveText('en', 'init.qwenMode'):
              return { value: 'managed' };
            case 'Which agent should be the default backend?':
              return { value: 'qwen' };
            case 'Use DASHSCOPE_API_KEY from the environment?':
              return { value: true };
            case 'DashScope Realtime API name:':
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
          case liveText('en', 'init.qwenMode'):
            return { value: 'managed' };
          case 'Which agent should be the default backend?':
            return { value: 'qwen' };
          case 'Use DASHSCOPE_API_KEY from the environment?':
            return { value: true };
          case 'DashScope Realtime API name:':
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
        (question) => question['message'] === 'DashScope Realtime API name:',
      );
    expect(modelQuestion).toMatchObject({
      type: 'text',
      initial: 'qwen3.5-omni-plus-realtime',
    });

    const serialized = mocks.writeFileSync.mock.calls[0]?.[1];
    expect(typeof serialized).toBe('string');
    expect(JSON.parse(String(serialized))).toMatchObject({
      language: 'en',
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
            [liveText(language, 'init.qwenMode'), 'managed'],
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
        (entry) => entry['type'] === 'confirm',
      )) {
        expect(question['yes']).toBe(liveText(language, 'init.yes'));
        expect(question['no']).toBe(liveText(language, 'init.no'));
      }
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

  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    'does not write config if prompt %s is cancelled',
    async (cancelAt) => {
      const answers = [
        true,
        'qwen',
        'managed',
        true,
        'fixture-model',
        true,
        'fixture-memory',
        '/tmp/live-language',
      ];
      let index = 0;
      mocks.prompt.mockImplementation(async () => {
        const current = index++;
        return current === cancelAt ? {} : { value: answers[current] };
      });
      await runInit();
      expect(mocks.writeFileSync).not.toHaveBeenCalled();
      expect(mocks.registerCurrentRuntime).not.toHaveBeenCalled();
      expect(index).toBe(cancelAt + 1);
    },
  );
});
