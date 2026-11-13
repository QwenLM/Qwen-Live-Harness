import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_ARTIFACT_BYTES, MobileArtifacts } from './artifacts.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function workspace() {
  const path = await mkdtemp(join(tmpdir(), 'remote-artifacts-'));
  directories.push(path);
  return path;
}

describe('read-only artifact snapshots', () => {
  it('previews project images, Markdown and HTML without exposing file paths or live reads', async () => {
    const project = await workspace();
    await mkdir(join(project, 'art'));
    await writeFile(
      join(project, 'art/maple.png'),
      Buffer.from([137, 80, 78, 71]),
    );
    await writeFile(join(project, 'report one.md'), '# Final report');
    await writeFile(join(project, 'index.html'), '<h1>Result</h1>');
    const store = new MobileArtifacts();
    const { artifacts, notice } = await store.collect('turn-1', project, [
      { type: 'file', uri: './art/maple.png' },
      { type: 'file', uri: pathToFileURL(join(project, 'report one.md')).href },
      { type: 'file', uri: 'index.html' },
      { type: 'file', uri: 'report%20one.md' },
    ]);
    expect(notice).toBeUndefined();
    expect(artifacts.map((value) => value.kind)).toEqual([
      'image',
      'markdown',
      'html',
    ]);
    expect(JSON.stringify(artifacts)).not.toContain(project);
    await writeFile(
      join(project, 'report one.md'),
      'Replaced after completion',
    );
    expect(
      Buffer.from(
        store.content('turn-1', artifacts[1]!.id)!.data,
        'base64',
      ).toString(),
    ).toBe('# Final report');
    expect(store.content('another-turn', artifacts[1]!.id)).toBeUndefined();
    store.clear();
    expect(store.content('turn-1', artifacts[0]!.id)).toBeUndefined();
  });

  it('rejects traversal, symlink escapes, hidden files, directories, missing files and network URLs', async () => {
    const root = await workspace(),
      project = join(root, 'project');
    await mkdir(project);
    await writeFile(join(root, 'private.md'), 'private');
    await writeFile(join(project, '.private.md'), 'private');
    await mkdir(join(project, 'folder.md'));
    await symlink(join(root, 'private.md'), join(project, 'escape.md'));
    const { artifacts, notice } = await new MobileArtifacts().collect(
      'turn',
      project,
      [
        '../private.md',
        '%2e%2e/private.md',
        join(root, 'private.md'),
        'escape.md',
        '.private.md',
        'folder.md',
        'missing.png',
        'https://example.com/x.png',
        'file://other-host/private.md',
        'sandbox:/tmp/x.png',
      ].map((uri) => ({ type: 'file', uri })),
    );
    expect(artifacts).toEqual([]);
    expect(notice).toBe('artifact_unavailable');
  });

  it('supports ACP inline images/documents with canonical base64 and strict format/size bounds', async () => {
    const store = new MobileArtifacts(),
      project = await workspace();
    const data = Buffer.from('# Embedded report').toString('base64');
    const result = await store.collect('turn', project, [
      {
        type: 'inline',
        mimeType: 'text/markdown; charset=utf-8',
        name: 'report.md',
        data,
      },
      { type: 'inline', mimeType: 'image/png', data: 'aGVsbG8=' },
      { type: 'inline', mimeType: 'text/markdown', data: 'not base64!' },
      { type: 'inline', mimeType: 'application/javascript', data },
    ]);
    expect(result.artifacts.map((value) => value.kind)).toEqual([
      'markdown',
      'image',
    ]);
    expect(result.notice).toBe('artifact_unavailable');
    const tooLarge = join(project, 'large.png');
    await writeFile(tooLarge, Buffer.alloc(MAX_ARTIFACT_BYTES + 1));
    expect(
      (await store.collect('next', project, [{ type: 'file', uri: tooLarge }]))
        .artifacts,
    ).toEqual([]);
  });

  it('enforces per-turn counts, per-turn bytes and the service retention limit', async () => {
    const project = await workspace(),
      store = new MobileArtifacts();
    const result = await store.collect(
      'many',
      project,
      Array.from({ length: 13 }, (_, i) => ({
        type: 'inline',
        mimeType: 'text/markdown',
        data: Buffer.from('file ' + i).toString('base64'),
      })),
    );
    expect(result.artifacts).toHaveLength(12);
    expect(result.notice).toBe('artifact_limit');
    const big = new MobileArtifacts();
    const data = Buffer.alloc(MAX_ARTIFACT_BYTES).toString('base64');
    for (let i = 0; i < 8; i++)
      expect(
        (
          await big.collect('big-' + i, project, [
            { type: 'inline', mimeType: 'image/png', data },
          ])
        ).artifacts,
      ).toHaveLength(1);
    expect(
      (
        await big.collect('full', project, [
          { type: 'inline', mimeType: 'image/png', data },
        ])
      ).notice,
    ).toBe('artifact_limit');
    const perTurn = await new MobileArtifacts().collect(
      'turn',
      project,
      [0, 1, 2].map((i) => ({
        type: 'inline',
        mimeType: 'image/png',
        data: Buffer.alloc(MAX_ARTIFACT_BYTES, i).toString('base64'),
      })),
    );
    expect(perTurn.artifacts).toHaveLength(2);
    expect(perTurn.notice).toBe('artifact_limit');
  });
});
