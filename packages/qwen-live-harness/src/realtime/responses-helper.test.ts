/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it, vi } from 'vitest';
import { runResponsesHelper } from './responses-helper.js';

const options = {
  endpoint: 'https://api.openai.com',
  apiKey: 'fixture-secret',
  model: 'gpt-6-luna',
  query: 'Current weather?',
};
function answer(output: unknown[], status = 'completed') {
  return new Response(JSON.stringify({ status, output }));
}

it('sends only the current query to an isolated read-only search and preserves real citations', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    answer([
      { type: 'web_search_call', status: 'completed' },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'Rain tomorrow.',
            annotations: [
              { type: 'url_citation', url: 'https://example.com/weather' },
            ],
          },
        ],
      },
    ]),
  );
  expect(await runResponsesHelper(options, fetcher)).toEqual({
    answer: 'Rain tomorrow.\nSources: https://example.com/weather',
    searchStatus: 'performed',
  });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://api.openai.com/v1/responses');
  expect(init?.redirect).toBe('error');
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject({
    store: false,
    tools: [{ type: 'web_search' }],
    input: [
      { role: 'user', content: [{ type: 'input_text', text: options.query }] },
    ],
  });
  expect(body).not.toHaveProperty('conversation');
});

it('provides a single image without search tools and does not infer web execution from prose', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    answer([
      {
        type: 'message',
        content: [{ type: 'output_text', text: 'An editor is visible.' }],
      },
    ]),
  );
  expect(
    await runResponsesHelper({ ...options, image: 'fixture-image' }, fetcher),
  ).toEqual({ answer: 'An editor is visible.', searchStatus: 'not_performed' });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.tools).toEqual([]);
  expect(body.input[0].content[1]).toEqual({
    type: 'input_image',
    image_url: 'data:image/jpeg;base64,fixture-image',
    detail: 'auto',
  });
});

it.each([
  new Response('fixture-secret raw error', { status: 401 }),
  answer([{ type: 'function_call' }]),
  answer(
    [{ type: 'message', content: [{ type: 'output_text', text: 'Partial.' }] }],
    'incomplete',
  ),
  answer([
    {
      type: 'message',
      content: [{ type: 'output_text', text: 'x'.repeat(16001) }],
    },
  ]),
])(
  'rejects failed, partial or unexpected tool results without retaining raw service data',
  async (response) => {
    const error = await runResponsesHelper(options, async () => response).catch(
      (e) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('fixture-secret');
  },
);

it('propagates cancellation to the worker and keeps it separate from task success', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.signal?.aborted).toBe(true);
    throw new Error('aborted');
  });
  controller.abort();
  await expect(
    runResponsesHelper({ ...options, signal: controller.signal }, fetcher),
  ).rejects.toThrow('cancelled');
});
