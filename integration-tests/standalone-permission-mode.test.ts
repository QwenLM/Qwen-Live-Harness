/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  functionCallOutputOf,
  permissionPayloadOf,
  speechAnnouncementOf,
  contextTextOf,
  startFakeDashScopeServer,
} from './fake-dashscope-server.js';
import {
  FakeHost,
  readLiveDiscovery,
  spawnQwenLiveHarness,
  startLiveCall,
} from './qwen-live-harness.js';
import type { SubagentsControlResult } from '../packages/qwen-live-harness/src/subagents/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function boot(mode: 'ask' | 'allow-all') {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-live-permission-mode-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'data');
  const discoveryDir = join(directory, 'discovery');
  await mkdir(dataDir);
  await mkdir(discoveryDir);
  const fakeDash = await startFakeDashScopeServer();
  cleanups.push(() => fakeDash.close());
  const live = await spawnQwenLiveHarness({
    dataDir,
    discoveryDir,
    cwd: directory,
    realtimeEndpoint: fakeDash.url,
    initialConfig: {
      permissionMode: mode,
      userSetting: { preserved: 'untouched' },
    },
    backends: JSON.stringify([
      {
        name: 'acp',
        kind: 'acp',
        default: true,
        cwd: directory,
        command: process.execPath,
        args: [
          resolve(
            'packages/qwen-live-harness/test-fixtures/fake-acp-agent.mjs',
          ),
        ],
      },
    ]),
  });
  cleanups.push(() => live.dispose());
  const host = new FakeHost(discoveryDir);
  await host.connect();
  cleanups.push(async () => host.close());
  const { conn } = await startLiveCall({ host, fakeDash });
  let sequence = 0;
  async function handoff() {
    const fromIndex = fakeDash.inbox.length;
    const callId = `mode-handoff-${++sequence}`;
    conn.queueFunctionCall({
      name: 'handoff',
      argumentsJson: JSON.stringify({
        task: `permission: mode operation ${sequence}`,
      }),
      callId,
    });
    conn.speakTranscript(`Create the requested file ${sequence}.`);
    const message = await fakeDash.waitForMessage(
      (entry) => functionCallOutputOf(entry)?.callId === callId,
      { fromIndex },
    );
    const receipt = JSON.parse(functionCallOutputOf(message)!.output) as {
      job: string;
    };
    return { fromIndex, taskId: `harness:${receipt.job}` };
  }
  async function page() {
    const discovery = await readLiveDiscovery(discoveryDir);
    const res = await fetch(`${live.url}/live/subagents`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${discovery.token}`,
        'x-qwen-live-harness-nonce': discovery.instanceNonce,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'list' }),
    });
    const result = (await res.json()) as SubagentsControlResult;
    if (result.type !== 'page') throw new Error('Missing page');
    return result.page;
  }
  return { dataDir, fakeDash, host, handoff, page };
}

describe('global Harness permission mode through the shipped daemon', () => {
  it('loads allow-all and auto-approves with an important-operation notification, without an approval question', async () => {
    const r = await boot('allow-all');
    expect(
      r.host.messages.find((m) => m['type'] === 'host.welcome')?.[
        'permissionModeV1'
      ],
    ).toEqual({ mode: 'allow-all' });
    const task = await r.handoff();
    await expect
      .poll(
        async () =>
          (await r.page()).snapshot.tasks.find((t) => t.id === task.taskId)
            ?.status,
        { timeout: 10000 },
      )
      .toBe('completed');
    expect(
      r.fakeDash.inbox
        .slice(task.fromIndex)
        .some((m) => permissionPayloadOf(m)),
    ).toBe(false);
    const notice = await r.fakeDash.waitForMessage(
      (m) => speechAnnouncementOf(m) !== undefined,
      { fromIndex: task.fromIndex },
    );
    const announcement = speechAnnouncementOf(notice)!;
    expect(announcement).toMatch(
      /^Auto-approved the background agent to (run|use) .+\.$/,
    );
    expect(announcement).not.toMatch(/cwd|incomplete|started|completed/);
    await r.fakeDash.waitForMessage(
      (m) => {
        const text = contextTextOf(m);
        return (
          text?.includes('[RESULT_DELIVERY]') === true &&
          text.includes('"kind":"permission_execution"') &&
          text.includes('"status":"played"') &&
          text.includes(announcement)
        );
      },
      { fromIndex: task.fromIndex },
    );
  });

  it('persists mode changes, handles current waiting requests, rejects stale callers, and resumes asking when disabled', async () => {
    const r = await boot('ask');
    const first = await r.handoff();
    await r.fakeDash.waitForMessage(
      (m) => permissionPayloadOf(m)?.request_id === 'req_1',
      { fromIndex: first.fromIndex },
    );
    expect(await r.host.setPermissionMode('allow-all')).toMatchObject({
      ok: true,
      permissionModeV1: { mode: 'allow-all' },
    });
    await expect
      .poll(
        async () =>
          (await r.page()).snapshot.tasks.find((t) => t.id === first.taskId)
            ?.status,
        { timeout: 10000 },
      )
      .toBe('completed');
    expect(
      JSON.parse(await readFile(join(r.dataDir, 'config.json'), 'utf8')),
    ).toMatchObject({
      permissionMode: 'allow-all',
      userSetting: { preserved: 'untouched' },
    });
    expect(await r.host.setPermissionMode('ask')).toMatchObject({
      ok: true,
      permissionModeV1: { mode: 'ask' },
    });
    const second = await r.handoff();
    await r.fakeDash.waitForMessage(
      (m) => permissionPayloadOf(m)?.request_id === 'req_2',
      { fromIndex: second.fromIndex },
    );
    expect(
      (await r.page()).snapshot.tasks.find((t) => t.id === second.taskId)
        ?.status,
    ).toBe('waiting');
    expect(
      await r.host.setPermissionMode('allow-all', { nonce: 'wrong-daemon' }),
    ).toMatchObject({ ok: false });
    expect(
      JSON.parse(await readFile(join(r.dataDir, 'config.json'), 'utf8'))[
        'permissionMode'
      ],
    ).toBe('ask');
    expect(
      (await r.page()).snapshot.tasks.find((t) => t.id === second.taskId)
        ?.status,
    ).toBe('waiting');
  });
});
