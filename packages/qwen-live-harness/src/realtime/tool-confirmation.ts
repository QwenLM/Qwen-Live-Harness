/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export interface RealtimeFunctionOutputOptions {
  /**
   * Trusted local confirmation that a Proactive creation was committed.
   * Never derive this flag from model arguments or the rendered receipt text.
   * Omit it if the receipt is replaced by an error or otherwise changed.
   */
  taskAdmission?: boolean;
}

function nonblankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Exact task identity for a receipt continuation. Normalize only JSON layout
 * and top-level key order; never collapse different strings or array values.
 * The caller must still restrict deduplication to its own admitted tool batch.
 */
export function taskRequestKey(
  name: string,
  rawArguments: string,
): string | undefined {
  let args: unknown;
  try {
    args = JSON.parse(rawArguments);
  } catch {
    return undefined;
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return undefined;
  }
  const entries = Object.entries(args).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return JSON.stringify([name, entries]);
}

/**
 * Establishes accepted work solely to avoid executing its exact request twice.
 * Warnings or partial results still belong to accepted work and remain in the
 * original receipt. This predicate must never be used to suppress audio.
 */
export function isAcceptedTaskAdmission(
  name: string,
  output: string,
  options?: RealtimeFunctionOutputOptions,
): boolean {
  if (!nonblankString(output)) return false;
  if (name === 'create_proactive_monitor' || name === 'create_live_narration') {
    return options?.taskAdmission === true;
  }
  if (name !== 'web_search' && name !== 'handoff' && name !== 'appshot')
    return false;
  let receipt: unknown;
  try {
    receipt = JSON.parse(output);
  } catch {
    return false;
  }
  if (
    receipt === null ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt)
  ) {
    return false;
  }
  const result = receipt as Record<string, unknown>;
  if (name === 'web_search' || name === 'appshot') {
    return result['status'] === 'accepted' && nonblankString(result['taskId']);
  }
  return (
    (result['status'] === 'accepted' || result['status'] === 'queued') &&
    nonblankString(result['job']) &&
    nonblankString(result['session']) &&
    !Object.hasOwn(result, 'delivery')
  );
}

/**
 * Classifies only successful asynchronous task admission, not task completion.
 * A true result alone does not authorize muting: the caller must also verify
 * that this is the matching receipt continuation, every sibling tool qualifies,
 * and the parent response already supplied its spoken preamble.
 */
export function isSuccessfulTaskAdmission(
  name: string,
  output: string,
  options?: RealtimeFunctionOutputOptions,
): boolean {
  if (!nonblankString(output)) return false;
  if (name === 'create_proactive_monitor' || name === 'create_live_narration') {
    // Proactive receipts are localized prose. Only the scheduler's committed
    // mutation can establish success; never guess by matching the prose.
    return options?.taskAdmission === true;
  }
  if (name !== 'web_search' && name !== 'handoff' && name !== 'appshot')
    return false;

  let receipt: unknown;
  try {
    receipt = JSON.parse(output);
  } catch {
    return false;
  }
  if (
    receipt === null ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt)
  ) {
    return false;
  }
  const result = receipt as Record<string, unknown>;
  if (name === 'appshot') {
    return (
      result['status'] === 'accepted' &&
      nonblankString(result['taskId']) &&
      Object.keys(result).every((key) =>
        [
          'status',
          'taskId',
          'source',
          'width',
          'height',
          'screen_scope',
          'display_id',
          'app',
          'window',
          'asset',
          'accessibility_text',
        ].includes(key),
      )
    );
  }
  if (name === 'web_search') {
    return (
      Object.keys(result).every(
        (key) => key === 'status' || key === 'taskId',
      ) &&
      result['status'] === 'accepted' &&
      nonblankString(result['taskId'])
    );
  }

  // Terminal instruction delivery is not an observed managed task. Notes may
  // disclose dropped images or other limitations and must remain audible.
  // Unknown fields may contain an answer or warning: fail open to speech.
  return (
    Object.keys(result).every((key) =>
      ['status', 'job', 'session', 'note'].includes(key),
    ) &&
    (result['status'] === 'accepted' || result['status'] === 'queued') &&
    nonblankString(result['job']) &&
    nonblankString(result['session']) &&
    !Object.hasOwn(result, 'delivery') &&
    (!Object.hasOwn(result, 'note') ||
      (typeof result['note'] === 'string' && result['note'].trim() === ''))
  );
}
