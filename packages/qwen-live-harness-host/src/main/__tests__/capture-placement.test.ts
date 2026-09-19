import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CapturePlacementGuard,
  type CapturePlacementSnapshot,
} from '../capture-placement.ts';

function fixture() {
  const state = {
    owner: {},
    nativeBounds: { x: 1091, y: 312, width: 700, height: 620 },
    offset: { x: 0, y: 0 },
    workArea: { x: 0, y: 25, width: 1440, height: 875 },
    visible: { x: 25, y: 227, width: 304, height: 341 },
    layout: 'orb',
    settingsOpen: false,
    visualGeneration: 1,
    available: true,
    contentBounds: undefined as CapturePlacementSnapshot['contentBounds'],
  };
  const snapshot = (): CapturePlacementSnapshot | undefined =>
    state.available
      ? {
          ...state,
          nativeBounds: { ...state.nativeBounds },
          offset: { ...state.offset },
          contentBounds: { ...(state.contentBounds ?? state.nativeBounds) },
          workArea: { ...state.workArea },
          visible: { ...state.visible },
          logical: {
            x: (state.contentBounds ?? state.nativeBounds).x + state.offset.x,
            y: (state.contentBounds ?? state.nativeBounds).y + state.offset.y,
          },
        }
      : undefined;
  const corrections: Array<{ x: number; y: number }> = [];
  const logs: Array<{ event: string; details: Record<string, unknown> }> = [];
  const guard = new CapturePlacementGuard(
    snapshot,
    (_before, offset) => {
      state.offset = offset;
      corrections.push(offset);
    },
    (event, details) => logs.push({ event, details }),
  );
  const pending = () => {
    let resolve: () => void = () => {};
    let reject: (error: Error) => void = () => {};
    const result = guard.capture(
      () =>
        new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    return { result, resolve, reject };
  };
  return { state, snapshot, guard, corrections, logs, pending };
}

describe('screen capture placement guard', () => {
  it('undoes its offset after the capture grace period or failure, even after a media-generation change', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    for (const fail of [false, true]) {
      const f = fixture();
      const original = f.snapshot()!;
      const result = f.guard.capture(async () => {
        f.state.nativeBounds.y -= 32;
        f.state.nativeBounds.height += 32;
        f.guard.nativeResized(f.state.owner);
        if (fail) throw new Error('capture failed');
      });
      if (fail) await assert.rejects(result, /capture failed/);
      else await result;
      context.mock.timers.tick(1000);
      f.state.visualGeneration++;
      f.state.nativeBounds = { ...original.nativeBounds };
      f.guard.nativeResized(f.state.owner);
      f.guard.nativeMoved(f.state.owner);
      assert.deepEqual(f.corrections, [
        { x: 0, y: 32 },
        { x: 0, y: 0 },
      ]);
      assert.deepEqual(f.snapshot()!.logical, original.logical);
      assert.equal(
        f.logs.filter(
          (row) => row.details.reason === 'native-geometry-restored',
        ).length,
        1,
      );
    }
  });

  it('keeps a single inverse across overlapping leases and a new capture after the original lease expires', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const original = f.snapshot()!;
    const first = f.pending();
    f.state.nativeBounds.y -= 32;
    f.state.nativeBounds.height += 32;
    f.guard.nativeResized(f.state.owner);
    const overlapping = f.pending();
    first.resolve();
    await first.result;
    context.mock.timers.tick(1000);
    const next = f.pending();
    f.state.nativeBounds = { ...original.nativeBounds };
    f.guard.nativeResized(f.state.owner);
    overlapping.resolve();
    next.resolve();
    await Promise.all([overlapping.result, next.result]);
    f.guard.nativeResized(f.state.owner);
    assert.deepEqual(f.corrections, [
      { x: 0, y: 32 },
      { x: 0, y: 0 },
    ]);
    f.guard.invalidate('test-end');
  });

  it('preserves the earliest inverse through a subsequent known capture expansion', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const original = f.snapshot()!;
    for (let index = 0; index < 2; index++) {
      await f.guard.capture(async () => {
        f.state.nativeBounds.y -= 32;
        f.state.nativeBounds.height += 32;
        f.guard.nativeResized(f.state.owner);
      });
      context.mock.timers.tick(1000);
    }
    f.state.nativeBounds = { ...original.nativeBounds };
    f.guard.nativeResized(f.state.owner);
    assert.deepEqual(f.corrections, [
      { x: 0, y: 32 },
      { x: 0, y: 64 },
      { x: 0, y: 0 },
    ]);
    assert.deepEqual(f.snapshot()!.logical, original.logical);
  });

  it('never overwrites independent offsets, owners, placement invalidations or unrelated OS movement', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    for (const change of [
      'invalidate',
      'offset',
      'owner',
      'layout',
      'area',
      'move',
    ]) {
      const f = fixture();
      const original = f.snapshot()!;
      await f.guard.capture(async () => {
        f.state.nativeBounds.y -= 32;
        f.state.nativeBounds.height += 32;
      });
      context.mock.timers.tick(1000);
      if (change === 'invalidate') f.guard.invalidate('drag-start');
      if (change === 'offset') f.state.offset = { ...f.state.offset, y: 7 };
      if (change === 'owner') f.state.owner = {};
      if (change === 'layout') f.state.layout = 'orb-preview';
      if (change === 'area') f.state.workArea.height -= 10;
      if (change === 'move') {
        f.state.nativeBounds.x += 10;
        f.guard.nativeMoved(original.owner);
      }
      f.state.nativeBounds = { ...original.nativeBounds };
      f.guard.nativeResized(original.owner);
      f.guard.nativeResized(f.state.owner);
      assert.deepEqual(f.corrections, [{ x: 0, y: 32 }], change);
      assert.equal(f.state.offset.y, change === 'offset' ? 7 : 32, change);
      f.guard.invalidate('test-end');
    }
  });

  it('bounds inverse records per owner and globally without cancelling captures', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const owners = Array.from({ length: 40 }, () => fixture());
    let current = owners[0]!;
    let restored = 0;
    const guard = new CapturePlacementGuard(
      () => current.snapshot(),
      (before, offset) => {
        const owner = owners.find(
          (candidate) => candidate.state.owner === before.owner,
        )!;
        owner.state.offset = { ...offset };
        if (offset.y === 0) restored++;
      },
      () => {},
    );
    for (const owner of owners) {
      current = owner;
      assert.equal(
        await guard.capture(async () => {
          owner.state.nativeBounds.y -= 32;
          owner.state.nativeBounds.height += 32;
          return 'captured';
        }),
        'captured',
      );
    }
    context.mock.timers.tick(1000);
    for (const [index, owner] of owners.entries()) {
      current = owner;
      owner.state.nativeBounds.y += 32;
      owner.state.nativeBounds.height -= 32;
      guard.nativeResized(owner.state.owner);
      assert.equal(owner.state.offset.y, index < 8 ? 32 : 0);
    }
    assert.equal(restored, 32);
  });

  it('drops an inverse whose callback fails without changing operation results or repeatedly retrying it', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const original = f.snapshot()!;
    let attempts = 0;
    const guard = new CapturePlacementGuard(
      f.snapshot,
      (_before, offset) => {
        if (++attempts > 1) throw new Error('renderer unavailable');
        f.state.offset = offset;
      },
      () => {
        throw new Error('diagnostic unavailable');
      },
    );
    assert.equal(
      await guard.capture(async () => {
        f.state.nativeBounds.y -= 32;
        f.state.nativeBounds.height += 32;
        return 'captured';
      }),
      'captured',
    );
    context.mock.timers.tick(1000);
    f.state.nativeBounds = { ...original.nativeBounds };
    guard.nativeResized(f.state.owner);
    guard.nativeResized(f.state.owner);
    assert.equal(attempts, 2);
  });

  it('replays the reported 1399/455/700/620 to 1399/423/700/652 transition using actual content coordinates', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    for (const contentStaysPut of [false, true]) {
      const f = fixture();
      f.state.nativeBounds = { x: 1399, y: 455, width: 700, height: 620 };
      f.state.workArea = { x: 0, y: 33, width: 1728, height: 990 };
      const before = f.snapshot()!;
      await f.guard.capture(async () => {
        f.state.nativeBounds = { x: 1399, y: 423, width: 700, height: 652 };
        if (contentStaysPut) f.state.contentBounds = { ...before.nativeBounds };
        f.guard.nativeResized(f.state.owner);
      });
      assert.deepEqual(f.snapshot()!.logical, { x: 1399, y: 455 });
      assert.deepEqual(f.corrections, contentStaysPut ? [] : [{ x: 0, y: 32 }]);
      assert.deepEqual(f.state.nativeBounds, {
        x: 1399,
        y: 423,
        width: 700,
        height: 652,
      });
      f.guard.invalidate('test-end');
    }
  });

  it('detects the observed top expansion without a move event and removes its own offset if the native geometry returns', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const before = f.snapshot()!;
    await f.guard.capture(async () => {
      f.state.nativeBounds.y -= 32;
      f.state.nativeBounds.height += 32;
    });
    assert.deepEqual(f.corrections, [{ x: 0, y: 32 }]);
    f.state.nativeBounds = { ...before.nativeBounds };
    f.guard.nativeResized(f.state.owner);
    assert.deepEqual(f.corrections, [
      { x: 0, y: 32 },
      { x: 0, y: 0 },
    ]);
    assert.deepEqual(f.snapshot()!.logical, before.logical);
    f.guard.invalidate('test-end');
  });

  it('does not classify arbitrary size changes or unrelated content movement as the observed top inset', async () => {
    for (const change of [
      '31px',
      '33px',
      'width',
      'bottom',
      'sideways-content',
    ]) {
      const f = fixture();
      const capture = f.pending();
      const delta = change === '31px' ? 31 : change === '33px' ? 33 : 32;
      f.state.nativeBounds.y -= delta;
      f.state.nativeBounds.height += delta;
      if (change === 'width') f.state.nativeBounds.width += 1;
      if (change === 'bottom') f.state.nativeBounds.y -= 1;
      if (change === 'sideways-content')
        f.state.contentBounds = {
          ...f.state.nativeBounds,
          x: f.state.nativeBounds.x + 1,
        };
      f.guard.nativeResized(f.state.owner);
      capture.resolve();
      await capture.result;
      assert.deepEqual(f.corrections, [], change);
    }
  });

  it('never lets diagnostic or snapshot failures change the original operation result', async () => {
    const f = fixture();
    const original = new Error('original capture failure');
    for (const failSnapshot of [false, true]) {
      const guard = new CapturePlacementGuard(
        () => {
          if (failSnapshot) throw new Error('snapshot failed');
          return f.snapshot();
        },
        () => {},
        () => {
          throw new Error('diagnostic failed');
        },
      );
      assert.equal(await guard.capture(async () => 'captured'), 'captured');
      await assert.rejects(
        guard.capture(async () => {
          throw original;
        }),
        (error) => error === original,
      );
      guard.invalidate('cleanup');
    }
  });

  it('abandons failed compensation without masking capture success or retrying the bad callback', async () => {
    const f = fixture();
    let attempts = 0;
    const guard = new CapturePlacementGuard(
      f.snapshot,
      () => {
        attempts++;
        throw new Error('renderer unavailable');
      },
      () => {},
    );
    assert.equal(
      await guard.capture(async () => {
        f.state.nativeBounds.y = 280;
        guard.nativeMoved(f.state.owner);
        return 'captured';
      }),
      'captured',
    );
    guard.nativeMoved(f.state.owner);
    assert.equal(attempts, 1);
  });

  it('bounds pending protection leases and expires metadata without cancelling any capture', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    let reads = 0;
    const guard = new CapturePlacementGuard(
      () => {
        reads++;
        return f.snapshot();
      },
      () => {},
      () => {},
    );
    const finishes: Array<() => void> = [];
    const captures = Array.from({ length: 40 }, () =>
      guard.capture(
        () => new Promise<number>((resolve) => finishes.push(() => resolve(1))),
      ),
    );
    const before = reads;
    guard.nativeMoved(f.state.owner);
    assert.equal(reads - before, 32);
    context.mock.timers.tick(15_001);
    const expired = reads;
    guard.nativeMoved(f.state.owner);
    assert.equal(reads, expired);
    for (const finish of finishes) finish();
    assert.deepEqual(await Promise.all(captures), Array(40).fill(1));
  });

  it('reproduces a 32px upward native clamp and preserves the visible position using only renderer offset', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const before = f.snapshot()!;
    const capture = f.pending();
    f.state.nativeBounds.y = 280;
    assert.equal(f.snapshot()!.logical.y, before.logical.y - 32);
    f.guard.nativeMoved(f.state.owner);
    assert.deepEqual(f.snapshot()!.logical, before.logical);
    assert.equal(f.state.nativeBounds.y, 280);
    assert.deepEqual(f.corrections, [{ x: 0, y: 32 }]);
    f.guard.nativeMoved(f.state.owner);
    assert.equal(f.corrections.length, 1);
    capture.resolve();
    await capture.result;
    context.mock.timers.tick(501);
    const log = f.logs.find(
      (entry) => entry.event === 'overlay_capture_compensated',
    );
    assert.equal(log?.details.captureId, 1);
    assert.equal(log?.details.reason, 'native-frame-clamp');
    assert.equal('owner' in (log?.details.before as object), false);
  });

  it('handles a full-frame horizontal clamp and a delayed move after completion, then expires', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    await f.guard.capture(async () => {});
    context.mock.timers.tick(400);
    f.state.nativeBounds.x = 740;
    f.guard.nativeMoved(f.state.owner);
    assert.deepEqual(f.corrections, [{ x: 351, y: 0 }]);
    context.mock.timers.tick(101);
    f.state.nativeBounds.y = 280;
    f.guard.nativeMoved(f.state.owner);
    assert.equal(f.corrections.length, 1);
  });

  it('reconciles a native clamp even if the platform move event arrives late', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    await f.guard.capture(async () => {
      f.state.nativeBounds.y = 280;
    });
    assert.deepEqual(f.corrections, [{ x: 0, y: 32 }]);
    f.guard.invalidate('test-end');
  });

  it('prioritizes drag, intentional positioning, settings, display topology and window replacement', async () => {
    for (const reason of [
      'drag-start',
      'settings-opened',
      'layout-changed',
      'display-removed',
      'renderer-reload',
      'window-created',
      'window-closed',
    ]) {
      const f = fixture();
      const capture = f.pending();
      f.guard.invalidate(reason);
      f.state.nativeBounds.y = 280;
      f.guard.nativeMoved(f.state.owner);
      capture.resolve();
      await capture.result;
      assert.deepEqual(f.corrections, [], reason);
    }
  });

  it('rejects stale snapshots even when an invalidation event was missed', async () => {
    for (const change of [
      'owner',
      'layout',
      'settings',
      'generation',
      'area',
      'size',
      'drag',
    ]) {
      const f = fixture();
      const capture = f.pending();
      if (change === 'owner') f.state.owner = {};
      if (change === 'layout') f.state.layout = 'orb-preview';
      if (change === 'settings') f.state.settingsOpen = true;
      if (change === 'generation') f.state.visualGeneration++;
      if (change === 'area') f.state.workArea.height -= 20;
      if (change === 'size') f.state.nativeBounds.width -= 20;
      if (change === 'drag') f.state.available = false;
      f.state.nativeBounds.y = 280;
      f.guard.nativeMoved(f.state.owner);
      capture.resolve();
      await capture.result;
      assert.deepEqual(f.corrections, [], change);
    }
  });

  it('does not override unrelated OS moves or already offscreen user content', async () => {
    for (const change of ['arbitrary', 'offset', 'offscreen']) {
      const f = fixture();
      if (change === 'offscreen') f.state.nativeBounds.y = 400;
      const capture = f.pending();
      if (change === 'arbitrary') f.state.nativeBounds.y -= 10;
      else f.state.nativeBounds.y = 280;
      if (change === 'offset') f.state.offset.x = 12;
      f.guard.nativeMoved(f.state.owner);
      capture.resolve();
      await capture.result;
      assert.deepEqual(f.corrections, [], change);
    }
  });

  it('isolates parallel captures, cleans failed leases, and never reapplies an invalidated old anchor', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const first = f.pending();
    const firstFailure = assert.rejects(first.result, /capture failed/);
    const second = f.pending();
    first.reject(new Error('capture failed'));
    await firstFailure;
    f.state.nativeBounds.y = 280;
    f.guard.nativeMoved(f.state.owner);
    assert.deepEqual(f.corrections, [{ x: 0, y: 32 }]);
    second.resolve();
    await second.result;
    f.guard.invalidate('drag-start');
    f.state.nativeBounds.y = 312;
    f.state.offset.y = 0;
    f.guard.nativeMoved(f.state.owner);
    assert.equal(f.corrections.length, 1);
    assert.deepEqual(
      f.logs
        .filter((log) => log.event === 'overlay_capture_started')
        .map((log) => log.details.captureId),
      [1, 2],
    );
  });

  it('never leaves a post-failure grace window and ignores moves on foreign windows', async () => {
    const f = fixture();
    await assert.rejects(
      f.guard.capture(async () => {
        throw new Error('capture failed');
      }),
    );
    f.state.nativeBounds.y = 280;
    f.guard.nativeMoved(f.state.owner);
    assert.deepEqual(f.corrections, []);
    f.state.nativeBounds.y = 312;
    const capture = f.pending();
    f.state.nativeBounds.y = 280;
    f.guard.nativeMoved({});
    assert.deepEqual(f.corrections, []);
    f.guard.invalidate('window-closed');
    capture.resolve();
    await capture.result;
  });
});
