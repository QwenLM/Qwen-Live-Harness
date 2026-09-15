import {
  launchRegisteredDaemon,
  StartupError,
} from 'qwen-live-harness/startup';

type LaunchOptions = Parameters<typeof launchRegisteredDaemon>[0];
type LaunchResult = Awaited<ReturnType<typeof launchRegisteredDaemon>>;

export type DaemonBootstrapState =
  | { phase: 'idle' | 'starting' | 'ready' }
  | { phase: 'failed'; error: unknown };

/** Only explicit app launches call start; transport reconnection never does. */
export class HostDaemonBootstrap {
  private state: DaemonBootstrapState = { phase: 'idle' };
  private operation: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private stopping = false;
  private cleanupFailure: StartupError | undefined;

  constructor(
    private readonly options: Omit<LaunchOptions, 'signal' | 'startIfMissing'>,
    private readonly callbacks: {
      onReady: (result: LaunchResult) => void | Promise<void>;
      onChange: () => void;
    },
    private readonly launch = launchRegisteredDaemon,
  ) {}

  get snapshot(): DaemonBootstrapState {
    return this.state;
  }

  markConnected(): void {
    if (this.stopping || this.state.phase === 'ready') return;
    this.state = { phase: 'ready' };
    this.callbacks.onChange();
  }

  start({
    startIfMissing = true,
  }: { startIfMissing?: boolean } = {}): Promise<void> {
    if (this.stopping || this.cleanupFailure) return Promise.resolve();
    if (this.operation) return this.operation;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.state = { phase: 'starting' };
    this.callbacks.onChange();
    const operation = Promise.resolve()
      .then(() => this.launch({ ...this.options, startIfMissing, signal }))
      .then(async (result) => {
        // Register the authenticated target even if Quit raced with readiness.
        // The caller can then confirm shutdown before allowing the app to exit.
        await this.callbacks.onReady(result);
        if (!signal.aborted) this.state = { phase: 'ready' };
      })
      .catch((error: unknown) => {
        if (
          error instanceof StartupError &&
          error.code === 'startup_cleanup_failed'
        ) {
          this.cleanupFailure = error;
        }
        if (!signal.aborted && this.state.phase !== 'ready') {
          this.state = { phase: 'failed', error };
        }
      })
      .finally(() => {
        if (this.operation === operation) this.operation = undefined;
        if (!this.stopping) this.callbacks.onChange();
      });
    this.operation = operation;
    return operation;
  }

  /** No further launch is allowed after the user requests whole-app Quit. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.abort?.abort();
    const previousFailure = this.cleanupFailure;
    await this.operation;
    if (this.cleanupFailure) {
      if (
        previousFailure === this.cleanupFailure &&
        this.cleanupFailure.retryCleanup
      ) {
        await this.cleanupFailure.retryCleanup();
        this.cleanupFailure = undefined;
      } else {
        throw this.cleanupFailure;
      }
    }
  }
}
