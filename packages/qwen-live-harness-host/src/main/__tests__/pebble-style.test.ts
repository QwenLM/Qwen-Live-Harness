import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (file: string) =>
  readFileSync(new URL(`../../renderer/${file}`, import.meta.url), 'utf8');
const style = read('style.css');
const tasks = read('subagents.css');
const theme = read('theme.css');
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`));
  assert(body, `Missing rule: ${selector}`);
  return body[1]!;
}

describe('Pebble typography and control styles', () => {
  it('keeps settings groups on the shared translucent well material', () => {
    assert.match(
      rule(style, '.settings-group'),
      /background: var\(--live-tonal-well\)/,
    );
  });

  it('defines a shared readable type scale without changing appearance palettes', () => {
    for (const token of [
      '--live-type-caption: 11px;',
      '--live-type-body: 12px;',
      '--live-type-label: 13px;',
      '--live-type-heading: 14px;',
    ])
      assert.equal(theme.split(token).length - 1, 2);
    assert.match(
      rule(style, '.voice-header'),
      /font-size: var\(--live-type-caption\)/,
    );
    assert.match(rule(style, '.voice-header'), /line-height: 12px/);
    assert.match(
      rule(style, '.settings-panel'),
      /font-size: var\(--live-type-body\)/,
    );
    assert.match(rule(style, '.voice-status-audio'), /padding-right: 0/);
    assert.match(
      rule(style, '.voice-status.has-preview-control .voice-status-audio'),
      /padding-right: 26px/,
    );
  });

  it('keeps named palette options in two compact rows with non-color selection feedback', () => {
    const grid = rule(style, '.settings-palette > .theme-palette-options');
    assert.match(grid, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
    assert.match(grid, /gap: 6px/);
    assert.match(
      rule(style, '.theme-palette-options > .theme-palette-option'),
      /min-height: 48px/,
    );
    assert.match(rule(style, '.theme-palette-name'), /overflow-wrap: anywhere/);
    assert.doesNotMatch(
      rule(style, '.theme-palette-name'),
      /display: none|visibility: hidden/,
    );
    assert.match(rule(style, '.theme-palette-check'), /opacity: 0/);
    assert.match(
      rule(
        style,
        ".theme-palette-option[aria-pressed='true'] .theme-palette-check",
      ),
      /opacity: 1/,
    );
    assert.match(
      rule(
        style,
        ".theme-palette-options > .theme-palette-option[aria-pressed='true']",
      ),
      /border-color: var\(--live-selection-ring\)/,
    );
    for (const color of [
      'iris',
      'clay',
      'sage',
      'tide',
      'graphite',
      'rose',
      'berry',
    ]) {
      assert(theme.includes(`--live-palette-${color}:`));
      assert(style.includes(`var(--live-palette-${color})`));
    }
  });

  it('keeps microphone labels whole and the rotated Memory chevron inside its box', () => {
    assert.match(
      rule(style, '.settings-row'),
      /grid-template-columns: minmax\(96px, max-content\) minmax\(0, 1fr\)/,
    );
    assert.match(rule(style, '.settings-row > strong'), /white-space: nowrap/);
    assert.match(
      rule(style, '.settings-row > strong'),
      /overflow-wrap: normal/,
    );
    assert.match(rule(style, '.settings-row select'), /min-width: 0/);
    assert.match(
      rule(style, '.settings-row select'),
      /text-overflow: ellipsis/,
    );
    const chevron = rule(style, '.memory-settings > summary > .memory-chevron');
    assert.match(chevron, /width: 11px/);
    assert.match(chevron, /height: 11px/);
  });

  it('reserves scrollbar space, removes only empty messages, and preserves focus and reduced-motion rules', () => {
    assert.match(rule(style, '.settings-body'), /overflow-y: scroll/);
    assert.match(rule(style, '.settings-body'), /scrollbar-gutter: stable/);
    assert.match(style, /\.settings-status:empty,[\s\S]*?display: none;/);
    assert.match(tasks, /\.subagents-error:empty,[\s\S]*?display: none;/);
    assert.match(
      style,
      /button:focus-visible,[\s\S]*?outline: 2px solid var\(--live-focus\)/,
    );
    assert.match(
      style,
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none !important/,
    );
  });

  it('keeps secondary actions usable and separates task titles from metadata and Stop', () => {
    assert.match(rule(style, '.settings-row .settings-refresh'), /width: 24px/);
    assert.match(
      rule(style, '.settings-row .settings-refresh'),
      /min-height: 28px/,
    );
    assert.match(rule(style, '.settings-config > button'), /min-height: 30px/);
    assert.match(
      rule(tasks, '.subagent-row > .subagents-stop'),
      /min-height: 28px/,
    );
    assert.match(rule(tasks, '.subagent-task-title'), /grid-row: 1/);
    assert.match(rule(tasks, '.subagent-task-backend'), /grid-row: 2/);
    assert.match(rule(tasks, '.subagent-task-activity'), /grid-row: 3/);
    assert.match(
      rule(
        tasks,
        '.subagent-row:has(> .subagents-stop:not([hidden])) .subagent-task-activity',
      ),
      /padding-right: 72px/,
    );
  });
});
