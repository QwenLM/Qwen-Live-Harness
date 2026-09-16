import {
  readDaemonStopMarker,
  type DaemonIdentity,
} from 'qwen-live-harness/lifecycle';
import { readDiscoveryFile } from './discovery.ts';

const OWNER_ARGUMENT = '--qwen-live-harness-owner=';
const POLL_INTERVAL_MS = 250;

export function parseDaemonOwner(
  argv: readonly string[],
): DaemonIdentity | undefined {
  const arguments_ = argv.filter((argument) =>
    argument.startsWith('--qwen-live-harness-owner'),
  );
  if (arguments_.length === 0) return undefined;
  const match =
    arguments_.length === 1 && arguments_[0]?.startsWith(OWNER_ARGUMENT)
      ? /^(\d+):([A-Za-z0-9_-]{16,256})$/u.exec(
          arguments_[0].slice(OWNER_ARGUMENT.length),
        )
      : null;
  const pid = match ? Number(match[1]) : 0;
  if (!match || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('Invalid desktop daemon identity');
  return { pid, instanceNonce: match[2]! };
}

function sameIdentity(
  left: DaemonIdentity | undefined,
  right: DaemonIdentity,
): boolean {
  return left?.pid === right.pid && left.instanceNonce === right.instanceNonce;
}

/** Explicit process shutdown survives transport loss and late App startup. */
export class HostDaemonLifecycle {
  private identity: DaemonIdentity | undefined;
  private generation = 0;
  private identityGeneration = 0;
  private identityChecks = 0;
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private stopped = false;
  private paused = false;
  private errorReported = false;

  constructor(
    private readonly discoveryPath: string,
    private readonly callbacks: {
      onStopped: (identity: DaemonIdentity) => void;
      onError?: () => void;
    },
    private readonly dependencies = {
      readStop: readDaemonStopMarker,
      readDiscovery: readDiscoveryFile,
    },
  ) {}

  /** Initial CLI arguments or an authenticated startup / welcome identity. */
  follow(identity: DaemonIdentity): void {
    if (this.stopped) return;
    if (!sameIdentity(this.identity, identity)) {
      this.generation += 1;
      this.identityGeneration += 1;
      this.identity = { ...identity };
      this.polling = undefined;
      this.errorReported = false;
    }
    if (this.paused) return;
    this.timer ??= setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.timer.unref();
    void this.poll();
  }

  /** A second App invocation cannot replace the tracked instance by argv alone. */
  async acceptActivation(identity: DaemonIdentity): Promise<boolean> {
    if (this.stopped || this.paused) return false;
    if (sameIdentity(this.identity, identity)) return true;
    return await this.checkIdentity(identity, false);
  }

  /** A late successful handshake / bootstrap must not restore a replaced owner. */
  async acceptAuthenticated(
    identity: DaemonIdentity,
    { allowMissing = false }: { allowMissing?: boolean } = {},
  ): Promise<boolean> {
    return await this.checkIdentity(identity, allowMissing);
  }

  private async checkIdentity(
    identity: DaemonIdentity,
    allowMissing: boolean,
  ): Promise<boolean> {
    if (this.stopped) return false;
    const generation = this.identityGeneration;
    const previous = this.identity;
    this.identityChecks += 1;
    // Hold a previous owner's marker while validating a newly welcomed owner.
    this.generation += 1;
    this.polling = undefined;
    try {
      const record = await this.dependencies.readDiscovery(this.discoveryPath);
      if (this.stopped || generation !== this.identityGeneration) return false;
      const matches =
        record.kind === 'ready' && sameIdentity(record.record, identity);
      // A Quit racing a successful authenticated bootstrap still needs its
      // target even if discovery was removed. A newer owner always wins.
      const quittingOriginal =
        allowMissing &&
        record.kind === 'missing' &&
        (previous === undefined || sameIdentity(previous, identity));
      if (!matches && !quittingOriginal) return false;
      this.follow(identity);
      return true;
    } finally {
      this.identityChecks -= 1;
      void this.poll();
    }
  }

  pause(): void {
    this.paused = true;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.polling = undefined;
  }

  resume(): void {
    if (this.stopped) return;
    this.paused = false;
    if (this.identity) this.follow(this.identity);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.polling = undefined;
  }

  async poll(): Promise<void> {
    if (this.stopped || this.paused || this.identityChecks || !this.identity)
      return;
    if (this.polling) return this.polling;
    const identity = { ...this.identity };
    const generation = this.generation;
    const operation = (async () => {
      try {
        const stopped = await this.dependencies.readStop(
          this.discoveryPath,
          identity,
        );
        if (this.stopped || generation !== this.generation) return;
        this.errorReported = false;
        if (!stopped) return;
        this.stop();
        this.callbacks.onStopped(identity);
      } catch {
        if (this.stopped || generation !== this.generation) return;
        if (!this.errorReported) this.callbacks.onError?.();
        this.errorReported = true;
      }
    })();
    this.polling = operation;
    try {
      await operation;
    } finally {
      if (this.polling === operation) this.polling = undefined;
    }
  }
}
