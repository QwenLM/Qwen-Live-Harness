/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describePermissionDetails,
  describeToolCall,
  isRecord,
  redactPermissionText,
  stripControlSequences,
} from './adaptor-utils.js';
import type { BackendEvent, PermissionDetails } from './types.js';

export function publicActivity(
  update: Record<string, unknown>,
  jobRef?: string,
  sessionCwd?: string,
): Extract<BackendEvent, { type: 'activity' }> | undefined {
  const kind = update['sessionUpdate'];
  let activity: 'message' | 'plan' | 'tool';
  let text = '';
  let details: PermissionDetails | undefined;
  let toolStatus:
    'pending' | 'in_progress' | 'completed' | 'failed' | undefined;
  if (kind === 'agent_message_chunk') {
    const content = update['content'];
    if (!isRecord(content) || typeof content['text'] !== 'string') return;
    activity = 'message';
    text = content['text'];
  } else if (kind === 'plan') {
    if (!Array.isArray(update['entries'])) return;
    activity = 'plan';
    text = update['entries']
      .slice(0, 24)
      .flatMap((entry) => {
        if (!isRecord(entry) || typeof entry['content'] !== 'string') return [];
        const status = ['pending', 'in_progress', 'completed'].includes(
          String(entry['status']),
        )
          ? String(entry['status'])
          : 'pending';
        return [`[${status}] ${entry['content'].slice(0, 1024)}`];
      })
      .join('\n');
  } else if (kind === 'tool_call' || kind === 'tool_call_update') {
    activity = 'tool';
    details = describePermissionDetails(update, sessionCwd);
    const parts: string[] = [];
    if (details.command || details.toolName)
      parts.push(describeToolCall(update));
    else if (typeof update['title'] === 'string') parts.push(update['title']);
    if (
      ['pending', 'in_progress', 'completed', 'failed'].includes(
        String(update['status']),
      )
    ) {
      toolStatus = update['status'] as typeof toolStatus;
      parts.push(`[${String(update['status'])}]`);
    }
    if (Array.isArray(update['content'])) {
      for (const part of update['content'].slice(0, 24)) {
        if (!isRecord(part) || part['type'] !== 'content') continue;
        const content = part['content'];
        if (
          isRecord(content) &&
          content['type'] === 'text' &&
          typeof content['text'] === 'string'
        )
          parts.push(content['text']);
      }
    }
    text = parts.join('\n');
  } else return;
  text = stripControlSequences(redactPermissionText(text.slice(0, 8192))).slice(
    0,
    8192,
  );
  if (!text && !details?.toolCallId && !toolStatus) return;
  return {
    type: 'activity',
    kind: activity,
    text,
    ...(jobRef ? { jobRef } : {}),
    ...(details?.toolCallId ? { toolCallId: details.toolCallId } : {}),
    ...(toolStatus ? { toolStatus } : {}),
    ...(details && Object.keys(details).length ? { details } : {}),
  };
}
