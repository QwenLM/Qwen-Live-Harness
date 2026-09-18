/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'node:path';
import type { LiveConfig } from './config.js';
import { LiveDaemon } from './daemon.js';
import { getLiveDiscoveryPath } from './host/discovery.js';
import { LiveHostInstaller } from './host/qwen-live-harness-host-installer.js';
import { liveMessage, liveText } from './i18n/messages.js';
import { LiveLogger } from './logger.js';
import { probeDaemon, StartupError } from './startup.js';
import { withDaemonStartupLock } from './startup-lock.js';
import { registerCurrentRuntime } from './startup-registration.js';
import { PACKAGE_VERSION } from './version.js';
import type { DaemonIdentity } from './lifecycle.js';
import type { RuntimeFailureLog } from './log/runtime-failure.js';

export type ManagedDaemon = Pick<
  LiveDaemon,
  'start' | 'stop' | 'stopForProcessExit' | 'getInstanceIdentity'
>;

export interface CliStartupOptions {
  daemonOnly: boolean;
  debug: boolean;
  signal?: AbortSignal;
  onDaemonCreated?: (daemon: ManagedDaemon) => void;
  logger?: LiveLogger;
  failureLog?: RuntimeFailureLog;
}

export interface CliStartupDependencies {
  platform: NodeJS.Platform;
  version: string;
  probe: typeof probeDaemon;
  register: typeof registerCurrentRuntime;
  lock: typeof withDaemonStartupLock;
  createDaemon: (config: LiveConfig, logger: LiveLogger) => ManagedDaemon;
  openHost: LiveHostInstaller['launch'];
}

/** One lock covers the probe and backend preflight for every CLI entry, including GUI children. */
export async function startCliApplication(
  config: LiveConfig,
  options: CliStartupOptions,
  overrides: Partial<CliStartupDependencies> = {},
): Promise<{ reused: boolean }> {
  const installer = new LiveHostInstaller();
  const dependencies: CliStartupDependencies = {
    platform: process.platform,
    version: PACKAGE_VERSION,
    probe: probeDaemon,
    register: registerCurrentRuntime,
    lock: withDaemonStartupLock,
    createDaemon: (settings, logger) =>
      new LiveDaemon(settings, { logger, failureLog: options.failureLog }),
    openHost: (settings) => installer.launch(settings),
    ...overrides,
  };
  const logger =
    options.logger ?? new LiveLogger(options.debug ? 'debug' : undefined);
  const discoveryPath = getLiveDiscoveryPath(resolve(config.discoveryDir));
  let owned: ManagedDaemon | undefined;
  let owner: DaemonIdentity | undefined;
  let reused = false;
  let abortCleanup: Promise<void> | undefined;
  const closeOwnedApplication = () => {
    if (owned && !abortCleanup) {
      abortCleanup = owned.stopForProcessExit().catch(() => {
        logger.error(
          liveText(config.language ?? 'en', 'startup.startup_cleanup_failed'),
        );
      });
    }
    return abortCleanup ?? Promise.resolve();
  };
  const stopStartingDaemon = () => {
    void closeOwnedApplication();
  };
  const checkCancelled = () => {
    if (options.signal?.aborted) throw new StartupError('startup_aborted');
  };
  try {
    logger.info(liveText(config.language ?? 'en', 'cli.checkingInstance'));
    const startedAt = Date.now();
    await dependencies.lock(
      discoveryPath,
      async () => {
        checkCancelled();
        const existing = await dependencies.probe(discoveryPath, {
          expectedVersion: dependencies.version,
          signal: options.signal,
        });
        if (existing.kind === 'ready') {
          if (
            existing.record.configPath !==
            resolve(config.dataDir, 'config.json')
          )
            throw new StartupError('daemon_mismatch');
          owner = {
            pid: existing.record.pid,
            instanceNonce: existing.record.instanceNonce,
          };
          reused = true;
        } else {
          checkCancelled();
          owned = dependencies.createDaemon(config, logger);
          options.onDaemonCreated?.(owned);
          options.signal?.addEventListener('abort', stopStartingDaemon, {
            once: true,
          });
          checkCancelled();
          await owned.start();
          checkCancelled();
          owner = owned.getInstanceIdentity();
        }
        if (!options.daemonOnly) {
          await dependencies.register({
            dataDir: resolve(config.dataDir),
            discoveryDir: resolve(config.discoveryDir),
            cwd: config.defaultCwd ? resolve(config.defaultCwd) : undefined,
          });
        }
      },
      { signal: options.signal },
    );
    logger.debug(
      `startup.daemon_ready ${JSON.stringify({ reused, durationMs: Date.now() - startedAt })}`,
    );
    checkCancelled();
    if (reused) logger.info(liveText(config.language ?? 'en', 'cli.reused'));
    if (!options.daemonOnly && dependencies.platform === 'darwin') {
      let stageStartedAt = Date.now();
      const status = await dependencies.openHost({
        debug: options.debug,
        discoveryPath,
        connectOnly: true,
        owner,
        signal: options.signal,
        onStage: (stage) => {
          if (stage === 'opening') {
            logger.debug(
              `startup.host_checked ${JSON.stringify({ durationMs: Date.now() - stageStartedAt })}`,
            );
            stageStartedAt = Date.now();
          }
          logger.info(
            liveText(
              config.language ?? 'en',
              stage === 'checking' ? 'cli.checkingHost' : 'cli.openingHost',
            ),
          );
        },
      });
      checkCancelled();
      if (status.state !== 'installed')
        throw new Error(
          status.message ?? liveMessage('installer.notInstalled'),
        );
      logger.info(liveText(config.language ?? 'en', 'cli.hostOpened'));
      logger.debug(
        `startup.host_opened ${JSON.stringify({ durationMs: Date.now() - stageStartedAt })}`,
      );
    }
    return { reused };
  } catch (error) {
    // A launch failure can only tear down the daemon created by this invocation.
    // Existing sessions belong to the already running application.
    await closeOwnedApplication();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', stopStartingDaemon);
    await abortCleanup;
  }
}
