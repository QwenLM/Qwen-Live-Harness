/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LiveDaemon wires everything together: the Host WebSocket endpoint
 * (protocol v9, including optional visual input), the
 * discovery file that Host binaries poll, the realtime orchestrator, and
 * the qwen serve adaptor.
 *
 * Discovery mutual exclusion: writing `~/.qwen-live-harness/run/daemon.json` fails fast
 * when another Qwen Live Harness daemon already owns it.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { AcpAdaptor } from './adaptor/acp-adaptor.js';
import { QwenCodeAdaptor } from './adaptor/qwen-code-adaptor.js';
import { BackendRegistry } from './adaptor/registry.js';
import type { BackendConfig, LiveConfig } from './config.js';
import { LiveHostInstaller } from './host/qwen-live-harness-host-installer.js';
import {
  getLiveDiscoveryPath,
  handoffLiveDiscoveryOwner,
  LiveDiscoveryOwnerActiveError,
  removeLiveDiscoveryFile,
  writeLiveDiscoveryFile,
} from './host/discovery.js';
import { LiveHostCoordinator } from './host/qwen-live-harness-host-coordinator.js';
import { LIVE_HOST_PROTOCOL_VERSION } from './host/types.js';
import { SessionLog } from './log/session-log.js';
import { DebugArchive } from './log/debug-archive.js';
import { readDebugBuildInfo } from './log/build-info.js';
import {
  RuntimeFailureLog,
  runtimeFailureRecord,
  runtimeFailureSecrets,
  type RuntimeFailure,
} from './log/runtime-failure.js';
import { LiveLogger } from './logger.js';
import { LiveSession } from './orchestrator/live-session.js';
import { MemoryService } from './memory/service.js';
import { MemoryStoreError } from './memory/store.js';
import { deriveMemoryBaseUrl } from './memory/config.js';
import { persistLanguagePreference } from './language-preferences.js';
import { persistPermissionModePreference } from './permission-preferences.js';
import { persistScreenDisplayPreference } from './visual-preferences.js';
import { liveMessage, liveText } from './i18n/messages.js';
import { writeDaemonStopMarker, type DaemonIdentity } from './lifecycle.js';
import { MonitorDebugStore } from './proactive/monitor-debug-store.js';
import { escapeAnsiCtrlCodes } from './realtime/sanitize.js';
import { PACKAGE_VERSION } from './version.js';
import {
  QWEN_REALTIME_INPUT_SAMPLE_RATE,
  QWEN_REALTIME_OUTPUT_SAMPLE_RATE,
} from './realtime/realtime-session.js';
import {
  MAX_SUBAGENTS_REQUEST_BYTES,
  parseSubagentsControlRequest,
  parseSubagentsControlResult,
  type SubagentsControlResult,
} from './subagents/types.js';

const HOST_WS_PATH = '/live/host';

export interface LiveDaemonDeps {
  /** Pre-built registry (tests); built from config.backends otherwise. */
  registry?: BackendRegistry;
  /** Installer (tests inject a fake); production installs the real Host. */
  installer?: LiveHostInstaller;
  logger?: LiveLogger;
  failureLog?: RuntimeFailureLog;
}

/** Build one adaptor from its config entry. */
function buildAdaptor(
  backend: BackendConfig,
  fields: { defaultCwd?: string; logger: LiveLogger; clientId: string },
): QwenCodeAdaptor | AcpAdaptor {
  if (backend.kind === 'qwen-code') {
    return new QwenCodeAdaptor({
      baseUrl: backend.baseUrl,
      ...(backend.managedServe ? { managedServe: backend.managedServe } : {}),
      ...(backend.token ? { token: backend.token } : {}),
      ...(backend.peerDiscovery
        ? { peerDiscovery: backend.peerDiscovery }
        : {}),
      ...(fields.defaultCwd ? { defaultCwd: fields.defaultCwd } : {}),
      clientId: fields.clientId,
      name: backend.name,
    });
  }
  return new AcpAdaptor({
    name: backend.name,
    command: backend.command,
    args: backend.args,
    env: backend.env,
    ...(backend.cwd ? { cwd: backend.cwd } : {}),
    ...(backend.sessionMode ? { sessionMode: backend.sessionMode } : {}),
    ...(fields.defaultCwd ? { defaultCwd: fields.defaultCwd } : {}),
    logger: fields.logger,
  });
}

export class LiveDaemon {
  private readonly logger: LiveLogger;
  private readonly registry: BackendRegistry;
  private readonly installer: LiveHostInstaller;
  private readonly token = randomUUID();
  private readonly instanceNonce = randomUUID();
  private readonly failureLog: RuntimeFailureLog;
  private failureLogUnavailable = false;
  private startupStage = 'constructor';
  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private coordinator: LiveHostCoordinator | undefined;
  private session: LiveSession | undefined;
  private memory: MemoryService | undefined;
  private log: SessionLog | undefined;
  private monitorDebug: MonitorDebugStore | undefined;
  private debugArchive: DebugArchive | undefined;
  private discoveryPublished = false;
  private stopping = false;
  private resourcesStopPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private exitMarkerPromise: Promise<void> | undefined;
  private pendingCleanup: Map<string, () => unknown> | undefined;

  constructor(
    private readonly config: LiveConfig,
    deps: LiveDaemonDeps = {},
  ) {
    this.logger = deps.logger ?? new LiveLogger();
    this.failureLog =
      deps.failureLog ??
      new RuntimeFailureLog(config.dataDir, () =>
        runtimeFailureSecrets(this.config, [this.token]),
      );
    this.installer = deps.installer ?? new LiveHostInstaller();
    this.registry =
      deps.registry ??
      new BackendRegistry(
        config.backends.map((backend) => ({
          adaptor: buildAdaptor(backend, {
            ...(config.defaultCwd ? { defaultCwd: config.defaultCwd } : {}),
            logger: this.logger,
            clientId: `qwen-live-harness-${this.instanceNonce.slice(0, 8)}-${backend.name}`,
          }),
          isDefault: backend.isDefault,
        })),
      );
  }

  getInstanceIdentity(): DaemonIdentity {
    return { pid: process.pid, instanceNonce: this.instanceNonce };
  }

  async start(): Promise<{ port: number; url: string }> {
    try {
      return await this.startRuntime();
    } catch (error) {
      if (!this.stopping)
        this.recordFailure({
          source: 'daemon',
          code: 'daemon_start_failed',
          stage: this.startupStage,
          impact: 'daemon',
          message:
            error instanceof Error ? error.message : 'Daemon startup failed.',
          errorName: error instanceof Error ? error.name : undefined,
        });
      throw error;
    }
  }

  private async startRuntime(): Promise<{ port: number; url: string }> {
    const assertStarting = () => {
      if (this.stopping)
        throw new Error(liveMessage('startup.startup_aborted'));
    };
    assertStarting();
    this.startupStage = 'debug_archive';
    if (this.logger.debugEnabled) {
      this.debugArchive = new DebugArchive({
        directory: join(this.config.dataDir, 'debug'),
        secrets: runtimeFailureSecrets(this.config, [this.token]),
        metadata: {
          effectiveConfig: this.config,
          version: PACKAGE_VERSION,
          build: await readDebugBuildInfo(),
          runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
          },
          mediaFormats: {
            inputAudio: {
              encoding: 'pcm_s16le',
              channels: 1,
              sampleRate: QWEN_REALTIME_INPUT_SAMPLE_RATE,
            },
            requestedOutputAudio: {
              encoding: 'pcm_s16le',
              channels: 1,
              sampleRate: QWEN_REALTIME_OUTPUT_SAMPLE_RATE,
            },
          },
          instanceNonce: this.instanceNonce,
        },
        onWarning: (warning) =>
          this.logger.warn(
            `Debug archive incomplete: ${JSON.stringify(warning)}`,
          ),
      });
      this.logger.debug(
        `debug.archive ${JSON.stringify({ path: this.debugArchive.path, retainRuns: 10, maxBytes: 512 * 1024 * 1024 })}`,
      );
      this.logger.warn(
        'Debug archives contain private conversation, media, prompts and tool results. Known keys and credential fields are redacted, but secrets visible or spoken in media are not. Review before sharing.',
      );
      const archive = new MonitorDebugStore((event, details) => {
        this.debugArchive?.recordRuntime(event, details);
        this.logger.debug(`${event} ${JSON.stringify(details)}`);
        this.log?.write('proactive.debug', { event, ...details });
        if (event === 'proactive.monitor_debug_failed')
          this.recordFailure({
            source: 'proactive',
            code: 'monitor_archive_failed',
            stage: 'debug_archive',
            impact: 'operation',
            message:
              'Monitor diagnostic archive failed; monitoring itself continues.',
            taskId:
              typeof details['taskId'] === 'string'
                ? details['taskId']
                : undefined,
          });
      });
      if (await archive.initialize()) this.monitorDebug = archive;
    }
    assertStarting();
    // An explicit empty registry enables independent Omni capabilities. A
    // configured default backend still fails fast before discovery is claimed;
    // secondary backends remain best-effort.
    if (!this.registry.hasBackends) {
      this.logger.info(
        liveText(this.config.language ?? 'en', 'cli.noBackends'),
      );
    }
    const backendStarts = new Map<string, number>();
    this.startupStage = 'backend_preflight';
    await this.registry.preflight(
      (message) => this.logger.warn(message),
      ({ backend, stage }) => {
        if (stage === 'unavailable')
          this.recordFailure({
            source: 'backend',
            code: 'backend_preflight_failed',
            stage: 'preflight',
            impact: 'feature',
            message: 'A configured backend did not initialize.',
            backend,
          });
        if (stage === 'starting') {
          backendStarts.set(backend, Date.now());
          this.logger.info(
            liveText(this.config.language ?? 'en', 'cli.backendStarting', {
              name: backend,
            }),
          );
        } else {
          this.logger.debug(
            `startup.backend ${JSON.stringify({
              backend,
              stage,
              durationMs:
                Date.now() - (backendStarts.get(backend) ?? Date.now()),
            })}`,
          );
        }
      },
    );
    assertStarting();

    this.startupStage = 'memory_initialization';
    let memoryBaseUrl = '';
    try {
      memoryBaseUrl = deriveMemoryBaseUrl(this.config.realtime.endpoint);
    } catch {
      if (this.config.memory.enabled)
        this.recordFailure({
          source: 'memory',
          code: 'memory_endpoint_unavailable',
          stage: 'initialization',
          impact: 'feature',
          message:
            'The configured Realtime endpoint cannot provide a default Memory endpoint.',
        });
      this.logger.warn(
        'Memory default endpoint unavailable; check realtimeEndpoint or QWEN_LIVE_HARNESS_REALTIME_ENDPOINT.',
      );
    }
    this.memory = new MemoryService({
      config: this.config.memory,
      dataDir: this.config.dataDir,
      connection: {
        baseUrl: memoryBaseUrl,
        apiKey: this.config.realtime.apiKey,
      },
      log: (event, details) => {
        this.debugArchive?.recordRuntime(event, details);
        this.logger.debug(`${event} ${JSON.stringify(details ?? {})}`);
        if (
          /[._](?:failed|error|unavailable|bad_response|invalid_response|timeout)$/u.test(
            event,
          )
        ) {
          this.recordFailure({
            source: 'memory',
            code: event,
            stage: 'memory_service',
            impact: 'operation',
            message:
              'A Memory sub-operation failed; other Memory functions may continue.',
            errorName:
              typeof details?.['kind'] === 'string'
                ? details['kind']
                : undefined,
          });
        }
      },
      onChange: () => this.coordinator?.refreshMemoryState(),
    });

    this.startupStage = 'host_initialization';
    const coordinator = new LiveHostCoordinator({
      onFailure: (failure) => this.recordFailure(failure),
      onDebug: (event, details) =>
        this.debugArchive?.recordRuntime(event, details),
      daemonInstanceNonce: this.instanceNonce,
      daemonShutdownV1: true,
      getUiLanguage: () => ({ language: this.config.language ?? 'en' }),
      getPermissionMode: () => ({ mode: this.config.permissionMode ?? 'ask' }),
      onPermissionModeAction: (mode) => {
        this.config.permissionMode = persistPermissionModePreference(
          this.config.dataDir,
          mode,
        );
        this.debugArchive?.recordRuntime('host.permission_mode_changed', {
          mode: this.config.permissionMode,
        });
        // Persistence is the settings transaction boundary. A later runtime
        // refresh failure must not make the UI pretend the saved mode reverted.
        try {
          this.session?.permissionModeChanged();
        } catch {
          this.debugArchive?.recordRuntime(
            'host.permission_mode_apply_failed',
            { mode: this.config.permissionMode },
          );
        }
        return { mode: this.config.permissionMode };
      },
      getSubagents: () => this.session?.getSubagentsSnapshot(),
      subagentsControlV1: true,
      onScreenDisplayChange: (screenDisplayId) => {
        this.config.visualInput.screenDisplayId =
          persistScreenDisplayPreference(this.config.dataDir, screenDisplayId);
        this.debugArchive?.recordRuntime('host.screen_display_changed', {
          screenDisplayId,
        });
      },
      onLanguageAction: (language) => {
        this.config.language = persistLanguagePreference(
          this.config.dataDir,
          language,
        );
        this.debugArchive?.recordRuntime('host.language_changed', {
          language: this.config.language,
        });
        return { language: this.config.language };
      },
      getMemoryState: () => this.memory!.state(),
      onMemoryAction: (action) => {
        this.debugArchive?.recordRuntime('host.memory_action', action);
        try {
          this.memory!.applyAction(action);
        } catch (error) {
          if (error instanceof MemoryStoreError)
            throw new Error(liveMessage(error.messageKey));
          if (
            error instanceof Error &&
            error.message.startsWith('qwen-live-harness-ui:')
          )
            throw error;
          throw new Error(liveMessage('memoryUI.updateFailed'));
        }
        this.session?.syncMemorySettings();
        return this.memory!.state();
      },
      visualInput: {
        source: this.config.visualInput.source,
        mode: this.config.visualInput.mode,
        screenDisplayId: this.config.visualInput.screenDisplayId ?? 'primary',
        fps: this.config.visualInput.fps,
        cameraWidth: this.config.visualInput.cameraResolution.width,
        cameraHeight: this.config.visualInput.cameraResolution.height,
        ...(this.config.visualInput.cameraSnapshotResolution === 'native'
          ? {}
          : {
              cameraSnapshotWidth:
                this.config.visualInput.cameraSnapshotResolution.width,
              cameraSnapshotHeight:
                this.config.visualInput.cameraSnapshotResolution.height,
            }),
        liveWidth: this.config.visualInput.liveResolution.width,
        liveHeight: this.config.visualInput.liveResolution.height,
        ...(this.config.visualInput.snapshotResolution === 'native'
          ? {}
          : {
              snapshotWidth: this.config.visualInput.snapshotResolution.width,
              snapshotHeight: this.config.visualInput.snapshotResolution.height,
            }),
      },
      logger: this.logger,
      ...(this.config.shortcut ? { shortcut: this.config.shortcut } : {}),
      getProviderReadiness: () =>
        this.config.realtime.apiKey
          ? { state: 'ready' }
          : {
              state: 'unavailable',
              blocker: 'provider_config',
              message: liveMessage('runtime.apiKeyMissing'),
            },
    });
    this.coordinator = coordinator;
    // The ported coordinator fails closed until the Appshot delivery channel
    // is verified (in qwen serve that channel is a separate reverse-RPC hop
    // booted lazily). Here the channel is the in-process visual capture call,
    // verified by construction.
    coordinator.setAppshotReadiness({ state: 'ready' });

    const log = new SessionLog({
      directory: join(this.config.dataDir, 'sessions'),
      liveSessionId: `live-${Date.now()}-${this.instanceNonce.slice(0, 8)}`,
      onEvent: (event) =>
        this.debugArchive?.recordRuntime('session.log', event),
    });
    this.log = log;

    const session = new LiveSession({
      getLanguage: () => this.config.language ?? 'en',
      getPermissionMode: () =>
        this.stopping ? 'ask' : (this.config.permissionMode ?? 'ask'),
      onFailure: (failure) => this.recordFailure(failure, false),
      failureSecrets: runtimeFailureSecrets(this.config, [this.token]),
      host: coordinator,
      registry: this.registry,
      realtime: {
        endpoint: this.config.realtime.endpoint,
        apiKey: this.config.realtime.apiKey,
        model: this.config.realtime.model,
        ...(this.config.realtime.voice
          ? { voice: this.config.realtime.voice }
          : {}),
      },
      proactive: this.config.proactive,
      monitorDebug: this.monitorDebug,
      debugArchive: this.debugArchive,
      memory: this.memory,
      log,
      logger: this.logger,
      onSubagentsChanged: () => coordinator.refreshSubagentsState(),
    });
    this.session = session;

    coordinator.setHandlers({
      onStart: (call) => {
        this.debugArchive?.recordRuntime('host.start', call);
        return session.start(call);
      },
      onStop: (call) => {
        this.debugArchive?.recordRuntime('host.stop', call);
        return session.stop(call);
      },
      onInputAudio: (call) => session.pushAudio(call),
      onInputMuteChanged: (call) => {
        this.debugArchive?.recordRuntime('host.input_mute_changed', call);
        session.setInputMuted(call);
      },
      onInputImage: (call) => session.pushImage(call),
      onVisualSettings: (call) => {
        this.debugArchive?.recordRuntime('host.visual_settings', call);
        session.setVisualSettings(call);
      },
      onPlaybackStarted: (call) => {
        this.debugArchive?.recordRuntime('host.playback_started', call);
        session.playbackStarted(call);
      },
      onPlaybackCompleted: (call) => {
        this.debugArchive?.recordRuntime('host.playback_completed', call);
        session.playbackCompleted(call);
      },
      onOutputMuted: (call) => {
        this.debugArchive?.recordRuntime('host.output_muted', call);
        session.outputMuted(call);
      },
    });

    this.startupStage = 'listen';
    const port = await this.listen();
    assertStarting();
    const url = `http://127.0.0.1:${port}`;

    this.startupStage = 'discovery';
    await this.publishDiscovery(url);
    if (this.stopping) {
      // Shutdown may have removed discovery before publication completed.
      // Never leave this late record pointing at an exiting bootstrap child.
      await this.removeDiscovery();
      assertStarting();
    }

    // The single machine-readable stdout line; harnesses parse the port
    // from it (same pattern as `qwen serve`).
    process.stdout.write(`qwen-live-harness listening on ${url}\n`);
    this.logger.debug(
      `configuration ${JSON.stringify({
        model: this.config.realtime.model,
        visualInput: this.config.visualInput,
        proactive: this.config.proactive,
        backends: this.config.backends.map((backend) => backend.name),
        sessionLog: log.filePath,
      })}`,
    );
    this.logger.info(
      `host endpoint ready at ${url}${HOST_WS_PATH} (protocol v${LIVE_HOST_PROTOCOL_VERSION})`,
    );
    return { port, url };
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.finishStop().catch((error: unknown) => {
      this.stopPromise = undefined;
      throw error;
    });
    return this.stopPromise;
  }

  async stopForProcessExit(): Promise<void> {
    const errors: unknown[] = [];
    // Persist an instance-bound notification before closing transports. This
    // also reaches a Host that is still opening or temporarily reconnecting.
    try {
      this.exitMarkerPromise ??= writeDaemonStopMarker(
        getLiveDiscoveryPath(resolve(this.config.discoveryDir)),
        this.getInstanceIdentity(),
      );
      await this.exitMarkerPromise;
    } catch (error) {
      this.logCleanupFailure('Host exit notification', error);
      errors.push(error);
    }
    try {
      await this.stop();
    } catch (error) {
      errors.push(error);
    }
    // An exiting process cannot serve a Quit retry. Only release our own lease.
    try {
      await this.removeDiscovery();
    } catch (error) {
      this.logCleanupFailure('discovery', error);
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        'Qwen Live Harness shutdown cleanup failed.',
      );
  }

  private async removeDiscovery(): Promise<void> {
    if (!this.discoveryPublished) return;
    await removeLiveDiscoveryFile(this.config.discoveryDir, {
      pid: process.pid,
      instanceNonce: this.instanceNonce,
    });
    this.discoveryPublished = false;
    this.pendingCleanup?.delete('discovery');
  }

  private recordFailure(failure: RuntimeFailure, includeSession = true): void {
    try {
      const record = runtimeFailureRecord(
        failure,
        runtimeFailureSecrets(this.config, [this.token]),
      );
      this.debugArchive?.recordRuntime('runtime.failure', record);
      if (includeSession) this.log?.write('failure', record);
      const saved = this.failureLog.write(record as unknown as RuntimeFailure);
      if (!saved && !this.failureLogUnavailable) {
        this.failureLogUnavailable = true;
        this.logger.warn(
          'Runtime failure log could not be written. Check the data directory permissions and disk space.',
        );
      }
    } catch {
      /* Failure reporting must not break cleanup or calls. */
    }
  }

  private logCleanupFailure(name: string, error: unknown): void {
    this.recordFailure({
      source: 'daemon',
      code: 'cleanup_failed',
      stage: 'cleanup',
      impact: 'daemon',
      message: `Cleanup of ${name} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      errorName: error instanceof Error ? error.name : undefined,
      executionUncertain: true,
    });
    const secrets = [
      this.token,
      this.config.realtime.apiKey,
      process.env[this.config.memory.updater.apiKeyEnv],
      process.env[this.config.memory.observer.apiKeyEnv],
      ...this.config.backends.flatMap((backend) =>
        backend.kind === 'qwen-code'
          ? [backend.token]
          : Object.entries(backend.env)
              .filter(([key]) =>
                /key|token|secret|password|authorization/iu.test(key),
              )
              .map(([, value]) => value),
      ),
    ]
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.length - left.length);
    const causes: unknown[] = [error];
    const seen = new Set<unknown>();
    const messages: string[] = [];
    while (causes.length && messages.length < 8) {
      const cause = causes.shift();
      if (seen.has(cause)) continue;
      seen.add(cause);
      let message =
        cause instanceof Error
          ? cause.message
          : typeof cause === 'string'
            ? cause
            : 'Unknown cleanup failure';
      message = message
        .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/giu, '[URL omitted]')
        .replace(
          /\b(?:Bearer|Basic)\s+[^\s"',;]+/giu,
          '[redacted authorization]',
        )
        .replace(/[\r\n\t]/gu, ' ');
      for (const secret of secrets)
        message = message.split(secret).join('[redacted]');
      messages.push(escapeAnsiCtrlCodes(message).slice(0, 512));
      if (cause instanceof Error && cause.cause !== undefined)
        causes.push(cause.cause);
      if (cause instanceof AggregateError)
        causes.push(...cause.errors.slice(0, 8));
    }
    this.logger.warn(
      `cleanup of '${name}' failed: ${messages.join('; ').slice(0, 2048)}`,
    );
  }

  private stopResources(): Promise<void> {
    this.stopping = true;
    this.pendingCleanup ??= new Map<string, () => unknown>([
      ['session', () => this.session?.dispose()],
      ['coordinator', () => this.coordinator?.dispose()],
      ...this.registry
        .all()
        .map(({ adaptor }): [string, () => unknown] => [
          `backend:${adaptor.name}`,
          () => adaptor.close(),
        ]),
      ['memory', () => this.memory?.close()],
      ['monitor debug archive', () => this.monitorDebug?.flush()],
      ['log', () => this.log?.close()],
      ['discovery', () => this.removeDiscovery()],
      ['debug archive', () => this.debugArchive?.close()],
    ]);
    const pending = this.pendingCleanup;
    this.resourcesStopPromise ??= (async () => {
      const errors: unknown[] = [];
      const clean = async (
        name: string,
        dispose: () => unknown,
      ): Promise<void> => {
        try {
          await dispose();
          pending.delete(name);
        } catch (error) {
          this.logCleanupFailure(name, error);
          errors.push(error);
        }
      };
      await Promise.all(
        ['session', 'coordinator'].map((name) => {
          const dispose = pending.get(name);
          return dispose ? clean(name, dispose) : undefined;
        }),
      );
      await Promise.all(
        [...pending]
          .filter(([name]) => name.startsWith('backend:'))
          .map(([name, dispose]) => clean(name, dispose)),
      );
      for (const [name, dispose] of pending) {
        if (
          name === 'session' ||
          name === 'coordinator' ||
          name.startsWith('backend:')
        )
          continue;
        if (name === 'discovery' && errors.length) continue;
        await clean(name, dispose);
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          'Qwen Live Harness shutdown cleanup failed.',
        );
    })().catch((error: unknown) => {
      this.resourcesStopPromise = undefined;
      throw error;
    });
    return this.resourcesStopPromise;
  }

  private async finishStop(): Promise<void> {
    await this.stopResources();
    await this.closeTransports();
  }

  private async closeTransports(): Promise<void> {
    // Graceful close waits on the peer; shutdown must not. Any client still
    // attached (or attached between dispose() and here) is torn down hard.
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.terminate();
      }
    }
    await new Promise<void>((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        resolve();
      });
    });
  }

  // -- internals ------------------------------------------------------------

  private handleRequest(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): void {
    const url = (req.url ?? '').split('?', 1)[0];
    const route = `${req.method} ${url}`;
    if (route === 'POST /live/quit') {
      if (!this.authorize(req)) {
        res.writeHead(401).end();
        return;
      }
      if (!this.authorizeInstance(req)) {
        res.writeHead(409).end();
        return;
      }
      void this.serveQuit(res);
      return;
    }
    if (this.stopping) {
      res.writeHead(503).end();
      return;
    }
    if (route === 'GET /live/instance') {
      if (!this.authorize(req)) {
        res.writeHead(401).end();
        return;
      }
      if (!this.authorizeInstance(req)) {
        res.writeHead(409).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          pid: process.pid,
          instanceNonce: this.instanceNonce,
          protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
          version: PACKAGE_VERSION,
        }),
      );
      return;
    }
    if (route === 'POST /live/subagents') {
      if (!this.authorize(req)) {
        res.writeHead(401).end();
        return;
      }
      if (!this.authorizeInstance(req)) {
        res.writeHead(409).end();
        return;
      }
      void this.serveSubagents(req, res);
      return;
    }
    if (
      (route === 'GET /live/setup' ||
        route === 'POST /live/setup/install' ||
        route === 'POST /live/setup/launch') &&
      this.authorize(req)
    ) {
      void this.serveSetup(route, res);
      return;
    }
    if (route === 'GET /healthz') {
      res.statusCode = 200;
      res.end('ok');
      return;
    }
    res.statusCode = route.startsWith('GET /live/setup') ? 401 : 404;
    res.end();
  }

  private async serveSubagents(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const reply = (status: number, result: SubagentsControlResult) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    };
    if (req.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
      reply(415, { type: 'error', code: 'invalid_request' });
      req.resume();
      return;
    }
    const encoded = await new Promise<string | undefined>((resolve) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let finished = false;
      const finish = (value?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish();
        req.destroy();
      }, 10_000);
      timer.unref();
      req.on('data', (chunk: Buffer) => {
        if (finished) return;
        bytes += chunk.length;
        if (bytes > MAX_SUBAGENTS_REQUEST_BYTES) {
          reply(413, { type: 'error', code: 'invalid_request' });
          finish();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => finish());
      req.on('aborted', () => finish());
    });
    if (encoded === undefined || res.destroyed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      reply(400, { type: 'error', code: 'invalid_request' });
      return;
    }
    const action = parseSubagentsControlRequest(parsed);
    if (!action) {
      reply(400, { type: 'error', code: 'invalid_request' });
      return;
    }
    if (this.stopping || !this.session) {
      reply(503, { type: 'error', code: 'unavailable' });
      return;
    }
    try {
      const result = parseSubagentsControlResult(
        await this.session.handleSubagentsRequest(action),
      );
      if (!result) throw new Error('Invalid subagent management result');
      reply(200, result);
    } catch {
      reply(500, { type: 'error', code: 'action_failed' });
    }
  }

  private async serveQuit(
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    try {
      await this.stopResources();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ stopped: true, instanceNonce: this.instanceNonce }),
      );
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'Qwen Live Harness shutdown cleanup failed.' }),
      );
      this.logger.error(
        'Qwen Live Harness shutdown cleanup failed; retry Quit.',
      );
      return;
    }
    // Close the listener after replying; server.close otherwise waits on
    // the very HTTP request that is awaiting its shutdown acknowledgement.
    void this.stop().catch(() =>
      this.logger.error(
        'Qwen Live Harness shutdown cleanup failed; retry Quit.',
      ),
    );
  }

  private async serveSetup(
    route: string,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const status =
      route === 'GET /live/setup'
        ? await this.installer.refresh()
        : route === 'POST /live/setup/install'
          ? // force=true is the recovery path: a corrupted-but-present
            // installation (bad Info.plist, revoked notarization) would
            // otherwise permanently fail inspection while the status still
            // says retryable. Force re-downloads and re-verifies.
            await this.installer.ensureInstalled(true)
          : await this.installer.launch();
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(status));
  }

  private authorize(req: IncomingMessage): boolean {
    // CSRF wall: a browser context always sends Origin; the Host never does.
    if (req.headers['origin'] !== undefined) return false;
    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
    const presented = Buffer.from(auth.slice('Bearer '.length));
    const expected = Buffer.from(this.token);
    return (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    );
  }

  private authorizeInstance(req: IncomingMessage): boolean {
    const nonce = req.headers['x-qwen-live-harness-nonce'];
    const presented = Buffer.from(typeof nonce === 'string' ? nonce : '');
    const expected = Buffer.from(this.instanceNonce);
    return (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    );
  }

  private listen(): Promise<number> {
    const server = createServer((req, res) => {
      this.handleRequest(req, res);
    });
    this.server = server;
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on('upgrade', (req, socket, head) => {
      // A Host redialing its cached discovery URL during shutdown must not
      // re-register — stop() would then wait on the fresh lease forever.
      if (this.stopping) {
        socket.destroy();
        return;
      }
      const path = (req.url ?? '').split('?', 1)[0];
      if (path !== HOST_WS_PATH) {
        socket.destroy();
        return;
      }
      if (!this.authorize(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const nonce = req.headers['x-qwen-live-harness-nonce'];
        this.coordinator?.attachHost(
          ws,
          typeof nonce === 'string' ? nonce : undefined,
        );
      });
    });

    return new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.port, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('could not determine the listening port'));
          return;
        }
        resolve(address.port);
      });
    });
  }

  private async publishDiscovery(url: string): Promise<void> {
    const record = {
      url,
      token: this.token,
      configPath: resolve(this.config.dataDir, 'config.json'),
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      pid: process.pid,
      instanceNonce: this.instanceNonce,
    };
    try {
      await writeLiveDiscoveryFile(this.config.discoveryDir, record);
      this.discoveryPublished = true;
      return;
    } catch (error) {
      if (!(error instanceof LiveDiscoveryOwnerActiveError)) {
        // A dead owner's record can be reclaimed through the handoff path.
        // The handoff's commitOwner must not touch the discovery file: the
        // handoff holds the directory lock (a nested write would deadlock)
        // and its confirm step expects the stale record to still be there.
        // Publish the new record after the reclaim completes.
        await handoffLiveDiscoveryOwner(
          this.config.discoveryDir,
          { pid: process.pid, instanceNonce: this.instanceNonce },
          async () => undefined,
          { waitForHandoffGrace: false },
        );
        await writeLiveDiscoveryFile(this.config.discoveryDir, record);
        this.discoveryPublished = true;
        return;
      }
      throw new Error(
        `Another Qwen Live Harness daemon (pid ${error.ownerPid}) already owns the Host ` +
          'discovery file. Stop that daemon and start qwen-live-harness again.',
      );
    }
  }
}
