/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Result backflow: takes normalized backend happenings and injects them into
 * the realtime conversation at safe moments.
 *
 * Spoken/detail split: every item lands as silent context (the model can
 * answer follow-ups from it), and speech-worthy items additionally trigger a
 * short verbatim spoken line.
 * Permission questions, task outcomes, external peer reports and asynchronous
 * search results use dedicated model-authored response lanes rather than
 * verbatim speech clamps.
 *
 * The injection window is closed while any of these hold:
 *  1. the user is speaking (VAD),
 *  2. a realtime response is in flight,
 *  3. Host playback has started but has not completed.
 * The negotiated Host playback protocol supplies the receipts used for (3).
 */

const QUIET_GAP_MS = 800;
const RECHECK_MIN_MS = 100;
const PROGRESS_THROTTLE_MS = 5 * 60_000;
const MAX_SPOKEN_CHARS = 280;
const MAX_CONTEXT_CHARS = 6_000;
const MAX_PENDING_PEER_REPORTS = 32;
const MAX_SEEN_PEER_REPORTS = 256;
const MAX_SEEN_SEARCH_RESULTS = 256;
const RECOVERED_AUDIO_SIGNAL_WAIT_MS = 8_000;

export type InjectorItemKind =
  | 'complete'
  | 'progress'
  | 'permission'
  | 'task_result'
  | 'error'
  | 'speak'
  | 'control'
  | 'peer_report'
  | 'search_result'
  | 'proactive';

export interface InjectorItem {
  kind: InjectorItemKind;
  /** Silent context body; peer reports use this only as a quoted speech body. */
  context: string;
  /** Verbatim spoken line; omitted items inject silently. */
  spoken?: string;
  jobHandle?: string;
  /** For permission items: lets a remote resolution retract the ask. */
  requestId?: string;
  announce?: boolean;
  /** Stable scheduler delivery id for a queued Proactive announcement. */
  deliveryId?: string;
  /** Daemon-owned text receipt, acknowledged only after full context delivery. */
  controlId?: string;
  /** Call-scoped external report identity, separate from jobs and controls. */
  reportId?: string;
  /** Call-scoped search task identity, separate from backend job handles. */
  searchId?: string;
}

export interface InjectorSink {
  /** Silent context injection; false when the transport refused. */
  injectContext(text: string): boolean;
  /** Verbatim speech request; false when the transport refused. */
  injectSpeech(text: string): boolean;
  /** Model-authored permission question; never fall back to verbatim speech. */
  injectPermission?(text: string): boolean;
  /** Model-authored task outcome; must never inherit a tool capability. */
  injectTaskResult?(text: string): boolean;
  /** A model-authored Proactive response request; false when refused. */
  injectProactive?(text: string): boolean;
  /** Isolated external quotation; must never fall back to ordinary speech. */
  injectPeerReport?(text: string, reportId?: string): boolean;
  /** Answer from quoted search evidence; never fall back to ordinary speech. */
  injectSearchResult?(text: string, searchId?: string): boolean;
  /** Accepted by the transport; this does not acknowledge Host playback. */
  onInjected?(item: InjectorItem, spoken: boolean): void;
}

export interface InjectorOptions {
  sink: InjectorSink;
  now?: () => number;
  quietGapMs?: number;
  progressThrottleMs?: number;
}

/**
 * Progress-throttle key: the job handle when the item has one, otherwise the
 * item's full context (the map is per-call and bounded in practice).
 */
function progressKeyOf(item: InjectorItem): string {
  return item.jobHandle ?? `ctx:${item.context}`;
}

export class Injector {
  private readonly sink: InjectorSink;
  private readonly now: () => number;
  private readonly quietGapMs: number;
  private readonly progressThrottleMs: number;

  private queue: InjectorItem[] = [];
  private speechInProgress = false;
  private responseInFlight = false;
  private directResponsePending = false;
  private responseRequestPending = false;
  private notificationRequestPending = false;
  private transportRecovering = false;
  private recoveredInputPending = false;
  private recoveredInputTimer: ReturnType<typeof setTimeout> | undefined;
  private playbackInProgress = false;
  private playbackCompletedAt = 0;
  private proactiveCycle:
    | {
        deliveryId?: string;
        responseStarted: boolean;
        responseDone: boolean;
        playbackStarted: boolean;
        playbackDone: boolean;
      }
    | undefined;
  private peerReportCycle:
    | {
        responseStarted: boolean;
        responseDone: boolean;
        playbackStarted: boolean;
        playbackDone: boolean;
      }
    | undefined;
  private readonly seenPeerReports = new Set<string>();
  private searchResultCycle:
    | {
        searchId?: string;
        responseStarted: boolean;
        responseDone: boolean;
        playbackStarted: boolean;
        playbackDone: boolean;
      }
    | undefined;
  private readonly seenSearchResults = new Set<string>();
  private lastProgressAt = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private flushing = false;

  constructor(options: InjectorOptions) {
    this.sink = options.sink;
    this.now = options.now ?? Date.now;
    this.quietGapMs = options.quietGapMs ?? QUIET_GAP_MS;
    this.progressThrottleMs =
      options.progressThrottleMs ?? PROGRESS_THROTTLE_MS;
  }

  // -- window state signals (fed by the orchestrator) ----------------------

  noteSpeechStarted(): boolean {
    this.clearRecoveredInputTimer();
    const outputWasPlaying = this.playbackInProgress;
    this.playbackInProgress = false;
    this.playbackCompletedAt = 0;
    this.speechInProgress = true;
    this.notificationRequestPending = false;
    // An accepted external quotation is never replayed after a barge-in.
    this.peerReportCycle = undefined;
    this.searchResultCycle = undefined;
    // Barge-in semantics: pending progress is stale the moment the user
    // speaks; conclusions and permission asks stay queued. A dropped item
    // was never delivered, so its throttle stamp must not stand — the job's
    // next progress report may come well within the window.
    const kept: InjectorItem[] = [];
    for (const item of this.queue) {
      if (item.kind === 'progress') {
        this.lastProgressAt.delete(progressKeyOf(item));
      } else {
        kept.push(item);
      }
    }
    this.queue = kept;
    return outputWasPlaying;
  }

  noteInputCommitted(responsePending = false): void {
    this.clearRecoveredInputTimer();
    this.speechInProgress = false;
    this.directResponsePending = responsePending;
    this.poke();
  }

  noteResponseCreated(authority?: string): void {
    this.clearRecoveredInputTimer();
    this.recoveredInputPending = false;
    this.directResponsePending = false;
    this.responseRequestPending = false;
    this.notificationRequestPending = false;
    this.responseInFlight = true;
    if (authority === 'proactive' && this.proactiveCycle) {
      this.proactiveCycle.responseStarted = true;
    }
    if (authority === 'peer_report' && this.peerReportCycle) {
      this.peerReportCycle.responseStarted = true;
    }
    if (authority === 'search_result' && this.searchResultCycle) {
      this.searchResultCycle.responseStarted = true;
    }
  }

  noteResponseDone(authority?: string): void {
    this.responseInFlight = false;
    if (authority === 'permission' || authority === 'task_result')
      this.notificationRequestPending = false;
    if (authority === 'proactive' && this.proactiveCycle) {
      this.proactiveCycle.responseDone = true;
      this.finishProactiveCycleIfComplete();
    }
    if (authority === 'peer_report') {
      // Also releases a request which failed before response.created.
      this.responseRequestPending = false;
      if (this.peerReportCycle) {
        this.peerReportCycle.responseDone = true;
        this.finishPeerReportCycleIfComplete();
      }
    }
    if (authority === 'search_result') {
      this.responseRequestPending = false;
      if (this.searchResultCycle) {
        this.searchResultCycle.responseDone = true;
        this.finishSearchResultCycleIfComplete();
      }
    }
    this.poke();
  }

  /** Fence stale transport state without treating it as a completed response. */
  beginTransportRecovery(): void {
    this.transportRecovering = true;
    this.clearRecoveredInputTimer();
    this.recoveredInputPending = false;
    this.speechInProgress = false;
    this.responseInFlight = false;
    this.directResponsePending = false;
    this.responseRequestPending = false;
    this.notificationRequestPending = false;
    this.playbackInProgress = false;
    this.playbackCompletedAt = 0;
    this.proactiveCycle = undefined;
    this.peerReportCycle = undefined;
    this.searchResultCycle = undefined;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Preserve the order of undelivered Proactive items ahead of newer events. */
  restoreProactiveAfterRecovery(items: readonly InjectorItem[]): void {
    if (this.disposed || !this.transportRecovering) return;
    const restored = items.filter(
      (item) => item.kind === 'proactive' && item.deliveryId,
    );
    const ids = new Set(restored.map((item) => item.deliveryId));
    this.queue = [
      ...restored,
      ...this.queue.filter(
        (item) => item.kind !== 'proactive' || !ids.has(item.deliveryId),
      ),
    ];
  }

  completeTransportRecovery(inputKind: 'text' | 'audio' | 'none'): void {
    if (this.disposed || !this.transportRecovering) return;
    this.transportRecovering = false;
    this.recoveredInputPending = inputKind !== 'none' && !this.responseInFlight;
    if (
      inputKind === 'none' &&
      !this.speechInProgress &&
      !this.responseInFlight
    )
      this.directResponsePending = false;
    if (
      inputKind === 'audio' &&
      this.recoveredInputPending &&
      !this.speechInProgress &&
      !this.directResponsePending
    ) {
      // Restored PCM may not produce VAD (for example a very short noise).
      // Release only this recovery guard if no real input signal arrives.
      this.recoveredInputTimer = setTimeout(() => {
        this.recoveredInputTimer = undefined;
        this.recoveredInputPending = false;
        this.poke();
      }, RECOVERED_AUDIO_SIGNAL_WAIT_MS);
      this.recoveredInputTimer.unref?.();
    }
    this.poke();
  }

  private clearRecoveredInputTimer(): void {
    if (this.recoveredInputTimer !== undefined)
      clearTimeout(this.recoveredInputTimer);
    this.recoveredInputTimer = undefined;
  }

  notePlaybackStarted(): void {
    this.playbackInProgress = true;
    this.playbackCompletedAt = 0;
    if (this.proactiveCycle?.responseStarted) {
      this.proactiveCycle.playbackStarted = true;
    }
    if (this.peerReportCycle?.responseStarted) {
      this.peerReportCycle.playbackStarted = true;
    }
    if (this.searchResultCycle?.responseStarted) {
      this.searchResultCycle.playbackStarted = true;
    }
  }

  notePlaybackCompleted(): void {
    this.playbackInProgress = false;
    this.playbackCompletedAt = this.now();
    if (this.proactiveCycle?.playbackStarted) {
      this.proactiveCycle.playbackDone = true;
      this.finishProactiveCycleIfComplete();
    }
    if (this.peerReportCycle?.playbackStarted) {
      this.peerReportCycle.playbackDone = true;
      this.finishPeerReportCycleIfComplete();
    }
    if (this.searchResultCycle?.playbackStarted) {
      this.searchResultCycle.playbackDone = true;
      this.finishSearchResultCycleIfComplete();
    }
    this.poke();
  }

  noteOutputCleared(): void {
    this.playbackInProgress = false;
    this.playbackCompletedAt = 0;
    this.peerReportCycle = undefined;
    this.searchResultCycle = undefined;
    this.poke();
  }

  /**
   * Release playback suppressed by an explicit user mute. A Proactive cycle
   * is completed only when the caller confirms that real response audio was
   * present; muting before any audio must not turn a silent response into a
   * successful delivery.
   */
  noteOutputSuppressed(completeProactive = false): void {
    this.playbackInProgress = false;
    this.playbackCompletedAt = 0;
    if (completeProactive && this.proactiveCycle) {
      this.proactiveCycle.playbackDone = true;
      this.finishProactiveCycleIfComplete();
    }
    if (this.peerReportCycle) {
      this.peerReportCycle.playbackDone = true;
      this.finishPeerReportCycleIfComplete();
    }
    if (this.searchResultCycle) {
      // The caller records suppressed/failed output separately from delivery.
      this.searchResultCycle.playbackDone = true;
      this.finishSearchResultCycleIfComplete();
    }
    this.poke();
  }

  // -- queue --------------------------------------------------------------

  enqueue(item: InjectorItem): boolean {
    if (this.disposed) return false;
    if (item.kind === 'search_result' && item.searchId) {
      if (
        this.seenSearchResults.has(item.searchId) ||
        this.searchResultCycle?.searchId === item.searchId ||
        this.queue.some(
          (queued) =>
            queued.kind === 'search_result' &&
            queued.searchId === item.searchId,
        )
      )
        return true;
      this.seenSearchResults.add(item.searchId);
      if (this.seenSearchResults.size > MAX_SEEN_SEARCH_RESULTS)
        this.seenSearchResults.delete(
          this.seenSearchResults.values().next().value!,
        );
    }
    if (item.kind === 'peer_report') {
      if (item.reportId && this.seenPeerReports.has(item.reportId)) return true;
      if (
        this.queue.filter((queued) => queued.kind === 'peer_report').length >=
        MAX_PENDING_PEER_REPORTS
      ) {
        return false;
      }
      if (item.reportId) {
        this.seenPeerReports.add(item.reportId);
        if (this.seenPeerReports.size > MAX_SEEN_PEER_REPORTS) {
          const oldest = this.seenPeerReports.values().next().value;
          if (oldest !== undefined) this.seenPeerReports.delete(oldest);
        }
      }
    }
    if (
      item.kind === 'control' &&
      item.controlId &&
      this.queue.some(
        (queued) =>
          queued.kind === 'control' && queued.controlId === item.controlId,
      )
    )
      return true;
    if (
      item.kind === 'permission' &&
      item.requestId !== undefined &&
      this.queue.some(
        (queued) =>
          queued.kind === 'permission' && queued.requestId === item.requestId,
      )
    ) {
      return true;
    }
    if (item.kind === 'progress') {
      // Throttle per job; jobless progress is keyed on its full context so
      // distinct notices (which may share a long common prefix) never
      // collide on one throttle window.
      const key = progressKeyOf(item);
      const last = this.lastProgressAt.get(key) ?? 0;
      if (this.now() - last < this.progressThrottleMs) return true;
      this.lastProgressAt.set(key, this.now());
      // At most one queued progress item per key.
      this.queue = this.queue.filter(
        (queued) =>
          !(queued.kind === 'progress' && progressKeyOf(queued) === key),
      );
    }
    this.queue.push(item);
    this.poke();
    return true;
  }

  /** Retract a queued permission ask that was resolved elsewhere. */
  retractPermission(requestId: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter(
      (item) => !(item.kind === 'permission' && item.requestId === requestId),
    );
    return this.queue.length !== before;
  }

  /** Retract a Proactive event that has not been submitted to Realtime yet. */
  retractProactive(deliveryId: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter(
      (item) => !(item.kind === 'proactive' && item.deliveryId === deliveryId),
    );
    return this.queue.length !== before;
  }

  /** Release an accepted Proactive cycle after cancellation or fatal failure. */
  abortProactive(deliveryId: string): boolean {
    if (this.proactiveCycle?.deliveryId !== deliveryId) return false;
    this.proactiveCycle = undefined;
    this.poke();
    return true;
  }

  /**
   * Atomically put an interrupted Proactive delivery back at the head of its
   * lane. Resetting the active cycle and prepending must be one operation;
   * otherwise aborting first could let the next queued delivery overtake it.
   */
  retryProactiveAtFront(item: InjectorItem): boolean {
    if (
      this.disposed ||
      item.kind !== 'proactive' ||
      !item.deliveryId ||
      this.proactiveCycle?.deliveryId !== item.deliveryId
    ) {
      return false;
    }
    this.proactiveCycle = undefined;
    this.queue = [
      item,
      ...this.queue.filter(
        (queued) =>
          queued.kind !== 'proactive' || queued.deliveryId !== item.deliveryId,
      ),
    ];
    this.poke();
    return true;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  /** A user mute consumes queued reports without blocking ordinary context. */
  dropPeerReports(): string[] {
    const ids = this.queue.flatMap((item) =>
      item.kind === 'peer_report' && item.reportId ? [item.reportId] : [],
    );
    this.queue = this.queue.filter((item) => item.kind !== 'peer_report');
    this.poke();
    return ids;
  }

  /** Retract a result not yet submitted; active responses require Realtime cancellation. */
  retractSearchResult(searchId: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter(
      (item) => item.kind !== 'search_result' || item.searchId !== searchId,
    );
    const removed = before !== this.queue.length;
    this.poke();
    return removed;
  }

  /** Muting or ending a call can discard pending speech without changing task outcomes. */
  dropSearchResults(): string[] {
    const ids = this.queue.flatMap((item) =>
      item.kind === 'search_result' && item.searchId ? [item.searchId] : [],
    );
    this.queue = this.queue.filter((item) => item.kind !== 'search_result');
    this.poke();
    return ids;
  }

  dispose(): void {
    this.disposed = true;
    this.clearRecoveredInputTimer();
    this.queue = [];
    this.peerReportCycle = undefined;
    this.seenPeerReports.clear();
    this.searchResultCycle = undefined;
    this.seenSearchResults.clear();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // -- delivery -----------------------------------------------------------

  private windowClosedForMs(): number {
    if (
      this.speechInProgress ||
      this.transportRecovering ||
      this.recoveredInputPending ||
      this.responseInFlight ||
      this.notificationRequestPending ||
      this.proactiveCycle ||
      this.peerReportCycle ||
      this.searchResultCycle
    ) {
      return -1;
    }
    if (
      (this.queue[0]?.kind === 'proactive' ||
        this.queue[0]?.kind === 'peer_report' ||
        this.queue[0]?.kind === 'search_result' ||
        this.queue[0]?.kind === 'control') &&
      (this.directResponsePending || this.responseRequestPending)
    ) {
      return -1;
    }
    if (this.playbackInProgress) return -1;
    if (this.playbackCompletedAt > 0) {
      const quietAt = this.playbackCompletedAt + this.quietGapMs;
      const wait = quietAt - this.now();
      return wait > 0 ? wait : 0;
    }
    return 0;
  }

  private poke(): void {
    if (this.disposed || this.flushing || this.queue.length === 0) return;
    const wait = this.windowClosedForMs();
    if (wait < 0) return; // reopened by a state signal later
    if (wait === 0) {
      this.flushing = true;
      try {
        while (
          !this.disposed &&
          this.queue.length > 0 &&
          this.windowClosedForMs() === 0
        ) {
          const first = this.queue[0];
          this.flush();
          if (this.queue[0] === first) break;
        }
      } finally {
        this.flushing = false;
      }
      if (this.windowClosedForMs() > 0) this.poke();
      return;
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.poke();
      },
      Math.max(wait, RECHECK_MIN_MS),
    );
    this.timer.unref?.();
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    const firstIndependent = this.queue.findIndex(
      (item) =>
        item.kind === 'proactive' ||
        item.kind === 'control' ||
        item.kind === 'permission' ||
        item.kind === 'task_result' ||
        item.kind === 'peer_report' ||
        item.kind === 'search_result',
    );
    if (firstIndependent === 0) {
      if (this.queue[0]?.kind === 'control') this.flushControl();
      else if (
        this.queue[0]?.kind === 'permission' ||
        this.queue[0]?.kind === 'task_result'
      )
        this.flushNotification();
      else if (this.queue[0]?.kind === 'peer_report') this.flushPeerReport();
      else if (this.queue[0]?.kind === 'search_result')
        this.flushSearchResult();
      else this.flushProactive();
      return;
    }
    const batchEnd =
      firstIndependent < 0 ? this.queue.length : firstIndependent;
    const batch = this.queue.slice(0, batchEnd);
    this.queue = this.queue.slice(batchEnd);

    // One combined silent context injection, budgeted per ITEM. Slicing the
    // joined text instead would let one oversized item push every later one
    // out of the injection entirely — silently, since those items are
    // already dequeued and onInjected still reports them delivered. Whole
    // items that do not fit go back at the head of the queue for the next
    // flush; only a lone item larger than the whole budget is truncated, so
    // that it can never wedge the lane.
    const fitted: InjectorItem[] = [];
    let used = 0;
    for (const item of batch) {
      const cost = item.context.length + (fitted.length > 0 ? 1 : 0);
      if (fitted.length > 0 && used + cost > MAX_CONTEXT_CHARS) break;
      fitted.push(item);
      used += cost;
    }
    const deferred = batch.slice(fitted.length);
    // The lone-item backstop keeps the HEAD, unlike the tail-keeping clamps
    // callers apply to a message BODY. An item's correlation tag is its
    // first characters ("[COMPLETE job_1]", "[PERMISSION req_1]"), and a
    // tail cut would take the tag with it — leaving the model an untagged
    // fragment, or a permission ask with no handle to vote on.
    const context = fitted
      .map((item, index) =>
        index === 0 && item.context.length > MAX_CONTEXT_CHARS
          ? `${item.context.slice(0, MAX_CONTEXT_CHARS - 1)}…`
          : item.context,
      )
      .join('\n');
    const contextAccepted = this.sink.injectContext(context);

    // One combined spoken line for the speech-worthy items — whole lines
    // only, since the model is told to read the text verbatim. Drawn from
    // the FITTED items, never the whole batch: speaking for an item whose
    // context was deferred would announce a result the model cannot back
    // up, and would then say it again when that item really lands.
    const spokenLines = fitted
      .map((item) => item.spoken)
      .filter((line): line is string => typeof line === 'string' && !!line);
    let spoken = '';
    for (const line of spokenLines) {
      const candidate = spoken ? `${spoken} ${line}` : line;
      if (candidate.length > MAX_SPOKEN_CHARS && spoken) break;
      spoken =
        candidate.length > MAX_SPOKEN_CHARS
          ? `${candidate.slice(0, MAX_SPOKEN_CHARS)}…`
          : candidate;
    }
    let spokenAccepted = false;
    if (spoken) {
      spokenAccepted = this.sink.injectSpeech(spoken);
      if (spokenAccepted) this.responseRequestPending = true;
    }

    if (!contextAccepted && !spokenAccepted) {
      // Transport refused (socket busy/closed): requeue and retry shortly.
      this.queue = [...batch, ...this.queue];
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.poke();
      }, this.quietGapMs);
      this.timer.unref?.();
      return;
    }
    // Back at the head, so poke()'s flush loop picks them up on its next
    // pass — a deferred item becomes its own injection, never a lost one.
    if (deferred.length > 0) this.queue = [...deferred, ...this.queue];
    for (const item of fitted) {
      this.sink.onInjected?.(item, spokenLines.length > 0);
    }
    this.poke();
  }

  private flushProactive(): void {
    const item = this.queue[0];
    if (!item || item.kind !== 'proactive') return;
    this.proactiveCycle = {
      ...(item.deliveryId ? { deliveryId: item.deliveryId } : {}),
      responseStarted: false,
      responseDone: false,
      playbackStarted: false,
      playbackDone: false,
    };
    const accepted = this.sink.injectProactive
      ? this.sink.injectProactive(item.context)
      : this.sink.injectSpeech(item.context);
    if (!accepted) {
      this.proactiveCycle = undefined;
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.poke();
      }, this.quietGapMs);
      this.timer.unref?.();
      return;
    }
    this.queue.shift();
    this.sink.onInjected?.(item, true);
  }

  private flushNotification(): void {
    const item = this.queue[0];
    if (!item || (item.kind !== 'permission' && item.kind !== 'task_result'))
      return;
    // A committed user turn absorbs this as notification context. At idle,
    // reserve one response so later notifications cannot overtake it.
    const silent = item.kind === 'permission' && item.announce === false;
    this.notificationRequestPending = !silent && !this.directResponsePending;
    let accepted = false;
    try {
      accepted =
        (silent
          ? this.sink.injectContext(item.context)
          : item.kind === 'permission'
            ? this.sink.injectPermission?.(item.context)
            : this.sink.injectTaskResult?.(item.context)) === true;
    } catch {
      // Keep all facts and correlation handles queued on refusal.
    }
    if (!accepted) {
      this.notificationRequestPending = false;
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          this.poke();
        },
        Math.max(this.quietGapMs, RECHECK_MIN_MS),
      );
      this.timer.unref?.();
      return;
    }
    this.queue.shift();
    this.sink.onInjected?.(item, !silent && !this.directResponsePending);
  }

  private flushControl(): void {
    const item = this.queue[0];
    if (!item || item.kind !== 'control') return;
    if (!this.sink.injectContext(item.context)) {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.poke();
      }, this.quietGapMs);
      this.timer.unref?.();
      return;
    }
    this.queue.shift();
    this.sink.onInjected?.(item, false);
    this.poke();
  }

  private flushPeerReport(): void {
    const item = this.queue[0];
    if (!item || item.kind !== 'peer_report') return;
    this.peerReportCycle = {
      responseStarted: false,
      responseDone: false,
      playbackStarted: false,
      playbackDone: false,
    };
    const previousResponseRequestPending = this.responseRequestPending;
    this.responseRequestPending = true;
    if (
      !this.sink.injectPeerReport?.(item.spoken ?? item.context, item.reportId)
    ) {
      this.peerReportCycle = undefined;
      this.responseRequestPending = previousResponseRequestPending;
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          this.poke();
        },
        Math.max(this.quietGapMs, RECHECK_MIN_MS),
      );
      this.timer.unref?.();
      return;
    }
    this.queue.shift();
    this.sink.onInjected?.(item, true);
  }

  private finishPeerReportCycleIfComplete(): void {
    const cycle = this.peerReportCycle;
    if (
      !cycle ||
      !cycle.responseDone ||
      (cycle.playbackStarted && !cycle.playbackDone)
    ) {
      return;
    }
    this.peerReportCycle = undefined;
  }

  private flushSearchResult(): void {
    const item = this.queue[0];
    if (!item || item.kind !== 'search_result') return;
    const cycle = {
      searchId: item.searchId,
      responseStarted: false,
      responseDone: false,
      playbackStarted: false,
      playbackDone: false,
    };
    this.searchResultCycle = cycle;
    const previousResponseRequestPending = this.responseRequestPending;
    this.responseRequestPending = true;
    let accepted = false;
    try {
      accepted =
        this.sink.injectSearchResult?.(item.context, item.searchId) === true;
    } catch {
      // A refused result remains queued; it must not escape through another lane.
    }
    if (!accepted) {
      if (this.searchResultCycle === cycle) this.searchResultCycle = undefined;
      this.responseRequestPending = previousResponseRequestPending;
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          this.poke();
        },
        Math.max(this.quietGapMs, RECHECK_MIN_MS),
      );
      this.timer.unref?.();
      return;
    }
    // A synchronous sink callback may have retracted this exact queue entry.
    const index = this.queue.indexOf(item);
    if (index >= 0) this.queue.splice(index, 1);
    this.sink.onInjected?.(item, true);
  }

  private finishSearchResultCycleIfComplete(): void {
    const cycle = this.searchResultCycle;
    // response.done can precede the Host's first playback receipt. A response
    // ending alone must not let the next result overtake its buffered audio.
    if (!cycle || !cycle.responseDone || !cycle.playbackDone) return;
    this.searchResultCycle = undefined;
  }

  private finishProactiveCycleIfComplete(): void {
    const cycle = this.proactiveCycle;
    if (!cycle || !cycle.responseDone || !cycle.playbackDone) return;
    this.proactiveCycle = undefined;
  }
}
