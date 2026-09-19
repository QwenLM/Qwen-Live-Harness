/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isAcceptedTaskAdmission,
  isSuccessfulTaskAdmission,
  taskRequestKey,
} from './tool-confirmation.js';

describe('accepted task admission deduplication', () => {
  it.each(['web_search', 'handoff'])(
    'deduplicates %s acceptance with extra result data without authorizing audio suppression',
    (name) => {
      const accepted =
        name === 'web_search'
          ? { status: 'accepted', taskId: 'search:1' }
          : { status: 'queued', job: 'job_1', session: 'session_1' };
      for (const extra of [
        { note: 'Images could not be sent.' },
        { answer: 'A partial answer.' },
        { warning: 'Some inputs were unavailable.' },
        { result: { partial: true } },
        { error: 'One nonfatal step failed after acceptance.' },
      ]) {
        const output = JSON.stringify({ ...accepted, ...extra });
        expect(isAcceptedTaskAdmission(name, output)).toBe(true);
        expect(isSuccessfulTaskAdmission(name, output)).toBe(false);
      }
    },
  );

  it('does not deduplicate rejected, incomplete, malformed or delivery-only receipts', () => {
    const outputs = [
      'not JSON',
      'null',
      '[]',
      '"accepted"',
      JSON.stringify({
        status: 'error',
        job: 'job_1',
        session: 'session_1',
        taskId: 'search:1',
      }),
      JSON.stringify({
        status: 'rejected',
        job: 'job_1',
        session: 'session_1',
        taskId: 'search:1',
      }),
      JSON.stringify({ status: 'accepted' }),
      JSON.stringify({
        status: 'accepted',
        job: '',
        session: 'session_1',
        taskId: '',
      }),
      JSON.stringify({
        status: 'accepted',
        job: 'job_1',
        session: ['session_1'],
        taskId: 1,
      }),
    ];
    for (const name of ['web_search', 'handoff']) {
      for (const output of outputs)
        expect(
          isAcceptedTaskAdmission(name, output, { taskAdmission: true }),
        ).toBe(false);
    }
    expect(
      isAcceptedTaskAdmission(
        'handoff',
        JSON.stringify({
          status: 'accepted',
          job: 'job_1',
          session: 'session_1',
          delivery: 'delivery_1',
        }),
      ),
    ).toBe(false);
  });

  it('requires trusted Proactive metadata and never applies it to other tools', () => {
    for (const name of ['create_proactive_monitor', 'create_live_narration']) {
      expect(isAcceptedTaskAdmission(name, '提醒任务已创建。')).toBe(false);
      expect(
        isAcceptedTaskAdmission(name, '提醒任务已创建。', {
          taskAdmission: true,
        }),
      ).toBe(true);
      expect(isAcceptedTaskAdmission(name, '', { taskAdmission: true })).toBe(
        false,
      );
    }
    for (const name of [
      'session_create',
      'create_proactive_timer',
      'update_proactive_task',
      'cancel_proactive_task',
      'memory_update',
    ]) {
      expect(
        isAcceptedTaskAdmission(name, '{"status":"accepted"}', {
          taskAdmission: true,
        }),
      ).toBe(false);
    }
  });
});

describe('receipt continuation task request identity', () => {
  it('normalizes JSON whitespace and top-level argument key order', () => {
    expect(
      taskRequestKey(
        'handoff',
        '{"task":"Fix the test","session":"session_1"}',
      ),
    ).toBe(
      taskRequestKey(
        'handoff',
        '{\n "session": "session_1", "task": "Fix the test"\n}',
      ),
    );
    expect(taskRequestKey('web_search', '{"query":"Current weather"}')).toBe(
      taskRequestKey('web_search', ' { "query" : "Current weather" } '),
    );
    expect(taskRequestKey('create_live_narration', '{}')).toBeDefined();
  });

  it('keeps tool name, query, task and target session distinct', () => {
    const requests = [
      ['web_search', '{"query":"Weather in Beijing"}'],
      ['web_search', '{"query":"Weather in Singapore"}'],
      ['web_search', '{"query":" Weather in Beijing "}'],
      ['web_search', '{"query":"Weather in Beijing","other":null}'],
      ['handoff', '{"query":"Weather in Beijing"}'],
      ['handoff', '{"task":"Fix A","session":"session_1"}'],
      ['handoff', '{"task":"Fix B","session":"session_1"}'],
      ['handoff', '{"task":"Fix A","session":"session_2"}'],
    ];
    const keys = requests.map(([name, args]) => taskRequestKey(name!, args!));
    expect(keys).not.toContain(undefined);
    expect(new Set(keys).size).toBe(requests.length);
  });

  it('preserves arrays, nested values, primitive types and string contents', () => {
    const requests = [
      '{"input_refs":["asset_1","asset_2"]}',
      '{"input_refs":["asset_2","asset_1"]}',
      '{"input_refs":"asset_1,asset_2"}',
      '{"repeat":true}',
      '{"repeat":"true"}',
      '{"repeat":1}',
      '{"repeat":null}',
      '{"nested":{"value":"first"}}',
      '{"nested":{"value":"second"}}',
    ];
    const keys = requests.map((args) => taskRequestKey('handoff', args));
    expect(keys).not.toContain(undefined);
    expect(new Set(keys).size).toBe(requests.length);
  });

  it.each(['', '{', 'not JSON', 'null', '[]', '[{}]', 'true', '1', '"task"'])(
    'does not deduplicate malformed or non-object arguments %j',
    (args) => expect(taskRequestKey('handoff', args)).toBeUndefined(),
  );
});

describe('successful task admission confirmation', () => {
  it('accepts only an acknowledged search task, not search results', () => {
    expect(
      isSuccessfulTaskAdmission(
        'web_search',
        JSON.stringify({ status: 'accepted', taskId: 'search:1' }),
      ),
    ).toBe(true);
    for (const receipt of [
      { status: 'completed', taskId: 'search:1', answer: 'The forecast.' },
      { status: 'ok', taskId: 'search:1' },
      { status: 'queued', taskId: 'search:1' },
      { status: 'error', taskId: 'search:1' },
      { status: 'accepted' },
      { status: 'accepted', taskId: '' },
      { status: 'accepted', taskId: ' \n ' },
      { status: 'accepted', taskId: 1 },
      { status: 'accepted', taskId: true },
      { status: 'accepted', taskId: ['search:1'] },
      { status: ['accepted'], taskId: 'search:1' },
    ]) {
      expect(
        isSuccessfulTaskAdmission('web_search', JSON.stringify(receipt), {
          taskAdmission: true,
        }),
      ).toBe(false);
    }
  });

  it.each(['accepted', 'queued'])(
    'accepts a managed %s task without warnings',
    (status) => {
      for (const extra of [{}, { note: '' }, { note: ' \n\t ' }]) {
        expect(
          isSuccessfulTaskAdmission(
            'handoff',
            JSON.stringify({
              status,
              job: 'job_1',
              session: 'session_1',
              ...extra,
            }),
          ),
        ).toBe(true);
      }
    },
  );

  it('keeps rejected, incomplete, terminal-delivery and warning receipts audible', () => {
    const accepted = { status: 'accepted', job: 'job_1', session: 'session_1' };
    for (const extra of [
      { status: 'rejected' },
      { status: 'error' },
      { status: 'cancelled' },
      { status: 'pending' },
      { status: 'completed' },
      { job: '' },
      { job: ' \n ' },
      { job: 1 },
      { job: null },
      { session: '' },
      { session: ['session_1'] },
      { delivery: 'delivery_1' },
      { delivery: null },
      { delivery: false },
      { note: 'This session cannot take images; sent text only.' },
      { note: { warning: 'Not supported' } },
      { note: null },
      { note: false },
    ]) {
      expect(
        isSuccessfulTaskAdmission(
          'handoff',
          JSON.stringify({ ...accepted, ...extra }),
          { taskAdmission: true },
        ),
      ).toBe(false);
    }
    for (const receipt of [
      { status: 'accepted', session: 'session_1' },
      { status: 'queued', job: 'job_1' },
      { status: 'accepted', session: 'session_1', delivery: 'delivery_1' },
    ]) {
      expect(
        isSuccessfulTaskAdmission('handoff', JSON.stringify(receipt)),
      ).toBe(false);
    }
  });

  it.each(['web_search', 'handoff'])(
    'keeps partial answers, errors and unknown fields audible in accepted %s receipts',
    (name) => {
      const accepted =
        name === 'web_search'
          ? { status: 'accepted', taskId: 'search:1' }
          : { status: 'accepted', job: 'job_1', session: 'session_1' };
      for (const extra of [
        { answer: 'The current temperature is 20 degrees; more follows.' },
        { result: { temperature: 20 } },
        { warning: 'Some sources were unavailable.' },
        { error: 'The operation did not start.' },
        { note: 'The query was changed to omit inaccessible sources.' },
        { pending_permission: { request_id: 'permission_1' } },
        { metadata: {} },
        { answer: null },
        { warning: '' },
      ]) {
        expect(
          isSuccessfulTaskAdmission(
            name,
            JSON.stringify({ ...accepted, ...extra }),
            { taskAdmission: true },
          ),
        ).toBe(false);
      }
    },
  );

  it.each(['create_proactive_monitor', 'create_live_narration'])(
    'requires trusted local admission metadata for %s localized prose',
    (name) => {
      for (const output of [
        '提醒任务已创建。',
        'The monitor is starting.',
        '{"committed":true}',
      ]) {
        expect(isSuccessfulTaskAdmission(name, output)).toBe(false);
        expect(
          isSuccessfulTaskAdmission(name, output, { taskAdmission: false }),
        ).toBe(false);
      }
      expect(
        isSuccessfulTaskAdmission(name, '提醒任务已创建。', {
          taskAdmission: true,
        }),
      ).toBe(true);
      expect(isSuccessfulTaskAdmission(name, '提醒任务未创建或修改。')).toBe(
        false,
      );
    },
  );

  it.each([
    'session_create',
    'create_proactive_timer',
    'update_proactive_task',
    'cancel_proactive_task',
    'list_proactive_tasks',
    'session_monitor',
    'session_list',
    'session_stop',
    'respond_permission',
    'memory_search',
    'memory_update',
    'appshot',
    'WEB_SEARCH',
    ' handoff ',
    '',
  ])('never treats %s as a silent admission', (name) => {
    expect(
      isSuccessfulTaskAdmission(
        name,
        JSON.stringify({
          status: 'accepted',
          taskId: 'search:1',
          job: 'job_1',
          session: 'session_1',
          committed: true,
        }),
        { taskAdmission: true },
      ),
    ).toBe(false);
  });

  it.each(['web_search', 'handoff'])(
    'fails open to audible output for malformed %s receipts',
    (name) => {
      for (const output of [
        'not JSON',
        '{',
        'null',
        'false',
        '1',
        '"accepted"',
        '[]',
        '[{"status":"accepted","taskId":"search:1","job":"job_1","session":"session_1"}]',
      ]) {
        expect(
          isSuccessfulTaskAdmission(name, output, { taskAdmission: true }),
        ).toBe(false);
      }
    },
  );

  it('never suppresses an absent receipt even with trusted admission metadata', () => {
    for (const name of [
      'web_search',
      'handoff',
      'create_proactive_monitor',
      'create_live_narration',
    ]) {
      for (const output of ['', ' \n\t ']) {
        expect(
          isSuccessfulTaskAdmission(name, output, { taskAdmission: true }),
        ).toBe(false);
      }
    }
  });
});
