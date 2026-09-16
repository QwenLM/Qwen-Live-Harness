/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import prompts from 'prompts';
import { parseBackends } from './config.js';
import { resolveLiveDataDirectory } from './paths.js';
import { liveText, type LiveLanguage } from './i18n/messages.js';
import { resolveQwenHome } from './vendor/qwen-code-peer/registry.js';

type RawBackend = Record<string, unknown> & {
  name?: unknown;
  kind?: unknown;
  default?: unknown;
  peerDiscovery?: unknown;
};
type PeerSettings = {
  qwenHome: string;
  reports: boolean;
  controllerToken?: string;
  controllerTokenEnv?: string;
};
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const TOKEN = /^qpc_[0-9a-f]{64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_CONFIG_BYTES = 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validateBackends(
  backends: RawBackend[],
  language: LiveLanguage,
): void {
  try {
    parseBackends(
      { ...process.env, QWEN_LIVE_HARNESS_BACKENDS: undefined },
      { backends },
      'config.json',
    );
  } catch {
    // Runtime validation can include raw config values. Never echo credentials.
    throw new Error(liveText(language, 'peerSetup.invalidConfig'));
  }
}

/** Only explicit answers enable peers. No Qwen settings or grants are changed. */
export async function promptPeerSetup(
  original: RawBackend[],
  language: LiveLanguage,
  options: { enabled?: true } = {},
): Promise<RawBackend[] | undefined> {
  const t = (key: Parameters<typeof liveText>[1]) => liveText(language, key);
  if (process.env['QWEN_LIVE_HARNESS_BACKENDS']?.trim())
    throw new Error(t('peerSetup.envOverride'));
  const labels = {
    yes: t('init.yes'),
    no: t('init.no'),
    yesOption: t('init.yesOption'),
    noOption: t('init.noOption'),
  };
  const choiceLabels = {
    hint: t('init.selectHint'),
    warn: t('init.selectDisabled'),
  };
  const backends = structuredClone(original);
  // Allow repairing an invalid/missing controller env reference on this backend.
  validateBackends(
    backends.map(({ peerDiscovery: _peer, ...backend }) => backend),
    language,
  );
  console.log(`\n${t('peerSetup.intro')}`);
  const candidates = backends.flatMap((backend, index) =>
    backend.kind === 'qwen-code'
      ? [{ title: String(backend.name), value: index }]
      : [],
  );
  const selected = await prompts({
    type: 'select',
    name: 'value',
    ...choiceLabels,
    message: t('peerSetup.backend'),
    choices: [...candidates, { title: t('peerSetup.addBackend'), value: -1 }],
    initial: 0,
  });
  if (selected.value === undefined) return undefined;
  const index = selected.value as number;
  if (
    index !== -1 &&
    !candidates.some((candidate) => candidate.value === index)
  )
    return undefined;
  const backend = index === -1 ? undefined : backends[index]!;
  const previous:
    | (Record<string, unknown> & {
        qwenHome?: unknown;
        reports?: unknown;
        controllerToken?: unknown;
        controllerTokenEnv?: unknown;
      })
    | undefined = record(backend?.peerDiscovery)
    ? backend.peerDiscovery
    : undefined;
  const enabled =
    options.enabled === true
      ? true
      : (
          await prompts({
            type: 'confirm',
            name: 'value',
            ...labels,
            message: t('peerSetup.enabled'),
            initial: previous !== undefined,
          })
        ).value;
  if (typeof enabled !== 'boolean') return undefined;
  if (!enabled) {
    if (backend) delete backend.peerDiscovery;
    return backends;
  }
  if (process.platform === 'win32') throw new Error(t('peerSetup.unsupported'));

  let target = backend;
  if (!target) {
    let suggestedName = 'qwen-peers';
    for (
      let suffix = 2;
      backends.some(
        (entry) => String(entry.name).toLowerCase() === suggestedName,
      );
      suffix++
    ) {
      suggestedName = `qwen-peers-${suffix}`;
    }
    const name = await prompts({
      type: 'text',
      name: 'value',
      message: t('peerSetup.name'),
      initial: suggestedName,
      validate: (value: string) =>
        (NAME.test(value.trim()) &&
          !backends.some(
            (entry) =>
              String(entry.name).toLowerCase() === value.trim().toLowerCase(),
          )) ||
        t('peerSetup.invalidName'),
    });
    if (typeof name.value !== 'string') return undefined;
    const url = await prompts({
      type: 'text',
      name: 'value',
      message: t('peerSetup.url'),
      initial: 'http://127.0.0.1:4170',
      validate: (value: string) =>
        validUrl(value.trim()) || t('peerSetup.invalidUrl'),
    });
    if (typeof url.value !== 'string') return undefined;
    const auth = await prompts({
      type: 'password',
      name: 'value',
      message: t('peerSetup.serveToken'),
    });
    if (typeof auth.value !== 'string') return undefined;
    if (!validUrl(url.value.trim())) throw new Error(t('peerSetup.invalidUrl'));
    // A sole backend is implicitly default until a second backend is added.
    if (backends.length === 1 && backends[0]!.default !== true)
      backends[0]!.default = true;
    target = {
      name: name.value.trim(),
      kind: 'qwen-code',
      baseUrl: url.value.trim(),
      ...(auth.value.trim() ? { token: auth.value.trim() } : {}),
    };
    backends.push(target);
  }
  const home = await prompts({
    type: 'text',
    name: 'value',
    message: t('peerSetup.home'),
    initial: resolveQwenHome(
      typeof previous?.qwenHome === 'string' ? previous.qwenHome : undefined,
    ),
    validate: (value: string) =>
      (!!value.trim() && !/\p{C}/u.test(value)) || t('peerSetup.invalidHome'),
  });
  if (typeof home.value !== 'string') return undefined;
  if (!home.value.trim() || /\p{C}/u.test(home.value))
    throw new Error(t('peerSetup.invalidHome'));
  console.log(t('peerSetup.messagingHint'));
  const reports = await prompts({
    type: 'confirm',
    name: 'value',
    ...labels,
    message: t('peerSetup.reports'),
    initial: previous?.reports === true,
  });
  if (typeof reports.value !== 'boolean') return undefined;
  const peer: PeerSettings = {
    qwenHome: resolveQwenHome(home.value.trim()),
    reports: reports.value,
  };
  const quotedHome = `'${peer.qwenHome.replaceAll("'", "'\"'\"'")}'`;
  console.log(liveText(language, 'peerSetup.grantHint', { home: quotedHome }));
  const hasGrant =
    typeof previous?.controllerToken === 'string' ||
    typeof previous?.controllerTokenEnv === 'string';
  const grant = await prompts({
    type: 'select',
    name: 'value',
    ...choiceLabels,
    message: t('peerSetup.controller'),
    initial: 0,
    choices: [
      ...(hasGrant ? [{ title: t('peerSetup.keepGrant'), value: 'keep' }] : []),
      { title: t('peerSetup.readOnly'), value: 'none' },
      { title: t('peerSetup.environment'), value: 'env' },
      { title: t('peerSetup.pasteToken'), value: 'token' },
    ],
  });
  if (grant.value === undefined) return undefined;
  if (grant.value === 'keep' && previous && hasGrant) {
    if (typeof previous.controllerTokenEnv === 'string')
      peer.controllerTokenEnv = previous.controllerTokenEnv;
    else if (typeof previous.controllerToken === 'string')
      peer.controllerToken = previous.controllerToken;
  } else if (grant.value === 'env') {
    const answer = await prompts({
      type: 'text',
      name: 'value',
      message: t('peerSetup.tokenEnv'),
      initial:
        typeof previous?.controllerTokenEnv === 'string'
          ? previous.controllerTokenEnv
          : 'QWEN_LIVE_HARNESS_CONTROLLER_TOKEN',
      validate: (value: string) =>
        (ENV_NAME.test(value.trim()) &&
          TOKEN.test(process.env[value.trim()] ?? '')) ||
        t('peerSetup.invalidEnv'),
    });
    if (typeof answer.value !== 'string') return undefined;
    if (
      !ENV_NAME.test(answer.value.trim()) ||
      !TOKEN.test(process.env[answer.value.trim()] ?? '')
    )
      throw new Error(t('peerSetup.invalidEnv'));
    peer.controllerTokenEnv = answer.value.trim();
  } else if (grant.value === 'token') {
    const answer = await prompts({
      type: 'password',
      name: 'value',
      message: t('peerSetup.token'),
      validate: (value: string) =>
        TOKEN.test(value.trim()) || t('peerSetup.invalidToken'),
    });
    if (typeof answer.value !== 'string') return undefined;
    if (!TOKEN.test(answer.value.trim()))
      throw new Error(t('peerSetup.invalidToken'));
    peer.controllerToken = answer.value.trim();
  } else if (grant.value !== 'none') return undefined;
  target.peerDiscovery = peer;
  validateBackends(backends, language);
  console.log(t('peerSetup.permissionsHint'));
  return backends;
}

async function readSnapshot(
  configPath: string,
  language: LiveLanguage,
): Promise<string> {
  try {
    const stat = await lstat(configPath);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error();
    const text = await readFile(configPath, 'utf8');
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error();
    return text;
  } catch {
    throw new Error(liveText(language, 'peerSetup.configRequired'));
  }
}

/** Incremental settings entry: preserve unrelated fields and fail on concurrent edits. */
export async function runPeerSetup(language: LiveLanguage): Promise<void> {
  const t = (key: Parameters<typeof liveText>[1]) => liveText(language, key);
  if (process.env['QWEN_LIVE_HARNESS_BACKENDS']?.trim())
    throw new Error(t('peerSetup.envOverride'));
  const configPath = join(resolveLiveDataDirectory(), 'config.json');
  const before = await readSnapshot(configPath, language);
  let config: Record<string, unknown> & {
    backends?: unknown;
    serveUrl?: unknown;
    serveToken?: unknown;
  };
  try {
    const value: unknown = JSON.parse(before.replace(/^\uFEFF/u, ''));
    if (!record(value)) throw new Error();
    config = value;
  } catch {
    throw new Error(t('peerSetup.invalidConfig'));
  }
  let original: RawBackend[];
  if (config.backends === undefined) {
    if (
      process.env['QWEN_LIVE_HARNESS_SERVE_URL']?.trim() ||
      process.env['QWEN_SERVER_TOKEN']?.trim()
    )
      throw new Error(t('peerSetup.envOverride'));
    original = [
      {
        name: 'qwen-code',
        kind: 'qwen-code',
        default: true,
        baseUrl: config.serveUrl ?? 'http://127.0.0.1:4170',
        ...(config.serveToken !== undefined
          ? { token: config.serveToken }
          : {}),
      },
    ];
  } else {
    if (!Array.isArray(config.backends) || !config.backends.every(record))
      throw new Error(t('peerSetup.invalidConfig'));
    original = config.backends;
  }
  const backends = await promptPeerSetup(original, language);
  if (!backends) {
    console.log(t('init.cancelled'));
    return;
  }
  if (JSON.stringify(original) === JSON.stringify(backends)) {
    console.log(t('peerSetup.unchanged'));
    return;
  }
  validateBackends(backends, language);
  const output = JSON.stringify({ ...config, backends }, null, 2) + '\n';
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  const lockPath = `${configPath}.peer-setup.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(t('peerSetup.saveBusy'));
      }
      throw error;
    }
    await lock.writeFile(String(process.pid), 'utf8');
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(output, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await readSnapshot(configPath, language)) !== before)
      throw new Error(t('peerSetup.concurrentEdit'));
    await rename(temporaryPath, configPath);
  } finally {
    try {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    } finally {
      if (lock) {
        await lock.close();
        await unlink(lockPath);
      }
    }
  }
  console.log(t('peerSetup.saved'));
}
