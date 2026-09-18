#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen-live-harness` bin entry: load config, start the daemon, exit cleanly on
 * SIGINT/SIGTERM.
 */

import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { runInit } from './init.js';
import { runPeerSetup } from './peer-setup.js';
import {
  diagnoseQwenPeers,
  formatPeerDiagnostics,
} from './peer-diagnostics.js';
import { LiveLogger } from './logger.js';
import { parseLiveCliArgs, type LiveCliArgs } from './cli-args.js';
import { readPreferredLiveLanguage as preferredLanguage } from './language-preferences.js';
import {
  displayLiveMessage,
  liveText,
  startupErrorMessage,
} from './i18n/messages.js';
import { startCliApplication, type ManagedDaemon } from './cli-startup.js';
import { StartupError } from './startup.js';
import {
  RuntimeFailureLog,
  runtimeFailureSecrets,
  sanitizeFailureMessage,
} from './log/runtime-failure.js';
import { resolveLiveDataDirectory } from './paths.js';

export { loadConfig, type BackendConfig, type LiveConfig } from './config.js';
export { LiveDaemon } from './daemon.js';
export { BackendRegistry } from './adaptor/registry.js';
export type {
  BackendAdaptor,
  BackendCapabilities,
  BackendEvent,
  BackendHandle,
} from './adaptor/types.js';

async function main(debug: boolean, daemonOnly: boolean): Promise<void> {
  const logger = new LiveLogger(debug ? 'debug' : undefined);
  let config: ReturnType<typeof loadConfig> | undefined;
  const failures = new RuntimeFailureLog(resolveLiveDataDirectory(), () =>
    runtimeFailureSecrets(config),
  );
  logger.info(liveText(preferredLanguage(), 'cli.starting'));
  if (logger.debugEnabled) {
    logger.debug(liveText(preferredLanguage(), 'cli.debugNotice'));
  }
  // A stray rejection in a background chain (event pump, auto-approval)
  // must be diagnosable, not process-fatal.
  process.on('unhandledRejection', (reason) => {
    failures.write({
      source: 'daemon',
      code: 'unhandled_rejection',
      stage: 'background_promise',
      impact: 'operation',
      message:
        reason instanceof Error
          ? reason.message
          : 'A background promise rejected.',
      errorName: reason instanceof Error ? reason.name : undefined,
      executionUncertain: true,
    });
    logger.error(
      `unhandled rejection: ${sanitizeFailureMessage(reason instanceof Error ? reason.message : String(reason), runtimeFailureSecrets(config))}`,
    );
  });
  let daemon: ManagedDaemon | undefined;
  const startup = new AbortController();
  let startOperation: Promise<unknown> = Promise.resolve();
  try {
    config = loadConfig();
  } catch (error) {
    failures.write({
      source: 'daemon',
      code: 'configuration_load_failed',
      stage: 'configuration',
      impact: 'daemon',
      message:
        error instanceof Error
          ? error.message
          : 'Configuration loading failed.',
      errorName: error instanceof Error ? error.name : undefined,
    });
    logger.error(
      displayLiveMessage(
        preferredLanguage(),
        error instanceof Error ? error.message : String(error),
      ),
    );
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    startup.abort();
    logger.info(liveText(preferredLanguage(), 'cli.stopping'));
    logger.debug(`received ${signal}, shutting down`);
    let exitCode = 0;
    startOperation
      .catch(() => undefined)
      .then(() => daemon?.stopForProcessExit())
      .catch((error: unknown) => {
        exitCode = 1;
        failures.write({
          source: 'daemon',
          code: 'process_shutdown_failed',
          stage: 'shutdown',
          impact: 'daemon',
          message: error instanceof Error ? error.message : 'Shutdown failed.',
          errorName: error instanceof Error ? error.name : undefined,
        });
        logger.error(
          `shutdown failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        process.exit(exitCode);
      });
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  try {
    startOperation = startCliApplication(config, {
      debug,
      daemonOnly,
      signal: startup.signal,
      logger,
      failureLog: failures,
      onDaemonCreated: (created) => {
        daemon = created;
      },
    });
    await startOperation;
  } catch (error) {
    if (shuttingDown) return;
    failures.write({
      source: 'daemon',
      code:
        error instanceof StartupError ? error.code : 'application_start_failed',
      stage: 'application_start',
      impact: 'daemon',
      message:
        error instanceof Error ? error.message : 'Application startup failed.',
      errorName: error instanceof Error ? error.name : undefined,
    });
    logger.error(
      displayLiveMessage(
        preferredLanguage(),
        error instanceof StartupError
          ? startupErrorMessage(error)
          : error instanceof Error
            ? error.message
            : String(error),
      ),
    );
    await daemon?.stopForProcessExit().catch(() => undefined);
    process.exitCode = 1;
  }
}

function runCli(args: LiveCliArgs): void {
  if (args.command === 'help') {
    process.stdout.write(`${liveText(preferredLanguage(), 'cli.usage')}\n`);
    return;
  }
  if (args.command === 'init') {
    void (
      args.peers
        ? runPeerSetup(preferredLanguage())
        : runInit({ source: args.source })
    ).catch((error: unknown) => {
      process.stderr.write(
        `${displayLiveMessage(preferredLanguage(), error instanceof Error ? error.message : String(error))}\n`,
      );
      process.exitCode = 1;
    });
    return;
  }
  if (args.command === 'doctor') {
    void (async () => {
      let config: ReturnType<typeof loadConfig>;
      try {
        config = loadConfig();
      } catch {
        process.stderr.write(
          `${liveText(preferredLanguage(), 'peerDoctor.configError')}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const diagnostics = await diagnoseQwenPeers(config);
      process.stdout.write(
        `${formatPeerDiagnostics(diagnostics, config.language ?? preferredLanguage())}\n`,
      );
      if (diagnostics.hasErrors) process.exitCode = 1;
    })().catch(() => {
      process.stderr.write(
        `${liveText(preferredLanguage(), 'peerDoctor.configError')}\n`,
      );
      process.exitCode = 1;
    });
    return;
  }
  void main(args.debug, args.daemonOnly);
}

// Only run as a daemon when invoked as the bin, not when imported. npm
// installs bins as symlinks and Node resolves import.meta.url through them,
// so compare against the realpath (same pattern as packages/cli/src/cli.ts);
// pathToFileURL also percent-encodes metacharacters (# ? %) the way Node did
// when it formed import.meta.url.
let invokedDirectly = false;
if (process.argv[1] !== undefined) {
  try {
    const entry = realpathSync(process.argv[1]);
    // Direct file invocation…
    invokedDirectly = import.meta.url === pathToFileURL(entry).href;
    // …or directory-form invocation (`node packages/qwen-live-harness`): Node
    // resolves the directory against package.json main; compare against
    // the built entry the bin ships so main() still runs.
    if (
      !invokedDirectly &&
      statSync(entry, { throwIfNoEntry: false })?.isDirectory()
    ) {
      invokedDirectly =
        import.meta.url === pathToFileURL(join(entry, 'dist', 'index.js')).href;
    }
  } catch {
    invokedDirectly = import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}
if (invokedDirectly) {
  try {
    runCli(parseLiveCliArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `${displayLiveMessage(preferredLanguage(), error instanceof Error ? error.message : String(error))}\n${liveText(preferredLanguage(), 'cli.usage')}\n`,
    );
    process.exitCode = 1;
  }
}
