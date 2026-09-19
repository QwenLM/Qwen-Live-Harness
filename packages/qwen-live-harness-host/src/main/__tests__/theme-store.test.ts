import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  readHostTheme,
  readHostThemeColor,
  saveHostTheme,
  saveHostThemeColor,
} from '../theme-store.ts';
import {
  isLiveTheme,
  LIVE_THEMES,
  LIVE_THEME_COLORS,
} from '../../shared/theme.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'live-theme-store-'));
  directories.push(path);
  return path;
}

describe('Host-local theme preferences', () => {
  it('accepts only the three exact preference values', () => {
    for (const value of LIVE_THEMES) assert.equal(isLiveTheme(value), true);
    for (const value of [
      undefined,
      null,
      true,
      1,
      '',
      'auto',
      'Dark',
      ' light ',
      [],
      {},
      { theme: 'dark' },
    ]) {
      assert.equal(isLiveTheme(value), false);
    }
  });

  it('round-trips each preference privately without touching language settings', () => {
    const root = directory();
    const data = join(root, 'user-data');
    const path = join(data, 'theme.json');
    assert.equal(readHostTheme(path), 'system');
    saveHostTheme(path, 'light');
    const languagePath = join(data, 'language.json');
    writeFileSync(languagePath, '{"language":"zh-CN"}', { mode: 0o600 });
    for (const theme of LIVE_THEMES) {
      saveHostTheme(path, theme);
      assert.equal(readHostTheme(path), theme);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { theme });
      assert.equal(readFileSync(languagePath, 'utf8'), '{"language":"zh-CN"}');
      assert.deepEqual(readdirSync(data).sort(), [
        'language.json',
        'theme.json',
      ]);
    }
    if (process.platform !== 'win32') {
      assert.equal(statSync(data).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  });

  it('falls back to System for missing, malformed, unknown or non-object preferences', () => {
    const path = join(directory(), 'theme.json');
    assert.equal(readHostTheme(path), 'system');
    for (const contents of [
      '{',
      'null',
      'true',
      '1',
      '"dark"',
      '[]',
      '{}',
      '{"language":"zh-CN"}',
      '{"theme":"auto"}',
      '{"theme":"Dark"}',
      '{"theme":null}',
      '{"theme":false}',
      '{"theme":1}',
      '{"theme":[]}',
      '{"theme":{"theme":"dark"}}',
    ]) {
      writeFileSync(path, contents);
      assert.equal(readHostTheme(path), 'system', contents);
    }
    assert.equal(readHostTheme(directory()), 'system');
  });

  it('rejects invalid saves before writing or replacing the previous preference', () => {
    const root = directory();
    const path = join(root, 'theme.json');
    saveHostTheme(path, 'dark');
    for (const value of [undefined, null, 'auto', 'Dark', 1, true, {}, []]) {
      assert.throws(() => saveHostTheme(path, value as never), TypeError);
      assert.equal(readHostTheme(path), 'dark');
      assert.deepEqual(readdirSync(root), ['theme.json']);
    }
    const missing = join(root, 'uncreated', 'theme.json');
    assert.throws(() => saveHostTheme(missing, 'auto' as never), TypeError);
    assert.deepEqual(readdirSync(root), ['theme.json']);
  });

  it('reports filesystem failures and cleans temporary files after failed replacement', () => {
    const root = directory();
    const path = join(root, 'theme.json');
    mkdirSync(path);
    writeFileSync(join(path, 'keep.txt'), 'Keep this directory intact');
    assert.throws(() => saveHostTheme(path, 'light'));
    assert.deepEqual(readdirSync(root), ['theme.json']);
    assert.equal(
      readFileSync(join(path, 'keep.txt'), 'utf8'),
      'Keep this directory intact',
    );
    const blockedParent = join(root, 'file-not-directory');
    writeFileSync(blockedParent, 'unchanged');
    assert.throws(() =>
      saveHostTheme(join(blockedParent, 'theme.json'), 'dark'),
    );
    assert.equal(readFileSync(blockedParent, 'utf8'), 'unchanged');
  });
});

describe('config.json themeColor preference', () => {
  it('defaults to Iris and reads every named palette without rewriting the connected config', () => {
    const path = join(directory(), 'config.json');
    assert.equal(readHostThemeColor(), 'iris');
    assert.equal(readHostThemeColor(path), 'iris');
    for (const color of LIVE_THEME_COLORS) {
      const config =
        '\uFEFF' +
        JSON.stringify({
          themeColor: color,
          language: 'zh-CN',
          realtimeApiKey: 'untouched',
        });
      writeFileSync(path, config);
      assert.equal(readHostThemeColor(path), color);
      assert.equal(readFileSync(path, 'utf8'), config);
    }
    for (const config of [
      '{}',
      '{',
      'null',
      '[]',
      '{"themeColor":"unknown"}',
      '{"themeColor":true}',
    ]) {
      writeFileSync(path, config);
      assert.equal(readHostThemeColor(path), 'iris');
    }
  });

  it('changes only the root palette and preserves credentials, backend, Memory and unknown JSON bytes', () => {
    const root = directory();
    const path = join(root, 'config.json');
    const original =
      '\uFEFF{\r\n  "theme\\u0043olor" : "iris",\r\n  "realtimeApiKey": "test-secret-not-a-real-key",\r\n  "backend": {"kind":"codex","args":["--flag"]},\r\n  "memory":{"enabled":true,"themeColor":"nested"},\r\n  "unknown": [900719925474099312345, {"text":"a,}\\"b"}]\r\n}\r\n';
    writeFileSync(path, original, { mode: 0o644 });
    for (const color of LIVE_THEME_COLORS) {
      saveHostThemeColor(path, color);
      assert.equal(
        readFileSync(path, 'utf8'),
        original.replace('"iris"', JSON.stringify(color)),
      );
      assert.equal(readHostThemeColor(path), color);
      assert.deepEqual(readdirSync(root), ['config.json']);
      if (process.platform !== 'win32')
        assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  });

  it('adds a missing root preference without changing nested values or the source data', () => {
    const path = join(directory(), 'config.json');
    for (const original of [
      '{}',
      ' { } \n',
      '\uFEFF{\n}\n',
      '{"memory":{"themeColor":"sage"},"unknown":[true,null,{}]}',
      '{\n  "language": "zh-CN"\n}\n',
      '{"themeColor":{"previous":"invalid"}}',
    ]) {
      writeFileSync(path, original);
      saveHostThemeColor(path, 'tide');
      const before = JSON.parse(original.replace(/^\uFEFF/, ''));
      const after = JSON.parse(
        readFileSync(path, 'utf8').replace(/^\uFEFF/, ''),
      );
      assert.deepEqual(after, { ...before, themeColor: 'tide' });
    }
  });

  it('rejects invalid IPC-like palette values without creating or modifying a file', () => {
    const root = directory();
    const path = join(root, 'config.json');
    const original = '{"themeColor":"clay"}';
    writeFileSync(path, original);
    for (const color of [
      undefined,
      null,
      1,
      true,
      '',
      'Iris',
      'auto',
      ' iris ',
      [],
      {},
    ]) {
      assert.throws(() => saveHostThemeColor(path, color as never), TypeError);
      assert.equal(readFileSync(path, 'utf8'), original);
      assert.deepEqual(readdirSync(root), ['config.json']);
    }
    assert.throws(
      () =>
        saveHostThemeColor(
          join(root, 'missing', 'config.json'),
          'wrong' as never,
        ),
      TypeError,
    );
    assert.deepEqual(readdirSync(root), ['config.json']);
  });

  it('never creates missing configurations or repairs invalid JSON and duplicate root keys', () => {
    const root = directory();
    const path = join(root, 'config.json');
    for (const missing of [path, join(root, 'missing', 'config.json')]) {
      assert.throws(() => saveHostThemeColor(missing, 'rose'));
      assert.equal(existsSync(missing), false);
    }
    assert.deepEqual(readdirSync(root), []);
    for (const invalid of [
      '{"key":"test-secret",',
      'null',
      'true',
      '2',
      '[]',
      '"iris"',
      '{"themeColor":"iris","themeColor":"sage"}',
      '{"themeColor":"iris","theme\\u0043olor":"sage"}',
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
      JSON.stringify({ extra: 'x'.repeat(1024 * 1024) }),
    ]) {
      writeFileSync(path, invalid);
      const original = readFileSync(path);
      assert.throws(
        () => saveHostThemeColor(path, 'berry'),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.doesNotMatch(error.message, /test-secret/);
          return true;
        },
      );
      assert.deepEqual(readFileSync(path), original);
      assert.deepEqual(readdirSync(root), ['config.json']);
    }
  });

  it('rejects unsafe paths and non-regular targets without touching their data', () => {
    const root = directory();
    const path = join(root, 'config.json');
    writeFileSync(path, '{}');
    for (const invalid of [
      'config.json',
      join(root, 'other.json'),
      `${root}/../${root.split('/').at(-1)}/config.json`,
      `${root}/config.json\n`,
    ])
      assert.throws(() => saveHostThemeColor(invalid, 'graphite'));
    assert.equal(readFileSync(path, 'utf8'), '{}');
    const folder = join(root, 'folder');
    mkdirSync(folder);
    mkdirSync(join(folder, 'config.json'));
    assert.throws(() =>
      saveHostThemeColor(join(folder, 'config.json'), 'graphite'),
    );
    assert.equal(statSync(join(folder, 'config.json')).isDirectory(), true);
  });

  it(
    'rejects symlinks, hardlinks, readonly files and unsafe directories',
    { skip: process.platform === 'win32' },
    () => {
      const root = directory();
      const targetDirectory = join(root, 'real');
      mkdirSync(targetDirectory, { mode: 0o700 });
      const path = join(targetDirectory, 'config.json');
      writeFileSync(path, '{}', { mode: 0o600 });
      const aliasDirectory = join(root, 'alias');
      symlinkSync(targetDirectory, aliasDirectory);
      assert.throws(() =>
        saveHostThemeColor(join(aliasDirectory, 'config.json'), 'rose'),
      );
      const symlinkDirectory = join(root, 'symlinks');
      mkdirSync(symlinkDirectory, { mode: 0o700 });
      symlinkSync(path, join(symlinkDirectory, 'config.json'));
      assert.throws(() =>
        saveHostThemeColor(join(symlinkDirectory, 'config.json'), 'rose'),
      );
      const hardlink = join(root, 'hardlink');
      linkSync(path, hardlink);
      assert.throws(() => saveHostThemeColor(path, 'rose'));
      rmSync(hardlink);
      chmodSync(path, 0o400);
      assert.throws(() => saveHostThemeColor(path, 'rose'));
      chmodSync(path, 0o600);
      chmodSync(targetDirectory, 0o770);
      assert.throws(() => saveHostThemeColor(path, 'rose'));
      chmodSync(targetDirectory, 0o700);
      assert.equal(readFileSync(path, 'utf8'), '{}');
      assert.deepEqual(readdirSync(targetDirectory), ['config.json']);
    },
  );

  it('rechecks the live connection before replacing and cleans its private temporary file', () => {
    const root = directory();
    const path = join(root, 'config.json');
    const original = '{"themeColor":"iris"}';
    writeFileSync(path, original);
    let checks = 0;
    assert.throws(
      () =>
        saveHostThemeColor(path, 'sage', () => {
          checks++;
          if (checks === 2) {
            const temporary = readdirSync(root).find((file) =>
              file.endsWith('.tmp'),
            );
            assert(temporary);
            assert.equal(statSync(join(root, temporary)).mode & 0o777, 0o600);
          }
          return checks < 2;
        }),
      /no longer connected/,
    );
    assert.equal(checks, 2);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.deepEqual(readdirSync(root), ['config.json']);
    assert.throws(
      () => saveHostThemeColor(path, 'sage', () => false),
      /no longer connected/,
    );
    assert.deepEqual(readdirSync(root), ['config.json']);
  });

  it('does not overwrite another writer or a replaced inode before the final check', () => {
    for (const replace of [false, true]) {
      const root = directory();
      const path = join(root, 'config.json');
      writeFileSync(path, '{"themeColor":"iris"}');
      const newer = '{"themeColor":"clay","keep":"new external edit"}';
      let checks = 0;
      assert.throws(
        () =>
          saveHostThemeColor(path, 'sage', () => {
            if (++checks === 2) {
              if (replace) {
                const nextPath = join(root, 'new-config');
                writeFileSync(nextPath, newer);
                renameSync(nextPath, path);
              } else writeFileSync(path, newer);
            }
            return true;
          }),
        /changed before saving/,
      );
      assert.equal(readFileSync(path, 'utf8'), newer);
      assert.deepEqual(readdirSync(root), ['config.json']);
    }
  });
});
