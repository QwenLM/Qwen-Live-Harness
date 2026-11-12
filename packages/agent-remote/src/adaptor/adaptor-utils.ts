/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers shared by every BackendAdaptor: wire-shape munging that both the
 * qwen serve adaptor and the ACP adaptor need — permission-option
 * classification, tool-call title text, and clamped summaries. Extracted
 * from qwen-code-adaptor.ts verbatim; keep both adaptors importing from
 * here rather than re-deriving the rules.
 */

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { PermissionDetails, PermissionOption } from './types.js';

export type PermissionOptionKind = PermissionOption['kind'];

export const MAX_SUMMARY_CHARS = 4_000;
export const MAX_DETAIL_CHARS = 48_000;
const MAX_PERMISSION_INPUT_CHARS = 16_384;
const SENSITIVE_PERMISSION_KEY =
  /api[_-]?key|private[_-]?key|access[_-]?key|token|password|passwd|secret|authorization|cookie|credential/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map one wire permission option to the adaptor's kind + escalation.
 *
 * Both qwen serve and ACP stamp every option with the structured `kind`
 * (`allow_once` | `allow_always` | `reject_once` | `reject_always` — see
 * `toPermissionOptions` in packages/cli acp-integration/permissionUtils.ts);
 * that is authoritative when present. An unknown structured kind fails
 * closed to 'other'. The word heuristics run only when the backend omitted
 * the field entirely.
 */
export function classifyOption(
  optionId: string,
  name: string | undefined,
  wireKind: string | undefined,
): { kind: PermissionOptionKind; escalation?: 'once' | 'always' } {
  switch (wireKind) {
    case 'allow_once':
      return { kind: 'proceed', escalation: 'once' };
    case 'allow_always':
      return { kind: 'proceed', escalation: 'always' };
    case 'reject_once':
      return { kind: 'reject', escalation: 'once' };
    case 'reject_always':
      return { kind: 'reject', escalation: 'always' };
    default:
      break;
  }
  // Fail closed: a structured kind we do not understand must not be votable
  // through a bare "allow"/"deny".
  if (wireKind !== undefined) return { kind: 'other' };
  // No structured kind at all: this is a generic/non-qwen agent (the
  // target of this PR). Word heuristics over free-form labels can be
  // inverted by negation ("Do not allow" → proceed), so fail closed
  // rather than guess — the spoken ask surfaces the title for the user
  // to decide.
  return { kind: 'other' };
}

/** Preserve the backend's declared scope, never invent one from an option id. */
export function describePersistentScope(
  name: string | undefined,
  wireKind: string | undefined,
): string | undefined {
  if (wireKind !== 'allow_always' || !name || name.length > 1024) return;
  const label = sanitizeTitleLine(redactPermissionText(name));
  if (label.includes('[REDACTED]')) return;
  // ACP has no machine-readable scope. These labels disclose actual breadth;
  // generic "Always allow" is deliberately not represented as a scoped grant.
  if (
    /\b(?:in (?:this |the )?(?:project|workspace)|for (?:this |the )?(?:command|tool|user|session)|all (?:edits|commands|tools|files)|(?:project|workspace|user)[ -]wide)\b/i.test(
      label,
    ) ||
    /(?:本|此|当前)(?:项目|工作区|命令|工具|会话)|所有(?:编辑|命令|工具|文件)/u.test(
      label,
    )
  )
    return label;
  return;
}

/**
 * The narrowest option of the wanted kind. A bare voice "allow" must take
 * the one-shot grant, never persist an always-allow rule (serve offers
 * [proceed_always_project, proceed_always_user, proceed_once, cancel] —
 * first-match would pick the project-wide rule).
 */
export function pickLeastEscalating(
  options: readonly PermissionOption[],
  wanted: PermissionOptionKind,
): PermissionOption | undefined {
  const rank = (option: PermissionOption): number =>
    option.escalation === 'once' ? 0 : option.escalation === undefined ? 1 : 2;
  let best: PermissionOption | undefined;
  for (const candidate of options) {
    if (candidate.kind !== wanted) continue;
    if (wanted === 'proceed' && candidate.escalation === 'always') continue;
    if (best === undefined || rank(candidate) < rank(best)) best = candidate;
  }
  return best;
}

/**
 * The broadest persistent grant of the wanted kind, or undefined when the
 * backend offered none.
 *
 * Only a deliberate "allow always" reaches this. Agents advertise the
 * always-options narrowest first (qwen-code offers
 * [ProceedAlwaysProject, ProceedAlwaysUser, ...] for exec, so project
 * scope precedes machine-wide user scope), and ACP gives no other signal
 * to rank two `allow_always` entries by, so offer order is the tiebreak
 * and the FIRST match wins. An agent that omits always-options entirely
 * (qwen-code hides them under `forceHideAlwaysAllow`) yields undefined and
 * the caller must fall back to a one-shot grant rather than cancel.
 */
export function pickPersistentGrant(
  options: readonly PermissionOption[],
  wanted: PermissionOptionKind,
): PermissionOption | undefined {
  return options.find(
    (option) => option.kind === wanted && option.escalation === 'always',
  );
}

/**
 * Compose display-only permission text. Control sequences and credentials
 * must not reach the UI or spoken ask. Authority is based on separate
 * structured facts, never this sanitized title.
 */
export function describeToolCall(toolCall: unknown): string {
  if (!isRecord(toolCall)) return 'a tool call';
  const details = describePermissionDetails(toolCall);
  const name = stripControlSequences(details.toolName ?? '');
  const command = details.command ?? '';
  const title = typeof toolCall['title'] === 'string' ? toolCall['title'] : '';
  const detail = stripControlSequences(
    redactPermissionText((command || title).slice(0, 8192)),
  );
  if (name && detail) return `${name}: ${detail}`;
  return name || detail || 'a tool call';
}

/** Redact credential syntax, without normalizing the other command bytes. */
export function redactPermissionText(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[^\s'";]+/gi, '$1 [REDACTED]')
    .replace(
      /((?:--)?\b[\w-]{0,64}(?:api[_-]?key|private[_-]?key|access[_-]?key|token|password|passwd|secret|authorization|cookie|credential)[\w-]{0,64}["']?\s*(?:=|:|\s)\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      '[REDACTED]',
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

/**
 * Bounded untrusted operation facts, kept separately from the display title.
 * Whitespace/quoting is significant: exact-action matching must never use a
 * sanitized title. Redaction or loss of input is explicitly marked incomplete.
 */
export function describePermissionDetails(
  toolCall: unknown,
  sessionCwd?: string,
): PermissionDetails {
  if (!isRecord(toolCall)) return {};
  let incomplete = false;
  let budget = MAX_PERMISSION_INPUT_CHARS;
  const string = (value: unknown, max = 8192): string | undefined => {
    if (typeof value !== 'string' || value.length === 0) return;
    if (value.length > max) {
      incomplete = true;
      return;
    }
    const redacted = redactPermissionText(value);
    if (redacted !== value) incomplete = true;
    return redacted;
  };
  const displayString = (value: unknown, max: number): string | undefined => {
    const exact = string(value, max);
    if (exact === undefined) return;
    const display = sanitizeTitleLine(exact);
    if (display !== exact) incomplete = true;
    return display || undefined;
  };
  const followsSecretFlag = (value: unknown[], index: number): boolean => {
    const previous = value[index - 1];
    return (
      typeof previous === 'string' &&
      /^--?[\w-]+$/.test(previous) &&
      SENSITIVE_PERMISSION_KEY.test(previous)
    );
  };
  const seen = new Set<object>();
  const snapshot = (value: unknown, depth = 0): unknown => {
    if (budget <= 0 || depth > 6) {
      incomplete = true;
      return '[OMITTED]';
    }
    if (typeof value === 'string') {
      budget -= value.length;
      if (budget < 0) {
        incomplete = true;
        return '[OMITTED]';
      }
      const redacted = redactPermissionText(value);
      if (redacted !== value) incomplete = true;
      return redacted;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || !value || seen.has(value)) {
      incomplete = true;
      return '[OMITTED]';
    }
    seen.add(value);
    const entries = Array.isArray(value)
      ? value.slice(0, 65).map((item, index) => [String(index), item] as const)
      : Object.entries(value);
    if (entries.length > 64) incomplete = true;
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const [key, child] of entries.slice(0, 64)) {
      budget -= key.length + 4;
      if (budget <= 0) {
        incomplete = true;
        break;
      }
      if (
        SENSITIVE_PERMISSION_KEY.test(key) ||
        (Array.isArray(value) && followsSecretFlag(value, Number(key)))
      ) {
        result[key] = '[REDACTED]';
        incomplete = true;
      } else result[key] = snapshot(child, depth + 1);
    }
    seen.delete(value);
    return Array.isArray(value) ? Object.values(result) : result;
  };
  const raw =
    toolCall['rawInput'] ?? toolCall['input'] ?? toolCall['arguments'];
  let input = raw;
  if (typeof raw === 'string' && raw.length <= MAX_PERMISSION_INPUT_CHARS) {
    try {
      input = JSON.parse(raw) as unknown;
    } catch {
      /* Opaque input remains opaque. */
    }
  }
  const record = isRecord(input) ? input : {};
  const toolCallId = string(toolCall['toolCallId'] ?? toolCall['id'], 256);
  const toolName = displayString(toolCall['name'] ?? toolCall['toolName'], 256);
  const rawCommand = toolCall['command'] ?? record['command'] ?? record['cmd'];
  let command: string | undefined;
  if (Array.isArray(rawCommand)) {
    if (
      rawCommand.length <= 64 &&
      rawCommand.every(
        (part) => typeof part === 'string' && part.length <= 8192,
      )
    ) {
      const argv = rawCommand.map((part, index) => {
        if (followsSecretFlag(rawCommand, index)) {
          incomplete = true;
          return '[REDACTED]';
        }
        return part === '' ? '' : string(part);
      });
      // JSON displays argv boundaries faithfully; never pretend it is a shell
      // command. The original array remains in rawInput for policy hashing.
      command = string(JSON.stringify(argv));
    } else incomplete = true;
  } else command = string(rawCommand);
  const operation = displayString(
    toolCall['operation'] ?? record['operation'] ?? toolCall['kind'],
    256,
  );
  const reportedCwd = string(
    toolCall['cwd'] ??
      record['cwd'] ??
      record['workdir'] ??
      record['working_directory'],
    4096,
  );
  let cwd = reportedCwd ?? string(sessionCwd, 4096);
  let cwdVerified = false;
  try {
    if (sessionCwd && isAbsolute(sessionCwd)) {
      const trusted = realpathSync(sessionCwd);
      const candidate = reportedCwd
        ? realpathSync(resolve(trusted, reportedCwd))
        : trusted;
      if (statSync(trusted).isDirectory() && candidate === trusted) {
        cwd = trusted;
        cwdVerified = true;
      }
    }
  } catch {
    /* A missing/non-local path is a fact, not a verified grant scope. */
  }
  const resources: string[] = [];
  let resourceBudget = 8192;
  const addResource = (value: unknown): void => {
    const path = string(value, 4096);
    if (path && !resources.includes(path)) {
      resourceBudget -= path.length;
      if (resources.length >= 24 || resourceBudget < 0) incomplete = true;
      else resources.push(path);
    }
  };
  for (const key of [
    'path',
    'file_path',
    'filePath',
    'directory',
    'source',
    'destination',
  ])
    addResource(record[key]);
  const locations = toolCall['locations'];
  if (Array.isArray(locations)) {
    if (locations.length > 24) incomplete = true;
    for (const location of locations.slice(0, 24))
      if (isRecord(location)) addResource(location['path']);
  }
  let rawInput = raw === undefined ? undefined : snapshot(input);
  if (
    rawInput !== undefined &&
    JSON.stringify(rawInput).length > MAX_PERMISSION_INPUT_CHARS
  ) {
    rawInput = undefined;
    incomplete = true;
  }
  // A legacy top-level command can omit environment/other execution inputs.
  // Keep it useful for display, but never claim that it is an exact action.
  if (raw === undefined && (command || operation || resources.length))
    incomplete = true;
  const metadataKeys = new Set([
    'toolCallId',
    'id',
    'name',
    'toolName',
    'title',
    'kind',
    'status',
    'content',
    'locations',
    'rawInput',
    'rawOutput',
    'command',
    'operation',
    'cwd',
    'input',
    'arguments',
    'sessionUpdate',
  ]);
  if (Object.keys(toolCall).some((key) => !metadataKeys.has(key)))
    incomplete = true;
  if (
    toolCall['command'] !== undefined &&
    record['command'] !== undefined &&
    toolCall['command'] !== record['command']
  )
    incomplete = true;
  const details: PermissionDetails = {
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(command ? { command } : {}),
    ...(rawInput !== undefined ? { rawInput } : {}),
    ...(cwd ? { cwd, cwdVerified } : {}),
    ...(operation ? { operation } : {}),
    ...(resources.length ? { resources } : {}),
    ...(incomplete ? { incomplete: true } : {}),
  };
  return JSON.stringify(details).length > MAX_DETAIL_CHARS
    ? { ...(toolCallId ? { toolCallId } : {}), incomplete: true }
    : details;
}

/**
 * Remove terminal control sequences without the first-line cut that
 * sanitizeTitleLine applies, so multi-line display text stays readable.
 * Mirrors the same sequence families (OSC, CSI, SS2/SS3/DCS, C0/DEL/C1).
 */
export function stripControlSequences(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[NOP]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ' ')
  );
}

/**
 * Slice the last `max` UTF-16 units, snapping the cut off a split surrogate
 * pair: a cut landing between the halves would lead with a lone low
 * surrogate that renders/speaks as U+FFFD.
 */
export function tailSlice(text: string, max: number): string {
  let start = text.length - max;
  const unit = text.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff) start += 1;
  return text.slice(start);
}

export function clampTail(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `…${tailSlice(trimmed, max)}`;
}

/**
 * One clean line for a tool-call title: first line only, terminal control
 * sequences stripped. Minimal inline of core's stripTerminalControlSequences
 * (packages/core utils/terminalSafe.ts) — the monolith's voice consumer
 * applied the same guard before titles reached the realtime model
 * (live-session-coordinator.ts), and neither acp-bridge nor the daemon
 * sanitizes upstream.
 */
export function sanitizeTitleLine(title: string): string {
  const firstLine = title.split(/\r?\n/, 1)[0] ?? '';
  return (
    firstLine
      // OSC: ESC ] ... (BEL | ST)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      // CSI: ESC [ params intermediates final
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // SS2/SS3/DCS leaders
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[NOP]/g, '')
      // Remaining C0 controls + DEL + C1 controls
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
      .trim()
  );
}
