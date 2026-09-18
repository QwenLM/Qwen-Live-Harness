/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen-live-harness init` — interactive setup wizard.
 *
 * Scans the user's machine for supported coding agents, lets them pick a
 * default backend, collects their DashScope API key, checks/installs the
 * Qwen Live Harness Host app, and writes ~/.qwen-live-harness/config.json.
 */

import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import prompts from 'prompts';
import { detectAgents, type DetectedAgent } from './agent-detector.js';
import {
  DEFAULT_PROACTIVE_CONFIG,
  DEFAULT_REALTIME_MODEL,
  type ProactiveConfig,
} from './config.js';
import { LiveHostInstaller } from './host/qwen-live-harness-host-installer.js';
import { initialMemoryConfig } from './memory/config.js';
import {
  resolveLiveDataDirectory,
  resolveLiveDiscoveryDirectory,
} from './paths.js';
import { registerCurrentRuntime } from './startup-registration.js';
import { isIP } from 'node:net';
import { resolveQwenHome } from './vendor/qwen-code-peer/registry.js';
import {
  displayLiveMessage,
  isLiveLanguage,
  liveText,
  type LiveLanguage,
  type LiveMessageKey,
  type LiveMessageParams,
} from './i18n/messages.js';

interface RawBackend extends Record<string, unknown> {
  name: string;
  kind: 'acp';
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  default?: boolean;
}

interface RawConfig {
  themeColor?: string;
  language?: LiveLanguage;
  realtimeApiKey?: string;
  realtimeEndpoint?: string;
  realtimeModel?: string;
  voice?: string;
  defaultCwd?: string;
  backends?: Record<string, unknown>[];
  port?: number;
  visualInput?: {
    source: 'screen' | 'camera';
    mode: 'on-demand' | 'live-feed';
    fps: number;
    cameraResolution: { width: number; height: number };
    cameraSnapshotResolution: 'native' | { width: number; height: number };
    liveResolution: { width: number; height: number };
    snapshotResolution: 'native' | { width: number; height: number };
  };
  proactive?: ProactiveConfig;
  memory?: ReturnType<typeof initialMemoryConfig>;
}

const REALTIME_ENDPOINTS = {
  beijing: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  singapore: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
};

function knownEndpointRegion(
  value: string | undefined,
): keyof typeof REALTIME_ENDPOINTS | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      !['https:', 'wss:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !['/', '/api-ws/v1/realtime', '/api-ws/v1/realtime/'].includes(
        url.pathname,
      )
    )
      return undefined;
    if (url.hostname === 'dashscope.aliyuncs.com') return 'beijing';
    if (url.hostname === 'dashscope-intl.aliyuncs.com') return 'singapore';
  } catch {
    // A custom or invalid existing endpoint is replaced only after an explicit choice.
  }
  return undefined;
}

export async function runInit(
  options: { source?: boolean } = {},
): Promise<void> {
  const configDirectory = resolveLiveDataDirectory();
  const configPath = join(configDirectory, 'config.json');
  let previousLanguage: LiveLanguage | undefined;
  let previousEndpoint: string | undefined;
  if (existsSync(configPath)) {
    try {
      const existing: unknown = JSON.parse(
        readFileSync(configPath, 'utf8').replace(/^\uFEFF/u, ''),
      );
      if (existing && typeof existing === 'object') {
        if ('language' in existing && isLiveLanguage(existing.language))
          previousLanguage = existing.language;
        if (
          'realtimeEndpoint' in existing &&
          typeof existing.realtimeEndpoint === 'string'
        )
          previousEndpoint = existing.realtimeEndpoint.trim();
      }
    } catch {
      /* The overwrite prompt still protects the existing file. */
    }
  }
  const languageAnswer = await prompts({
    type: 'toggle',
    name: 'value',
    message: liveText('en', 'language.choose'),
    inactive: liveText('zh-CN', 'language.chinese'),
    active: liveText('en', 'language.english'),
    initial: previousLanguage === 'en',
  });
  if (typeof languageAnswer.value !== 'boolean') return;
  const language: LiveLanguage = languageAnswer.value ? 'en' : 'zh-CN';
  const t = (key: LiveMessageKey, params?: LiveMessageParams) =>
    liveText(language, key, params);
  const toggleLabels = {
    active: t('init.yes'),
    inactive: t('init.no'),
  };
  const selectLabels = {
    hint: t('init.selectHint'),
    warn: t('init.selectDisabled'),
  };
  console.log(`\n  ${t('init.title')}\n  ================\n`);

  // 1. Check existing config
  if (existsSync(configPath)) {
    const overwrite = await prompts({
      type: 'toggle',
      ...toggleLabels,
      name: 'value',
      message: t('init.overwrite'),
      initial: true,
    });
    if (typeof overwrite.value !== 'boolean') {
      console.log(`\n  ${t('init.cancelled')}\n`);
      return;
    }
    if (!overwrite.value) {
      console.log(
        `\n  ${t(options.source ? 'init.sourceKeep' : 'init.keep')}\n`,
      );
      return;
    }
  }

  // 2. Scan for agents
  console.log(`  ${t('init.scanning')}\n`);
  const agents = detectAgents();
  let defaultAgent: DetectedAgent | undefined;
  if (agents.length === 0) {
    console.log(`  ${t('init.noAgents')}`);
    const action = await prompts({
      type: 'select',
      ...selectLabels,
      name: 'value',
      message: t('init.noAgentAction'),
      choices: [
        {
          title: t('init.noBackendOption'),
          value: 'continue',
          description: t('init.noBackendHint'),
        },
        { title: t('init.installAgentFirst'), value: 'install' },
      ],
      initial: 0,
    });
    if (action.value === 'install') {
      console.log(
        `\n  ${t(options.source ? 'init.sourceInstallAgent' : 'init.installAgent')}\n`,
      );
      return;
    }
    if (action.value !== 'continue') {
      console.log(`\n  ${t('init.cancelled')}\n`);
      return;
    }
  } else {
    for (const agent of agents) {
      console.log(`  ✓ ${agent.label} (${agent.version})`);
    }
    console.log();

    console.log(`  ${t('init.agentHint')}\n`);
    // 3. Select a default backend, or explicitly leave delegation disabled.
    const defaultChoice = await prompts({
      type: 'select',
      ...selectLabels,
      name: 'value',
      message: t('init.defaultAgent'),
      choices: [
        ...agents.map((agent) => ({
          title: `${agent.label} (${agent.version})`,
          value: agent.name,
        })),
        {
          title: t('init.noBackendOption'),
          value: null,
          description: t('init.noBackendHint'),
        },
      ],
      initial: 0,
    });
    if (defaultChoice.value !== null) {
      defaultAgent = agents.find((agent) => agent.name === defaultChoice.value);
      if (!defaultAgent) {
        console.log(`\n  ${t('init.cancelled')}\n`);
        return;
      }
    }
  }
  if (!defaultAgent) console.log(`\n  ${t('init.noBackendHint')}\n`);

  async function configureBackend(
    agent: DetectedAgent,
    isDefault: boolean,
  ): Promise<Record<string, unknown> | undefined> {
    if (agent.name !== 'qwen') return toRawBackend(agent, isDefault);
    const mode = await prompts({
      type: 'select',
      ...selectLabels,
      name: 'value',
      message: t('init.qwenMode'),
      choices: [
        { title: t('init.qwenManaged'), value: 'managed' },
        { title: t('init.qwenExisting'), value: 'existing' },
        { title: t('init.qwenAcp'), value: 'acp' },
      ],
      initial: 0,
    });
    if (mode.value === 'acp') return toRawBackend(agent, isDefault);
    const common = {
      name: agent.name,
      kind: 'qwen-code',
      peerDiscovery: { qwenHome: resolveQwenHome(), reports: false },
      ...(isDefault ? { default: true } : {}),
    };
    if (mode.value === 'managed') {
      console.log(`  ${t('init.qwenManagedHint')}\n`);
      return { ...common, managedServe: { command: agent.command } };
    }
    if (mode.value !== 'existing') return undefined;
    console.log(`  ${t('init.qwenExistingHint')}\n`);
    const url = await prompts({
      type: 'text',
      name: 'value',
      message: t('init.localServeUrl'),
      initial: 'http://127.0.0.1:4170',
      validate: (value: string) =>
        validServeUrl(value.trim()) || t('init.invalidLocalServeUrl'),
    });
    if (typeof url.value !== 'string') return undefined;
    if (!validServeUrl(url.value.trim()))
      throw new Error(t('init.invalidLocalServeUrl'));
    const token = await prompts({
      type: 'password',
      name: 'value',
      message: t('peerSetup.serveToken'),
    });
    if (typeof token.value !== 'string') return undefined;
    return {
      ...common,
      baseUrl: url.value.trim(),
      ...(token.value.trim() ? { token: token.value.trim() } : {}),
    };
  }

  const backends: Record<string, unknown>[] = [];
  if (defaultAgent) {
    const defaultBackend = await configureBackend(defaultAgent, true);
    if (!defaultBackend) {
      console.log(`\n  ${t('init.cancelled')}\n`);
      return;
    }
    backends.push(defaultBackend);
  }
  // 4. Add additional backends
  const remaining = defaultAgent
    ? agents.filter((agent) => agent !== defaultAgent)
    : [];
  let addMore = remaining.length > 0;
  const available = [...remaining];
  while (addMore && available.length > 0) {
    const more = await prompts({
      type: 'toggle',
      ...toggleLabels,
      name: 'value',
      message: t('init.addAgent', { count: available.length }),
      initial: true,
    });
    if (typeof more.value !== 'boolean') {
      console.log(`\n  ${t('init.cancelled')}\n`);
      return;
    }
    if (!more.value) {
      addMore = false;
      break;
    }
    const pick = await prompts({
      type: 'select',
      ...selectLabels,
      name: 'value',
      message: t('init.whichAgent'),
      choices: available.map((agent) => ({
        title: `${agent.label} (${agent.version})`,
        value: agent.name,
      })),
      initial: 0,
    });
    if (pick.value === undefined) {
      console.log(`\n  ${t('init.cancelled')}\n`);
      return;
    }
    const agent = available.find((a) => a.name === pick.value)!;
    const backend = await configureBackend(agent, false);
    if (!backend) {
      console.log(`\n  ${t('init.cancelled')}\n`);
      return;
    }
    backends.push(backend);
    const idx = available.indexOf(agent);
    if (idx !== -1) available.splice(idx, 1);
  }

  // 5. API key
  const envKeyName = process.env['DASHSCOPE_API_KEY']
    ? 'DASHSCOPE_API_KEY'
    : process.env['QWEN_LIVE_HARNESS_REALTIME_API_KEY']
      ? 'QWEN_LIVE_HARNESS_REALTIME_API_KEY'
      : undefined;
  const envKey = envKeyName ? process.env[envKeyName] : undefined;
  let apiKey: string | undefined;
  if (envKey) {
    const useEnv = await prompts({
      type: 'toggle',
      ...toggleLabels,
      name: 'value',
      message: t('init.useEnv', { name: envKeyName! }),
      initial: true,
    });
    if (typeof useEnv.value !== 'boolean') {
      console.log(`\n  ${t('init.cancelled')}\n`);
      return;
    }
    if (useEnv.value) {
      apiKey = envKey;
    } else {
      console.log(`  ${t('init.unsetEnv', { name: envKeyName! })}`);
    }
  }
  if (!apiKey) {
    const keyPrompt = await prompts({
      type: 'password',
      name: 'value',
      message: t('init.apiKey'),
      validate: (val: string) =>
        val.trim().length > 0 || t('init.apiKeyRequired'),
    });
    apiKey = keyPrompt.value?.trim();
  }
  if (!apiKey) {
    console.log(`\n  ${t('init.cancelledKey')}\n`);
    return;
  }

  // 6. Realtime API name
  const modelPrompt = await prompts({
    type: 'text',
    name: 'value',
    message: t('init.apiName'),
    initial: DEFAULT_REALTIME_MODEL,
    validate: (value: string) =>
      value.trim().length > 0 || t('init.apiNameRequired'),
  });
  const realtimeModel =
    typeof modelPrompt.value === 'string'
      ? modelPrompt.value.trim()
      : undefined;
  if (!realtimeModel) {
    console.log(`\n  ${t('init.cancelled')}\n`);
    return;
  }

  // 7. Select the service region for the API key and model just configured.
  const previousRegion = knownEndpointRegion(previousEndpoint);
  if (previousEndpoint && !previousRegion)
    console.log(`\n  ${t('init.customEndpointHint')}\n`);
  const endpointPrompt = await prompts({
    type: 'toggle',
    name: 'value',
    message: t('init.endpoint'),
    inactive: t('init.endpointBeijing'),
    active: t('init.endpointSingapore'),
    initial: previousRegion === 'singapore',
  });
  if (typeof endpointPrompt.value !== 'boolean') {
    console.log(`\n  ${t('init.cancelled')}\n`);
    return;
  }
  const realtimeEndpoint = endpointPrompt.value
    ? REALTIME_ENDPOINTS.singapore
    : REALTIME_ENDPOINTS.beijing;
  if (process.env['QWEN_LIVE_HARNESS_REALTIME_ENDPOINT']?.trim())
    console.log(`\n  ${t('init.endpointEnvOverride')}\n`);
  console.log(`\n  ${t('init.endpointKeyHint')}\n`);

  // 8. Memory
  const memoryPrompt = await prompts({
    type: 'toggle',
    ...toggleLabels,
    name: 'value',
    message: t('init.memoryEnabled'),
    initial: true,
  });
  if (typeof memoryPrompt.value !== 'boolean') {
    console.log(`\n  ${t('init.cancelled')}\n`);
    return;
  }
  let memoryModel = 'qwen3.7-plus';
  if (memoryPrompt.value) {
    const memoryModelPrompt = await prompts({
      type: 'text',
      name: 'value',
      message: t('init.memoryModel'),
      initial: memoryModel,
      validate: (value: string) =>
        (value.trim().length > 0 &&
          value.trim().length <= 256 &&
          !/\p{C}/u.test(value)) ||
        t('init.modelRequired'),
    });
    if (
      typeof memoryModelPrompt.value !== 'string' ||
      !memoryModelPrompt.value.trim()
    ) {
      console.log(`\n  ${t('init.cancelled')}\n`);
      return;
    }
    memoryModel = memoryModelPrompt.value.trim();
  }

  // 9. A coding workspace is only needed when delegation is enabled.
  let defaultCwd = resolve(process.cwd());
  if (defaultAgent) {
    const cwdPrompt = await prompts({
      type: 'text',
      name: 'value',
      message: t('init.cwd'),
      initial: process.cwd(),
    });
    if (cwdPrompt.value === undefined) {
      console.log(`\n  ${t('init.cancelled')}\n`);
      return;
    }
    const selectedCwd = String(cwdPrompt.value).trim();
    defaultCwd = resolve(
      selectedCwd === '~'
        ? homedir()
        : /^~[/\\]/u.test(selectedCwd)
          ? join(homedir(), selectedCwd.slice(2))
          : selectedCwd || process.cwd(),
    );
  }

  // 10. Host app (macOS only)
  let hostStatus = t('init.hostSkipped');
  if (options.source) {
    console.log(`\n  ${t('init.sourceHostHint')}`);
    hostStatus = t('init.hostSource');
  } else if (process.platform === 'darwin') {
    console.log(`\n  ${t('init.hostChecking')}`);
    const installer = new LiveHostInstaller();
    const status = await installer.refresh();
    if (status.state === 'installed') {
      console.log(
        `  ✓ ${t('init.hostInstalled', { version: status.version! })}`,
      );
      hostStatus = t('init.hostReady');
    } else if (status.state === 'missing') {
      const install = await prompts({
        type: 'toggle',
        ...toggleLabels,
        name: 'value',
        message: t('init.hostInstall'),
        initial: true,
      });
      if (typeof install.value !== 'boolean') {
        console.log(`\n  ${t('init.cancelled')}\n`);
        return;
      }
      if (install.value) {
        console.log(`  ${t('init.hostInstalling')}`);
        const result = await installer.ensureInstalled(false, {
          launch: false,
        });
        if (result.state === 'installed') {
          console.log(
            `  ✓ ${t('init.hostInstalled', { version: result.version! })}`,
          );
          hostStatus = t('init.hostReady');
        } else {
          console.log(
            `  ✗ ${t('init.hostInstallFailed', { detail: result.message ? displayLiveMessage(language, result.message) : t('init.unknownError') })}`,
          );
          hostStatus = t('init.hostFailed');
        }
      } else {
        hostStatus = t('init.hostSkipped');
      }
    } else {
      console.log(
        `  ! ${t('init.hostCheckFailed', { detail: status.message ? displayLiveMessage(language, status.message) : t('init.unknownError') })}`,
      );
      hostStatus = t('init.hostError');
    }
  } else {
    console.log(`\n  ${t('init.hostMacOnly')}`);
    hostStatus = t('init.hostUnsupported');
  }

  // 11. Write config
  const config: RawConfig = {
    themeColor: 'iris',
    language,
    realtimeApiKey: apiKey,
    realtimeEndpoint,
    realtimeModel,
    visualInput: {
      source: 'screen',
      mode: 'on-demand',
      fps: 1,
      cameraResolution: { width: 1280, height: 720 },
      cameraSnapshotResolution: 'native',
      liveResolution: { width: 1280, height: 720 },
      snapshotResolution: 'native',
    },
    proactive: DEFAULT_PROACTIVE_CONFIG,
    memory: initialMemoryConfig(memoryPrompt.value, memoryModel),
    defaultCwd,
    backends,
  };

  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  const tmpPath = configPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
  renameSync(tmpPath, configPath);

  // Desktop startup must only see this runtime after its config is complete.
  // This registers the executable; it does not launch the Host or daemon.
  if (!options.source)
    await registerCurrentRuntime({
      dataDir: configDirectory,
      discoveryDir: resolveLiveDiscoveryDirectory(),
      cwd: defaultCwd,
    });

  // 12. Done
  console.log(`\n  ✓ ${t('init.saved', { path: configPath })}`);
  console.log(
    `  ✓ ${defaultAgent ? t('init.backendSummary', { name: defaultAgent.label }) : t('init.noBackendSummary')}`,
  );
  console.log(`  ✓ ${t('init.apiSummary', { name: realtimeModel })}`);
  console.log(
    `  ✓ ${t('init.endpointSummary', { endpoint: realtimeEndpoint })}`,
  );
  console.log(
    `  ✓ ${t('init.memorySummary', { name: memoryPrompt.value ? memoryModel : t('init.disabled') })}`,
  );
  console.log(`  ✓ ${t('init.hostSummary', { status: hostStatus })}`);
  console.log(`\n  ${t(options.source ? 'init.sourceRun' : 'init.run')}\n`);
  if (backends.some((backend) => backend['kind'] === 'qwen-code'))
    console.log(t('peerSetup.initHint'));
}

function toRawBackend(agent: DetectedAgent, isDefault: boolean): RawBackend {
  return {
    name: agent.name,
    kind: 'acp',
    command: agent.command,
    args: agent.args,
    ...(Object.keys(agent.env ?? {}).length > 0 ? { env: agent.env } : {}),
    ...(isDefault ? { default: true } : {}),
  };
}

function validServeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.hostname === 'localhost' ||
        url.hostname === '[::1]' ||
        (isIP(url.hostname) === 4 && url.hostname.startsWith('127.')))
    );
  } catch {
    return false;
  }
}
