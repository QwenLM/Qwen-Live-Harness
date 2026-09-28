import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { VoiceCreationPanel } from '../../renderer/voice-creation.ts';
import type { HostPublicState, LiveHostApi } from '../../shared/host-api.ts';
import { liveMessage } from 'qwen-live-harness/i18n';
import type {
  VoiceCloneOutcome,
  VoiceSampleInfo,
} from 'qwen-live-harness/voice-sample';
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const sample = {
  name: 'sample.wav',
  seconds: 12,
  previewUrl: 'blob:local-preview',
};
function setup(api: Partial<LiveHostApi> = {}) {
  const dom = new JSDOM('<body></body>');
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  cleanup.push(() => {
    dom.window.close();
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const state = {
    connection: 'ready',
    language: 'en',
    live: { state: 'idle' },
    permissions: { microphone: 'granted' },
    voiceSettingsV1: {
      model: 'qwen3.8-omni-flash-realtime',
      voice: 'Tina',
      presets: ['Tina'],
      custom: 'supported',
      availability: 'supported',
      overridden: false,
      cloningV1: true,
    },
  } as HostPublicState;
  const panel = new VoiceCreationPanel(api as LiveHostApi);
  cleanup.push(() => panel.dispose());
  panel.update(state);
  panel.show();
  const button = (text: string) => {
    const b = [...panel.element.querySelectorAll('button')].find(
      (b) => b.textContent === text,
    );
    assert(b, text);
    return b;
  };
  const status = () =>
    panel.element.querySelector('[role="status"]')!.textContent!;
  return { panel, state, button, status };
}
it('keeps samples local until Create and use, prevents duplicate upload and reports success', async () => {
  let creates = 0,
    discarded = 0;
  let finish!: (r: VoiceCloneOutcome) => void;
  const r = setup({
    chooseVoiceSample: async () => sample,
    discardVoiceSample: () => {
      discarded++;
    },
    createVoice: () => {
      creates++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  r.button('Choose audio').click();
  await settle();
  assert.equal(creates, 0);
  assert.equal(r.panel.element.querySelector('audio')!.src, sample.previewUrl);
  r.button('Create and use').click();
  r.button('Create and use').click();
  assert.equal(creates, 1);
  assert(r.button('Choose audio').disabled);
  finish({ ok: true, voice: 'qwen-created' });
  await settle();
  assert.match(r.status(), /created and selected/i);
  assert.equal(discarded, 1);
  assert.equal(
    r.panel.element.querySelector('audio')!.hasAttribute('src'),
    false,
  );
});
it('preserves the created ID for recovery and does not upload again after save failure', async () => {
  let creates = 0;
  const r = setup({
    chooseVoiceSample: async () => sample,
    createVoice: async () => {
      creates++;
      return {
        ok: false,
        error: liveMessage('voice.saveFailed'),
        createdVoice: 'qwen-recover-me',
      };
    },
  });
  r.button('Choose audio').click();
  await settle();
  r.button('Create and use').click();
  await settle();
  assert.equal(
    r.panel.element.querySelector('input')!.value,
    'qwen-recover-me',
  );
  assert.match(r.status(), /was created/);
  assert(r.button('Create and use').disabled);
  r.button('Create and use').click();
  assert.equal(creates, 1);
});
it('cancels pending recording on dismissal and ignores a late sample', async () => {
  let finish!: (r: VoiceSampleInfo) => void;
  let discards = 0;
  const r = setup({
    recordVoiceSample: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    discardVoiceSample: () => {
      discards++;
    },
  });
  r.button('Record').click();
  r.panel.dismiss();
  finish(sample);
  await settle();
  r.panel.show();
  assert.equal(discards, 1);
  assert(r.button('Create and use').disabled);
  assert.equal(
    r.panel.element.querySelector('audio')!.hasAttribute('src'),
    false,
  );
});
it('disables capture during calls and cancels recording when microphone permission is lost', async () => {
  let discards = 0;
  const r = setup({
    recordVoiceSample: () => new Promise(() => {}),
    discardVoiceSample: () => {
      discards++;
    },
  });
  r.button('Record').click();
  r.panel.update({
    ...r.state,
    permissions: { ...r.state.permissions, microphone: 'denied' },
  });
  assert.equal(discards, 1);
  assert(r.button('Record').disabled);
  r.panel.update({ ...r.state, live: { ...r.state.live, state: 'listening' } });
  assert(r.button('Choose audio').disabled);
});

it('clears the previous sample when a replacement fails to decode', async () => {
  let picks = 0;
  const r = setup({
    chooseVoiceSample: async () => {
      if (picks++) throw new Error(liveMessage('voice.sampleInvalid'));
      return sample;
    },
  });
  r.button('Choose audio').click();
  await settle();
  assert.equal(r.button('Create and use').disabled, false);
  r.button('Choose audio').click();
  await settle();
  assert.equal(r.button('Create and use').disabled, true);
  assert.equal(
    r.panel.element.querySelector('audio')!.hasAttribute('src'),
    false,
  );
});
