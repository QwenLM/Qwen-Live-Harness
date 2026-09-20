/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PermissionDetails } from '../adaptor/types.js';
import { liveText } from '../i18n/messages.js';

type Language = 'en' | 'zh-CN';
type Label =
  | 'Python'
  | 'Git'
  | 'AppleScript'
  | 'Node.js'
  | 'npm'
  | 'pnpm'
  | 'Yarn'
  | 'Shell'
  | 'copyFiles'
  | 'interface'
  | 'fileEdit';
type Category = { kind: 'command' | 'tool'; label?: Label };

const MAX_COMMAND_CHARS = 16_384;
const MAX_ARGUMENTS = 128;
const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'pwsh',
  'powershell',
]);
const SHELL_TOOLS = new Set([
  'bash',
  'shell',
  'shell_command',
  'run_shell_command',
  'execute_command',
  'exec_command',
  'functions.exec_command',
  'terminal',
]);
const NON_SHELL_TOOLS = new Map<string, Label>([
  ['cua_repl.js', 'interface'],
  ['mcp.cua_repl.js', 'interface'],
  ['mcp__cua_repl.js', 'interface'],
  ['mcp__cua_repl__js', 'interface'],
  ['functions.mcp__cua_repl__js', 'interface'],
  ['apply_patch', 'fileEdit'],
  ['functions.apply_patch', 'fileEdit'],
  ['edit_file', 'fileEdit'],
  ['write_file', 'fileEdit'],
]);
const COMMANDS = new Map<string, Label>([
  ['git', 'Git'],
  ['osascript', 'AppleScript'],
  ['cp', 'copyFiles'],
  ['node', 'Node.js'],
  ['nodejs', 'Node.js'],
  ['npm', 'npm'],
  ['pnpm', 'pnpm'],
  ['yarn', 'Yarn'],
]);

function hasUnsafeControls(text: string): boolean {
  return /\p{C}/u.test(text.replace(/[\t\r\n]/gu, ''));
}

/** A bounded display lexer, not an execution parser or a security decision. */
function shellWords(
  text: string,
): { words: string[]; compound: boolean } | undefined {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | undefined;
  let compound = false;
  const flush = () => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else word += character;
      continue;
    }
    if (character === '\\') {
      const next = text[++index];
      if (next === undefined) return;
      // Shell line continuations do not introduce another command.
      if (next !== '\n') {
        word += next;
        started = true;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else {
        if (character === '$' || character === '`') compound = true;
        word += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === ' ' || character === '\t') flush();
    else {
      if (';&|<>()`$\r\n#'.includes(character)) compound = true;
      word += character;
      started = true;
    }
    if (words.length > MAX_ARGUMENTS) return;
  }
  if (quote) return;
  flush();
  return words.length > 0 && words.length <= MAX_ARGUMENTS
    ? { words, compound }
    : undefined;
}

function parseCommand(
  command: string,
): { words: string[]; compound: boolean } | undefined {
  if (
    !command ||
    command.length > MAX_COMMAND_CHARS ||
    hasUnsafeControls(command)
  )
    return;
  const text = command.trim();
  if (!text) return;
  if (text.startsWith('[')) {
    try {
      const value: unknown = JSON.parse(text);
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > MAX_ARGUMENTS ||
        !value.every(
          (entry) => typeof entry === 'string' && !hasUnsafeControls(entry),
        )
      )
        return;
      return { words: value, compound: false };
    } catch {
      return;
    }
  }
  return shellWords(text);
}

function commandCategory(command: string, depth = 0): Category {
  const parsed = parseCommand(command);
  if (!parsed) return { kind: 'command' };
  if (parsed.compound) return { kind: 'command', label: 'Shell' };
  const executable =
    parsed.words[0]
      ?.split(/[\\/]/u)
      .at(-1)
      ?.toLowerCase()
      .replace(/\.exe$/u, '') ?? '';
  if (SHELLS.has(executable)) {
    // Unwrap only an explicit, single -c/-lc payload, never positional args,
    // arbitrary flags, environment assignments, or an unbounded shell chain.
    let script: string | undefined;
    if (
      parsed.words.length === 3 &&
      ['-c', '-lc', '-cl'].includes(parsed.words[1]!)
    )
      script = parsed.words[2];
    else if (
      parsed.words.length === 4 &&
      ['-l', '--login'].includes(parsed.words[1]!) &&
      parsed.words[2] === '-c'
    )
      script = parsed.words[3];
    if (
      script &&
      depth < 3 &&
      ['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(executable)
    ) {
      const nested = commandCategory(script, depth + 1);
      return nested.label ? nested : { kind: 'command', label: 'Shell' };
    }
    return { kind: 'command', label: 'Shell' };
  }
  if (/^python(?:[23](?:\.\d{1,2})?)?$/u.test(executable))
    return { kind: 'command', label: 'Python' };
  if (executable === 'apply_patch')
    return { kind: 'command', label: 'fileEdit' };
  return {
    kind: 'command',
    ...(COMMANDS.has(executable) ? { label: COMMANDS.get(executable)! } : {}),
  };
}

function localizedLabel(label: Label, language: Language): string {
  if (label === 'copyFiles')
    return liveText(language, 'permissions.approvalName.copyFiles');
  if (label === 'interface')
    return liveText(language, 'permissions.approvalName.interface');
  if (label === 'fileEdit')
    return liveText(language, 'permissions.approvalName.fileEdit');
  return label;
}

/** Announces approval only. No raw titles, arguments, paths or names reach speech. */
export function automaticApprovalAnnouncement(
  details:
    Pick<PermissionDetails, 'command' | 'toolName' | 'operation'> | undefined,
  language: Language,
): string {
  let category: Category = { kind: 'tool' };
  try {
    const { command, toolName, operation } = details ?? {};
    const tool =
      typeof toolName === 'string' &&
      toolName.length <= 256 &&
      !/\p{C}/u.test(toolName)
        ? toolName.trim().toLowerCase()
        : '';
    const knownTool = NON_SHELL_TOOLS.get(tool);
    if (knownTool) category = { kind: 'tool', label: knownTool };
    else if (typeof command === 'string' && command.trim())
      category = commandCategory(command);
    else if (SHELL_TOOLS.has(tool) || (!tool && operation === 'execute'))
      category = { kind: 'command' };
  } catch {
    // Malformed objects/getters must never leak arbitrary exception text.
  }
  if (category.label)
    return liveText(
      language,
      category.kind === 'command'
        ? 'permissions.autoApprovedCommand'
        : 'permissions.autoApprovedTool',
      { name: localizedLabel(category.label, language) },
    );
  return liveText(
    language,
    category.kind === 'command'
      ? 'permissions.autoApprovedGenericCommand'
      : 'permissions.autoApprovedGenericTool',
  );
}
