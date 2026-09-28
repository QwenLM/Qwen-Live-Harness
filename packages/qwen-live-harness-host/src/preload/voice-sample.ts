import { liveMessage } from 'qwen-live-harness/i18n';
import {
  encodeVoiceSample,
  voiceSampleSeconds,
  VOICE_SAMPLE_RATE,
  VOICE_SAMPLE_MAX_SECONDS,
  type VoiceSampleInfo,
} from 'qwen-live-harness/voice-sample';

/** Audio stays in this preload until the user explicitly creates a voice. */
export class VoiceSampleCapture {
  private generation = 0;
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private timer?: ReturnType<typeof setTimeout>;
  private wav?: Uint8Array;
  private preview?: string;

  bytes(): Uint8Array {
    if (!this.wav) throw new Error(liveMessage('voice.sampleInvalid'));
    return this.wav;
  }

  async select(
    pick: () => Promise<{ name: string; data: Uint8Array } | undefined>,
  ): Promise<VoiceSampleInfo | undefined> {
    const generation = ++this.generation;
    const file = await pick();
    if (!file) return undefined;
    if (generation !== this.generation)
      throw new DOMException('Cancelled', 'AbortError');
    return this.prepare(file.data, file.name, generation);
  }

  async record(deviceId?: string): Promise<VoiceSampleInfo> {
    this.clear();
    const generation = this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((t) => t.stop());
      throw new DOMException('Cancelled', 'AbortError');
    }
    this.stream = stream;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const chunks: Blob[] = [];
      const recorder = (this.recorder = new MediaRecorder(stream));
      const recording = new Promise<Blob>((resolve, reject) => {
        let bytes = 0;
        recorder.ondataavailable = (event) => {
          bytes += event.data.size;
          if (bytes > 10 * 1024 * 1024) {
            if (recorder.state !== 'inactive') recorder.stop();
            reject(new Error(liveMessage('voice.sampleTooLarge')));
          } else chunks.push(event.data);
        };
        recorder.onerror = () =>
          reject(new Error(liveMessage('voice.recordFailed')));
        recorder.onstop = () =>
          resolve(new Blob(chunks, { type: recorder.mimeType }));
      });
      recorder.start(250);
      this.timer = timer = setTimeout(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, VOICE_SAMPLE_MAX_SECONDS * 1000);
      const blob = await recording;
      if (generation !== this.generation)
        throw new DOMException('Cancelled', 'AbortError');
      return await this.prepare(
        new Uint8Array(await blob.arrayBuffer()),
        liveMessage('voice.recordedSample'),
        generation,
        true,
      );
    } finally {
      clearTimeout(timer);
      stream.getTracks().forEach((t) => t.stop());
      if (this.stream === stream) {
        this.recorder = undefined;
        this.stream = undefined;
      }
    }
  }

  stopRecording(): void {
    if (!this.recorder) this.generation++;
    else if (this.recorder.state !== 'inactive') this.recorder.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    clearTimeout(this.timer);
  }

  clear(): void {
    this.generation++;
    this.stopRecording();
    this.recorder = undefined;
    this.stream = undefined;
    this.wav = undefined;
    if (this.preview) URL.revokeObjectURL(this.preview);
    this.preview = undefined;
  }

  private async prepare(
    data: Uint8Array,
    name: string,
    generation: number,
    recording = false,
  ): Promise<VoiceSampleInfo> {
    const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
    let decoded: AudioBuffer;
    try {
      decoded = await context.decodeAudioData(new Uint8Array(data).buffer);
    } catch {
      throw new Error(liveMessage('voice.sampleInvalid'));
    } finally {
      await context.close();
    }
    if (
      !Number.isFinite(decoded.duration) ||
      decoded.duration < 3 ||
      (!recording && decoded.duration > VOICE_SAMPLE_MAX_SECONDS)
    )
      throw new Error(liveMessage('voice.sampleInvalid'));
    const offline = new OfflineAudioContext(
      1,
      Math.round(
        Math.min(decoded.duration, VOICE_SAMPLE_MAX_SECONDS) *
          VOICE_SAMPLE_RATE,
      ),
      VOICE_SAMPLE_RATE,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    if (generation !== this.generation)
      throw new DOMException('Cancelled', 'AbortError');
    const wav = encodeVoiceSample(rendered.getChannelData(0));
    const seconds = voiceSampleSeconds(wav);
    if (seconds === undefined)
      throw new Error(liveMessage('voice.sampleInvalid'));
    if (this.preview) URL.revokeObjectURL(this.preview);
    this.wav = wav;
    this.preview = URL.createObjectURL(
      new Blob([new Uint8Array(wav).buffer], { type: 'audio/wav' }),
    );
    return { name, seconds, previewUrl: this.preview };
  }
}
