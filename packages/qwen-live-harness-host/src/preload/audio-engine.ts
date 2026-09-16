import { ipcRenderer } from 'electron';
import { liveMessage } from 'qwen-live-harness/i18n';
import { HostAudioLifecycle } from './audio-lifecycle.ts';
import {
  AudioOperation,
  AudioOperationTimeoutError,
  closeAudioContext,
  stopAudioStream,
} from './audio-operation.ts';
import {
  audioInputConstraints,
  hasAudioInputDevice,
  isUnavailableDevicePreference,
  shouldRecheckAudioInput,
} from './audio-input-policy.ts';
import {
  OutputPlaybackTracker,
  scheduleOutputFrame,
} from './audio-output-queue.ts';
import type { OutputFrameAdmission } from './audio-output-queue.ts';
import { StreamingOutputResampler } from './audio-output-resampler.ts';
import type { AudioInputDevice } from '../shared/host-api.ts';
import type { PlaybackIdentity } from '../shared/protocol.ts';

const OUTPUT_SAMPLE_RATE = 24_000;
const MICROPHONE_DEVICE_STORAGE_KEY =
  'qwen-live-harness-microphone-input-device-id';

type AudioSelfCheck = {
  audioInput: boolean;
  audioOutput: boolean;
  inputError?: string;
  outputError?: string;
};

type AudioDiagnosticDetails = Readonly<
  Record<string, string | number | boolean | undefined>
>;

function errorCode(error: unknown): string {
  if (error instanceof AudioOperationTimeoutError) return error.code;
  if (error instanceof DOMException && error.name) return error.name;
  return 'audio_unavailable';
}

export class HostAudioEngine {
  private captureContext: AudioContext | undefined;
  private captureStream: MediaStream | undefined;
  private captureOutputStream: MediaStream | undefined;
  private captureSource: MediaStreamAudioSourceNode | undefined;
  private captureNode: AudioWorkletNode | undefined;
  private outputContext: AudioContext | undefined;
  private outputSources = new Set<AudioBufferSourceNode>();
  private outputCursor = 0;
  private outputGeneration = 0;
  private outputQueue: Promise<void> = Promise.resolve();
  private readonly outputPlayback = new OutputPlaybackTracker();
  private readonly outputResamplers = new Map<
    string,
    StreamingOutputResampler
  >();
  private outputEndMarkerMode = false;
  private outputMuted = false;
  private captureRequested = false;
  private inputMuted = false;
  private captureEpoch: number | undefined;
  private captureGeneration = 0;
  private mediaDeviceListenerInstalled = false;
  private microphoneAllowed = false;
  private serviceActive = false;
  private selfCheckGeneration = 0;
  private firstCaptureFrameEpoch: number | undefined;
  private captureOperation: AudioOperation | undefined;
  private readinessOperation: AudioOperation | undefined;
  private outputOperation: AudioOperation | undefined;
  private captureRequestRevision = 0;
  private readonly lifecycle = new HostAudioLifecycle();

  constructor(
    private readonly onInputLevel: (level: number) => void = () => {},
    private readonly onDiagnostic: (
      event: string,
      details: AudioDiagnosticDetails,
    ) => void = () => {},
    private readonly onPlaybackStarted: (
      identity: PlaybackIdentity,
    ) => void = () => {},
    private readonly onPlaybackCompleted: (
      identity: PlaybackIdentity,
    ) => void = () => {},
  ) {}

  private readonly handleDeviceChange = (): void => {
    if (this.captureRequested && this.captureContext && this.captureNode) {
      const epoch = this.captureEpoch;
      void this.lifecycle
        .runIfCurrent(() => this.refreshCaptureInput())
        .catch((error: unknown) => {
          if (errorCode(error) !== 'AbortError') this.reportCaptureError(epoch);
        });
      return;
    }
    if (shouldRecheckAudioInput(this.captureRequested)) {
      void this.recheck('audio_device_changed');
    }
  };

  initialize(microphoneAllowed: boolean): Promise<void> {
    this.cancelPendingInput();
    return this.lifecycle.activate(async () => {
      this.serviceActive = true;
      this.microphoneAllowed = microphoneAllowed;
      this.installMediaDeviceListener();
      await this.recheckCurrent('audio_initialize');
    });
  }

  async listInputDevices(): Promise<AudioInputDevice[]> {
    const selectedDeviceId = this.selectedInputDeviceId();
    const operation = new AudioOperation('audio_devices');
    let devices: MediaDeviceInfo[];
    try {
      devices = await operation.wait(() =>
        navigator.mediaDevices.enumerateDevices(),
      );
    } finally {
      operation.dispose();
    }
    return devices
      .filter(
        (device) =>
          device.kind === 'audioinput' &&
          device.deviceId.length > 0 &&
          device.deviceId !== 'default',
      )
      .map((device, index) => ({
        deviceId: device.deviceId,
        label:
          device.label ||
          liveMessage('host.device.fallback', { index: index + 1 }),
        selected: device.deviceId === selectedDeviceId,
      }));
  }

  setInputDevice(deviceId?: string): Promise<void> {
    if (deviceId) localStorage.setItem(MICROPHONE_DEVICE_STORAGE_KEY, deviceId);
    else localStorage.removeItem(MICROPHONE_DEVICE_STORAGE_KEY);
    return this.lifecycle.runIfCurrent(() => this.refreshCaptureInput());
  }

  recheck(reason: string): Promise<void> {
    this.cancelPendingInput();
    return this.lifecycle.runIfCurrent(() => this.recheckCurrent(reason));
  }

  private cancelPendingInput(): void {
    this.captureRequestRevision += 1;
    this.selfCheckGeneration += 1;
    this.captureOperation?.cancel();
    this.readinessOperation?.cancel();
  }

  private async recheckCurrent(reason: string): Promise<void> {
    if (!this.serviceActive) return;
    const generation = ++this.selfCheckGeneration;
    this.captureRequested = false;
    this.captureEpoch = undefined;
    ipcRenderer.send('live:audio:self-check', {
      audioInput: false,
      audioOutput: false,
      inputError: reason,
      outputError: reason,
    } satisfies AudioSelfCheck);
    if (!this.serviceActive || generation !== this.selfCheckGeneration) return;
    await this.resetAudioContexts();
    if (!this.serviceActive || generation !== this.selfCheckGeneration) return;
    await this.runSelfCheck(generation);
  }

  private async runSelfCheck(generation: number): Promise<void> {
    const operation = new AudioOperation('audio_readiness');
    this.readinessOperation = operation;
    const result: AudioSelfCheck = {
      audioInput: false,
      audioOutput: false,
    };
    try {
      try {
        await this.checkOutput();
        result.audioOutput = true;
      } catch (error) {
        result.outputError = errorCode(error);
      }

      if (this.microphoneAllowed) {
        try {
          await operation.wait(() => this.checkInput());
          result.audioInput = true;
        } catch (error) {
          result.inputError = errorCode(error);
        }
      }
      if (this.serviceActive && generation === this.selfCheckGeneration) {
        ipcRenderer.send('live:audio:self-check', result);
      }
    } finally {
      operation.dispose();
      if (this.readinessOperation === operation)
        this.readinessOperation = undefined;
    }
  }

  setCapture(enabled: boolean, muted: boolean, epoch?: number): Promise<void> {
    const revision = ++this.captureRequestRevision;
    if (!enabled || muted || epoch !== this.captureEpoch)
      this.captureOperation?.cancel();
    let completed = false;
    return this.lifecycle
      .runIfCurrent(async () => {
        if (revision !== this.captureRequestRevision)
          throw new DOMException('audio_capture_start_cancelled', 'AbortError');
        await this.setCaptureCurrent(enabled, muted, epoch);
        completed = true;
      })
      .then(() => {
        // A lifecycle replacement can skip the callback entirely. That is
        // cancellation, not a successful capture-ready acknowledgement.
        if (!completed || revision !== this.captureRequestRevision)
          throw new DOMException('audio_capture_start_cancelled', 'AbortError');
      });
  }

  private async setCaptureCurrent(
    enabled: boolean,
    muted: boolean,
    epoch?: number,
  ): Promise<void> {
    if (enabled && !this.serviceActive)
      throw new Error('audio_service_inactive');
    if (
      enabled &&
      (epoch === undefined || !Number.isSafeInteger(epoch) || epoch < 0)
    ) {
      throw new Error('audio_epoch_unavailable');
    }
    const epochChanged = this.captureEpoch !== epoch;
    this.captureRequested = enabled;
    this.inputMuted = muted;
    this.captureEpoch = epoch;
    if (epochChanged) this.firstCaptureFrameEpoch = undefined;
    if (!enabled || muted) {
      this.onInputLevel(0);
      await this.stopCapture();
      if (enabled) {
        this.onDiagnostic('capture_ready', {
          epoch,
          muted,
          capturing: false,
        });
      }
      return;
    }
    if (epochChanged && this.captureContext) await this.stopCapture();
    if (!(await this.startCapture())) return;
    this.onDiagnostic('capture_ready', {
      epoch,
      muted,
      capturing: this.captureStream !== undefined,
      contextState: this.captureContext?.state,
      contextSampleRate: this.captureContext?.sampleRate,
      inputSampleRate: this.captureStream?.getAudioTracks()[0]?.getSettings()
        .sampleRate,
    });
  }

  setOutputMuted(muted: boolean): void {
    this.outputMuted = muted;
    if (muted) this.clearOutput();
  }

  setOutputEndMarkerMode(enabled: boolean): void {
    const next = enabled === true;
    if (next === this.outputEndMarkerMode) return;
    this.outputEndMarkerMode = next;
    this.outputPlayback.setEndMarkerRequired(next);
    this.clearOutput();
    this.onDiagnostic('output_end_marker_mode_changed', { enabled: next });
  }

  play(frame: Uint8Array, identity: PlaybackIdentity): Promise<void> {
    if (
      !this.serviceActive ||
      this.outputMuted ||
      frame.byteLength === 0 ||
      frame.byteLength % 2 !== 0 ||
      !Number.isSafeInteger(identity.epoch) ||
      identity.epoch < 0 ||
      !Number.isSafeInteger(identity.outputId) ||
      identity.outputId < 0
    ) {
      this.onDiagnostic('output_frame_skipped', {
        bytes: frame.byteLength,
        serviceActive: this.serviceActive,
        outputMuted: this.outputMuted,
        epoch: identity.epoch,
        outputId: identity.outputId,
      });
      return Promise.resolve();
    }
    const playbackIdentity = { ...identity };
    const generation = this.outputGeneration;
    return this.enqueueOutput(() =>
      this.playCurrent(frame, playbackIdentity, generation),
    );
  }

  finishOutputAudio(identity: PlaybackIdentity): Promise<void> {
    const playbackIdentity = { ...identity };
    const generation = this.outputGeneration;
    return this.enqueueOutput(() => {
      if (
        !this.outputEndMarkerMode ||
        generation !== this.outputGeneration ||
        !Number.isSafeInteger(playbackIdentity.epoch) ||
        playbackIdentity.epoch < 0 ||
        !Number.isSafeInteger(playbackIdentity.outputId) ||
        playbackIdentity.outputId < 0
      ) {
        this.onDiagnostic('output_finish_skipped', {
          epoch: playbackIdentity.epoch,
          outputId: playbackIdentity.outputId,
          generation,
          currentGeneration: this.outputGeneration,
          markerMode: this.outputEndMarkerMode,
        });
        return;
      }
      const key = this.outputKey(playbackIdentity);
      const resampler = this.outputResamplers.get(key);
      try {
        if (resampler && this.outputContext) {
          this.outputResamplers.delete(key);
          const tail = resampler.finish();
          if (tail.length > 0) {
            const admission = this.outputPlayback.beginFrame(playbackIdentity);
            if (admission) {
              this.scheduleOutput(
                this.outputContext,
                tail,
                this.outputContext.sampleRate,
                admission,
                generation,
                { bytes: 0, tail: true },
              );
            }
          }
        }
      } catch (error) {
        this.clearOutput();
        throw error;
      }
      const transition = this.outputPlayback.finish(playbackIdentity);
      if (!transition.accepted) {
        this.onDiagnostic('output_finish_stale', {
          epoch: playbackIdentity.epoch,
          outputId: playbackIdentity.outputId,
          generation,
        });
        return;
      }
      this.onDiagnostic('output_finish_received', {
        epoch: playbackIdentity.epoch,
        outputId: playbackIdentity.outputId,
        generation,
        activeSources: this.outputSources.size,
      });
      if (transition.completed) {
        this.onPlaybackCompleted(transition.completed);
      }
    });
  }

  private enqueueOutput(operation: () => Promise<void> | void): Promise<void> {
    const result = this.outputQueue.catch(() => undefined).then(operation);
    this.outputQueue = result.catch(() => undefined);
    return result;
  }

  private async playCurrent(
    frame: Uint8Array,
    playbackIdentity: PlaybackIdentity,
    generation: number,
  ): Promise<void> {
    if (
      generation !== this.outputGeneration ||
      !this.serviceActive ||
      this.outputMuted
    ) {
      this.onDiagnostic('output_frame_stale', {
        bytes: frame.byteLength,
        generation,
        currentGeneration: this.outputGeneration,
        outputMuted: this.outputMuted,
      });
      return;
    }
    try {
      const context = await this.ensureOutputContext();
      if (
        generation !== this.outputGeneration ||
        !this.serviceActive ||
        this.outputMuted
      ) {
        this.onDiagnostic('output_frame_stale', {
          bytes: frame.byteLength,
          generation,
          currentGeneration: this.outputGeneration,
          outputMuted: this.outputMuted,
        });
        return;
      }

      const admission = this.outputPlayback.beginFrame(playbackIdentity);
      if (!admission) {
        this.onDiagnostic('output_frame_identity_skipped', {
          epoch: playbackIdentity.epoch,
          outputId: playbackIdentity.outputId,
          generation,
        });
        return;
      }
      const samples = frame.byteLength / 2;
      const channel = new Float32Array(samples);
      const view = new DataView(
        frame.buffer,
        frame.byteOffset,
        frame.byteLength,
      );
      let peak = 0;
      let sumSquares = 0;
      let zeroCrossings = 0;
      let previous = 0;
      for (let index = 0; index < samples; index += 1) {
        const sample = view.getInt16(index * 2, true) / 0x8000;
        channel[index] = sample;
        peak = Math.max(peak, Math.abs(sample));
        sumSquares += sample * sample;
        if (
          index > 0 &&
          ((previous < 0 && sample >= 0) || (previous >= 0 && sample < 0))
        ) {
          zeroCrossings += 1;
        }
        previous = sample;
      }
      let outputSamples: Float32Array = channel;
      let sampleRate = OUTPUT_SAMPLE_RATE;
      // Legacy peers cannot mark the end, so retain their per-frame drain path.
      if (this.outputEndMarkerMode) {
        const key = this.outputKey(playbackIdentity);
        let resampler = this.outputResamplers.get(key);
        if (!resampler) {
          resampler = new StreamingOutputResampler(
            OUTPUT_SAMPLE_RATE,
            context.sampleRate,
          );
          this.outputResamplers.set(key, resampler);
        }
        outputSamples = resampler.push(channel);
        sampleRate = context.sampleRate;
      }
      this.scheduleOutput(
        context,
        outputSamples,
        sampleRate,
        admission,
        generation,
        {
          bytes: frame.byteLength,
          rms: Math.sqrt(sumSquares / samples),
          peak,
          zeroCrossings,
        },
      );
    } catch (error) {
      if (generation !== this.outputGeneration) {
        this.onDiagnostic('output_frame_stale', {
          bytes: frame.byteLength,
          generation,
          currentGeneration: this.outputGeneration,
          outputMuted: this.outputMuted,
        });
        return;
      }
      this.clearOutput();
      throw error;
    }
  }

  private outputKey(identity: PlaybackIdentity): string {
    return `${identity.epoch}:${identity.outputId}`;
  }

  private scheduleOutput(
    context: AudioContext,
    samples: Float32Array,
    sampleRate: number,
    admission: OutputFrameAdmission,
    generation: number,
    details: AudioDiagnosticDetails,
  ): void {
    const capturedOutput = admission.output;
    const playbackIdentity = capturedOutput.identity;
    if (samples.length === 0) {
      this.outputPlayback.endFrame(capturedOutput);
      if (admission.playbackStarted) {
        this.onPlaybackStarted(playbackIdentity);
      }
      return;
    }
    const audioBuffer = context.createBuffer(1, samples.length, sampleRate);
    audioBuffer.getChannelData(0).set(samples);
    const schedule = scheduleOutputFrame(
      context.currentTime,
      this.outputCursor,
      audioBuffer.duration,
      this.outputEndMarkerMode ? context.sampleRate : undefined,
    );
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    source.onended = () => {
      this.outputSources.delete(source);
      source.disconnect();
      const transition = this.outputPlayback.endFrame(capturedOutput);
      this.onDiagnostic('output_source_ended', {
        generation,
        currentGeneration: this.outputGeneration,
        remainingSources: this.outputSources.size,
      });
      if (transition.completed) {
        this.onPlaybackCompleted(transition.completed);
      }
    };
    this.outputSources.add(source);
    source.start(schedule.startAt);
    this.outputCursor = schedule.endAt;
    if (admission.playbackStarted) {
      this.onPlaybackStarted(playbackIdentity);
    }
    this.onDiagnostic('output_frame_scheduled', {
      ...details,
      epoch: playbackIdentity.epoch,
      outputId: playbackIdentity.outputId,
      generation,
      contextState: context.state,
      contextTime: context.currentTime,
      startAt: schedule.startAt,
      endAt: schedule.endAt,
      queuedSeconds: Math.max(0, schedule.endAt - context.currentTime),
      activeSources: this.outputSources.size,
      contextSampleRate: context.sampleRate,
      inputSampleRate: OUTPUT_SAMPLE_RATE,
      sourceSampleRate: sampleRate,
    });
  }

  clearOutput(): void {
    this.onDiagnostic('output_clear', {
      generation: this.outputGeneration,
      activeSources: this.outputSources.size,
      contextState: this.outputContext?.state,
      contextTime: this.outputContext?.currentTime,
      outputCursor: this.outputCursor,
    });
    this.outputGeneration += 1;
    this.outputOperation?.cancel();
    this.outputPlayback.clear();
    this.outputResamplers.clear();
    for (const source of this.outputSources) {
      try {
        source.stop();
      } catch {
        // A source that ended between iteration and stop is already clear.
      }
    }
    this.outputSources.clear();
    const context = this.outputContext;
    this.outputContext = undefined;
    this.outputCursor = 0;
    void closeAudioContext(context);
  }

  dispose(): Promise<void> {
    this.cancelPendingInput();
    let captureClose = Promise.resolve();
    return this.lifecycle.deactivate(
      () => {
        this.serviceActive = false;
        this.selfCheckGeneration += 1;
        this.clearOutput();
        this.captureRequested = false;
        this.captureEpoch = undefined;
        this.microphoneAllowed = false;
        captureClose = this.stopCapture();
        if (this.mediaDeviceListenerInstalled) {
          navigator.mediaDevices.removeEventListener(
            'devicechange',
            this.handleDeviceChange,
          );
          this.mediaDeviceListenerInstalled = false;
        }
      },
      async () => {
        await captureClose;
        await this.resetAudioContexts();
      },
    );
  }

  private async checkInput(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!hasAudioInputDevice(devices)) {
      throw new Error('audio_input_unavailable');
    }
  }

  private async checkOutput(): Promise<void> {
    if (typeof AudioContext === 'undefined')
      throw new Error('audio_output_unavailable');
  }

  private async ensureOutputContext(): Promise<AudioContext> {
    const created = this.outputContext === undefined;
    const context =
      this.outputContext ??
      new AudioContext({
        // Keep the device clock; changing it can disrupt other apps' audio.
        latencyHint: 'interactive',
      });
    this.outputContext = context;
    if (context.state === 'suspended') {
      const operation = new AudioOperation('audio_output_start');
      this.outputOperation = operation;
      try {
        await operation.wait(
          () => context.resume(),
          () => closeAudioContext(context),
        );
      } finally {
        operation.dispose();
        if (this.outputOperation === operation)
          this.outputOperation = undefined;
      }
    }
    if (context.state !== 'running')
      throw new Error('audio_output_unavailable');
    if (created) {
      this.onDiagnostic('output_context_ready', {
        sourceSampleRate: OUTPUT_SAMPLE_RATE,
        contextSampleRate: context.sampleRate,
        resampling: context.sampleRate !== OUTPUT_SAMPLE_RATE,
        contextState: context.state,
      });
    }
    return context;
  }

  private async startCapture(): Promise<boolean> {
    const epoch = this.captureEpoch;
    if (
      this.captureContext ||
      !this.captureRequested ||
      this.inputMuted ||
      epoch === undefined
    )
      return this.captureContext !== undefined;
    const generation = ++this.captureGeneration;
    const operation = new AudioOperation('audio_capture_start');
    this.captureOperation = operation;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let worklet: AudioWorkletNode | undefined;
    let outputStream: MediaStream | undefined;
    let adopted = false;
    let stage = 'microphone';
    const current = () =>
      !operation.aborted &&
      generation === this.captureGeneration &&
      this.serviceActive &&
      this.captureRequested &&
      !this.inputMuted &&
      this.captureEpoch === epoch;
    try {
      operation.stage = stage;
      this.onDiagnostic('capture_start_stage', { epoch, stage });
      stream = await this.openInputStream(operation);
      operation.throwIfAborted();
      if (!current())
        throw new DOMException('audio_capture_start_cancelled', 'AbortError');
      const startedContext = new AudioContext({ latencyHint: 'interactive' });
      context = startedContext;
      stage = 'worklet';
      operation.stage = stage;
      this.onDiagnostic('capture_start_stage', { epoch, stage });
      await operation.wait(
        () =>
          startedContext.audioWorklet.addModule(
            new URL('./audio-input-worklet.js', window.location.href).href,
          ),
        () => closeAudioContext(startedContext),
      );
      operation.throwIfAborted();
      if (!current())
        throw new DOMException('audio_capture_start_cancelled', 'AbortError');
      source = startedContext.createMediaStreamSource(stream);
      const startedWorklet = new AudioWorkletNode(
        startedContext,
        'qwen-pcm16-input',
        {
          channelCount: 1,
          channelCountMode: 'explicit',
          outputChannelCount: [1],
        },
      );
      worklet = startedWorklet;
      const destination = startedContext.createMediaStreamDestination();
      outputStream = destination.stream;
      destination.channelCount = 1;
      source.connect(startedWorklet);
      startedWorklet.connect(destination);
      startedWorklet.port.onmessage = (
        event: MessageEvent<{ level: number; pcm16: ArrayBuffer }>,
      ) => {
        if (
          !this.serviceActive ||
          !this.captureRequested ||
          this.inputMuted ||
          this.captureContext !== startedContext ||
          this.captureNode !== startedWorklet ||
          this.captureEpoch !== epoch
        ) {
          return;
        }
        const { level, pcm16 } = event.data;
        this.onInputLevel(level);
        if (pcm16.byteLength > 0) {
          ipcRenderer.send('live:audio:input', {
            epoch,
            pcm16: new Uint8Array(pcm16),
          });
          if (this.firstCaptureFrameEpoch !== epoch) {
            this.firstCaptureFrameEpoch = epoch;
            this.onDiagnostic('capture_first_frame', {
              epoch,
              bytes: pcm16.byteLength,
              contextState: startedContext.state,
            });
          }
        }
      };
      stage = 'resume';
      operation.stage = stage;
      this.onDiagnostic('capture_start_stage', { epoch, stage });
      if (startedContext.state === 'suspended')
        await operation.wait(
          () => startedContext.resume(),
          () => closeAudioContext(startedContext),
        );
      operation.throwIfAborted();
      if (!current())
        throw new DOMException('audio_capture_start_cancelled', 'AbortError');
      if (startedContext.state !== 'running')
        throw new Error('audio_input_unavailable');
      this.captureStream = stream;
      this.captureOutputStream = outputStream;
      this.captureSource = source;
      this.captureContext = startedContext;
      this.captureNode = startedWorklet;
      adopted = true;
      this.monitorInputTracks(stream, generation);
      return true;
    } catch (error) {
      this.onDiagnostic('capture_start_failed', {
        epoch,
        stage,
        code: errorCode(error),
      });
      throw error;
    } finally {
      operation.dispose();
      if (this.captureOperation === operation)
        this.captureOperation = undefined;
      if (!adopted) {
        source?.disconnect();
        worklet?.disconnect();
        if (stream) stopAudioStream(stream);
        if (outputStream) stopAudioStream(outputStream);
        await closeAudioContext(context);
      }
    }
  }

  private async stopCapture(): Promise<void> {
    this.captureOperation?.cancel();
    this.captureGeneration += 1;
    this.firstCaptureFrameEpoch = undefined;
    const source = this.captureSource;
    const node = this.captureNode;
    const stream = this.captureStream;
    const outputStream = this.captureOutputStream;
    const context = this.captureContext;
    this.captureSource = undefined;
    this.captureNode = undefined;
    this.captureStream = undefined;
    this.captureOutputStream = undefined;
    this.captureContext = undefined;
    source?.disconnect();
    node?.disconnect();
    for (const track of stream?.getTracks() ?? []) track.stop();
    for (const track of outputStream?.getTracks() ?? []) track.stop();
    await closeAudioContext(context);
  }

  private async refreshCaptureInput(): Promise<void> {
    const context = this.captureContext;
    const worklet = this.captureNode;
    if (!context || !worklet || !this.captureRequested || this.inputMuted)
      return;
    const generation = ++this.captureGeneration;
    const operation = new AudioOperation('audio_input_switch');
    this.captureOperation = operation;
    let stream: MediaStream | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let adopted = false;
    try {
      stream = await this.openInputStream(operation);
      operation.throwIfAborted();
      if (
        generation !== this.captureGeneration ||
        !this.captureRequested ||
        this.inputMuted ||
        context !== this.captureContext ||
        worklet !== this.captureNode
      )
        return;
      source = context.createMediaStreamSource(stream);
      source.connect(worklet);
      this.monitorInputTracks(stream, generation);
      const previousSource = this.captureSource;
      const previousStream = this.captureStream;
      this.captureSource = source;
      this.captureStream = stream;
      adopted = true;
      previousSource?.disconnect();
      if (previousStream) stopAudioStream(previousStream);
    } finally {
      operation.dispose();
      if (this.captureOperation === operation)
        this.captureOperation = undefined;
      if (!adopted) {
        source?.disconnect();
        if (stream) stopAudioStream(stream);
      }
    }
  }

  private monitorInputTracks(stream: MediaStream, generation: number): void {
    for (const track of stream.getAudioTracks()) {
      const handleUnavailable = (): void => {
        if (generation === this.captureGeneration) {
          void this.recheck('audio_input_track_unavailable');
        }
      };
      track.addEventListener('ended', handleUnavailable, { once: true });
    }
  }

  private reportCaptureError(epoch: number | undefined): void {
    ipcRenderer.send('live:audio:capture-error', {
      epoch,
      code: 'audio_input_unavailable',
    });
  }

  private selectedInputDeviceId(): string | undefined {
    const selected = localStorage
      .getItem(MICROPHONE_DEVICE_STORAGE_KEY)
      ?.trim();
    return selected || undefined;
  }

  private async openInputStream(
    operation: AudioOperation,
  ): Promise<MediaStream> {
    const open = (deviceId?: string) =>
      operation.wait(
        () =>
          navigator.mediaDevices.getUserMedia({
            audio: audioInputConstraints(deviceId),
            video: false,
          }),
        stopAudioStream,
      );
    const selectedDeviceId = this.selectedInputDeviceId();
    if (selectedDeviceId) {
      try {
        return await open(selectedDeviceId);
      } catch (error) {
        if (!isUnavailableDevicePreference(error)) throw error;
      }
    }
    try {
      return await open();
    } catch (error) {
      if (
        !(error instanceof DOMException) ||
        error.name !== 'NotSupportedError'
      ) {
        throw error;
      }
      const fallback = (
        await operation.wait(() => navigator.mediaDevices.enumerateDevices())
      ).find(
        (device) =>
          device.kind === 'audioinput' &&
          device.deviceId.length > 0 &&
          device.deviceId !== 'default',
      );
      if (!fallback) throw error;
      return await open(fallback.deviceId);
    }
  }

  private async resetAudioContexts(): Promise<void> {
    this.clearOutput();
    await this.stopCapture();
    const outputContext = this.outputContext;
    this.outputContext = undefined;
    this.outputCursor = 0;
    await closeAudioContext(outputContext);
  }

  private installMediaDeviceListener(): void {
    if (this.mediaDeviceListenerInstalled) return;
    navigator.mediaDevices.addEventListener(
      'devicechange',
      this.handleDeviceChange,
    );
    this.mediaDeviceListenerInstalled = true;
  }
}
