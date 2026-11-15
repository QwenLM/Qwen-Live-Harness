import { expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { AcpAdaptor } from '../adaptor/acp-adaptor.js';
import { AsyncEventQueue } from '../adaptor/async-event-queue.js';
import type { BackendEvent } from '../adaptor/types.js';
import {
  generateFeedPresentation,
  parseFeedPresentation,
} from './feed-presentation.js';

const coverSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><rect width="640" height="400" fill="#163e35"/></svg>';
const input = {
  request: 'Create a report',
  output: 'Report completed',
  artifacts: [{ name: 'report.md', mimeType: 'text/markdown' }],
};

it('generates a cover through a real ACP child and cleans up its owned process', async () => {
  let adaptor: AcpAdaptor | undefined;
  const result = await generateFeedPresentation(
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
      });
      return adaptor;
    },
    input,
    new AbortController().signal,
  );
  expect(result.description).toContain('project report');
  expect(result.coverSvg).toContain('Project report');
  expect(
    (await adaptor!.listSessions()).every(
      (session) => session.state === 'closed',
    ),
  ).toBe(true);
});

it.each([
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/private"/></svg>',
  '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.com)"/></svg>',
])('rejects active or externally loaded cover content %s', (svg) => {
  expect(() =>
    parseFeedPresentation(
      JSON.stringify({ description: 'Report', coverSvg: svg }),
    ),
  ).toThrow();
});

it('bounds descriptions and replies while accepting a fenced JSON response', () => {
  expect(
    parseFeedPresentation(
      '```json\n' +
        JSON.stringify({ description: 'Report', coverSvg }) +
        '\n```',
    ).coverSvg,
  ).toBe(coverSvg);
  for (const description of ['', 'x'.repeat(241)]) {
    expect(() =>
      parseFeedPresentation(JSON.stringify({ description, coverSvg })),
    ).toThrow();
  }
  expect(() => parseFeedPresentation('x'.repeat(24_001))).toThrow();
});

it('ignores stale jobs, denies tool requests and closes the generation adaptor', async () => {
  const queue = new AsyncEventQueue<BackendEvent>();
  const adaptor = new AcpAdaptor({
    name: 'fixture',
    command: process.execPath,
    args: [],
  });
  vi.spyOn(adaptor, 'preflight').mockResolvedValue();
  vi.spyOn(adaptor, 'createSession').mockResolvedValue({
    id: 'cover',
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
  queue.push({
    type: 'turn_complete',
    jobRef: 'stale',
    summary: JSON.stringify({ description: 'Stale', coverSvg }),
  });
  queue.push({
    type: 'permission_request',
    jobRef: 'owned',
    requestId: 'write',
    title: 'Write a file',
    options: [],
  });
  await expect(
    generateFeedPresentation(
      () => adaptor,
      input,
      new AbortController().signal,
    ),
  ).rejects.toThrow('requested a tool');
  expect(deny).toHaveBeenCalledWith(
    { id: 'cover', adaptor: 'fixture' },
    'write',
    'deny',
  );
  expect(close).toHaveBeenCalled();
});

it('aborts generation and closes its child when the gateway shuts down', async () => {
  const queue = new AsyncEventQueue<BackendEvent>();
  const adaptor = new AcpAdaptor({
    name: 'fixture',
    command: process.execPath,
    args: [],
  });
  vi.spyOn(adaptor, 'preflight').mockResolvedValue();
  vi.spyOn(adaptor, 'createSession').mockResolvedValue({
    id: 'cover',
    adaptor: 'fixture',
  });
  vi.spyOn(adaptor, 'prompt').mockResolvedValue({
    status: 'accepted',
    jobRef: 'owned',
  });
  const events = vi
    .spyOn(adaptor, 'events')
    .mockImplementation((_handle, options) => queue.subscribe(options));
  const close = vi.spyOn(adaptor, 'close').mockImplementation(async () => {
    queue.end();
  });
  const controller = new AbortController();
  const result = generateFeedPresentation(
    () => adaptor,
    input,
    controller.signal,
  );
  const rejected = expect(result).rejects.toThrow();
  await vi.waitFor(() => expect(events).toHaveBeenCalled());
  controller.abort();
  await rejected;
  expect(close).toHaveBeenCalled();
});
