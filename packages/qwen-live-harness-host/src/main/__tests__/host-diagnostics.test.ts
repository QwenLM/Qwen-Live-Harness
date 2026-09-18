import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  createHostDiagnosticsLogger,
  daemonConnectionDiagnostic,
  hostDiagnosticErrorName,
} from '../host-diagnostics.ts';

let temporaryDirectory: string;
let logDirectory: string;
let activePath: string;
beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'qwen-host-diagnostics-'));
  logDirectory = join(temporaryDirectory, 'logs');
  activePath = join(logDirectory, 'host-errors.log');
});
afterEach(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

describe('persistent Host failure diagnostics', () => {
  it('records bounded failure details without requiring a debug flag', () => {
    const logger = createHostDiagnosticsLogger(logDirectory);
    logger.write('audio_capture_timeout', {
      epoch: 3,
      code: 'audio_capture_start_timeout',
      stage: 'main_watchdog',
      durationMs: 10_000,
    });
    logger.write('renderer_process_gone', { reason: 'crashed', exitCode: 139 });
    const entries = readFileSync(activePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(entries[0], {
      timestamp: entries[0].timestamp,
      source: 'qwen-live-harness-host',
      event: 'audio_capture_timeout',
      epoch: 3,
      code: 'audio_capture_start_timeout',
      stage: 'main_watchdog',
      durationMs: 10_000,
    });
    assert.ok(Number.isFinite(Date.parse(entries[0].timestamp)));
    assert.equal(entries[1].reason, 'crashed');
    if (process.platform !== 'win32') {
      assert.equal(lstatSync(logDirectory).mode & 0o777, 0o700);
      assert.equal(lstatSync(activePath).mode & 0o777, 0o600);
    }
  });

  it('does not create files for ordinary frame events or arbitrary event names', () => {
    const logger = createHostDiagnosticsLogger(logDirectory);
    logger.write('output_frame_received', { epoch: 1, bytes: 1_024 });
    logger.write('capture_start_stage', { stage: 'microphone' });
    logger.write('unknown_failure_with_private_data');
    assert.equal(existsSync(logDirectory), false);
  });

  it('ignores healthy connection snapshots and intentional Quit disconnections', () => {
    const logger = createHostDiagnosticsLogger(logDirectory);
    for (const phase of ['disconnected', 'connecting', 'ready']) {
      logger.write(
        'daemon_connection',
        daemonConnectionDiagnostic({ phase }, false),
      );
    }
    for (const phase of [
      'disconnected',
      'connecting',
      'ready',
      'error',
      'incompatible',
    ]) {
      logger.write(
        'daemon_connection',
        daemonConnectionDiagnostic(
          { phase, error: 'daemon_disconnected' },
          true,
        ),
      );
    }
    assert.equal(existsSync(logDirectory), false);
  });

  it('retains safe daemon connection failures without copying provider messages', () => {
    const logger = createHostDiagnosticsLogger(logDirectory);
    for (const snapshot of [
      { phase: 'error', error: 'daemon_connection' },
      { phase: 'incompatible', error: 'host_version' },
      { phase: 'disconnected', error: 'daemon_disconnected' },
      { phase: 'error', error: 'daemon_reconnect_exhausted' },
      { phase: 'error', error: 'discovery_permissions' },
      { phase: 'ready', error: 'sk-test-secret /private/user/path' },
      { phase: 'error' },
    ]) {
      logger.write(
        'daemon_connection',
        daemonConnectionDiagnostic(snapshot, false),
      );
    }
    const text = readFileSync(activePath, 'utf8');
    const entries = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(entries.length, 7);
    assert.deepEqual(
      entries.map(({ phase, code }) => ({ phase, code })),
      [
        { phase: 'error', code: 'daemon_connection' },
        { phase: 'incompatible', code: 'host_version' },
        { phase: 'disconnected', code: 'daemon_disconnected' },
        { phase: 'error', code: 'daemon_reconnect_exhausted' },
        { phase: 'error', code: 'discovery_permissions' },
        { phase: 'ready', code: 'daemon_error' },
        { phase: 'error', code: undefined },
      ],
    );
    assert(!text.includes('sk-test-secret'));
    assert(!text.includes('/private/user/path'));
  });

  it('retains permission and visual/audio interruption codes without media or error text', () => {
    const logger = createHostDiagnosticsLogger(logDirectory);
    const cases = [
      ['camera_permission_error', 'camera_permission_request_failed', 'camera'],
      [
        'permission_request_failed',
        'microphone_permission_request_failed',
        'microphone',
      ],
      ['permission_denied', 'camera_permission_denied', 'camera'],
      ['permission_denied', 'microphone_permission_denied', 'microphone'],
      ['permission_revoked', 'camera_permission_revoked', 'camera'],
      ['permission_revoked', 'microphone_permission_revoked', 'microphone'],
      [
        'permission_revoked',
        'accessibility_permission_revoked',
        'accessibility',
      ],
      [
        'permission_revoked',
        'screen_recording_permission_revoked',
        'screenRecording',
      ],
      ['audio_capture_failed', 'audio_transport_rejected', undefined],
      ['camera_capture_error', 'camera_track_ended', undefined],
      ['visual_capture_error', 'screen_frame_too_large', undefined],
      ['audio_output_finish_failed', 'audio_output_finish_failed', undefined],
    ] as const;
    for (const [event, code, permission] of cases) {
      logger.write(event, {
        code,
        permission,
        errorName: 'NotAllowedError',
        epoch: 5,
        outputId: 8,
        message: 'private media device and path',
      });
    }
    const text = readFileSync(activePath, 'utf8');
    const entries = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      entries.map(({ event, code, permission }) => [event, code, permission]),
      cases,
    );
    assert.equal(entries[0].errorName, 'NotAllowedError');
    assert.equal(entries[0].epoch, 5);
    assert.equal(entries[0].outputId, 8);
    assert(!text.includes('private media'));
  });

  it('normalizes unexpected error names before forwarding diagnostics', () => {
    assert.equal(
      hostDiagnosticErrorName(new TypeError('private')),
      'TypeError',
    );
    assert.equal(
      hostDiagnosticErrorName(new DOMException('private', 'NotAllowedError')),
      'NotAllowedError',
    );
    assert.equal(
      hostDiagnosticErrorName(
        Object.assign(new Error('private'), { name: 'sk-secret' }),
      ),
      'Error',
    );
    assert.equal(
      hostDiagnosticErrorName({ name: 'TypeError', message: 'private' }),
      'Error',
    );
  });

  it('records the failing capture stage but ignores an ordinary user cancellation', () => {
    const logger = createHostDiagnosticsLogger(logDirectory);
    logger.write('capture_start_failed', {
      epoch: 1,
      stage: 'microphone',
      code: 'AbortError',
    });
    assert.equal(existsSync(logDirectory), false);
    logger.write('capture_start_failed', {
      epoch: 2,
      stage: 'worklet',
      code: 'NotReadableError',
    });
    const entry = JSON.parse(readFileSync(activePath, 'utf8'));
    assert.equal(entry.event, 'capture_start_failed');
    assert.equal(entry.epoch, 2);
    assert.equal(entry.stage, 'worklet');
    assert.equal(entry.code, 'NotReadableError');
  });

  it('drops secrets, media, paths, arbitrary labels, and structured details', () => {
    const logger = createHostDiagnosticsLogger(logDirectory);
    logger.write('capture_start_failed', {
      epoch: 2,
      stage: 'microphone',
      apiKey: 'sk-test-secret-do-not-record',
      code: 'sk-test-secret-do-not-record',
      reason: 'Bearer test-secret',
      message: 'failed /private/user/path with a key',
      image: 'image-bytes',
      audio: new Uint8Array([1, 2, 3]),
      path: '/private/user/path',
      source: 'private-device-name',
      details: { error: 'sensitive' },
      durationMs: Number.NaN,
      exitCode: Number.POSITIVE_INFINITY,
    });
    const entry = JSON.parse(readFileSync(activePath, 'utf8'));
    assert.deepEqual(Object.keys(entry).sort(), [
      'epoch',
      'event',
      'source',
      'stage',
      'timestamp',
    ]);
    assert.equal(entry.source, 'qwen-live-harness-host');
    assert.equal(entry.stage, 'microphone');
  });

  it('keeps only the active log and one bounded private rotation', () => {
    const logger = createHostDiagnosticsLogger(logDirectory);
    logger.write('preload_failed', { kind: 'TypeError' });
    const full = Buffer.alloc(1024 * 1024, 'x');
    writeFileSync(activePath, full);
    logger.write('renderer_unresponsive');
    assert.deepEqual(readFileSync(`${activePath}.1`), full);
    assert.equal(
      JSON.parse(readFileSync(activePath, 'utf8')).event,
      'renderer_unresponsive',
    );
    writeFileSync(activePath, Buffer.alloc(1024 * 1024, 'y'));
    logger.write('audio_capture_failed', { code: 'NotReadableError' });
    assert.equal(readFileSync(`${activePath}.1`, 'utf8')[0], 'y');
    assert.deepEqual(readdirSync(logDirectory).sort(), [
      'host-errors.log',
      'host-errors.log.1',
    ]);
    for (const path of [activePath, `${activePath}.1`]) {
      assert.ok(lstatSync(path).size <= 1024 * 1024);
      if (process.platform !== 'win32')
        assert.equal(lstatSync(path).mode & 0o777, 0o600);
    }
  });

  it('ignores an unusable directory and malformed details without throwing', () => {
    writeFileSync(logDirectory, 'not a directory');
    const logger = createHostDiagnosticsLogger(logDirectory);
    assert.doesNotThrow(() => logger.write('audio_capture_failed'));
    assert.equal(readFileSync(logDirectory, 'utf8'), 'not a directory');
    assert.doesNotThrow(() =>
      logger.write('audio_capture_failed', {
        get epoch() {
          throw new Error('invalid caller data');
        },
      }),
    );
  });

  it('does not write through a symlinked log directory or file', () => {
    if (process.platform === 'win32') return;
    const targetDirectory = join(temporaryDirectory, 'other');
    mkdirSync(targetDirectory, { mode: 0o700 });
    symlinkSync(targetDirectory, logDirectory);
    const logger = createHostDiagnosticsLogger(logDirectory);
    logger.write('preload_failed');
    assert.deepEqual(readdirSync(targetDirectory), []);
    unlinkSync(logDirectory);
    mkdirSync(logDirectory, { mode: 0o700 });
    const targetFile = join(targetDirectory, 'external.log');
    writeFileSync(targetFile, 'unchanged', { mode: 0o600 });
    symlinkSync(targetFile, activePath);
    logger.write('preload_failed');
    assert.equal(readFileSync(targetFile, 'utf8'), 'unchanged');
  });

  it('leaves public or multiply-linked log files untouched', () => {
    const logger = createHostDiagnosticsLogger(logDirectory);
    logger.write('preload_failed');
    const original = readFileSync(activePath, 'utf8');
    if (process.platform !== 'win32') {
      chmodSync(activePath, 0o644);
      logger.write('renderer_unresponsive');
      assert.equal(readFileSync(activePath, 'utf8'), original);
      chmodSync(activePath, 0o600);
    }
    linkSync(activePath, join(temporaryDirectory, 'other.log'));
    logger.write('renderer_unresponsive');
    assert.equal(readFileSync(activePath, 'utf8'), original);
  });

  it('does not replace an unsafe rotation target', () => {
    if (process.platform === 'win32') return;
    const logger = createHostDiagnosticsLogger(logDirectory);
    logger.write('preload_failed');
    writeFileSync(activePath, Buffer.alloc(1024 * 1024, 'x'));
    const external = join(temporaryDirectory, 'external.log');
    writeFileSync(external, 'untouched', { mode: 0o600 });
    symlinkSync(external, `${activePath}.1`);
    assert.doesNotThrow(() => logger.write('renderer_unresponsive'));
    assert.equal(readFileSync(external, 'utf8'), 'untouched');
    assert.equal(lstatSync(`${activePath}.1`).isSymbolicLink(), true);
  });
});
