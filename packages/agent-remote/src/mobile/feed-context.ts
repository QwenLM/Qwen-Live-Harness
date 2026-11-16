import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  redactPermissionText,
  stripControlSequences,
} from '../adaptor/adaptor-utils.js';
import type { MobileTask } from './tasks.js';

export const FEED_SOURCES = ['workbench', 'codex', 'qwen'] as const;
export type FeedSource = (typeof FEED_SOURCES)[number];
export interface ContextMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}
export interface FeedContext {
  id: string;
  source: FeedSource;
  title: string;
  updatedAt: number;
  messages: ContextMessage[];
  incomplete: boolean;
  link?: { runId: string; conversationId: string; taskId: string };
}
export interface SourceReading {
  source: FeedSource;
  status: 'ready' | 'missing' | 'error' | 'limited';
  contexts: FeedContext[];
}
export const CONTEXT_WINDOW_MS = 30 * 24 * 60 * 60_000;
const FILE_BYTES = 2 * 1024 * 1024;
export function contextID(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}
export function contextText(text: string, limit = 4000): string {
  return redactPermissionText(stripControlSequences(text))
    .trim()
    .slice(0, limit);
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function parts(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part: unknown) => {
      const item = record(part);
      return typeof item['text'] === 'string' && item['thought'] !== true
        ? item['text']
        : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Only dialogue is imported: never system prompts, reasoning, tool output or credentials files. */
export function parseSession(
  source: 'codex' | 'qwen',
  text: string,
  id: string,
  updatedAt: number,
  incomplete = false,
): FeedContext | undefined {
  const messages: ContextMessage[] = [];
  const fallback: ContextMessage[] = [];
  let ownAnalysis = false;
  let lineNumber = 0;
  const append = (
    target: ContextMessage[],
    role: 'user' | 'assistant',
    raw: string,
  ) => {
    if (
      role === 'user' &&
      /^(?:Create personal insight cards from the quoted conversation evidence below\.|Create an activity-feed cover for an already completed task\.)/u.test(
        raw.trim(),
      )
    ) {
      ownAnalysis = true;
      return;
    }
    if (
      !raw.trim() ||
      /^(?:# AGENTS\.md|<environment_context>|<permissions instructions>|<turn_aborted>)/u.test(
        raw.trim(),
      )
    )
      return;
    const text = contextText(raw);
    if (text.length < raw.trim().length) incomplete = true;
    target.push({ id: `${id}:${lineNumber}`, role, text });
  };
  for (const line of text.split('\n')) {
    lineNumber++;
    if (!line.trim()) continue;
    let item: Record<string, unknown>;
    try {
      item = record(JSON.parse(line));
    } catch {
      incomplete = true;
      continue;
    }
    if (source === 'codex') {
      const payload = record(item['payload']);
      if (
        item['type'] === 'event_msg' &&
        ['user_message', 'agent_message'].includes(String(payload['type']))
      ) {
        if (typeof payload['message'] === 'string')
          append(
            messages,
            payload['type'] === 'user_message' ? 'user' : 'assistant',
            payload['message'],
          );
      } else if (
        item['type'] === 'response_item' &&
        payload['type'] === 'message' &&
        ['user', 'assistant'].includes(String(payload['role']))
      ) {
        append(
          fallback,
          payload['role'] as 'user' | 'assistant',
          parts(payload['content']),
        );
      }
    } else if (
      item['isSidechain'] !== true &&
      ['user', 'assistant'].includes(String(item['type']))
    ) {
      const message = record(item['message']);
      append(
        messages,
        item['type'] as 'user' | 'assistant',
        parts(message['parts'] ?? message['content']),
      );
    }
  }
  const dialogue = messages.length ? messages : fallback;
  const first = dialogue.find((message) => message['role'] === 'user');
  if (!first || ownAnalysis) return;
  return {
    id,
    source,
    title: first.text.slice(0, 100),
    updatedAt,
    messages: dialogue.slice(-80),
    incomplete: incomplete || dialogue.length > 80,
  };
}

export function workbenchContexts(
  tasks: readonly MobileTask[],
  runId: string,
): FeedContext[] {
  const groups = new Map<string, MobileTask[]>();
  for (const task of tasks) {
    if (
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)
    )
      continue;
    const group = groups.get(task.conversationId) ?? [];
    group.push(task);
    groups.set(task.conversationId, group);
  }
  return [...groups.entries()].map(([conversationId, turns]) => {
    turns.sort((a, b) => a.turnIndex - b.turnIndex);
    const id = contextID(`workbench:${runId}:${conversationId}`);
    const latest = turns.at(-1)!;
    const messages = turns
      .flatMap((task): ContextMessage[] => [
        {
          id: `${task.id}:user`,
          role: 'user',
          text: contextText(task.request),
        },
        {
          id: `${task.id}:assistant`,
          role: 'assistant',
          text: contextText(task.output),
        },
      ])
      .filter((message) => message['text']);
    return {
      id,
      source: 'workbench',
      title: contextText(turns[0]!.request, 100),
      updatedAt: latest.finishedAt ?? latest.updatedAt,
      messages: messages.slice(-80),
      incomplete:
        messages.length > 80 ||
        turns.some(
          (task) =>
            task.outputTruncated ||
            task.request.length > 4000 ||
            task.output.length > 4000,
        ),
      link: { runId, conversationId, taskId: latest.id },
    };
  });
}

/** Bounded, read-only scan of the explicitly selected CLI's transcript directory. */
export async function readSessionSource(
  source: 'codex' | 'qwen',
  root: string,
  signal: AbortSignal,
  now = Date.now(),
): Promise<SourceReading> {
  const contexts: FeedContext[] = [];
  let limited = false;
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error('Invalid source');
    const canonicalRoot = await realpath(root);
    const candidates: Array<{ path: string; mtime: number }> = [];
    let visited = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      signal.throwIfAborted();
      if (depth > 3 || visited > 6000) {
        limited = true;
        return;
      }
      const entries = await readdir(directory, { withFileTypes: true });
      // Date directories sort newest first; Qwen project directories have no time ordering.
      entries.sort((a, b) => b.name.localeCompare(a.name));
      for (const entry of entries) {
        signal.throwIfAborted();
        if (++visited > 6000) {
          limited = true;
          break;
        }
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (
            source === 'codex'
              ? /^\d{2,4}$/u.test(entry.name)
              : depth === 0 || (depth === 1 && entry.name === 'chats')
          )
            await walk(path, depth + 1);
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.jsonl') &&
          !entry.name.endsWith('.ledger.jsonl') &&
          (source !== 'qwen' || depth === 2)
        ) {
          const stat = await lstat(path);
          if (stat.isFile() && stat.mtimeMs >= now - CONTEXT_WINDOW_MS)
            candidates.push({ path, mtime: stat.mtimeMs });
        }
      }
    };
    await walk(canonicalRoot, 0);
    candidates.sort((a, b) => b.mtime - a.mtime);
    if (candidates.length > 40) limited = true;
    for (const candidate of candidates.slice(0, 40)) {
      signal.throwIfAborted();
      // Recheck canonical ancestry and refuse symlink leaves, including during replacement.
      if ((await realpath(candidate.path)) !== candidate.path) {
        limited = true;
        continue;
      }
      const file = await open(
        candidate.path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile()) {
          limited = true;
          continue;
        }
        const offset = Math.max(0, stat.size - FILE_BYTES);
        const bytes = Buffer.alloc(Math.min(FILE_BYTES, stat.size));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
        let text = bytes.subarray(0, bytesRead).toString('utf8');
        if (offset) text = text.slice(text.indexOf('\n') + 1);
        if ((await realpath(candidate.path)) !== candidate.path) {
          limited = true;
          continue;
        }
        const context = parseSession(
          source,
          text,
          contextID(`${source}:${relative(canonicalRoot, candidate.path)}`),
          candidate.mtime,
          offset > 0,
        );
        if (context) contexts.push(context);
        else limited = true;
      } finally {
        await file.close();
      }
    }
    return { source, status: limited ? 'limited' : 'ready', contexts };
  } catch (error) {
    signal.throwIfAborted();
    return {
      source,
      status:
        (error as NodeJS.ErrnoException).code === 'ENOENT' && !contexts.length
          ? 'missing'
          : 'error',
      contexts,
    };
  }
}
