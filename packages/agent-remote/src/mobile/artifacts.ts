import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactSource } from '../adaptor/types.js';

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_TASK_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const FORMATS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
};

export interface MobileArtifact {
  id: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'markdown' | 'html';
  size: number;
}
interface StoredArtifact {
  taskId: string;
  artifact: MobileArtifact;
  data: Buffer;
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child !== '' &&
    !isAbsolute(child) &&
    !child.split(sep).some((part) => part.startsWith('.'))
  );
}

/** Immutable, size-bounded snapshots of outputs from the exact owned turn. */
export class MobileArtifacts {
  private readonly stored = new Map<string, StoredArtifact>();
  private totalBytes = 0;

  async collect(
    taskId: string,
    project: string,
    sources: readonly ArtifactSource[],
  ): Promise<{ artifacts: MobileArtifact[]; notice?: string }> {
    const artifacts: MobileArtifact[] = [];
    const hashes = new Set<string>();
    let bytes = 0;
    let notice: string | undefined;
    for (const source of sources.slice(0, 48)) {
      try {
        const value =
          source.type === 'file'
            ? await this.readProjectFile(project, source.uri)
            : this.inline(source);
        if (!value) {
          notice ??= 'artifact_unavailable';
          continue;
        }
        const { data, mimeType, name } = value;
        const hash = createHash('sha256')
          .update(mimeType)
          .update(data)
          .digest('hex');
        if (hashes.has(hash)) continue;
        if (
          artifacts.length >= 12 ||
          bytes + data.length > MAX_TASK_BYTES ||
          this.totalBytes + data.length > MAX_TOTAL_BYTES
        ) {
          notice = 'artifact_limit';
          break;
        }
        const artifact: MobileArtifact = {
          id: randomUUID(),
          name,
          mimeType,
          size: data.length,
          kind: mimeType.startsWith('image/')
            ? 'image'
            : mimeType === 'text/html'
              ? 'html'
              : 'markdown',
        };
        this.stored.set(artifact.id, { taskId, artifact, data });
        this.totalBytes += data.length;
        bytes += data.length;
        hashes.add(hash);
        artifacts.push(artifact);
      } catch {
        notice ??= 'artifact_unavailable';
      }
    }
    return { artifacts, ...(notice ? { notice } : {}) };
  }

  content(taskId: string, id: string) {
    const stored = this.stored.get(id);
    if (!stored || stored.taskId !== taskId) return undefined;
    return { ...stored.artifact, taskId, data: stored.data.toString('base64') };
  }

  clear(): void {
    this.stored.clear();
    this.totalBytes = 0;
  }

  private inline(source: Extract<ArtifactSource, { type: 'inline' }>) {
    const mimeType = source.mimeType.split(';')[0]!.trim().toLowerCase();
    if (
      !Object.values(FORMATS).includes(mimeType) ||
      source.data.length > Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4 ||
      source.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(source.data)
    )
      return undefined;
    const data = Buffer.from(source.data, 'base64');
    if (
      !data.length ||
      data.length > MAX_ARTIFACT_BYTES ||
      data.toString('base64') !== source.data
    )
      return undefined;
    const extension = Object.keys(FORMATS).find(
      (key) => FORMATS[key] === mimeType,
    )!;
    const name = source.name
      ? basename(source.name)
          .replace(/\p{Cc}/gu, '')
          .slice(-256)
      : 'output' + extension;
    return { data, mimeType, name: name || 'output' + extension };
  }

  private async readProjectFile(project: string, uri: string) {
    if (uri.length > 4096 || /\p{Cc}/u.test(uri)) return undefined;
    let path: string;
    if (uri.startsWith('file:')) path = fileURLToPath(uri);
    else {
      if (/^[a-z][a-z0-9+.-]*:/iu.test(uri)) return undefined;
      path = decodeURIComponent(uri.replace(/#L\d+$/u, ''));
    }
    const mimeType = FORMATS[extname(path).toLowerCase()];
    if (!mimeType) return undefined;
    const projectPath = resolve(project);
    const root = await realpath(projectPath);
    const candidate = resolve(projectPath, path);
    if (!inside(projectPath, candidate) && !inside(root, candidate))
      return undefined;
    const canonical = await realpath(candidate);
    if (!inside(root, canonical)) return undefined;
    const file = await open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat();
      const entry = await stat(canonical);
      if (
        !before.isFile() ||
        before.size < 1 ||
        before.size > MAX_ARTIFACT_BYTES ||
        before.ino !== entry.ino ||
        before.dev !== entry.dev
      )
        return undefined;
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await file.stat();
      if (
        length !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        (await realpath(candidate)) !== canonical
      )
        return undefined;
      return {
        data: buffer.subarray(0, length),
        name: basename(path),
        mimeType,
      };
    } finally {
      await file.close();
    }
  }
}
