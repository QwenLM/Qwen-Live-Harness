/** Conservative paint extent of the shared CSS shadow, not a hit-test margin. */
export const OVERLAY_SHADOW_PADDING = 36;

export const OVERLAY_GEOMETRY = {
  canvas: { width: 700, height: 620 },
  setup: { x: 158, y: 70, width: 384, height: 480 },
  card: { x: 60, y: 334, width: 234, height: 171 },
  header: { x: 75, y: 349, width: 204, height: 12 },
  orb: { x: 78, y: 381, width: 51, height: 51 },
  orbMotion: { x: 78, y: 381, width: 51, height: 51 },
  toolbar: { x: 75, y: 450, width: 204, height: 41 },
  status: { x: 142, y: 389.5, width: 137, height: 34 },
  summary: { x: 60, y: 518, width: 234, height: 30 },
  caption: { x: 41, y: 239, width: 272, height: 88 },
  preview: { x: 96.5, y: 215, width: 161, height: 107 },
  previewWithCaption: { x: 96.5, y: 122, width: 161, height: 107 },
  previewToggle: { x: 256, y: 408, width: 23, height: 23 },
  settings: { x: 350, y: 40, width: 306, height: 532 },
  settingsBounds: { x: 5, y: 4, width: 687, height: 604 },
  bounds: {
    setup: { x: 122, y: 34, width: 456, height: 552 },
    // Keep the same horizontal/bottom anchor and a safe caption envelope so
    // transcript updates never reposition the native window or task panels.
    orb: { x: 5, y: 203, width: 344, height: 381 },
    'orb-preview': { x: 5, y: 86, width: 344, height: 498 },
  },
} as const;

export type OverlayLayout = keyof typeof OVERLAY_GEOMETRY.bounds;
