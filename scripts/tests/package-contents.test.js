/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCliHelp,
  assertInstalledNotices,
  assertPackageContents,
} from '../check-package.mjs';
import { liveText } from '../../packages/qwen-live-harness/src/i18n/messages.ts';

const required = [
  'dist/index.js',
  'dist/LICENSE',
  'dist/vendor/qwen-code-sdk-LICENSE',
  'dist/vendor/qwen-code-peer/LICENSE',
  'dist/vendor/qwen-code-peer/upstream.json',
  'dist/vendor/qwen-code-peer/README.md',
];
const manifest = (paths = required) => ({
  files: paths.map((path) => ({ path })),
});
const temporary = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('npm package content guard', () => {
  it.each(['en', 'zh-CN'])(
    'accepts the current %s public CLI help contract',
    (language) => {
      expect(() =>
        assertCliHelp(liveText(language, 'cli.usage')),
      ).not.toThrow();
    },
  );

  it.each([
    [
      'old usage',
      (text) =>
        text.replace('[init | doctor --peers] [options]', '[init] [--debug]'),
    ],
    [
      'wrong binary',
      (text) => text.replace('Usage: qwen-live-harness', 'Usage: qwen-code'),
    ],
    ['missing init', (text) => text.replace(/^ {2}init {2,}.*$/mu, '')],
    [
      'missing init --peers',
      (text) => text.replace(/^ {2}init --peers.*$/mu, ''),
    ],
    [
      'missing doctor --peers',
      (text) => text.replace(/^ {2}doctor --peers.*$/mu, ''),
    ],
    [
      'missing debug short flag',
      (text) => text.replace('--debug, -d', '--debug'),
    ],
    ['missing help short flag', (text) => text.replace('--help, -h', '--help')],
    [
      'wrong development flag',
      (text) => text.replace('--daemon-only', '--no-host'),
    ],
  ])(
    'rejects an incorrect/incomplete installed help surface: %s',
    (_name, mutate) => {
      expect(() =>
        assertCliHelp(mutate(liveText('en', 'cli.usage'))),
      ).toThrow();
    },
  );

  it('accepts compiled runtime and all complete notice paths without a package-root LICENSE', () => {
    expect(() => assertPackageContents(manifest())).not.toThrow();
  });

  it('accepts every production log module and declaration instead of mistaking the source directory for generated logs', async () => {
    const sources = await readdir(
      new URL('../../packages/qwen-live-harness/src/log/', import.meta.url),
    );
    const modules = sources.filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(modules.length).toBeGreaterThan(0);
    const emitted = modules.flatMap((name) => [
      `dist/log/${name.slice(0, -3)}.js`,
      `dist/log/${name.slice(0, -3)}.d.ts`,
    ]);
    expect(emitted).toContain('dist/log/session-log.js');
    expect(emitted).toContain('dist/log/debug-archive.d.ts');
    expect(() =>
      assertPackageContents(manifest([...required, ...emitted])),
    ).not.toThrow();
  });

  it.each(required)(
    'requires %s even if a legacy root LICENSE exists',
    (missing) => {
      expect(() =>
        assertPackageContents(
          manifest([...required.filter((name) => name !== missing), 'LICENSE']),
        ),
      ).toThrow('Required file absent');
    },
  );

  it.each([
    'dist/main.js.map',
    'dist/main.js.MAP',
    'dist/main.js.bak',
    'dist/main.js.BACKUP',
    'dist/main.old',
    'dist/main.orig',
    'dist/file.tmp',
    'dist/file.temp',
    'dist/run.log',
    'dist/file.tsbuildinfo',
    'dist/file.swp',
    'dist/file.swo',
    'dist/file~',
    'dist/example.test.js',
    'dist/example.spec.js',
    'dist/__tests__/one.js',
    'dist/testing/fake.js',
    'dist/test-fixtures/fake.js',
    'dist/tests/one.js',
    'dist/coverage/index.html',
    'dist/debug/events.jsonl',
    'dist/logs/run.jsonl',
    'dist/log/session.jsonl',
    'dist/log/trace.ndjson',
    'src/index.ts',
    'debug/run.jsonl',
  ])('rejects unexpected intermediate %s', (unwanted) => {
    expect(() =>
      assertPackageContents(manifest([...required, unwanted])),
    ).toThrow('artifacts leaked');
  });

  it.each(['/tmp/private', '../LICENSE', 'dist/../LICENSE', 'dist\\LICENSE'])(
    'rejects invalid package path %s',
    (invalid) => {
      expect(() =>
        assertPackageContents(manifest([...required, invalid])),
      ).toThrow('Invalid path');
    },
  );

  it('validates installed full license and vendor notice bytes, not merely presence', async () => {
    const installed = await mkdtemp(
      join(tmpdir(), 'qwen-package-notices-test-'),
    );
    temporary.push(installed);
    const expected = {
      'dist/LICENSE': Buffer.from(
        'Complete project license\nTerms remain unchanged.\n',
      ),
      'dist/vendor/qwen-code-sdk-LICENSE': Buffer.from(
        'Third-party SDK license\n',
      ),
      'dist/vendor/qwen-code-peer/LICENSE': Buffer.from(
        'Third-party peer license\n',
      ),
      'dist/vendor/qwen-code-peer/upstream.json': Buffer.from(
        '{"commit":"fixture"}\n',
      ),
      'dist/vendor/qwen-code-peer/README.md': Buffer.from(
        'Pinned source provenance\n',
      ),
    };
    for (const [name, bytes] of Object.entries(expected)) {
      await mkdir(dirname(join(installed, name)), { recursive: true });
      await writeFile(join(installed, name), bytes);
    }
    expect(() => assertInstalledNotices(installed, expected)).not.toThrow();
    await writeFile(
      join(installed, 'dist/LICENSE'),
      'Complete project license\n',
    );
    expect(() => assertInstalledNotices(installed, expected)).toThrow(
      'notice differs',
    );
    await writeFile(join(installed, 'dist/LICENSE'), expected['dist/LICENSE']);
    await writeFile(
      join(installed, 'dist/vendor/qwen-code-peer/LICENSE'),
      'Different license',
    );
    expect(() => assertInstalledNotices(installed, expected)).toThrow(
      'notice differs',
    );
    await rm(join(installed, 'dist/LICENSE'));
    expect(() => assertInstalledNotices(installed, expected)).toThrow();
  });
});
