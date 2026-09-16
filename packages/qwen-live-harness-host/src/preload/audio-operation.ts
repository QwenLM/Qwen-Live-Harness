export const AUDIO_START_TIMEOUT_MS = 10_000;
export const AUDIO_CLOSE_TIMEOUT_MS = 1_000;

export class AudioOperationTimeoutError extends Error {
  constructor(
    readonly code: string,
    readonly stage?: string,
  ) {
    super(code);
    this.name = 'AudioOperationTimeoutError';
  }
}

/** Browser audio promises cannot be cancelled, so abandon and clean late results. */
export class AudioOperation {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  stage: string | undefined;

  constructor(
    private readonly name: string,
    timeoutMs = AUDIO_START_TIMEOUT_MS,
  ) {
    this.timer = setTimeout(() => {
      this.controller.abort(
        new AudioOperationTimeoutError(`${name}_timeout`, this.stage),
      );
    }, timeoutMs);
  }

  cancel(): void {
    this.controller.abort(
      new DOMException(`${this.name}_cancelled`, 'AbortError'),
    );
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  throwIfAborted(): void {
    this.controller.signal.throwIfAborted();
  }

  async wait<T>(
    operation: () => Promise<T>,
    cleanupLate?: (value: T) => void | Promise<void>,
  ): Promise<T> {
    const { signal } = this.controller;
    signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const abort = () => {
        settled = true;
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      const complete = () => {
        settled = true;
        signal.removeEventListener('abort', abort);
      };
      try {
        void operation().then(
          (value) => {
            if (settled || signal.aborted) {
              void Promise.resolve()
                .then(() => cleanupLate?.(value))
                .catch(() => undefined);
              return;
            }
            complete();
            resolve(value);
          },
          (error: unknown) => {
            if (settled) return;
            complete();
            reject(error);
          },
        );
      } catch (error) {
        complete();
        reject(error);
      }
    });
  }
}

export async function closeAudioContext(context?: AudioContext): Promise<void> {
  if (!context) return;
  const operation = new AudioOperation('audio_close', AUDIO_CLOSE_TIMEOUT_MS);
  try {
    await operation.wait(() => context.close());
  } catch {
    // Stream tracks and graph nodes are released before waiting for the device.
  } finally {
    operation.dispose();
  }
}

export function stopAudioStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
