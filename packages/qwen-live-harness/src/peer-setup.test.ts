/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  liveText,
  type LiveLanguage,
  type LiveMessageKey,
} from './i18n/messages.js';
import { loadConfig } from './config.js';
import { promptPeerSetup, runPeerSetup } from './peer-setup.js';

const { prompt } = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock('prompts', () => ({ default: prompt }));

let directory: string;
let configPath: string;
let qwenHome: string;
const token = `qpc_${'b'.repeat(64)}`;
const acp = {
  name: 'qwen',
  kind: 'acp',
  command: 'qwen',
  args: ['--acp'],
  env: { PRESERVE: 'yes' },
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'live-peer-setup-'));
  configPath = join(directory, 'config.json');
  qwenHome = join(directory, 'local qwen');
  prompt.mockReset();
  vi.stubEnv('QWEN_LIVE_HARNESS_DATA_DIR', directory);
  vi.stubEnv('QWEN_LIVE_HARNESS_BACKENDS', undefined);
  vi.stubEnv('QWEN_LIVE_HARNESS_SERVE_URL', undefined);
  vi.stubEnv('QWEN_SERVER_TOKEN', undefined);
  vi.stubEnv('SETUP_TEST_GRANT', token);
  vi.stubEnv('DASHSCOPE_API_KEY', undefined);
  vi.stubEnv('QWEN_LIVE_HARNESS_REALTIME_API_KEY', undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function answers(
  overrides: Partial<Record<LiveMessageKey, unknown>> = {},
  language: LiveLanguage = 'en',
) {
  const values: Partial<Record<LiveMessageKey, unknown>> = {
    'peerSetup.backend': -1,
    'peerSetup.enabled': true,
    'peerSetup.name': 'qwen-peers',
    'peerSetup.url': 'http://127.0.0.1:4170',
    'peerSetup.serveToken': 'private-serve-token',
    'peerSetup.home': qwenHome,
    'peerSetup.reports': true,
    'peerSetup.controller': 'env',
    'peerSetup.tokenEnv': 'SETUP_TEST_GRANT',
    'peerSetup.token': token,
    ...overrides,
  };
  prompt.mockImplementation(async (question: { message: string }) => {
    const key = (Object.keys(values) as LiveMessageKey[]).find(
      (key) => liveText(language, key) === question.message,
    );
    if (!key) throw new Error(`Unexpected prompt ${question.message}`);
    return values[key] === undefined ? {} : { value: values[key] };
  });
}

async function save(backends: unknown = [acp]) {
  const config = {
    language: 'en',
    realtimeApiKey: 'private-model-key',
    defaultCwd: '/user/workspace',
    visualInput: { source: 'screen', fps: 1 },
    futureUserSetting: { nested: ['keep', 'verbatim'] },
    backends,
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o640 });
  return config;
}

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath, 'utf8'));
}

function output() {
  return vi.mocked(console.log).mock.calls.flat().join('\n');
}

it('adds discovery to the selected managed service without adding a backend', async () => {
  answers();
  const backend = {
    name: 'qwen',
    kind: 'qwen-code',
    default: true,
    managedServe: { command: 'qwen' },
  };
  const configured = await promptPeerSetup([backend], 'en', {
    enabled: true,
    backendIndex: 0,
  });
  expect(configured).toHaveLength(1);
  expect(configured?.[0]).toMatchObject({
    ...backend,
    peerDiscovery: { qwenHome, reports: true },
  });
  expect(prompt.mock.calls.map(([question]) => question.message)).not.toContain(
    liveText('en', 'peerSetup.backend'),
  );
});

describe('incremental peer setup', () => {
  it.each(['en', 'zh-CN'] as const)(
    'preserves config and the ACP default while adding a separate backend (%s)',
    async (language) => {
      const original = await save();
      answers({}, language);
      await runPeerSetup(language);
      const written = await readConfig();
      expect(written).toEqual({
        ...original,
        backends: [
          { ...acp, default: true },
          {
            name: 'qwen-peers',
            kind: 'qwen-code',
            baseUrl: 'http://127.0.0.1:4170',
            token: 'private-serve-token',
            peerDiscovery: {
              qwenHome,
              reports: true,
              controllerTokenEnv: 'SETUP_TEST_GRANT',
            },
          },
        ],
      });
      expect(loadConfig().backends[0]).toMatchObject({
        kind: 'acp',
        isDefault: true,
        env: acp.env,
      });
      expect(loadConfig().backends[1]).toMatchObject({
        kind: 'qwen-code',
        isDefault: false,
        peerDiscovery: { controllerToken: token },
      });
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(directory)).toEqual(['config.json']);
      for (const secret of [token, 'private-serve-token', 'private-model-key'])
        expect(output()).not.toContain(secret);
    },
  );

  it('updates an existing qwen-code backend without changing endpoint, authentication, other backends or defaults', async () => {
    const backend = {
      name: 'daemon',
      kind: 'qwen-code',
      serveUrl: 'https://example.invalid/qwen',
      token: 'retained-auth',
      extra: { future: true },
    };
    const original = await save([{ ...acp, default: true }, backend]);
    answers({ 'peerSetup.backend': 1 });
    await runPeerSetup('en');
    expect(await readConfig()).toEqual({
      ...original,
      backends: [
        { ...acp, default: true },
        {
          ...backend,
          peerDiscovery: {
            qwenHome,
            reports: true,
            controllerTokenEnv: 'SETUP_TEST_GRANT',
          },
        },
      ],
    });
    expect(
      prompt.mock.calls.some(
        ([question]) =>
          question.message === liveText('en', 'peerSetup.serveToken'),
      ),
    ).toBe(false);
  });

  it('can disable peers without removing the REST backend or its credentials', async () => {
    const backend = {
      name: 'daemon',
      kind: 'qwen-code',
      baseUrl: 'http://127.0.0.1:4170',
      token: 'preserve',
      default: true,
      peerDiscovery: { qwenHome, reports: true, controllerToken: token },
    };
    await save([backend]);
    answers({ 'peerSetup.backend': 0, 'peerSetup.enabled': false });
    await runPeerSetup('en');
    const { peerDiscovery: _peer, ...expected } = backend;
    expect((await readConfig())['backends']).toEqual([expected]);
    expect(loadConfig().backends[0]).toMatchObject({
      kind: 'qwen-code',
      token: 'preserve',
    });
    expect(await readdir(directory)).toEqual(['config.json']);
  });

  it('repairs a missing controller environment reference by choosing read-only mode', async () => {
    await save([
      {
        name: 'daemon',
        kind: 'qwen-code',
        peerDiscovery: {
          qwenHome,
          controllerTokenEnv: 'ABSENT_SETUP_TEST_GRANT',
        },
      },
    ]);
    vi.stubEnv('ABSENT_SETUP_TEST_GRANT', undefined);
    answers({ 'peerSetup.backend': 0, 'peerSetup.controller': 'none' });
    await runPeerSetup('en');
    expect(loadConfig().backends[0]).toMatchObject({
      peerDiscovery: { qwenHome, reports: true },
    });
    expect(JSON.stringify(await readConfig())).not.toContain('controllerToken');
  });

  it('does not rewrite an unchanged configuration or create Qwen resources', async () => {
    await save([
      {
        name: 'daemon',
        kind: 'qwen-code',
        peerDiscovery: {
          qwenHome,
          reports: true,
          controllerTokenEnv: 'SETUP_TEST_GRANT',
        },
      },
    ]);
    const before = await readFile(configPath, 'utf8');
    answers({ 'peerSetup.backend': 0, 'peerSetup.controller': 'keep' });
    await runPeerSetup('en');
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect((await stat(configPath)).mode & 0o777).toBe(0o640);
    expect(await readdir(directory)).toEqual(['config.json']);
  });

  it('preserves legacy endpoint and token when enabling peers', async () => {
    const config = {
      realtimeApiKey: 'kept-model',
      serveUrl: 'http://127.0.0.1:4230',
      serveToken: 'kept-server',
      future: true,
    };
    await writeFile(configPath, JSON.stringify(config));
    answers({ 'peerSetup.backend': 0, 'peerSetup.controller': 'none' });
    await runPeerSetup('en');
    expect(await readConfig()).toMatchObject({
      ...config,
      backends: [
        {
          name: 'qwen-code',
          kind: 'qwen-code',
          default: true,
          baseUrl: config.serveUrl,
          token: config.serveToken,
          peerDiscovery: { qwenHome },
        },
      ],
    });
  });

  it('persists a pasted token only through hidden input and never prints it', async () => {
    await save();
    answers({ 'peerSetup.controller': 'token' });
    await runPeerSetup('en');
    expect(loadConfig().backends[1]).toMatchObject({
      peerDiscovery: { controllerToken: token },
    });
    expect(
      prompt.mock.calls.find(
        ([question]) => question.message === liveText('en', 'peerSetup.token'),
      )?.[0].type,
    ).toBe('password');
    expect(output()).not.toContain(token);
  });

  it.each([
    'peerSetup.backend',
    'peerSetup.enabled',
    'peerSetup.name',
    'peerSetup.url',
    'peerSetup.serveToken',
    'peerSetup.home',
    'peerSetup.reports',
    'peerSetup.controller',
    'peerSetup.tokenEnv',
  ] as const)(
    'cancel at %s leaves original bytes and permissions untouched',
    async (key) => {
      await save();
      const before = await readFile(configPath, 'utf8');
      answers({ [key]: undefined });
      await runPeerSetup('en');
      expect(await readFile(configPath, 'utf8')).toBe(before);
      expect((await stat(configPath)).mode & 0o777).toBe(0o640);
      expect(await readdir(directory)).toEqual(['config.json']);
    },
  );

  it('detects concurrent file edits and removes only its own temporary file', async () => {
    await save();
    answers();
    const answer = prompt.getMockImplementation()!;
    const external = JSON.stringify({
      editedByUser: true,
      token: 'keep-external-secret',
    });
    prompt.mockImplementation(async (question) => {
      if (question.message === liveText('en', 'peerSetup.tokenEnv'))
        await writeFile(configPath, external);
      return answer(question);
    });
    await expect(runPeerSetup('en')).rejects.toThrow(
      liveText('en', 'peerSetup.concurrentEdit'),
    );
    expect(await readFile(configPath, 'utf8')).toBe(external);
    expect(await readdir(directory)).toEqual(['config.json']);
    expect(output()).not.toContain('keep-external-secret');
  });

  it('rejects environment backend overrides before asking or writing', async () => {
    await save();
    const before = await readFile(configPath, 'utf8');
    vi.stubEnv('QWEN_LIVE_HARNESS_BACKENDS', '["private-controller"]');
    await expect(runPeerSetup('en')).rejects.toThrow(
      liveText('en', 'peerSetup.envOverride'),
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('serializes two competing setup saves and refuses the stale result', async () => {
    await save();
    answers();
    const answer = prompt.getMockImplementation()!;
    let homeNumber = 0;
    let ready = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    prompt.mockImplementation(async (question) => {
      if (question.message === liveText('en', 'peerSetup.home'))
        return { value: `${qwenHome}-${++homeNumber}` };
      if (question.message === liveText('en', 'peerSetup.tokenEnv')) {
        if (++ready === 2) release();
        await bothReady;
      }
      return answer(question);
    });
    const results = await Promise.allSettled([
      runPeerSetup('en'),
      runPeerSetup('en'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failed = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect([
      liveText('en', 'peerSetup.saveBusy'),
      liveText('en', 'peerSetup.concurrentEdit'),
    ]).toContain(failed.reason.message);
    expect(loadConfig().backends).toHaveLength(2);
    expect(await readdir(directory)).toEqual(['config.json']);
  });

  it('does not remove a save lock owned by another setup process', async () => {
    await save();
    const before = await readFile(configPath, 'utf8');
    const lockPath = `${configPath}.peer-setup.lock`;
    await writeFile(lockPath, String(process.pid), { mode: 0o600 });
    answers();
    await expect(runPeerSetup('en')).rejects.toThrow(
      liveText('en', 'peerSetup.saveBusy'),
    );
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(await readFile(lockPath, 'utf8')).toBe(String(process.pid));
  });

  it('fails safely for malformed config and symbolic links', async () => {
    await writeFile(configPath, '{"private-key"');
    await expect(runPeerSetup('en')).rejects.toThrow(
      liveText('en', 'peerSetup.invalidConfig'),
    );
    await rm(configPath);
    const target = join(directory, 'user-config.json');
    await writeFile(target, JSON.stringify({ backends: [acp] }));
    await symlink(target, configPath);
    await expect(runPeerSetup('en')).rejects.toThrow(
      liveText('en', 'peerSetup.configRequired'),
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it('allows no-op decline without adding a backend, even on an unsupported platform', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    await save();
    const before = await readFile(configPath, 'utf8');
    answers({ 'peerSetup.enabled': false });
    await runPeerSetup('en');
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('rejects invalid env input without logging its value or touching config', async () => {
    await save();
    const before = await readFile(configPath, 'utf8');
    vi.stubEnv('SETUP_TEST_GRANT', 'bad-sensitive-token');
    answers();
    await expect(runPeerSetup('en')).rejects.toThrow(
      liveText('en', 'peerSetup.invalidEnv'),
    );
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(output()).not.toContain('bad-sensitive-token');
  });

  it('quotes the selected Qwen home in copyable grant instructions', async () => {
    qwenHome = join(directory, "home's $(not-a-command)");
    await save();
    answers({ 'peerSetup.controller': 'none' });
    await runPeerSetup('en');
    expect(output()).toContain("'\"'\"'");
    expect(await readdir(directory)).toEqual(['config.json']);
  });

  it("does not change the caller's backend objects during fresh init", async () => {
    const original = structuredClone([acp]);
    answers();
    const result = await promptPeerSetup(original, 'en', { enabled: true });
    expect(result).toHaveLength(2);
    expect(original).toEqual([acp]);
  });
});
