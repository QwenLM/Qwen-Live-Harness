import type { LiveHostApi } from '../shared/host-api.ts';
import { LiveView } from './live-view.ts';

declare global {
  interface Window {
    qwenLiveHarnessHost: LiveHostApi;
  }
}

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing Qwen Live Harness Host root');
const view = new LiveView(app, window.qwenLiveHarnessHost);
let receivedState = false;
const unsubscribe = window.qwenLiveHarnessHost.onState((state) => {
  receivedState = true;
  view.update(state);
});
const unsubscribeLevel = window.qwenLiveHarnessHost.onInputLevel((level) =>
  view.setInputLevel(level),
);
void window.qwenLiveHarnessHost.getState().then((state) => {
  if (!receivedState) view.update(state);
});
window.addEventListener('beforeunload', () => {
  unsubscribe();
  unsubscribeLevel();
  view.dispose();
});
