import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  BackendAdaptor,
  BackendEvent,
  BackendHandle,
  ContentBlock,
} from '../adaptor/types.js';
import { AsyncEventQueue } from '../adaptor/async-event-queue.js';
import { MobileTasks } from './tasks.js';

class FakeAdaptor implements BackendAdaptor {
  queues = new Map<string, AsyncEventQueue<BackendEvent>>();
  sessions: BackendHandle[] = [];
  promptCalls = 0;
  early: BackendEvent[] = [];
  constructor(readonly name: string) {}
  capabilities() {
    return {
      steering: 'none' as const,
      imageInput: false,
      permissionForwarding: true,
      proactiveSpeak: false,
      sessionList: false,
      eventDelivery: 'stream' as const,
    };
  }
  preflight = vi.fn(async () => {});
  async createSession(_options?: { cwd?: string; label?: string }) {
    const handle = { adaptor: this.name, id: randomUUID() };
    this.sessions.push(handle);
    this.queues.set(handle.id, new AsyncEventQueue());
    return handle;
  }
  async listSessions() {
    return [];
  }
  async prompt(handle: BackendHandle, _blocks: readonly ContentBlock[]) {
    this.promptCalls++;
    for (const event of this.early) this.emit(event, handle);
    return { status: 'accepted' as const, jobRef: `job-${this.promptCalls}` };
  }
  events(handle: BackendHandle, options?: { signal?: AbortSignal }) {
    return this.queues.get(handle.id)!.subscribe(options);
  }
  isBusy() {
    return true;
  }
  async cancel() {}
  cancelJob = vi.fn(async () => 'stopping' as const);
  respondPermission = vi.fn(
    async (_handle: BackendHandle, _id: string, _decision: string) =>
      'delivered' as const,
  );
  async close() {
    for (const queue of this.queues.values()) queue.end();
  }
  emit(event: BackendEvent, handle = this.sessions.at(-1)!) {
    this.queues.get(handle.id)!.push(event);
  }
}

const services: MobileTasks[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});
function setup(permissionMode: 'ask' | 'allow-all' = 'ask') {
  const qwen = new FakeAdaptor('qwen'),
    codex = new FakeAdaptor('codex');
  const service = new MobileTasks(
    new Map([
      ['qwen', qwen],
      ['codex', codex],
    ]),
    [{ id: 'project', name: 'Project', path: '/tmp/mobile-test' }],
    { permissionMode },
  );
  services.push(service);
  const submit = (backend = 'qwen', id: string = randomUUID()) =>
    service.submit({ id, backend, project: 'project', text: 'User task' });
  return { service, qwen, codex, submit };
}
const permission: BackendEvent = {
  type: 'permission_request',
  jobRef: 'job-1',
  requestId: 'permission-1',
  title: 'Write fixture file',
  details: { command: 'write fixture.txt', cwd: '/tmp/mobile-test' },
  options: [
    { optionId: 'once', kind: 'proceed', escalation: 'once' },
    { optionId: 'never', kind: 'reject', escalation: 'once' },
  ],
};

describe('mobile task ownership', () => {
  it('continues the exact owned session with independent, deduplicated turns', async () => {
    const { service, qwen, submit } = setup();
    const first = submit();
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
    qwen.emit({
      type: 'turn_complete',
      jobRef: 'job-1',
      summary: 'First result',
    });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('completed'),
    );
    const input = {
      id: randomUUID(),
      backend: 'qwen',
      project: 'project',
      conversationId: first.id,
      text: 'Continue the work',
    };
    const next = service.submit(input);
    service.submit(input);
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(2));
    expect(qwen.sessions).toHaveLength(1);
    expect(next.conversationId).toBe(first.id);
    expect(next.turnIndex).toBe(2);
    expect(() => service.submit({ ...input, id: randomUUID() })).toThrow(
      'conversation_busy',
    );
    expect(() =>
      service.submit({ ...input, conversationId: undefined }),
    ).toThrow('idempotency_conflict');
    expect(() =>
      service.submit({ ...input, id: randomUUID(), backend: 'codex' }),
    ).toThrow('conversation_target_mismatch');
    expect(() =>
      service.submit({
        ...input,
        id: randomUUID(),
        conversationId: randomUUID(),
      }),
    ).toThrow('conversation_not_found');
    qwen.emit({
      type: 'turn_complete',
      jobRef: 'job-1',
      summary: 'Stale result',
    });
    qwen.emit({ ...permission, jobRef: 'job-1' });
    qwen.emit({ ...permission, jobRef: 'job-2' });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.permissions).toHaveLength(1),
    );
    const approval = service.snapshot().tasks[0]!.permissions[0]!;
    await expect(
      service.permission(first.id, approval.id, 'allow'),
    ).rejects.toThrow('permission_expired');
    await service.permission(next.id, approval.id, 'allow');
    expect(qwen.respondPermission).toHaveBeenCalledTimes(1);
    await service.cancel(first.id);
    expect(qwen.cancelJob).not.toHaveBeenCalled();
    qwen.emit({
      type: 'turn_complete',
      jobRef: 'job-2',
      summary: 'Second result',
    });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('completed'),
    );
    expect(service.snapshot().tasks.map((task) => task.output)).toEqual([
      'Second result',
      'First result',
    ]);
    expect(service.snapshot().tasks[0]!.canContinue).toBe(true);
    expect(qwen.promptCalls).toBe(2);
  });

  it('keeps the owned context when a follow-up is stopped before it is submitted', async () => {
    const { service, qwen, submit } = setup();
    const first = submit();
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
    qwen.emit({
      type: 'turn_complete',
      jobRef: 'job-1',
      summary: 'Original result',
    });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('completed'),
    );
    const input = {
      id: randomUUID(),
      backend: 'qwen',
      project: 'project',
      conversationId: first.id,
      text: 'Stop before sending',
    };
    const cancelled = service.submit(input);
    await service.cancel(cancelled.id);
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('cancelled'),
    );
    expect(qwen.promptCalls).toBe(1);
    expect(service.snapshot().tasks[0]!.canContinue).toBe(true);
    const next = service.submit({
      ...input,
      id: randomUUID(),
      text: 'Continue instead',
    });
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(2));
    expect(next.turnIndex).toBe(3);
    expect(qwen.sessions).toHaveLength(1);
  });

  it('cannot continue an interrupted session or silently create a replacement', async () => {
    const { service, qwen, submit } = setup();
    const first = submit();
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
    qwen.emit({ type: 'session_closed' });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('interrupted'),
    );
    expect(service.snapshot().tasks[0]!.canContinue).toBe(false);
    expect(() =>
      service.submit({
        id: randomUUID(),
        backend: 'qwen',
        project: 'project',
        conversationId: first.id,
        text: 'Retry',
      }),
    ).toThrow('conversation_unavailable');
    expect(qwen.sessions).toHaveLength(1);
    expect(qwen.promptCalls).toBe(1);
  });

  it('stops only the current follow-up and waits for its own confirmation', async () => {
    const { service, qwen, submit } = setup();
    const first = submit();
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
    qwen.emit({ type: 'turn_complete', jobRef: 'job-1', summary: 'Done' });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('completed'),
    );
    const next = service.submit({
      id: randomUUID(),
      backend: 'qwen',
      project: 'project',
      conversationId: first.id,
      text: 'Follow up',
    });
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(2));
    await service.cancel(next.id);
    expect(qwen.cancelJob).toHaveBeenCalledWith(qwen.sessions[0], 'job-2');
    expect(service.snapshot().tasks[0]!.status).toBe('cancelling');
    qwen.emit({ type: 'turn_error', jobRef: 'job-1', error: 'cancelled' });
    qwen.emit({ type: 'turn_error', jobRef: 'job-2', error: 'cancelled' });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('cancelled'),
    );
    const third = service.submit({
      id: randomUUID(),
      backend: 'qwen',
      project: 'project',
      conversationId: first.id,
      text: 'A different approach',
    });
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(3));
    expect(third.turnIndex).toBe(3);
    expect(qwen.sessions).toHaveLength(1);
    expect(service.snapshot().tasks[1]!.output).not.toBe('Done');
  });
  it('automatically grants only the real current request in allow-all mode without claiming task completion', async () => {
    const { service, qwen, submit } = setup('allow-all');
    submit();
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
    qwen.emit({ ...permission, jobRef: 'old-job' });
    qwen.emit(permission);
    await vi.waitFor(() =>
      expect(qwen.respondPermission).toHaveBeenCalledTimes(1),
    );
    expect(qwen.respondPermission).toHaveBeenCalledWith(
      qwen.sessions[0],
      'permission-1',
      'allow',
    );
    expect(service.snapshot().permissionMode).toBe('allow-all');
    expect(service.snapshot().tasks[0]!.permissions).toHaveLength(0);
    expect(service.snapshot().tasks[0]!.status).toBe('running');
  });

  it.each([{ incomplete: true }, { rawInput: { command: 'x'.repeat(9000) } }])(
    'keeps manual approval disabled for incomplete or undisplayed details: %j',
    async (details) => {
      const { service, qwen, submit } = setup();
      const task = submit();
      await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
      qwen.emit({ ...permission, details } as BackendEvent);
      await vi.waitFor(() =>
        expect(service.snapshot().tasks[0]!.permissions).toHaveLength(1),
      );
      const pending = service.snapshot().tasks[0]!.permissions[0]!;
      expect(pending.canAllow).toBe(false);
      await expect(
        service.permission(task.id, pending.id, 'allow'),
      ).rejects.toThrow('permission_details_incomplete');
      expect(qwen.respondPermission).not.toHaveBeenCalled();
      await service.permission(task.id, pending.id, 'deny');
      expect(qwen.respondPermission).toHaveBeenCalledWith(
        qwen.sessions[0],
        'permission-1',
        'deny',
      );
    },
  );
  it('routes to the named backend, deduplicates retries, and never infers completion from admission', async () => {
    const { service, qwen, codex, submit } = setup();
    const task = submit('codex');
    submit('codex', task.id);
    await vi.waitFor(() => expect(codex.promptCalls).toBe(1));
    expect(qwen.promptCalls).toBe(0);
    expect(service.snapshot().tasks[0]!.status).toBe('running');
    expect(() => submit('qwen', task.id)).toThrow('idempotency_conflict');
    codex.emit({
      type: 'turn_complete',
      jobRef: 'stale-job',
      summary: 'stale',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.snapshot().tasks[0]!.status).toBe('running');
    codex.emit({
      type: 'turn_complete',
      jobRef: 'job-1',
      summary: 'Actual result',
    });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('completed'),
    );
    expect(service.snapshot().tasks[0]!.output).toBe('Actual result');
    expect(() =>
      service.submit({
        id: randomUUID(),
        backend: 'qwen',
        project: '/etc',
        text: 'test',
      }),
    ).toThrow('target_not_found');
  });

  it('binds one-time approvals to their owned task and rejects stale decisions without voting', async () => {
    const { service, qwen, submit } = setup();
    const task = submit();
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
    qwen.emit(permission);
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.permissions).toHaveLength(1),
    );
    expect(service.snapshot().tasks[0]!.status).toBe('waiting');
    const request = service.snapshot().tasks[0]!.permissions[0]!;
    const other = submit('codex');
    await expect(
      service.permission(other.id, request.id, 'allow'),
    ).rejects.toThrow('permission_expired');
    expect(qwen.respondPermission).not.toHaveBeenCalled();
    await service.permission(task.id, request.id, 'allow');
    expect(qwen.respondPermission).toHaveBeenCalledWith(
      qwen.sessions[0],
      'permission-1',
      'allow',
    );
    expect(
      service.snapshot().tasks.find((row) => row.id === task.id)!.status,
    ).toBe('running');
    await expect(
      service.permission(task.id, request.id, 'deny'),
    ).rejects.toThrow('permission_expired');
    expect(qwen.respondPermission).toHaveBeenCalledTimes(1);
  });

  it('never upgrades a missing once option to a persistent grant and can still deny', async () => {
    const { service, qwen, submit } = setup();
    const task = submit();
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
    qwen.emit({
      ...permission,
      options: [
        { optionId: 'always', kind: 'proceed', escalation: 'always' },
        { optionId: 'deny', kind: 'reject' },
      ],
    } as BackendEvent);
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.permissions).toHaveLength(1),
    );
    const request = service.snapshot().tasks[0]!.permissions[0]!;
    expect(request.canAllow).toBe(false);
    await expect(
      service.permission(task.id, request.id, 'allow'),
    ).rejects.toThrow('no_one_time_option');
    expect(qwen.respondPermission).not.toHaveBeenCalled();
    await service.permission(task.id, request.id, 'deny');
    expect(qwen.respondPermission).toHaveBeenCalledWith(
      qwen.sessions[0],
      'permission-1',
      'deny',
    );
  });

  it('retains cancelling until a backend outcome and blocks queued approval after stop', async () => {
    const { service, qwen, submit } = setup();
    const task = submit();
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
    qwen.emit(permission);
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.permissions).toHaveLength(1),
    );
    const request = service.snapshot().tasks[0]!.permissions[0]!;
    const vote = service.permission(task.id, request.id, 'allow');
    const rejection = expect(vote).rejects.toThrow('permission_expired');
    await service.cancel(task.id);
    await rejection;
    expect(qwen.respondPermission).not.toHaveBeenCalled();
    expect(service.snapshot().tasks[0]!.status).toBe('cancelling');
    expect(qwen.cancelJob).toHaveBeenCalledWith(qwen.sessions[0], 'job-1');
    qwen.emit({ type: 'turn_error', jobRef: 'job-1', error: 'cancelled' });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('cancelled'),
    );
  });

  it('captures events arriving before the prompt receipt and reports a broken stream as unknown', async () => {
    const { service, qwen, submit } = setup();
    qwen.early = [permission];
    submit();
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.permissions).toHaveLength(1),
    );
    qwen.queues.get(qwen.sessions[0]!.id)!.end();
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('interrupted'),
    );
    expect(service.snapshot().tasks[0]!.permissions).toHaveLength(0);
  });

  it('cancels before preflight without ever submitting a prompt', async () => {
    const { service, qwen, submit } = setup();
    let finish!: () => void;
    qwen.preflight.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const task = submit();
    await service.cancel(task.id);
    finish();
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('cancelled'),
    );
    expect(qwen.promptCalls).toBe(0);
    expect(qwen.sessions).toHaveLength(0);
  });
});
