import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createHostDiagnosticsLogger } from '../host-diagnostics.ts';
import { windowDiagnosticDetails } from '../window-diagnostics.ts';

const temporary: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qwen-host-window-trace-'));
  temporary.push(root);
  const directory = join(root, 'logs');
  return { directory, path: join(directory, 'host-window-trace.jsonl') };
}
afterEach(() =>
  temporary
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

describe('persistent opt-in window geometry diagnostics', () => {
  it('does not create a geometry file when debug is disabled', () => {
    const f = fixture();
    createHostDiagnosticsLogger(f.directory).write('overlay_capture_started', {
      captureId: 1,
    });
    assert.equal(existsSync(f.directory), false);
  });
  it('records capture, native movement, sent and applied offsets with process and build correlation', () => {
    const f = fixture();
    const logger = createHostDiagnosticsLogger(f.directory, {
      windowTrace: true,
    });
    logger.write('host_window_trace_started', {
      traceVersion: 1,
      buildId: 'a'.repeat(64),
    });
    const before = {
      nativeBounds: { x: 300, y: 312, width: 700, height: 620 },
      logical: { x: 300, y: 312 },
      offset: { x: 0, y: 0 },
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
      layout: 'orb',
      settingsOpen: false,
      visualGeneration: 5,
    };
    logger.write('overlay_capture_started', { captureId: 7, before });
    logger.write('overlay_native_moved', {
      bounds: { ...before.nativeBounds, y: 280 },
      offset: before.offset,
    });
    logger.write('overlay_offset_sent', { offset: { x: 0, y: 32 } });
    logger.write('overlay_offset_applied', {
      offset: { x: 0, y: 32 },
      cardBounds: { x: 60, y: 366, width: 234, height: 171 },
    });
    logger.write('overlay_capture_finished', {
      captureId: 7,
      succeeded: true,
      before,
      after: { ...before, offset: { x: 0, y: 32 } },
    });
    logger.write('overlay_capture_compensated', {
      captureId: 7,
      phase: 'native-restore',
      reason: 'native-geometry-restored',
      correctedOffset: { x: 0, y: 0 },
    });
    const records = readFileSync(f.path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 7);
    assert(
      records.every(
        (row) =>
          row.pid === process.pid && row.source === 'qwen-live-harness-host',
      ),
    );
    assert.equal(records[0].buildId, 'a'.repeat(64));
    assert.deepEqual(records[1].before, before);
    assert.deepEqual(records[4].cardBounds, {
      x: 60,
      y: 366,
      width: 234,
      height: 171,
    });
    assert.equal(records[5].captureId, 7);
    assert.equal(records[6].phase, 'native-restore');
    assert.equal(records[6].reason, 'native-geometry-restored');
    assert.deepEqual(records[6].correctedOffset, { x: 0, y: 0 });
    assert.equal(existsSync(join(f.directory, 'host-errors.log')), false);
    if (process.platform !== 'win32')
      assert.equal(statSync(f.path).mode & 0o777, 0o600);
  });
  it('only keeps bounded geometry and owned labels, never content from logs or the renderer', () => {
    const result = windowDiagnosticDetails('overlay_capture_started', {
      captureId: 2,
      reason: 'secret-token',
      apiKey: 'secret-token',
      before: {
        ...{
          owner: { password: 'secret-token' },
          nativeBounds: {
            x: 2,
            y: 3,
            width: 700,
            height: 620,
            title: 'private-title',
          },
          logical: { x: NaN, y: 3 },
          offset: { x: 0, y: Infinity },
        },
        layout: 'private-title',
      },
      changedMetrics: ['workArea', 'private-title'],
      cardBounds: { x: 100_000_000, y: 0 },
    });
    assert.deepEqual(result, {
      captureId: 2,
      before: { nativeBounds: { x: 2, y: 3, width: 700, height: 620 } },
      changedMetrics: ['workArea'],
    });
    assert.equal(windowDiagnosticDetails('untrusted-event', {}), undefined);
  });
  it('keeps frame expansion separate from actual content movement in resize traces', () => {
    const frame = { x: 1399, y: 423, width: 700, height: 652 };
    const content = { x: 1399, y: 455, width: 700, height: 620 };
    assert.deepEqual(
      windowDiagnosticDetails('overlay_native_resized', {
        bounds: frame,
        contentBounds: content,
        nativeSize: [700, 652],
        contentSize: [700, 620],
        requestedCanvas: { width: 700, height: 620 },
        isFullScreen: false,
        isSimpleFullScreen: false,
        isMaximized: false,
        reason: 'native-resize',
      }),
      {
        bounds: frame,
        contentBounds: content,
        nativeSize: { width: 700, height: 652 },
        contentSize: { width: 700, height: 620 },
        requestedCanvas: { width: 700, height: 620 },
        isFullScreen: false,
        isSimpleFullScreen: false,
        isMaximized: false,
        reason: 'native-resize',
      },
    );
  });
  it('rotates the geometry log independently at four MiB', () => {
    const f = fixture();
    const logger = createHostDiagnosticsLogger(f.directory, {
      windowTrace: true,
    });
    logger.write('overlay_offset_sent', { offset: { x: 0, y: 0 } });
    writeFileSync(f.path, 'x'.repeat(4 * 1024 * 1024 - 10), { mode: 0o600 });
    logger.write('overlay_offset_applied', { offset: { x: 0, y: 32 } });
    assert(existsSync(`${f.path}.1`));
    assert.equal(
      JSON.parse(readFileSync(f.path, 'utf8')).event,
      'overlay_offset_applied',
    );
  });
});
