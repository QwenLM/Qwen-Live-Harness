import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { liveMessage, liveText } from 'qwen-live-harness/i18n';
import type {
  InstructionDelivery,
  SessionReport,
  SubagentTask,
  SubagentsControlResult,
  SubagentsSnapshot,
} from 'qwen-live-harness/subagents';
import { SubagentsView } from '../../renderer/subagents-view.ts';
import type {
  SubagentsWindowApi,
  SubagentsWindowState,
} from '../../shared/subagents-api.ts';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

function task(overrides: Partial<SubagentTask> = {}): SubagentTask {
  return {
    id: 'task-1',
    kind: 'harness',
    title: 'Check build',
    status: 'running',
    createdAt: 1_788_790_000_000,
    updatedAt: 1_788_790_001_000,
    request: 'Run focused tests',
    activity: 'Running the tests',
    output: 'Build output',
    events: [{ at: 1_788_790_001_000, kind: 'tool', text: 'npm test' }],
    ...overrides,
  };
}

function snapshot(tasks = [task()]): SubagentsSnapshot {
  return {
    revision: 1,
    counts: {
      running: 3,
      completed: 7,
      needsAttention: 2,
      failed: 1,
      cancelled: 1,
      interrupted: 1,
    },
    tasks,
    omitted: 4,
  };
}

function setup(
  overrides: Partial<SubagentsWindowApi> = {},
  initial: Partial<SubagentsWindowState> = {},
) {
  const dom = new JSDOM('<!doctype html><main id="app"></main>');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  cleanup.push(() => {
    dom.window.close();
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const app = dom.window.document.querySelector<HTMLElement>('#app')!;
  const calls: unknown[][] = [];
  const state: SubagentsWindowState = {
    language: 'en',
    connected: true,
    mode: 'summary',
    snapshot: snapshot(),
    ...initial,
  };
  const api: SubagentsWindowApi = {
    getState: async () => state,
    onState: () => () => {},
    setHover: (value) => calls.push(['hover', value]),
    setKeyboardHeld: (value) => calls.push(['keyboard', value]),
    back: async () => {
      calls.push(['back']);
    },
    expand: async () => {
      calls.push(['expand']);
    },
    close: () => calls.push(['close']),
    openDetail: async (id) => {
      calls.push(['detail', id]);
    },
    control: async (instanceId, request) => {
      calls.push(['control', instanceId, request]);
      return {
        type: 'outcome',
        outcome: 'stopping',
        ...(request.action === 'stop' ? { taskId: request.taskId } : {}),
      };
    },
    ...overrides,
  };
  const view = new SubagentsView(app, api);
  cleanup.push(() => view.dispose());
  view.update(state);
  const get = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const node = app.querySelector<T>(selector);
    assert(node, `Missing ${selector}`);
    return node;
  };
  const update = (next: Partial<SubagentsWindowState>) => {
    Object.assign(state, next);
    view.update({ ...state });
  };
  return { dom, app, calls, view, get, update, state };
}

describe('Subagents read-only surfaces', () => {
  it('hides legacy persistent scopes while localizing once-only outcomes and preserving raw command details', async () => {
    const scope = liveMessage('subagents.permissionScope');
    const message = liveMessage('subagents.allowOnce');
    const selected = task({
      status: 'waiting',
      permissions: [
        {
          requestHandle: 'req_once',
          title: 'Run tests',
          details: 'npm test -- --runInBand',
          alwaysScope: scope,
          choices: [
            { decision: 'allow', scope: 'once' },
            { decision: 'allow', scope: 'always' },
            { decision: 'deny' },
          ],
        },
      ],
    });
    const h = setup(
      {
        control: async (_instance, request) => {
          h.calls.push(['control', request]);
          return {
            type: 'outcome',
            outcome: 'allowed',
            requestHandle: 'req_once',
            scope: 'once',
            message,
          };
        },
      },
      {
        mode: 'detail',
        instanceId: 'one',
        controlsAvailable: true,
        selectedId: selected.id,
        page: { snapshot: snapshot([selected]), selected, offset: 0, total: 1 },
      },
    );
    assert.equal(h.app.querySelector('.subagent-permission-scope'), null);
    assert.equal(h.app.querySelector('[data-scope="always"]'), null);
    assert.equal(h.get('.subagent-permission-details').tabIndex, 0);
    h.get<HTMLButtonElement>(
      '[data-decision="allow"][data-scope="once"]',
    ).click();
    await settled();
    assert.deepEqual(h.calls.at(-1), [
      'control',
      {
        action: 'permission',
        requestHandle: 'req_once',
        decision: 'allow',
        scope: 'once',
      },
    ]);
    assert.equal(
      h.get('.subagents-feedback').textContent,
      liveText('en', 'subagents.allowOnce'),
    );
    h.update({ language: 'zh-CN' });
    assert.equal(
      h.get('.subagents-feedback').textContent,
      liveText('zh-CN', 'subagents.allowOnce'),
    );
    assert.equal(h.app.querySelector('.subagent-permission-scope'), null);
    assert.equal(
      h.get('.subagent-permission-details').textContent,
      'npm test -- --runInBand',
    );
  });

  it('filters from count buttons, resets paging, and offers a visible return to all tasks', async () => {
    const entries = [
      task({ id: 'new-done', status: 'completed', createdAt: 5 }),
      task({ id: 'old-waiting', status: 'waiting', createdAt: 1 }),
    ];
    const h = setup(
      {},
      {
        mode: 'list',
        instanceId: 'daemon-one',
        controlsAvailable: true,
        snapshot: snapshot(entries),
        page: { snapshot: snapshot(entries), offset: 32, total: 34 },
      },
    );
    const filter = h.get<HTMLButtonElement>('[data-filter="needsAttention"]');
    assert.equal(filter.tagName, 'BUTTON');
    assert.equal(filter.type, 'button');
    assert.equal(
      filter.getAttribute('aria-controls'),
      h.get('.subagents-list').id,
    );
    assert.equal(filter.getAttribute('aria-pressed'), 'false');
    filter.focus();
    filter.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), [
      'control',
      'daemon-one',
      { action: 'list', offset: 0, filter: 'needsAttention' },
    ]);
    h.update({
      filter: 'needsAttention',
      page: {
        snapshot: snapshot([entries[1]!]),
        offset: 0,
        total: 1,
        filter: 'needsAttention',
      },
    });
    assert.equal(filter.getAttribute('aria-pressed'), 'true');
    assert.equal(h.get('.subagents-filter-bar').hidden, false);
    assert.equal(h.app.querySelector('[data-task-id="new-done"]'), null);
    h.update({ language: 'zh-CN' });
    assert.equal(h.get('[data-filter="needsAttention"]'), filter);
    assert.equal(document.activeElement, filter);
    assert.equal(
      h.get('.subagents-clear-filter').textContent,
      liveText('zh-CN', 'subagents.showAllTasks'),
    );
    filter.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), [
      'control',
      'daemon-one',
      { action: 'list', offset: 0, filter: 'all' },
    ]);
    h.get<HTMLButtonElement>('.subagents-clear-filter').click();
    await settled();
    assert.deepEqual(h.calls.at(-1), [
      'control',
      'daemon-one',
      { action: 'list', offset: 0, filter: 'all' },
    ]);
    h.get<HTMLButtonElement>('.subagents-clear-filter').focus();
    h.update({
      filter: 'all',
      page: { snapshot: snapshot(entries), offset: 0, total: 2 },
    });
    assert.equal(document.activeElement, filter);
    h.update({ loading: true });
    assert.equal(filter.getAttribute('aria-disabled'), 'true');
    assert.equal(filter.disabled, false);
    const beforeBlockedClick = h.calls.length;
    filter.click();
    await settled();
    assert.equal(h.calls.length, beforeBlockedClick);
    h.update({ loading: false, connected: false });
    assert.equal(filter.disabled, true);
  });

  it('keeps filtered pagination and shows a truthful empty category while hiding unrelated sections', async () => {
    const entry = task({ status: 'completed' });
    const h = setup(
      {},
      {
        mode: 'list',
        instanceId: 'daemon-one',
        controlsAvailable: true,
        filter: 'completed',
        page: {
          snapshot: snapshot([entry]),
          filter: 'completed',
          offset: 3,
          total: 8,
          discoveredSessions: [],
          instructionDeliveries: [],
          sessionReports: [],
        },
      },
    );
    h.get<HTMLButtonElement>(
      '.subagents-pagination button:nth-of-type(2)',
    ).click();
    await settled();
    assert.deepEqual(h.calls.at(-1), [
      'control',
      'daemon-one',
      { action: 'list', offset: 4, filter: 'completed' },
    ]);
    h.update({
      page: {
        snapshot: snapshot([]),
        filter: 'completed',
        offset: 0,
        total: 0,
        discoveredSessions: [],
        unassignedPermissions: [
          { requestHandle: 'other', title: 'Approval', choices: [] },
        ],
      },
    });
    assert.equal(h.get('.subagents-empty').hidden, false);
    assert.equal(
      h.get('.subagents-empty').textContent,
      liveText('en', 'subagents.filterEmpty'),
    );
    assert.equal(h.app.querySelector('.discovered-sessions'), null);
    assert.equal(h.app.querySelector('.subagent-unassigned'), null);
  });

  it('orders all task rows by creation time across status changes and preserves focus when new tasks arrive', () => {
    const old = task({ id: 'old-running', createdAt: 1 });
    const newer = task({
      id: 'new-completed',
      createdAt: 5,
      status: 'completed',
    });
    const h = setup({}, { mode: 'list', snapshot: snapshot([old, newer]) });
    const order = () =>
      [...h.app.querySelectorAll<HTMLElement>('[data-task-id]')].map(
        (node) => node.dataset.taskId,
      );
    assert.deepEqual(order(), ['new-completed', 'old-running']);
    const oldButton = h.get<HTMLButtonElement>('[data-task-id="old-running"]');
    oldButton.focus();
    h.update({
      snapshot: snapshot([
        old,
        newer,
        task({ id: 'newest-failed', createdAt: 10, status: 'failed' }),
      ]),
    });
    assert.deepEqual(order(), [
      'newest-failed',
      'new-completed',
      'old-running',
    ]);
    assert.equal(document.activeElement, oldButton);
    h.update({
      snapshot: snapshot([
        { ...old, status: 'waiting', updatedAt: 999 },
        newer,
      ]),
    });
    assert.deepEqual(order(), ['new-completed', 'old-running']);
    assert.equal(document.activeElement, oldButton);
  });

  it('localizes only an explicit owned outputMessage and never interprets markers in external output', () => {
    const original = liveMessage('visual.failed');
    const value = task({
      kind: 'visual',
      status: 'failed',
      output: original,
      outputMessage: liveMessage('subagents.error.action_failed'),
    });
    const h = setup(
      {},
      { mode: 'detail', selectedId: value.id, snapshot: snapshot([value]) },
    );
    const output = h.get('.subagent-output');
    for (const language of ['en', 'zh-CN', 'en'] as const) {
      h.update({ language });
      assert.equal(
        output.textContent,
        liveText(language, 'subagents.error.action_failed'),
      );
      assert.equal(h.get('.subagent-output'), output);
      assert.equal(h.get('.subagent-request').textContent, value.request);
    }
    h.update({
      language: 'zh-CN',
      snapshot: snapshot([{ ...value, outputMessage: undefined }]),
    });
    assert.equal(output.textContent, original);
    h.update({
      snapshot: snapshot([
        { ...value, outputMessage: 'PRIVATE malformed marker' },
      ]),
    });
    assert.equal(
      output.textContent,
      liveText('zh-CN', 'subagents.outputUnavailable'),
    );
  });

  it('localizes every runtime-owned source without rewriting user labels or task contents', () => {
    for (const [source, expectedEn, expectedZh] of [
      ['screen+audio', 'Screen + Microphone', '屏幕 + 麦克风'],
      ['camera', 'Camera', '摄像头'],
      [
        'timer',
        liveText('en', 'subagents.sourceTimer'),
        liveText('zh-CN', 'subagents.sourceTimer'),
      ],
      ['Custom source', 'Custom source', 'Custom source'],
    ]) {
      const value = task({
        source,
        title: 'User title',
        request: 'User request',
        output: 'Backend response',
      });
      const h = setup(
        {},
        { mode: 'detail', selectedId: value.id, snapshot: snapshot([value]) },
      );
      for (const [language, expected] of [
        ['en', expectedEn],
        ['zh-CN', expectedZh],
      ] as const) {
        h.update({ language });
        assert(
          h.get('.subagent-metadata').textContent?.includes(
            liveText(language, 'ui.labelValue', {
              label: liveText(language, 'subagents.source'),
              value: expected!,
            }),
          ),
        );
        assert.equal(h.get('.subagent-title').textContent, value.title);
        assert.equal(h.get('.subagent-request').textContent, value.request);
        assert.equal(h.get('.subagent-output').textContent, value.output);
      }
    }
  });

  it('keeps load and unknown action failures localized when language changes', async () => {
    const h = setup({
      expand: async () => {
        throw new Error('PRIVATE /Users/example/private');
      },
    });
    h.get<HTMLButtonElement>('.subagents-summary').click();
    await settled();
    assert.equal(
      h.get('.subagents-error').textContent,
      liveText('en', 'subagents.error.action_failed'),
    );
    h.update({ language: 'zh-CN' });
    assert.equal(
      h.get('.subagents-error').textContent,
      liveText('zh-CN', 'subagents.error.action_failed'),
    );
    h.view.showLoadFailure();
    assert.equal(
      h.get('.subagents-error').textContent,
      liveText('zh-CN', 'subagents.loadFailed'),
    );
    h.update({ language: 'en', mode: 'list', connected: false });
    assert.equal(
      h.get('.subagents-error').textContent,
      liveText('en', 'subagents.loadFailed'),
    );
    assert(!h.app.textContent?.includes('PRIVATE'));
  });

  it('identifies search rows and details, preserves query/output as text, and localizes real activity', async () => {
    const query = '<b>What is the current price?</b>';
    const answer = '<script>not executable</script> Search result text.';
    const entry = task({
      id: 'search:1',
      kind: 'search',
      title: query,
      request: query,
      output: answer,
      activity: liveMessage('search.running'),
      events: [{ at: 1, kind: 'status', text: liveMessage('search.queued') }],
      canStop: true,
    });
    const h = setup(
      {},
      {
        mode: 'list',
        snapshot: snapshot([entry]),
        instanceId: 'daemon-search',
        controlsAvailable: true,
      },
    );
    const row = h.get<HTMLButtonElement>('[data-task-id="search:1"]');
    assert.equal(row.dataset.kind, 'search');
    assert.match(row.textContent ?? '', /Web Search/);
    assert.match(row.getAttribute('aria-label') ?? '', /Web Search/);
    row.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), ['detail', entry.id]);
    h.update({ mode: 'detail', selectedId: entry.id });
    assert.equal(h.get('.subagent-metadata').textContent, 'Web Search');
    assert.equal(h.get('.subagent-title').textContent, query);
    assert.equal(h.get('.subagent-request').textContent, query);
    const output = h.get('.subagent-output');
    assert.equal(output.textContent, answer);
    assert.equal(
      h.app.querySelector('script, .subagent-title b, [role="progressbar"]'),
      null,
    );
    h.update({ language: 'zh-CN' });
    assert.equal(h.get('.subagent-metadata').textContent, '联网搜索');
    assert.equal(
      h.get('.subagent-latest').textContent,
      liveText('zh-CN', 'search.running'),
    );
    assert.match(h.get('.subagent-events').textContent ?? '', /正在等待搜索/);
    assert.equal(h.get('.subagent-output'), output);
    assert.equal(output.textContent, answer);
  });

  it('stops the exact search task from the list or detail and waits for its confirmed result', async () => {
    for (const mode of ['list', 'detail'] as const) {
      const entry = task({
        id: `search:${mode}`,
        kind: 'search',
        title: 'Weather today',
        canStop: true,
      });
      const h = setup(
        {},
        {
          mode,
          selectedId: entry.id,
          snapshot: snapshot([entry]),
          instanceId: 'daemon-search',
          controlsAvailable: true,
        },
      );
      const selector =
        mode === 'list'
          ? '.subagent-row > .subagents-stop'
          : '.subagent-identity .subagents-stop';
      const stop = h.get<HTMLButtonElement>(selector);
      stop.click();
      stop.click();
      await settled();
      assert.deepEqual(h.calls, [
        ['control', 'daemon-search', { action: 'stop', taskId: entry.id }],
      ]);
      const updated = {
        ...entry,
        status: 'cancelled' as const,
        canStop: false,
        stopReason: 'ended' as const,
        activity: liveMessage('search.cancelled'),
      };
      h.update({ language: 'zh-CN', snapshot: snapshot([updated]) });
      assert.equal(stop.hidden, true);
      const status = h.get(
        mode === 'list'
          ? '.subagent-task > .subagent-status'
          : '.subagent-identity .subagent-status',
      );
      assert.match(status.textContent ?? '', /已取消/);
      assert.equal(h.calls.length, 1);
    }
  });

  it('localizes search lifecycle and answer-delivery states without inventing completion percentages', () => {
    const entry = task({
      id: 'search:activity',
      kind: 'search',
      title: 'Actual query',
    });
    const h = setup(
      {},
      { mode: 'detail', selectedId: entry.id, snapshot: snapshot([entry]) },
    );
    const keys = [
      'search.queued',
      'search.running',
      'search.completed',
      'search.failed',
      'search.cancelled',
      'search.fallback',
      'search.fallbackStarted',
      'search.fallbackFailed',
      'search.awaitingAnswer',
      'search.answering',
      'search.answered',
      'search.answerInterrupted',
      'search.answerMuted',
    ] as const;
    for (const language of ['en', 'zh-CN'] as const) {
      for (const key of keys) {
        const params =
          key === 'search.fallbackStarted' ? { backend: 'Codex' } : undefined;
        h.update({
          language,
          snapshot: snapshot([
            {
              ...entry,
              status: 'delivering',
              activity: liveMessage(key, params),
            },
          ]),
        });
        assert.equal(
          h.get('.subagent-latest').textContent,
          liveText(language, key, params),
        );
        assert.equal(h.get('.subagent-title').textContent, entry.title);
      }
    }
    assert.equal(h.app.querySelector('[role="progressbar"], progress'), null);
  });

  it('labels visual analysis and distinguishes preparing from actual playback or undelivered output', () => {
    const entry = task({
      id: 'visual:1',
      kind: 'visual',
      title: 'Read the picture',
      status: 'delivering',
    });
    const h = setup(
      {},
      { mode: 'detail', selectedId: entry.id, snapshot: snapshot([entry]) },
    );
    for (const language of ['en', 'zh-CN'] as const) {
      for (const [notification, key] of [
        ['preparing', 'subagents.notificationPreparing'],
        ['speaking', 'subagents.notificationSpeaking'],
        ['undelivered', 'subagents.notificationUndelivered'],
      ] as const) {
        h.update({
          language,
          snapshot: snapshot([
            { ...entry, notification, activity: liveMessage('visual.running') },
          ]),
        });
        assert.ok(
          h.app.textContent?.includes(
            liveText(language, 'subagents.kind.visual'),
          ),
        );
        assert.ok(h.app.textContent?.includes(liveText(language, key)));
        assert.equal(
          h.get('.subagent-latest').textContent,
          liveText(language, 'visual.running'),
        );
      }
    }
  });

  it('localizes an absent report source without changing a real terminal named Unknown peer', () => {
    const value = snapshot([]);
    const report: SessionReport = {
      id: 'report_unknown',
      backend: 'qwen',
      source: '',
      sourceStatus: 'unconfirmed',
      category: 'info',
      text: 'Original report text',
      receivedAt: 1_788_790_000_000,
      updatedAt: 1_788_790_001_000,
      announcement: 'unspoken',
    };
    const page = {
      snapshot: value,
      offset: 0,
      total: 0,
      sessionReports: [
        report,
        { ...report, id: 'report_named', source: 'Unknown peer' },
      ],
    };
    const h = setup(
      {},
      { mode: 'list', language: 'zh-CN', snapshot: value, page },
    );
    const names = h.app.querySelectorAll('.session-report-source');
    assert.equal(
      names[0]?.textContent,
      `${liveText('zh-CN', 'subagents.unknownReportSource')} · qwen`,
    );
    assert.equal(names[1]?.textContent, 'Unknown peer · qwen');
    h.view.update({ ...h.state, language: 'en' });
    assert.equal(
      names[0]?.textContent,
      `${liveText('en', 'subagents.unknownReportSource')} · qwen`,
    );
    assert.equal(names[1]?.textContent, 'Unknown peer · qwen');
    assert.equal(report.source, '');
  });

  it('keeps self-reported results separate from tasks and updates announcement state without interpreting report text', () => {
    const value = snapshot([]);
    value.omitted = 0;
    value.counts = {
      running: 0,
      completed: 0,
      needsAttention: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
    };
    const report: SessionReport = {
      id: 'report_1',
      backend: 'qwen',
      source: '<b>Terminal</b>',
      sourceStatus: 'matched',
      session: 'session_1',
      category: 'result',
      text: '<img src=x>\n' + liveMessage('subagents.completed'),
      receivedAt: 1_788_790_000_000,
      updatedAt: 1_788_790_001_000,
      announcement: 'queued',
    };
    const page = {
      snapshot: value,
      offset: 0,
      total: 0,
      sessionReports: [report],
    };
    const h = setup(
      {},
      { mode: 'list', language: 'en', snapshot: value, page },
    );
    assert.equal(h.get('.subagents-empty').hidden, true);
    assert.equal(
      h.get('.session-report-source').textContent,
      '<b>Terminal</b> · qwen',
    );
    assert.equal(h.app.querySelector('.session-report-source b'), null);
    assert.equal(h.get('.session-report-text').textContent, report.text);
    assert.equal(h.app.querySelector('.session-report-text img'), null);
    assert.equal(
      h.get('.session-report-category').textContent,
      'Reported result',
    );
    assert.equal(
      h.get('.session-report-source-status').textContent,
      liveText('en', 'subagents.reportSourceMatched'),
    );
    assert.equal(
      h.get('.session-reports-description').textContent,
      liveText('en', 'subagents.reportsAttribution'),
    );
    assert.equal(
      h.app.querySelectorAll(
        '.session-report button, .session-report [data-status="completed"], .subagent-row',
      ).length,
      0,
    );
    const row = h.get('.session-report');
    for (const [announcement, key] of [
      ['queued', 'subagents.reportQueued'],
      ['submitted', 'subagents.reportSubmitted'],
      ['speaking', 'subagents.reportSpeaking'],
      ['announced', 'subagents.reportAnnounced'],
      ['interrupted', 'subagents.reportInterrupted'],
      ['unspoken', 'subagents.reportUnspoken'],
      ['suppressed', 'subagents.reportSuppressed'],
    ] as const) {
      h.update({
        language: 'zh-CN',
        page: {
          ...page,
          sessionReports: [
            {
              ...report,
              announcement,
              sourceStatus: 'unconfirmed',
              updatedAt: report.updatedAt + 1000,
            },
          ],
        },
      });
      assert.equal(h.get('.session-report'), row);
      assert.equal(
        h.get('.session-report-announcement').textContent,
        liveText('zh-CN', key),
      );
      assert.equal(
        h.get('.session-report-source-status').textContent,
        liveText('zh-CN', 'subagents.reportSourceUnconfirmed'),
      );
      assert.equal(
        h.get('.subagents-panel [data-count="running"]').textContent,
        '0',
      );
      assert.equal(
        h.get('.subagents-panel [data-count="completed"]').textContent,
        '0',
      );
    }
    const formatTime = (at: number) =>
      new Date(at).toLocaleString('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    assert.equal(
      h.get('.session-report-time').textContent,
      liveText('zh-CN', 'subagents.reportTime', {
        received: formatTime(report.receivedAt),
        updated: formatTime(report.updatedAt + 1000),
      }),
    );
    h.update({
      page: { ...page, sessionReports: [], sessionReportsOmitted: 2 },
    });
    assert.equal(h.app.querySelector('.session-report'), null);
    assert.equal(h.get('.session-reports-empty').hidden, false);
    assert.match(h.get('.session-reports-omitted').textContent ?? '', /2/);
    h.update({ page: { snapshot: value, offset: 0, total: 0 } });
    assert.equal(h.app.querySelector('.session-reports'), null);
  });

  it('shows terminal discovery separately without inventing running tasks or session controls', async () => {
    const value = snapshot([]);
    value.omitted = 0;
    value.counts = {
      running: 0,
      completed: 0,
      needsAttention: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
    };
    const session = {
      id: 'session:terminal-1',
      backend: 'qwen-code',
      sessionId: 'peer-1',
      title: '<b>Terminal project</b>',
      cwd: '/project/with a long directory',
      source: 'terminal' as const,
      status: 'unknown' as const,
      readOnly: true as const,
    };
    const h = setup(
      {},
      {
        mode: 'list',
        language: 'zh-CN',
        connected: true,
        controlsAvailable: true,
        instanceId: 'live:1',
        snapshot: value,
        page: {
          snapshot: value,
          offset: 0,
          total: 0,
          discoveredSessions: [session],
          discoveredSessionsOmitted: 2,
        },
      },
    );
    assert.equal(
      h.get('.subagents-panel [data-count="running"]').textContent,
      '0',
    );
    assert.equal(h.app.querySelectorAll('.subagent-row').length, 0);
    assert.equal(h.get('.subagents-empty').hidden, true);
    assert.equal(h.get('.discovered-sessions h2').textContent, '终端会话');
    assert.equal(h.get('.discovered-session-title').textContent, session.title);
    assert.equal(h.app.querySelector('.discovered-session-title b'), null);
    assert.match(
      h.get('.discovered-session-origin').textContent ?? '',
      /终端.*qwen-code.*peer-1/,
    );
    assert.equal(h.get('.discovered-session-cwd').textContent, session.cwd);
    assert.equal(
      h.get('.discovered-session .subagent-status').textContent,
      '执行状态未知',
    );
    assert.equal(
      h.get('.discovered-session-instructions').textContent,
      liveText('zh-CN', 'subagents.sessionsReadOnly'),
    );
    assert.match(h.get('.discovered-sessions-omitted').textContent ?? '', /2/);
    assert.equal(
      h.app.querySelectorAll('.discovered-session button').length,
      0,
    );

    const refresh = h.get<HTMLButtonElement>(
      '.discovered-sessions-header button',
    );
    refresh.click();
    await settled();
    assert.deepEqual(
      h.calls.find(([name]) => name === 'control'),
      ['control', 'live:1', { action: 'list', offset: 0 }],
    );
    h.update({
      page: { snapshot: value, offset: 0, total: 0, discoveredSessions: [] },
    });
    assert.equal(h.app.querySelectorAll('.discovered-session').length, 0);
    assert.equal(h.get('.discovered-sessions-empty').hidden, false);
    assert.equal(
      h.get('.discovered-sessions-empty').textContent,
      '未发现终端会话。',
    );
    h.update({ connected: false });
    assert.equal(refresh.disabled, true);
    h.update({
      connected: true,
      page: { snapshot: value, offset: 0, total: 0 },
    });
    assert.equal(h.app.querySelector('.discovered-sessions'), null);
    assert.equal(h.get('.subagents-empty').hidden, false);
  });

  it('renders terminal authorization and evolving delivery receipts without task actions or completion counts', () => {
    const value = snapshot([]);
    value.omitted = 0;
    value.counts = {
      running: 0,
      completed: 0,
      needsAttention: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
    };
    const session = {
      id: 'session_1',
      backend: 'qwen',
      sessionId: 'terminal-1',
      title: 'Coding terminal',
      source: 'terminal' as const,
      status: 'unknown' as const,
      readOnly: false,
    };
    const delivery: InstructionDelivery = {
      id: 'delivery_1',
      session: 'session_1',
      backend: 'qwen',
      status: 'held',
      tracking: true,
      createdAt: 1_788_790_000_000,
      updatedAt: 1_788_790_001_000,
      note: '<b>Review in terminal</b>',
    };
    const page = {
      snapshot: value,
      offset: 0,
      total: 0,
      discoveredSessions: [session],
      instructionDeliveries: [delivery],
    };
    const h = setup(
      {},
      {
        mode: 'list',
        language: 'en',
        snapshot: value,
        page,
        controlsAvailable: true,
        instanceId: 'one',
      },
    );
    assert.equal(
      h.get('.discovered-session-instructions').textContent,
      liveText('en', 'subagents.sessionsCanInstruct'),
    );
    assert.equal(
      h.get('.discovered-sessions-description').textContent,
      liveText('en', 'subagents.sessionsInstructions'),
    );
    assert.equal(
      h.get('.instruction-delivery-target').textContent,
      'Coding terminal · qwen',
    );
    assert.equal(
      h.get('.instruction-delivery-status').textContent,
      liveText('en', 'subagents.deliveryHeld'),
    );
    assert.equal(
      h.get('.instruction-delivery-tracking').textContent,
      liveText('en', 'subagents.deliveryTracking'),
    );
    assert.equal(
      h.get('.instruction-delivery-note').textContent,
      delivery.note,
    );
    assert.equal(h.app.querySelector('.instruction-delivery-note b'), null);
    assert.match(
      h.get('.instruction-delivery-time').textContent ?? '',
      /Started.*Updated/,
    );
    assert.equal(
      h.get('.instruction-deliveries-description').textContent,
      liveText('en', 'subagents.deliveryNotCompletion'),
    );
    assert.equal(
      h.app.querySelectorAll(
        '.instruction-delivery button, .discovered-session button',
      ).length,
      0,
    );
    assert.equal(h.app.querySelectorAll('.subagent-row').length, 0);
    const row = h.get('.instruction-delivery');
    const refresh = h.get<HTMLButtonElement>(
      '.discovered-sessions-header button',
    );
    refresh.focus();
    for (const [status, key] of [
      ['pending', 'subagents.deliveryPending'],
      ['delivered', 'subagents.deliveryDelivered'],
      ['denied', 'subagents.deliveryDenied'],
      ['refused', 'subagents.deliveryRefused'],
      ['expired', 'subagents.deliveryExpired'],
      ['misaddressed', 'subagents.deliveryMisaddressed'],
      ['dropped', 'subagents.deliveryDropped'],
      ['unknown', 'subagents.deliveryUnknown'],
      ['failed', 'subagents.deliveryFailed'],
    ] as const) {
      h.update({
        language: 'zh-CN',
        page: {
          ...page,
          instructionDeliveries: [
            {
              ...delivery,
              status,
              tracking: false,
              updatedAt: delivery.updatedAt + 1000,
            },
          ],
        },
      });
      assert.equal(h.get('.instruction-delivery'), row);
      assert.equal(h.dom.window.document.activeElement, refresh);
      assert.equal(
        h.get('.instruction-delivery-status').textContent,
        liveText('zh-CN', key),
      );
      assert.equal(
        h.get('.instruction-delivery-unknown').hidden,
        status !== 'unknown',
      );
      assert.equal(
        h.get('.subagents-panel [data-count="running"]').textContent,
        '0',
      );
      assert.equal(
        h.get('.subagents-panel [data-count="completed"]').textContent,
        '0',
      );
    }
    assert.equal(
      h.get('.instruction-delivery-tracking').textContent,
      liveText('zh-CN', 'subagents.deliveryTrackingEnded'),
    );
    h.update({
      page: {
        ...page,
        instructionDeliveries: [],
        instructionDeliveriesOmitted: 3,
      },
    });
    assert.equal(h.app.querySelector('.instruction-delivery'), null);
    assert.equal(h.get('.instruction-deliveries-empty').hidden, false);
    assert.match(
      h.get('.instruction-deliveries-omitted').textContent ?? '',
      /3/,
    );
    h.update({ page: { snapshot: value, offset: 0, total: 0 } });
    assert.equal(h.app.querySelector('.instruction-deliveries'), null);
  });

  it('marks an unassigned backend approval without inventing an active task', () => {
    const value = snapshot([]);
    value.counts = {
      running: 0,
      completed: 0,
      needsAttention: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
    };
    value.pendingUnassignedPermissions = 1;
    const h = setup({}, { snapshot: value });
    assert.equal(h.get('.subagents-summary-waiting').hidden, false);
    assert.match(
      h.get('.subagents-summary').getAttribute('aria-label') ?? '',
      /0 running.*1 waiting/,
    );
    h.update({ mode: 'list' });
    assert.equal(
      h.get('.subagents-panel [data-count="needsAttention"]').textContent,
      '1',
    );
  });

  it('stops the exact selected task outside the summary page and distinguishes requested from confirmed', async () => {
    const selected = task({ id: 'harness:40', canStop: true });
    const h = setup(
      {},
      {
        mode: 'detail',
        selectedId: selected.id,
        instanceId: 'daemon-one',
        controlsAvailable: true,
        page: { snapshot: snapshot(), offset: 0, total: 40, selected },
      },
    );
    const stop = h.get<HTMLButtonElement>('.subagent-identity .subagents-stop');
    assert.equal(stop.hidden, false);
    stop.click();
    stop.click();
    await settled();
    assert.deepEqual(h.calls, [
      ['control', 'daemon-one', { action: 'stop', taskId: 'harness:40' }],
    ]);
    assert.equal(
      h.get('.subagent-identity .subagent-status').textContent,
      'Running',
    );
    assert.equal(
      h.get('.subagents-feedback').textContent,
      liveText('en', 'subagents.outcome.stopping'),
    );
    h.update({
      page: {
        ...h.state.page!,
        selected: { ...selected, canStop: false, stopReason: 'stopping' },
      },
    });
    assert.equal(stop.disabled, true);
    assert.equal(stop.textContent, 'Stopping…');
    h.update({
      language: 'zh-CN',
      page: {
        ...h.state.page!,
        selected: {
          ...selected,
          canStop: false,
          stopReason: 'ended',
          status: 'cancelled',
        },
      },
    });
    assert.equal(stop.hidden, true);
    assert.equal(h.get('.subagents-feedback').textContent, '任务已停止。');
    assert.equal(
      h.get('.subagent-identity .subagent-status').textContent,
      '已取消',
    );
    h.get<HTMLButtonElement>('.subagents-close').click();
    assert.equal(h.calls.filter(([call]) => call === 'control').length, 1);
  });

  it('renders real pending decisions with explicit scopes, keeps focus, and sends the request handle', async () => {
    const selected = task({
      status: 'waiting',
      canStop: true,
      permissions: [
        {
          requestHandle: 'req_12',
          title: '<script>Write file outside project</script>',
          details:
            '<img src=x onerror=alert(1)>\nnode scripts/build-report.mjs',
          alwaysScope: 'Only report generation in /tmp/report-project',
          choices: [
            { decision: 'allow', scope: 'once' },
            { decision: 'allow', scope: 'always' },
            { decision: 'deny', scope: 'once' },
          ],
        },
      ],
      permissionsOmitted: 3,
    });
    const h = setup(
      {
        control: async (instance, request) => {
          h.calls.push(['control', instance, request]);
          return {
            type: 'outcome',
            outcome: 'allowed',
            requestHandle: 'req_12',
          };
        },
      },
      {
        mode: 'detail',
        instanceId: 'daemon-one',
        controlsAvailable: true,
        selectedId: selected.id,
        page: { snapshot: snapshot([selected]), offset: 0, total: 1, selected },
      },
    );
    const allow = h.get<HTMLButtonElement>(
      '[data-decision="allow"][data-scope="once"]',
    );
    assert.equal(allow.textContent, liveText('en', 'subagents.allowOnce'));
    assert.equal(
      h.get('[data-decision="deny"]').textContent,
      liveText('en', 'subagents.deny'),
    );
    assert.equal(h.app.querySelector('script'), null);
    assert.equal(h.app.querySelector('img'), null);
    assert.equal(
      h.get('.subagent-permission-details').textContent,
      selected.permissions![0]!.details,
    );
    assert.equal(h.app.querySelector('.subagent-permission-scope'), null);
    assert.equal(h.app.querySelector('[data-scope="always"]'), null);
    allow.focus();
    h.update({ language: 'zh-CN' });
    assert.equal(h.get('[data-decision="allow"][data-scope="once"]'), allow);
    assert.equal(document.activeElement, allow);
    assert.equal(allow.textContent, liveText('zh-CN', 'subagents.allowOnce'));
    assert.match(h.get('.subagents-more-permissions').textContent ?? '', /3/);
    allow.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), [
      'control',
      'daemon-one',
      {
        action: 'permission',
        requestHandle: 'req_12',
        decision: 'allow',
        scope: 'once',
      },
    ]);
    assert.equal(
      h.get('.subagents-feedback').textContent,
      liveText('zh-CN', 'subagents.outcome.allowed'),
    );
    h.update({ connected: false });
    assert.equal(allow.disabled, true);
  });

  it('shows unassigned approvals separately and pages retained tasks instead of hiding active details', async () => {
    const entries = [task({ id: 'harness:33', canStop: true })];
    const h = setup(
      {},
      {
        mode: 'list',
        instanceId: 'daemon-one',
        controlsAvailable: true,
        page: {
          snapshot: snapshot(entries),
          offset: 32,
          total: 34,
          unassignedPermissions: [
            {
              requestHandle: 'req_2',
              title: 'Unassigned write',
              choices: [{ decision: 'deny', scope: 'once' }],
            },
          ],
        },
      },
    );
    assert(
      h
        .get('.subagent-unassigned')
        .textContent?.includes(
          liveText('en', 'subagents.unassignedPermissions'),
        ),
    );
    assert.equal(h.app.querySelector('[data-task-id="task-1"]'), null);
    assert.equal(h.get('.subagents-page-label').textContent, '33–33 of 34');
    const denial = h.get<HTMLButtonElement>(
      '.subagent-unassigned [data-decision="deny"]',
    );
    denial.focus();
    h.update({ language: 'zh-CN' });
    assert.equal(h.get('.subagent-unassigned [data-decision="deny"]'), denial);
    assert.equal(document.activeElement, denial);
    const next = h.get<HTMLButtonElement>(
      '.subagents-pagination button:nth-of-type(2)',
    );
    next.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), [
      'control',
      'daemon-one',
      { action: 'list', offset: 33 },
    ]);
    assert.equal(h.get('.subagents-retention').hidden, true);
  });

  it('does not apply late action feedback to a replacement daemon or permanently lock controls after closing', async () => {
    let finish: (result: SubagentsControlResult) => void = () => {};
    const selected = task({ canStop: true });
    const h = setup(
      {
        control: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
      {
        mode: 'detail',
        instanceId: 'one',
        controlsAvailable: true,
        selectedId: selected.id,
        page: { snapshot: snapshot([selected]), offset: 0, total: 1, selected },
      },
    );
    h.get<HTMLButtonElement>('.subagent-identity .subagents-stop').click();
    h.update({ instanceId: 'two' });
    finish({ type: 'outcome', outcome: 'stopped' });
    await settled();
    assert.equal(h.get('.subagents-feedback').hidden, true);
    const stop = h.get<HTMLButtonElement>('.subagent-identity .subagents-stop');
    assert.equal(stop.disabled, false);
    stop.click();
    h.get<HTMLButtonElement>('.subagents-close').click();
    finish({ type: 'error', code: 'action_failed' });
    await settled();
    h.update({ mode: 'summary' });
    assert.equal(
      h.get<HTMLButtonElement>('.subagents-summary').disabled,
      false,
    );
    assert.equal(h.get('.subagents-error').hidden, true);
  });

  it('shows authoritative paired-language counts rather than counting retained tasks', async () => {
    const h = setup();
    const summary = h.get<HTMLButtonElement>('.subagents-summary');
    assert.match(summary.textContent ?? '', /Subagents/);
    assert.equal(
      summary.querySelector('[data-count="running"]')?.textContent,
      '3',
    );
    assert.equal(
      summary.querySelector('[data-count="completed"]')?.textContent,
      '7',
    );
    assert.equal(summary.querySelector('[data-count="needsAttention"]'), null);
    assert.equal(h.get('.subagents-summary-waiting').hidden, false);
    assert.equal(
      h.get('.subagents-summary-waiting').title,
      liveText('en', 'subagents.summaryWaiting', { count: 2 }),
    );
    assert.equal(
      summary.querySelector('.subagents-bot')?.getAttribute('aria-hidden'),
      'true',
    );
    assert.equal(summary.querySelector('.subagents-arrow'), null);
    assert.doesNotMatch(
      summary.textContent ?? '',
      /Running|Completed|Needs you/,
    );
    assert.equal(
      summary.getAttribute('aria-label'),
      'View subagents: 3 running, 7 completed, 2 waiting for your input.',
    );
    const running = summary.querySelector('[data-count="running"]');
    const completed = summary.querySelector('[data-count="completed"]');
    summary.click();
    await settled();
    assert.deepEqual(h.calls, [['expand']]);
    assert.equal(h.get('.subagents-panel').hidden, true);
    h.update({ language: 'zh-CN' });
    assert.equal(h.get('.subagents-summary'), summary);
    assert.equal(summary.querySelector('[data-count="running"]'), running);
    assert.equal(summary.querySelector('[data-count="completed"]'), completed);
    assert.match(summary.textContent ?? '', /子智能体/);
    assert.doesNotMatch(summary.textContent ?? '', /进行中|已完成|需关注/);
    assert.equal(
      summary.getAttribute('aria-label'),
      liveText('zh-CN', 'subagents.summaryLabel', {
        running: 3,
        completed: 7,
        waiting: 2,
      }),
    );
    assert.equal(summary.title, summary.getAttribute('aria-label'));
    assert.equal(
      summary.getAttribute('aria-label'),
      '查看子智能体：3 项进行中，7 项已完成，2 项等待你处理。',
    );
    assert.equal(
      h.get('.subagents-summary .running').title,
      liveText('zh-CN', 'ui.labelValue', {
        label: liveText('zh-CN', 'subagents.running'),
        value: 3,
      }),
    );
    assert.equal(
      h.get('.subagents-summary .completed').title,
      liveText('zh-CN', 'ui.labelValue', {
        label: liveText('zh-CN', 'subagents.completed'),
        value: 7,
      }),
    );
  });

  it('pulses only for connected active summary counts and hides the waiting marker at zero', () => {
    const empty = snapshot([]);
    empty.counts = {
      running: 0,
      completed: 0,
      needsAttention: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
    };
    const h = setup({}, { snapshot: empty });
    const summary = h.get('.subagents-summary');
    const point = h.get('.subagents-count-symbol.running');
    assert.equal(summary.classList.contains('running-active'), false);
    assert.equal(h.get('.subagents-summary-waiting').hidden, true);
    h.update({
      snapshot: {
        ...empty,
        counts: { ...empty.counts, running: 2, needsAttention: 1 },
      },
    });
    assert.equal(summary.classList.contains('running-active'), true);
    assert.equal(h.get('.subagents-summary-waiting').hidden, false);
    h.update({ connected: false });
    assert.equal(summary.classList.contains('running-active'), false);
    assert.match(summary.title, /Disconnected/);
    h.update({ connected: true, mode: 'list' });
    assert.equal(summary.classList.contains('running-active'), false);
    h.update({ mode: 'summary' });
    assert.equal(summary.classList.contains('running-active'), true);
    h.update({ snapshot: empty });
    assert.equal(summary.classList.contains('running-active'), false);
    assert.equal(h.get('.subagents-summary-waiting').hidden, true);
    assert.equal(h.get('.subagents-count-symbol.running'), point);
  });

  it('keeps large summary numbers compact while titles, accessibility and list counts stay exact', () => {
    const value = snapshot([]);
    value.counts = {
      ...value.counts,
      running: 1_234_567,
      completed: 9_876_543,
      needsAttention: 456,
    };
    const h = setup({}, { snapshot: value });
    const running = h.get('.subagents-summary [data-count="running"]');
    const completed = h.get('.subagents-summary [data-count="completed"]');
    assert.equal(running.textContent, '999+');
    assert.equal(completed.textContent, '999+');
    assert.equal(running.title, 'Running: 1234567');
    assert.equal(completed.title, 'Completed: 9876543');
    assert.equal(
      h.get('.subagents-summary').getAttribute('aria-label'),
      liveText('en', 'subagents.summaryLabel', {
        running: 1_234_567,
        completed: 9_876_543,
        waiting: 456,
      }),
    );
    h.update({ mode: 'list', language: 'zh-CN' });
    assert.equal(
      h.get('.subagents-panel [data-count="running"]').textContent,
      '1234567',
    );
    assert.equal(
      h.get('.subagents-panel [data-count="completed"]').textContent,
      '9876543',
    );
    assert.equal(
      h.get('.subagents-panel [data-count="needsAttention"]').textContent,
      '456',
    );
  });

  it('uses a gentle 1.4 second opacity pulse and disables it for reduced motion', async () => {
    const css = await readFile(
      new URL('../../renderer/subagents.css', import.meta.url),
      'utf8',
    );
    assert.match(
      css,
      /\.subagents-summary\.running-active \.subagents-count-symbol\.running\s*\{\s*animation: subagents-running-pulse 1\.4s ease-in-out infinite;/,
    );
    assert.match(
      css,
      /@keyframes subagents-running-pulse\s*\{[\s\S]*?opacity: 0\.45;[\s\S]*?opacity: 1;/,
    );
    assert.match(
      css,
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.subagents-summary\.running-active \.subagents-count-symbol\.running\s*\{\s*animation: none;/,
    );
    assert.doesNotMatch(
      css,
      /^\.subagents-count-symbol\.running\s*\{[^}]*animation:/m,
    );
    assert.match(
      css,
      /\.subagents-summary-waiting\s*\{[^}]*position: absolute;/,
    );
  });

  it('reports pointer hover separately from keyboard focus and closes with ordered releases', () => {
    const h = setup();
    const summary = h.get<HTMLButtonElement>('.subagents-summary');
    h.app.dispatchEvent(new h.dom.window.Event('pointerenter'));
    h.app.dispatchEvent(new h.dom.window.Event('pointerleave'));
    summary.focus();
    h.app.dispatchEvent(new h.dom.window.Event('pointerleave'));
    summary.blur();
    assert.deepEqual(h.calls, [
      ['hover', true],
      ['keyboard', false],
      ['hover', false],
      ['keyboard', false],
      ['hover', false],
      ['keyboard', false],
      ['hover', false],
      ['keyboard', false],
      ['hover', false],
      ['keyboard', false],
    ]);
    document.dispatchEvent(
      new h.dom.window.KeyboardEvent('keydown', { key: 'Tab' }),
    );
    summary.focus();
    assert.deepEqual(h.calls.slice(-2), [
      ['hover', false],
      ['keyboard', true],
    ]);
    h.app.dispatchEvent(new h.dom.window.Event('pointerleave'));
    assert.deepEqual(h.calls.slice(-2), [
      ['hover', false],
      ['keyboard', true],
    ]);
    summary.dispatchEvent(
      new h.dom.window.Event('pointerdown', { bubbles: true }),
    );
    assert.deepEqual(h.calls.slice(-2), [
      ['hover', false],
      ['keyboard', false],
    ]);
    document.dispatchEvent(
      new h.dom.window.KeyboardEvent('keydown', { key: 'Escape' }),
    );
    assert.deepEqual(h.calls.slice(-3), [
      ['keyboard', false],
      ['hover', false],
      ['close'],
    ]);
  });

  it('does not retain hidden-list keyboard hover after native blur and summary reopen', () => {
    const h = setup({}, { mode: 'list' });
    document.dispatchEvent(
      new h.dom.window.KeyboardEvent('keydown', { key: 'Tab' }),
    );
    h.get<HTMLButtonElement>('.subagents-close').focus();
    assert.deepEqual(h.calls.slice(-2), [
      ['hover', false],
      ['keyboard', true],
    ]);
    h.dom.window.dispatchEvent(new h.dom.window.Event('blur'));
    assert.deepEqual(h.calls.slice(-2), [
      ['hover', false],
      ['keyboard', false],
    ]);
    h.update({ mode: 'summary' });
    h.app.dispatchEvent(new h.dom.window.Event('pointerenter'));
    h.app.dispatchEvent(new h.dom.window.Event('pointerleave'));
    assert.deepEqual(h.calls.slice(-2), [
      ['hover', false],
      ['keyboard', false],
    ]);
  });

  it('switches the same panel from summary through list and detail and uses Back without closing', async () => {
    const h = setup();
    const summary = h.get<HTMLButtonElement>('.subagents-summary');
    const panel = h.get('.subagents-panel');
    const list = h.get('.subagents-list');
    const row = h.get<HTMLButtonElement>('[data-task-id="task-1"]');
    const back = h.get<HTMLButtonElement>('.subagents-back');
    summary.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), ['expand']);
    assert.equal(panel.hidden, true);
    h.update({ mode: 'list' });
    assert.equal(summary.hidden, true);
    assert.equal(panel.hidden, false);
    assert.equal(back.hidden, true);
    list.scrollTop = 41;
    row.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), ['detail', 'task-1']);
    h.update({ mode: 'detail', selectedId: 'task-1' });
    assert.equal(h.get('.subagents-panel'), panel);
    assert.equal(back.hidden, false);
    assert.equal(list.hidden, true);
    assert.equal(h.get('.subagent-detail-body').hidden, false);
    back.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), ['back']);
    assert.equal(h.state.mode, 'detail');
    h.update({ mode: 'list', selectedId: undefined });
    assert.equal(h.get('.subagents-panel'), panel);
    assert.equal(h.get('.subagents-list'), list);
    assert.equal(h.get('[data-task-id="task-1"]'), row);
    assert.equal(list.scrollTop, 41);
    assert.equal(back.hidden, true);
    assert.equal(
      h.calls.some(([call]) => call === 'close'),
      false,
    );
    h.get<HTMLButtonElement>('.subagents-close').click();
    assert.deepEqual(h.calls.slice(-3), [
      ['keyboard', false],
      ['hover', false],
      ['close'],
    ]);
  });

  it('allows Back from disconnected details while remote task-opening actions remain disabled', async () => {
    const h = setup(
      {},
      {
        mode: 'detail',
        selectedId: 'task-1',
        connected: false,
      },
    );
    h.get<HTMLButtonElement>('.subagents-back').click();
    await settled();
    assert.deepEqual(h.calls, [['back']]);
    h.update({ mode: 'list', selectedId: undefined });
    const row = h.get<HTMLButtonElement>('[data-task-id="task-1"]');
    assert.equal(row.disabled, true);
    row.click();
    h.update({ mode: 'summary' });
    const summary = h.get<HTMLButtonElement>('.subagents-summary');
    assert.equal(summary.disabled, true);
    summary.click();
    await settled();
    assert.deepEqual(h.calls, [['back']]);
  });

  it('keeps task rows, click identity, focus and list scroll stable across updates', async () => {
    const first = task({ createdAt: 1_788_790_000_002 });
    const second = task({
      id: 'task-2',
      title: 'Read docs',
      status: 'completed',
    });
    const h = setup({}, { mode: 'list', snapshot: snapshot([first, second]) });
    const list = h.get('.subagents-list');
    const row = h.get<HTMLButtonElement>('[data-task-id="task-1"]');
    list.scrollTop = 53;
    row.focus();
    h.update({
      language: 'zh-CN',
      snapshot: {
        ...snapshot([
          second,
          { ...first, status: 'waiting', activity: 'Need your input' },
        ]),
        revision: 2,
      },
    });
    assert.equal(h.get('[data-task-id="task-1"]'), row);
    assert.equal(document.activeElement, row);
    assert.equal(list.scrollTop, 53);
    assert.equal(list.firstElementChild?.firstElementChild, row);
    assert.match(row.textContent ?? '', /等待输入/);
    assert.match(row.textContent ?? '', /Need your input/);
    row.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), ['detail', first.id]);
    assert.match(h.get('.subagents-other-counts').textContent ?? '', /1 失败/);
    assert.match(h.get('.subagents-retention').textContent ?? '', /4/);
    h.update({ snapshot: snapshot([second]) });
    assert.equal(h.app.querySelector('[data-task-id="task-1"]'), null);
  });

  it('renders public title, request and output as text, not markup, while localizing owned activity', () => {
    const payload =
      '<img src="https://example.com/x" onerror="alert(1)"><script>bad()</script>';
    const entry = task({
      title: payload,
      request: payload,
      output: payload.repeat(80),
      activity: liveMessage('subagents.reconnecting'),
      events: [
        { at: 1, kind: 'message', text: payload },
        { at: 2, kind: 'status', text: liveMessage('subagents.callEnded') },
      ],
      outputTruncated: true,
    });
    const h = setup(
      {},
      { mode: 'detail', selectedId: entry.id, snapshot: snapshot([entry]) },
    );
    const output = h.get('.subagent-output');
    h.update({ language: 'zh-CN' });
    assert.equal(h.get('.subagent-title').textContent, payload);
    assert.equal(h.get('.subagent-request').textContent, payload);
    assert.equal(output.textContent, payload.repeat(80));
    assert.equal(h.app.querySelector('img, script, a'), null);
    assert.equal(
      h.get('.subagent-latest').textContent,
      liveText('zh-CN', 'subagents.reconnecting'),
    );
    assert(
      h
        .get('.subagent-events')
        .textContent?.includes(liveText('zh-CN', 'subagents.callEnded')),
    );
    assert.equal(h.get('.subagent-truncated').hidden, false);
    assert.equal(h.get('.subagent-output'), output);
    assert.equal(
      h.app.querySelector('button[data-cancel], button[data-approve]'),
      null,
    );
  });

  it('keeps notification delivery distinct from task completion and preserves exact statuses', () => {
    const entry = task({
      kind: 'proactive',
      status: 'monitoring',
      triggerCount: 3,
      pendingNotifications: 2,
      notification: 'delivered',
      remainingSec: 4.2,
    });
    const h = setup(
      {},
      { mode: 'detail', selectedId: entry.id, snapshot: snapshot([entry]) },
    );
    assert.equal(
      h.get('.subagent-identity .subagent-status').textContent,
      'Monitoring',
    );
    assert.match(
      h.get('.subagent-notifications').textContent ?? '',
      /Triggers: 3/,
    );
    assert.match(
      h.get('.subagent-notifications').textContent ?? '',
      /Pending announcements: 2/,
    );
    assert(
      h
        .get('.subagent-notifications')
        .textContent?.includes(
          liveText('en', 'subagents.notificationDelivered'),
        ),
    );
    assert.match(
      h.get('.subagent-notifications').textContent ?? '',
      /Remaining: 5s/,
    );
    assert.equal(
      h.get('.subagent-section:last-child h2').textContent,
      liveText('en', 'subagents.output'),
    );
    for (const status of [
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ] as const) {
      h.update({ snapshot: snapshot([{ ...entry, status }]) });
      assert.equal(
        h.get('.subagent-identity .subagent-status').textContent,
        liveText('en', `subagents.${status}`),
      );
      assert.equal(
        h.get('.subagent-section:last-child h2').textContent,
        liveText(
          'en',
          status === 'completed' ? 'subagents.result' : 'subagents.output',
        ),
      );
    }
  });

  it('follows output and activity only from the bottom and retains content and focus on disconnect', () => {
    let entry = task();
    const h = setup(
      {},
      { mode: 'detail', selectedId: entry.id, snapshot: snapshot([entry]) },
    );
    const output = h.get('.subagent-output');
    const events = h.get('.subagent-events');
    const body = h.get('.subagent-detail-body');
    let height = 500;
    for (const node of [output, events, body]) {
      Object.defineProperty(node, 'scrollHeight', {
        configurable: true,
        get: () => height,
      });
      Object.defineProperty(node, 'clientHeight', {
        configurable: true,
        value: 100,
      });
      node.scrollTop = 80;
    }
    output.focus();
    entry = {
      ...entry,
      output: 'more output',
      events: [
        ...entry.events,
        { at: 2, kind: 'message', text: 'more activity' },
      ],
    };
    h.update({ snapshot: snapshot([entry]) });
    for (const node of [output, events, body]) assert.equal(node.scrollTop, 80);
    assert.equal(document.activeElement, output);
    for (const node of [output, events, body]) node.scrollTop = 400;
    entry = {
      ...entry,
      output: 'even more output',
      updatedAt: entry.updatedAt + 1000,
    };
    h.update({ snapshot: snapshot([entry]) });
    for (const node of [output, events, body])
      assert.equal(node.scrollTop, height);
    height = 600;
    h.update({ connected: false });
    assert.equal(h.get('.subagents-notice').hidden, false);
    assert.match(h.get('.subagents-notice').textContent ?? '', /Disconnected/);
    assert.equal(output.textContent, 'even more output');
    assert.equal(document.activeElement, output);
    h.update({
      connected: true,
      selectedId: undefined,
      snapshot: snapshot([]),
    });
    assert.equal(h.get('.subagent-detail-body').hidden, true);
    assert.match(h.get('.subagents-empty').textContent ?? '', /no longer/);
  });

  it('handles empty, unsupported and missing-task states without inventing entries', () => {
    const h = setup({}, { mode: 'list', snapshot: snapshot([]) });
    assert.equal(h.get('.subagents-empty').hidden, false);
    assert.match(
      h.get('.subagents-empty').textContent ?? '',
      /No task details/,
    );
    assert.equal(
      h.get('.subagents-retention').textContent,
      liveText('en', 'subagents.omitted', { count: 4 }),
    );
    h.update({
      snapshot: {
        ...snapshot([]),
        omitted: 0,
        counts: {
          running: 0,
          completed: 0,
          needsAttention: 0,
          failed: 0,
          cancelled: 0,
          interrupted: 0,
        },
      },
    });
    assert.match(
      h.get('.subagents-empty').textContent ?? '',
      /No subagent tasks/,
    );
    assert.equal(h.app.querySelector('[data-task-id]'), null);
    h.update({ snapshot: undefined });
    assert.match(h.get('.subagents-empty').textContent ?? '', /unavailable/);
    h.update({ mode: 'summary' });
    assert.equal(h.get<HTMLButtonElement>('.subagents-summary').disabled, true);
    h.update({ mode: 'detail', selectedId: 'unknown' });
    assert.match(h.get('.subagents-empty').textContent ?? '', /no longer/);
    h.get<HTMLButtonElement>('.subagents-close').click();
    assert.deepEqual(h.calls.at(-1), ['close']);
  });

  it('shows failed opens, suppresses duplicate actions, and does not reopen after close', async () => {
    let rejectOpen: (error: Error) => void = () => {};
    let openings = 0;
    const h = setup({
      expand: () => {
        openings++;
        return new Promise<void>((_resolve, reject) => {
          rejectOpen = reject;
        });
      },
    });
    const summary = h.get<HTMLButtonElement>('.subagents-summary');
    summary.click();
    summary.click();
    assert.equal(openings, 1);
    rejectOpen(new Error(liveMessage('subagents.openFailed')));
    await settled();
    assert.equal(summary.disabled, false);
    assert.equal(h.get('.subagents-summary-error').hidden, false);
    h.update({ language: 'zh-CN' });
    assert.equal(
      h.get('.subagents-summary-error').textContent,
      liveText('zh-CN', 'subagents.openFailed'),
    );
    summary.click();
    document.dispatchEvent(
      new h.dom.window.KeyboardEvent('keydown', { key: 'Escape' }),
    );
    rejectOpen(new Error('late failure'));
    await settled();
    assert.deepEqual(h.calls.at(-1), ['close']);
    assert.equal(h.app.textContent?.includes('late failure'), false);
  });

  it('isolates media and scripts and makes expanded-panel headers draggable without dragging controls', async () => {
    const [html, css] = await Promise.all([
      readFile(
        new URL('../../renderer/subagents.html', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL('../../renderer/subagents.css', import.meta.url),
        'utf8',
      ),
    ]);
    assert.match(html, /connect-src 'none'; media-src 'none'/);
    assert.match(html, /script-src 'self'/);
    assert.match(css, /\.subagents-header\s*\{\s*-webkit-app-region: drag;/);
    assert.match(css, /button\s*\{[^}]*-webkit-app-region: no-drag;/);
    assert.match(css, /\.subagent-output\s*\{[^}]*overflow-y: auto;/);
    assert.match(css, /\.subagent-task-title\s*\{[^}]*height: 18px;/);
    assert.match(css, /\.subagent-task-activity\s*\{[^}]*height: 16px;/);
    assert.match(
      css,
      /\.subagent-task > \.subagent-status\s*\{[^}]*height: 16px;/,
    );
  });
});
