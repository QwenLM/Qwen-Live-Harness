import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MobileProjects } from './projects.js';

let temporary: string, root: string, outside: string, projects: MobileProjects;
beforeEach(async () => {
  temporary = await realpath(
    await mkdtemp(join(tmpdir(), 'mobile-directory-test-')),
  );
  root = join(temporary, 'shared');
  outside = join(temporary, 'outside');
  await Promise.all([mkdir(root), mkdir(outside)]);
  projects = new MobileProjects([{ id: 'root', name: 'Shared', path: root }]);
});
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

describe('shared working folders', () => {
  it('uses the same canonical path for root selection and state while retaining the original grant check', async () => {
    const alias = join(temporary, 'shared-alias');
    await symlink(root, alias);
    const catalog = new MobileProjects([
      { id: 'root', name: 'Shared', path: alias },
    ]);
    const listing = await catalog.list('root', '');
    const selected = await catalog.select('root', '');
    expect(listing.path).toBe(root);
    expect(selected).toEqual(catalog.projects[0]);
    expect(selected.path).toBe(listing.path);
    expect(catalog.roots[0]!.path).toBe(alias);
    await rm(alias);
    await symlink(outside, alias);
    await expect(catalog.select('root', '')).rejects.toThrow(
      'directory_changed',
    );
  });

  it('lists only directories, handles names verbatim and returns canonical parents within the shared root', async () => {
    await Promise.all([
      mkdir(join(root, '项目 with spaces')),
      mkdir(join(root, '.hidden')),
      writeFile(join(root, 'file.txt'), 'fixture'),
    ]);
    await symlink(outside, join(root, 'outside-link'));
    await symlink(join(root, 'file.txt'), join(root, 'file-link'));
    await symlink(join(root, 'missing'), join(root, 'broken-link'));
    await symlink(join(root, '项目 with spaces'), join(root, 'inside-link'));
    const listing = await projects.list('root', '');
    expect(
      new Set(listing.directories.map((entry) => entry.relativePath)),
    ).toEqual(new Set(['.hidden', '项目 with spaces']));
    expect(listing.parentPath).toBeUndefined();
    expect(listing.path).toBe(root);
    const child = await projects.list('root', 'inside-link');
    expect(child.path).toBe(join(root, '项目 with spaces'));
    expect(child.relativePath).toBe('项目 with spaces');
    expect(child.parentPath).toBe('');
    expect(child.directories).toEqual([]);
  });

  it('rejects traversal, absolute paths, out-of-root links, files and missing roots', async () => {
    await writeFile(join(root, 'file'), 'data');
    await symlink(outside, join(root, 'outside-link'));
    for (const path of [
      '../outside',
      'child/../../outside',
      outside,
      'bad\0name',
      'file',
      'missing',
      'outside-link',
    ]) {
      await expect(projects.list('root', path)).rejects.toThrow();
      await expect(projects.select('root', path)).rejects.toThrow();
    }
    await expect(projects.list('unknown', '')).rejects.toThrow(
      'directory_unavailable',
    );
    for (const cursor of [-1, 0.5, 10_001, Number.NaN])
      await expect(projects.list('root', '', cursor)).rejects.toThrow(
        'invalid_directory',
      );
    expect(projects.projects).toHaveLength(1);
  });

  it('paginates directory names with bounded pages and can continue through files-only pages', async () => {
    await Promise.all(
      Array.from({ length: 130 }, (_, index) =>
        mkdir(join(root, 'folder-' + index)),
      ),
    );
    const names = new Set<string>();
    let cursor: number | undefined;
    do {
      const page = await projects.list('root', '', cursor);
      expect(page.directories.length).toBeLessThanOrEqual(100);
      for (const directory of page.directories) names.add(directory.name);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(names.size).toBe(130);
    const files = join(root, 'files');
    await mkdir(files);
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        writeFile(join(files, 'file-' + index), 'fixture'),
      ),
    );
    const first = await projects.list('root', 'files');
    expect(first.directories).toEqual([]);
    expect(first.nextCursor).toBe(256);
    expect(
      (await projects.list('root', 'files', first.nextCursor)).nextCursor,
    ).toBeUndefined();
  });

  it('registers canonical selections once and rejects changed directory identities until explicit reselection', async () => {
    const folder = join(root, 'work');
    await mkdir(folder);
    await symlink(folder, join(root, 'alias'));
    const selected = await projects.select('root', 'alias');
    expect(selected).toMatchObject({
      path: folder,
      rootId: 'root',
      relativePath: 'work',
    });
    expect(await projects.select('root', 'work')).toEqual(selected);
    expect(projects.projects).toHaveLength(2);
    expect(() => projects.validate(selected)).not.toThrow();
    await rename(folder, join(root, 'old-work'));
    await symlink(outside, folder);
    expect(() => projects.validate(selected)).toThrow('directory_changed');
    await expect(projects.select('root', 'work')).rejects.toThrow(
      'directory_outside_shared',
    );
    await rm(folder);
    await mkdir(folder);
    expect(() => projects.validate(selected)).toThrow('directory_changed');
    const reselected = await projects.select('root', 'work');
    expect(reselected.id).not.toBe(selected.id);
    expect(() => projects.validate(reselected)).not.toThrow();
    expect(() => projects.validate(selected)).toThrow('directory_changed');
    expect(await projects.select('root', '')).toEqual(projects.roots[0]);
  });

  it('pins root identity and bounds selected projects without modifying shared roots', async () => {
    for (let index = 0; index < 101; index++) {
      await mkdir(join(root, String(index)));
      if (index < 100) await projects.select('root', String(index));
    }
    await expect(projects.select('root', '100')).rejects.toThrow(
      'directory_limit',
    );
    expect(projects.roots).toHaveLength(1);
    expect(projects.projects).toHaveLength(101);
    await rename(root, join(temporary, 'previous-shared'));
    await symlink(outside, root);
    await expect(projects.list('root', '')).rejects.toThrow(
      'directory_changed',
    );
    await expect(projects.select('root', '')).rejects.toThrow(
      'directory_changed',
    );
  });
});
