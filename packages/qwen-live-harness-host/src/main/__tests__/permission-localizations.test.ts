import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const packaging = readFileSync(
  new URL('../../../electron-builder.yml', import.meta.url),
  'utf8',
);
const keys = ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription'];

describe('macOS permission purpose localization', () => {
  for (const locale of ['en', 'zh-Hans']) {
    const file = new URL(
      `../../../resources/localizations/${locale}.lproj/InfoPlist.strings`,
      import.meta.url,
    );
    const source = readFileSync(file, 'utf8');
    const messages = Object.fromEntries(
      [...source.matchAll(/"([^"\n]+)"\s*=\s*("(?:\\.|[^"\\])*");/gu)].map(
        ([, key, value]) => [key, JSON.parse(value!)],
      ),
    );
    it(`packages valid ${locale} microphone and camera descriptions outside the asar`, () => {
      assert.deepEqual(Object.keys(messages).sort(), keys);
      for (const value of Object.values(messages)) {
        assert.equal(typeof value, 'string');
        assert.match(value, /Qwen Live Harness Host/u);
        assert.match(value, /Qwen Omni/u);
        assert.doesNotMatch(value, /when you|only when|始终|仅在|仅当/u);
      }
      assert(
        packaging.includes(`from: 'resources/localizations/${locale}.lproj'`),
      );
      assert(packaging.includes(`to: '${locale}.lproj'`));
      if (locale === 'en') {
        for (const [key, value] of Object.entries(messages))
          assert(packaging.includes(`${key}: '${value}'`));
      } else
        for (const value of Object.values(messages))
          assert.match(value, /[\u4e00-\u9fff]/u);
    });
    it(
      `accepts ${locale} InfoPlist.strings with the native plist parser`,
      { skip: process.platform !== 'darwin' },
      () => {
        const checked = spawnSync(
          '/usr/bin/plutil',
          ['-lint', fileURLToPath(file)],
          {
            encoding: 'utf8',
          },
        );
        assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
      },
    );
  }
  it('declares supported macOS languages independently of runtime UI preferences', () => {
    assert.match(packaging, /CFBundleDevelopmentRegion: 'en'/u);
    assert.match(packaging, /CFBundleLocalizations:\s+- 'en'\s+- 'zh-Hans'/u);
  });
});
