import { isRecord } from './adaptor-utils.js';
import type { ArtifactSource } from './types.js';

const EXTENSIONS = '(?:png|jpe?g|gif|webp|svg|md|markdown|html?)';
const MAX_ENCODED = 12 * 1024 * 1024;

/** References only: never interpret tool output as a command or scan a folder. */
export function artifactReferences(text: string): ArtifactSource[] {
  const sources = new Set<string>();
  const bounded = text.slice(-65_536);
  for (const match of bounded.matchAll(
    /!?\[[^\]\n]{0,512}\]\(\s*(<[^>\n]{1,4096}>|[^\s)]{1,4096})(?:\s+"[^"\n]{0,256}")?\s*\)/gu,
  )) {
    sources.add(match[1]!.replace(/^<|>$/gu, ''));
  }
  for (const match of bounded.matchAll(
    new RegExp('`([^`\\n]{1,4096}\\.' + EXTENSIONS + ')`', 'giu'),
  ))
    sources.add(match[1]!);
  for (const match of bounded.matchAll(
    new RegExp(
      '(?<![\\w:/])(?:file:///|sandbox:/|/|\\./)[^\\s\\x00-\\x1f"\'`<>]{0,4096}\\.' +
        EXTENSIONS +
        '(?=[\\s"\'`<>),\\]]|$)',
      'giu',
    ),
  ))
    sources.add(match[0]);
  return [...sources]
    .filter((uri) =>
      new RegExp('\\.' + EXTENSIONS + '(?:#L\\d+)?$', 'iu').test(uri),
    )
    .slice(0, 24)
    .map((uri) => ({ type: 'file', uri }));
}

/** Preserve ACP images/resources separately from the bounded text activity log. */
export function artifactContents(
  update: Record<string, unknown>,
): ArtifactSource[] {
  const blocks: unknown[] = [];
  if (update['sessionUpdate'] === 'agent_message_chunk')
    blocks.push(update['content']);
  else if (
    ['tool_call', 'tool_call_update'].includes(
      String(update['sessionUpdate']),
    ) &&
    Array.isArray(update['content'])
  ) {
    for (const part of update['content'].slice(0, 24)) {
      if (isRecord(part) && part['type'] === 'content')
        blocks.push(part['content']);
    }
  }
  const sources: ArtifactSource[] = [];
  let budget = MAX_ENCODED;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'text' && typeof block['text'] === 'string')
      sources.push(...artifactReferences(block['text']));
    else if (
      block['type'] === 'resource_link' &&
      typeof block['uri'] === 'string'
    )
      sources.push({ type: 'file', uri: block['uri'].slice(0, 4096) });
    else if (block['type'] === 'image' || block['type'] === 'resource') {
      const resource =
        block['type'] === 'resource' && isRecord(block['resource'])
          ? block['resource']
          : block;
      const mimeType = resource['mimeType'];
      let data = resource['data'] ?? resource['blob'];
      if (
        typeof resource['text'] === 'string' &&
        resource['text'].length <= 8 * 1024 * 1024
      )
        data = Buffer.from(resource['text']).toString('base64');
      if (
        typeof mimeType !== 'string' ||
        typeof data !== 'string' ||
        data.length > budget
      )
        continue;
      budget -= data.length;
      const uri =
        typeof resource['uri'] === 'string' ? resource['uri'] : undefined;
      sources.push({
        type: 'inline',
        mimeType,
        data,
        ...(uri ? { name: uri.slice(-256) } : {}),
      });
    }
    if (sources.length >= 24) break;
  }
  return sources.slice(0, 24);
}
