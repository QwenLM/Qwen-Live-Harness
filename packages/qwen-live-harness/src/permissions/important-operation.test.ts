/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { isImportantPermissionOperation } from './important-operation.js';

describe('automatic operation announcement policy', () => {
  it.each([
    'pwd',
    'ls -la /tmp',
    '/bin/ls /tmp',
    'git status --short',
    '/usr/bin/git diff --stat',
    '["/bin/zsh","-lc","git status --short"]',
  ])('keeps the simple inspection %s in logs without voice', (command) => {
    expect(
      isImportantPermissionOperation({ command, operation: 'execute' }),
    ).toBe(false);
  });
  it.each([
    'rm -rf ./output',
    'python build.py',
    'npm install',
    'curl https://example.test',
    'git push',
    'git diff --output=changes.patch',
    'git show --ext-diff',
    'ls; rm file',
    'pwd > file',
    'git status && git push',
    'ls $(touch file)',
    '/tmp/ls',
    '["/bin/zsh","-lc","ls; rm file"]',
  ])('announces effects, composition or unknown commands: %s', (command) => {
    expect(isImportantPermissionOperation({ command, operation: 'read' })).toBe(
      true,
    );
  });
  it('skips known read/list/search metadata but announces missing, incomplete or mutating operations', () => {
    for (const operation of ['read', 'list', 'search', 'inspect'])
      expect(isImportantPermissionOperation({ operation })).toBe(false);
    for (const operation of [
      'write',
      'delete',
      'execute',
      'network',
      'unknown',
    ])
      expect(isImportantPermissionOperation({ operation })).toBe(true);
    expect(isImportantPermissionOperation()).toBe(true);
    expect(
      isImportantPermissionOperation({ command: 'pwd', incomplete: true }),
    ).toBe(true);
  });
});
