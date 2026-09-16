type CaptureAttempt = {
  epoch: number;
  muted: boolean;
  acknowledged: boolean;
  hasFrame: boolean;
  finished: boolean;
};

/** A device promise resolving is not evidence that microphone samples flow. */
export class CaptureReadinessDeadline {
  private attempt: CaptureAttempt | undefined;
  private cancelTimer: (() => void) | undefined;

  constructor(
    private readonly onReady: (epoch: number) => void,
    private readonly onTimeout: (epoch: number) => void,
    private readonly schedule = (callback: () => void) => {
      const timer = setTimeout(callback, 10_000);
      timer.unref();
      return () => clearTimeout(timer);
    },
  ) {}

  arm(epoch: number, muted: boolean): void {
    if (this.attempt?.epoch === epoch) {
      if (this.attempt.muted === muted) return;
      if (muted) {
        this.attempt.muted = true;
        this.complete();
        return;
      }
    }
    this.cancel();
    const attempt: CaptureAttempt = {
      epoch,
      muted,
      acknowledged: false,
      hasFrame: false,
      finished: false,
    };
    this.attempt = attempt;
    this.cancelTimer = this.schedule(() => {
      if (this.attempt !== attempt || attempt.finished) return;
      attempt.finished = true;
      this.cancelTimer = undefined;
      this.onTimeout(epoch);
    });
  }

  acknowledge(epoch: number): void {
    if (this.attempt?.epoch !== epoch || this.attempt.finished) return;
    this.attempt.acknowledged = true;
    this.complete();
  }

  frame(epoch: number): void {
    if (this.attempt?.epoch !== epoch || this.attempt.finished) return;
    this.attempt.hasFrame = true;
    this.complete();
  }

  cancel(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.attempt = undefined;
  }

  isReady(epoch: number): boolean {
    return (
      this.attempt?.epoch === epoch &&
      this.attempt.finished &&
      this.attempt.acknowledged &&
      (this.attempt.muted || this.attempt.hasFrame)
    );
  }

  private complete(): void {
    const attempt = this.attempt;
    if (
      !attempt ||
      attempt.finished ||
      !attempt.acknowledged ||
      (!attempt.muted && !attempt.hasFrame)
    )
      return;
    attempt.finished = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.onReady(attempt.epoch);
  }
}
