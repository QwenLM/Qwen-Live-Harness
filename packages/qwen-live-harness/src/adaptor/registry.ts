/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The set of backends a live call can drive. One of them is the default
 * (what a bare session_create/handoff resolves to); the rest are named
 * targets the voice model selects via session_create's `backend` arg.
 *
 * Preflight policy: the DEFAULT backend's failure aborts daemon start
 * before the discovery file is claimed. An explicitly empty registry supports
 * direct voice, visual input, Memory, and Proactive without task delegation.
 * Secondary backends are best-effort AND off the ready path: their warm-up
 * starts once the default is ready, but the daemon never waits for it (a cold
 * package-runner install can take minutes). Until a warm-up settles the entry
 * reads 'starting'; a failure marks it unavailable with the last error, and
 * session_create naming it awaits that warm-up before reporting the error.
 */

import type { BackendAdaptor, BackendHandle } from './types.js';

export interface RegisteredBackend {
  readonly adaptor: BackendAdaptor;
  readonly isDefault: boolean;
  /** 'starting' until a secondary's background warm-up settles. */
  status: 'starting' | 'ready' | 'unavailable';
  lastError?: string;
}

export type RegistryLog = (message: string) => void;
export type RegistryProgress = (event: {
  backend: string;
  stage: 'starting' | 'ready' | 'unavailable';
}) => void;

export class BackendRegistry {
  private readonly entries: RegisteredBackend[];
  private readonly byName: Map<string, RegisteredBackend>;
  /** In-flight secondary warm-ups by backend name; settled ones drop out. */
  private readonly warmups = new Map<string, Promise<void>>();
  private closing = false;

  constructor(
    entries: ReadonlyArray<{ adaptor: BackendAdaptor; isDefault: boolean }>,
  ) {
    this.entries = entries.map((entry) => ({
      adaptor: entry.adaptor,
      isDefault: entry.isDefault,
      status: 'ready' as const,
    }));
    this.byName = new Map(
      this.entries.map((entry) => [entry.adaptor.name, entry]),
    );
  }

  get hasBackends(): boolean {
    return this.entries.length > 0;
  }

  get defaultAdaptor(): BackendAdaptor {
    const entry = this.entries.find((candidate) => candidate.isDefault);
    if (!entry) {
      // Empty registries have no default. Callers must check hasBackends
      // before starting work; nonempty configuration validates its default.
      throw new Error('no default backend configured');
    }
    return entry.adaptor;
  }

  get defaultName(): string {
    return this.defaultAdaptor.name;
  }

  names(): string[] {
    return this.entries.map((entry) => entry.adaptor.name);
  }

  /** All registered backends, default first. */
  all(): readonly RegisteredBackend[] {
    return this.entries;
  }

  byAdaptorName(name: string): RegisteredBackend | undefined {
    return this.byName.get(name);
  }

  /**
   * The adaptor that owns a backend handle. Handles are minted only by
   * registered adaptors, so an unknown name is an invariant violation —
   * throw rather than guess.
   */
  adaptorFor(handle: BackendHandle): BackendAdaptor {
    const entry = this.byName.get(handle.adaptor);
    if (!entry) {
      throw new Error(
        `unknown backend '${handle.adaptor}' (configured: ${this.names().join(', ')})`,
      );
    }
    return entry.adaptor;
  }

  async preflight(
    log: RegistryLog,
    progress?: RegistryProgress,
  ): Promise<void> {
    if (!this.hasBackends) return;
    // Default first, and its failure aborts startup.
    progress?.({ backend: this.defaultAdaptor.name, stage: 'starting' });
    await this.defaultAdaptor.preflight();
    progress?.({ backend: this.defaultAdaptor.name, stage: 'ready' });
    // Secondaries warm up in the background. Their readiness is best-effort,
    // so it must never sit on the daemon's ready path: a package-runner
    // install can take minutes, and the daemon is usable without them.
    for (const entry of this.entries) {
      if (entry.isDefault) continue;
      void this.warmUp(entry, log, progress);
    }
  }

  /**
   * Await a secondary backend's in-flight warm-up, resolving immediately when
   * none is pending. Only entries reading 'starting' have one; every other
   * status is already settled.
   */
  async whenReady(name: string): Promise<void> {
    await this.warmups.get(name);
  }

  private warmUp(
    entry: RegisteredBackend,
    log: RegistryLog,
    progress?: RegistryProgress,
  ): Promise<void> {
    const name = entry.adaptor.name;
    const inFlight = this.warmups.get(name);
    if (inFlight) return inFlight;
    entry.status = 'starting';
    progress?.({ backend: name, stage: 'starting' });
    const running = (async () => {
      try {
        await entry.adaptor.preflight();
        entry.status = 'ready';
        progress?.({ backend: name, stage: 'ready' });
      } catch (error) {
        entry.status = 'unavailable';
        entry.lastError =
          error instanceof Error ? error.message : String(error);
        // A shutdown that interrupts a warm-up is not a broken backend; the
        // adaptor reports itself closed, which would misread as a config fix.
        if (this.closing) return;
        progress?.({ backend: name, stage: 'unavailable' });
        log(`backend '${name}' unavailable: ${entry.lastError}`);
      } finally {
        this.warmups.delete(name);
      }
      // Fire-and-forget: the outcome lives in status/lastError, so a warm-up
      // must never reject — an unhandled rejection would kill the daemon, and
      // whenReady() would surface a reporting fault as a backend failure.
    })().catch(() => {});
    this.warmups.set(name, running);
    return running;
  }

  async closeAll(log: RegistryLog): Promise<void> {
    this.closing = true;
    await Promise.allSettled(
      this.entries.map(async (entry) => {
        try {
          await entry.adaptor.close();
        } catch (error) {
          log(
            `closing backend '${entry.adaptor.name}' failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );
  }
}
