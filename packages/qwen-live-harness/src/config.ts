/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration: environment first, `~/.qwen-live-harness/config.json` as fallback,
 * built-in defaults last. Hand-rolled validation — the surface is small and
 * a schema library would be the package's only heavy dependency.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isScreenDisplayId } from './host/screen-display.js';
import { resolveMemoryConfig, type MemoryConfig } from './memory/config.js';
import type { LiveLanguage } from './i18n/messages.js';
import { resolveLiveLanguage } from './language-preferences.js';
import {
  PROACTIVE_MONITOR_CHUNK_DURATION_SEC,
  PROACTIVE_MONITOR_FPS,
} from './proactive/media-cadence.js';
import {
  resolveLiveDataDirectory,
  resolveLiveDiscoveryDirectory,
} from './paths.js';

/**
 * One backend the live call can drive. `name` is what the voice model sees
 * (session_create's `backend` arg); it becomes the scoping prefix for
 * jobRefs and permission requestIds, so it must not contain ':'.
 */
export type BackendConfig =
  | {
      name: string;
      kind: 'qwen-code';
      baseUrl: string;
      token?: string;
      /** Live owns this local service; address and token are assigned at startup. */
      managedServe?: { command: string };
      /** Opt-in local terminals; an explicit controller grant enables text delivery. */
      peerDiscovery?: {
        qwenHome: string;
        controllerToken?: string;
        reports?: boolean;
      };
      isDefault: boolean;
    }
  | {
      name: string;
      kind: 'acp';
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
      /**
       * Approval mode selected after `session/new` (ACP `session/set_mode`),
       * e.g. `yolo`. Omitted → the advertised asking mode is forced so every
       * action needs an explicit approval.
       */
      sessionMode?: string;
      isDefault: boolean;
    };

export type VisualInputSource = 'screen' | 'camera';
export type VisualInputMode = 'on-demand' | 'live-feed';
export type VisualResolution = 'native' | { width: number; height: number };

export interface VisualInputConfig {
  source: VisualInputSource;
  mode: VisualInputMode;
  screenDisplayId?: string;
  fps: number;
  cameraResolution: Exclude<VisualResolution, 'native'>;
  cameraSnapshotResolution: VisualResolution;
  liveResolution: Exclude<VisualResolution, 'native'>;
  snapshotResolution: VisualResolution;
}

export interface ProactiveConfig {
  enabled: boolean;
  monitor: {
    sessionRecycleEvals: number;
    representationCompact: 'none' | 'normal';
  };
  scheduler: {
    evalIntervalSec: number;
    /** Legacy config field; no longer limits active monitors. */
    maxConcurrentTasks?: number;
    maxFailuresPerTask: number;
    repeat: {
      cooldownSec: number;
      maxWaitTtsSec: number;
      clearBufferOnResume: boolean;
    };
  };
  vision: {
    windowSizeSec: number;
    minEvalDurationSec: number;
  };
  audio: {
    windowSizeSec: number;
    minEvalDurationSec: number;
  };
}

export interface LiveConfig {
  language?: LiveLanguage;
  realtime: {
    endpoint: string;
    apiKey: string;
    model: string;
    voice?: string;
  };
  /** Explicit [] disables delegation; otherwise exactly one backend is the default. */
  backends: BackendConfig[];
  /** Default working directory for handoff-created sessions. */
  defaultCwd?: string;
  /** Data root: session logs live in `<dataDir>/sessions`. */
  dataDir: string;
  /** Discovery base; the shipped Host reads `<base>/run/daemon.json`. */
  discoveryDir: string;
  /** Global shortcut advertised to the Host. */
  shortcut?: string;
  /** Visual source, acquisition mode, and capture quality settings. */
  visualInput: VisualInputConfig;
  /** Background perception and timer monitoring. */
  proactive: ProactiveConfig;
  memory: MemoryConfig;
  /** Fixed listen port; 0 (default) lets the kernel pick. */
  port: number;
}

const DEFAULT_REALTIME_ENDPOINT = 'https://dashscope.aliyuncs.com';
export const DEFAULT_REALTIME_MODEL = 'qwen3.8-omni-flash-realtime';
const DEFAULT_VISUAL_FPS = 1;
const MIN_VISUAL_FPS = 0.1;
const MAX_VISUAL_FPS = 10;
const DEFAULT_LIVE_WIDTH = 1280;
const DEFAULT_LIVE_HEIGHT = 720;
const MIN_VISUAL_WIDTH = 160;
const MAX_LIVE_WIDTH = 3840;
const MAX_SNAPSHOT_WIDTH = 7680;
const MIN_VISUAL_HEIGHT = 120;
const MAX_LIVE_HEIGHT = 2160;
const MAX_SNAPSHOT_HEIGHT = 4320;
const DEFAULT_SERVE_URL = 'http://127.0.0.1:4170';
const BACKEND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
/** ACP mode ids are short tokens ("default", "auto-edit", "yolo"). */
const SESSION_MODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const DEFAULT_PROACTIVE_CONFIG: ProactiveConfig = {
  enabled: true,
  monitor: {
    sessionRecycleEvals: 60,
    representationCompact: 'normal',
  },
  scheduler: {
    evalIntervalSec: 1,
    maxFailuresPerTask: 3,
    repeat: {
      cooldownSec: 3,
      maxWaitTtsSec: 30,
      clearBufferOnResume: true,
    },
  },
  vision: {
    windowSizeSec: 10,
    minEvalDurationSec: 0,
  },
  audio: {
    windowSizeSec: 60,
    minEvalDurationSec: 0,
  },
};

function readConfigFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // Only a genuinely missing file means "no config". Anything else
    // (EACCES, EISDIR, EIO) must surface, or the later missing-key error
    // would point the user at a file that already contains the key.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `Could not read config file ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  // Editors commonly save JSON with a UTF-8 BOM; JSON.parse rejects it.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
    throw new Error('not an object');
  } catch (error) {
    throw new Error(
      `Invalid config file ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Shell-style expansion of a leading `~` to the user's home directory. */
function expandTilde(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function pathStr(value: unknown): string | undefined {
  const trimmed = str(value);
  return trimmed === undefined ? undefined : expandTilde(trimmed);
}

function resolvePort(
  env: Record<string, string | undefined>,
  file: Record<string, unknown>,
  configPath: string,
): number {
  const envPort = str(env['QWEN_LIVE_HARNESS_PORT']);
  if (envPort !== undefined) {
    const port = Number(envPort);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error(`Invalid QWEN_LIVE_HARNESS_PORT: ${envPort}`);
    }
    return port;
  }
  const filePort = file['port'];
  if (filePort === undefined) return 0;
  // Accept the natural JSON spelling ("port": 4171) as well as a string.
  // Any other type (true, [4171], {}) is a config mistake and must not
  // silently boot on a kernel-picked ephemeral port.
  const portRaw =
    typeof filePort === 'number'
      ? String(filePort)
      : typeof filePort === 'string'
        ? filePort.trim()
        : undefined;
  const port = portRaw ? Number(portRaw) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(
      `Invalid "port" in ${configPath}: ${JSON.stringify(filePort)}`,
    );
  }
  return port;
}

function resolveVisualFps(
  env: Record<string, string | undefined>,
  visualInput: Record<string, unknown>,
  configPath: string,
): number {
  const envFps = str(env['QWEN_LIVE_HARNESS_VISUAL_FPS']);
  const raw = envFps ?? visualInput['fps'];
  if (raw === undefined) return DEFAULT_VISUAL_FPS;
  const fps =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(fps) || fps < MIN_VISUAL_FPS || fps > MAX_VISUAL_FPS) {
    const source =
      envFps === undefined
        ? `"visualInput.fps" in ${configPath}`
        : 'QWEN_LIVE_HARNESS_VISUAL_FPS';
    throw new Error(
      `Invalid ${source}: ${JSON.stringify(raw)} (expected ${MIN_VISUAL_FPS}-${MAX_VISUAL_FPS})`,
    );
  }
  return fps;
}

function parseVisualResolution(
  raw: unknown,
  source: string,
  allowNative: boolean,
  fallback: VisualResolution,
  maximumWidth: number,
  maximumHeight: number,
): VisualResolution {
  if (raw === undefined) return fallback;
  if (allowNative && raw === 'native') return 'native';
  let width: unknown;
  let height: unknown;
  if (typeof raw === 'string') {
    const match = /^(\d+)x(\d+)$/iu.exec(raw.trim());
    width = match?.[1] === undefined ? undefined : Number(match[1]);
    height = match?.[2] === undefined ? undefined : Number(match[2]);
  } else if (isRecordLike(raw)) {
    width = raw['width'];
    height = raw['height'];
  }
  if (
    !Number.isInteger(width) ||
    Number(width) < MIN_VISUAL_WIDTH ||
    Number(width) > maximumWidth ||
    !Number.isInteger(height) ||
    Number(height) < MIN_VISUAL_HEIGHT ||
    Number(height) > maximumHeight
  ) {
    throw new Error(
      `Invalid ${source}: ${JSON.stringify(raw)} (expected ${
        allowNative ? '"native" or ' : ''
      }WIDTHxHEIGHT)`,
    );
  }
  return { width: Number(width), height: Number(height) };
}

function resolveVisualInput(
  env: Record<string, string | undefined>,
  file: Record<string, unknown>,
  configPath: string,
): VisualInputConfig {
  const visualInput = strictObject(
    file['visualInput'],
    'visualInput',
    configPath,
    [
      'source',
      'mode',
      'screenDisplayId',
      'fps',
      'cameraResolution',
      'cameraSnapshotResolution',
      'liveResolution',
      'snapshotResolution',
    ],
  );
  const screenDisplayId =
    visualInput['screenDisplayId'] === undefined
      ? 'primary'
      : visualInput['screenDisplayId'];
  if (!isScreenDisplayId(screenDisplayId)) {
    throw new Error(
      `Invalid "visualInput.screenDisplayId" in ${configPath}: expected "primary" or a display UUID`,
    );
  }
  const source =
    str(env['QWEN_LIVE_HARNESS_VISUAL_SOURCE']) ??
    visualInput['source'] ??
    'screen';
  if (source !== 'screen' && source !== 'camera') {
    throw new Error(
      `Invalid visual input source: ${JSON.stringify(source)} (expected "screen" or "camera")`,
    );
  }
  const mode =
    str(env['QWEN_LIVE_HARNESS_VISUAL_MODE']) ??
    visualInput['mode'] ??
    'on-demand';
  if (mode !== 'on-demand' && mode !== 'live-feed') {
    throw new Error(
      `Invalid visual input mode: ${JSON.stringify(mode)} (expected "on-demand" or "live-feed")`,
    );
  }
  const cameraEnvironment = str(env['QWEN_LIVE_HARNESS_CAMERA_RESOLUTION']);
  const cameraSnapshotEnvironment = str(
    env['QWEN_LIVE_HARNESS_CAMERA_SNAPSHOT_RESOLUTION'],
  );
  const liveEnvironment = str(env['QWEN_LIVE_HARNESS_VISUAL_LIVE_RESOLUTION']);
  const snapshotEnvironment = str(
    env['QWEN_LIVE_HARNESS_VISUAL_SNAPSHOT_RESOLUTION'],
  );
  const cameraResolution = parseVisualResolution(
    cameraEnvironment ?? visualInput['cameraResolution'],
    cameraEnvironment === undefined
      ? `"visualInput.cameraResolution" in ${configPath}`
      : 'QWEN_LIVE_HARNESS_CAMERA_RESOLUTION',
    false,
    { width: DEFAULT_LIVE_WIDTH, height: DEFAULT_LIVE_HEIGHT },
    MAX_LIVE_WIDTH,
    MAX_LIVE_HEIGHT,
  );
  if (cameraResolution === 'native') {
    throw new Error('Camera resolution cannot be native.');
  }
  const cameraSnapshotResolution = parseVisualResolution(
    cameraSnapshotEnvironment ?? visualInput['cameraSnapshotResolution'],
    cameraSnapshotEnvironment === undefined
      ? `"visualInput.cameraSnapshotResolution" in ${configPath}`
      : 'QWEN_LIVE_HARNESS_CAMERA_SNAPSHOT_RESOLUTION',
    true,
    'native',
    MAX_SNAPSHOT_WIDTH,
    MAX_SNAPSHOT_HEIGHT,
  );
  const liveResolution = parseVisualResolution(
    liveEnvironment ?? visualInput['liveResolution'],
    liveEnvironment === undefined
      ? `"visualInput.liveResolution" in ${configPath}`
      : 'QWEN_LIVE_HARNESS_VISUAL_LIVE_RESOLUTION',
    false,
    { width: DEFAULT_LIVE_WIDTH, height: DEFAULT_LIVE_HEIGHT },
    MAX_LIVE_WIDTH,
    MAX_LIVE_HEIGHT,
  );
  if (liveResolution === 'native') {
    throw new Error('Live Feed resolution cannot be native.');
  }
  const snapshotResolution = parseVisualResolution(
    snapshotEnvironment ?? visualInput['snapshotResolution'],
    snapshotEnvironment === undefined
      ? `"visualInput.snapshotResolution" in ${configPath}`
      : 'QWEN_LIVE_HARNESS_VISUAL_SNAPSHOT_RESOLUTION',
    true,
    'native',
    MAX_SNAPSHOT_WIDTH,
    MAX_SNAPSHOT_HEIGHT,
  );
  return {
    source,
    mode,
    screenDisplayId: screenDisplayId.toLowerCase(),
    fps: resolveVisualFps(env, visualInput, configPath),
    cameraResolution,
    cameraSnapshotResolution,
    liveResolution,
    snapshotResolution,
  };
}

const PROACTIVE_KEYS = [
  'enabled',
  'monitor',
  'scheduler',
  'vision',
  'audio',
] as const;
const PROACTIVE_MONITOR_KEYS = [
  'sessionRecycleEvals',
  'representationCompact',
] as const;
const PROACTIVE_SCHEDULER_KEYS = [
  'evalIntervalSec',
  'maxConcurrentTasks',
  'maxFailuresPerTask',
  'repeat',
] as const;
const PROACTIVE_REPEAT_KEYS = [
  'cooldownSec',
  'maxWaitTtsSec',
  'clearBufferOnResume',
] as const;
const PROACTIVE_VISION_KEYS = ['windowSizeSec', 'minEvalDurationSec'] as const;
const PROACTIVE_AUDIO_KEYS = ['windowSizeSec', 'minEvalDurationSec'] as const;

function strictObject(
  raw: unknown,
  path: string,
  configPath: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!isRecordLike(raw)) {
    throw new Error(`Invalid "${path}" in ${configPath}: expected an object`);
  }
  const unknownKeys = Object.keys(raw).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Invalid "${path}" in ${configPath}: unknown key(s): ${unknownKeys
        .map((key) => JSON.stringify(key))
        .join(', ')}`,
    );
  }
  return raw;
}

function proactiveNumber(
  raw: unknown,
  fallback: number,
  path: string,
  configPath: string,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  if (raw === undefined) return fallback;
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    (integer && !Number.isInteger(raw)) ||
    raw < minimum ||
    raw > maximum
  ) {
    throw new Error(
      `Invalid "${path}" in ${configPath}: ${JSON.stringify(raw)} ` +
        `(expected ${integer ? 'an integer' : 'a finite number'} from ${minimum} to ${maximum})`,
    );
  }
  return raw;
}

function proactiveBoolean(
  raw: unknown,
  fallback: boolean,
  path: string,
  configPath: string,
): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    throw new Error(
      `Invalid "${path}" in ${configPath}: ${JSON.stringify(raw)} (expected a boolean)`,
    );
  }
  return raw;
}

function resolveProactiveEnabled(
  env: Record<string, string | undefined>,
  proactive: Record<string, unknown>,
  configPath: string,
): boolean {
  const environment = env['QWEN_LIVE_HARNESS_PROACTIVE_ENABLED'];
  if (environment !== undefined) {
    switch (environment.trim()) {
      case 'true':
      case '1':
        return true;
      case 'false':
      case '0':
        return false;
      default:
        throw new Error(
          `Invalid QWEN_LIVE_HARNESS_PROACTIVE_ENABLED: ${JSON.stringify(environment)} ` +
            '(expected true, false, 1, or 0)',
        );
    }
  }
  return proactiveBoolean(
    proactive['enabled'],
    DEFAULT_PROACTIVE_CONFIG.enabled,
    'proactive.enabled',
    configPath,
  );
}

function resolveProactive(
  env: Record<string, string | undefined>,
  file: Record<string, unknown>,
  configPath: string,
): ProactiveConfig {
  const proactive = strictObject(
    file['proactive'],
    'proactive',
    configPath,
    PROACTIVE_KEYS,
  );
  const removed: string[] = [];
  if (
    isRecordLike(proactive['monitor']) &&
    Object.hasOwn(proactive['monitor'], 'chunkDurationSec')
  )
    removed.push('proactive.monitor.chunkDurationSec');
  if (
    isRecordLike(proactive['vision']) &&
    Object.hasOwn(proactive['vision'], 'fps')
  )
    removed.push('proactive.vision.fps');
  if (removed.length) {
    throw new Error(
      `Remove ${removed.map((field) => `"${field}"`).join(' and ')} from ${configPath}: Proactive media input is fixed at ${PROACTIVE_MONITOR_FPS} FPS and ${PROACTIVE_MONITOR_CHUNK_DURATION_SEC}-second chunks; these fields are no longer configurable.`,
    );
  }
  const monitor = strictObject(
    proactive['monitor'],
    'proactive.monitor',
    configPath,
    PROACTIVE_MONITOR_KEYS,
  );
  const scheduler = strictObject(
    proactive['scheduler'],
    'proactive.scheduler',
    configPath,
    PROACTIVE_SCHEDULER_KEYS,
  );
  const repeat = strictObject(
    scheduler['repeat'],
    'proactive.scheduler.repeat',
    configPath,
    PROACTIVE_REPEAT_KEYS,
  );
  const vision = strictObject(
    proactive['vision'],
    'proactive.vision',
    configPath,
    PROACTIVE_VISION_KEYS,
  );
  const audio = strictObject(
    proactive['audio'],
    'proactive.audio',
    configPath,
    PROACTIVE_AUDIO_KEYS,
  );

  const visionWindowSizeSec = proactiveNumber(
    vision['windowSizeSec'],
    DEFAULT_PROACTIVE_CONFIG.vision.windowSizeSec,
    'proactive.vision.windowSizeSec',
    configPath,
    0.1,
    86_400,
  );
  const visionMinEvalDurationSec = proactiveNumber(
    vision['minEvalDurationSec'],
    DEFAULT_PROACTIVE_CONFIG.vision.minEvalDurationSec,
    'proactive.vision.minEvalDurationSec',
    configPath,
    0,
    86_400,
  );
  if (visionMinEvalDurationSec > visionWindowSizeSec) {
    throw new Error(
      `Invalid "proactive.vision.minEvalDurationSec" in ${configPath}: ` +
        'must not exceed proactive.vision.windowSizeSec',
    );
  }

  const audioWindowSizeSec = proactiveNumber(
    audio['windowSizeSec'],
    DEFAULT_PROACTIVE_CONFIG.audio.windowSizeSec,
    'proactive.audio.windowSizeSec',
    configPath,
    0.1,
    86_400,
  );
  const audioMinEvalDurationSec = proactiveNumber(
    audio['minEvalDurationSec'],
    DEFAULT_PROACTIVE_CONFIG.audio.minEvalDurationSec,
    'proactive.audio.minEvalDurationSec',
    configPath,
    0,
    86_400,
  );
  if (audioMinEvalDurationSec > audioWindowSizeSec) {
    throw new Error(
      `Invalid "proactive.audio.minEvalDurationSec" in ${configPath}: ` +
        'must not exceed proactive.audio.windowSizeSec',
    );
  }

  const representationCompact =
    monitor['representationCompact'] === undefined
      ? DEFAULT_PROACTIVE_CONFIG.monitor.representationCompact
      : monitor['representationCompact'];
  if (representationCompact !== 'none' && representationCompact !== 'normal') {
    throw new Error(
      `Invalid "proactive.monitor.representationCompact" in ${configPath}: ` +
        `${JSON.stringify(representationCompact)} (expected "none" or "normal")`,
    );
  }

  for (const [modality, windowSizeSec] of [
    ['vision', visionWindowSizeSec],
    ['audio', audioWindowSizeSec],
  ] as const) {
    if (windowSizeSec < PROACTIVE_MONITOR_CHUNK_DURATION_SEC) {
      throw new Error(
        `Invalid "proactive.${modality}.windowSizeSec" in ${configPath}: ` +
          `must cover the fixed ${PROACTIVE_MONITOR_CHUNK_DURATION_SEC}-second Proactive media chunk.`,
      );
    }
  }

  return {
    enabled: resolveProactiveEnabled(env, proactive, configPath),
    monitor: {
      representationCompact,
      sessionRecycleEvals: proactiveNumber(
        monitor['sessionRecycleEvals'],
        DEFAULT_PROACTIVE_CONFIG.monitor.sessionRecycleEvals,
        'proactive.monitor.sessionRecycleEvals',
        configPath,
        1,
        1_000_000,
        true,
      ),
    },
    scheduler: {
      evalIntervalSec: proactiveNumber(
        scheduler['evalIntervalSec'],
        DEFAULT_PROACTIVE_CONFIG.scheduler.evalIntervalSec,
        'proactive.scheduler.evalIntervalSec',
        configPath,
        0.05,
        3_600,
      ),
      ...(scheduler['maxConcurrentTasks'] !== undefined
        ? {
            maxConcurrentTasks: proactiveNumber(
              scheduler['maxConcurrentTasks'],
              4,
              'proactive.scheduler.maxConcurrentTasks',
              configPath,
              1,
              1_024,
              true,
            ),
          }
        : {}),
      maxFailuresPerTask: proactiveNumber(
        scheduler['maxFailuresPerTask'],
        DEFAULT_PROACTIVE_CONFIG.scheduler.maxFailuresPerTask,
        'proactive.scheduler.maxFailuresPerTask',
        configPath,
        1,
        1_000_000,
        true,
      ),
      repeat: {
        cooldownSec: proactiveNumber(
          repeat['cooldownSec'],
          DEFAULT_PROACTIVE_CONFIG.scheduler.repeat.cooldownSec,
          'proactive.scheduler.repeat.cooldownSec',
          configPath,
          0,
          86_400,
        ),
        maxWaitTtsSec: proactiveNumber(
          repeat['maxWaitTtsSec'],
          DEFAULT_PROACTIVE_CONFIG.scheduler.repeat.maxWaitTtsSec,
          'proactive.scheduler.repeat.maxWaitTtsSec',
          configPath,
          0.1,
          86_400,
        ),
        clearBufferOnResume: proactiveBoolean(
          repeat['clearBufferOnResume'],
          DEFAULT_PROACTIVE_CONFIG.scheduler.repeat.clearBufferOnResume,
          'proactive.scheduler.repeat.clearBufferOnResume',
          configPath,
        ),
      },
    },
    vision: {
      windowSizeSec: visionWindowSizeSec,
      minEvalDurationSec: visionMinEvalDurationSec,
    },
    audio: {
      windowSizeSec: audioWindowSizeSec,
      minEvalDurationSec: audioMinEvalDurationSec,
    },
  };
}

/**
 * Validate one raw backend entry (already known to be an object) from the
 * named source. Kind-mismatched keys fail loud: a silently ignored
 * `command` on a qwen-code entry is a config mistake, not a default.
 */
function parseBackend(
  raw: Record<string, unknown>,
  source: string,
  index: number,
  env: Record<string, string | undefined>,
): BackendConfig {
  const where = `${source} entry #${index + 1}`;
  const name = str(raw['name']);
  if (!name || !BACKEND_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid backend name in ${where}: ${JSON.stringify(raw['name'])} ` +
        '(expected up to 32 chars of letters, digits, "_" or "-", no ":")',
    );
  }
  const kind = raw['kind'];
  if (kind === 'qwen-code') {
    for (const banned of ['command', 'args', 'env', 'cwd', 'sessionMode']) {
      if (raw[banned] !== undefined) {
        throw new Error(
          `"${banned}" is not valid for kind qwen-code (${where})`,
        );
      }
    }
    let managedServe: { command: string } | undefined;
    if (raw['managedServe'] !== undefined) {
      const managed = raw['managedServe'];
      if (
        !isRecordLike(managed) ||
        Object.keys(managed).some((key) => key !== 'command') ||
        typeof managed['command'] !== 'string' ||
        !managed['command'].trim() ||
        /\p{C}/u.test(managed['command'])
      ) {
        throw new Error(
          `Invalid managedServe in ${where}: expected { command: string }`,
        );
      }
      if (
        ['serveUrl', 'baseUrl', 'token'].some((key) => raw[key] !== undefined)
      ) {
        throw new Error(
          `Invalid managedServe in ${where}: address and token are assigned automatically`,
        );
      }
      managedServe = { command: managed['command'].trim() };
    }
    const baseUrl = managedServe
      ? 'http://127.0.0.1:0'
      : (str(raw['serveUrl'] ?? raw['baseUrl']) ?? DEFAULT_SERVE_URL);
    const token = str(raw['token']);
    let peerDiscovery:
      | { qwenHome: string; controllerToken?: string; reports?: boolean }
      | undefined;
    if (raw['peerDiscovery'] !== undefined) {
      const peer = raw['peerDiscovery'];
      if (
        !isRecordLike(peer) ||
        Object.keys(peer).some(
          (key) =>
            ![
              'qwenHome',
              'controllerToken',
              'controllerTokenEnv',
              'reports',
            ].includes(key),
        ) ||
        typeof peer['qwenHome'] !== 'string' ||
        !peer['qwenHome'].trim()
      ) {
        throw new Error(
          `Invalid peerDiscovery in ${where}: expected { qwenHome: string }`,
        );
      }
      peerDiscovery = { qwenHome: peer['qwenHome'].trim() };
      if (peer['reports'] !== undefined) {
        if (typeof peer['reports'] !== 'boolean') {
          throw new Error(
            `Invalid peerDiscovery in ${where}: reports must be a boolean`,
          );
        }
        peerDiscovery.reports = peer['reports'];
      }
      if (
        peer['controllerToken'] !== undefined &&
        peer['controllerTokenEnv'] !== undefined
      ) {
        throw new Error(
          `Invalid peerDiscovery in ${where}: choose controllerToken or controllerTokenEnv, not both`,
        );
      }
      let controllerToken: unknown = peer['controllerToken'];
      if (peer['controllerTokenEnv'] !== undefined) {
        const key = peer['controllerTokenEnv'];
        if (
          typeof key !== 'string' ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)
        ) {
          throw new Error(
            `Invalid peerDiscovery in ${where}: controllerTokenEnv must name an environment variable`,
          );
        }
        controllerToken = env[key];
        if (controllerToken === undefined) {
          throw new Error(
            `Invalid peerDiscovery in ${where}: the controller token environment variable is unset`,
          );
        }
      }
      if (controllerToken !== undefined) {
        if (
          typeof controllerToken !== 'string' ||
          !/^qpc_[0-9a-f]{64}$/.test(controllerToken)
        ) {
          throw new Error(
            `Invalid peerDiscovery in ${where}: controller token must be minted by qwen sessions controllers add`,
          );
        }
        peerDiscovery.controllerToken = controllerToken;
      }
    }
    return {
      name,
      kind,
      baseUrl,
      ...(managedServe ? { managedServe } : {}),
      ...(token ? { token } : {}),
      ...(peerDiscovery ? { peerDiscovery } : {}),
      isDefault: raw['default'] === true,
    };
  }
  if (kind === 'acp') {
    for (const banned of [
      'serveUrl',
      'baseUrl',
      'token',
      'peerDiscovery',
      'managedServe',
    ]) {
      if (raw[banned] !== undefined) {
        throw new Error(`"${banned}" is not valid for kind acp (${where})`);
      }
    }
    const command = str(raw['command']);
    if (!command) {
      throw new Error(`Invalid acp backend "command" in ${where}`);
    }
    const rawArgs = raw['args'] ?? [];
    if (
      !Array.isArray(rawArgs) ||
      rawArgs.some((arg) => typeof arg !== 'string')
    ) {
      throw new Error(
        `Invalid acp backend "args" in ${where}: expected string[]`,
      );
    }
    const rawEnv = raw['env'] ?? {};
    if (!isRecordLike(rawEnv)) {
      throw new Error(
        `Invalid acp backend "env" in ${where}: expected an object`,
      );
    }
    for (const [key, value] of Object.entries(rawEnv)) {
      if (typeof value !== 'string') {
        throw new Error(
          `Invalid acp backend "env" value for "${key}" in ${where}: expected a string`,
        );
      }
    }
    const cwd = pathStr(raw['cwd']);
    const sessionMode = str(raw['sessionMode']);
    if (raw['sessionMode'] !== undefined && !sessionMode) {
      throw new Error(
        `Invalid acp backend "sessionMode" in ${where}: expected a non-empty string`,
      );
    }
    if (sessionMode && !SESSION_MODE_PATTERN.test(sessionMode)) {
      throw new Error(
        `Invalid acp backend "sessionMode" in ${where}: ` +
          `${JSON.stringify(sessionMode)} (expected up to 64 chars of letters, ` +
          'digits, "_" or "-")',
      );
    }
    return {
      name,
      kind,
      command,
      args: rawArgs as string[],
      env: rawEnv as Record<string, string>,
      ...(cwd ? { cwd } : {}),
      ...(sessionMode ? { sessionMode } : {}),
      isDefault: raw['default'] === true,
    };
  }
  throw new Error(
    `Invalid backend "kind" in ${where}: ${JSON.stringify(kind)} ` +
      '(expected "qwen-code" or "acp")',
  );
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shared with incremental setup so saved backends use the runtime contract. */
export function parseBackends(
  env: Record<string, string | undefined>,
  file: Record<string, unknown>,
  configPath: string,
): BackendConfig[] {
  let entries: unknown;
  let source: string;
  const envBackends = str(env['QWEN_LIVE_HARNESS_BACKENDS']);
  if (envBackends !== undefined) {
    try {
      entries = JSON.parse(envBackends);
    } catch (error) {
      throw new Error(
        `Invalid QWEN_LIVE_HARNESS_BACKENDS: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    source = 'QWEN_LIVE_HARNESS_BACKENDS';
  } else if (file['backends'] !== undefined) {
    entries = file['backends'];
    source = configPath;
  } else {
    // Legacy single-backend spellings synthesize the implicit qwen-code
    // backend so existing configs (and the e2e harness) keep working.
    const baseUrl =
      str(env['QWEN_LIVE_HARNESS_SERVE_URL']) ??
      str(file['serveUrl']) ??
      DEFAULT_SERVE_URL;
    const token = str(env['QWEN_SERVER_TOKEN']) ?? str(file['serveToken']);
    return [
      {
        name: 'qwen-code',
        kind: 'qwen-code',
        baseUrl,
        ...(token ? { token } : {}),
        isDefault: true,
      },
    ];
  }
  if (!Array.isArray(entries)) {
    throw new Error(
      `${source}: "backends" must be an array, got ${JSON.stringify(entries)}`,
    );
  }
  const backends = entries.map((entry, index) => {
    if (!isRecordLike(entry)) {
      throw new Error(`${source} entry #${index + 1} must be an object`);
    }
    return parseBackend(entry, source, index, env);
  });
  const names = new Set<string>();
  for (const backend of backends) {
    const lower = backend.name.toLowerCase();
    if (names.has(lower)) {
      throw new Error(`duplicate backend name '${backend.name}' in ${source}`);
    }
    names.add(lower);
  }
  const defaults = backends.filter((backend) => backend.isDefault);
  if (defaults.length > 1) {
    throw new Error(`${source}: at most one backend may set "default": true`);
  }
  if (defaults.length === 0 && backends.length > 1) {
    throw new Error(
      `${source}: mark one backend "default": true (a single entry is implicitly the default)`,
    );
  }
  if (defaults.length === 0 && backends.length === 1) {
    backends[0] = { ...backends[0], isDefault: true };
  }
  return backends;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): LiveConfig {
  const dataDir = resolveLiveDataDirectory(env);
  const configPath = join(dataDir, 'config.json');
  const file = readConfigFile(configPath);
  const language = resolveLiveLanguage(file['language']);

  const apiKey =
    str(env['DASHSCOPE_API_KEY']) ??
    str(env['QWEN_LIVE_HARNESS_REALTIME_API_KEY']) ??
    str(file['realtimeApiKey']);
  if (!apiKey) {
    throw new Error(
      'A DashScope realtime API key is required: set DASHSCOPE_API_KEY ' +
        `or put "realtimeApiKey" in ${configPath}.`,
    );
  }

  const port = resolvePort(env, file, configPath);
  const visualInput = resolveVisualInput(env, file, configPath);
  const proactive = resolveProactive(env, file, configPath);
  const memory = resolveMemoryConfig(file['memory'], dataDir, configPath);
  const backends = parseBackends(env, file, configPath);

  const voice =
    str(env['QWEN_LIVE_HARNESS_VOICE']) ?? str(file['voice']) ?? 'Tina';
  const defaultCwd =
    pathStr(env['QWEN_LIVE_HARNESS_CWD']) ?? pathStr(file['defaultCwd']);
  const shortcut =
    str(env['QWEN_LIVE_HARNESS_SHORTCUT']) ?? str(file['shortcut']);

  return {
    language,
    realtime: {
      endpoint:
        str(env['QWEN_LIVE_HARNESS_REALTIME_ENDPOINT']) ??
        str(file['realtimeEndpoint']) ??
        DEFAULT_REALTIME_ENDPOINT,
      apiKey,
      model:
        str(env['QWEN_LIVE_HARNESS_REALTIME_MODEL']) ??
        str(file['realtimeModel']) ??
        DEFAULT_REALTIME_MODEL,
      ...(voice ? { voice } : {}),
    },
    backends,
    ...(defaultCwd ? { defaultCwd } : {}),
    dataDir,
    discoveryDir: resolveLiveDiscoveryDirectory(env, file['discoveryDir']),
    ...(shortcut ? { shortcut } : {}),
    visualInput,
    proactive,
    memory,
    port,
  };
}
