/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveMessage } from './i18n/messages.js';
import {
  isPermissionMode,
  persistPermissionModePreference,
  resolvePermissionMode,
} from './permission-preferences.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const directories: string[] = [];
const PRIVATE_FIXTURE = 'fixture-api-key-must-not-leak';
const FIXED_TIME = new Date('2026-09-20T00:00:00.000Z');

function directory(): string {
  const path = fs.mkdtempSync(join(tmpdir(), 'live-permission-preference-'));
  directories.push(path);
  return path;
}

function configFixture() {
  return {
    realtimeApiKey: PRIVATE_FIXTURE,
    realtimeEndpoint: 'wss://invite.example.test/realtime',
    defaultBackend: 'codex',
    backends: [
      {
        name: 'codex',
        env: {
          OPENAI_API_KEY: 'fixture-backend-key',
          CUSTOM_COMMAND: "printf '%s'  'keep  spaces'",
        },
      },
    ],
    language: 'zh-CN',
    future: { nested: [null, true, { value: '原样保留' }], enabled: false },
    permissionMode: 'ask',
  };
}

function fixture(): { dataDir: string; path: string; original: Buffer } {
  const dataDir = directory();
  const path = join(dataDir, 'config.json');
  fs.writeFileSync(path, JSON.stringify(configFixture()), { mode: 0o644 });
  fs.utimesSync(path, FIXED_TIME, FIXED_TIME);
  return { dataDir, path, original: fs.readFileSync(path) };
}

function expectNoTemporaryFiles(dataDir: string): void {
  expect(
    fs
      .readdirSync(dataDir)
      .filter((name) => name.startsWith('.permission-mode-')),
  ).toEqual([]);
}

function capturedError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const captured = error as Error;
    expect(captured.message).not.toContain(PRIVATE_FIXTURE);
    expect(captured.message).not.toContain('EACCES');
    expect(captured.message).not.toContain('fixture-backend-key');
    return captured;
  }
  throw new Error('Expected preference persistence to fail.');
}

afterEach(() => {
  vi.mocked(fs.fsyncSync).mockReset().mockImplementation(actualFs.fsyncSync);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actualFs.renameSync);
  for (const path of directories.splice(0))
    fs.rmSync(path, { recursive: true, force: true });
});

describe('permission mode validation', () => {
  it('defaults to ask and accepts only the two exact modes', () => {
    expect(resolvePermissionMode(undefined)).toBe('ask');
    for (const mode of ['ask', 'allow-all'] as const) {
      expect(isPermissionMode(mode)).toBe(true);
      expect(resolvePermissionMode(mode)).toBe(mode);
    }
  });

  it.each([
    null,
    true,
    false,
    0,
    1,
    '',
    'auto',
    'allow',
    'ALLOW-ALL',
    ' ask',
    [],
    {},
  ])('rejects unknown mode %j without normalizing or widening it', (value) => {
    expect(isPermissionMode(value)).toBe(false);
    expect(capturedError(() => resolvePermissionMode(value)).message).toBe(
      liveMessage('permissionMode.invalid'),
    );
    const { dataDir, path, original } = fixture();
    expect(
      capturedError(() => persistPermissionModePreference(dataDir, value))
        .message,
    ).toBe(liveMessage('permissionMode.invalid'));
    expect(fs.readFileSync(path)).toEqual(original);
    expectNoTemporaryFiles(dataDir);
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it('does not treat an omitted settings value as permission to overwrite a saved mode', () => {
    const { dataDir, path, original } = fixture();
    expect(
      capturedError(() => persistPermissionModePreference(dataDir, undefined))
        .message,
    ).toBe(liveMessage('permissionMode.invalid'));
    expect(fs.readFileSync(path)).toEqual(original);
  });
});

describe('persistPermissionModePreference', () => {
  it.each(['ask', 'allow-all'] as const)(
    'atomically writes %s using a private temporary file and preserves every unrelated field',
    (mode) => {
      const { dataDir, path, original } = fixture();
      const before = fs.lstatSync(path);
      let temporaryPath: string | undefined;
      vi.mocked(fs.fsyncSync).mockImplementationOnce((fd) => {
        expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(path)).toEqual(original);
        actualFs.fsyncSync(fd);
      });
      vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
        temporaryPath = String(from);
        expect(to).toBe(path);
        expect(temporaryPath).toMatch(/\.permission-mode-[^/]+\.tmp$/u);
        expect(fs.lstatSync(temporaryPath).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(path)).toEqual(original);
        expect(JSON.parse(fs.readFileSync(temporaryPath, 'utf8'))).toEqual({
          ...configFixture(),
          permissionMode: mode,
        });
        actualFs.renameSync(from, to);
      });

      expect(persistPermissionModePreference(dataDir, mode)).toBe(mode);
      expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual({
        ...configFixture(),
        permissionMode: mode,
      });
      expect(fs.fsyncSync).toHaveBeenCalledOnce();
      expect(fs.renameSync).toHaveBeenCalledOnce();
      expect(fs.lstatSync(path).ino).not.toBe(before.ino);
      expect(fs.lstatSync(path).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(temporaryPath!)).toBe(false);
      expectNoTemporaryFiles(dataDir);
    },
  );

  it('accepts an existing object with a UTF-8 BOM while preserving credentials', () => {
    const { dataDir, path } = fixture();
    fs.writeFileSync(path, '\uFEFF' + JSON.stringify(configFixture()));
    expect(persistPermissionModePreference(dataDir, 'allow-all')).toBe(
      'allow-all',
    );
    expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual({
      ...configFixture(),
      permissionMode: 'allow-all',
    });
  });

  it('refuses a missing config instead of creating a partial config', () => {
    const dataDir = directory();
    expect(
      capturedError(() => persistPermissionModePreference(dataDir, 'allow-all'))
        .message,
    ).toBe(liveMessage('permissionMode.configInvalid'));
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });

  it.each([
    '{"realtimeApiKey":"' + PRIVATE_FIXTURE + '",',
    'null',
    '[]',
    '"' + PRIVATE_FIXTURE + '"',
    '0',
    'true',
  ])(
    'refuses invalid JSON or a non-object root without changing its bytes (%s)',
    (raw) => {
      const dataDir = directory();
      const path = join(dataDir, 'config.json');
      fs.writeFileSync(path, raw);
      expect(
        capturedError(() =>
          persistPermissionModePreference(dataDir, 'allow-all'),
        ).message,
      ).toBe(liveMessage('permissionMode.configInvalid'));
      expect(fs.readFileSync(path, 'utf8')).toBe(raw);
      expectNoTemporaryFiles(dataDir);
      expect(fs.renameSync).not.toHaveBeenCalled();
    },
  );

  it('refuses a config larger than 4 MiB before creating a replacement', () => {
    const dataDir = directory();
    const path = join(dataDir, 'config.json');
    const raw = JSON.stringify({
      private: PRIVATE_FIXTURE,
      large: 'x'.repeat(4 * 1024 * 1024),
    });
    fs.writeFileSync(path, raw);
    expect(
      capturedError(() => persistPermissionModePreference(dataDir, 'allow-all'))
        .message,
    ).toBe(liveMessage('permissionMode.configInvalid'));
    expect(fs.readFileSync(path, 'utf8')).toBe(raw);
    expectNoTemporaryFiles(dataDir);
  });

  it.each(['symlink', 'hardlink', 'directory'] as const)(
    'refuses a %s config leaf without modifying the target',
    (kind) => {
      const dataDir = directory();
      const path = join(dataDir, 'config.json');
      const target = join(dataDir, 'private-original.json');
      const original = JSON.stringify(configFixture());
      fs.writeFileSync(target, original);
      if (kind === 'symlink') fs.symlinkSync(target, path);
      else if (kind === 'hardlink') fs.linkSync(target, path);
      else fs.mkdirSync(path);
      expect(
        capturedError(() =>
          persistPermissionModePreference(dataDir, 'allow-all'),
        ).message,
      ).toBe(liveMessage('permissionMode.configInvalid'));
      expect(fs.readFileSync(target, 'utf8')).toBe(original);
      expectNoTemporaryFiles(dataDir);
      expect(fs.renameSync).not.toHaveBeenCalled();
    },
  );

  it.each(['fsync', 'rename'] as const)(
    'cleans up private temporary files and sanitizes a %s failure',
    (stage) => {
      const { dataDir, path, original } = fixture();
      const fail = () => {
        throw new Error(`EACCES ${PRIVATE_FIXTURE} fixture-backend-key`);
      };
      if (stage === 'fsync')
        vi.mocked(fs.fsyncSync).mockImplementationOnce(fail);
      else vi.mocked(fs.renameSync).mockImplementationOnce(fail);
      expect(
        capturedError(() =>
          persistPermissionModePreference(dataDir, 'allow-all'),
        ).message,
      ).toBe(liveMessage('permissionMode.saveFailed'));
      expect(fs.readFileSync(path)).toEqual(original);
      expectNoTemporaryFiles(dataDir);
      if (stage === 'fsync') expect(fs.renameSync).not.toHaveBeenCalled();
    },
  );

  it('rejects a same-size same-inode edit even when its mtime is restored', () => {
    const { dataDir, path, original } = fixture();
    const before = fs.lstatSync(path);
    const changed = Buffer.from(
      original.toString('utf8').replace('原样保留', '并发修改'),
    );
    expect(changed.length).toBe(original.length);
    vi.mocked(fs.fsyncSync).mockImplementationOnce((fd) => {
      actualFs.fsyncSync(fd);
      fs.writeFileSync(path, changed);
      fs.utimesSync(path, FIXED_TIME, FIXED_TIME);
      expect(fs.lstatSync(path)).toMatchObject({
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
      });
    });
    expect(
      capturedError(() => persistPermissionModePreference(dataDir, 'allow-all'))
        .message,
    ).toBe(liveMessage('permissionMode.concurrentEdit'));
    expect(fs.readFileSync(path)).toEqual(changed);
    expect(fs.renameSync).not.toHaveBeenCalled();
    expectNoTemporaryFiles(dataDir);
  });

  it('rejects an inode replacement even when the replacement has identical bytes and mtime', () => {
    const { dataDir, path, original } = fixture();
    const before = fs.lstatSync(path);
    let replacementInode: number | bigint | undefined;
    vi.mocked(fs.fsyncSync).mockImplementationOnce((fd) => {
      actualFs.fsyncSync(fd);
      const replacement = join(dataDir, 'concurrent.json');
      fs.writeFileSync(replacement, original);
      fs.utimesSync(replacement, FIXED_TIME, FIXED_TIME);
      actualFs.renameSync(replacement, path);
      replacementInode = fs.lstatSync(path).ino;
      expect(replacementInode).not.toBe(before.ino);
      expect(fs.lstatSync(path).mtimeMs).toBe(before.mtimeMs);
    });
    expect(
      capturedError(() => persistPermissionModePreference(dataDir, 'allow-all'))
        .message,
    ).toBe(liveMessage('permissionMode.concurrentEdit'));
    expect(fs.readFileSync(path)).toEqual(original);
    expect(fs.lstatSync(path).ino).toBe(replacementInode);
    expect(fs.renameSync).not.toHaveBeenCalled();
    expectNoTemporaryFiles(dataDir);
  });

  it.each(['symlink', 'hardlink'] as const)(
    'refuses a concurrent %s leaf change after the temporary file is written',
    (kind) => {
      const { dataDir, path, original } = fixture();
      const other = join(dataDir, 'concurrent-target.json');
      vi.mocked(fs.fsyncSync).mockImplementationOnce((fd) => {
        actualFs.fsyncSync(fd);
        if (kind === 'symlink') {
          fs.writeFileSync(other, original);
          fs.unlinkSync(path);
          fs.symlinkSync(other, path);
        } else fs.linkSync(path, other);
      });
      expect(
        capturedError(() =>
          persistPermissionModePreference(dataDir, 'allow-all'),
        ).message,
      ).toBe(liveMessage('permissionMode.concurrentEdit'));
      expect(fs.readFileSync(other)).toEqual(original);
      expect(fs.readFileSync(path)).toEqual(original);
      expect(fs.renameSync).not.toHaveBeenCalled();
      expectNoTemporaryFiles(dataDir);
    },
  );
});
