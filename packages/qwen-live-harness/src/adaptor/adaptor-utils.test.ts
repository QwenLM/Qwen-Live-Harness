/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describePermissionDetails,
  describePersistentScope,
  describeToolCall,
  pickLeastEscalating,
} from './adaptor-utils.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'live-permission-details-'));
  roots.push(root);
  return root;
}

describe('permission operation facts', () => {
  it('displays argv faithfully and retains the exact array including argument order and empty strings', () => {
    const argv = ['/bin/zsh', '-lc', "printf '%s'  'a  b'", ''];
    const tool = { title: 'Run command', rawInput: { command: argv } };
    const details = describePermissionDetails(tool);
    expect(details.command).toBe(JSON.stringify(argv));
    expect(details.rawInput).toEqual({ command: argv });
    expect(details.incomplete).toBeUndefined();
    expect(describeToolCall(tool)).toBe(JSON.stringify(argv));
    expect(
      describePermissionDetails({ rawInput: { command: [...argv].reverse() } })
        .rawInput,
    ).not.toEqual(details.rawInput);
  });

  it('redacts argv credentials, common token formats and display control sequences', () => {
    const details = describePermissionDetails({
      name: '\u001b[31mBash',
      operation: 'execute\nforged',
      rawInput: {
        command: ['tool', '--password', 'argv-fixture-secret'],
        private_key: 'private-fixture-secret',
        access_key: 'access-fixture-secret',
        note: 'ghp_123456789012345678901234',
      },
    });
    expect(details).toMatchObject({
      toolName: 'Bash',
      operation: 'execute',
      incomplete: true,
    });
    expect(JSON.stringify(details)).not.toMatch(
      /argv-fixture-secret|private-fixture-secret|access-fixture-secret|ghp_123/,
    );
  });

  it('never treats a legacy command or omitted top-level execution facts as a complete action', () => {
    expect(describePermissionDetails({ command: 'echo ok' })).toMatchObject({
      command: 'echo ok',
      incomplete: true,
    });
    expect(
      describePermissionDetails({
        rawInput: { command: 'echo ok' },
        env: { FIXTURE: 'value' },
      }),
    ).toMatchObject({ incomplete: true });
    expect(
      describePermissionDetails({
        command: 'echo second',
        rawInput: { command: 'echo first' },
      }),
    ).toMatchObject({ incomplete: true });
  });

  it('uses rawInput commands for display and retains significant whitespace and quoting', () => {
    const command = "  printf '%s'  'a  b'\n";
    const tool = {
      toolCallId: 'tc-1',
      title: 'Run command',
      kind: 'execute',
      rawInput: { command },
    };
    expect(describeToolCall(tool)).toBe(command);
    expect(describePermissionDetails(tool)).toEqual({
      toolCallId: 'tc-1',
      command,
      operation: 'execute',
      rawInput: { command },
    });
    expect(
      describePermissionDetails({ rawInput: { cmd: command } }).command,
    ).toBe(command);
    expect(
      describePermissionDetails({ rawInput: JSON.stringify({ command }) })
        .rawInput,
    ).toEqual({ command });
  });

  it('verifies only the canonical directory backed by the adaptor session cwd', () => {
    const root = workspace();
    const other = join(root, 'other');
    const alias = `${root}-alias`;
    mkdirSync(other);
    symlinkSync(root, alias, 'dir');
    roots.push(alias);
    expect(describePermissionDetails({}, root)).toEqual({
      cwd: realpathSync(root),
      cwdVerified: true,
    });
    expect(
      describePermissionDetails({ rawInput: { cwd: alias } }, root),
    ).toMatchObject({ cwd: realpathSync(root), cwdVerified: true });
    expect(
      describePermissionDetails({ rawInput: { cwd: other } }, root),
    ).toMatchObject({ cwd: other, cwdVerified: false });
    expect(
      describePermissionDetails({ rawInput: { cwd: root } }),
    ).toMatchObject({ cwd: root, cwdVerified: false });
    expect(describePermissionDetails({}, join(root, 'missing'))).toMatchObject({
      cwdVerified: false,
    });
    const file = join(root, 'file');
    writeFileSync(file, 'fixture');
    expect(describePermissionDetails({}, file)).toMatchObject({
      cwdVerified: false,
    });
  });

  it('retains structured resources but does not infer operations from a title', () => {
    expect(
      describePermissionDetails({
        title: 'Edit every file',
        rawInput: { file_path: '/work/a' },
        locations: [{ path: '/work/b' }],
      }),
    ).toEqual({
      rawInput: { file_path: '/work/a' },
      resources: ['/work/a', '/work/b'],
    });
    expect(describePermissionDetails({ title: 'Run command' })).toEqual({});
  });

  it('bounds oversized, deeply nested and cyclic input and marks it incomplete', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    for (const rawInput of [
      { command: 'x'.repeat(100_000) },
      cycle,
      Array.from({ length: 100 }, () => 'a'),
    ]) {
      const details = describePermissionDetails({ rawInput });
      expect(details.incomplete).toBe(true);
      expect(JSON.stringify(details).length).toBeLessThan(20_000);
    }
  });

  it('redacts credentials from facts and display and makes those facts ineligible for matching', () => {
    const command =
      "echo ok; API_KEY='fixture-secret' request --password another-secret";
    const tool = {
      name: 'Bash',
      rawInput: { command, access_token: 'nested-secret' },
    };
    const details = describePermissionDetails(tool);
    expect(details.incomplete).toBe(true);
    expect(JSON.stringify(details)).not.toMatch(
      /fixture-secret|another-secret|nested-secret/,
    );
    expect(describeToolCall(tool)).not.toMatch(/fixture-secret|another-secret/);
    expect(
      describeToolCall({ title: 'Run command --password fixture-secret' }),
    ).not.toContain('fixture-secret');
  });
});

describe('permission option scope', () => {
  it('requires explicit persistent wire kind and an honest native scope label', () => {
    expect(
      describePersistentScope('Always Allow in project: git', 'allow_always'),
    ).toBe('Always Allow in project: git');
    expect(describePersistentScope('Allow all edits', 'allow_always')).toBe(
      'Allow all edits',
    );
    expect(
      describePersistentScope('Always Allow', 'allow_always'),
    ).toBeUndefined();
    expect(
      describePersistentScope('Allow all edits', undefined),
    ).toBeUndefined();
    expect(
      describePersistentScope('Always Allow in project: git', 'allow_once'),
    ).toBeUndefined();
  });

  it('never silently escalates an ordinary approval to the only persistent option', () => {
    expect(
      pickLeastEscalating(
        [{ optionId: 'all', kind: 'proceed', escalation: 'always' }],
        'proceed',
      ),
    ).toBeUndefined();
    expect(
      pickLeastEscalating(
        [
          { optionId: 'all', kind: 'proceed', escalation: 'always' },
          { optionId: 'one', kind: 'proceed', escalation: 'once' },
        ],
        'proceed',
      )?.optionId,
    ).toBe('one');
  });
});
