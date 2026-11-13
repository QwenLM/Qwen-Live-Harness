import { describe, expect, it } from 'vitest';
import { artifactContents, artifactReferences } from './artifact-content.js';

describe('ACP artifact content', () => {
  it('retains inline images, embedded documents and tool resource links', () => {
    const image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
    expect(
      artifactContents({
        sessionUpdate: 'agent_message_chunk',
        content: image,
      }),
    ).toEqual([{ type: 'inline', mimeType: 'image/png', data: 'aGVsbG8=' }]);
    expect(
      artifactContents({
        sessionUpdate: 'tool_call_update',
        content: [
          {
            type: 'content',
            content: { type: 'resource_link', uri: 'file:///work/maple.png' },
          },
          {
            type: 'content',
            content: {
              type: 'resource',
              resource: {
                uri: 'report.md',
                mimeType: 'text/markdown',
                text: '# Report',
              },
            },
          },
        ],
      }),
    ).toEqual([
      { type: 'file', uri: 'file:///work/maple.png' },
      {
        type: 'inline',
        name: 'report.md',
        mimeType: 'text/markdown',
        data: Buffer.from('# Report').toString('base64'),
      },
    ]);
  });
  it('finds final links and quoted filenames, including spaces and encoded paths', () => {
    expect(
      artifactReferences(
        '![Maple](./art/maple.png) [Report](<reports/my report.md>) `index.html`\nSaved /work/chart%20one.webp',
      ),
    ).toEqual(
      expect.arrayContaining([
        { type: 'file', uri: './art/maple.png' },
        { type: 'file', uri: 'reports/my report.md' },
        { type: 'file', uri: 'index.html' },
        { type: 'file', uri: '/work/chart%20one.webp' },
      ]),
    );
    expect(artifactReferences('https://example.com/page.html')).toEqual([]);
    expect(artifactReferences('['.repeat(70_000))).toEqual([]);
    expect(artifactReferences('/'.repeat(70_000))).toEqual([]);
  });
  it('ignores thoughts, raw payloads and unsupported content and bounds extraction', () => {
    const secret = { type: 'image', mimeType: 'image/png', data: 'private' };
    expect(
      artifactContents({
        sessionUpdate: 'agent_thought_chunk',
        content: secret,
      }),
    ).toEqual([]);
    expect(
      artifactContents({
        sessionUpdate: 'tool_call_update',
        rawOutput: secret,
        content: [{ type: 'diff', path: '/work/private.md' }],
      }),
    ).toEqual([]);
    expect(
      artifactContents({
        sessionUpdate: 'agent_message_chunk',
        content: { ...secret, type: 'unknown' },
      }),
    ).toEqual([]);
    expect(
      artifactReferences(
        Array.from({ length: 100 }, (_, i) => `[${i}](${i}.md)`).join(' '),
      ),
    ).toHaveLength(24);
  });
});
