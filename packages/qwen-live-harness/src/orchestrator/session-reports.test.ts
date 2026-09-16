/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionReports } from './session-reports.js';
import type { PeerSessionReport } from '../adaptor/types.js';

function report(id: string): PeerSessionReport {
  return {
    id,
    callId: 'call',
    source: 'Terminal',
    sourceStatus: 'unconfirmed',
    category: 'info',
    text: 'A report',
    receivedAt: 1,
  };
}

describe('SessionReports', () => {
  it('bounds retained history without evicting reports waiting for audio, and keeps internal identities private', () => {
    const ledger = new SessionReports(vi.fn());
    const pending = ledger.add('qwen', report('private-pending'))!;
    ledger.update(pending.id, 'submitted');
    for (let i = 0; i < 120; i++) {
      const row = ledger.add('qwen', {
        ...report(`private-${i}`),
        correlationId: 'private-correlation',
        sourceSessionId: 'private-source',
      })!;
      ledger.update(row.id, 'announced');
    }
    expect(ledger.page()).toHaveLength(100);
    expect(ledger.page()).toContainEqual(
      expect.objectContaining({ id: pending.id, announcement: 'submitted' }),
    );
    expect(ledger.omitted).toBe(21);
    expect(JSON.stringify(ledger.page())).not.toContain('private-');
    const copy = ledger.page()[0]!;
    copy.text = 'mutated';
    expect(ledger.page()[0]?.text).toBe('A report');
  });

  it('does not evict retained history or claim admission when the downstream queue refuses', () => {
    const ledger = new SessionReports(vi.fn());
    for (let i = 0; i < 100; i++) {
      const row = ledger.add('qwen', report(`${i}`))!;
      ledger.update(row.id, 'unspoken');
    }
    const before = ledger.page();
    const rejected = ledger.add('qwen', report('rejected'))!;
    ledger.reject(rejected.id);
    expect(ledger.page()).toEqual(before);
    expect(ledger.omitted).toBe(0);
    expect(ledger.add('qwen', report('rejected'))).toBeUndefined();
  });

  it('ends pending records, clears old-call data and advances its independent revision', () => {
    const ledger = new SessionReports(vi.fn());
    const row = ledger.add('qwen', report('one'))!;
    ledger.update(row.id, 'queued');
    ledger.end();
    expect(ledger.page()[0]?.announcement).toBe('unspoken');
    const revision = ledger.revision;
    ledger.clear();
    expect(ledger.revision).toBeGreaterThan(revision);
    expect(ledger.page()).toEqual([]);
    expect(
      ledger.add('qwen', { ...report('one'), callId: 'new' }),
    ).toBeDefined();
  });
});
