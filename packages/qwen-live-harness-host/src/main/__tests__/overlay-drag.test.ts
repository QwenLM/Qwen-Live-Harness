import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { makeOverlayDraggable } from '../../renderer/overlay-drag.ts';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function fixture() {
  const dom = new JSDOM(
    '<body><main><div class="surface"><span class="wave">Wave</span><button><span>Control</span></button><input><a href="#">Link</a><summary>Details</summary><label>Label</label><div contenteditable="true">Edit</div><div role="button">Action</div></div><div class="outside">Outside</div></main></body>',
  );
  const document = dom.window.document;
  const surface = document.querySelector<HTMLElement>('.surface')!;
  const calls: unknown[][] = [];
  const captures: number[] = [];
  let held: number | undefined;
  surface.setPointerCapture = (id) => {
    held = id;
    captures.push(id);
  };
  surface.hasPointerCapture = (id) => held === id;
  surface.releasePointerCapture = (id) => {
    if (held === id) held = undefined;
  };
  const dispose = makeOverlayDraggable(surface, {
    dragOverlay: (...args) => calls.push(args),
  });
  cleanup.push(() => dom.window.close(), dispose);
  const pointer = (
    target: EventTarget,
    type: string,
    x = 0,
    y = 0,
    id = 1,
    button = 0,
  ) => {
    const event = new dom.window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      screenX: x,
      screenY: y,
      button,
    });
    Object.defineProperties(event, {
      pointerId: { value: id },
      isPrimary: { value: id === 1 },
    });
    target.dispatchEvent(event);
    return event;
  };
  const click = (target: Element) => {
    const event = new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    target.dispatchEvent(event);
    return event;
  };
  return { dom, document, surface, pointer, click, calls, captures, dispose };
}

describe('overlay pointer gesture lifecycle', () => {
  it('captures a bubbled visible target, applies one threshold and releases outside the handle', () => {
    const h = fixture();
    const wave = h.document.querySelector('.wave')!;
    assert.equal(
      h.pointer(wave, 'pointerdown', 100, 120).defaultPrevented,
      true,
    );
    assert.deepEqual(h.captures, [1]);
    h.pointer(h.document.body, 'pointermove', 102, 122);
    assert.deepEqual(h.calls, []);
    h.pointer(h.document.body, 'pointermove', 130, 160);
    h.pointer(h.document.body, 'pointerup', 140, 170);
    assert.deepEqual(h.calls, [
      ['start', 100, 120],
      ['move', 130, 160],
      ['end', 140, 170],
    ]);
    assert.equal(h.surface.hasPointerCapture(1), false);
    assert.equal(h.click(h.document.body).defaultPrevented, true);
    assert.equal(h.click(h.document.body).defaultPrevented, false);
  });

  it('keeps controls, their children, text inputs, links and summaries out of the drag gesture', () => {
    const h = fixture();
    for (const selector of [
      'button',
      'button span',
      'input',
      'a',
      'summary',
      'label',
      '[contenteditable]',
      '[role="button"]',
    ]) {
      const control = h.document.querySelector(selector)!;
      assert.equal(
        h.pointer(control, 'pointerdown', 20, 30).defaultPrevented,
        false,
      );
      h.pointer(control, 'pointermove', 60, 80);
      h.pointer(control, 'pointerup', 60, 80);
      assert.equal(h.click(control).defaultPrevented, false);
    }
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.captures, []);
  });

  it('ignores a second pointer, right click and unrelated pointer release', () => {
    const h = fixture();
    h.pointer(h.surface, 'pointerdown', 10, 20, 2);
    h.pointer(h.surface, 'pointerdown', 10, 20, 1, 2);
    assert.deepEqual(h.captures, []);
    h.pointer(h.surface, 'pointerdown', 100, 100);
    h.pointer(h.surface, 'pointerdown', 200, 200, 2);
    h.pointer(h.surface, 'pointerup', 200, 200, 2);
    h.pointer(h.surface, 'pointermove', 120, 130);
    h.pointer(h.surface, 'pointerup', 120, 130);
    assert.deepEqual(h.calls, [
      ['start', 100, 100],
      ['move', 120, 130],
      ['end', 120, 130],
    ]);
  });

  it('finishes exactly once on capture loss or cancel, then permits the next real control click', () => {
    for (const reason of ['lostpointercapture', 'pointercancel']) {
      const h = fixture();
      h.pointer(h.surface, 'pointerdown', 100, 100);
      h.pointer(h.surface, 'pointermove', 125, 140);
      h.pointer(h.surface, reason);
      h.pointer(h.document.body, 'pointerup');
      assert.deepEqual(h.calls, [
        ['start', 100, 100],
        ['move', 125, 140],
        ['end', 125, 140],
      ]);
      assert.equal(
        h.click(h.document.querySelector('button')!).defaultPrevented,
        false,
      );
    }
  });

  it('ends on native blur and ignores stale movement until a new pointer gesture', () => {
    const h = fixture();
    h.pointer(h.surface, 'pointerdown', 100, 100);
    h.pointer(h.surface, 'pointermove', 125, 140);
    h.dom.window.dispatchEvent(new h.dom.window.Event('blur'));
    h.pointer(h.document.body, 'pointermove', 400, 400);
    h.pointer(h.document.body, 'pointerup', 400, 400);
    assert.deepEqual(h.calls, [
      ['start', 100, 100],
      ['move', 125, 140],
      ['end', 125, 140],
    ]);
    assert.equal(
      h.click(h.document.querySelector('button')!).defaultPrevented,
      false,
    );
  });

  it('recovers from a missed mouse release without following the next unpressed move', () => {
    const h = fixture();
    h.pointer(h.surface, 'pointerdown', 100, 100);
    h.pointer(h.surface, 'pointermove', 125, 140);
    const move = new h.dom.window.MouseEvent('pointermove', {
      bubbles: true,
      buttons: 0,
      screenX: 500,
      screenY: 500,
    });
    Object.defineProperties(move, {
      pointerId: { value: 1 },
      pointerType: { value: 'mouse' },
    });
    h.document.body.dispatchEvent(move);
    assert.deepEqual(h.calls, [
      ['start', 100, 100],
      ['move', 125, 140],
      ['end', 125, 140],
    ]);
    assert.equal(
      h.click(h.document.querySelector('button')!).defaultPrevented,
      false,
    );
  });

  it('uses document movement/release if pointer capture throws and removes listeners on dispose', () => {
    const h = fixture();
    h.surface.setPointerCapture = () => {
      throw new Error('No pointer capture');
    };
    h.pointer(h.surface, 'pointerdown', 100, 100);
    h.pointer(h.document.body, 'pointermove', 125, 140);
    h.dispose();
    h.pointer(h.surface, 'pointerdown', 200, 200);
    h.pointer(h.document.body, 'pointermove', 400, 400);
    h.pointer(h.document.body, 'pointerup', 400, 400);
    assert.deepEqual(h.calls, [
      ['start', 100, 100],
      ['move', 125, 140],
      ['end', 125, 140],
    ]);
    assert.equal(h.surface.hasAttribute('data-live-drag'), false);
    assert.equal(h.click(h.document.body).defaultPrevented, false);
  });

  it('never consumes the next pointer click if the browser did not emit a drag click', async () => {
    const h = fixture();
    const run = () => {
      h.pointer(h.surface, 'pointerdown', 100, 100);
      h.pointer(h.surface, 'pointermove', 125, 140);
      h.pointer(h.surface, 'pointerup', 125, 140);
    };
    run();
    const outside = h.document.querySelector('.outside')!;
    h.pointer(outside, 'pointerdown', 500, 500);
    h.pointer(outside, 'pointerup', 500, 500);
    assert.equal(h.click(outside).defaultPrevented, false);
    run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.click(outside).defaultPrevented, false);
  });
});
