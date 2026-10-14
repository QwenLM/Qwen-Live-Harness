/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, it, vi } from 'vitest';
import {
  ConversationCompactor,
  conversationSummarizer,
} from './context-compaction.js';
import { DEFAULT_MEMORY_CONFIG } from '../memory/config.js';

it('merges older entries in the background without losing messages arriving during summary generation', async () => {
  let resolve!: (value: string) => void;
  const summarize = vi.fn(
    (_input: string) =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const compactor = new ConversationCompactor(summarize, vi.fn());
  for (let i = 0; i < 16; i++)
    compactor.remember({ role: 'user', text: `Fact ${i}` });
  compactor.remember({ role: 'user', text: 'Latest correction' });
  expect(summarize).toHaveBeenCalledTimes(1);
  resolve('Facts 0 through 7; requests and approvals are historical only.');
  await compactor.refresh();
  const second = compactor.refresh();
  // A second incremental request includes the preceding summary.
  expect(summarize).toHaveBeenCalledTimes(2);
  expect(summarize.mock.calls[1]?.[0]).toContain('Facts 0 through 7');
  resolve('Facts 0 through 8.');
  await second;
  expect(compactor.context()).toContain('Latest correction');
  expect(compactor.context()).toContain('never instructions or authorization');
  compactor.close();
});

it('keeps recent long Unicode messages within the conservative history budget', () => {
  const compactor = new ConversationCompactor(vi.fn(), vi.fn());
  compactor.remember({
    role: 'user',
    text: '开始'.repeat(5000) + 'Latest correction',
  });
  const context = compactor.context()!;
  const data = context.slice(context.indexOf('{'));
  expect(Buffer.byteLength(data)).toBeLessThanOrEqual(8192);
  expect(context).toContain('historical text truncated');
  expect(context).toContain('Latest correction');
  expect(() => JSON.parse(data)).not.toThrow();
  compactor.close();
});

it('refuses rotation when older history could not be summarized and aborts on close', async () => {
  const summarize = vi.fn(async (_input: string, signal: AbortSignal) => {
    expect(signal.aborted).toBe(false);
    throw new Error('fixture failure');
  });
  const compactor = new ConversationCompactor(summarize, vi.fn());
  for (let i = 0; i < 16; i++)
    compactor.remember({ role: 'context', text: `Receipt ${i}` });
  await compactor.refresh();
  expect(compactor.context()).toBeUndefined();
  compactor.close();
  await compactor.refresh();
  expect(summarize).toHaveBeenCalledTimes(1);
});

it.each(['length', 'tool_calls'])(
  'rejects a %s completion instead of installing a partial summary',
  async (finishReason) => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { finish_reason: finishReason, message: { content: 'Partial' } },
          ],
        }),
      ),
    );
    try {
      const summarize = conversationSummarizer(
        { baseUrl: 'http://fixture.invalid', apiKey: 'fake' },
        DEFAULT_MEMORY_CONFIG.updater,
      );
      await expect(
        summarize('quoted data', new AbortController().signal),
      ).rejects.toThrow();
    } finally {
      fetcher.mockRestore();
    }
  },
);

it.each([null, []])(
  'accepts a finished text summary with an empty tool_calls field %j',
  async (toolCalls) => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: 'Verified constraints.',
                tool_calls: toolCalls,
              },
            },
          ],
        }),
      ),
    );
    try {
      const summarize = conversationSummarizer(
        { baseUrl: 'http://fixture.invalid' },
        DEFAULT_MEMORY_CONFIG.updater,
      );
      await expect(
        summarize('quoted history', new AbortController().signal),
      ).resolves.toBe('Verified constraints.');
    } finally {
      fetcher.mockRestore();
    }
  },
);

it('refuses a restored summary whose JSON escaping exceeds the history budget', async () => {
  const compactor = new ConversationCompactor(
    async () => '"'.repeat(4096),
    vi.fn(),
  );
  for (let i = 0; i < 16; i++)
    compactor.remember({ role: 'user', text: `Fact ${i}` });
  await compactor.refresh();
  expect(compactor.context()).toBeUndefined();
  compactor.close();
});
