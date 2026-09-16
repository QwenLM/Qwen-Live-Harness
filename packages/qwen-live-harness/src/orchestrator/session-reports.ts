/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PeerSessionReport } from '../adaptor/types.js';
import type { SessionReport } from '../subagents/types.js';

const PENDING = new Set<SessionReport['announcement']>([
  'queued',
  'submitted',
  'speaking',
]);

/** Display-only ledger. It owns no jobs, permissions or execution state. */
export class SessionReports {
  private readonly records = new Map<string, SessionReport>();
  private readonly seen = new Map<string, string>();
  private seq = 0;
  revision = 0;
  omitted = 0;

  constructor(private readonly changed: (report?: SessionReport) => void) {}

  clear(): void {
    this.records.clear();
    this.seen.clear();
    this.omitted = 0;
    this.publish();
  }

  add(
    backend: string,
    report: PeerSessionReport,
    session?: string,
  ): SessionReport | undefined {
    const key = JSON.stringify([backend, report.callId, report.id]);
    if (this.seen.has(key)) return undefined;
    if (
      this.records.size >= 100 &&
      ![...this.records.values()].some(
        (item) => !PENDING.has(item.announcement),
      )
    )
      return undefined;
    const view: SessionReport = {
      id: `report_${++this.seq}`,
      backend,
      source: report.source,
      sourceStatus: report.sourceStatus,
      ...(session ? { session } : {}),
      category: report.category,
      text: report.text,
      receivedAt: report.receivedAt,
      updatedAt: report.receivedAt,
      announcement: 'queued',
    };
    this.records.set(view.id, view);
    this.seen.set(key, view.id);
    while (this.seen.size > 256)
      this.seen.delete(this.seen.keys().next().value!);
    return view;
  }

  get(id: string): SessionReport | undefined {
    const report = this.records.get(id);
    return report ? { ...report } : undefined;
  }

  reject(id: string): void {
    this.records.delete(id);
  }

  update(
    id: string,
    announcement: SessionReport['announcement'],
    note?: string,
  ): void {
    const report = this.records.get(id);
    if (!report) return;
    report.announcement = announcement;
    report.updatedAt = Math.max(report.receivedAt, Date.now());
    if (note) report.note = note;
    while (this.records.size > 100) {
      const old = [...this.records.values()].find(
        (item) => item.id !== id && !PENDING.has(item.announcement),
      );
      if (!old) break;
      this.records.delete(old.id);
      this.omitted += 1;
    }
    this.publish(report);
  }

  end(): void {
    for (const report of this.records.values()) {
      if (PENDING.has(report.announcement)) {
        this.update(
          report.id,
          'unspoken',
          'The call ended before playback was confirmed.',
        );
      }
    }
  }

  page(): SessionReport[] {
    return [...this.records.values()]
      .reverse()
      .map((report) => ({ ...report }));
  }

  private publish(report?: SessionReport): void {
    this.revision += 1;
    this.changed(report ? { ...report } : undefined);
  }
}
