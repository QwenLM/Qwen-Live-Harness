import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  OVERLAY_GEOMETRY,
  OVERLAY_SHADOW_PADDING,
} from '../../shared/overlay-geometry.ts';

const css = readFileSync(
  new URL('../../renderer/style.css', import.meta.url),
  'utf8',
);
type Rect = { x: number; y: number; width: number; height: number };
function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}
function painted(rect: Rect): Rect {
  return {
    x: rect.x - OVERLAY_SHADOW_PADDING,
    y: rect.y - OVERLAY_SHADOW_PADDING,
    width: rect.width + OVERLAY_SHADOW_PADDING * 2,
    height: rect.height + OVERLAY_SHADOW_PADDING * 2,
  };
}

describe('Pebble presentation geometry', () => {
  it('matches the selected card, disc, preview and settings dimensions', () => {
    const { card, orb, settings, preview } = OVERLAY_GEOMETRY;
    assert.deepEqual([card.width, card.height], [234, 171]);
    assert.deepEqual([orb.width, orb.height], [51, 51]);
    assert.deepEqual([preview.width, preview.height], [161, 107]);
    assert.deepEqual([settings.width, settings.height], [306, 532]);
  });
  it('keeps controls inside the card and reserves separate space for captions, preview, summary and settings', () => {
    const {
      card,
      toolbar,
      orb,
      status,
      header,
      summary,
      caption,
      previewWithCaption,
      settings,
      settingsBounds,
      bounds,
    } = OVERLAY_GEOMETRY;
    for (const rect of [toolbar, orb, status, header])
      assert(contains(card, rect));
    assert.equal(toolbar.y - card.y, 116);
    assert.equal(orb.x - card.x, 18);
    assert.equal(orb.y - card.y, 47);
    assert.equal(summary.y - card.y - card.height, 13);
    assert.equal(
      caption.y - previewWithCaption.y - previewWithCaption.height,
      10,
    );
    assert.equal(card.y - caption.y - caption.height, 7);
    assert(settings.x > card.x + card.width);
    for (const rect of [card, summary, caption, settings, previewWithCaption])
      assert(contains(settingsBounds, rect));
    for (const rect of [card, summary, caption])
      assert(contains(bounds.orb, rect));
    assert(contains(bounds['orb-preview'], previewWithCaption));
  });
  it('uses compact gaps while keeping caption geometry and native anchors stable', () => {
    const {
      card,
      toolbar,
      summary,
      preview,
      previewWithCaption,
      caption,
      bounds,
    } = OVERLAY_GEOMETRY;
    assert.equal(card.y - preview.y - preview.height, 12);
    assert.equal(card.y + card.height - toolbar.y - toolbar.height, 14);
    assert.equal(summary.y - card.y - card.height, 13);
    assert(contains(bounds['orb-preview'], preview));
    assert(contains(bounds['orb-preview'], previewWithCaption));
    assert(contains(bounds['orb-preview'], caption));
    for (const key of ['orb', 'orb-preview'] as const) {
      assert.equal(bounds[key].x, bounds.orb.x);
      assert.equal(bounds[key].width, bounds.orb.width);
      assert.equal(
        bounds[key].y + bounds[key].height,
        bounds.orb.y + bounds.orb.height,
      );
    }
  });

  it('contains each wide-shadow paint envelope in its clamp region and native canvas', () => {
    const {
      canvas,
      setup,
      card,
      summary,
      caption,
      preview,
      previewWithCaption,
      settings,
      bounds,
      settingsBounds,
    } = OVERLAY_GEOMETRY;
    const native = { x: 0, y: 0, ...canvas };
    assert.equal(OVERLAY_SHADOW_PADDING, 36);
    assert(contains(bounds.setup, painted(setup)));
    for (const region of [card, summary, caption]) {
      assert(contains(bounds.orb, painted(region)));
      assert(contains(bounds['orb-preview'], painted(region)));
    }
    for (const region of [preview, previewWithCaption])
      assert(contains(bounds['orb-preview'], painted(region)));
    for (const region of [
      card,
      summary,
      caption,
      preview,
      previewWithCaption,
      settings,
    ])
      assert(contains(settingsBounds, painted(region)));
    for (const envelope of [...Object.values(bounds), settingsBounds])
      assert(contains(native, envelope));
  });

  it('budgets the actual shared shadow rather than only the panel content box', () => {
    const theme = readFileSync(
      new URL('../../renderer/theme.css', import.meta.url),
      'utf8',
    );
    const shadows = [...theme.matchAll(/--live-shadow:\s*([^;]+);/g)];
    assert.equal(shadows.length, 2);
    for (const shadow of shadows) {
      for (const layer of shadow[1]!.split(',')) {
        if (layer.includes('inset')) continue;
        const [x, y, blur, spread] = layer
          .trim()
          .split(/\s+/)
          .slice(0, 4)
          .map(parseFloat);
        assert([x, y, blur, spread].every(Number.isFinite));
        const extent =
          Math.max(Math.abs(x!), Math.abs(y!)) + blur! * 1.5 + spread!;
        assert(extent <= OVERLAY_SHADOW_PADDING);
      }
    }
  });
  it('uses tokenized materials, persistent controls and bounded scrollable settings', () => {
    assert.match(css, /border-radius: 26px/);
    assert.match(css, /backdrop-filter: blur\(16px\)/);
    assert.doesNotMatch(
      css,
      /controls-visible|visibility: hidden|--input-scale/,
    );
    assert.match(css, /\.settings-body\s*\{[^}]*overflow-y: scroll/);
    assert.match(css, /\.settings-body\s*\{[^}]*scrollbar-gutter: stable/);
    assert.match(css, /\.settings-panel\s*\{[^}]*pointer-events: auto/);
    assert.match(css, /\.settings-layer\s*\{[^}]*pointer-events: none/);
  });
  it('disables animation and bar transforms under reduced motion', () => {
    const reduced = css.slice(
      css.indexOf('@media (prefers-reduced-motion: reduce)'),
    );
    assert.match(reduced, /animation: none !important/);
    assert.match(reduced, /\.voice-wave i\s*\{[^}]*transform: none !important/);
  });
});
