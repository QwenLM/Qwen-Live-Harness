import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSession,
  readSessionSource,
  workbenchContexts,
  type FeedContext,
} from './feed-context.js';
import {
  parseInsights,
  selectInsightContexts,
  type InsightDraft,
} from './feed-insights.js';
import { PersonalFeed } from './personal-feed.js';
import type { MobileTask } from './tasks.js';

let directory: string;
const feeds: PersonalFeed[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'personal-feed-test-'));
});
afterEach(async () => {
  await Promise.all(feeds.splice(0).map((feed) => feed.close()));
  await rm(directory, { recursive: true, force: true });
});

const now = Date.now();
function context(id = 'one'): FeedContext {
  return {
    id,
    source: 'codex',
    title: 'Remember decisions',
    updatedAt: now,
    incomplete: false,
    messages: [
      {
        id: id + '-user',
        role: 'user',
        text: 'Please keep corrections to decisions across conversations.',
      },
      {
        id: id + '-ai',
        role: 'assistant',
        text: 'We could record a decision and its current status.',
      },
    ],
  };
}
function draft(contexts = [context()]): InsightDraft {
  return {
    kind: contexts.length > 1 ? 'connection' : 'next_step',
    topic: 'Memory',
    title: 'Keep the latest decision visible',
    summary: 'A small experiment with decision state.',
    why: 'Your conversation asks how corrections should survive.',
    sections: [
      { label: 'Observe', text: 'A recorded decision can become stale.' },
      { label: 'Try', text: 'Track proposed, changed and completed states.' },
    ],
    evidence: contexts.map((item) => ({
      contextId: item.id,
      messageId: item.messages[0]!.id,
      quote: item.messages[0]!.text,
    })),
    followUp: 'How should a changed decision replace an earlier one?',
  };
}
function setup(
  overrides: Partial<ConstructorParameters<typeof PersonalFeed>[0]> = {},
) {
  const generate = vi.fn<
    ConstructorParameters<typeof PersonalFeed>[0]['generate']
  >(async (_backend, input) => [draft(input.contexts)]);
  const readSource = vi.fn<typeof readSessionSource>(async (source) => ({
    source,
    status: 'ready' as const,
    contexts: [context()],
  }));
  const options: ConstructorParameters<typeof PersonalFeed>[0] = {
    directory,
    roots: { codex: join(directory, 'codex'), qwen: join(directory, 'qwen') },
    backends: ['fake'],
    workbench: () => ({ runId: 'run-one', tasks: [] }),
    generate,
    readSource,
    now: () => now,
    ...overrides,
  };
  const feed = new PersonalFeed(options);
  feeds.push(feed);
  return { feed, generate, readSource, options };
}
const enabled = {
  enabled: true,
  sources: ['codex'],
  backend: 'fake',
  language: 'en',
};

it('imports dialogue and corrections without reasoning, tool output, system data or duplicate Codex messages', () => {
  const events = [
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'duplicate' }],
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Remember the decision, token=secret-test-value',
      },
    },
    {
      type: 'event_msg',
      payload: { type: 'agent_reasoning', text: 'private chain' },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', output: 'private file' },
    },
    {
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'The proposal is A.' },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Correction: use proposal B instead of A.',
      },
    },
  ];
  const result = parseSession(
    'codex',
    events.map((event) => JSON.stringify(event)).join('\n'),
    'id',
    now,
  )!;
  expect(result.messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'user',
  ]);
  expect(result.messages.at(-1)!.text).toContain('proposal B');
  expect(JSON.stringify(result)).not.toMatch(
    /secret-test-value|private chain|private file|duplicate/,
  );
  expect(result.messages[0]!.text).toContain('[REDACTED]');
});

it('supports Qwen parts, ignores sidechains, and marks malformed or bounded context incomplete', () => {
  const lines = [
    {
      type: 'user',
      message: {
        role: 'user',
        parts: [{ text: 'Please compare the two memory designs.' }],
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'model',
        parts: [
          { text: 'hidden thought', thought: true },
          { text: 'A response.' },
          { functionCall: { name: 'shell' } },
        ],
      },
    },
    {
      type: 'user',
      isSidechain: true,
      message: { parts: [{ text: 'subagent request' }] },
    },
  ];
  const result = parseSession(
    'qwen',
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n{partial',
    'q',
    now,
  )!;
  expect(result.incomplete).toBe(true);
  expect(result.messages).toHaveLength(2);
  expect(JSON.stringify(result)).not.toMatch(/hidden thought|subagent|shell/);
  const long = context();
  long.messages = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    role: i % 2 ? 'assistant' : 'user',
    text: 'x'.repeat(1000),
  }));
  const selected = selectInsightContexts([long])[0]!;
  expect(selected.incomplete).toBe(true);
  expect(selected.messages.at(-1)!.id).toBe('29');
  expect(
    selected.messages.reduce((n, m) => n + m.text.length, 0),
  ).toBeLessThanOrEqual(6000);
});

it('excludes the feed own background sessions so generated cards cannot become fresh user interests', () => {
  for (const source of ['codex', 'qwen'] as const) {
    const text =
      'Create personal insight cards from the quoted conversation evidence below.\nHistorical user words';
    const record =
      source === 'codex'
        ? {
            type: 'event_msg',
            payload: { type: 'user_message', message: text },
          }
        : { type: 'user', message: { parts: [{ text }] } };
    expect(
      parseSession(source, JSON.stringify(record), 'generated', now),
    ).toBeUndefined();
  }
});

it('reads only selected transcript files and never follows symlinks or reads credential JSON', async () => {
  const root = join(directory, 'codex'),
    day = join(root, '2026', '11', '16');
  await mkdir(day, { recursive: true });
  const line = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: 'A session without any produced artifacts.',
    },
  });
  await writeFile(join(day, 'rollout.jsonl'), line);
  await writeFile(join(root, 'auth.json'), 'not a transcript');
  const outside = join(directory, 'outside.jsonl');
  await writeFile(outside, line.replace('A session', 'A secret'));
  await symlink(outside, join(day, 'linked.jsonl'));
  await symlink(directory, join(root, '2025'));
  const result = await readSessionSource(
    'codex',
    root,
    new AbortController().signal,
  );
  expect(result.status).toBe('ready');
  expect(result.contexts).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('A secret');
  expect(
    (
      await readSessionSource(
        'codex',
        join(directory, 'absent'),
        new AbortController().signal,
      )
    ).status,
  ).toBe('missing');
  const controller = new AbortController();
  controller.abort();
  await expect(
    readSessionSource('codex', root, controller.signal),
  ).rejects.toThrow();
});

it('keeps complete workbench turns and their ownership without requiring artifacts', () => {
  const task = {
    id: 't',
    conversationId: 'c',
    turnIndex: 1,
    request: 'Compare two approaches',
    output: 'The first proposal',
    outputTruncated: false,
    status: 'completed',
    updatedAt: now,
  } as MobileTask;
  const contexts = workbenchContexts(
    [
      task,
      {
        ...task,
        id: 't2',
        turnIndex: 2,
        request: 'I changed my mind; compare a third.',
        output: 'Revised proposal',
      },
      { ...task, id: 'busy', conversationId: 'busy', status: 'running' },
    ],
    'run',
  );
  expect(contexts).toHaveLength(1);
  expect(contexts[0]!.messages).toHaveLength(4);
  expect(contexts[0]!.link).toEqual({
    runId: 'run',
    conversationId: 'c',
    taskId: 't2',
  });
});

it('requires exact evidence and separate conversations for claimed connections', () => {
  const valid = draft();
  expect(
    parseInsights(JSON.stringify({ cards: [valid] }), [context()]),
  ).toEqual([valid]);
  for (const card of [
    {
      ...valid,
      evidence: [{ ...valid.evidence[0], quote: 'Invented source evidence' }],
    },
    { ...valid, evidence: [{ ...valid.evidence[0], contextId: 'unprovided' }] },
    { ...valid, kind: 'connection' },
    { ...valid, sections: [] },
  ])
    expect(() =>
      parseInsights(JSON.stringify({ cards: [card] }), [context()]),
    ).toThrow();
  expect(parseInsights('{"cards":[]}', [])).toEqual([]);
});

it('does not read or use a model until the user selects and enables sources', async () => {
  const { feed, generate, readSource } = setup();
  await feed.refresh();
  expect(readSource).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
  expect(feed.snapshot().cards).toEqual([]);
  expect(() => feed.configure({ ...enabled, sources: ['browser'] })).toThrow();
  expect(() => feed.configure({ ...enabled, sources: [] })).toThrow();
});

it('generates without artifacts, verifies evidence, persists through restart, and does not regenerate unchanged input', async () => {
  let time = now;
  const { feed, generate, options } = setup({ now: () => time });
  feed.configure(enabled);
  await feed.refresh();
  expect(generate).toHaveBeenCalledOnce();
  const card = feed.snapshot().cards[0]!;
  expect(card.evidence[0]).toMatchObject({
    source: 'codex',
    role: 'user',
    quote: context().messages[0]!.text,
  });
  expect(feed.snapshot()).not.toHaveProperty('contexts');
  expect((await stat(join(directory, 'personal-feed.json'))).mode & 0o777).toBe(
    0o600,
  );
  await feed.close();
  const restarted = new PersonalFeed(options);
  feeds.push(restarted);
  expect(restarted.snapshot().cards[0]!.id).toBe(card.id);
  time += 16 * 60_000;
  await restarted.refresh();
  expect(generate).toHaveBeenCalledOnce();
  restarted.configure(enabled);
  await restarted.refresh();
  expect(generate).toHaveBeenCalledOnce();
  restarted.configure({ ...enabled, enabled: false });
  restarted.configure(enabled);
  time += 16 * 60_000;
  await restarted.refresh();
  expect(generate).toHaveBeenCalledOnce();
});

it('respects cooldown, daily request budget, and keeps dismissed cards as negative generation context', async () => {
  let time = now,
    revision = 0;
  const { feed, generate } = setup({
    now: () => time,
    readSource: async (source) => ({
      source,
      status: 'ready',
      contexts: [
        {
          ...context(),
          messages: [
            {
              ...context().messages[0]!,
              text: 'New user correction number ' + revision++,
            },
          ],
        },
      ],
    }),
  });
  feed.configure(enabled);
  await feed.refresh();
  feed.dismiss(feed.snapshot().cards[0]!.id);
  expect(feed.snapshot().cards).toEqual([]);
  time += 60_001;
  await feed.refresh();
  expect(generate).toHaveBeenCalledOnce();
  time += 15 * 60_000;
  await feed.refresh();
  expect(generate.mock.calls[1]![1].previous[0]!.title).toBe(draft().title);
  expect(generate.mock.calls[1]![1].previous[0]!.dismissed).toBe(true);
  for (let i = 0; i < 8; i++) {
    time += 16 * 60_000;
    await feed.refresh();
  }
  expect(generate).toHaveBeenCalledTimes(6);
});

it('revoking a source cancels in-flight generation and prevents a late card from being committed', async () => {
  let resolve!: (cards: InsightDraft[]) => void;
  const { feed } = setup({
    generate: async () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  feed.configure(enabled);
  const operation = feed.refresh();
  await vi.waitFor(() => expect(feed.snapshot().status).toBe('generating'));
  feed.configure({ ...enabled, enabled: false, sources: [] });
  resolve([draft()]);
  await operation;
  expect(feed.snapshot().status).toBe('disabled');
  expect(feed.snapshot().cards).toEqual([]);
  expect(
    JSON.parse(await readFile(join(directory, 'personal-feed.json'), 'utf8'))
      .contexts,
  ).toEqual([]);
});

it('a generation error or insufficient evidence produces no fabricated cards and preserves old cards', async () => {
  let time = now,
    fail = false;
  const { feed } = setup({
    now: () => time,
    generate: async () => {
      if (fail) throw new Error('provider detail must stay private');
      return [draft()];
    },
  });
  feed.configure(enabled);
  await feed.refresh();
  const id = feed.snapshot().cards[0]!.id;
  fail = true;
  time += 16 * 60_000;
  feed.configure({ ...enabled, language: 'zh-CN' });
  await feed.refresh();
  expect(feed.snapshot().error).toBe('feed_generation_failed');
  expect(feed.snapshot().cards[0]!.id).toBe(id);
  expect(JSON.stringify(feed.snapshot())).not.toContain('provider detail');
});

it('clear removes derived data and disables generation while leaving original session files intact', async () => {
  const original = join(directory, 'original.jsonl');
  await writeFile(original, 'original');
  const { feed, generate } = setup();
  feed.configure(enabled);
  await feed.refresh();
  feed.clear();
  await feed.refresh();
  expect(feed.snapshot().preferences.enabled).toBe(false);
  expect(feed.snapshot().cards).toEqual([]);
  expect(await readFile(original, 'utf8')).toBe('original');
  expect(generate).toHaveBeenCalledOnce();
});

it('preserves corrupt or unsupported storage instead of silently resetting it', async () => {
  const path = join(directory, 'personal-feed.json');
  await writeFile(path, '{broken');
  const { feed, readSource } = setup();
  await feed.refresh();
  expect(feed.snapshot().error).toBe('feed_storage_unreadable');
  expect(() => feed.configure(enabled)).toThrow();
  expect(() => feed.clear()).toThrow();
  expect(await readFile(path, 'utf8')).toBe('{broken');
  expect(readSource).not.toHaveBeenCalled();
});
