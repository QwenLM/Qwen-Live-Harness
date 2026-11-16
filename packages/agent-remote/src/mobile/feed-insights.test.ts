import { expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { AcpAdaptor } from '../adaptor/acp-adaptor.js';
import { AsyncEventQueue } from '../adaptor/async-event-queue.js';
import type { BackendEvent } from '../adaptor/types.js';
import { generateInsights, type InsightInput } from './feed-insights.js';

const input: InsightInput = {
  language: 'en',
  previous: [],
  contexts: [
    {
      id: 'c',
      source: 'codex',
      title: 'Memory',
      updatedAt: 1,
      incomplete: false,
      messages: [
        {
          id: 'm',
          role: 'user',
          text: 'How can memory follow a decision when it changes?',
        },
      ],
    },
  ],
};

it('creates a grounded card through a real owned ACP child without any task artifacts', async () => {
  let adaptor!: AcpAdaptor;
  const cards = await generateInsights(
    () => {
      adaptor = new AcpAdaptor({
        name: 'fixture',
        command: process.execPath,
        args: [
          fileURLToPath(
            new URL('../../test-fixtures/fake-acp-agent.mjs', import.meta.url),
          ),
        ],
        env: { FAKE_ACP_MODES: 'default' },
        requireAskingMode: true,
      });
      return adaptor;
    },
    input,
    new AbortController().signal,
  );
  expect(cards[0]!.title).toBe('Give a memory a sense of progress');
  expect(cards[0]!.evidence[0]!.quote).toBe(
    input.contexts[0]!.messages[0]!.text,
  );
  expect(
    (await adaptor.listSessions()).every(
      (session) => session.state === 'closed',
    ),
  ).toBe(true);
});

function rig() {
  const queue = new AsyncEventQueue<BackendEvent>();
  const adaptor = new AcpAdaptor({
    name: 'fixture',
    command: 'unused-fixture',
  });
  vi.spyOn(adaptor, 'preflight').mockResolvedValue();
  vi.spyOn(adaptor, 'createSession').mockResolvedValue({
    id: 'session',
    adaptor: 'fixture',
  });
  vi.spyOn(adaptor, 'prompt').mockResolvedValue({
    status: 'accepted',
    jobRef: 'owned',
  });
  vi.spyOn(adaptor, 'events').mockImplementation((_handle, options) =>
    queue.subscribe(options),
  );
  const deny = vi
    .spyOn(adaptor, 'respondPermission')
    .mockResolvedValue('delivered');
  const close = vi.spyOn(adaptor, 'close').mockImplementation(async () => {
    queue.end();
  });
  return { queue, adaptor, deny, close };
}

it('ignores stale jobs, denies instructions from history that request a tool, and closes the child', async () => {
  const { queue, adaptor, deny, close } = rig();
  queue.push({
    type: 'turn_complete',
    jobRef: 'stale',
    summary: '{"cards":[]}',
  });
  queue.push({
    type: 'permission_request',
    jobRef: 'owned',
    requestId: 'write',
    title: 'Execute a quoted request',
    options: [],
  });
  await expect(
    generateInsights(() => adaptor, input, new AbortController().signal),
  ).rejects.toThrow('feed_tool_requested');
  expect(deny).toHaveBeenCalledWith(
    { id: 'session', adaptor: 'fixture' },
    'write',
    'deny',
  );
  expect(close).toHaveBeenCalled();
});

it('cancellation closes generation and cannot turn a late result into a card', async () => {
  const { adaptor, close } = rig();
  const controller = new AbortController();
  const result = generateInsights(() => adaptor, input, controller.signal);
  const rejection = expect(result).rejects.toThrow();
  await vi.waitFor(() => expect(adaptor.events).toHaveBeenCalled());
  controller.abort();
  await rejection;
  expect(close).toHaveBeenCalled();
});

it('reports a bounded model timeout distinctly and closes the owned child', async () => {
  const { adaptor, close } = rig();
  const timer = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(timer.signal);
  try {
    const result = generateInsights(
      () => adaptor,
      input,
      new AbortController().signal,
    );
    const rejected = expect(result).rejects.toThrow('feed_generation_timeout');
    await vi.waitFor(() => expect(adaptor.events).toHaveBeenCalled());
    expect(timeout).toHaveBeenCalledWith(300_000);
    timer.abort(new DOMException('Timed out', 'TimeoutError'));
    await rejected;
    expect(close).toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
  }
});

it('reports invalid output without exposing unverified model text', async () => {
  const { queue, adaptor, close } = rig();
  queue.push({
    type: 'turn_complete',
    jobRef: 'owned',
    summary: 'unverified private text',
  });
  await expect(
    generateInsights(() => adaptor, input, new AbortController().signal),
  ).rejects.toThrow('feed_invalid_response');
  expect(close).toHaveBeenCalled();
});
