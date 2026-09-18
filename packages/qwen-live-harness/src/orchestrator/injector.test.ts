/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector } from './injector.js';
import type { InjectorItem, InjectorSink } from './injector.js';

const QUIET_GAP_MS = 800;

class FakeSink implements InjectorSink {
  contextCalls: string[] = [];
  speechCalls: string[] = [];
  permissionCalls: string[] = [];
  taskResultCalls: string[] = [];
  peerReportCalls: string[] = [];
  searchResultCalls: Array<{ text: string; searchId?: string }> = [];
  injected: Array<{ item: InjectorItem; spoken: boolean }> = [];
  contextResult = true;
  speechResult = true;
  peerReportResult = true;
  searchResultResult = true;

  injectContext(text: string): boolean {
    this.contextCalls.push(text);
    return this.contextResult;
  }

  injectSpeech(text: string): boolean {
    this.speechCalls.push(text);
    return this.speechResult;
  }

  injectPermission(text: string): boolean {
    this.permissionCalls.push(text);
    return true;
  }

  injectTaskResult(text: string): boolean {
    this.taskResultCalls.push(text);
    return true;
  }

  injectPeerReport(text: string): boolean {
    this.peerReportCalls.push(text);
    return this.peerReportResult;
  }

  injectSearchResult(text: string, searchId?: string): boolean {
    this.searchResultCalls.push({ text, ...(searchId ? { searchId } : {}) });
    return this.searchResultResult;
  }

  onInjected(item: InjectorItem, spoken: boolean): void {
    this.injected.push({ item, spoken });
  }
}

function complete(context: string, spoken?: string): InjectorItem {
  return { kind: 'complete', context, ...(spoken ? { spoken } : {}) };
}

let sink: FakeSink;
let injector: Injector;

function makeInjector(options?: {
  quietGapMs?: number;
  progressThrottleMs?: number;
}): Injector {
  injector = new Injector({
    sink,
    now: () => Date.now(),
    ...(options?.quietGapMs !== undefined
      ? { quietGapMs: options.quietGapMs }
      : {}),
    ...(options?.progressThrottleMs !== undefined
      ? { progressThrottleMs: options.progressThrottleMs }
      : {}),
  });
  return injector;
}

beforeEach(() => {
  vi.useFakeTimers();
  // Far past the initial playbackDeadline (0) + quiet gap: window starts open.
  vi.setSystemTime(1_000_000);
  sink = new FakeSink();
  makeInjector();
});

afterEach(() => {
  injector.dispose();
  vi.useRealTimers();
});

describe('Injector context budget', () => {
  // Mirrors MAX_CONTEXT_CHARS in injector.ts.
  const BUDGET = 6_000;

  it('defers whole items past the budget instead of slicing them away', () => {
    // A backend turn detail can run far past one injection's budget. Slicing
    // the joined batch would drop everything after it with no trace, while
    // still reporting those items delivered.
    const big = complete('B'.repeat(BUDGET));
    const after = complete('[COMPLETE job_2] second task finished');
    injector.noteSpeechStarted();
    injector.enqueue(big);
    injector.enqueue(after);
    injector.noteInputCommitted();

    // Two injections, both whole. Before this, the joined slice kept the
    // first and silently swallowed the second while still reporting it
    // delivered.
    expect(sink.contextCalls).toEqual([big.context, after.context]);
    expect(sink.injected.map((entry) => entry.item)).toEqual([big, after]);
  });

  it('does not speak for an item whose context was deferred', () => {
    // Speaking about a result the model has no context for is the exact
    // "claimed without evidence" failure the instructions warn against —
    // and the line would then be spoken a second time when the deferred
    // item really lands.
    const big = complete('B'.repeat(BUDGET), 'The first task finished.');
    const after = complete('[COMPLETE job_2] lint done', 'Lint finished.');
    injector.noteSpeechStarted();
    injector.enqueue(big);
    injector.enqueue(after);
    injector.noteInputCommitted();

    expect(sink.contextCalls).toEqual([big.context, after.context]);
    expect(sink.speechCalls).toEqual([
      'The first task finished.',
      'Lint finished.',
    ]);
    // Exactly once each, in step with the context that backs it.
    expect(
      sink.speechCalls.filter((line) => line === 'Lint finished.'),
    ).toHaveLength(1);
  });

  it('truncates a lone oversized item rather than wedging the lane', () => {
    const huge = complete('H'.repeat(BUDGET * 3));
    injector.enqueue(huge);

    expect(sink.contextCalls).toHaveLength(1);
    expect(sink.contextCalls[0]).toHaveLength(BUDGET);
    expect(sink.contextCalls[0]?.endsWith('…')).toBe(true);
    expect(sink.injected.map((entry) => entry.item)).toEqual([huge]);
    expect(injector.pendingCount).toBe(0);
  });

  it('keeps a permission ask whole when a large completion shares the batch', () => {
    const permission: InjectorItem = {
      kind: 'permission',
      requestId: 'acp:perm-1',
      context: '[PERMISSION req_1] Session session_1 wants to run: rm -rf /a',
    };
    const big = complete('B'.repeat(BUDGET));
    injector.noteSpeechStarted();
    injector.enqueue(big);
    injector.enqueue(permission);
    injector.noteInputCommitted();

    // Permissions have an independent lane, never a size-capped batch.
    expect(sink.permissionCalls).toEqual([permission.context]);
  });
});

describe('Injector permission questions', () => {
  const permission: InjectorItem = {
    kind: 'permission',
    requestId: 'acp:perm-1',
    context: '[PERMISSION] {"request_id":"req_1","action":"Run command"}',
    spoken: 'Legacy English must never be read.',
  };

  it('retains interrupted approval context silently without blocking later results', () => {
    injector.enqueue({ ...permission, announce: false });
    injector.enqueue(complete('later result', 'Task finished.'));
    expect(sink.contextCalls).toEqual([permission.context, 'later result']);
    expect(sink.permissionCalls).toEqual([]);
    expect(sink.speechCalls).toEqual(['Task finished.']);
    expect(sink.injected[0]?.spoken).toBe(false);
    expect(injector.pendingCount).toBe(0);
  });

  it('keeps a silent permission queued on refusal and allows retraction', () => {
    sink.contextResult = false;
    injector.enqueue({ ...permission, announce: false });
    expect(injector.pendingCount).toBe(1);
    expect(sink.permissionCalls).toEqual([]);
    injector.retractPermission(permission.requestId!);
    sink.contextResult = true;
    vi.advanceTimersByTime(QUIET_GAP_MS);
    expect(injector.pendingCount).toBe(0);
    expect(sink.permissionCalls).toEqual([]);
    expect(sink.contextCalls).toHaveLength(1);
  });

  it('reserves a distinct response so progress cannot replace the question', () => {
    injector.enqueue(permission);
    injector.enqueue(complete('result evidence', 'Task finished.'));
    expect(sink.permissionCalls).toEqual([permission.context]);
    expect(sink.contextCalls).toEqual([]);
    expect(sink.speechCalls).toEqual([]);
    injector.noteResponseCreated('permission');
    injector.notePlaybackStarted();
    injector.noteResponseDone('permission');
    expect(sink.speechCalls).toEqual([]);
    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(QUIET_GAP_MS);
    expect(sink.speechCalls).toEqual(['Task finished.']);
  });

  it('retries refusal without falling back to verbatim speech or losing the request', () => {
    const inject = vi
      .spyOn(sink, 'injectPermission')
      .mockReturnValueOnce(false);
    injector.enqueue(permission);
    expect(injector.pendingCount).toBe(1);
    expect(sink.speechCalls).toEqual([]);
    vi.advanceTimersByTime(QUIET_GAP_MS);
    expect(inject).toHaveBeenCalledTimes(2);
    expect(injector.pendingCount).toBe(0);
    expect(sink.permissionCalls).toEqual([permission.context]);
  });

  it('merges a held question on input commit and reopens after a failed request', () => {
    injector.noteSpeechStarted();
    injector.enqueue(permission);
    injector.noteInputCommitted(true);
    expect(sink.permissionCalls).toEqual([permission.context]);
    expect(sink.injected).toEqual([{ item: permission, spoken: false }]);
    injector.noteResponseCreated('direct');
    injector.noteResponseDone('direct');
    injector.enqueue(permission);
    injector.enqueue(complete('later context'));
    expect(injector.pendingCount).toBe(1);
    injector.noteResponseDone('permission');
    expect(sink.contextCalls).toEqual(['later context']);
  });
});

describe('Injector structured task outcomes', () => {
  const outcome: InjectorItem = {
    kind: 'task_result',
    context: '[COMPLETE job_1] {"status":"completed"}',
    spoken: 'The task to old code finished.',
  };
  it('reserves a model response and playback slot for each outcome without generic speech', () => {
    injector.enqueue(outcome);
    injector.enqueue({
      ...outcome,
      context: '[ERROR job_2] {"status":"failed"}',
    });
    expect(sink.taskResultCalls).toEqual([outcome.context]);
    expect(sink.speechCalls).toEqual([]);
    expect(sink.contextCalls).toEqual([]);
    injector.noteResponseCreated('task_result');
    injector.notePlaybackStarted();
    injector.noteResponseDone('task_result');
    expect(sink.taskResultCalls).toHaveLength(1);
    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(QUIET_GAP_MS);
    expect(sink.taskResultCalls).toHaveLength(2);
  });
  it('keeps the full result queued on refusal, and merges it with a pending real user reply', () => {
    const inject = vi
      .spyOn(sink, 'injectTaskResult')
      .mockReturnValueOnce(false);
    injector.enqueue(outcome);
    expect(injector.pendingCount).toBe(1);
    injector.noteSpeechStarted();
    injector.noteInputCommitted(true);
    expect(inject).toHaveBeenCalledTimes(2);
    expect(sink.injected).toEqual([{ item: outcome, spoken: false }]);
    expect(sink.speechCalls).toEqual([]);
  });
});

describe('Injector transport recovery barrier', () => {
  const question: InjectorItem = {
    kind: 'permission',
    requestId: 'p1',
    context: 'pending permission',
  };
  it('freezes every notification and clears stale speech/response state before a no-input recovery', () => {
    injector.noteSpeechStarted();
    injector.noteResponseCreated('direct');
    injector.enqueue(question);
    injector.beginTransportRecovery();
    injector.enqueue(complete('result', 'result'));
    injector.noteResponseDone('direct');
    injector.noteOutputCleared();
    expect(sink.permissionCalls).toEqual([]);
    injector.completeTransportRecovery('none');
    expect(sink.permissionCalls).toEqual(['pending permission']);
    injector.noteResponseCreated('permission');
    injector.noteResponseDone('permission');
    vi.advanceTimersByTime(QUIET_GAP_MS);
    expect(sink.speechCalls).toEqual(['result']);
  });
  it('keeps resumed user text ahead of queued permissions until its real response finishes', () => {
    injector.beginTransportRecovery();
    injector.enqueue(question);
    injector.completeTransportRecovery('text');
    injector.noteInputCommitted(true);
    expect(sink.permissionCalls).toEqual([]);
    injector.noteResponseCreated('direct');
    expect(sink.permissionCalls).toEqual([]);
    injector.noteResponseDone('direct');
    expect(sink.permissionCalls).toEqual(['pending permission']);
  });
  it('does not block forever when restored audio produces no VAD, but honors an actual long utterance', () => {
    injector.beginTransportRecovery();
    injector.enqueue(question);
    injector.completeTransportRecovery('audio');
    vi.advanceTimersByTime(7_999);
    expect(sink.permissionCalls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sink.permissionCalls).toEqual(['pending permission']);
    injector.beginTransportRecovery();
    injector.enqueue({ ...question, requestId: 'p2', context: 'second' });
    injector.completeTransportRecovery('audio');
    injector.noteSpeechStarted();
    vi.advanceTimersByTime(30_000);
    expect(sink.permissionCalls).toHaveLength(1);
    injector.noteInputCommitted(true);
    injector.noteResponseCreated('direct');
    injector.noteResponseDone('direct');
    expect(sink.permissionCalls).toEqual(['pending permission', 'second']);
  });
  it('restores only unfinished proactive deliveries ahead of newer queued events', () => {
    const first: InjectorItem = {
      kind: 'proactive',
      context: 'first',
      deliveryId: 'd1',
    };
    const second: InjectorItem = {
      kind: 'proactive',
      context: 'second',
      deliveryId: 'd2',
    };
    const proactive = vi.fn((_text: string) => true);
    injector.dispose();
    injector = new Injector({
      sink: {
        ...sink,
        injectContext: () => true,
        injectSpeech: () => true,
        injectProactive: proactive,
      },
    });
    injector.enqueue(first);
    injector.enqueue(second);
    injector.beginTransportRecovery();
    injector.restoreProactiveAfterRecovery([first]);
    injector.completeTransportRecovery('none');
    expect(proactive.mock.calls.map(([text]) => text)).toEqual([
      'first',
      'first',
    ]);
    injector.noteResponseCreated('proactive');
    injector.notePlaybackStarted();
    injector.noteResponseDone('proactive');
    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(QUIET_GAP_MS);
    expect(proactive.mock.calls.map(([text]) => text)).toEqual([
      'first',
      'first',
      'second',
    ]);
  });
});

describe('Injector asynchronous search results', () => {
  function result(searchId: string, answer = searchId): InjectorItem {
    return {
      kind: 'search_result',
      searchId,
      context: JSON.stringify({
        query: `Question ${searchId}`,
        answer,
        searchStatus: 'performed',
      }),
    };
  }

  function completeSearch(): void {
    injector.noteResponseCreated('search_result');
    injector.notePlaybackStarted();
    injector.noteResponseDone('search_result');
    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(QUIET_GAP_MS);
  }

  it('uses only the specialized sink and preserves a large evidence payload', () => {
    const item = result('large', 'x'.repeat(20_000));
    injector.enqueue(item);
    expect(sink.searchResultCalls).toEqual([
      { text: item.context, searchId: 'large' },
    ]);
    expect(sink.contextCalls).toEqual([]);
    expect(sink.speechCalls).toEqual([]);
    expect(sink.peerReportCalls).toEqual([]);
    expect(sink.injected).toEqual([{ item, spoken: true }]);
  });

  it('keeps deferred ordinary items and full search evidence separate in a mixed queue', () => {
    const huge = complete('[COMPLETE job_1] ' + 'B'.repeat(12_000));
    const deferred = complete('[COMPLETE job_2] Deferred ordinary result.');
    const search = result('mixed', 'S'.repeat(20_000));
    const after = complete('[COMPLETE job_3] After search.', 'After search.');
    injector.noteSpeechStarted();
    for (const item of [huge, deferred, search, after]) injector.enqueue(item);
    injector.noteInputCommitted();

    expect(sink.contextCalls).toHaveLength(2);
    expect(sink.contextCalls[0]).toHaveLength(6_000);
    expect(sink.contextCalls[0]?.startsWith('[COMPLETE job_1] ')).toBe(true);
    expect(sink.contextCalls[0]?.endsWith('…')).toBe(true);
    expect(sink.contextCalls[1]).toBe(deferred.context);
    expect(sink.searchResultCalls).toEqual([
      { text: search.context, searchId: 'mixed' },
    ]);
    expect(sink.speechCalls).toEqual([]);
    expect(sink.injected.map(({ item }) => item)).toEqual([
      huge,
      deferred,
      search,
    ]);
    expect(injector.pendingCount).toBe(1);

    completeSearch();
    expect(sink.contextCalls.at(-1)).toBe(after.context);
    expect(sink.speechCalls).toEqual(['After search.']);
    expect(sink.injected.map(({ item }) => item)).toEqual([
      huge,
      deferred,
      search,
      after,
    ]);
    expect(injector.pendingCount).toBe(0);
  });

  it('waits through a new user turn, its direct response and Host quiet gap', () => {
    injector.noteSpeechStarted();
    injector.enqueue(result('one'));
    injector.noteInputCommitted(true);
    expect(sink.searchResultCalls).toEqual([]);
    injector.noteResponseCreated('direct');
    injector.notePlaybackStarted();
    injector.noteResponseDone('direct');
    expect(sink.searchResultCalls).toEqual([]);
    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(QUIET_GAP_MS - 1);
    expect(sink.searchResultCalls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sink.searchResultCalls.map((item) => item.searchId)).toEqual([
      'one',
    ]);
  });

  it.each(['response-before-playback-start', 'playback-before-response-done'])(
    'keeps completion-arrival order and waits for real playback (%s)',
    (order) => {
      injector.enqueue(result('finished-second-task-first'));
      injector.enqueue(result('finished-first-task-second'));
      injector.noteResponseCreated('search_result');
      if (order === 'response-before-playback-start') {
        injector.noteResponseDone('search_result');
        vi.advanceTimersByTime(2 * QUIET_GAP_MS);
        expect(sink.searchResultCalls).toHaveLength(1);
        injector.notePlaybackStarted();
        injector.notePlaybackCompleted();
      } else {
        injector.notePlaybackStarted();
        injector.notePlaybackCompleted();
        vi.advanceTimersByTime(2 * QUIET_GAP_MS);
        expect(sink.searchResultCalls).toHaveLength(1);
        injector.noteResponseDone('search_result');
      }
      vi.advanceTimersByTime(QUIET_GAP_MS);
      expect(sink.searchResultCalls.map((item) => item.searchId)).toEqual([
        'finished-second-task-first',
        'finished-first-task-second',
      ]);
    },
  );

  it('coexists with control, peer and proactive items without mixing evidence', () => {
    injector.noteSpeechStarted();
    injector.enqueue(result('one'));
    injector.enqueue({
      kind: 'control',
      controlId: 'control',
      context: 'Control',
    });
    injector.enqueue({
      kind: 'peer_report',
      reportId: 'peer',
      context: 'Peer',
    });
    injector.enqueue({
      kind: 'proactive',
      deliveryId: 'proactive',
      context: 'Proactive',
    });
    injector.enqueue(result('two'));
    injector.noteInputCommitted();
    expect(sink.searchResultCalls).toHaveLength(1);
    completeSearch();
    expect(sink.contextCalls).toEqual(['Control']);
    expect(sink.peerReportCalls).toEqual(['Peer']);
    injector.noteResponseCreated('peer_report');
    injector.noteResponseDone('peer_report');
    expect(sink.speechCalls).toEqual(['Proactive']);
    injector.noteResponseCreated('proactive');
    injector.notePlaybackStarted();
    injector.notePlaybackCompleted();
    injector.noteResponseDone('proactive');
    vi.advanceTimersByTime(QUIET_GAP_MS);
    expect(sink.searchResultCalls.map((item) => item.searchId)).toEqual([
      'one',
      'two',
    ]);
    expect(sink.injected.map(({ item }) => item.kind)).toEqual([
      'search_result',
      'control',
      'peer_report',
      'proactive',
      'search_result',
    ]);
  });

  it('retracts exact queued results and drops remaining search speech only', () => {
    injector.noteSpeechStarted();
    injector.enqueue(result('one'));
    injector.enqueue(result('two'));
    injector.enqueue({ kind: 'control', controlId: 'keep', context: 'Keep' });
    expect(injector.retractSearchResult('one')).toBe(true);
    expect(injector.retractSearchResult('missing')).toBe(false);
    expect(injector.dropSearchResults()).toEqual(['two']);
    injector.enqueue(result('one'));
    injector.enqueue(result('two'));
    injector.noteInputCommitted();
    expect(sink.searchResultCalls).toEqual([]);
    expect(sink.contextCalls).toEqual(['Keep']);
  });

  it('deduplicates a result while queued, submitted and after playback', () => {
    injector.noteSpeechStarted();
    injector.enqueue(result('one'));
    injector.enqueue(result('one'));
    expect(injector.pendingCount).toBe(1);
    injector.noteInputCommitted();
    injector.enqueue(result('one'));
    completeSearch();
    injector.enqueue(result('one'));
    expect(sink.searchResultCalls).toHaveLength(1);
    expect(injector.pendingCount).toBe(0);
  });

  it('does not replay an interrupted submission or inject the next result into the new turn', () => {
    injector.enqueue(result('one'));
    injector.enqueue(result('two'));
    injector.noteResponseCreated('search_result');
    injector.notePlaybackStarted();
    injector.noteSpeechStarted();
    injector.noteOutputCleared();
    injector.noteResponseDone('search_result');
    injector.noteInputCommitted(true);
    expect(sink.searchResultCalls).toHaveLength(1);
    injector.noteResponseCreated('direct');
    injector.noteResponseDone('direct');
    expect(sink.searchResultCalls.map((item) => item.searchId)).toEqual([
      'one',
      'two',
    ]);
  });

  it('requires explicit suppression to release a silent or failed search response', () => {
    injector.enqueue(result('one'));
    injector.enqueue(result('two'));
    injector.noteResponseDone('search_result');
    vi.advanceTimersByTime(2 * QUIET_GAP_MS);
    expect(sink.searchResultCalls).toHaveLength(1);
    injector.noteOutputSuppressed();
    expect(sink.searchResultCalls).toHaveLength(2);
  });

  it('waits for response completion when output is suppressed first', () => {
    injector.enqueue(result('one'));
    injector.enqueue(result('two'));
    injector.noteResponseCreated('search_result');
    injector.noteOutputSuppressed();
    expect(sink.searchResultCalls).toHaveLength(1);
    injector.noteResponseDone('search_result');
    expect(sink.searchResultCalls).toHaveLength(2);
  });

  it('retries a refused result without acknowledging it or falling back to another sink', () => {
    sink.searchResultResult = false;
    injector.enqueue(result('one'));
    expect(injector.pendingCount).toBe(1);
    expect(sink.injected).toEqual([]);
    expect(sink.contextCalls).toEqual([]);
    expect(sink.speechCalls).toEqual([]);
    sink.searchResultResult = true;
    vi.advanceTimersByTime(QUIET_GAP_MS);
    expect(sink.injected).toHaveLength(1);
    expect(injector.pendingCount).toBe(0);
  });

  it('keeps later results when a sink synchronously retracts the submitted entry', () => {
    const original = sink.injectSearchResult.bind(sink);
    sink.injectSearchResult = (text, searchId) => {
      if (searchId === 'one') injector.retractSearchResult('one');
      return original(text, searchId);
    };
    injector.noteSpeechStarted();
    injector.enqueue(result('one'));
    injector.enqueue(result('two'));
    injector.noteInputCommitted();
    expect(injector.pendingCount).toBe(1);
    completeSearch();
    expect(sink.searchResultCalls.map((item) => item.searchId)).toEqual([
      'one',
      'two',
    ]);
  });

  it('does not route through another sink if the search sink is absent', () => {
    injector.dispose();
    injector = new Injector({
      sink: {
        injectContext: (text) => sink.injectContext(text),
        injectSpeech: (text) => sink.injectSpeech(text),
      },
    });
    injector.enqueue(result('one'));
    vi.advanceTimersByTime(QUIET_GAP_MS);
    expect(injector.pendingCount).toBe(1);
    expect(sink.contextCalls).toEqual([]);
    expect(sink.speechCalls).toEqual([]);
  });

  it('disposes queued results without late callbacks into a later conversation', () => {
    sink.searchResultResult = false;
    injector.enqueue(result('one'));
    injector.dispose();
    sink.searchResultResult = true;
    vi.advanceTimersByTime(QUIET_GAP_MS);
    expect(sink.injected).toEqual([]);
    expect(injector.enqueue(result('two'))).toBe(false);
  });
});

describe('Injector external peer reports', () => {
  function report(id: string): InjectorItem {
    return { kind: 'peer_report', reportId: id, context: `External ${id}` };
  }

  it('uses the report sink only, with no persistent context or ordinary speech', () => {
    injector.enqueue(report('one'));
    expect(sink.peerReportCalls).toEqual(['External one']);
    expect(sink.contextCalls).toEqual([]);
    expect(sink.speechCalls).toEqual([]);
    expect(sink.injected).toEqual([{ item: report('one'), spoken: true }]);
  });

  it('keeps reports separate from ordinary and proactive items', () => {
    injector.noteSpeechStarted();
    injector.enqueue(complete('Before'));
    injector.enqueue(report('one'));
    injector.enqueue(complete('After'));
    injector.enqueue({ kind: 'proactive', context: 'Scheduled' });
    injector.noteInputCommitted();
    expect(sink.contextCalls).toEqual(['Before']);
    expect(sink.peerReportCalls).toEqual(['External one']);
    expect(sink.speechCalls).toEqual([]);
    injector.noteResponseCreated('peer_report');
    injector.noteResponseDone('peer_report');
    expect(sink.contextCalls).toEqual(['Before', 'After']);
    expect(sink.speechCalls).toEqual(['Scheduled']);
  });

  it('holds through user input, direct response acknowledgement and Host playback', () => {
    injector.noteSpeechStarted();
    injector.enqueue(report('one'));
    injector.noteInputCommitted(true);
    expect(sink.peerReportCalls).toEqual([]);
    injector.noteResponseCreated('direct');
    injector.notePlaybackStarted();
    injector.noteResponseDone('direct');
    expect(sink.peerReportCalls).toEqual([]);
    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(QUIET_GAP_MS - 1);
    expect(sink.peerReportCalls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sink.peerReportCalls).toEqual(['External one']);
  });

  it('waits for an ordinary speech request to be acknowledged', () => {
    injector.enqueue(complete('Result', 'Result ready.'));
    injector.enqueue(report('one'));
    expect(sink.peerReportCalls).toEqual([]);
    injector.noteResponseCreated('backend_speech');
    injector.noteResponseDone('backend_speech');
    expect(sink.peerReportCalls).toEqual(['External one']);
  });

  it.each(['response-first', 'playback-first'])(
    'submits one report per response and waits for both receipts (%s)',
    (order) => {
      injector.enqueue(report('one'));
      injector.enqueue(report('two'));
      expect(sink.peerReportCalls).toEqual(['External one']);
      injector.noteResponseCreated('peer_report');
      injector.notePlaybackStarted();
      if (order === 'response-first') {
        injector.noteResponseDone('peer_report');
        vi.advanceTimersByTime(2 * QUIET_GAP_MS);
        expect(sink.peerReportCalls).toEqual(['External one']);
        injector.notePlaybackCompleted();
      } else {
        injector.notePlaybackCompleted();
        vi.advanceTimersByTime(2 * QUIET_GAP_MS);
        expect(sink.peerReportCalls).toEqual(['External one']);
        injector.noteResponseDone('peer_report');
      }
      vi.advanceTimersByTime(QUIET_GAP_MS);
      expect(sink.peerReportCalls).toEqual(['External one', 'External two']);
    },
  );

  it('retries refusal without acknowledging or falling back to another sink', () => {
    sink.peerReportResult = false;
    injector.enqueue(report('one'));
    expect(injector.pendingCount).toBe(1);
    expect(sink.injected).toEqual([]);
    expect(sink.contextCalls).toEqual([]);
    expect(sink.speechCalls).toEqual([]);
    sink.peerReportResult = true;
    vi.advanceTimersByTime(QUIET_GAP_MS);
    expect(injector.pendingCount).toBe(0);
    expect(sink.injected).toHaveLength(1);
  });

  it('fails closed when the specialized report sink is unavailable', () => {
    injector.dispose();
    injector = new Injector({
      sink: {
        injectContext: (text) => sink.injectContext(text),
        injectSpeech: (text) => sink.injectSpeech(text),
      },
    });
    injector.enqueue(report('one'));
    vi.advanceTimersByTime(QUIET_GAP_MS);
    expect(injector.pendingCount).toBe(1);
    expect(sink.contextCalls).toEqual([]);
    expect(sink.speechCalls).toEqual([]);
  });

  it('bounds only the report lane and deduplicates accepted report identities', () => {
    injector.noteSpeechStarted();
    for (let index = 0; index < 32; index += 1) {
      expect(injector.enqueue(report(String(index)))).toBe(true);
    }
    expect(injector.enqueue(report('0'))).toBe(true);
    expect(injector.enqueue(report('overflow'))).toBe(false);
    expect(injector.enqueue(complete('Ordinary'))).toBe(true);
    expect(injector.pendingCount).toBe(33);
    injector.noteInputCommitted();
    expect(injector.enqueue(report('0'))).toBe(true);
    expect(injector.pendingCount).toBe(32);
    expect(injector.enqueue(report('overflow'))).toBe(true);
    expect(injector.pendingCount).toBe(33);
    injector.noteResponseCreated('peer_report');
    injector.noteResponseDone('peer_report');
    expect(injector.enqueue(report('0'))).toBe(true);
    expect(sink.peerReportCalls).toEqual(['External 0', 'External 1']);
  });

  it('releases silent or failed reports without a playback receipt', () => {
    injector.enqueue(report('one'));
    injector.enqueue(report('two'));
    // response.created may never arrive when the request times out.
    injector.noteResponseDone('peer_report');
    expect(sink.peerReportCalls).toEqual(['External one', 'External two']);
    injector.enqueue(report('three'));
    injector.noteResponseCreated('peer_report');
    injector.noteResponseDone('peer_report');
    expect(sink.peerReportCalls).toEqual([
      'External one',
      'External two',
      'External three',
    ]);
  });

  it('drops an interrupted submitted report and preserves unsent reports', () => {
    injector.enqueue(report('one'));
    injector.enqueue(report('two'));
    injector.noteResponseCreated('peer_report');
    injector.notePlaybackStarted();
    injector.noteSpeechStarted();
    injector.noteOutputCleared();
    injector.noteResponseDone('peer_report');
    expect(sink.peerReportCalls).toEqual(['External one']);
    injector.noteInputCommitted(true);
    injector.noteResponseCreated('direct');
    injector.noteResponseDone('direct');
    expect(sink.peerReportCalls).toEqual(['External one', 'External two']);
  });

  it('releases suppressed output only after the report response finishes', () => {
    injector.enqueue(report('one'));
    injector.enqueue(report('two'));
    injector.noteResponseCreated('peer_report');
    injector.notePlaybackStarted();
    injector.noteOutputSuppressed();
    expect(sink.peerReportCalls).toEqual(['External one']);
    injector.noteResponseDone('peer_report');
    expect(sink.peerReportCalls).toEqual(['External one', 'External two']);
  });

  it('disposes queued reports without later callbacks', () => {
    sink.peerReportResult = false;
    injector.enqueue(report('one'));
    injector.dispose();
    sink.peerReportResult = true;
    vi.advanceTimersByTime(QUIET_GAP_MS);
    expect(injector.pendingCount).toBe(0);
    expect(sink.injected).toEqual([]);
    expect(injector.enqueue(report('two'))).toBe(false);
  });
});

describe('Injector window conditions', () => {
  it('drains thousands of independent control receipts without recursive stack growth', () => {
    injector.noteSpeechStarted();
    for (let index = 0; index < 10_000; index += 1) {
      injector.enqueue({
        kind: 'control',
        controlId: String(index),
        context: `receipt ${index}`,
      });
      if (index % 100 === 0) injector.enqueue(complete(`ordinary ${index}`));
    }
    expect(() => injector.noteInputCommitted()).not.toThrow();
    expect(injector.pendingCount).toBe(0);
    const receipts = sink.contextCalls.filter((text) =>
      text.startsWith('receipt'),
    );
    expect(receipts).toHaveLength(10_000);
    expect(receipts[0]).toBe('receipt 0');
    expect(receipts.at(-1)).toBe('receipt 9999');
    expect(
      sink.injected.filter(({ item }) => item.kind === 'control'),
    ).toHaveLength(10_000);
  });

  it('delivers control receipts separately and completely beyond the ordinary batch cap', () => {
    injector.noteSpeechStarted();
    const first = 'A'.repeat(7_000);
    const second = 'B'.repeat(7_000);
    injector.enqueue({
      kind: 'control',
      controlId: 'one',
      context: first,
      spoken: 'must not speak',
    });
    injector.enqueue({ kind: 'control', controlId: 'one', context: first });
    injector.enqueue({ kind: 'control', controlId: 'two', context: second });
    expect(injector.pendingCount).toBe(2);
    injector.noteInputCommitted(true);
    expect(sink.contextCalls).toEqual([]);
    injector.noteResponseCreated('direct');
    injector.noteResponseDone('direct');
    expect(sink.contextCalls).toEqual([first, second]);
    expect(sink.speechCalls).toEqual([]);
    expect(sink.injected.map((entry) => entry.spoken)).toEqual([false, false]);
  });

  it('does not acknowledge a control receipt through speech-only acceptance', () => {
    sink.contextResult = false;
    sink.speechResult = true;
    injector.enqueue({
      kind: 'control',
      controlId: 'one',
      context: 'Complete owned text',
      spoken: 'speech',
    });
    expect(sink.injected).toEqual([]);
    expect(sink.speechCalls).toEqual([]);
    expect(injector.pendingCount).toBe(1);
    sink.contextResult = true;
    vi.advanceTimersByTime(QUIET_GAP_MS);
    expect(sink.injected).toHaveLength(1);
    expect(sink.injected[0]?.item.context).toBe('Complete owned text');
    expect(injector.pendingCount).toBe(0);
  });

  it('deduplicates a replayed permission while its ask is queued', () => {
    injector.noteSpeechStarted();
    const permission: InjectorItem = {
      kind: 'permission',
      requestId: 'r1',
      context: '[PERMISSION req_1] allow?',
      spoken: 'Should I allow it?',
    };

    injector.enqueue(permission);
    injector.enqueue(permission);
    expect(injector.pendingCount).toBe(1);

    injector.noteInputCommitted();
    expect(sink.permissionCalls).toEqual(['[PERMISSION req_1] allow?']);
    expect(sink.speechCalls).toEqual([]);
  });

  it('holds items through speech stop and delivers on input commit', () => {
    injector.noteSpeechStarted();
    injector.enqueue(complete('tests passed'));

    expect(sink.contextCalls).toEqual([]);
    expect(injector.pendingCount).toBe(1);

    injector.noteInputCommitted();

    expect(sink.contextCalls).toEqual(['tests passed']);
    expect(injector.pendingCount).toBe(0);
  });

  it('reports playback in progress when user speech starts', () => {
    injector.notePlaybackStarted();

    expect(injector.noteSpeechStarted()).toBe(true);
    injector.noteOutputCleared();
    expect(injector.noteSpeechStarted()).toBe(false);
  });

  it('drops the quiet gap when speech starts after playback completes', () => {
    injector.notePlaybackStarted();
    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(100);

    expect(injector.noteSpeechStarted()).toBe(false);
    injector.enqueue(complete('arrived while speaking', 'Result ready.'));
    injector.noteInputCommitted();

    expect(sink.contextCalls).toEqual(['arrived while speaking']);
    expect(sink.speechCalls).toEqual(['Result ready.']);
    expect(injector.pendingCount).toBe(0);
  });

  it('holds items while a realtime response is in flight and delivers on done', () => {
    injector.noteResponseCreated();
    injector.enqueue(complete('build finished'));

    expect(sink.contextCalls).toEqual([]);
    expect(injector.pendingCount).toBe(1);

    injector.noteResponseDone();

    expect(sink.contextCalls).toEqual(['build finished']);
  });

  it('holds items while playback is in progress and delivers after completion + quiet gap', () => {
    injector.notePlaybackStarted();
    injector.enqueue(complete('done'));

    expect(sink.contextCalls).toEqual([]);

    injector.notePlaybackCompleted();
    // Quiet gap still applies after completion.
    vi.advanceTimersByTime(QUIET_GAP_MS - 1);
    expect(sink.contextCalls).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(sink.contextCalls).toEqual(['done']);
  });

  it('holds items through multiple playback chunks until completion', () => {
    injector.notePlaybackStarted();
    // Additional chunks arrive while playback is in progress — the
    // window stays closed until the Host reports completion.
    injector.notePlaybackStarted();
    injector.enqueue(complete('done'));

    vi.advanceTimersByTime(QUIET_GAP_MS + 5_000);
    expect(sink.contextCalls).toEqual([]);

    injector.notePlaybackCompleted();
    vi.advanceTimersByTime(QUIET_GAP_MS - 1);
    expect(sink.contextCalls).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(sink.contextCalls).toEqual(['done']);
  });

  it('reopens the window immediately when output is cleared during playback', () => {
    injector.notePlaybackStarted();
    injector.enqueue(complete('interrupted'));
    vi.advanceTimersByTime(500);
    expect(sink.contextCalls).toEqual([]);

    injector.noteOutputCleared();

    expect(sink.contextCalls).toEqual(['interrupted']);
  });
});

describe('Injector batching', () => {
  it('flushes a held batch as one context injection and one spoken line, in order', () => {
    injector.noteResponseCreated();
    injector.enqueue({
      kind: 'complete',
      context: 'job_1 finished',
      spoken: 'Job one finished.',
      jobHandle: 'job_1',
    });
    injector.enqueue({
      kind: 'progress',
      context: 'job_2 is halfway',
      spoken: 'Job two is halfway.',
      jobHandle: 'job_2',
    });
    injector.enqueue({
      kind: 'permission',
      context: 'job_3 wants to edit a file',
      spoken: 'Job three needs permission.',
      jobHandle: 'job_3',
      requestId: 'req_1',
    });
    expect(injector.pendingCount).toBe(3);

    injector.noteResponseDone();

    expect(sink.contextCalls).toEqual(['job_1 finished\njob_2 is halfway']);
    expect(sink.speechCalls).toEqual(['Job one finished. Job two is halfway.']);
    expect(sink.permissionCalls).toEqual(['job_3 wants to edit a file']);
    expect(sink.injected).toHaveLength(3);
    expect(injector.pendingCount).toBe(0);
  });

  it('injects silently when no batch item carries a spoken line', () => {
    injector.enqueue(complete('quiet update'));

    expect(sink.contextCalls).toEqual(['quiet update']);
    expect(sink.speechCalls).toEqual([]);
    expect(sink.injected).toEqual([
      { item: complete('quiet update'), spoken: false },
    ]);
  });
});

describe('Injector progress throttling', () => {
  it('drops a second progress item for the same job inside the throttle window', () => {
    injector.enqueue({ kind: 'progress', context: 'p1', jobHandle: 'job_1' });
    expect(sink.contextCalls).toEqual(['p1']);

    vi.advanceTimersByTime(60_000);
    injector.enqueue({ kind: 'progress', context: 'p2', jobHandle: 'job_1' });

    expect(sink.contextCalls).toEqual(['p1']);
    expect(injector.pendingCount).toBe(0);

    // Past the 5-minute throttle the same job may report again.
    vi.advanceTimersByTime(5 * 60_000);
    injector.enqueue({ kind: 'progress', context: 'p3', jobHandle: 'job_1' });
    expect(sink.contextCalls).toEqual(['p1', 'p3']);
  });

  it('throttles per job handle, not globally', () => {
    injector.enqueue({ kind: 'progress', context: 'a1', jobHandle: 'job_a' });
    vi.advanceTimersByTime(1_000);
    injector.enqueue({ kind: 'progress', context: 'b1', jobHandle: 'job_b' });

    expect(sink.contextCalls).toEqual(['a1', 'b1']);
  });

  it('keeps at most one queued progress item per job (newest wins)', () => {
    makeInjector({ progressThrottleMs: 0 });
    injector.noteResponseCreated();
    injector.enqueue({
      kind: 'progress',
      context: 'stale',
      jobHandle: 'job_1',
    });
    injector.enqueue({
      kind: 'progress',
      context: 'fresh',
      jobHandle: 'job_1',
    });
    expect(injector.pendingCount).toBe(1);

    injector.noteResponseDone();

    expect(sink.contextCalls).toEqual(['fresh']);
  });

  it('keys jobless progress on the full context, not a shared prefix', () => {
    injector.noteResponseCreated();
    // Identical first 32 chars, diverging afterwards — the shape of two
    // permission-retraction notices for one session.
    const shared = '[BACKEND session_1] The permission request ';
    injector.enqueue({ kind: 'progress', context: `${shared}(req_1) done.` });
    injector.enqueue({ kind: 'progress', context: `${shared}(req_2) done.` });
    expect(injector.pendingCount).toBe(2);

    injector.noteResponseDone();

    expect(sink.contextCalls).toEqual([
      `${shared}(req_1) done.\n${shared}(req_2) done.`,
    ]);
  });

  it('dedups true jobless duplicates to a single queued item', () => {
    makeInjector({ progressThrottleMs: 0 });
    injector.noteResponseCreated();
    injector.enqueue({ kind: 'progress', context: 'same jobless notice' });
    injector.enqueue({ kind: 'progress', context: 'same jobless notice' });

    expect(injector.pendingCount).toBe(1);
  });

  it('clears the throttle stamp when speech start drops queued progress', () => {
    injector.noteResponseCreated();
    injector.enqueue({ kind: 'progress', context: 'p1', jobHandle: 'job_1' });
    expect(injector.pendingCount).toBe(1);

    // Barge-in drops the undelivered progress; the throttle window must not
    // survive it, or the job goes silent for the whole window.
    injector.noteSpeechStarted();
    expect(injector.pendingCount).toBe(0);
    injector.noteInputCommitted();
    injector.noteResponseDone();

    vi.advanceTimersByTime(1_000);
    injector.enqueue({ kind: 'progress', context: 'p2', jobHandle: 'job_1' });

    expect(sink.contextCalls).toEqual(['p2']);
  });

  it('keeps the throttle stamp for progress that was actually delivered', () => {
    injector.enqueue({ kind: 'progress', context: 'p1', jobHandle: 'job_1' });
    expect(sink.contextCalls).toEqual(['p1']);

    injector.noteSpeechStarted();
    injector.noteInputCommitted();
    vi.advanceTimersByTime(1_000);
    injector.enqueue({ kind: 'progress', context: 'p2', jobHandle: 'job_1' });

    expect(sink.contextCalls).toEqual(['p1']);
  });
});

describe('Injector queue maintenance', () => {
  it('drops queued progress on speech start but keeps conclusions and permission asks', () => {
    injector.noteResponseCreated();
    injector.enqueue(complete('finished'));
    injector.enqueue({ kind: 'progress', context: 'halfway', jobHandle: 'j' });
    injector.enqueue({
      kind: 'permission',
      context: 'needs approval',
      requestId: 'req_1',
    });
    expect(injector.pendingCount).toBe(3);

    injector.noteSpeechStarted();
    expect(injector.pendingCount).toBe(2);

    injector.noteResponseDone();
    injector.noteInputCommitted();
    expect(sink.contextCalls).toEqual(['finished']);
    expect(sink.permissionCalls).toEqual(['needs approval']);
  });

  it('retracts a queued permission ask by request id', () => {
    injector.noteResponseCreated();
    injector.enqueue({
      kind: 'permission',
      context: 'ask one',
      requestId: 'req_1',
    });
    injector.enqueue({
      kind: 'permission',
      context: 'ask two',
      requestId: 'req_2',
    });

    expect(injector.retractPermission('req_1')).toBe(true);
    expect(injector.pendingCount).toBe(1);
    expect(injector.retractPermission('req_unknown')).toBe(false);

    injector.noteResponseDone();
    expect(sink.permissionCalls).toEqual(['ask two']);
  });

  it('dispose clears the queue and nothing is delivered afterwards', () => {
    injector.noteResponseCreated();
    injector.enqueue(complete('stale one'));
    injector.enqueue({
      kind: 'permission',
      context: 'stale ask',
      requestId: 'req_1',
    });
    expect(injector.pendingCount).toBe(2);

    injector.dispose();

    expect(injector.pendingCount).toBe(0);
    injector.noteResponseDone();
    vi.advanceTimersByTime(60_000);
    expect(sink.contextCalls).toEqual([]);
    expect(sink.speechCalls).toEqual([]);
  });
});

describe('Injector transport refusal', () => {
  it('requeues the batch and retries after the quiet gap when the sink refuses', () => {
    sink.contextResult = false;
    sink.speechResult = false;

    injector.enqueue(complete('important', 'Say this.'));

    expect(sink.contextCalls).toEqual(['important']);
    expect(sink.speechCalls).toEqual(['Say this.']);
    expect(sink.injected).toEqual([]);
    expect(injector.pendingCount).toBe(1);

    sink.contextResult = true;
    sink.speechResult = true;
    vi.advanceTimersByTime(QUIET_GAP_MS);

    expect(sink.contextCalls).toEqual(['important', 'important']);
    expect(sink.speechCalls).toEqual(['Say this.', 'Say this.']);
    expect(sink.injected).toHaveLength(1);
    expect(injector.pendingCount).toBe(0);
  });

  it('counts a spoken-only acceptance as delivered', () => {
    sink.contextResult = false;
    sink.speechResult = true;

    injector.enqueue(complete('body', 'Spoken line.'));

    expect(injector.pendingCount).toBe(0);
    expect(sink.injected).toHaveLength(1);
  });
});

describe('Injector size caps', () => {
  it('caps the combined context injection at 6000 chars', () => {
    injector.noteSpeechStarted();
    injector.enqueue(complete('a'.repeat(4_000)));
    injector.enqueue(complete('b'.repeat(4_000)));
    injector.noteInputCommitted();

    // Whole items only, like the spoken lane below: neither is cut in half
    // by a slice of the joined text. The overflow becomes its own
    // injection on the same flush pass.
    expect(sink.contextCalls).toEqual(['a'.repeat(4_000), 'b'.repeat(4_000)]);
  });

  it('joins spoken lines whole and stops before breaching 280 chars', () => {
    injector.noteSpeechStarted();
    injector.enqueue(complete('one', 'x'.repeat(200)));
    injector.enqueue(complete('two', 'y'.repeat(200)));
    injector.noteInputCommitted();

    expect(sink.speechCalls).toHaveLength(1);
    // Whole-line greedy join: the second line would breach the cap, so
    // only the first is spoken — never a mid-line cut of line two.
    expect(sink.speechCalls[0]).toBe('x'.repeat(200));
  });

  it('truncates a single over-long spoken line with an ellipsis', () => {
    injector.noteSpeechStarted();
    injector.enqueue(complete('ctx', 'z'.repeat(400)));
    injector.noteInputCommitted();

    expect(sink.speechCalls).toHaveLength(1);
    expect(sink.speechCalls[0]).toBe(`${'z'.repeat(280)}…`);
  });
});
