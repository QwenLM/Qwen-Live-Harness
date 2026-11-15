import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { opendir, realpath, stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { MobileError } from './errors.js';

export interface MobileProject {
  id: string;
  name: string;
  path: string;
  rootId?: string;
  relativePath?: string;
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

function identity(path: string): DirectoryIdentity {
  const canonical = realpathSync(path),
    info = statSync(canonical);
  if (!info.isDirectory()) throw new MobileError(404, 'directory_unavailable');
  return { path: canonical, dev: info.dev, ino: info.ino };
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep);
}

/** Browsing and selection never grant access beyond the computer's shared roots. */
export class MobileProjects {
  readonly roots: readonly MobileProject[];
  private readonly grants = new Map<string, DirectoryIdentity>();
  private readonly selected = new Map<
    string,
    { project: MobileProject; identity: DirectoryIdentity }
  >();

  constructor(roots: readonly MobileProject[]) {
    this.roots = roots.map((root) => ({ ...root }));
    for (const root of this.roots) {
      try {
        this.grants.set(root.id, identity(root.path));
      } catch {
        /* Unavailable roots cannot be browsed. */
      }
    }
  }

  get projects(): MobileProject[] {
    return [
      ...this.roots,
      ...[...this.selected.values()].map((entry) => entry.project),
    ].map((project) => ({ ...project }));
  }

  private async directory(
    rootId: string,
    path: string,
  ): Promise<{
    grant: DirectoryIdentity;
    folder: DirectoryIdentity;
    relativePath: string;
  }> {
    const root = this.roots.find((entry) => entry.id === rootId),
      grant = this.grants.get(rootId);
    if (!root || !grant) throw new MobileError(404, 'directory_unavailable');
    if (
      path.length > 4096 ||
      path.includes('\0') ||
      isAbsolute(path) ||
      path.split(/[/\\]/u).includes('..')
    )
      throw new MobileError(400, 'invalid_directory');
    try {
      const current = identity(root.path);
      if (
        current.path !== grant.path ||
        current.dev !== grant.dev ||
        current.ino !== grant.ino
      )
        throw new MobileError(409, 'directory_changed');
      const candidate = resolve(grant.path, path);
      if (!inside(grant.path, candidate))
        throw new MobileError(403, 'directory_outside_shared');
      const canonical = await realpath(candidate);
      if (!inside(grant.path, canonical))
        throw new MobileError(403, 'directory_outside_shared');
      const info = await stat(canonical);
      if (!info.isDirectory())
        throw new MobileError(404, 'directory_unavailable');
      return {
        grant,
        folder: { path: canonical, dev: info.dev, ino: info.ino },
        relativePath: relative(grant.path, canonical).split(sep).join('/'),
      };
    } catch (error) {
      if (error instanceof MobileError) throw error;
      throw new MobileError(404, 'directory_unavailable');
    }
  }

  async list(rootId: string, path: string, cursor = 0) {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > 10_000)
      throw new MobileError(400, 'invalid_directory');
    const { grant, folder, relativePath } = await this.directory(rootId, path);
    const directories: Array<{ name: string; relativePath: string }> = [];
    let offset = 0,
      scanned = 0,
      more = false;
    try {
      const handle = await opendir(folder.path);
      try {
        let entry;
        while ((entry = await handle.read()) !== null) {
          if (offset++ < cursor) continue;
          scanned++;
          if (entry.isDirectory() || entry.isSymbolicLink()) {
            try {
              const target = await realpath(join(folder.path, entry.name));
              if (
                inside(grant.path, target) &&
                (await stat(target)).isDirectory()
              ) {
                const child = relative(grant.path, target).split(sep).join('/');
                if (
                  child !== relativePath &&
                  !directories.some(
                    (directory) => directory.relativePath === child,
                  )
                )
                  directories.push({ name: entry.name, relativePath: child });
              }
            } catch {
              /* Missing, inaccessible and out-of-root entries are not selectable. */
            }
          }
          if (directories.length >= 100 || scanned >= 256 || offset >= 10_000) {
            more = true;
            break;
          }
        }
      } finally {
        await handle.close();
      }
    } catch {
      throw new MobileError(404, 'directory_unavailable');
    }
    return {
      rootId,
      relativePath,
      path: folder.path,
      ...(relativePath
        ? {
            parentPath: relative(grant.path, dirname(folder.path))
              .split(sep)
              .join('/'),
          }
        : {}),
      directories: directories.sort((a, b) => a.name.localeCompare(b.name)),
      ...(more && offset < 10_000 ? { nextCursor: offset } : {}),
      truncated: more && offset >= 10_000,
    };
  }

  async select(rootId: string, path: string): Promise<MobileProject> {
    const { folder, relativePath } = await this.directory(rootId, path);
    const configured = this.roots.find((project) => {
      const grant = this.grants.get(project.id);
      return (
        grant?.path === folder.path &&
        grant.dev === folder.dev &&
        grant.ino === folder.ino
      );
    });
    if (configured) return { ...configured };
    const existing = [...this.selected.values()].find(
      (entry) =>
        entry.identity.path === folder.path &&
        entry.identity.dev === folder.dev &&
        entry.identity.ino === folder.ino,
    );
    if (existing) return { ...existing.project };
    if (this.selected.size >= 100)
      throw new MobileError(429, 'directory_limit');
    const project: MobileProject = {
      id: createHash('sha256')
        .update(JSON.stringify(folder))
        .digest('hex')
        .slice(0, 16),
      name: basename(folder.path),
      path: folder.path,
      rootId,
      relativePath,
    };
    this.selected.set(project.id, { project, identity: folder });
    return { ...project };
  }

  validate(project: MobileProject): void {
    const selected = this.selected.get(project.id);
    if (!selected) return;
    try {
      const current = identity(project.path),
        grant = this.grants.get(project.rootId!);
      const root = this.roots.find((entry) => entry.id === project.rootId);
      const currentRoot = root ? identity(root.path) : undefined;
      if (
        !grant ||
        !currentRoot ||
        currentRoot.path !== grant.path ||
        currentRoot.dev !== grant.dev ||
        currentRoot.ino !== grant.ino ||
        !inside(grant.path, current.path) ||
        current.path !== selected.identity.path ||
        current.dev !== selected.identity.dev ||
        current.ino !== selected.identity.ino
      )
        throw new Error('changed');
    } catch {
      throw new MobileError(409, 'directory_changed');
    }
  }
}
