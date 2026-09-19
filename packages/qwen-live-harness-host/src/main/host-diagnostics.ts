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
import { windowDiagnosticDetails } from './window-diagnostics.ts';

const MAX_LOG_BYTES = 1024 * 1024;
const FAILURE_EVENTS = new Set([
  'audio_initialization_failed',
  'audio_self_check_failed',
  'audio_capture_failed',
  'audio_capture_timeout',
  'capture_start_failed',
  'audio_output_failed',
  'audio_output_finish_failed',
  'output_start_failed',
  'camera_capture_error',
  'camera_permission_error',
  'permission_request_failed',
  'permission_denied',
  'permission_revoked',
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
  'daemon_connection',
]);
const NUMERIC_FIELDS = [
  'epoch',
  'outputId',
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
  'errorName',
  'phase',
  'permission',
];
// Values are machine labels, never Error.message, device names, paths, or media.
// An unknown value is omitted; the event itself still identifies the failure.
const SAFE_LABELS = new Set([
  'AbortError',
  'Error',
  'TypeError',
  'RangeError',
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
  'audio_output_finish_failed',
  'audio_transport_rejected',
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
  'camera_track_ended',
  'camera_ready_timeout',
  'camera_snapshot_frame_timeout',
  'camera_preview_restore_failed',
  'camera_permission_required',
  'camera_permission_request_failed',
  'microphone_permission_request_failed',
  'camera_permission_denied',
  'microphone_permission_denied',
  'camera_permission_revoked',
  'microphone_permission_revoked',
  'accessibility_permission_revoked',
  'screen_recording_permission_revoked',
  'screen_failed',
  'screen_frame_too_large',
  'screen_capture_unavailable',
  'jpeg_read_failed',
  'jpeg_encode_failed',
  'main_watchdog',
  'first_frame',
  'readiness',
  'microphone',
  'accessibility',
  'screenRecording',
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
  'daemon_error',
  'daemon_connection',
  'daemon_disconnected',
  'daemon_identity',
  'daemon_reconnect_exhausted',
  'discovery_unreadable',
  'discovery_not_regular_file',
  'discovery_permissions',
  'discovery_owner',
  'discovery_size',
  'discovery_json',
  'discovery_shape',
  'discovery_protocol',
  'discovery_url',
  'provider_config',
  'provider_unreachable',
  'camera',
  'screen',
]);

/** Connection messages can contain provider text; retain only known labels. */
export function daemonConnectionDiagnostic(
  snapshot: { phase: string; error?: string },
  intentional: boolean,
): Readonly<Record<string, unknown>> {
  return {
    phase: snapshot.phase,
    intentional,
    failed: Boolean(snapshot.error),
    ...(snapshot.error
      ? {
          code: SAFE_LABELS.has(snapshot.error)
            ? snapshot.error
            : 'daemon_error',
        }
      : {}),
  };
}

/** Error names are optional diagnostics, never an avenue for arbitrary text. */
export function hostDiagnosticErrorName(error: unknown): string {
  return error instanceof Error &&
    SAFE_LABELS.has(error.name) &&
    error.name.endsWith('Error')
    ? error.name
    : 'Error';
}

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
  options: { windowTrace?: boolean } = {},
): HostDiagnosticsLogger {
  return {
    write(event, details = {}) {
      let descriptor: number | undefined;
      try {
        const windowDetails = options.windowTrace
          ? windowDiagnosticDetails(event, details)
          : undefined;
        if (!FAILURE_EVENTS.has(event) && !windowDetails) return;
        const activePath = join(
          logDirectory,
          windowDetails ? 'host-window-trace.jsonl' : 'host-errors.log',
        );
        const rotatedPath = `${activePath}.1`;
        const maxBytes = windowDetails ? 4 * MAX_LOG_BYTES : MAX_LOG_BYTES;
        if (
          event === 'daemon_connection' &&
          (details['intentional'] === true ||
            (details['phase'] !== 'error' &&
              details['phase'] !== 'incompatible' &&
              details['failed'] !== true))
        )
          return;
        if (
          event === 'capture_start_failed' &&
          details['code'] === 'AbortError'
        )
          return;
        const safeDetails: Record<string, unknown> = windowDetails ?? {};
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
            ...(windowDetails ? { pid: process.pid } : {}),
            event,
            ...safeDetails,
          })}\n`,
        );
        if (!privateDirectory(logDirectory)) return;
        const previous = optionalStat(activePath);
        if (
          previous &&
          (!regularPrivateFile(previous) || previous.size > maxBytes)
        )
          return;
        if (previous && previous.size + entry.length > maxBytes) {
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
          opened.size + entry.length > maxBytes
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
