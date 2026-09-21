/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Native mid-turn steering over ACP, in CI.
 *
 * Steering is PULLED: the agent calls the client's `craft/drainMidTurnQueue`
 * between tool batches, and until it has pulled once the harness honestly
 * degrades to queue-until-idle. The scripted fixture never pulled, so this
 * tier had no coverage outside `test:backends` — which needs a built Qwen
 * Code CLI and does not run in CI. `FAKE_ACP_DRAINS` makes the fixture pull
 * the way a real agent does, so the whole path is exercisable here.
 *
 * What this pins down: a handoff aimed at a busy session reports that it
 * joined the running task, the instruction really reaches THAT turn, and the
 * turn's completion carries it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  startFakeDashScopeServer,
  contextTextOf,
  functionCallOutputOf,
  type FakeDashScopeServer,
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import {
  FakeHost,
  spawnQwenLiveHarness,
  startLiveCall,
  waitForLiveResponseAfter,
  type SpawnedQwenLiveHarness,
} from './qwen-live-harness.js';

const AGENT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../packages/qwen-live-harness/test-fixtures/fake-acp-agent.mjs',
);

describe('standalone daemon steering an ACP turn mid-flight', () => {
  let temporary: string;
  let dataDir: string;
  let fakeDash: FakeDashScopeServer;
  let live: SpawnedQwenLiveHarness;
  let host: FakeHost;
  let conn: FakeDashScopeConnection;

  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'qwen-live-harness-steer-'));
    dataDir = join(temporary, 'data');
    const discoveryDir = join(temporary, 'discovery');
    await mkdir(dataDir);
    await mkdir(discoveryDir);
    fakeDash = await startFakeDashScopeServer();
    live = await spawnQwenLiveHarness({
      dataDir,
      discoveryDir,
      cwd: temporary,
      realtimeEndpoint: fakeDash.url,
      backends: JSON.stringify([
        {
          name: 'steerable-acp',
          kind: 'acp',
          command: process.execPath,
          args: [AGENT],
          // Hold turns open for up to ~10s waiting for steering, and settle
          // immediately once it lands. A generous budget keeps the test off
          // the wall clock without slowing the path it exercises.
          env: { FAKE_ACP_DRAINS: '100', FAKE_ACP_DRAIN_DELAY_MS: '100' },
          cwd: temporary,
          default: true,
        },
      ]),
    });
    host = new FakeHost(discoveryDir);
    await host.connect();
    conn = (await startLiveCall({ host, fakeDash })).conn;
  });

  afterAll(async () => {
    host?.close();
    await live?.dispose();
    await fakeDash?.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  async function handoff(request: string, task: string, callId: string) {
    const fromIndex = fakeDash.inbox.length;
    conn.queueFunctionCall({
      name: 'handoff',
      argumentsJson: JSON.stringify({ task }),
      callId,
    });
    conn.speakTranscript(request);
    const message = await fakeDash.waitForMessage(
      (m) => functionCallOutputOf(m)?.callId === callId,
      { fromIndex, description: `the handoff receipt for ${callId}` },
    );
    // A handoff receipt has its own continuation, even when its admission
    // audio is muted. Do not let that request consume the next queued tool
    // call which belongs to a different real user turn.
    await waitForLiveResponseAfter(
      { fakeDash, dataDir },
      message,
      'tool_continuation',
    );
    return {
      fromIndex,
      receipt: JSON.parse(functionCallOutputOf(message)!.output) as Record<
        string,
        unknown
      >,
    };
  }

  function waitForComplete(job: string, fromIndex: number) {
    return fakeDash.waitForMessage(
      (m) => contextTextOf(m)?.includes(`[COMPLETE ${job}]`) ?? false,
      { fromIndex, description: `[COMPLETE ${job}]` },
    );
  }

  it('joins a follow-up into the turn already running and completes with it', async () => {
    // The fixture pulls once at session/new, so native steering is available
    // from the first turn — no warm-up round trip, nothing timing-dependent.
    const long = await handoff(
      'Please run the project test suite.',
      'long running task',
      'steer-long',
    );
    expect(long.receipt['status']).toBe('accepted');

    const followUp = await handoff(
      'Please run only the unit tests and skip integration tests.',
      'also skip integration',
      'steer-follow',
    );
    expect(followUp.receipt['status']).toBe('accepted');
    // Native steering, not the queue-until-idle degradation.
    expect(String(followUp.receipt['note'])).toContain(
      'joined the currently running task',
    );

    // And it really reached that turn: the fixture echoes what it pulled,
    // and the echo shows up in the running task's completion.
    const complete = await waitForComplete(
      String(long.receipt['job']),
      long.fromIndex,
    );
    expect(contextTextOf(complete)).toContain('steered: also skip integration');
    // Which turn owns the instruction is pinned precisely by the adaptor
    // unit tests (`turn_joined`); here the receipt handle is deliberately
    // not asserted, because it is minted before that event can arrive and
    // is aliased onto the running job afterwards.
  });
});
