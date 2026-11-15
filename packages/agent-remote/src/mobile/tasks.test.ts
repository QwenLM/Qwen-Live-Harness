import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BackendAdaptor,
  BackendEvent,
  BackendHandle,
  ContentBlock,
} from '../adaptor/types.js';
import { AsyncEventQueue } from '../adaptor/async-event-queue.js';
import { MobileTasks } from './tasks.js';
import type {
  FeedPresentation,
  FeedPresentationInput,
} from './feed-presentation.js';

class FakeAdaptor implements BackendAdaptor {
  queues = new Map<string, AsyncEventQueue<BackendEvent>>();
  sessions: BackendHandle[] = [];
  promptCalls = 0;
  supportsImages = false;
  prompts: ContentBlock[][] = [];
  early: BackendEvent[] = [];
  constructor(readonly name: string) {}
  capabilities() {
    return {
      steering: 'none' as const,
      imageInput: this.supportsImages,
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
    this.prompts.push([..._blocks]);
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
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});
function setup(
  permissionMode: 'ask' | 'allow-all' = 'ask',
  generatePresentation?: (
    backend: string,
    input: FeedPresentationInput,
    signal: AbortSignal,
  ) => Promise<FeedPresentation>,
) {
  const qwen = new FakeAdaptor('qwen'),
    codex = new FakeAdaptor('codex');
  const service = new MobileTasks(
    new Map([
      ['qwen', qwen],
      ['codex', codex],
    ]),
    [{ id: 'project', name: 'Project', path: '/tmp/mobile-test' }],
    { permissionMode, generatePresentation },
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
  it('generates an owned feed cover once after completion without delaying follow-ups or changing the result', async () => {
    let resolve!: (value: FeedPresentation) => void;
    const generate = vi.fn(
      (_backend: string, _input: FeedPresentationInput, signal: AbortSignal) =>
        new Promise<FeedPresentation>((done, reject) => {
          resolve = done;
          signal.addEventListener('abort', () => reject(new Error('Stopped')), {
            once: true,
          });
        }),
    );
    const { service, qwen, submit } = setup('ask', generate);
    const original = submit();
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
    qwen.emit({
      type: 'artifact',
      jobRef: 'job-1',
      source: {
        type: 'inline',
        name: 'report.md',
        mimeType: 'text/markdown',
        data: Buffer.from('# Result').toString('base64'),
      },
    });
    qwen.emit({
      type: 'turn_complete',
      jobRef: 'job-1',
      summary: 'Original completed result',
    });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const completed = service.snapshot().tasks[0]!;
    expect(completed).toMatchObject({
      status: 'completed',
      output: 'Original completed result',
      canContinue: true,
      presentationPending: true,
    });
    submit('qwen', original.id);
    expect(generate).toHaveBeenCalledTimes(1);
    service.submit({
      id: randomUUID(),
      conversationId: original.id,
      backend: 'qwen',
      project: 'project',
      text: 'Follow up',
    });
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(2));
    resolve({
      description: 'A completed project report.',
      coverSvg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"></svg>',
    });
    await vi.waitFor(() =>
      expect(
        service.snapshot().tasks.find((task) => task.id === original.id)
          ?.presentation,
      ).toBeDefined(),
    );
    const enriched = service
      .snapshot()
      .tasks.find((task) => task.id === original.id)!;
    expect(enriched.output).toBe(completed.output);
    expect(enriched.finishedAt).toBe(completed.finishedAt);
    expect(enriched.updatedAt).toBe(completed.updatedAt);
    expect(enriched.artifacts).toEqual(completed.artifacts);
    expect(enriched.presentationPending).toBe(false);
    const cover = enriched.presentation!.cover;
    expect(service.artifact(original.id, cover.id)).toMatchObject({
      name: 'cover.svg',
      mimeType: 'image/svg+xml',
      taskId: original.id,
      runId: service.runId,
    });
    expect(() =>
      service.artifact(service.snapshot().tasks[0]!.id, cover.id),
    ).toThrow();
    expect(qwen.sessions).toHaveLength(1);
  });

  it('keeps task output and artifacts when optional cover generation fails', async () => {
    const generate = vi.fn(async () => {
      throw new Error('Generation failed');
    });
    const { service, qwen, submit } = setup('allow-all', generate);
    submit();
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
    qwen.emit({
      type: 'artifact',
      jobRef: 'job-1',
      source: {
        type: 'inline',
        mimeType: 'text/markdown',
        data: Buffer.from('# Result').toString('base64'),
      },
    });
    qwen.emit({
      type: 'turn_complete',
      jobRef: 'job-1',
      summary: 'Original output',
    });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.presentationPending).toBe(false),
    );
    expect(service.snapshot().tasks[0]).toMatchObject({
      status: 'completed',
      output: 'Original output',
      presentationPending: false,
    });
    expect(service.snapshot().tasks[0]!.artifacts).toHaveLength(1);
    expect(service.snapshot().tasks[0]!.presentation).toBeUndefined();
  });

  it('does not generate covers for failed or cancelled tasks or text-only results', async () => {
    const generate = vi.fn();
    const { service, qwen, submit } = setup('ask', generate);
    for (const error of ['failed', 'cancelled']) {
      submit();
      await vi.waitFor(() =>
        expect(qwen.promptCalls).toBe(error === 'failed' ? 1 : 2),
      );
      qwen.emit({
        type: 'turn_error',
        jobRef: `job-${qwen.promptCalls}`,
        error,
      });
      await vi.waitFor(() =>
        expect(service.snapshot().tasks[0]!.status).toBe(error),
      );
    }
    submit();
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(3));
    qwen.emit({ type: 'turn_complete', jobRef: 'job-3', summary: 'Text only' });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('completed'),
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it('keeps completed results but refuses artifact collection after a selected folder is replaced', async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'mobile-owned-folder-')),
    );
    directories.push(directory);
    const folder = join(directory, 'work');
    await mkdir(folder);
    const qwen = new FakeAdaptor('qwen');
    const service = new MobileTasks(new Map([['qwen', qwen]]), [
      { id: 'root', name: 'Fixture', path: directory },
    ]);
    services.push(service);
    const selected = await service.selectDirectory('root', 'work');
    service.submit({
      id: randomUUID(),
      backend: 'qwen',
      project: selected.project.id,
      text: 'Collect result',
    });
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
    qwen.emit({
      type: 'artifact',
      jobRef: 'job-1',
      source: {
        type: 'inline',
        mimeType: 'text/markdown',
        data: Buffer.from('# Result').toString('base64'),
      },
    });
    await rename(folder, folder + '-old');
    await symlink(directory, folder);
    qwen.emit({
      type: 'turn_complete',
      jobRef: 'job-1',
      summary: 'Real completed output',
    });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.artifactsPending).toBe(false),
    );
    expect(service.snapshot().tasks[0]).toMatchObject({
      status: 'completed',
      output: 'Real completed output',
      artifacts: [],
      artifactNotice: 'artifact_unavailable',
    });
  });

  const image = () => ({
    id: randomUUID(),
    name: 'test.png',
    mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  });

  it('delivers image-only and mixed follow-ups to the exact owned session and deduplicates all image bytes', async () => {
    const { service, qwen } = setup();
    qwen.supportsImages = true;
    const attachment = image();
    const input = {
      id: randomUUID(),
      backend: 'qwen',
      project: 'project',
      text: '',
      attachments: [attachment],
    };
    const first = service.submit(input);
    service.submit(input);
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
    expect(qwen.prompts[0]).toEqual([
      {
        type: 'image',
        mimeType: 'image/png',
        name: 'test.png',
        data: Buffer.from(attachment.data, 'base64'),
      },
    ]);
    expect(first.attachments?.[0]).toMatchObject({
      id: attachment.id,
      size: Buffer.from(attachment.data, 'base64').length,
    });
    expect(JSON.stringify(service.snapshot())).not.toContain(attachment.data);
    for (const changed of [
      [],
      [{ ...attachment, id: randomUUID() }],
      [{ ...attachment, name: 'changed.png' }],
      [
        {
          ...attachment,
          data: Buffer.concat([
            Buffer.from(attachment.data, 'base64'),
            Buffer.from('changed'),
          ]).toString('base64'),
        },
      ],
    ]) {
      expect(() => service.submit({ ...input, attachments: changed })).toThrow(
        changed.length ? 'idempotency_conflict' : 'invalid_task',
      );
    }
    const bytes = service.attachment(first.id, attachment.id);
    expect(bytes).toMatchObject({
      id: attachment.id,
      taskId: first.id,
      runId: service.runId,
      data: attachment.data,
    });
    expect(() => service.attachment(randomUUID(), attachment.id)).toThrow(
      'attachment_unavailable',
    );
    qwen.emit({
      type: 'turn_complete',
      jobRef: 'job-1',
      summary: 'Seen image',
    });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('completed'),
    );
    service.submit({
      ...input,
      id: randomUUID(),
      conversationId: first.id,
      text: 'Compare this image',
    });
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(2));
    expect(qwen.sessions).toHaveLength(1);
    expect(qwen.prompts[1]?.[0]).toEqual({
      type: 'text',
      text: 'Compare this image',
    });
    expect(qwen.prompts[1]?.[1]).toEqual(qwen.prompts[0]?.[0]);
  });

  it('rejects malformed, oversized, duplicate and non-image attachments before creating work', () => {
    const { service, qwen } = setup();
    const valid = image();
    for (const attachments of [
      null,
      {},
      [null],
      [valid, valid],
      Array.from({ length: 5 }, image),
      [{ ...valid, id: '../private' }],
      [{ ...valid, name: '../private.png' }],
      [{ ...valid, mimeType: 'image/svg+xml' }],
      [{ ...valid, data: 'invalid' }],
      [{ ...valid, data: 'aGVsbG8=' }],
      [{ ...valid, data: valid.data + '\n' }],
      [
        {
          ...valid,
          data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64'),
        },
      ],
    ]) {
      expect(() =>
        service.submit({
          id: randomUUID(),
          backend: 'qwen',
          project: 'project',
          text: 'Review',
          attachments,
        }),
      ).toThrow();
    }
    expect(service.snapshot().tasks).toHaveLength(0);
    expect(qwen.promptCalls).toBe(0);
  });

  it('checks negotiated image capability before creating a session and never drops an image silently', async () => {
    const { service, qwen } = setup();
    service.submit({
      id: randomUUID(),
      backend: 'qwen',
      project: 'project',
      text: 'Review',
      attachments: [image()],
    });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('failed'),
    );
    expect(qwen.sessions).toHaveLength(0);
    expect(qwen.promptCalls).toBe(0);
    expect(service.snapshot().tasks[0]!.events.at(-1)?.text).toContain(
      'image_input_unsupported',
    );
    expect(
      service.snapshot().backends.find((backend) => backend.id === 'qwen')
        ?.imageInput,
    ).toBe(false);
    expect(() =>
      service.submit({
        id: randomUUID(),
        backend: 'qwen',
        project: 'project',
        text: 'Review',
        attachments: [image()],
      }),
    ).toThrow('image_input_unsupported');
  });

  it('bounds retained image bytes without counting retries or blocking text-only tasks', async () => {
    const { service, qwen } = setup();
    qwen.supportsImages = true;
    const sample = image();
    const data = Buffer.alloc(2 * 1024 * 1024);
    Buffer.from(sample.data, 'base64').copy(data);
    const encoded = data.toString('base64');
    let last!: Parameters<MobileTasks['submit']>[0];
    for (let turn = 1; turn <= 8; turn++) {
      last = {
        id: randomUUID(),
        backend: 'qwen',
        project: 'project',
        text: '',
        attachments: Array.from({ length: 4 }, () => ({
          ...sample,
          id: randomUUID(),
          data: encoded,
        })),
      };
      service.submit(last);
      await vi.waitFor(() => expect(qwen.promptCalls).toBe(turn));
      qwen.emit({
        type: 'turn_complete',
        jobRef: 'job-' + turn,
        summary: 'Seen',
      });
      await vi.waitFor(() =>
        expect(service.snapshot().tasks[0]!.status).toBe('completed'),
      );
    }
    expect(() => service.submit(last)).not.toThrow();
    expect(() => service.submit({ ...last, id: randomUUID() })).toThrow(
      'attachment_limit',
    );
    expect(() =>
      service.submit({
        ...last,
        id: randomUUID(),
        text: 'Text still works',
        attachments: [],
      }),
    ).not.toThrow();
  });

  it('cancels image work during preflight without delivering bytes or creating a replacement session', async () => {
    const { service, qwen } = setup();
    qwen.supportsImages = true;
    let ready!: () => void;
    qwen.preflight.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const task = service.submit({
      id: randomUUID(),
      backend: 'qwen',
      project: 'project',
      text: '',
      attachments: [image()],
    });
    await vi.waitFor(() => expect(ready).toBeTypeOf('function'));
    await service.cancel(task.id);
    ready();
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('cancelled'),
    );
    expect(qwen.sessions).toHaveLength(0);
    expect(qwen.promptCalls).toBe(0);
  });

  it('bounds early artifact bursts without interrupting the owned task', async () => {
    const { service, qwen, submit } = setup();
    const source = {
      type: 'inline' as const,
      mimeType: 'image/png',
      data: Buffer.alloc(1024 * 1024).toString('base64'),
    };
    qwen.early = Array.from({ length: 40 }, () => ({
      type: 'artifact' as const,
      jobRef: 'job-1',
      source,
    }));
    submit();
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('running'),
    );
    qwen.emit({ type: 'turn_complete', jobRef: 'job-1', summary: 'Done' });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.artifactsPending).toBe(false),
    );
    expect(service.snapshot().tasks[0]).toMatchObject({
      status: 'completed',
      artifactNotice: 'artifact_limit',
    });
    expect(service.snapshot().tasks[0]!.artifacts).toHaveLength(1);
  });
  it('freezes the terminal timestamp while artifact preparation and later events finish', async () => {
    const { service, qwen, submit } = setup();
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    submit();
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
    qwen.emit({
      type: 'artifact',
      jobRef: 'job-1',
      source: {
        type: 'inline',
        mimeType: 'text/markdown',
        data: Buffer.from('# Result').toString('base64'),
      },
    });
    now = 5_000;
    qwen.emit({ type: 'turn_complete', jobRef: 'job-1', summary: 'Done' });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.artifacts).toHaveLength(1),
    );
    now = 50_000;
    qwen.emit({
      type: 'activity',
      jobRef: 'job-1',
      kind: 'message',
      text: 'late',
    });
    qwen.emit({ type: 'turn_complete', jobRef: 'job-1', summary: 'duplicate' });
    await Promise.resolve();
    expect(service.snapshot().tasks[0]).toMatchObject({
      createdAt: 1_000,
      finishedAt: 5_000,
      updatedAt: 5_000,
      output: 'Done',
      status: 'completed',
    });
  });

  it('keeps artifacts bound to the exact admitted turn across follow-ups and cancellation', async () => {
    const { service, qwen, submit } = setup();
    const first = submit();
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(1));
    const source = {
      type: 'inline' as const,
      mimeType: 'text/markdown',
      data: Buffer.from('# Owned result').toString('base64'),
    };
    qwen.emit({ type: 'artifact', jobRef: 'stale', source });
    qwen.emit({
      type: 'turn_complete',
      jobRef: 'job-1',
      summary: 'No artifact from the stale job',
    });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('completed'),
    );
    expect(service.snapshot().tasks[0]!.artifacts).toEqual([]);
    const second = service.submit({
      id: randomUUID(),
      backend: 'qwen',
      project: 'project',
      text: 'Follow up',
      conversationId: first.id,
    });
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(2));
    qwen.emit({ type: 'artifact', jobRef: 'job-1', source });
    qwen.emit({ type: 'artifact', jobRef: 'job-2', source });
    qwen.emit({ type: 'turn_complete', jobRef: 'job-2', summary: 'Done' });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.artifacts).toHaveLength(1),
    );
    const artifact = service.snapshot().tasks[0]!.artifacts[0]!;
    expect(service.artifact(second.id, artifact.id).taskId).toBe(second.id);
    expect(() => service.artifact(first.id, artifact.id)).toThrow(
      'artifact_unavailable',
    );
    expect(service.snapshot().tasks[1]!.artifacts).toEqual([]);
    const third = submit();
    await vi.waitFor(() => expect(qwen.promptCalls).toBe(3));
    qwen.emit({ type: 'artifact', jobRef: 'job-3', source });
    await service.cancel(third.id);
    qwen.emit({ type: 'turn_error', jobRef: 'job-3', error: 'cancelled' });
    await vi.waitFor(() =>
      expect(service.snapshot().tasks[0]!.status).toBe('cancelled'),
    );
    qwen.emit({ type: 'artifact', jobRef: 'job-3', source });
    expect(service.snapshot().tasks[0]!.artifacts).toEqual([]);
  });
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
