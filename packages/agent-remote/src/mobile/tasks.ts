/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type {
  BackendAdaptor,
  BackendEvent,
  BackendHandle,
} from '../adaptor/types.js';
import {
  redactPermissionText,
  stripControlSequences,
} from '../adaptor/adaptor-utils.js';
import {
  PermissionBroker,
  type PermissionBrokerMode,
  type PendingPermission,
} from '../permissions/permission-broker.js';

export class MobileError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

export interface MobileProject {
  id: string;
  name: string;
  path: string;
}

export type MobileTaskStatus =
  | 'starting'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface MobilePermission {
  id: string;
  title: string;
  toolName?: string;
  command?: string;
  cwd?: string;
  input?: string;
  canAllow: boolean;
}

export interface MobileTask {
  id: string;
  backend: string;
  project: string;
  request: string;
  status: MobileTaskStatus;
  createdAt: number;
  updatedAt: number;
  activity: string;
  output: string;
  outputTruncated: boolean;
  permissions: MobilePermission[];
  events: Array<{ id: string; kind: string; text: string; at: number }>;
}

interface OwnedTask {
  view: MobileTask;
  handle?: BackendHandle;
  jobRef?: string;
  buffered: BackendEvent[];
  admitted: boolean;
  attempted: boolean;
  cancelRequested: boolean;
  controller: AbortController;
}

const TERMINAL = new Set<MobileTaskStatus>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_OUTPUT = 16_384;
function clean(value: string, limit = MAX_OUTPUT): string {
  return stripControlSequences(redactPermissionText(value)).slice(-limit);
}

function completePermission(request: PendingPermission): boolean {
  if (request.title.length >= 8192 || request.details?.incomplete) return false;
  try {
    return JSON.stringify(request.details ?? {}).length <= 8192;
  } catch {
    return false;
  }
}

/** Text-only task ownership, independent of voice calls and their authority. */
export class MobileTasks {
  readonly runId = randomUUID();
  private readonly tasks = new Map<string, OwnedTask>();
  private readonly ready = new Map<string, Promise<void>>();
  private readonly backendStates = new Map<
    string,
    'available' | 'starting' | 'ready' | 'unavailable'
  >();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly broker: PermissionBroker;
  private readonly permissionMode: PermissionBrokerMode;
  private closed = false;

  constructor(
    private readonly adaptors: ReadonlyMap<string, BackendAdaptor>,
    readonly projects: readonly MobileProject[],
    options: { permissionMode?: PermissionBrokerMode } = {},
  ) {
    this.permissionMode = options.permissionMode ?? 'ask';
    this.broker = new PermissionBroker({
      adaptorFor: (handle) => {
        const owner = [...this.tasks.values()].find(
          (task) =>
            task.handle?.id === handle.id &&
            task.handle.adaptor === handle.adaptor,
        );
        if (
          this.closed ||
          !owner ||
          owner.cancelRequested ||
          TERMINAL.has(owner.view.status)
        )
          throw new MobileError(409, 'permission_expired');
        const adaptor = this.adaptors.get(handle.adaptor);
        if (!adaptor) throw new MobileError(404, 'backend_not_found');
        return adaptor;
      },
      getPermissionMode: () => this.permissionMode,
      onDecision: (event) => {
        const task = this.tasks.get(event.pending.sessionHandle);
        if (event.auto && task && !TERMINAL.has(task.view.status))
          this.event(
            task,
            'permission',
            event.outcome === 'already_resolved'
              ? 'Permission was already resolved by the agent'
              : event.decision === 'allow'
                ? 'Automatic one-time approval sent; awaiting the agent'
                : 'One-time approval unavailable; the backend request was cancelled',
          );
      },
    });
  }

  snapshot() {
    return {
      version: 1,
      runId: this.runId,
      permissionMode: this.permissionMode,
      backends: [...this.adaptors.keys()].map((id) => ({
        id,
        name: id === 'qwen' ? 'Qwen Code' : id === 'codex' ? 'Codex' : id,
        status: this.backendStates.get(id) ?? 'available',
      })),
      projects: this.projects,
      tasks: [...this.tasks.values()].map((task) => this.view(task)).reverse(),
    };
  }

  private view(task: OwnedTask): MobileTask {
    const pending = this.broker.pendingRequests.filter(
      (request) => request.sessionHandle === task.view.id,
    );
    return {
      ...task.view,
      status:
        !TERMINAL.has(task.view.status) &&
        !task.cancelRequested &&
        pending.length
          ? 'waiting'
          : task.view.status,
      permissions: pending.map((request) => ({
        id: request.requestHandle,
        title: request.title,
        ...(request.details?.toolName
          ? { toolName: clean(request.details.toolName, 256) }
          : {}),
        ...(request.details?.command
          ? { command: clean(request.details.command, 8192) }
          : {}),
        ...(request.details?.cwd
          ? { cwd: clean(request.details.cwd, 4096) }
          : {}),
        ...(request.details
          ? { input: clean(JSON.stringify(request.details), 8192) }
          : {}),
        canAllow:
          completePermission(request) &&
          !task.cancelRequested &&
          request.options.some(
            (option) =>
              option.kind === 'proceed' && option.escalation !== 'always',
          ),
      })),
      events: [...task.view.events],
    };
  }

  submit(input: {
    id: string;
    backend: string;
    project: string;
    text: string;
  }): MobileTask {
    if (this.closed) throw new MobileError(503, 'service_stopping');
    if (
      !UUID.test(input.id) ||
      !input.text.trim() ||
      input.text.length > 16_000
    )
      throw new MobileError(400, 'invalid_task');
    const id = input.id.toLowerCase();
    const existing = this.tasks.get(id);
    if (existing) {
      if (
        existing.view.backend !== input.backend ||
        existing.view.project !== input.project ||
        existing.view.request !== input.text.trim()
      )
        throw new MobileError(409, 'idempotency_conflict');
      return this.view(existing);
    }
    const adaptor = this.adaptors.get(input.backend);
    const project = this.projects.find((entry) => entry.id === input.project);
    if (!adaptor || !project) throw new MobileError(404, 'target_not_found');
    if (
      this.tasks.size >= 100 ||
      [...this.tasks.values()].filter((task) => !TERMINAL.has(task.view.status))
        .length >= 4
    )
      throw new MobileError(429, 'task_limit');
    const now = Date.now();
    const task: OwnedTask = {
      view: {
        id,
        backend: input.backend,
        project: input.project,
        request: input.text.trim(),
        status: 'starting',
        createdAt: now,
        updatedAt: now,
        activity: '',
        output: '',
        outputTruncated: false,
        permissions: [],
        events: [],
      },
      controller: new AbortController(),
      buffered: [],
      admitted: false,
      attempted: false,
      cancelRequested: false,
    };
    this.tasks.set(id, task);
    this.event(task, 'status', 'Connecting to the agent');
    this.track(this.begin(task, adaptor, project));
    return this.view(task);
  }

  private track(operation: Promise<unknown>): void {
    this.operations.add(operation);
    void operation
      .finally(() => this.operations.delete(operation))
      .catch(() => {});
  }

  private async prepare(adaptor: BackendAdaptor): Promise<void> {
    let operation = this.ready.get(adaptor.name);
    if (!operation) {
      this.backendStates.set(adaptor.name, 'starting');
      operation = adaptor
        .preflight()
        .then(() => {
          this.backendStates.set(adaptor.name, 'ready');
        })
        .catch((error: unknown) => {
          this.backendStates.set(adaptor.name, 'unavailable');
          this.ready.delete(adaptor.name);
          throw error;
        });
      this.ready.set(adaptor.name, operation);
    }
    await operation;
  }

  private async begin(
    task: OwnedTask,
    adaptor: BackendAdaptor,
    project: MobileProject,
  ): Promise<void> {
    try {
      await this.prepare(adaptor);
      if (this.closed || task.cancelRequested) {
        this.finish(task, 'cancelled', 'Stopped before submission');
        return;
      }
      task.handle = await adaptor.createSession({
        cwd: project.path,
        label: task.view.request.slice(0, 80),
      });
      if (this.closed || task.cancelRequested) {
        this.finish(task, 'cancelled', 'Stopped before submission');
        return;
      }
      this.track(this.pump(task, adaptor));
      task.attempted = true;
      const receipt = await adaptor.prompt(task.handle, [
        { type: 'text', text: task.view.request },
      ]);
      if (this.closed || TERMINAL.has(task.view.status)) return;
      if (receipt.status === 'rejected' || !receipt.jobRef) {
        this.finish(
          task,
          receipt.status === 'rejected' ? 'failed' : 'interrupted',
          receipt.note ??
            'Agent did not confirm task admission; execution outcome is unknown',
        );
        return;
      }
      task.jobRef = receipt.jobRef;
      task.admitted = true;
      task.view.status = task.cancelRequested ? 'cancelling' : 'running';
      this.event(task, 'status', 'Task accepted by the agent');
      for (const event of task.buffered.splice(0))
        await this.consume(task, event);
      if (task.cancelRequested && !TERMINAL.has(task.view.status))
        await this.stopOwned(task).catch(() => {});
    } catch (error) {
      this.finish(
        task,
        task.attempted ? 'interrupted' : 'failed',
        error instanceof Error ? error.message : 'Agent connection failed',
      );
    }
  }

  private async pump(task: OwnedTask, adaptor: BackendAdaptor): Promise<void> {
    try {
      for await (const event of adaptor.events(task.handle!, {
        signal: task.controller.signal,
      })) {
        if (this.closed || TERMINAL.has(task.view.status)) break;
        if (!task.admitted) {
          if (task.buffered.length >= 128) {
            this.finish(
              task,
              'interrupted',
              'Event buffer exceeded; execution outcome is unknown',
            );
            break;
          }
          task.buffered.push(event);
        } else await this.consume(task, event);
      }
      if (!this.closed && !TERMINAL.has(task.view.status))
        this.finish(
          task,
          'interrupted',
          'Agent disconnected; execution outcome is unknown',
        );
    } catch (error) {
      this.finish(
        task,
        'interrupted',
        error instanceof Error ? error.message : 'Agent event stream failed',
      );
    }
  }

  private async consume(task: OwnedTask, event: BackendEvent): Promise<void> {
    if (TERMINAL.has(task.view.status) || this.closed) return;
    if ('jobRef' in event && event.jobRef && event.jobRef !== task.jobRef)
      return;
    switch (event.type) {
      case 'activity': {
        this.event(task, event.kind, event.text);
        if (event.kind === 'message') {
          const output = task.view.output + clean(event.text);
          task.view.outputTruncated ||= output.length > MAX_OUTPUT;
          task.view.output = output.slice(-MAX_OUTPUT);
        }
        break;
      }
      case 'progress':
        this.event(task, 'progress', event.summary);
        break;
      case 'turn_started':
        this.event(task, 'status', 'Agent is working');
        break;
      case 'permission_request':
        {
          const receipt = await this.broker.onRequest({
            requestId: event.requestId,
            backend: task.handle!,
            sessionHandle: task.view.id,
            ...(event.jobRef ? { jobRef: event.jobRef } : {}),
            title: event.title,
            options: event.options,
            ...(event.details ? { details: event.details } : {}),
            allowAutoAnswer: true,
          });
          if (!receipt.autoAnswered && !TERMINAL.has(task.view.status))
            this.event(
              task,
              'permission',
              this.permissionMode === 'allow-all'
                ? 'Automatic approval could not finish; check the Mac'
                : 'Waiting for your decision',
            );
        }
        break;
      case 'permission_resolved':
        this.broker.onResolved(task.handle!, event.requestId);
        break;
      case 'turn_complete':
        this.finish(task, 'completed', event.detail ?? event.summary);
        break;
      case 'turn_error':
        this.finish(
          task,
          event.error === 'cancelled' ? 'cancelled' : 'failed',
          event.error,
        );
        break;
      case 'session_closed':
        this.finish(
          task,
          'interrupted',
          'Session closed; execution outcome is unknown',
        );
        break;
    }
  }

  private event(task: OwnedTask, kind: string, text: string): void {
    task.view.updatedAt = Date.now();
    task.view.activity = clean(text, 1024);
    task.view.events.push({
      id: randomUUID(),
      kind,
      text: clean(text, 1024),
      at: task.view.updatedAt,
    });
    task.view.events = task.view.events.slice(-24);
  }

  private finish(
    task: OwnedTask,
    status: MobileTaskStatus,
    text: string,
  ): void {
    if (TERMINAL.has(task.view.status)) return;
    task.view.status = status;
    if (status === 'completed' && text) {
      task.view.outputTruncated ||= text.length > MAX_OUTPUT;
      task.view.output = clean(text);
    }
    this.event(task, 'status', text);
    this.broker.clearSession(task.view.id);
    task.controller.abort();
  }

  async permission(
    taskId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ): Promise<MobileTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new MobileError(404, 'task_not_found');
    const pending = this.broker.resolveHandle(requestId);
    if (
      !pending ||
      pending.sessionHandle !== taskId ||
      task.cancelRequested ||
      TERMINAL.has(task.view.status)
    )
      throw new MobileError(409, 'permission_expired');
    if (
      decision === 'allow' &&
      !pending.options.some(
        (option) => option.kind === 'proceed' && option.escalation !== 'always',
      )
    )
      throw new MobileError(409, 'no_one_time_option');
    if (decision === 'allow' && !completePermission(pending))
      throw new MobileError(409, 'permission_details_incomplete');
    await this.broker.respond(requestId, decision);
    if (!TERMINAL.has(task.view.status))
      this.event(
        task,
        'permission',
        decision === 'allow'
          ? 'One-time approval sent; awaiting the agent'
          : 'Denial sent; awaiting the agent',
      );
    return this.view(task);
  }

  async cancel(taskId: string): Promise<MobileTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new MobileError(404, 'task_not_found');
    if (TERMINAL.has(task.view.status) || task.cancelRequested)
      return this.view(task);
    task.cancelRequested = true;
    task.view.status = 'cancelling';
    this.event(task, 'status', 'Stop requested; awaiting the agent');
    if (task.admitted) await this.stopOwned(task);
    return this.view(task);
  }

  private async stopOwned(task: OwnedTask): Promise<void> {
    const adaptor = this.adaptors.get(task.view.backend)!;
    try {
      if (adaptor.cancelJob) {
        const outcome = await adaptor.cancelJob(task.handle!, task.jobRef!);
        if (outcome === 'stopped')
          this.finish(task, 'cancelled', 'Agent confirmed the task stopped');
        else if (outcome === 'not_found')
          this.event(
            task,
            'status',
            'Agent could not confirm the task; execution outcome is unknown',
          );
      } else await adaptor.cancel(task.handle!);
    } catch {
      task.cancelRequested = false;
      task.view.status = 'running';
      this.event(task, 'status', 'Stop failed; retry or check the Mac');
      throw new MobileError(502, 'cancel_failed');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.tasks.values())
      this.finish(
        task,
        'interrupted',
        'Mac service stopped; execution outcome is unknown',
      );
    const outcomes = await Promise.allSettled(
      [...this.adaptors.values()].map((adaptor) => adaptor.close()),
    );
    await Promise.allSettled([...this.operations]);
    if (outcomes.some((outcome) => outcome.status === 'rejected'))
      throw new Error('Agent cleanup failed; check the Mac');
  }
}
