/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SUBAGENTS_CONTROL_BYTES,
  MAX_DISCOVERED_SESSIONS,
  MAX_INSTRUCTION_DELIVERIES,
  INSTRUCTION_DELIVERY_STATUSES,
  MAX_SESSION_REPORTS,
  SESSION_REPORT_CATEGORIES,
  SESSION_REPORT_ANNOUNCEMENTS,
  parseSubagentsSnapshot,
  parseSubagentsControlRequest,
  parseSubagentsControlResult,
} from './types.js';

const task = {
  id: 'job:1',
  kind: 'harness',
  status: 'running',
  title: 'Task',
  request: 'Request',
  createdAt: 0,
  updatedAt: 0,
  activity: '',
  output: '',
  events: [],
};
const snapshot = {
  revision: 1,
  omitted: 0,
  counts: {
    running: 1,
    completed: 0,
    needsAttention: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
  },
  tasks: [task],
};
describe('subagent snapshot identity and value validation', () => {
  it('accepts independent delivery and report revisions without changing task counts', () => {
    expect(
      parseSubagentsSnapshot({ ...snapshot, deliveryRevision: 0 }),
    ).toBeDefined();
    expect(
      parseSubagentsSnapshot({ ...snapshot, deliveryRevision: 20 }),
    ).toMatchObject({
      revision: snapshot.revision,
      counts: snapshot.counts,
    });
    for (const deliveryRevision of [-1, 1.5, Infinity, '2'])
      expect(
        parseSubagentsSnapshot({ ...snapshot, deliveryRevision }),
      ).toBeUndefined();
    expect(
      parseSubagentsSnapshot({
        ...snapshot,
        deliveryRevision: 2,
        reportRevision: 10,
      }),
    ).toMatchObject({
      revision: snapshot.revision,
      counts: snapshot.counts,
      deliveryRevision: 2,
      reportRevision: 10,
    });
    for (const reportRevision of [-1, 0.5, Infinity, '1'])
      expect(
        parseSubagentsSnapshot({ ...snapshot, reportRevision }),
      ).toBeUndefined();
  });
  it('rejects coerced enums and duplicate task ids', () => {
    expect(parseSubagentsSnapshot(snapshot)).toBeDefined();
    for (const invalid of [
      { ...task, kind: ['harness'] },
      { ...task, notification: ['delivered'] },
      { ...task, events: [{ at: 0, text: 'x', kind: ['status'] }] },
    ])
      expect(
        parseSubagentsSnapshot({ ...snapshot, tasks: [invalid] }),
      ).toBeUndefined();
    expect(
      parseSubagentsSnapshot({
        ...snapshot,
        tasks: [task, { ...task, title: 'Other task' }],
      }),
    ).toBeUndefined();
  });
});

describe('subagent management contracts', () => {
  it('bounds session reports and rejects internal identifiers and malformed source or announcement states', () => {
    const report = {
      id: 'report_1',
      backend: 'qwen',
      source: 'Terminal',
      sourceStatus: 'matched',
      session: 'session_1',
      category: 'progress',
      text: 'Tests are running.',
      receivedAt: 100,
      updatedAt: 200,
      announcement: 'queued',
      note: 'Waiting for a pause',
    };
    const response = (fields: object) => ({
      type: 'page',
      page: { snapshot, offset: 0, total: 1, ...fields },
    });
    for (const category of SESSION_REPORT_CATEGORIES)
      for (const announcement of SESSION_REPORT_ANNOUNCEMENTS) {
        const result = response({
          sessionReports: [{ ...report, category, announcement }],
        });
        expect(parseSubagentsControlResult(result)).toEqual(result);
      }
    expect(
      parseSubagentsControlResult(
        response({
          sessionReports: [
            { ...report, sourceStatus: 'unconfirmed', session: undefined },
          ],
        }),
      ),
    ).toBeDefined();
    expect(
      parseSubagentsControlResult(
        response({ sessionReports: [], sessionReportsOmitted: 3 }),
      ),
    ).toBeDefined();
    const invalidRows = [
      { ...report, id: '' },
      { ...report, backend: 'x'.repeat(257) },
      { ...report, source: 'x'.repeat(241) },
      { ...report, sourceStatus: 'authenticated' },
      { ...report, session: 'x'.repeat(129) },
      { ...report, text: 'x'.repeat(2001) },
      { ...report, category: ['progress'] },
      { ...report, category: 'completed' },
      { ...report, receivedAt: -1 },
      { ...report, updatedAt: 99 },
      { ...report, announcement: ['announced'] },
      { ...report, announcement: 'delivered' },
      { ...report, note: 'x'.repeat(1025) },
      { ...report, msgId: 'transport-id' },
      { ...report, token: 'secret' },
      { ...report, socketPath: '/private/socket' },
      { ...report, correlation: 'internal' },
    ];
    for (const value of invalidRows)
      expect(
        parseSubagentsControlResult(response({ sessionReports: [value] })),
      ).toBeUndefined();
    for (const fields of [
      { sessionReports: [report, report] },
      { sessionReportsOmitted: 1 },
      { sessionReports: [], sessionReportsOmitted: -1 },
      {
        sessionReports: Array.from(
          { length: MAX_SESSION_REPORTS + 1 },
          (_, index) => ({ ...report, id: `report_${index}` }),
        ),
      },
    ])
      expect(parseSubagentsControlResult(response(fields))).toBeUndefined();
  });

  it('keeps discovery bounded and explicitly distinguishes instruction authorization', () => {
    const session = {
      id: 'session:1',
      backend: 'qwen',
      sessionId: 'peer-1',
      title: 'Terminal session',
      cwd: '/project',
      source: 'terminal',
      status: 'unknown',
      readOnly: true,
    };
    const response = (fields: object) => ({
      type: 'page',
      page: { snapshot, offset: 0, total: 1, ...fields },
    });
    expect(parseSubagentsControlResult(response({}))).toBeDefined();
    const valid = response({
      discoveredSessions: [session],
      discoveredSessionsOmitted: 2,
    });
    expect(parseSubagentsControlResult(valid)).toEqual(valid);
    expect(
      parseSubagentsControlResult(
        response({ discoveredSessions: [{ ...session, readOnly: false }] }),
      ),
    ).toBeDefined();
    expect(
      parseSubagentsControlResult(response({ discoveredSessions: [] })),
    ).toBeDefined();
    for (const invalid of [
      { discoveredSessions: [session, session] },
      { discoveredSessions: [{ ...session, status: 'running' }] },
      { discoveredSessions: [{ ...session, readOnly: 'false' }] },
      { discoveredSessions: [{ ...session, source: 'daemon' }] },
      { discoveredSessions: [{ ...session, sessionId: '' }] },
      { discoveredSessions: [{ ...session, id: 'x'.repeat(129) }] },
      { discoveredSessions: [{ ...session, title: 'x'.repeat(241) }] },
      { discoveredSessions: [{ ...session, cwd: 'x'.repeat(4097) }] },
      {
        discoveredSessions: Array.from(
          { length: MAX_DISCOVERED_SESSIONS + 1 },
          (_, index) => ({ ...session, id: `session:${index}` }),
        ),
      },
      { discoveredSessions: [session], discoveredSessionsOmitted: -1 },
      { discoveredSessionsOmitted: 1 },
    ])
      expect(parseSubagentsControlResult(response(invalid))).toBeUndefined();
  });

  it('accepts bounded instruction receipts separately and rejects internal or malformed fields', () => {
    const delivery = {
      id: 'delivery_1',
      session: 'session_1',
      backend: 'qwen',
      status: 'held',
      tracking: true,
      createdAt: 100,
      updatedAt: 200,
      note: 'Awaiting review',
    };
    const response = (fields: object) => ({
      type: 'page',
      page: { snapshot, offset: 0, total: 1, ...fields },
    });
    for (const status of INSTRUCTION_DELIVERY_STATUSES) {
      const result = response({
        instructionDeliveries: [{ ...delivery, status }],
      });
      expect(parseSubagentsControlResult(result)).toEqual(result);
    }
    expect(
      parseSubagentsControlResult(
        response({
          instructionDeliveries: [],
          instructionDeliveriesOmitted: 2,
        }),
      ),
    ).toBeDefined();
    const invalidRows = [
      { ...delivery, id: '' },
      { ...delivery, session: 'x'.repeat(129) },
      { ...delivery, status: ['held'] },
      { ...delivery, status: 'completed' },
      { ...delivery, tracking: 'yes' },
      { ...delivery, createdAt: -1 },
      { ...delivery, updatedAt: 99 },
      { ...delivery, backend: 'x'.repeat(257) },
      { ...delivery, note: 'x'.repeat(1025) },
      { ...delivery, msgId: 'private-transport-id' },
      { ...delivery, token: 'controller-secret' },
    ];
    for (const row of invalidRows)
      expect(
        parseSubagentsControlResult(response({ instructionDeliveries: [row] })),
      ).toBeUndefined();
    for (const fields of [
      { instructionDeliveries: [delivery, delivery] },
      { instructionDeliveriesOmitted: 1 },
      { instructionDeliveries: [], instructionDeliveriesOmitted: -1 },
      {
        instructionDeliveries: Array.from(
          { length: MAX_INSTRUCTION_DELIVERIES + 1 },
          (_, i) => ({ ...delivery, id: `delivery_${i}` }),
        ),
      },
    ])
      expect(parseSubagentsControlResult(response(fields))).toBeUndefined();
  });

  it('bounds approval descriptions and never offers Allow for incomplete descriptions', () => {
    const permission = {
      requestHandle: 'req:1',
      title: 'x'.repeat(4096),
      titleTruncated: true,
      choices: [{ decision: 'deny', scope: 'once' }],
    };
    const response = (value: unknown) => ({
      type: 'page',
      page: { snapshot, offset: 0, total: 1, unassignedPermissions: [value] },
    });
    expect(parseSubagentsControlResult(response(permission))).toBeDefined();
    expect(
      parseSubagentsControlResult(
        response({ ...permission, title: 'x'.repeat(4097) }),
      ),
    ).toBeUndefined();
    expect(
      parseSubagentsControlResult(
        response({
          ...permission,
          choices: [{ decision: 'allow', scope: 'once' }],
        }),
      ),
    ).toBeUndefined();
    expect(
      parseSubagentsControlResult(
        response({ ...permission, titleTruncated: 'true' }),
      ),
    ).toBeUndefined();
  });

  it('accepts only exact bounded action fields and offered decision types', () => {
    for (const action of [
      { action: 'list' },
      { action: 'list', offset: 32, selectedId: 'job:1' },
      { action: 'stop', taskId: 'job:1' },
      { action: 'permission', requestHandle: 'req:1', decision: 'allow' },
    ])
      expect(parseSubagentsControlRequest(action)).toEqual(action);
    for (const action of [
      { action: 'stop', taskId: '' },
      { action: 'stop', taskId: 'x'.repeat(129) },
      { action: 'stop', taskId: 'job:1', all: true },
      { action: 'list', offset: -1 },
      { action: 'list', offset: 1.5 },
      { action: 'permission', requestHandle: 'req:1', decision: 'always' },
      { action: ['stop'], taskId: 'job:1' },
    ])
      expect(parseSubagentsControlRequest(action)).toBeUndefined();
  });

  it('validates selected detail, permissions, paging and owned results', () => {
    const result = {
      type: 'page',
      page: {
        snapshot,
        offset: 32,
        total: 40,
        selected: {
          ...task,
          canStop: false,
          stopReason: 'stopping',
          permissions: [
            {
              requestHandle: 'req:1',
              title: 'Write file',
              choices: [
                { decision: 'allow', scope: 'once' },
                { decision: 'deny', scope: 'once' },
              ],
            },
          ],
          permissionsOmitted: 1,
        },
      },
    };
    expect(parseSubagentsControlResult(result)).toEqual(result);
    expect(
      parseSubagentsControlResult({
        ...result,
        page: {
          ...result.page,
          unassignedPermissions: [
            {
              requestHandle: 'req:other',
              title: 'External approval',
              choices: [],
            },
          ],
        },
      }),
    ).toBeDefined();
    for (const bad of [
      { ...result, page: { ...result.page, offset: 40 } },
      {
        ...result,
        page: { ...result.page, selected: { ...task, canStop: 'yes' } },
      },
      {
        ...result,
        page: {
          ...result.page,
          selected: { ...task, stopReason: 'cancel_all' },
        },
      },
      { ...result, page: { ...result.page, unassignedPermissionsOmitted: -1 } },
      {
        ...result,
        page: {
          ...result.page,
          unassignedPermissions: [
            {
              requestHandle: 'req:long',
              title: 'Request',
              backend: 'x'.repeat(257),
              choices: [],
            },
          ],
        },
      },
      {
        ...result,
        page: {
          ...result.page,
          selected: {
            ...task,
            permissions: [
              {
                requestHandle: 'req:1',
                title: 'Bad',
                choices: [{ decision: 'allow', scope: 'all' }],
              },
            ],
          },
        },
      },
      { type: 'error', code: 'raw_backend_error' },
      { type: 'outcome', outcome: 'stopped' },
      { type: 'outcome', outcome: ['stopped'], taskId: 'job:1' },
      { type: 'outcome', outcome: 'allowed', requestHandle: '' },
      { ...result, extra: 'x'.repeat(MAX_SUBAGENTS_CONTROL_BYTES + 1) },
    ])
      expect(parseSubagentsControlResult(bad)).toBeUndefined();
    expect(
      parseSubagentsControlResult({
        type: 'outcome',
        outcome: 'stopped',
        taskId: 'job:1',
      }),
    ).toBeDefined();
    expect(
      parseSubagentsControlResult({
        type: 'outcome',
        outcome: 'allowed',
        requestHandle: 'req:1',
      }),
    ).toBeDefined();
  });
});
