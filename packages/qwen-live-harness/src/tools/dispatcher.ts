/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Routes realtime function calls to handlers and turns whatever happens —
 * success, handler error, bad arguments, timeout — into a JSON receipt
 * string. No call is ever left unanswered: an unanswered function call
 * would stall the realtime response arbitration.
 */

import {
  emitRuntimeFailure,
  type RuntimeFailure,
  type RuntimeFailureSink,
} from '../log/runtime-failure.js';

/**
 * Generous by design: the timeout is a last-resort answer for the model,
 * not a cancellation — the handler keeps running and its side effects
 * (a created job, a submitted prompt) stay real. The receipt wording must
 * therefore steer the model away from retrying.
 */
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const TIMEOUT_NOTE =
  'The action is still running in the background and may yet finish. Do ' +
  'not retry the call; check on it with session_monitor.';
const INVALID_ARGUMENTS_NOTE =
  'Tool arguments must be a valid JSON object. No action was executed.';

/** Per-call context threaded through from the realtime function-call event. */
export interface ToolContext {
  /** Transcript tail captured at call time (capturesTranscript tools). */
  activeTranscript: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
  /** Current real user's request, not a synthetic notification or earlier turn. */
  userRequest?: string;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface ToolDispatchResult {
  /** JSON receipt to submit as the function call output. */
  receipt: string;
  ok: boolean;
}

export interface ToolDispatcherOptions {
  handlers: ReadonlyMap<string, ToolHandler>;
  timeoutMs?: number;
  /** Guidance must match the capabilities available in the current call. */
  timeoutNote?: string;
  /** Best-effort diagnostics; never changes tool execution or receipts. */
  onFailure?: RuntimeFailureSink;
}

function errorName(error: unknown): string | undefined {
  try {
    return error instanceof Error && typeof error.name === 'string'
      ? error.name
      : undefined;
  } catch {
    return undefined;
  }
}

function parseArguments(
  raw: string,
  name: string,
  onFailure: RuntimeFailureSink | undefined,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
    emitRuntimeFailure(onFailure, {
      source: 'tool',
      code: 'tool_arguments_shape',
      stage: 'arguments',
      impact: 'operation',
      toolName: name,
      message: 'Tool arguments were not an object; the tool was not executed.',
    });
  } catch (error) {
    emitRuntimeFailure(onFailure, {
      source: 'tool',
      code: 'tool_arguments_invalid',
      stage: 'arguments',
      impact: 'operation',
      toolName: name,
      errorName: errorName(error),
      message: 'Tool arguments were not valid JSON; the tool was not executed.',
    });
  }
  return undefined;
}

class ToolTimeoutError extends Error {
  constructor() {
    super('tool handler timed out');
    this.name = 'ToolTimeoutError';
  }
}

export class ToolDispatcher {
  private readonly handlers: ReadonlyMap<string, ToolHandler>;
  private readonly timeoutMs: number;
  private readonly timeoutNote: string;
  private readonly onFailure?: RuntimeFailureSink;

  constructor(options: ToolDispatcherOptions) {
    this.handlers = options.handlers;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
    this.timeoutNote = options.timeoutNote ?? TIMEOUT_NOTE;
    this.onFailure = options.onFailure;
  }

  async dispatch(
    name: string,
    rawArguments: string,
    ctx: ToolContext,
  ): Promise<ToolDispatchResult> {
    const handler = this.handlers.get(name);
    if (!handler) {
      this.reportFailure(name, {
        code: 'tool_unknown',
        stage: 'lookup',
        message: 'The requested tool has no registered handler.',
      });
      return {
        ok: false,
        receipt: JSON.stringify({
          status: 'error',
          note: `No handler for tool ${name}.`,
        }),
      };
    }
    const args = parseArguments(rawArguments, name, this.onFailure);
    if (args === undefined) {
      return {
        ok: false,
        receipt: JSON.stringify({
          status: 'error',
          code: 'invalid_arguments',
          note: INVALID_ARGUMENTS_NOTE,
        }),
      };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stage: 'handler' | 'serialization' = 'handler';
    try {
      const outcome = await Promise.race([
        Promise.resolve(handler(args, ctx)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ToolTimeoutError());
          }, this.timeoutMs);
          timer.unref?.();
        }),
      ]);
      stage = 'serialization';
      const receipt = JSON.stringify(outcome);
      this.observeBusinessResult(name, receipt);
      return { ok: true, receipt };
    } catch (error) {
      if (error instanceof ToolTimeoutError) {
        this.reportFailure(name, {
          code: 'tool_timeout_pending',
          stage: 'handler',
          message:
            'The tool response timed out; execution may still continue and must not be retried automatically.',
          errorName: errorName(error),
          executionUncertain: true,
        });
        return {
          ok: false,
          receipt: JSON.stringify({
            status: 'pending',
            note: this.timeoutNote,
          }),
        };
      }
      this.reportFailure(name, {
        code:
          stage === 'serialization'
            ? 'tool_result_serialization_failed'
            : 'tool_handler_failed',
        stage,
        message:
          stage === 'serialization'
            ? 'The tool result could not be serialized; execution may already have occurred.'
            : 'The tool handler raised an error; prior side effects are not rolled back.',
        errorName: errorName(error),
        executionUncertain: true,
      });
      return {
        ok: false,
        receipt: JSON.stringify({
          status: 'error',
          note:
            error instanceof Error && error.message
              ? error.message.slice(0, 300)
              : 'the tool failed',
        }),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private observeBusinessResult(name: string, receipt: string): void {
    if (!this.onFailure) return;
    try {
      // Inspect the already serialized wire result, not getters or toJSON on
      // the handler-owned object. Observability must not execute them twice.
      const outcome: unknown = JSON.parse(receipt);
      if (
        outcome &&
        typeof outcome === 'object' &&
        !Array.isArray(outcome) &&
        'status' in outcome &&
        outcome.status === 'error'
      ) {
        this.reportFailure(name, {
          code: 'tool_business_rejected',
          stage: 'result',
          message: 'The tool handler returned a business error receipt.',
        });
      }
    } catch {
      // Keep the original receipt even if it cannot be inspected for diagnostics.
    }
  }

  private reportFailure(
    name: string,
    failure: Pick<RuntimeFailure, 'code' | 'stage' | 'message'> &
      Pick<RuntimeFailure, 'errorName' | 'executionUncertain'>,
  ): void {
    emitRuntimeFailure(this.onFailure, {
      source: 'tool',
      impact: 'operation',
      toolName: name,
      ...failure,
    });
  }
}
