import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  functionCallOutputOf,
  startFakeDashScopeServer,
  type FakeDashScopeConnection,
  type FakeDashScopeServer,
} from './fake-dashscope-server.js';
import {
  FakeHost,
  spawnQwenLiveHarness,
  startLiveCall,
  waitForLiveResponseAfter,
  type SpawnedQwenLiveHarness,
} from './qwen-live-harness.js';

type Json = Record<string, unknown>;

describe('native Realtime search isolated from foreground function tools', () => {
  let directory: string;
  let dataDir: string;
  let live: SpawnedQwenLiveHarness;
  let fakeDash: FakeDashScopeServer;
  let host: FakeHost;
  let conn: FakeDashScopeConnection;
  const answer =
    'A current synthetic result. Source: https://example.invalid/reference';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'qwen-live-search-integration-'));
    dataDir = join(directory, 'data');
    const discoveryDir = join(directory, 'discovery');
    await mkdir(dataDir);
    await mkdir(discoveryDir);
    fakeDash = await startFakeDashScopeServer({
      nativeSearchReply: { answer, searchCount: 1 },
    });
    live = await spawnQwenLiveHarness({
      dataDir,
      discoveryDir,
      cwd: directory,
      realtimeEndpoint: fakeDash.url,
      model: 'qwen3.5-omni-plus-realtime',
      env: { PATH: '' },
      initialConfig: {
        backends: [],
        memory: {
          enabled: true,
          updater: { enabled: false },
          observer: { enabled: false },
          retrieve: { useVector: false },
        },
        proactive: { enabled: true },
      },
    });
    host = new FakeHost(discoveryDir);
    await host.connect();
    ({ conn } = await startLiveCall({ host, fakeDash }));
  });

  afterAll(async () => {
    host?.close();
    await live?.dispose();
    await fakeDash?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function tool(name: string, args: Json, callId: string) {
    const fromIndex = fakeDash.inbox.length;
    conn.queueFunctionCall({
      name,
      argumentsJson: JSON.stringify(args),
      callId,
    });
    conn.speakTranscript(`Please run ${name}.`);
    const message = await fakeDash.waitForMessage(
      (value) => functionCallOutputOf(value)?.callId === callId,
      { fromIndex },
    );
    await waitForLiveResponseAfter(
      { fakeDash, dataDir },
      message,
      'tool_continuation',
    );
    return functionCallOutputOf(message)!.output;
  }

  it('opens a separate text-only native search and returns its result for speech', async () => {
    const query = 'Find the current synthetic public information.';
    const receipt = JSON.parse(
      await tool('web_search', { query }, 'native-query'),
    ) as Json;
    expect(receipt).toMatchObject({
      status: 'ok',
      answer,
      searchStatus: 'performed',
    });
    expect(fakeDash.connections).toHaveLength(2);
    const search = fakeDash.connections[1]!;
    const updates = search.inbox.filter(
      (value) => value['type'] === 'session.update',
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.['session']).toMatchObject({
      modalities: ['text'],
      tools: [],
      enable_search: true,
      search_options: { enable_source: true },
    });
    expect(updates[0]?.['session']).not.toHaveProperty('voice');
    expect(
      search.inbox.some(
        (value) =>
          value['type'] === 'input_audio_buffer.append' ||
          value['type'] === 'input_image_buffer.append',
      ),
    ).toBe(false);
    const input = search.inbox.find(
      (value) => value['type'] === 'conversation.item.create',
    )?.['item'] as Json;
    expect(input).toMatchObject({
      role: 'user',
      content: [{ type: 'input_text', text: query }],
    });
    expect(
      search.inbox.filter(
        (value) => value['type'] === 'conversation.item.create',
      ),
    ).toHaveLength(1);
    expect(search.inbox.some((value) => functionCallOutputOf(value))).toBe(
      false,
    );
    await expect
      .poll(() => search.socket.readyState)
      .toBe(search.socket.CLOSED);
  });

  it('keeps the search function and existing tools after a Memory configuration update', async () => {
    await tool(
      'omnibio',
      { operations: { add: ['The user prefers concise search summaries.'] } },
      'search-memory-update',
    );
    const updates = conn.inbox.filter(
      (value) => value['type'] === 'session.update',
    );
    expect(updates.length).toBeGreaterThan(1);
    for (const update of updates) {
      const session = update['session'] as Json;
      expect(session['enable_search']).not.toBe(true);
      const names = (
        session['tools'] as Array<{ function: { name: string } }>
      ).map((value) => value.function.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'web_search',
          'appshot',
          'omnibio',
          'create_proactive_monitor',
        ]),
      );
    }
    const result = JSON.parse(
      await tool('handoff', { task: 'Create a file' }, 'search-not-execution'),
    ) as Json;
    expect(result).toMatchObject({ status: 'error', code: 'no_backend' });
    expect(live.proc.exitCode).toBeNull();
  });
});
