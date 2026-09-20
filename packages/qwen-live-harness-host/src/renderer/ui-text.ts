import {
  liveText,
  type LiveLanguage,
  type LiveMessageKey,
} from 'qwen-live-harness/i18n';

/** Used only before the Host has supplied its saved application language. */
export function initialUiLanguage(document: Document): LiveLanguage {
  const navigator = document.defaultView?.navigator;
  const preferences = navigator?.languages?.length
    ? navigator.languages
    : [navigator?.language ?? 'en'];
  for (const language of preferences) {
    if (/^zh(?:-|$)/iu.test(language)) return 'zh-CN';
    if (/^en(?:-|$)/iu.test(language)) return 'en';
  }
  return 'en';
}

export function uiText<T extends HTMLElement>(
  element: T,
  key: LiveMessageKey,
): T {
  element.dataset.liveText = key;
  element.textContent = liveText('en', key);
  return element;
}

export function uiLabel<T extends HTMLElement>(
  element: T,
  key: LiveMessageKey,
): T {
  element.dataset.liveLabel = key;
  element.setAttribute('aria-label', liveText('en', key));
  element.title = liveText('en', key);
  return element;
}

export function localizeUi(element: HTMLElement, language: LiveLanguage): void {
  const withAttribute = (selector: string): HTMLElement[] => [
    ...(element.matches(selector) ? [element] : []),
    ...element.querySelectorAll<HTMLElement>(selector),
  ];
  for (const child of withAttribute('[data-live-text]')) {
    const value = liveText(language, child.dataset.liveText as LiveMessageKey);
    if (child.textContent !== value) child.textContent = value;
  }
  for (const child of withAttribute('[data-live-label]')) {
    const value = liveText(language, child.dataset.liveLabel as LiveMessageKey);
    if (child.getAttribute('aria-label') !== value)
      child.setAttribute('aria-label', value);
    if (child.title !== value) child.title = value;
  }
}
