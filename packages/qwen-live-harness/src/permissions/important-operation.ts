/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PermissionDetails } from '../adaptor/types.js';

/** Notification policy only. This classification never grants permission. */
export function isImportantPermissionOperation(
  details?: PermissionDetails,
): boolean {
  if (!details || details.incomplete) return true;
  if (details.command) {
    let command = details.command.trim();
    try {
      const argv: unknown = JSON.parse(command);
      if (Array.isArray(argv) && argv.every((v) => typeof v === 'string')) {
        if (
          argv.length === 3 &&
          /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|zsh|sh)$/.test(argv[0]) &&
          ['-c', '-lc'].includes(argv[1])
        )
          command = argv[2];
        else command = argv.join(' ');
      }
    } catch {
      /* Shell strings remain quoted data; never execute or evaluate them. */
    }
    // Any composition, substitution or redirection is important, even if its
    // first word looks read-only. Unknown commands are important by default.
    if (/[;&|<>$`\n\r]/u.test(command)) return true;
    if (/(?:^|\s)--(?:output|ext-diff|textconv|exec)(?:=|\s|$)/u.test(command))
      return true;
    if (
      /^(?:(?:\/bin\/|\/usr\/bin\/))?(?:pwd|ls)(?:\s[^;&|<>$`\n\r]*)?$/u.test(
        command,
      )
    )
      return false;
    if (
      /^(?:\/usr\/bin\/)?git\s+(?:status|diff|log|show)(?:\s[^;&|<>$`\n\r]*)?$/u.test(
        command,
      )
    )
      return false;
    return true;
  }
  return !['read', 'list', 'search', 'inspect'].includes(
    details.operation?.toLowerCase() ?? '',
  );
}
