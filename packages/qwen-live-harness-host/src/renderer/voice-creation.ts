import type { LiveHostApi, HostPublicState } from '../shared/host-api.ts';
import type { VoiceSampleInfo } from 'qwen-live-harness/voice-sample';
import {
  liveText,
  displayLiveMessage,
  displayLiveError,
  type LiveMessageKey,
} from 'qwen-live-harness/i18n';
import { uiText, localizeUi } from './ui-text.ts';

export class VoiceCreationPanel {
  readonly element = document.createElement('div');
  private state?: HostPublicState;
  private sample?: VoiceSampleInfo;
  private generation = 0;
  private recording = false;
  private preparing = false;
  private creating = false;
  private started = 0;
  private timer?: ReturnType<typeof setInterval>;
  private message: unknown = '';
  private receipt = '';
  private readonly choose = this.button(
    'voice.chooseFile',
    () => void this.prepare(false),
  );
  private readonly record = this.button(
    'voice.record',
    () => void this.prepare(true),
  );
  private readonly stop = this.button('voice.stopRecording', () =>
    this.api.stopVoiceRecording?.(),
  );
  private readonly discard = this.button('voice.discard', () => this.clear());
  private readonly create = this.button(
    'voice.create',
    () => void this.upload(),
  );
  private readonly close = this.button('ui.close', () => this.dismiss());
  private readonly player = document.createElement('audio');
  private readonly status = document.createElement('p');
  private readonly savedId = document.createElement('input');

  constructor(private readonly api: LiveHostApi) {
    this.element.className = 'voice-creation';
    this.element.hidden = true;
    const title = uiText(document.createElement('strong'), 'voice.cloneTitle');
    const guide = uiText(document.createElement('p'), 'voice.cloneGuide');
    const consent = uiText(document.createElement('p'), 'voice.cloneConsent');
    guide.className = consent.className = 'settings-hint';
    const controls = document.createElement('div');
    controls.className = 'settings-options';
    controls.append(this.choose, this.record, this.stop, this.discard);
    this.player.controls = true;
    this.player.preload = 'metadata';
    this.player.hidden = true;
    this.status.className = 'settings-hint';
    this.status.setAttribute('role', 'status');
    this.savedId.readOnly = true;
    this.savedId.hidden = true;
    this.savedId.setAttribute('aria-label', 'Voice ID');
    const actions = document.createElement('div');
    actions.className = 'settings-options';
    actions.append(this.create, this.close);
    this.element.append(
      title,
      guide,
      controls,
      this.player,
      consent,
      actions,
      this.status,
      this.savedId,
    );
  }

  show(): void {
    this.element.hidden = false;
    this.render();
  }
  dismiss(): void {
    this.clear();
    this.element.hidden = true;
  }
  dispose(): void {
    this.dismiss();
    this.generation++;
  }
  update(state: HostPublicState): void {
    this.state = state;
    if (
      this.recording &&
      (!this.available() || state.permissions.microphone !== 'granted')
    )
      this.clear();
    this.render();
  }

  private button(key: LiveMessageKey, action: () => void): HTMLButtonElement {
    const result = uiText(document.createElement('button'), key);
    result.type = 'button';
    result.addEventListener('click', action);
    return result;
  }
  private available(): boolean {
    return Boolean(
      this.state?.connection === 'ready' &&
      !this.state.quitState &&
      this.state.voiceSettingsV1?.cloningV1 &&
      !this.state.voiceSettingsV1.overridden &&
      this.state.voiceSettingsV1.custom !== 'unsupported' &&
      ['idle', 'error', 'unavailable'].includes(this.state.live.state),
    );
  }
  private clear(): void {
    this.generation++;
    this.api.discardVoiceSample?.();
    this.sample = undefined;
    this.preparing = this.recording = false;
    clearInterval(this.timer);
    if (this.player.getAttribute('src')) this.player.pause();
    this.player.removeAttribute('src');
    this.player.hidden = true;
    if (!this.creating) {
      this.message = '';
      this.receipt = '';
    }
    this.render();
  }
  private async prepare(record: boolean): Promise<void> {
    if (
      !this.available() ||
      this.preparing ||
      this.creating ||
      this.state?.voiceSettingsV1?.creating
    )
      return;
    const generation = ++this.generation;
    this.preparing = true;
    this.recording = record;
    this.message = '';
    this.receipt = '';
    if (this.player.getAttribute('src')) this.player.pause();
    if (record) {
      this.sample = undefined;
      this.player.pause();
      this.player.removeAttribute('src');
      this.started = Date.now();
      this.timer = setInterval(() => this.render(), 1000);
    }
    this.render();
    try {
      const sample = record
        ? await this.api.recordVoiceSample?.()
        : await this.api.chooseVoiceSample?.();
      if (generation !== this.generation) return;
      if (sample) {
        this.sample = sample;
        this.player.src = sample.previewUrl;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.api.discardVoiceSample?.();
        this.sample = undefined;
        this.player.removeAttribute('src');
        this.message = error;
      }
    } finally {
      if (generation === this.generation) {
        this.preparing = this.recording = false;
        clearInterval(this.timer);
        this.render();
      }
    }
  }
  private async upload(): Promise<void> {
    if (
      !this.sample ||
      !this.available() ||
      this.creating ||
      this.preparing ||
      !this.api.createVoice
    )
      return;
    this.creating = true;
    this.message = '';
    this.receipt = '';
    this.player.pause();
    this.render();
    try {
      const result = await this.api.createVoice();
      if (result.ok || result.createdVoice) {
        this.api.discardVoiceSample?.();
        this.sample = undefined;
        this.player.removeAttribute('src');
      }
      if (result.ok) this.message = result.warning ?? 'voice-created';
      else {
        this.message = result.error;
        this.receipt = result.createdVoice ?? '';
      }
    } catch (error) {
      this.message = error;
    } finally {
      this.creating = false;
      this.render();
    }
  }
  private render(): void {
    const language = this.state?.language ?? 'en';
    localizeUi(this.element, language);
    const busy =
      this.creating ||
      this.preparing ||
      Boolean(this.state?.voiceSettingsV1?.creating);
    this.choose.disabled = this.record.disabled = !this.available() || busy;
    this.record.disabled ||= this.state?.permissions.microphone !== 'granted';
    this.stop.hidden = !this.recording;
    this.stop.disabled = !this.recording;
    this.discard.disabled = this.creating || (!this.sample && !this.preparing);
    this.create.disabled = !this.available() || busy || !this.sample;
    this.close.disabled = this.creating;
    this.player.hidden = !this.sample;
    this.savedId.hidden = !this.receipt;
    this.savedId.value = this.receipt;
    this.savedId.setAttribute(
      'aria-label',
      liveText(language, 'voice.customId'),
    );
    this.status.textContent = this.creating
      ? liveText(language, 'voice.creating')
      : this.recording
        ? liveText(language, 'voice.recording', {
            seconds: Math.floor((Date.now() - this.started) / 1000),
          })
        : this.receipt
          ? `${liveText(language, 'voice.createdUnsaved')} ${displayLiveError(language, this.message, 'voice.cloneFailed')}`
          : this.message === 'voice-created'
            ? liveText(language, 'voice.created')
            : this.message
              ? displayLiveError(language, this.message, 'voice.cloneFailed')
              : !this.available()
                ? liveText(language, 'voice.cloneIdle')
                : this.sample
                  ? liveText(language, 'voice.sampleReady', {
                      name: displayLiveMessage(language, this.sample.name),
                      seconds: this.sample.seconds.toFixed(1),
                    })
                  : '';
  }
}
