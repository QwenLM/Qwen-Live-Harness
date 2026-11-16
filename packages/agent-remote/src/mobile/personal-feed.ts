import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { privateDirectory } from '../state.js';
import { MobileError } from './errors.js';
import {
  CONTEXT_WINDOW_MS,
  FEED_SOURCES,
  contextID,
  readSessionSource,
  workbenchContexts,
  type FeedContext,
  type FeedSource,
  type SourceReading,
} from './feed-context.js';
import {
  parseInsights,
  selectInsightContexts,
  type InsightDraft,
  type InsightInput,
} from './feed-insights.js';
import type { MobileTask } from './tasks.js';

export interface FeedPreferences {
  enabled: boolean;
  sources: FeedSource[];
  backend: string;
  language: 'zh-CN' | 'en';
}
export interface InsightEvidence {
  contextId: string;
  source: FeedSource;
  title: string;
  updatedAt: number;
  role: 'user' | 'assistant';
  quote: string;
  incomplete: boolean;
  link?: FeedContext['link'];
}
export interface InsightCard extends Omit<InsightDraft, 'evidence'> {
  id: string;
  createdAt: number;
  evidence: InsightEvidence[];
  dismissed?: boolean;
}
interface FeedStore {
  version: 1;
  preferences: FeedPreferences;
  contexts: FeedContext[];
  cards: InsightCard[];
  evaluatedDigest?: string;
  lastEvaluatedAt?: number;
  attempts: number[];
}
interface FeedOptions {
  directory: string;
  roots: { codex: string; qwen: string };
  backends: string[];
  workbench: () => { runId: string; tasks: MobileTask[] };
  generate: (
    backend: string,
    input: InsightInput,
    signal: AbortSignal,
  ) => Promise<InsightDraft[]>;
  readSource?: typeof readSessionSource;
  now?: () => number;
}

/** Durable personal context and cards; independent of a task's artifacts or service run. */
export class PersonalFeed {
  private store: FeedStore;
  private readonly path: string;
  private controller = new AbortController();
  private operation?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private readable = true;
  private status: 'disabled' | 'idle' | 'collecting' | 'generating' | 'error' =
    'disabled';
  private error?: string;
  private readings: Array<{
    source: FeedSource;
    status: SourceReading['status'];
  }> = [];
  private lastScan = 0;

  constructor(private readonly options: FeedOptions) {
    privateDirectory(options.directory);
    this.path = join(options.directory, 'personal-feed.json');
    this.store = {
      version: 1,
      preferences: {
        enabled: false,
        sources: [],
        backend: options.backends[0] ?? '',
        language: 'zh-CN',
      },
      contexts: [],
      cards: [],
      attempts: [],
    };
    if (existsSync(this.path)) {
      try {
        const stat = lstatSync(this.path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > 12 * 1024 * 1024
        )
          throw new Error('Invalid store');
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as FeedStore;
        this.validateStore(parsed);
        this.store = parsed;
      } catch {
        this.readable = false;
        this.error = 'feed_storage_unreadable';
        this.status = 'error';
      }
    }
    if (this.readable)
      this.status = this.store.preferences.enabled ? 'idle' : 'disabled';
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private preferences(value: unknown): FeedPreferences {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new MobileError(400, 'invalid_feed_preferences');
    const prefs = value as FeedPreferences;
    if (
      typeof prefs.enabled !== 'boolean' ||
      !Array.isArray(prefs.sources) ||
      prefs.sources.length > 3 ||
      new Set(prefs.sources).size !== prefs.sources.length ||
      !prefs.sources.every((source) => FEED_SOURCES.includes(source)) ||
      typeof prefs.backend !== 'string' ||
      !['zh-CN', 'en'].includes(prefs.language) ||
      (prefs.enabled &&
        (!prefs.sources.length ||
          !this.options.backends.includes(prefs.backend)))
    )
      throw new MobileError(400, 'invalid_feed_preferences');
    return {
      enabled: prefs.enabled,
      sources: [...prefs.sources],
      backend: prefs.backend,
      language: prefs.language,
    };
  }

  private validateStore(store: FeedStore): void {
    if (
      store.version !== 1 ||
      !Array.isArray(store.contexts) ||
      store.contexts.length > 80 ||
      !Array.isArray(store.cards) ||
      store.cards.length > 48 ||
      !Array.isArray(store.attempts) ||
      !store.attempts.every(Number.isFinite)
    )
      throw new Error('Invalid store');
    // A removed backend must not destroy otherwise valid saved content.
    this.preferences({ ...store.preferences, enabled: false });
    if (typeof store.preferences.enabled !== 'boolean')
      throw new Error('Invalid preferences');
    for (const context of store.contexts) {
      if (
        !FEED_SOURCES.includes(context.source) ||
        typeof context.id !== 'string' ||
        typeof context.title !== 'string' ||
        !Number.isFinite(context.updatedAt) ||
        !Array.isArray(context.messages) ||
        context.messages.length > 80 ||
        typeof context.incomplete !== 'boolean' ||
        context.messages.some(
          (message) =>
            typeof message.id !== 'string' ||
            !['user', 'assistant'].includes(message.role) ||
            typeof message.text !== 'string' ||
            message.text.length > 4000,
        )
      )
        throw new Error('Invalid context');
    }
    for (const card of store.cards) {
      if (
        typeof card.id !== 'string' ||
        !Number.isFinite(card.createdAt) ||
        !Array.isArray(card.evidence) ||
        card.evidence.some(
          (evidence) =>
            !FEED_SOURCES.includes(evidence.source) ||
            typeof evidence.quote !== 'string' ||
            typeof evidence.title !== 'string' ||
            !Number.isFinite(evidence.updatedAt) ||
            typeof evidence.incomplete !== 'boolean' ||
            !['user', 'assistant'].includes(evidence.role) ||
            (evidence.link &&
              ![
                evidence.link.runId,
                evidence.link.conversationId,
                evidence.link.taskId,
              ].every((id) => typeof id === 'string')),
        )
      )
        throw new Error('Invalid card');
      // Reuse the wire schema without trusting saved content as executable data.
      parseInsights(
        JSON.stringify({
          cards: [
            {
              ...card,
              evidence: card.evidence.map((evidence, index) => ({
                contextId: evidence.contextId,
                messageId: String(index),
                quote: evidence.quote,
              })),
            },
          ],
        }),
        card.evidence.map((evidence) => ({
          id: evidence.contextId,
          source: evidence.source,
          title: evidence.title,
          updatedAt: evidence.updatedAt,
          incomplete: evidence.incomplete,
          messages: card.evidence.map((item, i) => ({
            id: String(i),
            role: item.role,
            text: item.quote,
          })),
        })),
      );
    }
  }

  private save(next: FeedStore): void {
    if (!this.readable) throw new MobileError(409, 'feed_storage_unreadable');
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), {
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporary, this.path);
      this.store = next;
    } catch {
      throw new MobileError(500, 'feed_storage_failed');
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  snapshot() {
    const now = this.now();
    return {
      preferences: {
        ...this.store.preferences,
        sources: [...this.store.preferences.sources],
      },
      status: this.status,
      error: this.error,
      cards: this.store.cards.filter(
        (card) => !card.dismissed && card.createdAt >= now - CONTEXT_WINDOW_MS,
      ),
      sources: FEED_SOURCES.map((id) => ({
        id,
        enabled: this.store.preferences.sources.includes(id),
        count: this.store.contexts.filter(
          (context) =>
            context.source === id &&
            context.updatedAt >= now - CONTEXT_WINDOW_MS,
        ).length,
        status:
          this.readings.find((reading) => reading.source === id)?.status ??
          'pending',
      })),
      lastEvaluatedAt: this.store.lastEvaluatedAt,
      nextEvaluationAt: this.store.attempts.length
        ? Math.max(
            this.store.attempts.at(-1)! + 15 * 60_000,
            this.store.attempts.filter((at) => at > now - 24 * 60 * 60_000)
              .length >= 6
              ? this.store.attempts[0]! + 24 * 60 * 60_000
              : 0,
          )
        : undefined,
    };
  }

  configure(value: unknown): void {
    if (this.closed) throw new MobileError(503, 'service_stopping');
    const preferences = this.preferences(value);
    const previous = this.store.preferences;
    if (JSON.stringify(preferences) === JSON.stringify(previous)) return;
    const next = {
      ...this.store,
      preferences,
      contexts: this.store.contexts.filter((context) =>
        preferences.sources.includes(context.source),
      ),
      cards: this.store.cards.filter((card) =>
        card.evidence.every((evidence) =>
          preferences.sources.includes(evidence.source),
        ),
      ),
      evaluatedDigest:
        preferences.language === previous.language &&
        preferences.backend === previous.backend &&
        JSON.stringify([...preferences.sources].sort()) ===
          JSON.stringify([...previous.sources].sort())
          ? this.store.evaluatedDigest
          : undefined,
    };
    this.save(next);
    this.controller.abort();
    this.controller = new AbortController();
    this.lastScan = 0;
    this.error = undefined;
    this.status = preferences.enabled ? 'idle' : 'disabled';
  }

  dismiss(id: string): void {
    if (!this.store.cards.some((card) => card.id === id))
      throw new MobileError(404, 'feed_card_unavailable');
    this.save({
      ...this.store,
      cards: this.store.cards.map((card) =>
        card.id === id ? { ...card, dismissed: true } : card,
      ),
    });
  }

  clear(): void {
    this.save({
      version: 1,
      preferences: { ...this.store.preferences, enabled: false, sources: [] },
      contexts: [],
      cards: [],
      attempts: this.store.attempts,
    });
    this.controller.abort();
    this.controller = new AbortController();
    this.error = undefined;
    this.status = 'disabled';
    this.readings = [];
    this.lastScan = 0;
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, 60_000);
    this.timer.unref();
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.operation) return this.operation;
    if (
      this.closed ||
      !this.readable ||
      !this.store.preferences.enabled ||
      this.now() - this.lastScan < 60_000
    )
      return Promise.resolve();
    const signal = this.controller.signal;
    this.operation = this.evaluate(signal)
      .catch((error: unknown) => {
        if (!signal.aborted && !this.closed) {
          this.status = 'error';
          this.error =
            error instanceof MobileError
              ? error.code
              : 'feed_generation_failed';
        }
      })
      .finally(() => {
        this.operation = undefined;
      });
    return this.operation;
  }

  private async evaluate(signal: AbortSignal): Promise<void> {
    const now = this.now(),
      preferences = this.store.preferences;
    this.lastScan = now;
    this.status = 'collecting';
    const contexts = new Map(
      this.store.contexts
        .filter((context) => context.updatedAt >= now - CONTEXT_WINDOW_MS)
        .map((context) => [context.id, context]),
    );
    const readings: typeof this.readings = [];
    for (const source of preferences.sources) {
      signal.throwIfAborted();
      if (source === 'workbench') {
        const workbench = this.options.workbench();
        for (const context of workbenchContexts(
          workbench.tasks,
          workbench.runId,
        ))
          contexts.set(context.id, context);
        readings.push({ source, status: 'ready' });
      } else {
        const reading = await (this.options.readSource ?? readSessionSource)(
          source,
          this.options.roots[source],
          signal,
          now,
        );
        for (const context of reading.contexts)
          contexts.set(context.id, context);
        readings.push({ source, status: reading.status });
      }
    }
    signal.throwIfAborted();
    this.readings = readings;
    let budget = 2_000_000;
    const seenDialogue = new Set<string>();
    const retained = [...contexts.values()]
      .filter((context) => context.updatedAt >= now - CONTEXT_WINDOW_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((context) => {
        const signature = contextID(
          JSON.stringify(
            context.messages.map(({ role, text }) => ({ role, text })),
          ),
        );
        if (seenDialogue.has(signature)) return false;
        seenDialogue.add(signature);
        return true;
      })
      .slice(0, 80)
      .filter((context) => {
        budget -= JSON.stringify(context).length;
        return budget >= 0;
      });
    this.save({
      ...this.store,
      contexts: retained,
      cards: this.store.cards.filter(
        (card) => card.createdAt >= now - CONTEXT_WINDOW_MS,
      ),
    });
    const selected = selectInsightContexts(retained);
    if (!selected.length) {
      this.status = 'idle';
      return;
    }
    const digest = contextID(
      JSON.stringify({
        language: preferences.language,
        contexts: selected.map(({ id, messages }) => ({ id, messages })),
      }),
    );
    const attempts = this.store.attempts.filter(
      (at) => at > now - 24 * 60 * 60_000,
    );
    if (
      digest === this.store.evaluatedDigest ||
      attempts.length >= 6 ||
      (attempts.length && now - attempts.at(-1)! < 15 * 60_000)
    ) {
      this.status = this.error ? 'error' : 'idle';
      return;
    }
    if (!this.options.backends.includes(preferences.backend))
      throw new MobileError(409, 'feed_backend_unavailable');
    this.save({ ...this.store, attempts: [...attempts, now] });
    this.status = 'generating';
    this.error = undefined;
    const input = {
      language: preferences.language,
      contexts: selected,
      previous: this.store.cards.map(({ title, summary, dismissed }) => ({
        title,
        summary,
        dismissed,
      })),
    };
    const drafts = await this.options.generate(
      preferences.backend,
      input,
      signal,
    );
    signal.throwIfAborted();
    // Validate even injected generators. References can never point outside this input.
    const verified = parseInsights(JSON.stringify({ cards: drafts }), selected);
    const cards = verified
      .map((draft): InsightCard => ({
        ...draft,
        id: randomUUID(),
        createdAt: this.now(),
        evidence: draft.evidence.map((evidence) => {
          const context = selected.find(
            (context) => context.id === evidence.contextId,
          )!;
          const message = context.messages.find(
            (message) => message.id === evidence.messageId,
          )!;
          return {
            contextId: context.id,
            source: context.source,
            title: context.title,
            updatedAt: context.updatedAt,
            role: message.role,
            quote: evidence.quote,
            incomplete: context.incomplete,
            ...(context.link ? { link: context.link } : {}),
          };
        }),
      }))
      .filter(
        (card, index, batch) =>
          !this.store.cards.some((previous) => previous.title === card.title) &&
          batch.findIndex((other) => other.title === card.title) === index,
      );
    this.save({
      ...this.store,
      cards: [...cards, ...this.store.cards].slice(0, 48),
      evaluatedDigest: digest,
      lastEvaluatedAt: this.now(),
    });
    this.status = 'idle';
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.operation;
  }
}
