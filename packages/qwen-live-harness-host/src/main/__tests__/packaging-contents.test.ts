import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterEach, describe, it } from 'node:test';
import { createPackage } from '@electron/asar';

const appDirectory = fileURLToPath(new URL('../../../', import.meta.url));
const rootLicense = resolve(appDirectory, '../../LICENSE');
const require = createRequire(import.meta.url);
const { assertPackagedContents } =
  require('../../../scripts/after-pack.cjs') as {
    assertPackagedContents(
      app: string,
      license?: string,
    ): { entries: number; licenseBytes: number; workletBytes: number };
  };
const { load } = require('js-yaml') as {
  load(text: string): Record<string, unknown>;
};
const { getMainFileMatchers } =
  require('app-builder-lib/out/fileMatcher.js') as {
    getMainFileMatchers(
      ...args: unknown[]
    ): Array<{ createFilter(): (filename: string, stat: unknown) => boolean }>;
  };
const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(
  extra: Record<string, string> = {},
  omit?: 'license' | 'worklet' | 'native' | 'locale',
) {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-host-package-test-'));
  temporary.push(directory);
  const source = join(directory, 'source');
  const app = join(directory, 'Fixture.app');
  const resources = join(app, 'Contents', 'Resources');
  const files: Record<string, string | Buffer> = {
    'dist/main.cjs': 'module.exports = {};',
    'dist/preload.cjs': 'module.exports = {};',
    'dist/subagents-preload.cjs': 'module.exports = {};',
    'dist/renderer/index.html': '<main></main>',
    'dist/renderer/subagents.html': '<main></main>',
    'dist/renderer/assets/main.js': 'console.log("fixture");',
    'package.json': '{"name":"fixture","version":"1.0.0"}',
    ...(omit === 'license'
      ? {}
      : { 'dist/LICENSE': await readFile(rootLicense) }),
    ...(omit === 'worklet'
      ? {}
      : {
          'dist/renderer/audio-input-worklet.js': await readFile(
            join(appDirectory, 'resources/audio-input-worklet.js'),
          ),
        }),
    ...extra,
  };
  for (const [name, content] of Object.entries(files)) {
    const target = join(source, name);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
  await mkdir(resources, { recursive: true });
  if (omit !== 'native') {
    await mkdir(join(resources, 'native'), { recursive: true });
    await writeFile(
      join(resources, 'native/qwen-live-harness-appshot.node'),
      Buffer.from([0, 1]),
    );
  }
  for (const locale of ['en', 'zh-Hans']) {
    if (omit === 'locale' && locale === 'zh-Hans') continue;
    const name = `${locale}.lproj/InfoPlist.strings`;
    await mkdir(resolve(join(resources, name), '..'), { recursive: true });
    await writeFile(
      join(resources, name),
      await readFile(join(appDirectory, 'resources/localizations', name)),
    );
  }
  await createPackage(source, join(resources, 'app.asar'));
  return { app, source, resources, files };
}

describe('Host packaged contents and release whitelist', () => {
  it('validates the actual ASAR license and worklet while keeping native resources', async () => {
    const f = await fixture();
    const result = assertPackagedContents(f.app, rootLicense);
    assert.equal(result.licenseBytes, (await readFile(rootLicense)).length);
    assert.equal(
      result.workletBytes,
      (await readFile(join(appDirectory, 'resources/audio-input-worklet.js')))
        .length,
    );
    assert(result.entries > 0);
  });

  for (const omitted of ['license', 'worklet', 'native', 'locale'] as const)
    it(`fails packaging when required ${omitted} is absent`, async () => {
      const f = await fixture({}, omitted);
      assert.throws(() => assertPackagedContents(f.app, rootLicense));
    });

  it('rejects a truncated license rather than accepting its filename alone', async () => {
    const f = await fixture({ 'dist/LICENSE': 'Apache License header only' });
    assert.throws(
      () => assertPackagedContents(f.app, rootLicense),
      /license must exactly match/u,
    );
  });

  for (const file of [
    'dist/renderer/assets/main.js.map',
    'dist/main.cjs.MAP',
    'dist/renderer/assets/main.js.backup',
    'dist/renderer/debug.log',
    'dist/renderer/view.test.js',
    'dist/renderer/icon.png',
    'dist/renderer/icon.icns',
    'dist/renderer/localizations/en.lproj/InfoPlist.strings',
  ])
    it(`rejects the actual packaged unwanted file ${file}`, async () => {
      const f = await fixture({ [file]: 'not for the release' });
      assert.throws(
        () => assertPackagedContents(f.app, rootLicense),
        /Unwanted files/u,
      );
    });

  it('uses electron-builder actual file matching to include the license and worklet but exclude maps and duplicate resources', async () => {
    const f = await fixture({
      'dist/main.cjs.map': '{}',
      'dist/renderer/assets/main.js.map': '{}',
      'dist/renderer/icon.png': 'duplicate',
      'dist/renderer/localizations/en.lproj/InfoPlist.strings': 'duplicate',
      'dist/renderer/file.bak': 'backup',
      'src/main/__tests__/fixture.test.ts': 'test',
    });
    const config = load(
      await readFile(join(appDirectory, 'electron-builder.yml'), 'utf8'),
    );
    const packager = {
      info: {
        config,
        projectDir: f.source,
        buildResourcesDir: 'resources',
        isPrepackedAppAsar: false,
        debugLogger: { isEnabled: false },
      },
    };
    const [matcher] = getMainFileMatchers(
      f.source,
      join(f.source, 'unused-output'),
      (value: string) => value,
      {},
      packager,
      join(f.source, 'release'),
      false,
    );
    const accepts = matcher!.createFilter();
    for (const name of [
      'dist/main.cjs',
      'dist/LICENSE',
      'dist/renderer/audio-input-worklet.js',
      'dist/renderer/assets/main.js',
    ])
      assert.equal(
        accepts(join(f.source, name), await stat(join(f.source, name))),
        true,
        name,
      );
    for (const name of [
      'dist/main.cjs.map',
      'dist/renderer/assets/main.js.map',
      'dist/renderer/icon.png',
      'dist/renderer/localizations/en.lproj/InfoPlist.strings',
      'dist/renderer/file.bak',
      'src/main/__tests__/fixture.test.ts',
    ])
      assert.equal(
        accepts(join(f.source, name), await stat(join(f.source, name))),
        false,
        name,
      );
  });

  it('copies only the required worklet into renderer and has no Host-only version bump entry', async () => {
    const build = await readFile(
      join(appDirectory, 'scripts/build.mjs'),
      'utf8',
    );
    const vite = await readFile(join(appDirectory, 'vite.config.ts'), 'utf8');
    const pkg = JSON.parse(
      await readFile(join(appDirectory, 'package.json'), 'utf8'),
    ) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.match(vite, /publicDir:\s*false/u);
    assert.match(
      build,
      /resources', 'audio-input-worklet\.js'[\s\S]*renderer', 'audio-input-worklet\.js'/u,
    );
    assert.equal(pkg.scripts['bump-version'], undefined);
    assert.equal(pkg.devDependencies['semver'], undefined);
    assert.equal(pkg.devDependencies['@types/semver'], undefined);
    assert(pkg.devDependencies['@electron/asar']);
  });
});
