import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_LOG_BYTES = 1024 * 1024;
const FAILURE_EVENTS = new Set([
  'audio_initialization_failed',
  'audio_self_check_failed',
  'audio_capture_failed',
  'audio_capture_timeout',
  'capture_start_failed',
  'audio_output_failed',
  'output_start_failed',
  'camera_capture_error',
  'visual_capture_error',
  'renderer_unresponsive',
  'renderer_process_gone',
  'renderer_load_failed',
  'preload_failed',
  'host_action_failed',
  'host_quit_failed',
  'host_daemon_stop_cleanup_failed',
  'daemon_bootstrap_failed',
  'daemon_identity_check_failed',
  'daemon_stop_marker_invalid',
  'daemon_launch_profile_mismatch',
]);
const NUMERIC_FIELDS = [
  'epoch',
  'durationMs',
  'exitCode',
  'errorCode',
  'attempt',
];
const LABEL_FIELDS = [
  'code',
  'stage',
  'reason',
  'kind',
  'action',
  'connection',
  'blocker',
  'inputError',
  'outputError',
];
// Values are machine labels, never Error.message, device names, paths, or media.
// An unknown value is omitted; the event itself still identifies the failure.
const SAFE_LABELS = new Set([
  'AbortError',
  'Error',
  'TypeError',
  'SyntaxError',
  'ReferenceError',
  'SecurityError',
  'NotAllowedError',
  'NotFoundError',
  'NotReadableError',
  'OverconstrainedError',
  'InvalidStateError',
  'NotSupportedError',
  'TimeoutError',
  'AudioOperationTimeoutError',
  'StartupError',
  'audio_unavailable',
  'audio_input_unavailable',
  'audio_output_unavailable',
  'audio_capture_start_timeout',
  'audio_output_start_timeout',
  'audio_readiness_timeout',
  'audio_readiness_failed',
  'audio_devices_timeout',
  'audio_input_switch_timeout',
  'audio_initialize_timeout',
  'audio_input_probe_timeout',
  'audio_close_timeout',
  'camera_unavailable',
  'camera_ready_timeout',
  'camera_snapshot_frame_timeout',
  'camera_preview_restore_failed',
  'camera_permission_required',
  'screen_failed',
  'screen_capture_unavailable',
  'jpeg_read_failed',
  'jpeg_encode_failed',
  'main_watchdog',
  'first_frame',
  'readiness',
  'microphone',
  'worklet',
  'resume',
  'output',
  'initialization',
  'input_probe',
  'clean-exit',
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'memory-eviction',
  'toggle',
  'stop',
  'new',
  'playback_started',
  'playback_completed',
  'ready',
  'connecting',
  'disconnected',
  'incompatible',
  'error',
  'microphone_permission',
  'camera_permission',
  'accessibility_permission',
  'screen_recording_permission',
  'audio_input',
  'audio_output',
  'global_shortcut',
  'appshot',
  'host_disconnected',
  'host_missing',
  'host_version',
  'provider_config',
  'provider_unreachable',
  'camera',
  'screen',
]);

export interface HostDiagnosticsLogger {
  write(event: string, details?: Readonly<Record<string, unknown>>): void;
}

function ownedMode(stat: Stats, mode: number): boolean {
  return (
    process.platform === 'win32' ||
    ((stat.mode & 0o777) === mode &&
      (typeof process.getuid !== 'function' || stat.uid === process.getuid()))
  );
}

function optionalStat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function regularPrivateFile(stat: Stats): boolean {
  return stat.isFile() && stat.nlink === 1 && ownedMode(stat, 0o600);
}

function privateDirectory(directory: string): boolean {
  const parent = lstatSync(dirname(directory));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (typeof process.getuid === 'function' && parent.uid !== process.getuid())
  )
    return false;
  if (!optionalStat(directory)) mkdirSync(directory, { mode: 0o700 });
  const stat = lstatSync(directory);
  return stat.isDirectory() && !stat.isSymbolicLink() && ownedMode(stat, 0o700);
}

/** Small, bounded failure logs are retained independently of verbose --debug output. */
export function createHostDiagnosticsLogger(
  logDirectory: string,
): HostDiagnosticsLogger {
  const activePath = join(logDirectory, 'host-errors.log');
  const rotatedPath = `${activePath}.1`;
  return {
    write(event, details = {}) {
      let descriptor: number | undefined;
      try {
        if (!FAILURE_EVENTS.has(event)) return;
        if (
          event === 'capture_start_failed' &&
          details['code'] === 'AbortError'
        )
          return;
        const safeDetails: Record<string, string | number | boolean> = {};
        for (const field of NUMERIC_FIELDS) {
          const value = details[field];
          if (typeof value === 'number' && Number.isSafeInteger(value))
            safeDetails[field] = value;
        }
        for (const field of LABEL_FIELDS) {
          const value = details[field];
          if (typeof value === 'string' && SAFE_LABELS.has(value))
            safeDetails[field] = value;
        }
        for (const field of ['audioInput', 'audioOutput']) {
          const value = details[field];
          if (typeof value === 'boolean') safeDetails[field] = value;
        }
        const entry = Buffer.from(
          `${JSON.stringify({
            timestamp: new Date().toISOString(),
            source: 'qwen-live-harness-host',
            event,
            ...safeDetails,
          })}\n`,
        );
        if (!privateDirectory(logDirectory)) return;
        const previous = optionalStat(activePath);
        if (
          previous &&
          (!regularPrivateFile(previous) || previous.size > MAX_LOG_BYTES)
        )
          return;
        if (previous && previous.size + entry.length > MAX_LOG_BYTES) {
          const rotated = optionalStat(rotatedPath);
          if (rotated) {
            if (!regularPrivateFile(rotated)) return;
            unlinkSync(rotatedPath);
          }
          renameSync(activePath, rotatedPath);
        }
        descriptor = openSync(
          activePath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_APPEND |
            (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
          0o600,
        );
        const opened = fstatSync(descriptor);
        if (
          !regularPrivateFile(opened) ||
          opened.size + entry.length > MAX_LOG_BYTES
        )
          return;
        writeSync(descriptor, entry);
      } catch {
        // Diagnostics must remain best-effort even for disk errors or bad IPC data.
      } finally {
        if (descriptor !== undefined) {
          try {
            closeSync(descriptor);
          } catch {
            // A logging failure must never interrupt audio or application shutdown.
          }
        }
      }
    },
  };
}
