import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clampOverlayPosition,
  overlayFramePosition,
  overlayPosition,
  visibleOverlayOffset,
} from '../overlay-position.ts';
import { OVERLAY_GEOMETRY } from '../../shared/overlay-geometry.ts';

describe('overlayPosition', () => {
  it('anchors to the bottom right of the selected display work area', () => {
    assert.deepEqual(
      overlayPosition(
        { x: -1_920, y: 23, width: 1_920, height: 1_057 },
        { x: 0, y: 0, width: 420, height: 300 },
      ),
      { x: -440, y: 760 },
    );
  });

  it('does not place a window before a tiny work area origin', () => {
    assert.deepEqual(
      overlayPosition(
        { x: 100, y: 200, width: 200, height: 100 },
        { x: 0, y: 0, width: 420, height: 300 },
      ),
      { x: 100, y: 200 },
    );
  });

  it('preserves a remembered position within a negative-coordinate display', () => {
    assert.deepEqual(
      clampOverlayPosition(
        { x: -900, y: 300 },
        { x: -1920, y: 23, width: 1920, height: 1057 },
        { x: 0, y: 0, width: 384, height: 480 },
      ),
      { x: -900, y: 300 },
    );
  });

  it('clamps a removed display position into the remaining work area', () => {
    assert.deepEqual(
      clampOverlayPosition(
        { x: -900, y: 900 },
        { x: 0, y: 23, width: 1280, height: 777 },
        { x: 0, y: 0, width: 384, height: 480 },
      ),
      { x: 0, y: 320 },
    );
    assert.deepEqual(
      clampOverlayPosition(
        { x: 900, y: 900 },
        { x: 100, y: 200, width: 200, height: 100 },
        { x: 0, y: 0, width: 384, height: 480 },
      ),
      { x: 100, y: 200 },
    );
  });

  it('allows transparent canvas outside the screen while protecting compact content', () => {
    const area = { x: 0, y: 23, width: 1280, height: 777 };
    assert.deepEqual(
      clampOverlayPosition(
        { x: 1200, y: 900 },
        area,
        OVERLAY_GEOMETRY.bounds.orb,
      ),
      { x: 931, y: 216 },
    );
    assert.deepEqual(
      clampOverlayPosition(
        { x: -300, y: -300 },
        area,
        OVERLAY_GEOMETRY.bounds.orb,
      ),
      { x: -5, y: -180 },
    );
    assert.deepEqual(
      clampOverlayPosition(
        { x: -300, y: -300 },
        area,
        OVERLAY_GEOMETRY.bounds['orb-preview'],
      ),
      { x: -5, y: -63 },
    );
  });

  it('keeps complete painted bounds inside normal, negative-coordinate and compact work areas', () => {
    for (const area of [
      { x: 0, y: 23, width: 1280, height: 777 },
      { x: -1920, y: -200, width: 1920, height: 1080 },
      { x: 100, y: 50, width: 700, height: 620 },
    ]) {
      for (const visible of [
        ...Object.values(OVERLAY_GEOMETRY.bounds),
        OVERLAY_GEOMETRY.settingsBounds,
      ]) {
        for (const point of [
          { x: -10000, y: -10000 },
          { x: 10000, y: 10000 },
        ]) {
          const before = { ...point };
          const result = clampOverlayPosition(point, area, visible);
          assert(result.x + visible.x >= area.x);
          assert(result.y + visible.y >= area.y);
          assert(result.x + visible.x + visible.width <= area.x + area.width);
          assert(result.y + visible.y + visible.height <= area.y + area.height);
          assert.deepEqual(point, before);
        }
      }
      assert.deepEqual(
        overlayPosition(area, OVERLAY_GEOMETRY.bounds.orb),
        overlayPosition(area, OVERLAY_GEOMETRY.bounds['orb-preview']),
      );
    }
  });
});

describe('native overlay frame and visible content placement', () => {
  it('keeps the whole canvas on the external display at the logged 2048px seam without moving the visible UI', () => {
    const point = { x: 1699, y: 474 };
    const workArea = { x: 0, y: 30, width: 2048, height: 1028 };
    const before = { x: 1000, y: 300, width: 700, height: 620 };
    const frame = overlayFramePosition(point, workArea, before, before);
    assert.deepEqual(frame, { x: 1348, y: 438 });
    const content = { ...before, ...frame };
    const offset = visibleOverlayOffset(
      point,
      content,
      OVERLAY_GEOMETRY.bounds.orb,
    );
    assert.deepEqual(offset, { x: 351, y: 36 });
    assert.deepEqual(
      { x: content.x + offset.x, y: content.y + offset.y },
      point,
    );
    assert.equal(frame.x + before.width, workArea.x + workArea.width);
    assert.equal(frame.y + before.height, workArea.y + workArea.height);
  });

  it('preserves every layout at all display edges with left, right, above and below display origins', () => {
    const before = { x: 400, y: 200, width: 700, height: 620 };
    for (const workArea of [
      { x: 0, y: 30, width: 2048, height: 1028 },
      { x: -1920, y: 23, width: 1920, height: 1057 },
      { x: 2048, y: -170, width: 1440, height: 900 },
      { x: 200, y: -1170, width: 1680, height: 1050 },
      { x: -300, y: 1058, width: 1920, height: 1080 },
    ]) {
      for (const visible of [
        ...Object.values(OVERLAY_GEOMETRY.bounds),
        OVERLAY_GEOMETRY.settingsBounds,
      ]) {
        for (const x of [-10000, 10000]) {
          for (const y of [-10000, 10000]) {
            const point = clampOverlayPosition({ x, y }, workArea, visible);
            const frame = overlayFramePosition(point, workArea, before, before);
            const content = { ...before, ...frame };
            const offset = visibleOverlayOffset(point, content, visible);
            assert(frame.x >= workArea.x);
            assert(frame.y >= workArea.y);
            assert(frame.x + content.width <= workArea.x + workArea.width);
            assert(frame.y + content.height <= workArea.y + workArea.height);
            assert(offset.x + visible.x >= 0);
            assert(offset.y + visible.y >= 0);
            assert(offset.x + visible.x + visible.width <= content.width);
            assert(offset.y + visible.y + visible.height <= content.height);
            assert.deepEqual(
              { x: content.x + offset.x, y: content.y + offset.y },
              point,
            );
          }
        }
      }
    }
  });

  it('subtracts the actual native content inset before clamping the frame', () => {
    const before = { x: 100, y: 100, width: 700, height: 652 };
    const beforeContent = { x: 100, y: 132, width: 700, height: 620 };
    const workArea = { x: -1920, y: -1080, width: 1920, height: 1050 };
    const point = { x: -1300, y: -700 };
    const frame = overlayFramePosition(point, workArea, before, beforeContent);
    assert.deepEqual(frame, { x: -1300, y: -732 });
    assert.deepEqual(
      visibleOverlayOffset(
        point,
        { ...beforeContent, x: frame.x, y: frame.y + 32 },
        OVERLAY_GEOMETRY.bounds.orb,
      ),
      { x: 0, y: 0 },
    );
    const edgePoint = clampOverlayPosition(
      { x: 10000, y: 10000 },
      workArea,
      OVERLAY_GEOMETRY.bounds.orb,
    );
    const edgeFrame = overlayFramePosition(
      edgePoint,
      workArea,
      before,
      beforeContent,
    );
    assert.deepEqual(edgeFrame, { x: -700, y: -682 });
    const offset = visibleOverlayOffset(
      edgePoint,
      { ...beforeContent, x: edgeFrame.x, y: edgeFrame.y + 32 },
      OVERLAY_GEOMETRY.bounds.orb,
    );
    assert.deepEqual(offset, { x: 351, y: 36 });
  });

  it('keeps the painted UI inside its actual viewport after a native readback is a display-width away', () => {
    const content = { x: 2048, y: -1080, width: 700, height: 620 };
    for (const visible of [
      ...Object.values(OVERLAY_GEOMETRY.bounds),
      OVERLAY_GEOMETRY.settingsBounds,
    ]) {
      for (const point of [
        { x: -3000, y: -5000 },
        { x: 10000, y: 10000 },
      ]) {
        const offset = visibleOverlayOffset(point, content, visible);
        assert(offset.x + visible.x >= 0);
        assert(offset.y + visible.y >= 0);
        assert(offset.x + visible.x + visible.width <= content.width);
        assert(offset.y + visible.y + visible.height <= content.height);
      }
    }
    assert.deepEqual(
      visibleOverlayOffset(
        { x: -3000, y: -5000 },
        content,
        OVERLAY_GEOMETRY.bounds.orb,
      ),
      { x: -5, y: -203 },
    );
    assert.deepEqual(
      visibleOverlayOffset(
        { x: 10000, y: 10000 },
        content,
        OVERLAY_GEOMETRY.bounds.orb,
      ),
      { x: 351, y: 36 },
    );
  });

  it('safely aligns the top left when the work area or viewport cannot fit the full geometry', () => {
    const before = { x: 0, y: 0, width: 700, height: 620 };
    assert.deepEqual(
      overlayFramePosition(
        { x: -5000, y: 5000 },
        { x: -250, y: -100, width: 300, height: 200 },
        before,
        before,
      ),
      { x: -250, y: -100 },
    );
    for (const point of [
      { x: -5000, y: 5000 },
      { x: 5000, y: -5000 },
    ]) {
      assert.deepEqual(
        visibleOverlayOffset(
          point,
          { x: -250, y: -100, width: 100, height: 80 },
          OVERLAY_GEOMETRY.bounds.orb,
        ),
        { x: -5, y: -203 },
      );
    }
  });

  it('does not mutate inputs or apply a display-scale conversion to logical coordinates', () => {
    const point = Object.freeze({ x: 340.5, y: -300.5 });
    const workArea = Object.freeze({
      x: 100,
      y: -600,
      width: 1440,
      height: 1000,
    });
    const frame = Object.freeze({ x: 40, y: 60, width: 700, height: 652 });
    const content = Object.freeze({ x: 42, y: 92, width: 698, height: 620 });
    assert.deepEqual(overlayFramePosition(point, workArea, frame, content), {
      x: 339,
      y: -332,
    });
    assert.deepEqual(
      visibleOverlayOffset(
        { x: 340, y: -300 },
        { x: 338, y: -300, width: 698, height: 620 },
        OVERLAY_GEOMETRY.bounds.orb,
      ),
      { x: 2, y: 0 },
    );
  });
});
