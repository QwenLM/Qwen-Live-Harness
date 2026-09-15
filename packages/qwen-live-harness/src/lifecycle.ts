/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const MARKER_FILENAME_PATTERN = /^[a-f0-9]{64}\.json$/;
const MAX_MARKER_BYTES = 4_096;
const MAX_MARKERS = 64;

export interface DaemonIdentity {
  pid: number;
  instanceNonce: string;
}

interface DaemonStopMarker extends DaemonIdentity {
  schemaVersion: 1;
  endedAt: string;
}

interface DirectoryIdentity {
  path: string;
  stat: Stats;
  privateMode: boolean;
}

export class DaemonStopMarkerError extends Error {
  constructor(cause?: unknown) {
    super('Qwen Live Harness daemon stop marker is invalid.', { cause });
    this.name = 'DaemonStopMarkerError';
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function markerFilename(nonce: string): string {
  // Discovery nonces may exceed the filesystem's 255-byte filename limit.
  // Keep the full identity in the record and use a fixed-size locator only.
  return `${createHash('sha256').update(nonce).digest('hex')}.json`;
}

function validIdentity(identity: DaemonIdentity): boolean {
  return (
    identity !== null &&
    typeof identity === 'object' &&
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    typeof identity.instanceNonce === 'string' &&
    NONCE_PATTERN.test(identity.instanceNonce)
  );
}

function assertArguments(
  discoveryPath: string,
  identity: DaemonIdentity,
): void {
  if (
    typeof discoveryPath !== 'string' ||
    !isAbsolute(discoveryPath) ||
    discoveryPath.length > 4_096 ||
    discoveryPath.includes('\0') ||
    !validIdentity(identity)
  ) {
    throw new DaemonStopMarkerError();
  }
}

function ownedMode(stat: Stats, mode?: number): boolean {
  return (
    process.platform === 'win32' ||
    ((typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
      (mode === undefined || (stat.mode & 0o777) === mode))
  );
}

async function inspectDirectory(
  path: string,
  privateMode: boolean,
): Promise<DirectoryIdentity> {
  const stat = await fs.lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !ownedMode(stat, privateMode ? 0o700 : undefined)
  ) {
    throw new DaemonStopMarkerError();
  }
  return { path, stat, privateMode };
}

async function assertDirectories(
  directories: DirectoryIdentity[],
): Promise<void> {
  for (const directory of directories) {
    const current = await inspectDirectory(
      directory.path,
      directory.privateMode,
    );
    if (
      current.stat.dev !== directory.stat.dev ||
      current.stat.ino !== directory.stat.ino
    ) {
      throw new DaemonStopMarkerError();
    }
  }
}

async function markerDirectories(
  discoveryPath: string,
  create: boolean,
): Promise<DirectoryIdentity[]> {
  const run = dirname(discoveryPath);
  // A direct daemon API caller can stop during preflight, before discovery
  // has created its base directory. CLI startup normally creates this sooner.
  if (create) await fs.mkdir(dirname(run), { recursive: true, mode: 0o700 });
  const directories = [await inspectDirectory(dirname(run), false)];
  for (const path of [run, join(run, 'stopped')]) {
    if (create) {
      await assertDirectories(directories);
      try {
        await fs.mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
    }
    directories.push(await inspectDirectory(path, true));
  }
  await assertDirectories(directories);
  return directories;
}

function parseMarker(value: unknown): DaemonStopMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DaemonStopMarkerError();
  }
  const record = value as DaemonStopMarker;
  if (
    Object.keys(record).sort().join(',') !==
      'endedAt,instanceNonce,pid,schemaVersion' ||
    record.schemaVersion !== 1 ||
    !validIdentity(record) ||
    typeof record.endedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.endedAt)) ||
    new Date(record.endedAt).toISOString() !== record.endedAt
  ) {
    throw new DaemonStopMarkerError();
  }
  return record;
}

async function readMarker(
  path: string,
): Promise<{ marker: DaemonStopMarker; stat: Stats } | undefined> {
  let stat: Stats;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    !ownedMode(stat, 0o600) ||
    stat.size < 1 ||
    stat.size > MAX_MARKER_BYTES
  ) {
    throw new DaemonStopMarkerError();
  }
  const handle = await fs.open(
    path,
    constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !ownedMode(opened, 0o600) ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      opened.size !== stat.size
    ) {
      throw new DaemonStopMarkerError();
    }
    // A fixed buffer also bounds reads if the file grows after lstat.
    const bytes = Buffer.alloc(MAX_MARKER_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new DaemonStopMarkerError();
    return {
      marker: parseMarker(JSON.parse(bytes.toString('utf8', 0, bytesRead))),
      stat,
    };
  } finally {
    await handle.close();
  }
}

/** Missing records never mean "stopped": only the exact daemon generation does. */
export async function readDaemonStopMarker(
  discoveryPath: string,
  identity: DaemonIdentity,
): Promise<boolean> {
  assertArguments(discoveryPath, identity);
  try {
    const directories = await markerDirectories(discoveryPath, false);
    const found = await readMarker(
      join(
        dirname(discoveryPath),
        'stopped',
        markerFilename(identity.instanceNonce),
      ),
    );
    await assertDirectories(directories);
    return (
      found !== undefined &&
      found.marker.pid === identity.pid &&
      found.marker.instanceNonce === identity.instanceNonce
    );
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    if (error instanceof DaemonStopMarkerError) throw error;
    throw new DaemonStopMarkerError(error);
  }
}

async function pruneMarkers(
  directories: DirectoryIdentity[],
  currentNonce: string,
): Promise<void> {
  const directory = directories[directories.length - 1]!.path;
  const markers: Array<{
    path: string;
    marker: DaemonStopMarker;
    stat: Stats;
  }> = [];
  for (const name of await fs.readdir(directory)) {
    if (!MARKER_FILENAME_PATTERN.test(name)) continue;
    try {
      const path = join(directory, name);
      const found = await readMarker(path);
      if (found && markerFilename(found.marker.instanceNonce) === name) {
        markers.push({ path, ...found });
      }
    } catch {
      // Foreign, damaged, or unsafe files are never cleanup targets.
    }
  }
  const previous = markers
    .filter(({ marker }) => marker.instanceNonce !== currentNonce)
    .sort(
      (a, b) =>
        b.marker.endedAt.localeCompare(a.marker.endedAt) ||
        b.marker.instanceNonce.localeCompare(a.marker.instanceNonce),
    );
  for (const candidate of previous.slice(MAX_MARKERS - 1)) {
    await assertDirectories(directories);
    try {
      const found = await readMarker(candidate.path);
      if (
        found &&
        found.stat.dev === candidate.stat.dev &&
        found.stat.ino === candidate.stat.ino &&
        found.marker.instanceNonce === candidate.marker.instanceNonce &&
        found.marker.pid === candidate.marker.pid
      ) {
        await fs.unlink(candidate.path);
      }
    } catch (error) {
      if (
        errorCode(error) !== 'ENOENT' &&
        !(error instanceof DaemonStopMarkerError)
      ) {
        throw error;
      }
    }
  }
}

/** Persist intentional shutdown before unpublishing discovery or closing sockets. */
export async function writeDaemonStopMarker(
  discoveryPath: string,
  identity: DaemonIdentity,
): Promise<void> {
  assertArguments(discoveryPath, identity);
  let temporary: string | undefined;
  try {
    const directories = await markerDirectories(discoveryPath, true);
    const directory = directories[directories.length - 1]!.path;
    const destination = join(directory, markerFilename(identity.instanceNonce));
    const existing = await readMarker(destination);
    if (existing) {
      if (
        existing.marker.pid !== identity.pid ||
        existing.marker.instanceNonce !== identity.instanceNonce
      ) {
        throw new DaemonStopMarkerError();
      }
      await pruneMarkers(directories, identity.instanceNonce);
      return;
    }
    const marker: DaemonStopMarker = {
      schemaVersion: 1,
      pid: identity.pid,
      instanceNonce: identity.instanceNonce,
      endedAt: new Date().toISOString(),
    };
    temporary = join(directory, `.stop-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(marker)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertDirectories(directories);
    await fs.rename(temporary, destination);
    temporary = undefined;
    await assertDirectories(directories);
    await pruneMarkers(directories, identity.instanceNonce);
  } catch (error) {
    if (error instanceof DaemonStopMarkerError) throw error;
    throw new DaemonStopMarkerError(error);
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => undefined);
  }
}
