const ICONS = {
  mic: '<path d="M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
  micOff:
    '<path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v4M5 10v2a7 7 0 0 0 12 5M19 10v2M12 19v3M8 22h8"/>',
  volume:
    '<path d="m11 4-6 5H2v6h3l6 5zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
  volumeOff: '<path d="m11 4-6 5H2v6h3l6 5zM16 9l5 6M21 9l-5 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  play: '<path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none"/>',
  settings:
    '<path d="M9.93,4.79 L10.26,2.15 L13.74,2.15 L14.07,4.79 L15.64,5.44 L17.74,3.81 L20.19,6.26 L18.56,8.36 L19.21,9.93 L21.85,10.26 L21.85,13.74 L19.21,14.07 L18.56,15.64 L20.19,17.74 L17.74,20.19 L15.64,18.56 L14.07,19.21 L13.74,21.85 L10.26,21.85 L9.93,19.21 L8.36,18.56 L6.26,20.19 L3.81,17.74 L5.44,15.64 L4.79,14.07 L2.15,13.74 L2.15,10.26 L4.79,9.93 L5.44,8.36 L3.81,6.26 L6.26,3.81 L8.36,5.44 Z"/><circle cx="12" cy="12" r="3.1"/>',
  quit: '<path d="M12 2v10M6 5a9 9 0 1 0 12 0"/>',
  camera:
    '<rect x="2" y="5" width="14" height="14" rx="3"/><path d="m16 9 6-3v12l-6-3"/>',
  screen:
    '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4M8 21h8"/>',
  memory: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  back: '<path d="m14 5-7 7 7 7"/>',
  task: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/><path d="M6 10v7h8"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:
    '<path d="m3 3 18 18M9 5c8-2 13 7 13 7a17 17 0 0 1-3 4M6 6a18 18 0 0 0-4 6s3 7 10 7c2 0 4-1 5-2M10 10a3 3 0 0 0 4 4"/>',
  external: '<path d="M14 3h7v7M21 3 10 14M10 3H4v17h17v-6"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M18 18A8 8 0 0 1 4 12"/>',
  qwen: '<path d="m12 3 2.7 5.4L21 9l-4.5 4.3 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9l6.3-.6z"/>',
  code: '<path d="m8 5-7 7 7 7M16 5l7 7-7 7M14 3l-4 18"/>',
} as const;

export type UiIcon = keyof typeof ICONS;

export function uiIcon(name: UiIcon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICONS[name];
  return svg;
}

export function setIcon(element: HTMLElement, name: UiIcon): void {
  if (element.dataset.icon === name) return;
  element.dataset.icon = name;
  element.replaceChildren(uiIcon(name));
}
