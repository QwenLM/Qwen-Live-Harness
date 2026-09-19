/** Only owned UI geometry is persisted; no media, text, paths or credentials. */
const EVENTS = new Set([
  'host_window_trace_started',
  'overlay_position',
  'overlay_native_moved',
  'overlay_native_resized',
  'overlay_native_will_resize',
  'overlay_layout_changed',
  'overlay_capture_started',
  'overlay_capture_finished',
  'overlay_capture_compensated',
  'overlay_capture_guard_cancelled',
  'overlay_offset_sent',
  'overlay_offset_applied',
  'native_display_changed',
]);
const LABELS = new Set([
  'setup',
  'orb',
  'orb-preview',
  'window-created',
  'renderer-ready',
  'layout-changed',
  'settings-opened',
  'settings-closed',
  'settings-dismissed',
  'drag-start',
  'drag-move',
  'drag-end',
  'window-shown',
  'native-frame-clamp',
  'native-move',
  'native-resize',
  'native-resized',
  'native-restore',
  'native-will-resize',
  'native-top-expansion',
  'native-top-inset-change',
  'native-geometry-restored',
  'content-origin-stable',
  'incompatible-geometry',
  'capture-guard-limit',
  'capture-guard-expired',
  'capture-finished',
  'unrecognized-native-move',
  'compensation-failed',
  'window-closed',
  'renderer-reload',
  'display-change',
  'display-added',
  'display-removed',
  'display-metrics-changed',
  'bounds',
  'workArea',
  'scaleFactor',
  'rotation',
  'colorSpace',
]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= 10_000_000
  );
}
function geometry(value: unknown): Record<string, number> | undefined {
  if (!record(value) || !finite(value['x']) || !finite(value['y']))
    return undefined;
  const result: Record<string, number> = { x: value['x'], y: value['y'] };
  for (const key of ['width', 'height']) {
    if (finite(value[key]) && value[key] > 0) result[key] = value[key];
  }
  return result;
}
function size(value: unknown): Record<string, number> | undefined {
  const width = Array.isArray(value)
    ? value[0]
    : record(value)
      ? value['width']
      : undefined;
  const height = Array.isArray(value)
    ? value[1]
    : record(value)
      ? value['height']
      : undefined;
  return finite(width) && width > 0 && finite(height) && height > 0
    ? { width, height }
    : undefined;
}
function snapshot(value: unknown): Record<string, unknown> | undefined {
  if (!record(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of [
    'nativeBounds',
    'contentBounds',
    'beforeContent',
    'afterContent',
    'logical',
    'offset',
    'workArea',
    'visible',
  ]) {
    const rect = geometry(value[key]);
    if (rect) result[key] = rect;
  }
  if (typeof value['layout'] === 'string' && LABELS.has(value['layout']))
    result['layout'] = value['layout'];
  if (typeof value['settingsOpen'] === 'boolean')
    result['settingsOpen'] = value['settingsOpen'];
  if (finite(value['visualGeneration']))
    result['visualGeneration'] = value['visualGeneration'];
  for (const key of ['nativeSize', 'contentSize', 'requestedCanvas']) {
    const dimensions = size(value[key]);
    if (dimensions) result[key] = dimensions;
  }
  for (const key of ['isFullScreen', 'isSimpleFullScreen', 'isMaximized']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  return Object.keys(result).length ? result : undefined;
}

export function windowDiagnosticDetails(
  event: string,
  details: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (!EVENTS.has(event)) return undefined;
  const safe: Record<string, unknown> = {};
  for (const key of [
    'captureId',
    'pid',
    'traceVersion',
    'displayId',
    'scaleFactor',
    'rotation',
    'visualGeneration',
  ]) {
    if (finite(details[key])) safe[key] = details[key];
  }
  for (const key of [
    'succeeded',
    'settingsOpen',
    'geometryChanged',
    'dragging',
    'isFullScreen',
    'isSimpleFullScreen',
    'isMaximized',
  ]) {
    if (typeof details[key] === 'boolean') safe[key] = details[key];
  }
  for (const key of ['reason', 'phase', 'layout', 'previousLayout']) {
    const value = details[key];
    if (typeof value === 'string' && LABELS.has(value)) safe[key] = value;
  }
  for (const key of [
    'bounds',
    'requested',
    'offset',
    'correctedOffset',
    'workArea',
    'cardBounds',
    'contentBounds',
    'beforeContent',
    'afterContent',
    'logical',
  ]) {
    const rect = geometry(details[key]);
    if (rect) safe[key] = rect;
  }
  for (const key of ['before', 'after']) {
    const value = geometry(details[key]) ?? snapshot(details[key]);
    if (value) safe[key] = value;
  }
  for (const key of ['nativeSize', 'contentSize', 'requestedCanvas']) {
    const dimensions = size(details[key]);
    if (dimensions) safe[key] = dimensions;
  }
  if (
    typeof details['buildId'] === 'string' &&
    /^[a-f0-9]{64}$/u.test(details['buildId'])
  )
    safe['buildId'] = details['buildId'];
  if (Array.isArray(details['changedMetrics']))
    safe['changedMetrics'] = details['changedMetrics']
      .filter(
        (key): key is string => typeof key === 'string' && LABELS.has(key),
      )
      .slice(0, 8);
  return safe;
}
