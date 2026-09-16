export type AudioCaptureFailure = {
  epoch?: number;
  code: string;
  stage?: string;
};

const CAPTURE_ERROR_NAMES = new Set([
  'NotAllowedError',
  'NotFoundError',
  'NotReadableError',
  'OverconstrainedError',
  'SecurityError',
]);
const CAPTURE_STAGES = new Set(['microphone', 'worklet', 'resume']);

export function isAudioOperationCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Only forward controlled diagnostics, never native error messages or devices. */
export function describeAudioCaptureFailure(
  error: unknown,
  epoch?: number,
): AudioCaptureFailure | undefined {
  const value = error instanceof Error ? error : undefined;
  // A stop, mute, or newer capture request is not an input-device failure.
  if (isAudioOperationCancelled(error)) return undefined;
  const timedOut = value?.name === 'AudioOperationTimeoutError';
  const stage =
    timedOut && 'stage' in value && typeof value.stage === 'string'
      ? value.stage
      : undefined;
  return {
    ...(epoch !== undefined ? { epoch } : {}),
    code: timedOut
      ? 'audio_capture_start_timeout'
      : value && CAPTURE_ERROR_NAMES.has(value.name)
        ? value.name
        : 'audio_input_unavailable',
    ...(stage && CAPTURE_STAGES.has(stage) ? { stage } : {}),
  };
}
