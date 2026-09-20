import { describe, expect, it } from 'vitest';
import { displayLiveMessage, liveMessage, liveText } from '../i18n/messages.js';
import {
  deliveryNoteForDisplay,
  reportNoteForDisplay,
  subagentForDisplay,
} from './display-text.js';
import type { SubagentTask } from './types.js';

function task(overrides: Partial<SubagentTask> = {}): SubagentTask {
  return {
    id: 'fixture',
    kind: 'proactive',
    title: 'User title',
    request: 'User request',
    status: 'failed',
    createdAt: 1,
    updatedAt: 2,
    activity: '',
    output: '',
    events: [],
    ...overrides,
  };
}

describe('Subagents display-only text projection', () => {
  it('localizes owned report and instruction notes while keeping unknown text verbatim', () => {
    const report = 'The call ended before playback was confirmed.';
    const delivery =
      'The send result is uncertain. The instruction may still be received; do not resend automatically.';
    expect(reportNoteForDisplay(report)).toBe(
      liveMessage('display.report.callEnded'),
    );
    expect(deliveryNoteForDisplay(delivery)).toBe(
      liveMessage('display.delivery.unconfirmed'),
    );
    for (const language of ['en', 'zh-CN'] as const) {
      expect(displayLiveMessage(language, reportNoteForDisplay(report))).toBe(
        liveText(language, 'display.report.callEnded'),
      );
      expect(
        displayLiveMessage(language, deliveryNoteForDisplay(delivery)),
      ).toBe(liveText(language, 'display.delivery.unconfirmed'));
    }
    for (const raw of [
      'An external report note',
      '未知接收方内容',
      '__proto__',
      liveMessage('ui.settings'),
    ]) {
      expect(reportNoteForDisplay(raw)).toBe(raw);
      expect(deliveryNoteForDisplay(raw)).toBe(raw);
    }
  });

  it('localizes known monitor errors without changing stored errors, model summaries or user content', () => {
    const error = 'Monitor setup failed: provider-private-detail';
    const source = task({
      activity: error,
      output: 'Actual model observation',
      events: [
        { at: 1, kind: 'status', text: error },
        { at: 2, kind: 'observation', text: error },
      ],
    });
    const before = structuredClone(source);
    const shown = subagentForDisplay(source);
    expect(shown.activity).toBe(liveMessage('display.monitor.setupFailed'));
    expect(shown.events[0]?.text).toBe(shown.activity);
    expect(shown.events[1]?.text).toBe(error);
    expect(shown.output).toBe('Actual model observation');
    expect(shown).not.toHaveProperty('outputMessage');
    expect(source).toEqual(before);
    expect(shown.title).toBe(source.title);
    expect(shown.request).toBe(source.request);
    expect(
      subagentForDisplay(task({ status: 'monitoring', activity: error }))
        .activity,
    ).toBe(error);
  });

  it('localizes notification status events without translating observations or unknown explanations', () => {
    const reason = 'Notification speech fallback was not delivered.';
    const shown = subagentForDisplay(
      task({
        status: 'monitoring',
        events: [
          { at: 1, kind: 'notification', text: reason },
          { at: 2, kind: 'message', text: reason },
          { at: 3, kind: 'notification', text: 'Unknown external note' },
        ],
      }),
    );
    expect(shown.events.map((event) => event.text)).toEqual([
      liveMessage('display.notification.failed'),
      reason,
      'Unknown external note',
    ]);
  });

  it('separates an application search failure display message from the raw answer and event record', () => {
    const answer = liveText('en', 'runtime.webSearchFailed');
    const source = task({
      kind: 'search',
      output: answer,
      outputMessage: liveMessage('search.failed'),
      events: [
        { at: 1, kind: 'status', text: answer },
        { at: 2, kind: 'message', text: answer },
      ],
    });
    const shown = subagentForDisplay(source);
    expect(shown.output).toBe(answer);
    expect(shown.outputMessage).toBe(liveMessage('search.failed'));
    expect(shown.events[0]?.text).toBe(liveMessage('search.failed'));
    expect(shown.events[1]?.text).toBe(answer);
    expect(source.events[0]?.text).toBe(answer);
  });

  it('only maps known adapter fallback errors, never guesses an output marker from arbitrary backend text', () => {
    const source = task({
      kind: 'harness',
      activity: 'the task failed',
      output: 'the task failed',
    });
    const shown = subagentForDisplay(source);
    expect(shown.output).toBe('the task failed');
    expect(shown.outputMessage).toBe(liveMessage('display.task.failed'));
    const outside = task({
      kind: 'harness',
      activity: 'Backend-specific explanation',
      output: liveMessage('search.failed'),
    });
    expect(subagentForDisplay(outside)).toEqual(outside);
    expect(
      subagentForDisplay(
        task({
          kind: 'harness',
          status: 'running',
          activity: 'running a tool',
        }),
      ).activity,
    ).toBe(liveMessage('display.task.runningTool'));
  });
});
