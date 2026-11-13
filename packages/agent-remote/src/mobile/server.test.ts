import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { AcpAdaptor } from '../adaptor/acp-adaptor.js';
import { MobileTasks } from './tasks.js';
import { MobileServer } from './server.js';
import { ensureMobileTLS } from './tls.js';

let directory: string, key: Buffer, cert: Buffer;
const servers: MobileServer[] = [];
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'qwen-mobile-https-test-'));
  ({ key, cert } = await ensureMobileTLS(directory, ['127.0.0.1']));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function setup(permissionMode: 'ask' | 'allow-all' = 'ask') {
  const fixture = fileURLToPath(
    new URL('../../test-fixtures/fake-acp-agent.mjs', import.meta.url),
  );
  const tasks = new MobileTasks(
    new Map(
      ['qwen', 'codex'].map((name) => [
        name,
        new AcpAdaptor({
          name,
          command: process.execPath,
          args: [fixture],
          env: { FAKE_ACP_MODES: 'default' },
          defaultCwd: directory,
        }),
      ]),
    ),
    [{ id: 'fixture', name: 'Fixture project', path: directory }],
    { permissionMode },
  );
  const server = new MobileServer(tasks, { key, cert });
  servers.push(server);
  const port = await server.listen(0, '127.0.0.1');
  const call = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Promise<{ status: number; value: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port,
            path,
            method: body === undefined ? 'GET' : 'POST',
            rejectUnauthorized: false,
            headers: {
              ...(body === undefined
                ? {}
                : { 'content-type': 'application/json' }),
              ...headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () =>
              resolve({
                status: res.statusCode!,
                value: JSON.parse(Buffer.concat(chunks).toString()) as Record<
                  string,
                  unknown
                >,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      },
    );
  const paired = await call('/v1/pair', { code: server.pairingCode });
  const headers = {
    authorization: `Bearer ${paired.value['token']}`,
    'x-live-run-id': tasks.runId,
  };
  return { tasks, server, call, headers };
}

it.each(['qwen', 'codex'])(
  'continues %s over HTTPS in the same ACP session without mixing results',
  async (backend) => {
    const { tasks, call, headers } = await setup('allow-all');
    expect(
      (await call('/v1/state', undefined, headers)).value['capabilities'],
    ).toEqual({ conversationTurns: true });
    const first = {
      id: randomUUID(),
      backend,
      project: 'fixture',
      text: 'First context',
    };
    expect((await call('/v1/tasks', first, headers)).status).toBe(202);
    await vi.waitFor(() =>
      expect(tasks.snapshot().tasks[0]!.status).toBe('completed'),
    );
    const second = {
      ...first,
      id: randomUUID(),
      conversationId: first.id,
      text: 'permission: Continue this context',
    };
    expect((await call('/v1/tasks', second, headers)).status).toBe(202);
    expect((await call('/v1/tasks', second, headers)).status).toBe(202);
    await vi.waitFor(() =>
      expect(tasks.snapshot().tasks[0]!.status).toBe('completed'),
    );
    const turns = tasks.snapshot().tasks;
    expect(turns).toHaveLength(2);
    expect(turns[0]!.conversationId).toBe(first.id);
    expect(turns[0]!.turnIndex).toBe(2);
    expect(turns[0]!.output).toContain(second.text);
    expect(turns[1]!.output).toContain(first.text);
    expect(turns[1]!.output).not.toContain(second.text);
    expect(
      (
        await call(
          '/v1/tasks',
          { ...second, id: randomUUID(), conversationId: 42 },
          headers,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          '/v1/tasks',
          { ...second, id: randomUUID() },
          { ...headers, 'x-live-run-id': 'old-run' },
        )
      ).status,
    ).toBe(409);
    expect(tasks.snapshot().tasks).toHaveLength(2);
  },
);

it('requires pairing and run identity, rejects browsers and does not expose desktop control', async () => {
  const { tasks, server, call, headers } = await setup();
  expect((await call('/v1/state')).status).toBe(401);
  expect((await call('/v1/pair', { code: server.pairingCode })).status).toBe(
    410,
  );
  expect(
    (
      await call('/v1/state', undefined, {
        ...headers,
        origin: 'https://attacker.invalid',
      })
    ).status,
  ).toBe(403);
  expect((await call('/live/quit', {}, headers)).status).toBe(404);
  expect(
    (
      await call(
        '/v1/tasks',
        {
          id: randomUUID(),
          backend: 'qwen',
          project: 'fixture',
          text: 'do not run',
        },
        { ...headers, 'x-live-run-id': 'old-process' },
      )
    ).status,
  ).toBe(409);
  expect(tasks.snapshot().tasks).toHaveLength(0);
  expect(
    (
      await call(
        '/v1/tasks',
        {
          id: randomUUID(),
          backend: 'qwen',
          project: directory,
          text: 'no arbitrary path',
        },
        headers,
      )
    ).status,
  ).toBe(404);
  expect(
    (await call('/v1/tasks', { text: 'x'.repeat(40_000) }, headers)).status,
  ).toBe(413);
});

it.each(['qwen', 'codex'])(
  'runs %s through HTTPS and a real ACP child, waits for approval, then completes exactly once',
  async (backend) => {
    const { tasks, call, headers } = await setup();
    const input = {
      id: randomUUID(),
      backend,
      project: 'fixture',
      text: 'permission: mobile approval fixture',
    };
    expect((await call('/v1/tasks', input, headers)).status).toBe(202);
    expect((await call('/v1/tasks', input, headers)).status).toBe(202);
    await vi.waitFor(
      () => expect(tasks.snapshot().tasks[0]!.status).toBe('waiting'),
      { timeout: 10_000 },
    );
    expect(tasks.snapshot().tasks).toHaveLength(1);
    const pending = tasks.snapshot().tasks[0]!.permissions[0]!;
    const vote = { requestId: pending.id, decision: 'allow' };
    expect(
      (await call(`/v1/tasks/${input.id}/permission`, vote, headers)).status,
    ).toBe(200);
    await vi.waitFor(() =>
      expect(tasks.snapshot().tasks[0]!.status).toBe('completed'),
    );
    expect(tasks.snapshot().tasks[0]!.output).toContain('permission granted');
    expect(
      (await call(`/v1/tasks/${input.id}/permission`, vote, headers)).status,
    ).toBe(409);
  },
);

it('renews a one-time code locally without changing paired credentials, tasks or run identity', async () => {
  const { server, tasks, call, headers } = await setup();
  const oldCode = server.pairingCode;
  expect(
    (await call('/v1/pairing', {}, { ...headers, 'x-live-run-id': 'old-run' }))
      .status,
  ).toBe(409);
  const renewed = await call('/v1/pairing', {}, headers);
  expect(renewed.status).toBe(200);
  expect(renewed.value['code']).not.toBe(oldCode);
  expect((await call('/v1/pair', { code: oldCode })).status).toBe(401);
  const paired = await call('/v1/pair', { code: renewed.value['code'] });
  expect('Bearer ' + paired.value['token']).toBe(headers.authorization);
  expect(paired.value['runId']).toBe(tasks.runId);
  expect((await call('/v1/state', undefined, headers)).status).toBe(200);
  expect(tasks.snapshot().tasks).toHaveLength(0);
});

it('forwards denial without approving or claiming success', async () => {
  const { tasks, call, headers } = await setup();
  const input = {
    id: randomUUID(),
    backend: 'qwen',
    project: 'fixture',
    text: 'permission: deny mobile fixture',
  };
  await call('/v1/tasks', input, headers);
  await vi.waitFor(
    () => expect(tasks.snapshot().tasks[0]!.status).toBe('waiting'),
    { timeout: 10_000 },
  );
  const requestId = tasks.snapshot().tasks[0]!.permissions[0]!.id;
  await call(
    `/v1/tasks/${input.id}/permission`,
    { requestId, decision: 'deny' },
    headers,
  );
  await vi.waitFor(() =>
    expect(tasks.snapshot().tasks[0]!.status).toBe('cancelled'),
  );
  expect(tasks.snapshot().tasks[0]!.output).not.toContain('permission granted');
});

it.each(['qwen', 'codex'])(
  'completes %s through automatic one-time approval without a phone vote',
  async (backend) => {
    const { tasks, call, headers } = await setup('allow-all');
    const input = {
      id: randomUUID(),
      backend,
      project: 'fixture',
      text: 'permission: automatically approve mobile fixture',
    };
    expect((await call('/v1/tasks', input, headers)).status).toBe(202);
    await vi.waitFor(
      () => expect(tasks.snapshot().tasks[0]!.status).toBe('completed'),
      { timeout: 10_000 },
    );
    expect(tasks.snapshot().tasks[0]!.permissions).toHaveLength(0);
    expect(tasks.snapshot().tasks[0]!.output).toContain('permission granted');
  },
);
