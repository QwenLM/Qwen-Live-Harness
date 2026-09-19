import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampOverlayPosition, overlayPosition } from '../overlay-position.ts';
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
