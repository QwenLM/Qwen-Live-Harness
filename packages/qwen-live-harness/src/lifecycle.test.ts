/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonStopMarkerError,
  readDaemonStopMarker,
  writeDaemonStopMarker,
  type DaemonIdentity,
} from './lifecycle.js';

let temporaryDirectory: string;
let discoveryPath: string;
const identity: DaemonIdentity = {
  pid: process.pid,
  instanceNonce: 'daemon_lifecycle_nonce_0001',
};

function markerName(nonce = identity.instanceNonce): string {
  return `${createHash('sha256').update(nonce).digest('hex')}.json`;
}

function markerPath(nonce = identity.instanceNonce): string {
  return join(dirname(discoveryPath), 'stopped', markerName(nonce));
}

function serializedMarker(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    ...identity,
    endedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(join(tmpdir(), 'qwen-harness-stop-'));
  discoveryPath = join(temporaryDirectory, 'run', 'daemon.json');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe('intentional daemon shutdown markers', () => {
  it('does not infer an intentional shutdown from missing discovery or directories', async () => {
    await expect(readDaemonStopMarker(discoveryPath, identity)).resolves.toBe(
      false,
    );
    await expect(fs.readdir(temporaryDirectory)).resolves.toEqual([]);
    await fs.mkdir(dirname(discoveryPath), { mode: 0o700 });
    await expect(readDaemonStopMarker(discoveryPath, identity)).resolves.toBe(
      false,
    );
  });

  it('publishes a private atomic marker for exactly one daemon generation', async () => {
    await writeDaemonStopMarker(discoveryPath, identity);
    await expect(readDaemonStopMarker(discoveryPath, identity)).resolves.toBe(
      true,
    );
    await expect(
      readDaemonStopMarker(discoveryPath, {
        ...identity,
        pid: identity.pid + 1,
      }),
    ).resolves.toBe(false);
    await expect(
      readDaemonStopMarker(discoveryPath, {
        ...identity,
        instanceNonce: 'daemon_lifecycle_nonce_0002',
      }),
    ).resolves.toBe(false);
    expect(JSON.parse(await fs.readFile(markerPath(), 'utf8'))).toEqual({
      schemaVersion: 1,
      ...identity,
      endedAt: expect.any(String),
    });
    if (process.platform !== 'win32') {
      expect((await fs.stat(markerPath())).mode & 0o777).toBe(0o600);
      expect((await fs.stat(dirname(markerPath()))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(dirname(discoveryPath))).mode & 0o777).toBe(0o700);
    }
    await expect(fs.readdir(dirname(markerPath()))).resolves.toEqual([
      markerName(),
    ]);
  });

  it('supports the longest valid nonce without exceeding filesystem filename limits', async () => {
    const longest = { ...identity, instanceNonce: 'a'.repeat(256) };
    await writeDaemonStopMarker(discoveryPath, longest);
    await expect(readDaemonStopMarker(discoveryPath, longest)).resolves.toBe(
      true,
    );
    const files = await fs.readdir(dirname(markerPath()));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(
      JSON.parse(await fs.readFile(markerPath(longest.instanceNonce), 'utf8')),
    ).toMatchObject(longest);
  });

  it('keeps an existing matching marker unchanged and rejects nonce collisions', async () => {
    await writeDaemonStopMarker(discoveryPath, identity);
    const before = await fs.readFile(markerPath(), 'utf8');
    const inode = (await fs.stat(markerPath())).ino;
    await writeDaemonStopMarker(discoveryPath, identity);
    await expect(fs.readFile(markerPath(), 'utf8')).resolves.toBe(before);
    expect((await fs.stat(markerPath())).ino).toBe(inode);
    await expect(
      writeDaemonStopMarker(discoveryPath, {
        ...identity,
        pid: identity.pid + 1,
      }),
    ).rejects.toBeInstanceOf(DaemonStopMarkerError);
    await expect(fs.readFile(markerPath(), 'utf8')).resolves.toBe(before);
  });

  it.each([
    { pid: 0 },
    { pid: -1 },
    { pid: 1.5 },
    { pid: Number.MAX_SAFE_INTEGER + 1 },
    { instanceNonce: '../unsafe_identity' },
    { instanceNonce: 'short' },
    { instanceNonce: 'a'.repeat(257) },
  ])(
    'rejects invalid identity without touching the filesystem: %j',
    async (overrides) => {
      const invalid = { ...identity, ...overrides };
      await expect(
        writeDaemonStopMarker(discoveryPath, invalid),
      ).rejects.toThrow('Qwen Live Harness daemon stop marker is invalid.');
      await expect(
        readDaemonStopMarker(discoveryPath, invalid),
      ).rejects.toBeInstanceOf(DaemonStopMarkerError);
      await expect(fs.readdir(temporaryDirectory)).resolves.toEqual([]);
    },
  );

  it.each(['relative/run/daemon.json', '/absolute/invalid\0path'])(
    'rejects invalid discovery paths: %s',
    async (path) => {
      await expect(
        writeDaemonStopMarker(path, identity),
      ).rejects.toBeInstanceOf(DaemonStopMarkerError);
      await expect(readDaemonStopMarker(path, identity)).rejects.toBeInstanceOf(
        DaemonStopMarkerError,
      );
    },
  );

  it.each(['run', 'stopped', 'marker'])(
    'rejects symlinks at %s without following them',
    async (target) => {
      if (process.platform === 'win32') return;
      await writeDaemonStopMarker(discoveryPath, identity);
      const path =
        target === 'run'
          ? dirname(discoveryPath)
          : target === 'stopped'
            ? dirname(markerPath())
            : markerPath();
      const moved = `${path}-real`;
      await fs.rename(path, moved);
      await fs.symlink(moved, path);
      await expect(
        readDaemonStopMarker(discoveryPath, identity),
      ).rejects.toBeInstanceOf(DaemonStopMarkerError);
      await expect(
        writeDaemonStopMarker(discoveryPath, identity),
      ).rejects.toBeInstanceOf(DaemonStopMarkerError);
    },
  );

  it.each(['run', 'stopped', 'marker'])(
    'rejects public permissions on %s',
    async (target) => {
      if (process.platform === 'win32') return;
      await writeDaemonStopMarker(discoveryPath, identity);
      const path =
        target === 'run'
          ? dirname(discoveryPath)
          : target === 'stopped'
            ? dirname(markerPath())
            : markerPath();
      await fs.chmod(path, target === 'marker' ? 0o644 : 0o755);
      await expect(
        readDaemonStopMarker(discoveryPath, identity),
      ).rejects.toBeInstanceOf(DaemonStopMarkerError);
      await expect(
        writeDaemonStopMarker(discoveryPath, identity),
      ).rejects.toBeInstanceOf(DaemonStopMarkerError);
    },
  );

  it('rejects a marker with multiple hard links', async () => {
    await writeDaemonStopMarker(discoveryPath, identity);
    await fs.link(markerPath(), join(temporaryDirectory, 'other-link.json'));
    await expect(
      readDaemonStopMarker(discoveryPath, identity),
    ).rejects.toBeInstanceOf(DaemonStopMarkerError);
    await expect(
      writeDaemonStopMarker(discoveryPath, identity),
    ).rejects.toBeInstanceOf(DaemonStopMarkerError);
  });

  it('rejects state owned by another user', async () => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function')
      return;
    await writeDaemonStopMarker(discoveryPath, identity);
    const anotherUid = process.getuid() + 1;
    vi.spyOn(process as { getuid: () => number }, 'getuid').mockReturnValue(
      anotherUid,
    );
    await expect(
      readDaemonStopMarker(discoveryPath, identity),
    ).rejects.toBeInstanceOf(DaemonStopMarkerError);
  });

  it.each([
    '',
    '{broken json',
    'null',
    '[]',
    'x'.repeat(4_097),
    serializedMarker({ schemaVersion: 2 }),
    serializedMarker({ endedAt: 'yesterday' }),
    serializedMarker({ pid: 0 }),
    serializedMarker({ extra: 'unknown-format' }),
  ])('rejects malformed or unbounded marker data %#', async (serialized) => {
    await writeDaemonStopMarker(discoveryPath, identity);
    await fs.writeFile(markerPath(), serialized);
    await expect(
      readDaemonStopMarker(discoveryPath, identity),
    ).rejects.toBeInstanceOf(DaemonStopMarkerError);
    await expect(
      writeDaemonStopMarker(discoveryPath, identity),
    ).rejects.toBeInstanceOf(DaemonStopMarkerError);
  });

  it('does not accept a different nonce inside an otherwise valid marker', async () => {
    await writeDaemonStopMarker(discoveryPath, identity);
    await fs.writeFile(
      markerPath(),
      serializedMarker({ instanceNonce: 'different_daemon_nonce_0001' }),
    );
    await expect(readDaemonStopMarker(discoveryPath, identity)).resolves.toBe(
      false,
    );
  });

  it('retains the newest 64 valid markers and leaves unrelated files untouched', async () => {
    await fs.mkdir(dirname(markerPath()), { recursive: true, mode: 0o700 });
    const oldNonces = Array.from(
      { length: 66 },
      (_, index) => `daemon_retention_nonce_${String(index).padStart(4, '0')}`,
    );
    for (const [index, nonce] of oldNonces.entries()) {
      await fs.writeFile(
        markerPath(nonce),
        serializedMarker({
          instanceNonce: nonce,
          endedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        }),
        { mode: 0o600 },
      );
    }
    const unrelated = [
      'notes.txt',
      markerName('foreign_marker_nonce_0001'),
      markerName('mismatch_marker_nonce_0001'),
    ];
    await fs.writeFile(join(dirname(markerPath()), unrelated[0]!), 'keep me');
    await fs.writeFile(join(dirname(markerPath()), unrelated[1]!), '{invalid', {
      mode: 0o600,
    });
    await fs.writeFile(
      join(dirname(markerPath()), unrelated[2]!),
      serializedMarker({ instanceNonce: 'mismatch_marker_nonce_0002' }),
      { mode: 0o600 },
    );
    await writeDaemonStopMarker(discoveryPath, identity);
    await expect(readDaemonStopMarker(discoveryPath, identity)).resolves.toBe(
      true,
    );
    const files = await fs.readdir(dirname(markerPath()));
    expect(files).toHaveLength(64 + unrelated.length);
    expect(files).toEqual(expect.arrayContaining(unrelated));
    for (const nonce of oldNonces.slice(0, 3)) {
      expect(files).not.toContain(markerName(nonce));
    }
    expect(files).toContain(markerName(oldNonces[3]));
    expect(files).toContain(markerName(oldNonces[65]));
  });
});
