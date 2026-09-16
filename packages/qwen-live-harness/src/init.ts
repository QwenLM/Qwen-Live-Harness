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
import { DEFAULT_PROACTIVE_CONFIG, type ProactiveConfig } from './config.js';
import { LiveHostInstaller } from './host/qwen-live-harness-host-installer.js';
import { initialMemoryConfig } from './memory/config.js';
import {
  resolveLiveDataDirectory,
  resolveLiveDiscoveryDirectory,
} from './paths.js';
import { registerCurrentRuntime } from './startup-registration.js';
import { promptPeerSetup } from './peer-setup.js';
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

export async function runInit(): Promise<void> {
  const configDirectory = resolveLiveDataDirectory();
  const configPath = join(configDirectory, 'config.json');
  let previousLanguage: LiveLanguage | undefined;
  if (existsSync(configPath)) {
    try {
      const existing: unknown = JSON.parse(
        readFileSync(configPath, 'utf8').replace(/^\uFEFF/u, ''),
      );
      if (
        existing &&
        typeof existing === 'object' &&
        'language' in existing &&
        isLiveLanguage(existing.language)
      )
        previousLanguage = existing.language;
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
  const confirmLabels = {
    yes: t('init.yes'),
    no: t('init.no'),
    yesOption: t('init.yesOption'),
    noOption: t('init.noOption'),
  };
  const selectLabels = {
    hint: t('init.selectHint'),
    warn: t('init.selectDisabled'),
  };
  console.log(`\n  ${t('init.title')}\n  ================\n`);

  // 1. Check existing config
  if (existsSync(configPath)) {
    const overwrite = await prompts({
      type: 'confirm',
      ...confirmLabels,
      name: 'value',
      message: t('init.overwrite'),
      initial: false,
    });
    if (!overwrite.value) {
      console.log(`\n  ${t('init.keep')}\n`);
      return;
    }
  }

  // 2. Scan for agents
  console.log(`  ${t('init.scanning')}\n`);
  const agents = detectAgents();
  if (agents.length === 0) {
    console.log(`  ${t('init.noAgents')}`);
    console.log(`  ${t('init.installAgent')}\n`);
    console.log(`  ${t('init.manualConfig', { path: configPath })}\n`);
    return;
  }
  for (const agent of agents) {
    console.log(`  ✓ ${agent.label} (${agent.version})`);
  }
  console.log();

  // 3. Select default backend
  const defaultChoice = await prompts({
    type: 'select',
    ...selectLabels,
    name: 'value',
    message: t('init.defaultAgent'),
    choices: agents.map((agent) => ({
      title: `${agent.label} (${agent.version})`,
      value: agent.name,
    })),
    initial: 0,
  });
  if (defaultChoice.value === undefined) {
    console.log(`\n  ${t('init.cancelled')}\n`);
    return;
  }

  // 4. Add additional backends
  let backends: Record<string, unknown>[] = [];
  const remaining = agents.filter((a) => a.name !== defaultChoice.value);
  let addMore = remaining.length > 0;
  const available = [...remaining];
  while (addMore && available.length > 0) {
    const more = await prompts({
      type: 'confirm',
      ...confirmLabels,
      name: 'value',
      message: t('init.addAgent', { count: available.length }),
      initial: false,
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
    backends.push(toRawBackend(agent, false));
    const idx = available.indexOf(agent);
    if (idx !== -1) available.splice(idx, 1);
  }

  // Build the default backend
  const defaultAgent = agents.find((a) => a.name === defaultChoice.value)!;
  backends.unshift(toRawBackend(defaultAgent, true));

  // M3 adds a separate qwen-code backend; existing ACP choices stay intact.
  if (agents.some((agent) => agent.name === 'qwen')) {
    const peers = await prompts({
      type: 'confirm',
      ...confirmLabels,
      name: 'value',
      message: t('peerSetup.optIn'),
      initial: false,
    });
    if (typeof peers.value !== 'boolean') {
      console.log(`\n  ${t('init.cancelled')}\n`);
      return;
    }
    if (peers.value) {
      const configured = await promptPeerSetup(backends, language, {
        enabled: true,
      });
      if (!configured) {
        console.log(`\n  ${t('init.cancelled')}\n`);
        return;
      }
      backends = configured;
    }
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
      type: 'confirm',
      ...confirmLabels,
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
    initial: 'qwen3.5-omni-plus-realtime',
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

  const memoryPrompt = await prompts({
    type: 'confirm',
    ...confirmLabels,
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

  // 7. Working directory
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
  const defaultCwd = resolve(
    selectedCwd === '~'
      ? homedir()
      : /^~[/\\]/u.test(selectedCwd)
        ? join(homedir(), selectedCwd.slice(2))
        : selectedCwd || process.cwd(),
  );

  // 8. Host app (macOS only)
  let hostStatus = t('init.hostSkipped');
  if (process.platform === 'darwin') {
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
        type: 'confirm',
        ...confirmLabels,
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

  // 9. Write config
  const config: RawConfig = {
    language,
    realtimeApiKey: apiKey,
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
  await registerCurrentRuntime({
    dataDir: configDirectory,
    discoveryDir: resolveLiveDiscoveryDirectory(),
    cwd: defaultCwd,
  });

  // 10. Done
  console.log(`\n  ✓ ${t('init.saved', { path: configPath })}`);
  console.log(`  ✓ ${t('init.backendSummary', { name: defaultAgent.label })}`);
  console.log(`  ✓ ${t('init.apiSummary', { name: realtimeModel })}`);
  console.log(
    `  ✓ ${t('init.memorySummary', { name: memoryPrompt.value ? memoryModel : t('init.disabled') })}`,
  );
  console.log(`  ✓ ${t('init.hostSummary', { status: hostStatus })}`);
  console.log(`\n  ${t('init.run')}\n`);
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
