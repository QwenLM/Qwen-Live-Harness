import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const source = readFileSync(
  new URL('../../preload/index.ts', import.meta.url),
  'utf8',
);
const pointerSource = source.slice(
  source.indexOf('let lastPointerInteractive:'),
);
assert.match(pointerSource, /refreshPointerInteractivity/);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function fixture() {
  const dom = new JSDOM(
    '<body><div data-live-drag><span class="wave">Wave</span></div><button data-live-interactive>Button</button><div class="empty"></div></body>',
  );
  const document = dom.window.document;
  const dock = document.querySelector('[data-live-drag]')!;
  let hit: Element | null = document.querySelector('.wave');
  document.elementFromPoint = () => hit;
  const frames: FrameRequestCallback[] = [];
  const messages: boolean[] = [];
  let releases = 0;
  runInNewContext(
    ts.transpileModule(pointerSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      window: dom.window,
      document,
      Element: dom.window.Element,
      MutationObserver: dom.window.MutationObserver,
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        frames.push(callback),
      ipcRenderer: {
        send: (channel: string, value: boolean) => {
          assert.equal(channel, 'live:pointer-interactivity');
          messages.push(value);
        },
      },
      camera: {
        dispose: () => {
          releases++;
        },
      },
      audio: {
        dispose: () => {
          releases++;
        },
      },
    },
  );
  const flush = () => {
    for (const callback of frames.splice(0)) callback(0);
  };
  const pointer = (target: Element, type: string, id = 1) => {
    const event = new dom.window.Event(type, { bubbles: true });
    Object.defineProperty(event, 'pointerId', { value: id });
    target.dispatchEvent(event);
    flush();
  };
  const move = (target: Element | null) => {
    hit = target;
    dom.window.dispatchEvent(
      new dom.window.MouseEvent('mousemove', { clientX: 10, clientY: 10 }),
    );
    flush();
  };
  const signal = (type: string) => {
    dom.window.dispatchEvent(new dom.window.Event(type));
    flush();
  };
  cleanup.push(() => {
    signal('beforeunload');
    dom.window.close();
  });
  return {
    dom,
    document,
    dock,
    pointer,
    move,
    signal,
    messages,
    releases: () => releases,
  };
}

describe('preload pointer interactivity and capture', () => {
  it('keeps a captured drag interactive before the movement threshold and releases it on pointerup', () => {
    const h = fixture();
    h.move(h.document.querySelector('.wave'));
    assert.deepEqual(h.messages, [true]);
    h.pointer(h.dock, 'gotpointercapture');
    h.move(null);
    h.signal('mouseleave');
    assert.deepEqual(h.messages, [true]);
    h.pointer(h.dock, 'pointerup');
    assert.deepEqual(h.messages, [true, false]);
  });

  it('releases capture on cancellation, capture loss, blur and renderer unload', () => {
    for (const type of [
      'pointercancel',
      'lostpointercapture',
      'blur',
      'beforeunload',
    ]) {
      const h = fixture();
      h.pointer(h.dock, 'gotpointercapture');
      h.move(null);
      assert.equal(h.messages.at(-1), true);
      if (type === 'blur' || type === 'beforeunload') h.signal(type);
      else h.pointer(h.dock, type);
      assert.equal(h.messages.at(-1), false, type);
      if (type === 'beforeunload') assert.equal(h.releases(), 2);
    }
  });

  it('ignores captures outside a registered drag handle and does not lose another pointer on a stale release', () => {
    const h = fixture();
    const empty = h.document.querySelector('.empty')!;
    h.move(empty);
    h.pointer(empty, 'gotpointercapture');
    assert.deepEqual(h.messages, [false]);
    h.pointer(h.dock, 'gotpointercapture');
    h.pointer(h.dock, 'pointerup', 2);
    assert.equal(h.messages.at(-1), true);
    h.pointer(h.dock, 'pointerup');
    assert.equal(h.messages.at(-1), false);
    h.move(h.document.querySelector('button'));
    assert.equal(h.messages.at(-1), true);
    h.move(empty);
    assert.equal(h.messages.at(-1), false);
  });

  it('makes only the preview and visible card hit-testable, never the transparent drag canvas', () => {
    const css = readFileSync(
      new URL('../../renderer/style.css', import.meta.url),
      'utf8',
    );
    assert.match(css, /\.voice-card\s*\{[^}]*pointer-events: auto/);
    assert.match(css, /\.camera-preview\s*\{[^}]*pointer-events: auto/);
    assert.match(
      css,
      /\.voice-surface,\s*\.orb-dock,\s*\.settings-layer\s*\{[^}]*pointer-events: none/,
    );
    assert.doesNotMatch(
      css,
      /\[data-live-drag\]\s*\{[^}]*pointer-events:\s*auto/,
    );
  });
});
