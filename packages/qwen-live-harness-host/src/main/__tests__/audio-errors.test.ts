import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeAudioCaptureFailure } from '../../preload/audio-errors.ts';

describe('audio capture error bridge', () => {
  it('does not report deliberately cancelled capture as a device failure', () => {
    assert.equal(
      describeAudioCaptureFailure(new DOMException('stopped', 'AbortError'), 8),
      undefined,
    );
  });

  it('carries the failed epoch and bounded timeout stage', () => {
    const error = Object.assign(new Error('private device details'), {
      name: 'AudioOperationTimeoutError',
      stage: 'microphone',
    });
    assert.deepEqual(describeAudioCaptureFailure(error, 7), {
      epoch: 7,
      code: 'audio_capture_start_timeout',
      stage: 'microphone',
    });
  });

  it('keeps known browser failure codes without copying messages', () => {
    assert.deepEqual(
      describeAudioCaptureFailure(
        new DOMException('private', 'NotReadableError'),
        2,
      ),
      { epoch: 2, code: 'NotReadableError' },
    );
    assert.deepEqual(describeAudioCaptureFailure(new Error('private')), {
      code: 'audio_input_unavailable',
    });
  });

  it('does not forward untrusted diagnostic fields', () => {
    const error = Object.assign(new Error('private'), {
      name: 'AudioOperationTimeoutError',
      stage: 'private device identifier',
    });
    assert.deepEqual(describeAudioCaptureFailure(error, 3), {
      epoch: 3,
      code: 'audio_capture_start_timeout',
    });
    assert.deepEqual(describeAudioCaptureFailure({ name: 'AbortError' }), {
      code: 'audio_input_unavailable',
    });
  });
});
