/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { constants } from 'node:fs';
import { lstat, open, opendir, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import type { BackendConfig, LiveConfig } from './config.js';
import { LIVE_HOST_PROTOCOL_VERSION } from './host/types.js';
import {
  liveText,
  type LiveLanguage,
  type LiveMessageKey,
} from './i18n/messages.js';
import {
  isLocalIpcPath,
  probePeerSocketVerdict,
  readLiveSessionRecords,
  resolveQwenHome,
  sessionRegistryDir,
  type PeerSocketVerdict,
  type SessionRecord,
} from './vendor/qwen-code-peer/index.js';

const MAX_BACKENDS = 16;
const MAX_HOMES = 8;
const MAX_REGISTRY_ENTRIES = 128;
const MAX_PROBES = 32;
const MAX_JSON_BYTES = 64 * 1024;
const HTTP_TIMEOUT_MS = 2000;

/** Keep aligned with QwenCodeAdaptor.preflight; these are capability tags, not a CLI version floor. */
const REQUIRED_FEATURES = [
  'session_create',
  'session_prompt',
  'session_events',
  'session_cancel',
  'session_permission_vote',
  'session_mid_turn_message_mutation',
] as const;

type ReadState = 'ready' | 'missing' | 'unreadable' | 'invalid';
type HttpFailure = 'unreachable' | 'auth-rejected' | 'invalid' | 'error';
type HttpResult = { state: 'ready'; value: unknown } | { state: HttpFailure };
type JsonResult =
  { state: 'ready'; value: unknown } | { state: Exclude<ReadState, 'ready'> };
type RegistryState = ReadState | 'truncated' | 'unsupported';
type ControllerState = 'configured-unverified' | 'missing' | 'invalid';

export interface PeerHomeDiagnostics {
  /** A local index, rather than a private filesystem path. */
  home: number;
  settings:
    ReadState | 'enabled' | 'disabled' | 'unset' | 'truncated' | 'unknown';
  inbound: 'accept' | 'hold' | 'refuse' | 'unset' | 'unknown';
  registry: RegistryState;
  liveRecords: number;
  terminals: number;
  terminalInboxes: number;
  probed: number;
  reachable: number;
  dead: number;
  unknown: number;
  omitted: number;
  versions: string[];
}

export interface PeerBackendDiagnostics {
  name: string;
  kind: BackendConfig['kind'];
  serve?: {
    location: 'local' | 'remote' | 'unknown';
    state: HttpFailure | 'ready' | 'missing-features' | 'remote-unverified';
    missingFeatures: string[];
    version?: string;
  };
  peers?: PeerHomeDiagnostics & {
    controller: ControllerState;
    reports: boolean;
  };
}

export type PeerDiagnosticHint =
  | 'settingsScope'
  | 'grant'
  | 'remote'
  | 'probeOnly'
  | 'hold'
  | 'unknownDelivery'
  | 'callAndMute'
  | 'serveRequired'
  | 'windows'
  | 'limits';

export interface PeerDiagnostics {
  v: 1;
  hasErrors: boolean;
  platform: 'supported' | 'unsupported';
  backends: PeerBackendDiagnostics[];
  omittedBackends: number;
  daemon: {
    state: ReadState | HttpFailure | 'protocol-mismatch' | 'stale';
    host: 'installed' | 'missing' | 'unknown' | 'unsupported';
    /** Existing read-only HTTP interfaces do not expose these states. */
    call: 'unknown';
    outputMuted: 'unknown';
    version?: string;
  };
  hints: PeerDiagnosticHint[];
}

export interface PeerDiagnosticsOptions {
  /** Test seams only. No endpoint, grant mutation, or message-sending dependency. */
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  readRecords?: typeof readLiveSessionRecords;
  probeSocket?: typeof probePeerSocketVerdict;
  timeoutMs?: number;
}

interface HomeInspection {
  summary: PeerHomeDiagnostics;
  sockets: string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeVersion(value: unknown): string | undefined {
  // Do not print arbitrary registry or HTTP strings, including credentials
  // disguised as version metadata. Unrecognized versions remain unknown.
  return typeof value === 'string' &&
    /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc|preview|dev|nightly)(?:[.-]\d{1,14})?)?$/u.test(
      value,
    )
    ? value
    : undefined;
}

function localHttpUrl(value: string): { url: URL; local: boolean } | undefined {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    return {
      url,
      local:
        hostname === 'localhost' ||
        hostname === '::1' ||
        (isIP(hostname) === 4 && hostname.startsWith('127.')),
    };
  } catch {
    return undefined;
  }
}

/** Bounded regular-file reads; never mkdir, chmod, lock, or remove records. */
async function readJson(
  filePath: string,
  platform: NodeJS.Platform,
  privateFile = false,
): Promise<JsonResult> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await (privateFile ? lstat : stat)(filePath);
    const limit = privateFile ? 16 * 1024 : MAX_JSON_BYTES;
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size <= 0 ||
      before.size > limit ||
      (privateFile &&
        (before.nlink !== 1 ||
          (platform !== 'win32' &&
            ((before.mode & 0o777) !== 0o600 ||
              (process.getuid && before.uid !== process.getuid())))))
    ) {
      return { state: 'invalid' };
    }
    handle = await open(
      filePath,
      constants.O_RDONLY |
        (platform === 'win32'
          ? 0
          : (privateFile ? constants.O_NOFOLLOW : 0) | constants.O_NONBLOCK),
    );
    const current = await handle.stat();
    if (
      !current.isFile() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size > limit ||
      (privateFile &&
        (current.nlink !== 1 ||
          current.size !== before.size ||
          (platform !== 'win32' &&
            ((current.mode & 0o777) !== 0o600 ||
              (process.getuid && current.uid !== process.getuid())))))
    )
      return { state: 'invalid' };
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) return { state: 'invalid' };
    try {
      return {
        state: 'ready',
        value: JSON.parse(
          privateFile
            ? buffer.subarray(0, bytesRead).toString('utf8')
            : stripSettingsComments(
                buffer.subarray(0, bytesRead).toString('utf8'),
              ),
        ) as unknown,
      };
    } catch {
      return { state: 'invalid' };
    }
  } catch (error) {
    return {
      state:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'missing'
          : 'unreadable',
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Qwen settings allow JSON comments; quoted strings are left untouched. */
function stripSettingsComments(value: string): string {
  return value.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu,
    (match, quoted: string | undefined) =>
      quoted ?? match.replace(/[^\r\n]/gu, ' '),
  );
}

async function requestJson(
  url: URL,
  headers: Record<string, string>,
  options: PeerDiagnosticsOptions,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timeoutMs = Math.max(
    1,
    Math.min(options.timeoutMs ?? HTTP_TIMEOUT_MS, HTTP_TIMEOUT_MS),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const operation = async (): Promise<HttpResult> => {
    const response = await (options.fetch ?? fetch)(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403)
      return { state: 'auth-rejected' };
    if (response.status >= 300 && response.status < 400)
      return { state: 'invalid' };
    if (!response.ok) return { state: 'error' };
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > MAX_JSON_BYTES)
      return { state: 'invalid' };
    if (!response.body) return { state: 'invalid' };
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_JSON_BYTES) return { state: 'invalid' };
      chunks.push(chunk.value);
    }
    try {
      return {
        state: 'ready',
        value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      };
    } catch {
      return { state: 'invalid' };
    }
  };
  try {
    return await Promise.race([
      operation(),
      new Promise<HttpResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ state: 'unreachable' });
        }, timeoutMs);
      }),
    ]);
  } catch {
    return { state: 'unreachable' };
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await run(values[index]!, index);
      }
    }),
  );
  return results;
}

async function registryState(directory: string): Promise<RegistryState> {
  try {
    let entries = 0;
    for await (const _entry of await opendir(directory)) {
      if (++entries > MAX_REGISTRY_ENTRIES) return 'truncated';
    }
    return 'ready';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'missing'
      : 'unreadable';
  }
}

function emptyHome(home: number, registry: RegistryState): HomeInspection {
  return {
    summary: {
      home,
      settings: 'unknown',
      inbound: 'unknown',
      registry,
      liveRecords: 0,
      terminals: 0,
      terminalInboxes: 0,
      probed: 0,
      reachable: 0,
      dead: 0,
      unknown: 0,
      omitted: 0,
      versions: [],
    },
    sockets: [],
  };
}

async function inspectHome(
  qwenHome: string,
  home: number,
  options: PeerDiagnosticsOptions,
): Promise<HomeInspection> {
  const platform = options.platform ?? process.platform;
  const result = emptyHome(
    home,
    platform === 'win32' ? 'unsupported' : 'ready',
  );
  const settings = await readJson(
    path.join(qwenHome, 'settings.json'),
    platform,
  );
  result.summary.settings = settings.state;
  if (settings.state === 'ready') {
    if (
      !object(settings.value) ||
      (settings.value['agents'] !== undefined &&
        !object(settings.value['agents']))
    ) {
      result.summary.settings = 'invalid';
    } else {
      const agents = settings.value['agents'] as
        Record<string, unknown> | undefined;
      const enabled = agents?.['crossSessionMessaging'];
      result.summary.settings =
        enabled === undefined
          ? 'unset'
          : enabled === true
            ? 'enabled'
            : enabled === false
              ? 'disabled'
              : 'invalid';
      const inbound = agents?.['crossSessionInbound'];
      result.summary.inbound =
        inbound === undefined
          ? 'unset'
          : inbound === 'accept' || inbound === 'hold' || inbound === 'refuse'
            ? inbound
            : 'unknown';
    }
  }
  if (platform === 'win32') return result;
  const directory = sessionRegistryDir(qwenHome);
  result.summary.registry = await registryState(directory);
  if (result.summary.registry !== 'ready') return result;
  let records: SessionRecord[];
  try {
    records = await (options.readRecords ?? readLiveSessionRecords)(directory);
  } catch {
    result.summary.registry = 'unreadable';
    return result;
  }
  // Recheck the result as well: the directory may grow after the count check.
  if (records.length > MAX_REGISTRY_ENTRIES) {
    result.summary.registry = 'truncated';
    return result;
  }
  result.summary.liveRecords = records.length;
  const terminals = records.filter(
    (record) => (record.kind ?? 'tui') === 'tui',
  );
  result.summary.terminals = terminals.length;
  const inboxes = terminals.filter(
    (record) => record.ipcPath && isLocalIpcPath(record.ipcPath),
  );
  result.summary.terminalInboxes = inboxes.length;
  result.sockets = [...new Set(inboxes.map((record) => record.ipcPath!))];
  result.summary.versions = [
    ...new Set(
      records
        .map((record) => safeVersion(record.qwenVersion))
        .filter((version): version is string => version !== undefined),
    ),
  ].sort();
  return result;
}

async function inspectServe(
  backend: Extract<BackendConfig, { kind: 'qwen-code' }>,
  options: PeerDiagnosticsOptions,
): Promise<NonNullable<PeerBackendDiagnostics['serve']>> {
  const base = localHttpUrl(backend.baseUrl);
  if (!base)
    return { location: 'unknown', state: 'invalid', missingFeatures: [] };
  if (!base.local)
    return {
      location: 'remote',
      state: 'remote-unverified',
      missingFeatures: [],
    };
  base.url.pathname = `${base.url.pathname.replace(/\/$/u, '')}/capabilities`;
  const response = await requestJson(
    base.url,
    backend.token ? { Authorization: `Bearer ${backend.token}` } : {},
    options,
  );
  if (response.state !== 'ready')
    return { location: 'local', state: response.state, missingFeatures: [] };
  if (
    !object(response.value) ||
    (response.value['features'] !== undefined &&
      (!Array.isArray(response.value['features']) ||
        response.value['features'].some((entry) => typeof entry !== 'string')))
  ) {
    return { location: 'local', state: 'invalid', missingFeatures: [] };
  }
  const features = new Set((response.value['features'] ?? []) as string[]);
  const missingFeatures = REQUIRED_FEATURES.filter(
    (feature) => !features.has(feature),
  );
  const version = safeVersion(response.value['qwenCodeVersion']);
  return {
    location: 'local',
    state: missingFeatures.length ? 'missing-features' : 'ready',
    missingFeatures,
    ...(version ? { version } : {}),
  };
}

async function inspectDaemon(
  discoveryDir: string,
  options: PeerDiagnosticsOptions,
): Promise<PeerDiagnostics['daemon']> {
  const result: PeerDiagnostics['daemon'] = {
    state: 'missing',
    host: 'unknown',
    call: 'unknown',
    outputMuted: 'unknown',
  };
  const read = await readJson(
    path.join(discoveryDir, 'run', 'daemon.json'),
    options.platform ?? process.platform,
    true,
  );
  if (read.state !== 'ready') return { ...result, state: read.state };
  const value = read.value;
  if (
    !object(value) ||
    typeof value['url'] !== 'string' ||
    typeof value['token'] !== 'string' ||
    !value['token'] ||
    value['token'].length > 4096 ||
    typeof value['instanceNonce'] !== 'string' ||
    !/^[A-Za-z0-9_-]{16,256}$/u.test(value['instanceNonce']) ||
    !Number.isSafeInteger(value['pid']) ||
    Number(value['pid']) <= 0
  )
    return { ...result, state: 'invalid' };
  if (value['protocolVersion'] !== LIVE_HOST_PROTOCOL_VERSION)
    return { ...result, state: 'protocol-mismatch' };
  const base = localHttpUrl(value['url']);
  if (!base?.local) return { ...result, state: 'invalid' };
  const headers = {
    Authorization: `Bearer ${value['token']}`,
    'x-qwen-live-harness-nonce': value['instanceNonce'],
  };
  const instance = new URL('/live/instance', base.url);
  const response = await requestJson(instance, headers, options);
  if (response.state !== 'ready') return { ...result, state: response.state };
  if (
    !object(response.value) ||
    response.value['pid'] !== value['pid'] ||
    response.value['instanceNonce'] !== value['instanceNonce']
  )
    return { ...result, state: 'stale' };
  if (response.value['protocolVersion'] !== LIVE_HOST_PROTOCOL_VERSION)
    return { ...result, state: 'protocol-mismatch' };
  result.state = 'ready';
  const version = safeVersion(response.value['version']);
  if (version) result.version = version;
  const setup = await requestJson(
    new URL('/live/setup', base.url),
    headers,
    options,
  );
  if (setup.state === 'ready' && object(setup.value)) {
    if (setup.value['state'] === 'installed') result.host = 'installed';
    else if (setup.value['state'] === 'missing') result.host = 'missing';
    else if (
      (options.platform ?? process.platform) !== 'darwin' &&
      setup.value['state'] === 'error'
    )
      result.host = 'unsupported';
  }
  return result;
}

/** Read-only evidence. No probe here proves controller authorization or playback. */
export async function diagnoseQwenPeers(
  config: Pick<LiveConfig, 'backends' | 'discoveryDir'>,
  options: PeerDiagnosticsOptions = {},
): Promise<PeerDiagnostics> {
  const selected = config.backends.slice(0, MAX_BACKENDS);
  const homes = [
    ...new Set(
      selected.flatMap((backend) =>
        backend.kind === 'qwen-code' && backend.peerDiscovery
          ? [resolveQwenHome(backend.peerDiscovery.qwenHome)]
          : [],
      ),
    ),
  ];
  const checkedHomes = homes.slice(0, MAX_HOMES);
  const daemonPromise = inspectDaemon(config.discoveryDir, options);
  const inspections = await mapLimit(checkedHomes, 2, (home, index) =>
    inspectHome(home, index + 1, options),
  );
  const sockets = [
    ...new Set(inspections.flatMap((inspection) => inspection.sockets)),
  ].slice(0, MAX_PROBES);
  const verdicts = await mapLimit(
    sockets,
    4,
    async (socket): Promise<PeerSocketVerdict> => {
      try {
        return await (options.probeSocket ?? probePeerSocketVerdict)(socket);
      } catch {
        return 'unknown';
      }
    },
  );
  const probes = new Map(
    sockets.map((socket, index) => [socket, verdicts[index]!]),
  );
  for (const inspection of inspections) {
    for (const socket of inspection.sockets) {
      const verdict = probes.get(socket);
      if (verdict === undefined) inspection.summary.omitted += 1;
      else {
        inspection.summary.probed += 1;
        if (verdict === 'alive') inspection.summary.reachable += 1;
        else if (verdict === 'dead') inspection.summary.dead += 1;
        else inspection.summary.unknown += 1;
      }
    }
  }
  const backends = await mapLimit(
    selected,
    4,
    async (backend, index): Promise<PeerBackendDiagnostics> => {
      const result: PeerBackendDiagnostics = {
        name: /^[a-z0-9][a-z0-9_-]{0,31}$/iu.test(backend.name)
          ? backend.name
          : `backend-${index + 1}`,
        kind: backend.kind,
      };
      if (backend.kind !== 'qwen-code') return result;
      result.serve = await inspectServe(backend, options);
      if (backend.peerDiscovery) {
        const home = homes.indexOf(
          resolveQwenHome(backend.peerDiscovery.qwenHome),
        );
        const inspected = inspections[home]?.summary ?? {
          ...emptyHome(home + 1, 'truncated').summary,
          settings: 'truncated' as const,
        };
        const token = backend.peerDiscovery.controllerToken;
        result.peers = {
          ...inspected,
          versions: [...inspected.versions],
          controller:
            token === undefined
              ? 'missing'
              : /^qpc_[0-9a-f]{64}$/u.test(token)
                ? 'configured-unverified'
                : 'invalid',
          reports: backend.peerDiscovery.reports === true,
        };
      }
      return result;
    },
  );
  const hints = new Set<PeerDiagnosticHint>([
    'probeOnly',
    'unknownDelivery',
    'callAndMute',
  ]);
  if (backends.some((backend) => backend.peers)) {
    hints.add('settingsScope');
    hints.add('grant');
    hints.add('hold');
  }
  if (backends.some((backend) => backend.serve?.location === 'remote'))
    hints.add('remote');
  if (
    backends.some((backend) => backend.serve && backend.serve.state !== 'ready')
  )
    hints.add('serveRequired');
  if ((options.platform ?? process.platform) === 'win32') hints.add('windows');
  hints.add('limits');
  const daemon = await daemonPromise;
  const hasErrors =
    !['ready', 'missing'].includes(daemon.state) ||
    backends.some(
      (backend) =>
        (backend.serve !== undefined &&
          !['ready', 'remote-unverified'].includes(backend.serve.state)) ||
        (backend.peers !== undefined &&
          (backend.peers.controller === 'invalid' ||
            ['invalid', 'unreadable'].includes(backend.peers.settings) ||
            ['invalid', 'unreadable', 'unsupported'].includes(
              backend.peers.registry,
            ))),
    );
  return {
    v: 1,
    hasErrors,
    platform:
      (options.platform ?? process.platform) === 'win32'
        ? 'unsupported'
        : 'supported',
    backends,
    omittedBackends: Math.max(0, config.backends.length - selected.length),
    daemon,
    hints: [...hints],
  };
}

export function formatPeerDiagnostics(
  result: PeerDiagnostics,
  language: LiveLanguage,
): string {
  const text = (key: string, params: Record<string, string | number> = {}) =>
    liveText(language, `peers.doctor.${key}` as LiveMessageKey, params);
  const state = (value: string) => text(`state.${value}`);
  const lines = [text('title')];
  for (const backend of result.backends) {
    lines.push(text('backend', { name: backend.name, kind: backend.kind }));
    if (backend.serve) {
      lines.push(
        text('serve', {
          location: state(backend.serve.location),
          state: state(backend.serve.state),
        }),
      );
      if (backend.serve.missingFeatures.length)
        lines.push(
          text('features', {
            features: backend.serve.missingFeatures.join(', '),
          }),
        );
      if (backend.serve.version)
        lines.push(text('versions', { versions: backend.serve.version }));
    }
    const peers = backend.peers;
    if (!peers) {
      lines.push(text('notConfigured'));
      continue;
    }
    lines.push(
      text('home', {
        home: peers.home,
        settings: state(peers.settings),
        inbound: state(peers.inbound),
      }),
    );
    lines.push(
      text('registry', {
        state: state(peers.registry),
        records:
          peers.registry === 'ready' ? peers.liveRecords : state('unknown'),
        terminals:
          peers.registry === 'ready' ? peers.terminals : state('unknown'),
        inboxes:
          peers.registry === 'ready' ? peers.terminalInboxes : state('unknown'),
      }),
    );
    lines.push(
      text('sockets', {
        probed: peers.probed,
        reachable: peers.reachable,
        dead: peers.dead,
        unknown: peers.unknown,
        omitted: peers.omitted,
      }),
    );
    lines.push(
      text('controller', {
        state: state(peers.controller),
        reports: state(peers.reports ? 'enabled' : 'disabled'),
      }),
    );
    lines.push(
      text('versions', {
        versions: peers.versions.length
          ? peers.versions.join(', ')
          : state('unknown'),
      }),
    );
  }
  lines.push(
    text('daemon', {
      state: state(result.daemon.state),
      host: state(result.daemon.host),
    }),
    text('callUnknown'),
  );
  if (result.omittedBackends)
    lines.push(text('omitted', { count: result.omittedBackends }));
  lines.push(...result.hints.map((hint) => text(`hint.${hint}`)));
  return lines.join('\n');
}
