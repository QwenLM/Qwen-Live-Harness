const shadowGutter = 40;
const panel = { width: 280, height: 420 } as const;

/** Native frame includes the transparent CSS shadow gutter, not extra content. */
export const SUBAGENTS_GEOMETRY = {
  summary: { width: 132, height: 62 },
  panel,
  shadowGutter,
  expanded: {
    width: panel.width + shadowGutter * 2,
    height: panel.height + shadowGutter * 2,
  },
} as const;
