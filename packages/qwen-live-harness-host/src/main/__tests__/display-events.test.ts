import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as positions from '../overlay-position.ts';
import * as policy from '../live-state-policy.ts';
import { OVERLAY_GEOMETRY } from '../../shared/overlay-geometry.ts';

function fixture() {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile(
    'index.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set([
    'handleDisplayChange',
    'clampOverlayToDisplays',
    'overlayWorkArea',
    'overlayContentBounds',
    'positionOverlay',
    'applyOverlayPosition',
    'setOverlayLayout',
    'dragOverlay',
    'syncPointerInteractivity',
    'captureOnDemandVisual',
  ]);
  const declarations = tree.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text),
  );
  assert.equal(declarations.length, names.size);
  const registrations = source.match(
    /^ {2}screen\.on\('display-(?:added|removed|metrics-changed)',[\s\S]*?^ {2}\}\);/gm,
  );
  assert.equal(registrations?.length, 3);
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  const bounds = { x: 600, y: 100, width: 700, height: 620 };
  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: area,
    scaleFactor: 2,
    rotation: 0,
  };
  const displays = [display];
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const moves: Array<{ x: number; y: number }> = [];
  const saved: Array<{ x: number; y: number }> = [];
  const dragging: boolean[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const counters = { capture: 0, restart: 0, refresh: 0, publish: 0 };
  let finishCapture: (() => void) | undefined;
  const context = {
    overlayCapturePlacement: {
      invalidate: () => {},
      capture: (operation: () => Promise<unknown>) => operation(),
    },
    ...positions,
    ...policy,
    OVERLAY_GEOMETRY,
    diagnosticsEnabled: false,
    screen: {
      on: (name: string, handler: (...args: unknown[]) => void) =>
        handlers.set(name, handler),
      getAllDisplays: () => displays,
      getDisplayNearestPoint: (point: { x: number; y: number }) => {
        const distance = (candidate: typeof display) => {
          const rectangle = candidate.bounds;
          const dx = Math.max(
            rectangle.x - point.x,
            0,
            point.x - rectangle.x - rectangle.width,
          );
          const dy = Math.max(
            rectangle.y - point.y,
            0,
            point.y - rectangle.y - rectangle.height,
          );
          return dx * dx + dy * dy;
        };
        return displays.reduce((nearest, candidate) =>
          distance(candidate) < distance(nearest) ? candidate : nearest,
        );
      },
    },
    overlay: {
      isDestroyed: () => false,
      getBounds: () => ({ ...bounds }),
      getContentBounds: () => ({ ...bounds }),
      setPosition: (x: number, y: number) => {
        Object.assign(bounds, { x, y });
        moves.push({ x, y });
      },
      setIgnoreMouseEvents: () => {},
    },
    desiredOverlayPosition: { x: bounds.x, y: bounds.y },
    hasCustomOverlayPosition: true,
    overlayReady: true,
    overlayLayout: 'orb',
    overlayPositioning: false,
    overlayOffset: { x: 0, y: 0 },
    overlayDrag: undefined,
    settingsOpen: false,
    pointerInteractive: false,
    pointerOverInteractive: false,
    subagents: {
      displaysChanged: () => {},
      dismissPeek: () => {},
      setDragging: (value: boolean) => dragging.push(value),
    },
    appshotCapture: {
      captureDisplayFrame: () => {
        counters.capture++;
        return new Promise((resolve) => {
          finishCapture = () =>
            resolve({
              screenshot: Uint8Array.of(1),
              displayId: 'fixture-display',
            });
        });
      },
    },
    refreshScreenDisplays: () => counters.refresh++,
    stopScreenFeed: () => counters.restart++,
    syncVisualCapture: () => {},
    publishState: () => counters.publish++,
    persistOverlayPosition: (): void => {
      saved.push({ ...context.desiredOverlayPosition });
    },
    sendRendererCommand: () => {},
    writeLiveDiagnostic: (event: string, details: object) =>
      diagnostics.push({ event, ...details }),
    daemon: { getEpoch: () => 1 },
    appshotReadiness: { refresh: () => {} },
    permissions: { screenRecording: 'granted' },
    selfChecks: { appshot: true },
    visualGeneration: 1,
    visualInput: {
      source: 'screen',
      mode: 'on-demand',
      screenDisplayId: 'primary',
    },
    live: { state: 'listening', callId: 'fixture', available: true },
    isHostReady: () => true,
    encodeScreenFrame: () => ({ image: 'fixture', width: 1280, height: 720 }),
    liveMessage: (key: string) => key,
  };
  const code = ts.transpileModule(
    declarations.map((node) => node.getText(tree)).join('\n') +
      '\n' +
      registrations?.join('\n') +
      '\n({ captureOnDemandVisual, dragOverlay, positionOverlay, applyOverlayPosition, setOverlayLayout });',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const api = runInNewContext(code, context) as {
    captureOnDemandVisual(request: object): Promise<unknown>;
    dragOverlay(phase: 'start' | 'move' | 'end', x: number, y: number): void;
    positionOverlay(position: { x: number; y: number }, reason: string): void;
    applyOverlayPosition(reason: string): void;
    setOverlayLayout(layout: 'setup' | 'orb' | 'orb-preview'): void;
  };
  return {
    api,
    context,
    display,
    displays,
    area,
    bounds,
    counters,
    moves,
    saved,
    dragging,
    diagnostics,
    logical: () => ({
      x: bounds.x + context.overlayOffset.x,
      y: bounds.y + context.overlayOffset.y,
    }),
    finish: () => finishCapture?.(),
    event: (
      name: string,
      changedMetrics?: string[],
      changedDisplay = display,
    ) => handlers.get(name)?.({}, changedDisplay, changedMetrics),
  };
}

function dualDisplayFixture() {
  const f = fixture();
  f.display.id = 2;
  Object.assign(f.display.bounds, {
    x: 0,
    y: 0,
    width: 2048,
    height: 1152,
  });
  Object.assign(f.area, { x: 0, y: 30, width: 2048, height: 1028 });
  const internal = {
    id: 1,
    bounds: { x: 2048, y: 0, width: 1728, height: 1117 },
    workArea: { x: 2048, y: 33, width: 1728, height: 1084 },
    scaleFactor: 2,
    rotation: 0,
  };
  f.displays.push(internal);
  return { ...f, internal };
}

function assertFrameInside(
  frame: positions.DisplayWorkArea,
  area: positions.DisplayWorkArea,
) {
  assert.ok(frame.x >= area.x);
  assert.ok(frame.y >= area.y);
  assert.ok(frame.x + frame.width <= area.x + area.width);
  assert.ok(frame.y + frame.height <= area.y + area.height);
}

describe('native display event isolation', () => {
  it('preserves a pending monitor frame and drag through non-geometric metrics', async () => {
    const f = fixture();
    const frame = f.api.captureOnDemandVisual({
      source: 'screen',
      screenScope: 'display',
      screenDisplayId: 'primary',
      persistAsset: false,
    });
    f.api.dragOverlay('start', 1000, 500);
    f.api.dragOverlay('move', 1010, 510);
    const before = { ...f.bounds };
    f.event('display-metrics-changed', ['colorSpace']);
    f.finish();
    await frame;
    f.api.dragOverlay('move', 1060, 560);
    assert.equal(f.bounds.x, before.x + 50);
    assert.equal(f.bounds.y, before.y + 50);
    assert.equal(f.context.visualGeneration, 1);
    assert.deepEqual(f.counters, {
      capture: 1,
      restart: 0,
      refresh: 0,
      publish: 0,
    });
    assert.deepEqual(f.saved, []);
    assert.deepEqual(f.dragging, [true]);
    assert.equal(
      f.diagnostics.find((log) => log.event === 'native_display_changed')
        ?.geometryChanged,
      false,
    );
  });

  it('ignores empty and unknown metrics without moving a stationary default orb', () => {
    const f = fixture();
    f.context.hasCustomOverlayPosition = false;
    const before = { ...f.bounds };
    f.event('display-metrics-changed', []);
    f.event('display-metrics-changed', ['colorSpace', 'unknown']);
    assert.deepEqual(f.bounds, before);
    assert.deepEqual(f.moves, []);
    assert.deepEqual(f.dragging, []);
    assert.equal(f.context.visualGeneration, 1);
  });

  for (const metric of ['bounds', 'workArea', 'scaleFactor', 'rotation']) {
    it(`invalidates frames and ends a drag for another display's ${metric} change even when the orb needs no clamp`, async () => {
      const f = fixture();
      const frame = f.api.captureOnDemandVisual({
        source: 'screen',
        screenScope: 'display',
        screenDisplayId: 'primary',
        persistAsset: false,
      });
      const rejection = assert.rejects(frame, /stale_visual_capture/);
      f.api.dragOverlay('start', 1000, 500);
      f.api.dragOverlay('move', 1010, 510);
      const before = { ...f.bounds };
      f.event('display-metrics-changed', ['colorSpace', metric], {
        ...f.display,
        id: 2,
        bounds: { ...f.display.bounds, x: 1440 },
        workArea: { ...f.area, x: 1440 },
      });
      f.finish();
      await rejection;
      f.api.dragOverlay('move', 1060, 560);
      f.api.dragOverlay('end', 1090, 590);
      assert.deepEqual(f.bounds, before);
      assert.deepEqual(
        { ...f.context.desiredOverlayPosition },
        {
          x: before.x,
          y: before.y,
        },
      );
      assert.equal(f.context.visualGeneration, 2);
      assert.equal(f.counters.restart, 1);
      assert.deepEqual(f.saved, [{ x: before.x, y: before.y }]);
      assert.deepEqual(f.dragging, [true, false]);
      assert.equal(f.context.overlayDrag, undefined);
    });
  }

  for (const event of ['display-added', 'display-removed']) {
    it(`${event} invalidates capture and preserves an already reachable default position`, () => {
      const f = fixture();
      f.context.hasCustomOverlayPosition = false;
      const before = { ...f.bounds };
      f.event(event);
      assert.equal(f.context.visualGeneration, 2);
      assert.equal(f.counters.refresh, 1);
      assert.equal(f.counters.restart, 1);
      assert.deepEqual(f.bounds, before);
      assert.deepEqual(f.moves, []);
      assert.deepEqual(f.dragging, [false]);
      assert.equal(f.context.overlayDrag, undefined);
      assert.equal(f.context.hasCustomOverlayPosition, false);
      assert.deepEqual(f.saved, []);
    });
  }

  it('clamps onto the remaining display and saves the recovered location after removal', () => {
    const f = fixture();
    f.api.dragOverlay('start', 1000, 500);
    f.api.dragOverlay('move', 1010, 510);
    f.area.width = 800;
    f.event('display-removed', undefined, { ...f.display, id: 2 });
    const corrected = { ...f.bounds };
    const recovered = f.logical();
    f.api.dragOverlay('move', 1060, 560);
    f.api.dragOverlay('end', 1090, 590);
    assert.deepEqual(f.bounds, corrected);
    assert.equal(
      recovered.x +
        OVERLAY_GEOMETRY.bounds.orb.x +
        OVERLAY_GEOMETRY.bounds.orb.width,
      f.area.width,
    );
    assert.deepEqual({ ...f.context.desiredOverlayPosition }, recovered);
    assert.deepEqual(f.saved, [recovered]);
    assert.deepEqual(f.dragging, [true, false]);
    const log = f.diagnostics.at(-1);
    assert.equal(log?.event, 'overlay_position');
    assert.equal(log?.reason, 'display-removed');
    assert.deepEqual(log?.after, corrected);
  });

  it('clamps the compensated logical position without resetting its macOS offset', () => {
    const f = fixture();
    f.bounds.y = 25;
    f.context.overlayOffset.y = -130;
    const before = { ...f.bounds };
    f.event('display-metrics-changed', ['bounds']);
    assert.deepEqual(f.bounds, before);
    assert.equal(f.context.overlayOffset.y, -130);
    assert.deepEqual(f.moves, []);
  });
});

describe('multi-display overlay placement and recovery', () => {
  it('keeps the card at the right edge while returning its transparent native frame to the external screen', () => {
    const f = dualDisplayFixture();
    Object.assign(f.bounds, { x: 1470, y: 472 });
    f.context.desiredOverlayPosition = { x: 1470, y: 472 };
    f.api.dragOverlay('start', 1570, 880);
    f.api.dragOverlay('move', 1799, 882);
    assert.deepEqual(f.logical(), { x: 1699, y: 474 });
    assert.deepEqual(f.bounds, {
      x: 1348,
      y: 438,
      width: 700,
      height: 620,
    });
    assert.deepEqual({ ...f.context.overlayOffset }, { x: 351, y: 36 });
    assertFrameInside(f.bounds, f.area);
    assert.deepEqual(
      {
        x: f.bounds.x + f.context.overlayOffset.x + OVERLAY_GEOMETRY.card.x,
        y: f.bounds.y + f.context.overlayOffset.y + OVERLAY_GEOMETRY.card.y,
      },
      { x: 1759, y: 808 },
    );
    f.api.dragOverlay('end', 1799, 882);
    assert.deepEqual(f.logical(), { x: 1699, y: 474 });
    assert.deepEqual(f.saved, [{ x: 1699, y: 474 }]);
  });

  it('moves the whole native frame onto the right-hand screen when the same drag crosses the display seam', () => {
    const f = dualDisplayFixture();
    Object.assign(f.bounds, { x: 1470, y: 472 });
    f.context.desiredOverlayPosition = { x: 1470, y: 472 };
    f.api.dragOverlay('start', 1570, 880);
    f.api.dragOverlay('move', 1799, 882);
    assertFrameInside(f.bounds, f.area);
    f.api.dragOverlay('move', 2350, 882);
    assert.deepEqual(f.logical(), { x: 2250, y: 474 });
    assertFrameInside(f.bounds, f.internal.workArea);
    assert.ok(f.bounds.x >= 2048);
    f.api.dragOverlay('end', 2350, 882);
    assert.deepEqual(f.saved, [{ x: 2250, y: 474 }]);
  });

  for (const event of ['display-metrics-changed', 'display-removed']) {
    it(`${event} cancels the old gesture and reconciles an OS-moved, already-reachable anchor`, () => {
      const f = dualDisplayFixture();
      Object.assign(f.bounds, { x: 2300, y: 100 });
      f.context.desiredOverlayPosition = { x: 2300, y: 100 };
      f.api.dragOverlay('start', 2400, 500);
      // The OS relocates the window before delivering the topology event.
      Object.assign(f.bounds, { x: 252, y: 100 });
      Object.assign(f.internal.bounds, { x: 0 });
      Object.assign(f.internal.workArea, { x: 0 });
      f.displays.splice(0, 1);
      f.event(
        event,
        event === 'display-metrics-changed'
          ? ['bounds', 'workArea']
          : undefined,
        event === 'display-removed' ? f.display : f.internal,
      );
      const recovered = { x: 252, y: 100 };
      assert.deepEqual(f.logical(), recovered);
      assert.deepEqual({ ...f.context.desiredOverlayPosition }, recovered);
      assert.deepEqual(f.saved, [recovered]);
      assert.equal(f.context.overlayDrag, undefined);
      assert.deepEqual(f.dragging, [true, false]);
      const moveCount = f.moves.length;
      f.api.dragOverlay('move', 2800, 850);
      f.api.dragOverlay('end', 2900, 950);
      assert.equal(f.moves.length, moveCount);
      assert.deepEqual(f.logical(), recovered);
      assert.deepEqual(f.saved, [recovered]);
      f.api.setOverlayLayout('orb-preview');
      f.api.setOverlayLayout('orb');
      assert.deepEqual(f.logical(), recovered);
      assert.deepEqual({ ...f.context.desiredOverlayPosition }, recovered);
      assertFrameInside(f.bounds, f.internal.workArea);
    });
  }
});
