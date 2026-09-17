/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LiveConfig } from '../config.js';

export function runtimeFailureSecrets(
  config?: LiveConfig,
  extras: readonly string[] = [],
): string[] {
  return [
    ...extras,
    process.env['DASHSCOPE_API_KEY'],
    config?.realtime.apiKey,
    config ? process.env[config.memory.updater.apiKeyEnv] : undefined,
    config ? process.env[config.memory.observer.apiKeyEnv] : undefined,
    ...(config?.backends ?? []).flatMap((backend) =>
      backend.kind === 'qwen-code'
        ? [backend.token]
        : Object.entries(backend.env ?? {})
            .filter(([key]) =>
              /key|token|secret|password|authorization/iu.test(key),
            )
            .map(([, value]) => value),
    ),
  ]
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.length - a.length);
}

/** Observability only: these records never authorize retries or change state. */
export interface RuntimeFailure {
  source:
    | 'realtime'
    | 'host'
    | 'tool'
    | 'backend'
    | 'proactive'
    | 'memory'
    | 'daemon';
  code: string;
  stage: string;
  impact: 'operation' | 'response' | 'task' | 'feature' | 'call' | 'daemon';
  message: string;
  epoch?: number;
  callId?: string;
  providerSessionId?: string;
  responseId?: string;
  toolCallId?: string;
  toolName?: string;
  taskId?: string;
  backend?: string;
  errorName?: string;
  kind?: 'configuration' | 'transient' | 'protocol';
  providerType?: string;
  param?: string;
  status?: number;
  closeCode?: number;
  fatal?: boolean;
  /** A timeout or lost acknowledgement does not prove execution stopped. */
  executionUncertain?: boolean;
}

export type RuntimeFailureSink = (failure: RuntimeFailure) => void;

function identifier(
  value: unknown,
  secrets: readonly string[],
): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9_.:/-]+$/u.test(value) &&
    !secrets.some((secret) => secret.length > 0 && value.includes(secret))
    ? value
    : undefined;
}

export function sanitizeFailureMessage(
  value: unknown,
  secrets: readonly string[] = [],
): string {
  let text = typeof value === 'string' ? value : 'Failure details unavailable.';
  for (const secret of secrets)
    if (secret) text = text.split(secret).join('[redacted]');
  return (
    text
      .replace(
        /\b(?:Bearer|Basic)\s+[^\s,;"'}]+/giu,
        '[redacted authorization]',
      )
      .replace(/\bsk-[A-Za-z0-9_-]+/gu, '[redacted]')
      .replace(
        /((?:api[_-]?key|token|authorization|password|secret)["']?\s*[=:]\s*["']?)[^\s,"'&;}]+/giu,
        '$1[redacted]',
      )
      .replace(/\b(https?|wss?):\/\/[^\s/@]+@/giu, '$1://[redacted]@')
      // Diagnostics are one bounded line; do not retain terminal control bytes.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
      .slice(0, 1000)
  );
}

/** Deliberately whitelist fields: no raw arguments, headers, media or stacks. */
export function runtimeFailureRecord(
  failure: RuntimeFailure,
  secrets: readonly string[] = [],
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    source: failure.source,
    code: identifier(failure.code, secrets) ?? 'unspecified_failure',
    stage: identifier(failure.stage, secrets) ?? 'unknown',
    impact: failure.impact,
    message: sanitizeFailureMessage(failure.message, secrets),
  };
  for (const field of [
    'callId',
    'providerSessionId',
    'responseId',
    'toolCallId',
    'toolName',
    'taskId',
    'backend',
    'errorName',
    'providerType',
    'kind',
    'param',
  ] as const) {
    const value = identifier(failure[field], secrets);
    if (value) result[field] = value;
  }
  if (Number.isSafeInteger(failure.epoch) && failure.epoch! >= 0)
    result['epoch'] = failure.epoch;
  if (
    Number.isInteger(failure.status) &&
    failure.status! >= 100 &&
    failure.status! <= 599
  )
    result['status'] = failure.status;
  if (
    Number.isInteger(failure.closeCode) &&
    failure.closeCode! >= 0 &&
    failure.closeCode! <= 65535
  )
    result['closeCode'] = failure.closeCode;
  if (typeof failure.fatal === 'boolean') result['fatal'] = failure.fatal;
  if (typeof failure.executionUncertain === 'boolean')
    result['executionUncertain'] = failure.executionUncertain;
  return result;
}

/** A diagnostic observer must never interfere with the operation being observed. */
export function emitRuntimeFailure(
  sink: RuntimeFailureSink | undefined,
  failure: RuntimeFailure,
): void {
  try {
    sink?.(failure);
  } catch {
    /* Best-effort diagnostics. */
  }
}

/** Synchronous, bounded error-only log: available before calls and during exit. */
export class RuntimeFailureLog {
  readonly filePath: string;
  private sequence = 0;
  private readonly directory: string;

  constructor(
    dataDir: string,
    private readonly secrets: () => readonly string[] = () => [],
    private readonly maxBytes = 1024 * 1024,
  ) {
    this.directory = join(dataDir, 'logs');
    this.filePath = join(
      this.directory,
      `runtime-errors-${Date.now()}-${randomUUID()}.jsonl`,
    );
  }

  write(failure: RuntimeFailure): boolean {
    let fd: number | undefined;
    try {
      const payload = runtimeFailureRecord(failure, this.secrets());
      const line = Buffer.from(
        JSON.stringify({
          ts: Date.now(),
          seq: ++this.sequence,
          pid: process.pid,
          type: 'failure',
          payload,
        }) + '\n',
      );
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const directory = lstatSync(this.directory);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (process.platform !== 'win32' &&
          ((directory.mode & 0o077) !== 0 ||
            (process.getuid && directory.uid !== process.getuid())))
      )
        return false;
      const existing = lstatSync(this.filePath, { throwIfNoEntry: false });
      if (existing) {
        if (
          !existing.isFile() ||
          existing.isSymbolicLink() ||
          (process.platform !== 'win32' &&
            ((existing.mode & 0o077) !== 0 ||
              (process.getuid && existing.uid !== process.getuid())))
        )
          return false;
        if (existing.size + line.length > this.maxBytes)
          renameSync(this.filePath, this.filePath + '.1');
      }
      fd = openSync(
        this.filePath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        (process.platform !== 'win32' &&
          ((opened.mode & 0o077) !== 0 ||
            (process.getuid && opened.uid !== process.getuid())))
      )
        return false;
      let offset = 0;
      while (offset < line.length) {
        const written = writeSync(fd, line, offset, line.length - offset);
        if (written <= 0) return false;
        offset += written;
      }
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== undefined)
        try {
          closeSync(fd);
        } catch {
          /* Diagnostics cannot break shutdown. */
        }
    }
  }
}
