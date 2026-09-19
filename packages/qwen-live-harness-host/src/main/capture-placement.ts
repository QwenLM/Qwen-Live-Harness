import {
  clampOverlayPosition,
  type DisplayWorkArea,
  type OverlayPosition,
} from './overlay-position.ts';

export interface CapturePlacementSnapshot {
  owner: object;
  nativeBounds: DisplayWorkArea;
  contentBounds?: DisplayWorkArea;
  logical: OverlayPosition;
  offset: OverlayPosition;
  workArea: DisplayWorkArea;
  visible: DisplayWorkArea;
  layout: string;
  settingsOpen: boolean;
  visualGeneration: number;
}

interface CaptureLease {
  id: number;
  before: CapturePlacementSnapshot;
  timer?: ReturnType<typeof setTimeout>;
}

interface ReverseCompensation {
  id: number;
  before: CapturePlacementSnapshot;
  applied: CapturePlacementSnapshot;
  offset: OverlayPosition;
}

const MAX_CAPTURE_GUARDS = 32;
const CAPTURE_GUARD_LIFETIME_MS = 15_000;

const samePoint = (a: OverlayPosition, b: OverlayPosition) =>
  a.x === b.x && a.y === b.y;
const sameRect = (a: DisplayWorkArea, b: DisplayWorkArea) =>
  samePoint(a, b) && a.width === b.width && a.height === b.height;
const samePlacementContext = (
  a: CapturePlacementSnapshot,
  b: CapturePlacementSnapshot,
) =>
  a.owner === b.owner &&
  a.layout === b.layout &&
  a.settingsOpen === b.settingsOpen &&
  sameRect(a.workArea, b.workArea) &&
  sameRect(a.visible, b.visible);
const sameNativeGeometry = (
  a: CapturePlacementSnapshot,
  b: CapturePlacementSnapshot,
) =>
  sameRect(a.nativeBounds, b.nativeBounds) &&
  sameRect(
    a.contentBounds ?? a.nativeBounds,
    b.contentBounds ?? b.nativeBounds,
  );
const publicSnapshot = (snapshot?: CapturePlacementSnapshot) =>
  snapshot && {
    nativeBounds: snapshot.nativeBounds,
    contentBounds: snapshot.contentBounds,
    logical: snapshot.logical,
    offset: snapshot.offset,
    workArea: snapshot.workArea,
    layout: snapshot.layout,
    settingsOpen: snapshot.settingsOpen,
    visualGeneration: snapshot.visualGeneration,
  };

/** Compensate only recognizable OS frame constraints around screen capture. */
export class CapturePlacementGuard {
  private sequence = 0;
  private readonly leases = new Map<number, CaptureLease>();
  // These records can only undo an offset we already applied. Unlike a capture
  // lease they never authorize a new forward correction or expire on a timer.
  private readonly reversals = new Map<object, ReverseCompensation>();

  constructor(
    private readonly snapshot: () => CapturePlacementSnapshot | undefined,
    private readonly compensate: (
      before: CapturePlacementSnapshot,
      offset: OverlayPosition,
    ) => void,
    private readonly diagnostic: (
      event: string,
      details: Record<string, unknown>,
    ) => void,
  ) {}

  async capture<T>(operation: () => Promise<T>): Promise<T> {
    const id = ++this.sequence;
    let before = this.readSnapshot();
    if (before && this.reversals.has(before.owner)) {
      this.reconcileReversal(before.owner, false);
      before = this.readSnapshot();
    }
    const lease: CaptureLease | undefined = before && { id, before };
    if (lease) {
      if (this.leases.size >= MAX_CAPTURE_GUARDS) {
        const oldest = this.leases.keys().next().value;
        if (oldest !== undefined) {
          this.emit('overlay_capture_guard_cancelled', {
            captureId: oldest,
            reason: 'capture-guard-limit',
          });
          this.release(oldest);
        }
      }
      this.leases.set(id, lease);
      // Limit protection metadata even if a native request or its queue stalls;
      // expiring the guard never cancels or changes the underlying capture.
      this.expire(lease, CAPTURE_GUARD_LIFETIME_MS);
    }
    this.emit('overlay_capture_started', {
      captureId: id,
      before: publicSnapshot(before),
    });
    let succeeded = false;
    try {
      const result = await operation();
      succeeded = true;
      return result;
    } finally {
      this.emit('overlay_capture_finished', {
        captureId: id,
        succeeded,
        before: publicSnapshot(before),
        after: publicSnapshot(this.readSnapshot()),
      });
      if (before) this.reconcileReversal(before.owner, true);
      if (lease && this.leases.has(id)) {
        this.reconcile(lease, 'capture-finished');
        if (!succeeded) this.release(id);
        else if (this.leases.has(id)) {
          // AppKit may deliver a frame-constraint move after the capture promise.
          this.expire(lease, 500);
        }
      }
      if (before) this.reconcileReversal(before.owner, false);
    }
  }

  nativeMoved(owner: object): void {
    this.reconcileReversal(owner, true);
    for (const lease of [...this.leases.values()].reverse()) {
      if (lease.before.owner === owner) this.reconcile(lease, 'native-move');
    }
    this.reconcileReversal(owner, false);
  }

  nativeResized(owner: object): void {
    this.reconcileReversal(owner, true);
    for (const lease of [...this.leases.values()].reverse()) {
      if (lease.before.owner === owner) this.reconcile(lease, 'native-resize');
    }
    this.reconcileReversal(owner, false);
  }

  invalidate(reason: string): void {
    const activeIds = new Set(this.leases.keys());
    for (const lease of this.leases.values()) {
      this.emit('overlay_capture_guard_cancelled', {
        captureId: lease.id,
        reason,
      });
      this.release(lease.id);
    }
    for (const reversal of this.reversals.values()) {
      if (!activeIds.has(reversal.id))
        this.emit('overlay_capture_guard_cancelled', {
          captureId: reversal.id,
          reason,
        });
    }
    this.reversals.clear();
  }

  private rememberReversal(
    lease: CaptureLease,
    applied: CapturePlacementSnapshot,
    offset: OverlayPosition,
  ): void {
    const previous = this.reversals.get(lease.before.owner);
    const canExtend =
      previous &&
      samePlacementContext(previous.before, lease.before) &&
      samePoint(previous.before.logical, lease.before.logical) &&
      (samePoint(previous.offset, lease.before.offset) ||
        samePoint(previous.before.offset, lease.before.offset));
    const before = canExtend ? previous.before : lease.before;
    const id = canExtend ? previous.id : lease.id;
    this.reversals.delete(before.owner);
    if (sameNativeGeometry(before, applied) && samePoint(before.offset, offset))
      return;
    if (this.reversals.size >= MAX_CAPTURE_GUARDS) {
      const oldest = this.reversals.keys().next().value;
      if (oldest !== undefined) this.reversals.delete(oldest);
    }
    this.reversals.set(before.owner, {
      id,
      before,
      applied,
      offset: { ...offset },
    });
  }

  private reconcileReversal(
    owner: object,
    deferUnknownGeometry: boolean,
  ): void {
    const reversal = this.reversals.get(owner);
    if (!reversal) return;
    const after = this.readSnapshot();
    // Media generations do not express a new UI position. Only placement,
    // owner and ownership of the actual offset fence an exact inverse.
    if (
      !after ||
      !samePlacementContext(reversal.before, after) ||
      !samePoint(reversal.offset, after.offset)
    ) {
      this.reversals.delete(owner);
      return;
    }
    if (sameNativeGeometry(reversal.before, after)) {
      this.reversals.delete(owner);
      try {
        this.compensate(reversal.before, { ...reversal.before.offset });
      } catch {
        this.emit('overlay_capture_guard_cancelled', {
          captureId: reversal.id,
          reason: 'compensation-failed',
        });
        return;
      }
      this.emit('overlay_capture_compensated', {
        captureId: reversal.id,
        phase: 'native-restore',
        reason: 'native-geometry-restored',
        before: publicSnapshot(reversal.before),
        after: publicSnapshot(after),
        correctedOffset: reversal.before.offset,
      });
      return;
    }
    // Let an active capture classify a subsequent known transition before
    // dropping its inverse record. With no valid forward correction, an
    // ordinary unrelated OS movement is never pulled back to an old anchor.
    if (!deferUnknownGeometry && !sameNativeGeometry(reversal.applied, after))
      this.reversals.delete(owner);
  }

  private readSnapshot(): CapturePlacementSnapshot | undefined {
    try {
      return this.snapshot();
    } catch {
      return undefined;
    }
  }

  private emit(event: string, details: Record<string, unknown>): void {
    try {
      this.diagnostic(event, details);
    } catch {
      // Position diagnostics must never turn a successful screenshot into failure.
    }
  }

  private expire(lease: CaptureLease, milliseconds: number): void {
    if (lease.timer) clearTimeout(lease.timer);
    lease.timer = setTimeout(() => {
      this.emit('overlay_capture_guard_cancelled', {
        captureId: lease.id,
        reason: 'capture-guard-expired',
      });
      this.release(lease.id);
    }, milliseconds);
    lease.timer.unref?.();
  }

  private release(id: number): void {
    const lease = this.leases.get(id);
    if (lease?.timer) clearTimeout(lease.timer);
    this.leases.delete(id);
  }

  private reconcile(lease: CaptureLease, phase: string): void {
    const before = lease.before;
    const after = this.readSnapshot();
    const compatible =
      after &&
      after.owner === before.owner &&
      after.layout === before.layout &&
      after.settingsOpen === before.settingsOpen &&
      after.visualGeneration === before.visualGeneration &&
      sameRect(after.workArea, before.workArea) &&
      sameRect(after.visible, before.visible);
    if (!compatible) {
      this.emit('overlay_capture_guard_cancelled', {
        captureId: lease.id,
        reason: 'incompatible-geometry',
        before: publicSnapshot(before),
        after: publicSnapshot(after),
      });
      this.release(lease.id);
      return;
    }
    if (samePoint(after.logical, before.logical)) return;
    // Never override an independent renderer offset change or a user/OS move
    // that is not the full native frame being constrained to the same work area.
    const frame = before.nativeBounds;
    const content = before.contentBounds ?? frame;
    const currentContent = after.contentBounds ?? after.nativeBounds;
    const unchangedSize =
      after.nativeBounds.width === frame.width &&
      after.nativeBounds.height === frame.height;
    const heightDelta = after.nativeBounds.height - frame.height;
    // The observed capture transition expands the top by exactly 32px while
    // preserving both horizontal edges and the bottom. Do not accept arbitrary
    // resizes, and use actual content movement rather than frame movement.
    const isTopInsetChange =
      Math.abs(heightDelta) === 32 &&
      after.nativeBounds.x === frame.x &&
      after.nativeBounds.width === frame.width &&
      after.nativeBounds.y === frame.y - heightDelta &&
      currentContent.x === content.x &&
      currentContent.width === content.width &&
      (currentContent.y === content.y ||
        currentContent.y === content.y - heightDelta) &&
      (currentContent.height === content.height ||
        currentContent.height === content.height + heightDelta);
    const constrained = clampOverlayPosition(frame, before.workArea, {
      x: 0,
      y: 0,
      width: frame.width,
      height: frame.height,
    });
    const axisMatches = (axis: 'x' | 'y') =>
      after.nativeBounds[axis] === frame[axis] ||
      after.nativeBounds[axis] === constrained[axis];
    const isFrameClamp =
      unchangedSize &&
      samePoint(after.offset, before.offset) &&
      !samePoint(after.nativeBounds, frame) &&
      axisMatches('x') &&
      axisMatches('y') &&
      samePoint(
        clampOverlayPosition(before.logical, before.workArea, before.visible),
        before.logical,
      );
    if (
      !isFrameClamp &&
      !(isTopInsetChange && samePoint(after.offset, before.offset))
    ) {
      this.emit('overlay_capture_guard_cancelled', {
        captureId: lease.id,
        reason: 'unrecognized-native-move',
        before: publicSnapshot(before),
        after: publicSnapshot(after),
      });
      this.release(lease.id);
      return;
    }
    const offset = {
      x: before.logical.x - currentContent.x,
      y: before.logical.y - currentContent.y,
    };
    try {
      this.compensate(before, offset);
    } catch {
      this.release(lease.id);
      this.emit('overlay_capture_guard_cancelled', {
        captureId: lease.id,
        reason: 'compensation-failed',
      });
      return;
    }
    this.rememberReversal(lease, after, offset);
    this.emit('overlay_capture_compensated', {
      captureId: lease.id,
      phase,
      reason: isTopInsetChange
        ? 'native-top-inset-change'
        : 'native-frame-clamp',
      before: publicSnapshot(before),
      after: publicSnapshot(after),
      correctedOffset: offset,
    });
  }
}
