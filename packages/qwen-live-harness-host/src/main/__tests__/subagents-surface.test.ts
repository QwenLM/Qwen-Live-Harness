import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { SUBAGENTS_GEOMETRY } from '../../shared/subagents-geometry.ts';

const theme = readFileSync(
  new URL('../../renderer/theme.css', import.meta.url),
  'utf8',
);
const css = readFileSync(
  new URL('../../renderer/subagents.css', import.meta.url),
  'utf8',
);
const native = readFileSync(
  new URL('../subagents-windows.ts', import.meta.url),
  'utf8',
);

function variables(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = theme.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert(match, selector);
  return Object.fromEntries(
    [...match[1]!.matchAll(/(--live-[\w-]+):\s*([^;]+);/g)].map((entry) => [
      entry[1]!,
      entry[2]!,
    ]),
  );
}

describe('translucent Subagents material and wide bounded shadow', () => {
  it('shares the translucent panel material across seven palettes and both appearances', () => {
    const base = variables(':root');
    for (const mode of ['light', 'dark']) {
      const defaults =
        mode === 'light'
          ? { ...base, ...variables(":root[data-theme='light']") }
          : base;
      for (const color of [
        'iris',
        'clay',
        'sage',
        'tide',
        'graphite',
        'rose',
        'berry',
      ]) {
        const palette =
          color === 'iris'
            ? defaults
            : {
                ...defaults,
                ...variables(
                  `:root[data-theme-color='${color}'][data-theme='${mode}']`,
                ),
              };
        assert.equal(palette['--live-subagents-bg'], 'var(--live-panel-bg)');
        assert.match(palette['--live-panel-bg']!, /^rgba\([\d,\s]+0\.95\)$/);
      }
    }
    assert.match(
      css,
      /\.subagents-panel\s*\{[^}]*background: var\(--live-subagents-bg\)/,
    );
    assert.match(css, /\.subagents-panel\s*\{[^}]*isolation: isolate/);
    assert.match(css, /backdrop-filter: blur\(16px\)/);
    assert.match(base['--live-panel-bg']!, /0\.95\)/);
    assert.equal(base['--live-subagents-shadow'], 'var(--live-shadow)');
    assert.match(
      base['--live-tonal-surface']!,
      /color-mix\([\s\S]+transparent\s*\)/,
    );
    assert.match(
      base['--live-tonal-well']!,
      /color-mix\([\s\S]+transparent\s*\)/,
    );
  });

  it('fits the wider shared shadow inside its enlarged gutter without reducing panel space', () => {
    for (const mode of [':root', ":root[data-theme='light']"]) {
      const tokens = variables(mode);
      const gutter = parseFloat(tokens['--live-subagents-gutter']!);
      assert.equal(gutter, SUBAGENTS_GEOMETRY.shadowGutter);
      assert.equal(gutter, 40);
      assert.match(tokens['--live-shadow']!, /8px 24px -8px/);
      for (const layer of tokens['--live-shadow']!.split(',')) {
        if (layer.includes('inset')) continue;
        const [x, y, blur, spread] = layer
          .trim()
          .split(/\s+/)
          .slice(0, 4)
          .map(parseFloat);
        assert([x, y, blur, spread].every(Number.isFinite));
        // Conservative three-sigma paint bounds for a CSS blur (sigma≈blur/2).
        const extent =
          Math.max(Math.abs(x!), Math.abs(y!)) + blur! * 1.5 + spread!;
        assert(extent < gutter, `Shadow exceeds its gutter: ${layer}`);
      }
    }
    assert.match(css, /box-shadow: var\(--live-subagents-shadow\)/);
    assert.match(css, /padding: var\(--live-subagents-gutter\)/);
    assert.doesNotMatch(css, /box-shadow: var\(--live-shadow\)/);
    assert.match(native, /hasShadow: false/);
    assert.match(native, /SUBAGENTS_GEOMETRY\.expanded/);
    assert.deepEqual(SUBAGENTS_GEOMETRY.summary, { width: 132, height: 62 });
    assert.deepEqual(SUBAGENTS_GEOMETRY.expanded, { width: 360, height: 500 });
    assert.equal(
      SUBAGENTS_GEOMETRY.expanded.width - 2 * SUBAGENTS_GEOMETRY.shadowGutter,
      SUBAGENTS_GEOMETRY.panel.width,
    );
    assert.equal(
      SUBAGENTS_GEOMETRY.expanded.height - 2 * SUBAGENTS_GEOMETRY.shadowGutter,
      SUBAGENTS_GEOMETRY.panel.height,
    );
    assert.deepEqual(SUBAGENTS_GEOMETRY.panel, { width: 280, height: 420 });
  });
});
