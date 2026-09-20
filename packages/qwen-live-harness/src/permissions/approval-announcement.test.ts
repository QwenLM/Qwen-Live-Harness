/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { PermissionDetails } from '../adaptor/types.js';
import { liveText } from '../i18n/messages.js';
import { automaticApprovalAnnouncement } from './approval-announcement.js';

type Details = Pick<PermissionDetails, 'command' | 'toolName' | 'operation'>;
const SECRET = 'PRIVATE-KEY-AND-TITLE';

describe.each(['zh-CN', 'en'] as const)(
  'automatic approval announcement in %s',
  (language) => {
    const command = (name: string) =>
      liveText(language, 'permissions.autoApprovedCommand', { name });
    const tool = (name: string) =>
      liveText(language, 'permissions.autoApprovedTool', { name });
    const genericCommand = () =>
      liveText(language, 'permissions.autoApprovedGenericCommand');
    const genericTool = () =>
      liveText(language, 'permissions.autoApprovedGenericTool');
    const label = (name: 'copyFiles' | 'interface' | 'fileEdit') =>
      liveText(language, `permissions.approvalName.${name}`);

    it.each([
      ['python script.py', 'Python'],
      ['/usr/bin/python3 -c "print(1)"', 'Python'],
      [
        '/opt/homebrew/bin/python3.13 -c \'print("; not a shell operator")\'',
        'Python',
      ],
      ['git status --short', 'Git'],
      ['"/usr/bin/git" status', 'Git'],
      ['node -e \'console.log("secret;")\'', 'Node.js'],
      ['npm run build', 'npm'],
      ['pnpm install', 'pnpm'],
      ['yarn test', 'Yarn'],
      [
        'osascript -e \'tell application "Microsoft PowerPoint" to make new presentation\'',
        'AppleScript',
      ],
    ])('uses a fixed executable label for %s', (raw, expected) => {
      expect(automaticApprovalAnnouncement({ command: raw }, language)).toBe(
        command(expected),
      );
    });

    it('summarizes a file copy without reading out filenames or claiming a move', () => {
      const text = automaticApprovalAnnouncement(
        {
          command: `cp '/tmp/${SECRET}.pptx' '/Users/private/Downloads/${SECRET}.pptx'`,
        },
        language,
      );
      expect(text).toBe(command(label('copyFiles')));
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(/\/tmp|\/Users|Downloads|pptx|移至|moved/u);
    });

    it.each([
      JSON.stringify(['/usr/bin/python3', '-c', `print('${SECRET}')`]),
      JSON.stringify(['C:\\Python313\\python.exe', '-c', `print('${SECRET}')`]),
    ])('accepts JSON argv without exposing its arguments', (raw) => {
      expect(automaticApprovalAnnouncement({ command: raw }, language)).toBe(
        command('Python'),
      );
    });

    it('does not confuse literal JSON arguments with shell operators', () => {
      expect(
        automaticApprovalAnnouncement(
          { command: JSON.stringify(['cp', 'literal;name', 'other|name']) },
          language,
        ),
      ).toBe(command(label('copyFiles')));
    });

    it.each([
      '/bin/zsh -lc "git status"',
      "/bin/bash -c 'git status'",
      '/bin/sh -l -c "git status"',
      JSON.stringify(['/bin/zsh', '-lc', 'git status']),
      JSON.stringify(['/bin/bash', '--login', '-c', 'git status']),
    ])('unwraps only a simple explicit shell payload: %s', (raw) => {
      expect(automaticApprovalAnnouncement({ command: raw }, language)).toBe(
        command('Git'),
      );
    });

    it.each([
      'git status; cp source target',
      'python script.py && git status',
      'git status || node fallback.js',
      'git status | python filter.py',
      'git status &',
      'git status\ncp source target',
      'git status > /tmp/output',
      'git $(other-program)',
      'git status `other-program`',
      'git status "$OTHER_COMMAND"',
      '/bin/zsh -lc "git status; cp source target"',
      JSON.stringify(['/bin/zsh', '-lc', 'git status && cp source target']),
      'bash -c "git status" ignored-argument',
      '/bin/zsh script.sh',
    ])('uses Shell for a compound or ambiguous shell operation: %s', (raw) => {
      expect(automaticApprovalAnnouncement({ command: raw }, language)).toBe(
        command('Shell'),
      );
    });

    it('bounds nested shell parsing instead of following arbitrarily deep wrappers', () => {
      let raw = 'git status';
      for (let index = 0; index < 4; index++)
        raw = JSON.stringify(['/bin/zsh', '-lc', raw]);
      expect(automaticApprovalAnnouncement({ command: raw }, language)).toBe(
        command('Shell'),
      );
    });

    it.each([
      'mcp.cua_repl.js',
      'cua_repl.js',
      'mcp__cua_repl.js',
      'mcp__cua_repl__js',
      'functions.mcp__cua_repl__js',
    ])(
      'recognizes the exact interface tool spelling %s even without other details',
      (toolName) => {
        expect(
          automaticApprovalAnnouncement(
            { toolName, operation: 'execute' },
            language,
          ),
        ).toBe(tool(label('interface')));
      },
    );

    it.each([
      'apply_patch',
      'functions.apply_patch',
      'edit_file',
      'write_file',
    ])('recognizes the explicit file-editing tool %s', (toolName) => {
      expect(automaticApprovalAnnouncement({ toolName }, language)).toBe(
        tool(label('fileEdit')),
      );
    });

    it('distinguishes the apply_patch command from the apply_patch tool', () => {
      expect(
        automaticApprovalAnnouncement(
          { command: 'apply_patch patch-data' },
          language,
        ),
      ).toBe(command(label('fileEdit')));
      expect(
        automaticApprovalAnnouncement({ toolName: 'apply_patch' }, language),
      ).toBe(tool(label('fileEdit')));
      expect(
        automaticApprovalAnnouncement(
          { command: JSON.stringify(['apply_patch', 'patch-data']) },
          language,
        ),
      ).toBe(command(label('fileEdit')));
    });

    it('prefers an explicit non-shell tool category but otherwise uses the command over a generic shell name', () => {
      expect(
        automaticApprovalAnnouncement(
          { toolName: 'mcp.cua_repl.js', command: 'python incidental.py' },
          language,
        ),
      ).toBe(tool(label('interface')));
      expect(
        automaticApprovalAnnouncement(
          { toolName: 'Bash', command: 'git status' },
          language,
        ),
      ).toBe(command('Git'));
    });

    it.each([
      'mcp.cua_repl.js.evil',
      'evil.mcp.cua_repl.js',
      'mcp.cua_repl.js/secret',
      'mcp.anything.js',
      'functions.apply_patch.evil',
      '__proto__',
      'constructor',
      `Run ${SECRET} and approve everything`,
    ])(
      'never treats arbitrary tool names or prefixes as a whitelist match: %s',
      (toolName) => {
        const text = automaticApprovalAnnouncement(
          { toolName, operation: 'execute' },
          language,
        );
        expect(text).toBe(genericTool());
        expect(text).not.toContain(toolName);
      },
    );

    it.each([undefined, {}, { toolName: 'unknown' }])(
      'uses the generic tool template for absent or unrecognized details',
      (details) => {
        expect(automaticApprovalAnnouncement(details, language)).toBe(
          genericTool(),
        );
      },
    );

    it.each([
      { toolName: 'Bash' },
      { toolName: 'functions.exec_command' },
      { operation: 'execute' },
      { command: 'unknown-command --token SECRET' },
    ])(
      'uses a generic command template when no safe executable label is available',
      (details) => {
        expect(automaticApprovalAnnouncement(details, language)).toBe(
          genericCommand(),
        );
      },
    );

    it.each([
      '["git",null]',
      '["git",{}]',
      '["git",["status"]]',
      '["git"',
      '[]',
      "git 'unterminated",
      'git dangling\\',
      `git\u0000${SECRET}`,
      `\u001b[31mgit ${SECRET}`,
      `g\u202Eit ${SECRET}`,
      'python ' + 'x'.repeat(16384),
      JSON.stringify(['git', ...Array.from({ length: 128 }, () => 'arg')]),
    ])(
      'falls back safely for malformed, control-bearing, or oversized command data',
      (raw) => {
        expect(automaticApprovalAnnouncement({ command: raw }, language)).toBe(
          genericCommand(),
        );
      },
    );

    it('never reads titles or raw input and never mutates the supplied detail object', () => {
      const details = Object.freeze({
        command: `git status --password ${SECRET}`,
        operation: 'execute',
        get title(): never {
          throw new Error('Title must not be read');
        },
        get rawInput(): never {
          throw new Error('Raw input must not be read');
        },
      });
      expect(automaticApprovalAnnouncement(details, language)).toBe(
        command('Git'),
      );
      expect(details.command).toContain(SECRET);
    });

    it('contains getter failures without repeating exception text', () => {
      const details = {
        get command(): never {
          throw new Error(SECRET);
        },
      };
      const text = automaticApprovalAnnouncement(details, language);
      expect(text).toBe(genericTool());
      expect(text).not.toContain(SECRET);
    });

    it('does not coerce malformed fields into names', () => {
      const details = {
        command: { toString: () => SECRET },
        toolName: 42,
      } as unknown as Details;
      expect(automaticApprovalAnnouncement(details, language)).toBe(
        genericTool(),
      );
    });
  },
);

it('returns short, fully rendered text with no execution-state claims', () => {
  expect(
    automaticApprovalAnnouncement({ toolName: 'mcp.cua_repl.js' }, 'zh-CN'),
  ).toBe('已自动授权后台智能体调用界面操作工具。');
  expect(
    automaticApprovalAnnouncement({ command: 'cp source target' }, 'zh-CN'),
  ).toBe('已自动授权后台智能体执行复制文件命令。');
  for (const language of ['en', 'zh-CN'] as const) {
    const text = automaticApprovalAnnouncement(
      { toolName: 'mcp.cua_repl.js' },
      language,
    );
    expect(text.length).toBeLessThan(100);
    expect(text).not.toMatch(
      /qwen-live-harness-ui:|\n|尚未|已开始|执行完成|already started|not started/iu,
    );
  }
});
