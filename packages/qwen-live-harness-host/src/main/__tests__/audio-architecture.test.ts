import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import ts from 'typescript';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const audioEngine = readFileSync(
  join(appRoot, 'src', 'preload', 'audio-engine.ts'),
  'utf8',
);
const audioOutputQueue = readFileSync(
  join(appRoot, 'src', 'preload', 'audio-output-queue.ts'),
  'utf8',
);
const audioOperation = readFileSync(
  join(appRoot, 'src', 'preload', 'audio-operation.ts'),
  'utf8',
);
const preload = readFileSync(
  join(appRoot, 'src', 'preload', 'index.ts'),
  'utf8',
);
const main = readFileSync(join(appRoot, 'src', 'main', 'index.ts'), 'utf8');
const daemonConnection = readFileSync(
  join(appRoot, 'src', 'main', 'daemon-connection.ts'),
  'utf8',
);

function engineMethod(name: string): string {
  const source = ts.createSourceFile(
    'audio-engine.ts',
    audioEngine,
    ts.ScriptTarget.Latest,
    true,
  );
  const engine = source.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'HostAudioEngine',
  );
  const method = engine?.members.find(
    (node) =>
      ts.isMethodDeclaration(node) && node.name.getText(source) === name,
  );
  assert(method, `HostAudioEngine.${name} must exist`);
  return method.getText(source);
}

describe('Qwen Live Harness Host audio architecture', () => {
  it('matches the Codex virtual microphone graph for capture', () => {
    const capture = engineMethod('startCapture');
    assert.match(
      capture,
      /const (?<destination>\w+) = \w+\.createMediaStreamDestination\(\);[\s\S]*?\w+\.connect\((?<worklet>\w+)\);\s*\k<worklet>\.connect\(\k<destination>\)/u,
    );
    assert.doesNotMatch(capture, /\w+\.connect\(\w+\.destination\)/u);
  });

  it('plays provider PCM on the device clock without a second media clock', () => {
    assert.match(
      audioEngine,
      /context\.createBuffer\(1, samples\.length, sampleRate\)/,
    );
    assert.match(audioEngine, /new StreamingOutputResampler\(/);
    assert.match(audioEngine, /source\.connect\(context\.destination\)/);
    assert.doesNotMatch(audioEngine, /sampleRate: OUTPUT_SAMPLE_RATE/);
    assert.doesNotMatch(audioEngine, /private outputDestination:/);
    assert.doesNotMatch(audioEngine, /private outputStream:/);
    assert.doesNotMatch(audioEngine, /private outputElement:/);
  });

  it('fully releases the device-clock playback context when output is cleared', () => {
    assert.match(
      engineMethod('clearOutput'),
      /const context = this\.outputContext;\s*this\.outputContext = undefined;[\s\S]*closeAudioContext\(context\)/u,
    );
    assert.match(
      audioOperation,
      /async function closeAudioContext\([\s\S]*new AudioOperation\('audio_close', AUDIO_CLOSE_TIMEOUT_MS\)[\s\S]*await operation\.wait\(\(\) => context\.close\(\)\)/u,
    );
  });

  it('preserves output identity from the wire through playback receipts', () => {
    assert.match(
      daemonConnection,
      /const frame = decodeOutputAudioFrame\(rawDataToBuffer\(data\)\)/u,
    );
    assert.match(main, /onOutputAudio: \(\{ audio, epoch, outputId \}\)/u);
    assert.match(
      main,
      /sendRendererCommand\('live:audio:play', \{ audio, epoch, outputId \}\)/u,
    );
    assert.match(
      audioEngine,
      /play\(frame: Uint8Array, identity: PlaybackIdentity\)/u,
    );
    assert.match(audioEngine, /this\.onPlaybackStarted\(playbackIdentity\)/u);
    assert.match(
      audioEngine,
      /this\.onPlaybackCompleted\(transition\.completed\)/u,
    );
    assert.match(
      preload,
      /ipcRenderer\.send\('live:audio:playback-started', identity\)/u,
    );
    assert.match(
      preload,
      /ipcRenderer\.send\('live:audio:playback-completed', identity\)/u,
    );
    assert.doesNotMatch(preload, /currentPlaybackEpoch/u);
    assert.match(
      main,
      /sendRequiredPlaybackReceipt\('playback_started', \(\) =>[\s\S]*daemon\.sendPlaybackStarted\(epoch, outputId\)/u,
    );
    assert.match(
      main,
      /sendRequiredPlaybackReceipt\('playback_completed', \(\) =>[\s\S]*daemon\.sendPlaybackCompleted\(epoch, outputId\)/u,
    );
    assert.match(
      main,
      /if \(!sent\) failRequiredDaemonMessage\(messageType\)/u,
    );
  });

  it('gates output completion on the negotiated end marker and FIFO drain', () => {
    assert.match(
      daemonConnection,
      /capabilities: \{ outputAudioEndMarkerV1: true \}/u,
    );
    assert.match(
      daemonConnection,
      /case 'host\.output_audio_finished':[\s\S]*outputAudioEndMarkerV1 === true[\s\S]*onOutputAudioFinished/u,
    );
    assert.match(
      main,
      /syncOutputAudioEndMarkerMode\(\)[\s\S]*live:audio:set-output-end-marker-mode/u,
    );
    assert.match(
      main,
      /onOutputAudioFinished:[\s\S]*live:audio:output-finished/u,
    );
    assert.match(
      preload,
      /live:audio:set-output-end-marker-mode[\s\S]*setOutputEndMarkerMode/u,
    );
    assert.match(
      preload,
      /live:audio:output-finished[\s\S]*finishOutputAudio/u,
    );
    assert.match(audioEngine, /private outputQueue: Promise<void>/u);
    assert.match(
      audioEngine,
      /this\.outputQueue\.catch\(\(\) => undefined\)\.then\(operation\)/u,
    );
    assert.match(
      audioEngine,
      /finishOutputAudio\([\s\S]*this\.outputPlayback\.finish/u,
    );
    assert.match(
      audioOutputQueue,
      /output\.activeFrames !== 0[\s\S]*this\.endMarkerRequired && !output\.finished/u,
    );
    assert.match(
      engineMethod('clearOutput'),
      /this\.outputGeneration \+= 1;[\s\S]*this\.outputOperation\?\.cancel\(\);[\s\S]*this\.outputPlayback\.clear\(\);[\s\S]*source\.stop\(\)/u,
    );
    assert.match(audioOutputQueue, /private readonly outputs = new Map/u);
  });

  it('monitors both initial and replacement input tracks for device loss', () => {
    assert.match(audioEngine, /private monitorInputTracks\(/);
    assert.equal(audioEngine.match(/this\.monitorInputTracks\(/gu)?.length, 2);
    assert.match(
      audioEngine,
      /private async refreshCaptureInput\(\)[\s\S]*const generation = \+\+this\.captureGeneration/u,
    );
  });
});
