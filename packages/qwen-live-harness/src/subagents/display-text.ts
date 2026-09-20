/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { liveMessage, type LiveMessageKey } from '../i18n/messages.js';
import type { SubagentTask } from './types.js';

const REPORT_NOTES: Readonly<Record<string, LiveMessageKey>> = {
  'The call ended before playback was confirmed.': 'display.report.callEnded',
  'Audio output was muted before this report could be announced.':
    'display.report.muted',
  'Audio output was muted before playback was confirmed.':
    'display.report.muted',
  'Audio output was muted when this report arrived.': 'display.report.muted',
  'Audio output was muted.': 'display.report.muted',
  'Managed task results are announced through backend events; this self-report is display-only.':
    'display.report.separateResult',
  'The response completed without playable audio.': 'display.report.noAudio',
  'The transport was replaced before this report was fully played.':
    'display.report.connectionChanged',
  'The user started speaking; this report will not replay automatically.':
    'display.report.userInterrupted',
  'The report response did not complete.': 'display.report.incomplete',
  'Playback was interrupted; this report will not replay automatically.':
    'display.report.interrupted',
};
const DELIVERY_NOTES: Readonly<Record<string, LiveMessageKey>> = {
  'No receipt arrived in time. The instruction may still be received; do not resend automatically.':
    'display.delivery.unconfirmed',
  'The send result is uncertain. The instruction may still be received; do not resend automatically.':
    'display.delivery.unconfirmed',
  'The call ended and receipt tracking stopped. Sent instructions were not cancelled.':
    'display.delivery.callEnded',
  'The voice call ended before the instruction was sent.':
    'display.delivery.notSentBeforeEnd',
  'The instruction could not be sent. Refresh the session list before trying again.':
    'display.delivery.notSent',
};
const MONITOR_ERRORS: Readonly<Record<string, LiveMessageKey>> = {
  'Maximum visual capture failures exceeded.': 'display.monitor.captureFailed',
  'Maximum monitor failures exceeded.': 'display.monitor.failed',
  'Proactive event exceeds the foreground response limit.':
    'display.monitor.eventTooLarge',
  'Updated monitor could not enter provisioning.':
    'display.monitor.setupFailed',
};
const NOTIFICATION_NOTES: Readonly<Record<string, LiveMessageKey>> = {
  'Notification speech was unavailable or interrupted.':
    'display.notification.unavailable',
  'Notification speech fallback could not be queued.':
    'display.notification.queueFailed',
  'Notification speech fallback was not delivered.':
    'display.notification.failed',
  'Audio output was muted before the notification was delivered.':
    'display.notification.muted',
  'A newer foreground response superseded the notification.':
    'display.notification.replaced',
};
const BACKEND_ERRORS: Readonly<Record<string, LiveMessageKey>> = {
  cancelled: 'subagents.cancelled',
  'the agent declined to continue the task': 'display.task.declined',
  'the task stopped early (token or turn limit); ask to continue it':
    'display.task.limitReached',
  'the turn ended unexpectedly': 'display.task.unexpectedEnd',
  'the task failed': 'display.task.failed',
};

function mapped(
  value: string,
  catalog: Readonly<Record<string, LiveMessageKey>>,
): string {
  const key = Object.hasOwn(catalog, value) ? catalog[value] : undefined;
  return key ? liveMessage(key) : value;
}

/** Display copies only: protocol receipts, logs and model context keep their text. */
export const reportNoteForDisplay = (value: string): string =>
  mapped(value, REPORT_NOTES);
export const deliveryNoteForDisplay = (value: string): string =>
  mapped(value, DELIVERY_NOTES);

function monitorErrorForDisplay(value: string): string {
  return value.startsWith('Monitor setup failed: ')
    ? liveMessage('display.monitor.setupFailed')
    : mapped(value, MONITOR_ERRORS);
}

/** Translate only our known fallback status text, not arbitrary task contents. */
export function subagentForDisplay(task: SubagentTask): SubagentTask {
  const statusText = (value: string): string => {
    if (task.kind === 'proactive' && task.status === 'failed')
      return monitorErrorForDisplay(value);
    if (
      task.kind === 'harness' &&
      ['failed', 'cancelled', 'interrupted'].includes(task.status)
    )
      return mapped(value, BACKEND_ERRORS);
    return value;
  };
  let activity = statusText(task.activity);
  if (task.kind === 'harness' && task.activity === 'running a tool')
    activity = liveMessage('display.task.runningTool');
  const fallbackOutput =
    task.kind === 'harness' &&
    ['failed', 'cancelled', 'interrupted'].includes(task.status)
      ? mapped(task.output, BACKEND_ERRORS)
      : task.output;
  const outputMessage =
    task.outputMessage ??
    (fallbackOutput !== task.output ? fallbackOutput : undefined);
  return {
    ...task,
    activity,
    ...(outputMessage ? { outputMessage } : {}),
    events: task.events.map((event) => ({
      ...event,
      text:
        event.kind === 'notification' && task.kind === 'proactive'
          ? mapped(event.text, NOTIFICATION_NOTES)
          : event.kind === 'status'
            ? outputMessage && event.text === task.output
              ? outputMessage
              : statusText(event.text)
            : event.kind === 'tool' &&
                task.kind === 'harness' &&
                event.text === 'running a tool'
              ? liveMessage('display.task.runningTool')
              : event.text,
    })),
  };
}
