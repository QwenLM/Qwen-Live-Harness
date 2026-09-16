/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const execute = promisify(execFile);
const STARTUP_TIMEOUT_MS = 11 * 60_000;

export function parseDevelopmentArgs(args) {
  let command = 'start';
  let debug = false;
  let help = false;
  for (const argument of args) {
    if (argument === '--debug' || argument === '-d') debug = true;
    else if (argument === '--help' || argument === '-h') help = true;
    else if (argument === 'init' && command === 'start') command = 'init';
    else throw new Error(`Unknown development option: ${argument}`);
  }
  return { command, debug, help };
}

async function waitOrAbort(operation, signal) {
  signal?.throwIfAborted();
  if (!signal) return await operation;
  let cancel;
  const cancelled = new Promise((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

async function loadRuntime(root) {
  const packageDirectory = join(root, 'packages', 'qwen-live-harness');
  const moduleAt = (file) =>
    import(pathToFileURL(join(packageDirectory, 'dist', file)).href);
  const [{ loadConfig }, { probeDaemon }, manifest] = await Promise.all([
    moduleAt('config.js'),
    moduleAt('startup.js'),
    readFile(join(packageDirectory, 'package.json'), 'utf8'),
  ]);
  const config = loadConfig();
  return {
    discoveryPath: join(resolve(config.discoveryDir), 'run', 'daemon.json'),
    configPath: join(resolve(config.dataDir), 'config.json'),
    version: JSON.parse(manifest).version,
    probe: probeDaemon,
  };
}

async function findElectron(root) {
  const hostDirectory = join(root, 'packages', 'qwen-live-harness-host');
  const require = createRequire(join(hostDirectory, 'package.json'));
  const packageDirectory = dirname(require.resolve('electron/package.json'));
  const dist = join(packageDirectory, 'dist');
  const relative = (
    await readFile(join(packageDirectory, 'path.txt'), 'utf8')
  ).trim();
  const executable = resolve(dist, relative);
  if (!relative || !executable.startsWith(`${dist}${sep}`))
    throw new Error(
      'The checkout Electron installation is invalid. Run npm ci in packages/qwen-live-harness-host.',
    );
  return executable;
}

async function assertNoHost(executable) {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,comm='], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const running = stdout.split('\n').some((line) => {
    const command = /^\s*\d+\s+(.*)$/u.exec(line)?.[1];
    return (
      command === executable ||
      command?.endsWith(
        '/Qwen Live Harness Host.app/Contents/MacOS/Qwen Live Harness Host',
      ) ||
      command?.includes(
        '/packages/qwen-live-harness-host/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      )
    );
  });
  if (running)
    throw new Error(
      'A Qwen Live Harness Host is already running. Quit it before npm start.',
    );
}

/** Source-only entry: no installed App, installer, trust receipt or runtime registration. */
export async function runDevelopment(options = {}, overrides = {}) {
  const root = options.root ?? repositoryRoot;
  const { command = 'start', debug = false, signal } = options;
  const initializing = command === 'init';
  const deps = {
    platform: process.platform,
    node: process.execPath,
    env: process.env,
    spawn,
    kill: process.kill.bind(process),
    now: Date.now,
    sleep,
    loadRuntime,
    findElectron,
    assertNoHost,
    log: (message) =>
      process.stderr.write(`[qwen-live-harness dev] ${message}\n`),
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    ...overrides,
  };
  if (!initializing && deps.platform !== 'darwin')
    throw new Error('The source Host currently requires macOS.');
  const children = new Set();
  let daemon;
  let host;
  const launch = (
    name,
    command,
    args,
    cwd = root,
    env = deps.env,
    detached = true,
  ) => {
    signal?.throwIfAborted();
    const child = deps.spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached,
      stdio: 'inherit',
    });
    const owned = { child, name, detached, exited: false, groupGone: false };
    owned.result = new Promise((resolveExit) => {
      child.once('error', (error) => resolveExit({ code: 1, error }));
      child.once('exit', (code, exitSignal) => {
        owned.exited = true;
        resolveExit({ code, signal: exitSignal });
      });
    });
    children.add(owned);
    return owned;
  };
  const groupAlive = (owned) => {
    if (owned.groupGone || !owned.child.pid) return false;
    if (!owned.detached && owned.exited) return false;
    try {
      deps.kill(owned.detached ? -owned.child.pid : owned.child.pid, 0);
      return true;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      owned.groupGone = true;
      return false;
    }
  };
  const stop = async (owned) => {
    if (!owned) return;
    const send = (name) => {
      if (!groupAlive(owned)) return;
      try {
        deps.kill(owned.detached ? -owned.child.pid : owned.child.pid, name);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        owned.groupGone = true;
      }
    };
    const wait = async (milliseconds) => {
      const deadline = deps.now() + milliseconds;
      while (groupAlive(owned) && deps.now() < deadline) await deps.sleep(25);
    };
    send('SIGTERM');
    await wait(5_000);
    if (groupAlive(owned)) {
      send('SIGKILL');
      await wait(2_000);
    }
    if (groupAlive(owned))
      throw new Error(
        `Could not stop the ${owned.name} process started by npm start.`,
      );
    children.delete(owned);
  };
  const requireSuccess = (result, name) => {
    if (result.error) throw result.error;
    if (result.code !== 0)
      throw new Error(
        `${name} exited with ${result.signal ?? `code ${result.code}`}.`,
      );
  };
  let failure;
  let failed = false;
  const cleanupErrors = [];
  try {
    let electron;
    if (!initializing) {
      electron = await deps.findElectron(root);
      await deps.assertNoHost(electron);
    }
    for (const task of initializing ? ['build'] : ['build', 'build:host']) {
      deps.log(
        task === 'build'
          ? 'Building daemon from this checkout…'
          : 'Building Host from this checkout…',
      );
      const npmPath = deps.env.npm_execpath;
      const command = npmPath ? deps.node : 'npm';
      const args = [...(npmPath ? [npmPath] : []), 'run', task];
      const building = launch(task, command, args);
      const result = await waitOrAbort(building.result, signal);
      await stop(building);
      requireSuccess(result, task);
    }
    if (initializing) {
      deps.log('Opening source setup…');
      // Keep the wizard in the terminal's foreground group so prompts can read
      // input. Cleanup targets only this child PID, never the terminal's group.
      const wizard = launch(
        'initialization',
        deps.node,
        [
          join(root, 'packages', 'qwen-live-harness', 'dist', 'index.js'),
          'init',
          '--source',
          ...(debug ? ['--debug'] : []),
        ],
        root,
        deps.env,
        false,
      );
      const result = await waitOrAbort(wizard.result, signal);
      await stop(wizard);
      requireSuccess(result, 'initialization');
    } else {
      const runtime = await deps.loadRuntime(root);
      const probe = () =>
        runtime.probe(runtime.discoveryPath, {
          expectedVersion: runtime.version,
          signal,
        });
      if ((await probe()).kind === 'ready')
        throw new Error(
          'A Qwen Live Harness daemon is already running. Quit it before npm start.',
        );
      await deps.assertNoHost(electron);
      deps.log('Starting the source daemon…');
      daemon = launch('daemon', deps.node, [
        join(root, 'packages', 'qwen-live-harness', 'dist', 'index.js'),
        '--daemon-only',
        ...(debug ? ['--debug'] : []),
      ]);
      const exited = daemon.result.then((result) => {
        requireSuccess(result, 'daemon');
        throw new Error('The source daemon exited before becoming ready.');
      });
      // Observe an early exit even when an abort or probe error wins the race.
      void exited.catch(() => undefined);
      const deadline = deps.now() + deps.startupTimeoutMs;
      let owner;
      while (!owner) {
        signal?.throwIfAborted();
        const current = await waitOrAbort(
          Promise.race([probe(), exited]),
          signal,
        );
        if (current.kind === 'ready') {
          if (
            current.record.pid !== daemon.child.pid ||
            current.record.configPath !== runtime.configPath
          )
            throw new Error(
              'Another daemon won startup. Its session has been left untouched; close it before retrying.',
            );
          owner = current.record;
          break;
        }
        if (deps.now() >= deadline)
          throw new Error(
            'The source daemon did not become ready before the startup deadline.',
          );
        await waitOrAbort(Promise.race([deps.sleep(100), exited]), signal);
      }
      await deps.assertNoHost(electron);
      const hostEnvironment = { ...deps.env };
      delete hostEnvironment.ELECTRON_RUN_AS_NODE;
      deps.log(
        'Opening the source Host. Press Ctrl+C to close both processes.',
      );
      host = launch(
        'Host',
        electron,
        [
          join(root, 'packages', 'qwen-live-harness-host'),
          '--qwen-live-harness-connect-only',
          `--qwen-live-harness-discovery-file=${runtime.discoveryPath}`,
          `--qwen-live-harness-owner=${owner.pid}:${owner.instanceNonce}`,
          ...(debug ? ['--live-harness-debug'] : []),
        ],
        root,
        hostEnvironment,
      );
      const result = await waitOrAbort(
        Promise.race([
          daemon.result.then((result) => ({ name: 'daemon', ...result })),
          host.result.then((result) => ({ name: 'Host', ...result })),
        ]),
        signal,
      );
      requireSuccess(result, result.name);
    }
  } catch (error) {
    failure = error;
    failed = true;
  } finally {
    // Close the daemon first so its authenticated stop marker also closes Host.
    for (const owned of [daemon, host, ...children]) {
      if (!owned || !children.has(owned)) continue;
      try {
        await stop(owned);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(failed ? [failure] : []), ...cleanupErrors],
      'Source process cleanup failed.',
    );
  if (failed) throw failure;
}

async function main() {
  let options;
  try {
    options = parseDevelopmentArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\nUsage: npm start -- [init] [--debug]\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(
      'Usage: npm start -- [init] [--debug]\nWithout init: build and run daemon + Host from this checkout (macOS). Ctrl+C stops both.\nWith init (also npm run init): build the daemon and configure source development; do not install or launch Host.\n',
    );
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await runDevelopment({ ...options, signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted || error instanceof AggregateError) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => '')) ===
    fileURLToPath(import.meta.url)
) {
  await main();
}
