/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  ftruncateSync,
  openSync,
  writeSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { request } from 'node:http';
import { isIP } from 'node:net';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import { promisify } from 'node:util';
import type { LiveDiscoveryRecord } from './host/discovery.js';
import { LIVE_HOST_PROTOCOL_VERSION } from './host/types.js';

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;
const STARTUP_TIMEOUT_MS = 60_000;
const executeFile = promisify(execFile);

export type StartupErrorCode =
  | 'runtime_missing'
  | 'runtime_invalid'
  | 'runtime_unavailable'
  | 'config_missing'
  | 'discovery_invalid'
  | 'daemon_unresponsive'
  | 'daemon_mismatch'
  | 'daemon_start_failed'
  | 'startup_timeout'
  | 'startup_aborted'
  | 'startup_cleanup_failed'
  | 'startup_busy';

/** A stable code keeps shared process-management errors localizable in both UIs. */
export class StartupError extends Error {
  readonly logPath?: string;
  /** Kept only in memory so Quit can retry cleaning up this exact owned child. */
  readonly retryCleanup?: () => Promise<void>;

  constructor(
    readonly code: StartupErrorCode,
    options: {
      cause?: unknown;
      logPath?: string;
      retryCleanup?: () => Promise<void>;
    } = {},
  ) {
    super(code, { cause: options.cause });
    this.name = 'StartupError';
    this.logPath = options.logPath;
    this.retryCleanup = options.retryCleanup;
  }
}

export interface RuntimeRegistration {
  schemaVersion: 1;
  nodePath: string;
  cliPath: string;
  version: string;
  dataDir: string;
  discoveryDir: string;
  cwd: string;
  path: string;
}

export interface RegisterRuntimeOptions {
  nodePath: string;
  cliPath: string;
  version: string;
  dataDir: string;
  discoveryDir: string;
  cwd?: string;
  path?: string;
}

export interface StartupOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ReadyDaemon {
  kind: 'ready';
  record: LiveDiscoveryRecord;
  version: string;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StartupError('startup_aborted');
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOwned(stat: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

async function inspectDirectory(
  directory: string,
  privateMode: boolean,
): Promise<void> {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      (!isOwned(stat) || (privateMode && (stat.mode & 0o777) !== 0o700)))
  )
    throw new StartupError('discovery_invalid');
}

async function prepareRunDirectory(discoveryPath: string): Promise<string> {
  const directory = dirname(resolve(discoveryPath));
  const base = dirname(directory);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  await inspectDirectory(base, false);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await inspectDirectory(directory, true);
  return directory;
}

/** Open without following a substituted symlink, then verify the opened inode. */
async function readPrivateJson(
  filePath: string,
  code: StartupErrorCode,
  metadataOnly = false,
): Promise<unknown | undefined> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new StartupError(code, { cause: error });
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (!metadataOnly && (stat.size < 1 || stat.size > MAX_RECORD_BYTES)) ||
    (process.platform !== 'win32' &&
      (!isOwned(stat) || (stat.mode & 0o777) !== 0o600))
  )
    throw new StartupError(code);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const opened = await handle.stat();
    if (
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      opened.size !== stat.size ||
      opened.mode !== stat.mode ||
      opened.nlink !== 1 ||
      !isOwned(opened)
    ) {
      throw new StartupError(code);
    }
    if (metadataOnly) return undefined;
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } catch (error) {
    throw new StartupError(code, { cause: error });
  } finally {
    await handle?.close();
  }
}

export function getRuntimeRegistrationPath(discoveryPath: string): string {
  return join(dirname(resolve(discoveryPath)), 'runtime.json');
}

function parseRuntime(value: unknown): RuntimeRegistration {
  if (!isObject(value) || value['schemaVersion'] !== 1)
    throw new StartupError('runtime_invalid');
  for (const key of ['nodePath', 'cliPath', 'dataDir', 'discoveryDir', 'cwd']) {
    if (
      typeof value[key] !== 'string' ||
      !isAbsolute(value[key]) ||
      value[key].includes('\0')
    )
      throw new StartupError('runtime_invalid');
  }
  if (
    typeof value['version'] !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(value['version']) ||
    typeof value['path'] !== 'string' ||
    value['path'].includes('\0')
  ) {
    throw new StartupError('runtime_invalid');
  }
  // Copy only the allowed fields; future environment variables and credentials
  // cannot accidentally become part of the persisted launch contract.
  return {
    schemaVersion: 1,
    nodePath: value['nodePath'] as string,
    cliPath: value['cliPath'] as string,
    dataDir: value['dataDir'] as string,
    discoveryDir: value['discoveryDir'] as string,
    cwd: value['cwd'] as string,
    version: value['version'],
    path: value['path'],
  };
}

export async function registerRuntime(
  options: RegisterRuntimeOptions,
): Promise<RuntimeRegistration> {
  const registration = parseRuntime({
    schemaVersion: 1,
    nodePath: await fs.realpath(options.nodePath),
    cliPath: await fs.realpath(options.cliPath),
    version: options.version,
    dataDir: resolve(options.dataDir),
    discoveryDir: resolve(options.discoveryDir),
    cwd: resolve(options.cwd ?? process.cwd()),
    path: options.path ?? process.env['PATH'] ?? dirname(options.nodePath),
  });
  await validateRuntimePackage(registration);
  const discoveryPath = join(registration.discoveryDir, 'run', 'daemon.json');
  const directory = await prepareRunDirectory(discoveryPath);
  const target = getRuntimeRegistrationPath(discoveryPath);
  // A normal CLI launch repairs an interrupted/corrupt registration, while
  // retaining the same ownership and symlink protections as a read.
  await readPrivateJson(target, 'runtime_invalid', true);
  const temporary = join(directory, `.runtime-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(registration, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, target);
  } finally {
    await handle.close();
    await fs.unlink(temporary).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
  }
  return registration;
}

function parseDiscovery(value: unknown): LiveDiscoveryRecord {
  if (
    !isObject(value) ||
    typeof value['url'] !== 'string' ||
    !Number.isSafeInteger(value['pid']) ||
    (value['pid'] as number) <= 0 ||
    !Number.isSafeInteger(value['protocolVersion']) ||
    typeof value['instanceNonce'] !== 'string' ||
    !/^[\w-]{16,256}$/u.test(value['instanceNonce']) ||
    typeof value['token'] !== 'string' ||
    !/^[\x21-\x7e]{1,4096}$/u.test(value['token'])
  )
    throw new StartupError('discovery_invalid');
  let url: URL;
  try {
    url = new URL(value['url']);
  } catch {
    throw new StartupError('discovery_invalid');
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  if (
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(
      hostname === 'localhost' ||
      hostname === '::1' ||
      (isIP(hostname) === 4 && hostname.startsWith('127.'))
    )
  ) {
    throw new StartupError('discovery_invalid');
  }
  return value as unknown as LiveDiscoveryRecord;
}

async function requestInstance(
  record: LiveDiscoveryRecord,
  options: StartupOptions,
): Promise<unknown> {
  const url = new URL('/live/instance', record.url);
  // Never let a hosts-file/DNS override send the private bearer token off-box.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return new Promise((resolveRequest, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        signal: options.signal,
        headers: {
          authorization: `Bearer ${record.token}`,
          'x-qwen-live-harness-nonce': record.instanceNonce,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        if (response.statusCode !== 200) {
          response.resume();
          reject(new StartupError('daemon_mismatch'));
          return;
        }
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RECORD_BYTES) {
            req.destroy(new StartupError('daemon_mismatch'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            resolveRequest(
              JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
            );
          } catch {
            reject(new StartupError('daemon_mismatch'));
          }
        });
        response.on('error', reject);
      },
    );
    const timer = setTimeout(
      () => req.destroy(new StartupError('daemon_unresponsive')),
      options.timeoutMs ?? 1_500,
    );
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
}

export async function probeDaemon(
  discoveryPath: string,
  options: StartupOptions & { expectedVersion?: string } = {},
): Promise<ReadyDaemon | { kind: 'missing' }> {
  assertNotAborted(options.signal);
  try {
    await inspectDirectory(dirname(resolve(discoveryPath)), true);
    await inspectDirectory(dirname(dirname(resolve(discoveryPath))), false);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' };
    throw error instanceof StartupError
      ? error
      : new StartupError('discovery_invalid', { cause: error });
  }
  const parsed = await readPrivateJson(discoveryPath, 'discovery_invalid');
  if (parsed === undefined) return { kind: 'missing' };
  const record = parseDiscovery(parsed);
  if (!processIsAlive(record.pid)) return { kind: 'missing' };
  if (record.protocolVersion !== LIVE_HOST_PROTOCOL_VERSION)
    throw new StartupError('daemon_mismatch');
  let instance: unknown;
  try {
    instance = await requestInstance(record, options);
  } catch (error) {
    assertNotAborted(options.signal);
    if (error instanceof StartupError) throw error;
    throw new StartupError('daemon_unresponsive', { cause: error });
  }
  if (
    !isObject(instance) ||
    instance['pid'] !== record.pid ||
    instance['instanceNonce'] !== record.instanceNonce ||
    instance['protocolVersion'] !== LIVE_HOST_PROTOCOL_VERSION ||
    typeof instance['version'] !== 'string' ||
    (options.expectedVersion !== undefined &&
      instance['version'] !== options.expectedVersion)
  ) {
    throw new StartupError('daemon_mismatch');
  }
  return { kind: 'ready', record, version: instance['version'] };
}

async function delay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  assertNotAborted(signal);
  await new Promise<void>((resolveDelay, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new StartupError('startup_aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolveDelay();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Only a CLI daemon owner takes this lock; the Host never holds it over spawn. */
export async function withDaemonStartupLock<T>(
  discoveryPath: string,
  callback: () => Promise<T>,
  options: StartupOptions = {},
): Promise<T> {
  assertNotAborted(options.signal);
  const directory = await prepareRunDirectory(discoveryPath);
  const lockPath = join(directory, '.startup.lock');
  const lockfile = (await import('proper-lockfile')).default;
  const deadline = Date.now() + (options.timeoutMs ?? STARTUP_TIMEOUT_MS);
  let release: (() => Promise<void>) | undefined;
  let compromised: unknown;
  while (!release) {
    assertNotAborted(options.signal);
    try {
      const existing = await fs.lstat(lockPath).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      });
      if (
        existing &&
        (!existing.isDirectory() ||
          existing.isSymbolicLink() ||
          !isOwned(existing))
      )
        throw new StartupError('discovery_invalid');
      // proper-lockfile indexes ownership by target, not lockfilePath. The
      // discovery writer independently locks `directory`; sharing its target
      // would overwrite this in-process owner and break release after publish.
      release = await lockfile.lock(join(directory, '.startup-owner'), {
        realpath: false,
        lockfilePath: lockPath,
        stale: 30_000,
        update: 5_000,
        retries: 0,
        onCompromised: (error) => {
          compromised = error;
        },
      });
    } catch (error) {
      if (errorCode(error) !== 'ELOCKED') throw error;
      if (Date.now() >= deadline) throw new StartupError('startup_busy');
      await delay(
        Math.min(100, Math.max(1, deadline - Date.now())),
        options.signal,
      );
    }
  }
  try {
    assertNotAborted(options.signal);
    const result = await callback();
    if (compromised)
      throw new StartupError('startup_busy', { cause: compromised });
    return result;
  } finally {
    await release();
  }
}

async function validateRuntimePackage(
  registration: RuntimeRegistration,
): Promise<void> {
  try {
    const node = await fs.stat(registration.nodePath);
    if (
      !node.isFile() ||
      !/^node(?:\.exe)?$/iu.test(basename(registration.nodePath))
    )
      throw new Error('Invalid Node executable');
    await fs.access(registration.nodePath, constants.X_OK);
    const cliPath = await fs.realpath(registration.cliPath);
    if (!(await fs.stat(cliPath)).isFile())
      throw new Error('Invalid CLI entry');
    const packageDirectory = dirname(dirname(cliPath));
    const manifest = JSON.parse(
      await fs.readFile(join(packageDirectory, 'package.json'), 'utf8'),
    ) as unknown;
    if (
      !isObject(manifest) ||
      manifest['name'] !== 'qwen-live-harness' ||
      manifest['version'] !== registration.version ||
      !isObject(manifest['bin']) ||
      manifest['bin']['qwen-live-harness'] !== 'dist/index.js' ||
      cliPath !==
        (await fs.realpath(join(packageDirectory, 'dist', 'index.js')))
    )
      throw new Error('Invalid CLI package');
    const cwd = await fs.stat(registration.cwd);
    if (!cwd.isDirectory()) throw new Error('Invalid working directory');
  } catch (error) {
    throw new StartupError('runtime_unavailable', { cause: error });
  }
}

/** Preserve backend credentials already in this process, but never persist them. */
function childEnvironment(
  registration: RuntimeRegistration,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:ELECTRON|NODE_|DYLD_|LD_|npm_)/iu.test(key)) continue;
    env[key] = value;
  }
  env['PATH'] = [dirname(registration.nodePath), registration.path]
    .filter(Boolean)
    .join(delimiter);
  env['QWEN_LIVE_HARNESS_DATA_DIR'] = registration.dataDir;
  env['QWEN_LIVE_HARNESS_DISCOVERY_DIR'] = registration.discoveryDir;
  return env;
}

async function createStartupLog(directory: string): Promise<{
  path: string;
  write: (chunk: Buffer) => void;
  close: () => void;
}> {
  const logs = join(directory, 'logs');
  await fs.mkdir(logs, { recursive: true, mode: 0o700 });
  await inspectDirectory(logs, true);
  const logPath = join(
    logs,
    `daemon-startup-${Date.now()}-${randomUUID()}.log`,
  );
  const fd = openSync(logPath, 'wx', 0o600);
  // Prune after creation so simultaneous desktop launches cannot each see
  // four old files, then leave six. Another launch may already prune a file.
  try {
    const old = await Promise.all(
      (await fs.readdir(logs))
        .filter((name) => /^daemon-startup-\d+-[\w-]+\.log$/u.test(name))
        .map(async (name) => ({
          path: join(logs, name),
          stat: await fs.lstat(join(logs, name)).catch((error: unknown) => {
            if (errorCode(error) === 'ENOENT') return undefined;
            throw error;
          }),
        })),
    );
    for (const entry of old
      .filter(
        (
          entry,
        ): entry is { path: string; stat: NonNullable<typeof entry.stat> } =>
          Boolean(
            entry.stat?.isFile() &&
            !entry.stat.isSymbolicLink() &&
            entry.stat.nlink === 1 &&
            isOwned(entry.stat),
          ),
      )
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(5))
      await fs.unlink(entry.path).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let closed = false;
  let bytes = 0;
  return {
    path: logPath,
    write: (chunk) => {
      if (closed) return;
      try {
        // A fixed-size rolling file avoids an unattended debug session filling disk.
        if (bytes + chunk.length > MAX_LOG_BYTES) {
          ftruncateSync(fd, 0);
          bytes = 0;
        }
        const data = chunk.subarray(Math.max(0, chunk.length - MAX_LOG_BYTES));
        bytes += writeSync(fd, data, 0, data.length, bytes);
      } catch {
        /* A logging failure must not interrupt daemon audio or startup. */
      }
    },
    close: () => {
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
    },
  };
}

interface OwnedChildState {
  /** Once our detached group disappears, never signal a later reuse of its PID. */
  groupGone: boolean;
}

function ownGroupIsAlive(child: ChildProcess, state: OwnedChildState): boolean {
  if (!child.pid || state.groupGone) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') {
      state.groupGone = true;
      return false;
    }
    // EPERM is not proof of disappearance. Keep waiting for the group to be
    // reaped; only ESRCH proves that all members are gone.
    if (errorCode(error) === 'EPERM') return true;
    throw error;
  }
}

async function stopOwnChild(
  child: ChildProcess,
  state: OwnedChildState,
): Promise<void> {
  if (!child.pid) return;
  const posixGroup = process.platform !== 'win32';
  const alive = () =>
    posixGroup
      ? ownGroupIsAlive(child, state)
      : child.exitCode === null && child.signalCode === null;
  const signal = (name: NodeJS.Signals) => {
    if (!alive()) return;
    try {
      // Only this launcher creates the detached group whose ID is child.pid.
      // Cleanup includes backend descendants after the leader has already exited.
      if (posixGroup) process.kill(-child.pid!, name);
      else child.kill(name);
    } catch (error) {
      if (errorCode(error) === 'ESRCH') state.groupGone = true;
      else if (errorCode(error) === 'EPERM') return;
      else throw error;
    }
  };
  signal('SIGTERM');
  const waitForExit = async (milliseconds: number) => {
    const deadline = Date.now() + milliseconds;
    while (alive() && Date.now() < deadline) await delay(25);
  };
  await waitForExit(5_000);
  if (alive()) {
    signal('SIGKILL');
    await waitForExit(2_000);
  }
  if (alive()) throw new StartupError('startup_cleanup_failed');
}

export async function launchRegisteredDaemon(
  options: StartupOptions & {
    discoveryPath: string;
    expectedVersion: string;
    debug?: boolean;
    startIfMissing?: boolean;
  },
): Promise<ReadyDaemon & { started: boolean; logPath?: string }> {
  assertNotAborted(options.signal);
  const existing = await probeDaemon(options.discoveryPath, {
    expectedVersion: options.expectedVersion,
    signal: options.signal,
  });
  if (existing.kind === 'ready') return { ...existing, started: false };
  if (options.startIfMissing === false)
    throw new StartupError('daemon_unresponsive');
  const raw = await readPrivateJson(
    getRuntimeRegistrationPath(options.discoveryPath),
    'runtime_invalid',
  );
  if (raw === undefined) throw new StartupError('runtime_missing');
  const registration = parseRuntime(raw);
  if (
    registration.version !== options.expectedVersion ||
    resolve(options.discoveryPath) !==
      join(registration.discoveryDir, 'run', 'daemon.json')
  )
    throw new StartupError('runtime_invalid');
  await validateRuntimePackage(registration);
  try {
    const config = await fs.lstat(join(registration.dataDir, 'config.json'));
    if (!config.isFile() || config.isSymbolicLink())
      throw new Error('Missing config');
  } catch (error) {
    throw new StartupError('config_missing', { cause: error });
  }
  const env = childEnvironment(registration);
  try {
    const result = await executeFile(
      registration.nodePath,
      [
        '-p',
        'JSON.stringify({node:process.versions.node,electron:process.versions.electron})',
      ],
      { env, timeout: 5_000, maxBuffer: 4_096, signal: options.signal },
    );
    const runtime = JSON.parse(result.stdout) as {
      node?: string;
      electron?: string;
    };
    const [major = 0, minor = 0] = (runtime.node ?? '').split('.').map(Number);
    if (runtime.electron || major < 22 || (major === 22 && minor < 13))
      throw new Error('Unsupported Node runtime');
  } catch (error) {
    assertNotAborted(options.signal);
    throw new StartupError('runtime_unavailable', { cause: error });
  }
  const directory = await prepareRunDirectory(options.discoveryPath);
  const log = await createStartupLog(directory).catch((error: unknown) => {
    throw new StartupError('daemon_start_failed', { cause: error });
  });
  let child: ChildProcess;
  try {
    child = spawn(
      registration.nodePath,
      [
        registration.cliPath,
        '--daemon-only',
        ...(options.debug ? ['--debug'] : []),
      ],
      {
        cwd: registration.cwd,
        env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    log.close();
    throw new StartupError('daemon_start_failed', {
      cause: error,
      logPath: log.path,
    });
  }
  let childError: unknown;
  let exited = false;
  let exitCode: number | null = null;
  const ownChildState: OwnedChildState = { groupGone: false };
  child.stdout?.on('data', log.write);
  child.stderr?.on('data', log.write);
  child.once('error', (error) => {
    childError = error;
  });
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
    if (process.platform !== 'win32') {
      // Record a vanished group immediately, before its numeric ID can be reused.
      try {
        ownGroupIsAlive(child, ownChildState);
      } catch {
        /* Retain for cleanup retry. */
      }
    }
  });
  child.once('close', log.close);
  child.unref();
  const deadline = Date.now() + (options.timeoutMs ?? STARTUP_TIMEOUT_MS);
  try {
    while (Date.now() < deadline) {
      assertNotAborted(options.signal);
      const state = await probeDaemon(options.discoveryPath, {
        expectedVersion: options.expectedVersion,
        signal: options.signal,
        timeoutMs: Math.min(1_500, Math.max(1, deadline - Date.now())),
      });
      if (state.kind === 'ready')
        return {
          ...state,
          started: state.record.pid === child.pid,
          logPath: log.path,
        };
      if (childError || (exited && exitCode !== 0))
        throw new StartupError('daemon_start_failed', {
          cause: childError,
          logPath: log.path,
        });
      // A concurrent CLI may have won the startup lock. Its loser exits 0;
      // keep waiting for the winner instead of starting another child.
      await delay(
        Math.min(100, Math.max(1, deadline - Date.now())),
        options.signal,
      );
    }
    throw new StartupError('startup_timeout', { logPath: log.path });
  } catch (error) {
    try {
      await stopOwnChild(child, ownChildState);
    } catch (cleanupError) {
      throw new StartupError('startup_cleanup_failed', {
        cause: cleanupError,
        logPath: log.path,
        retryCleanup: () => stopOwnChild(child, ownChildState),
      });
    }
    throw error instanceof StartupError
      ? new StartupError(error.code, { cause: error, logPath: log.path })
      : new StartupError('daemon_start_failed', {
          cause: error,
          logPath: log.path,
        });
  }
}
