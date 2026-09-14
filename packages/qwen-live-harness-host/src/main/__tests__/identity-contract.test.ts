import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { LIVE_HOST_BUNDLE_ID } from '../../shared/protocol.ts';

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('Qwen Live Harness Host identity', () => {
  it('uses the new native product and an independent Electron user data namespace', () => {
    const main = read('../index.ts');
    const builder = read('../../../electron-builder.yml');
    assert.equal(LIVE_HOST_BUNDLE_ID, 'com.alibaba.qwen-live-harness.host');
    assert.match(builder, /^appId: 'com\.alibaba\.qwen-live-harness\.host'$/mu);
    assert.match(builder, /^productName: 'Qwen Live Harness Host'$/mu);
    assert.match(main, /app\.setName\('Qwen Live Harness Host'\)/u);
    // Electron derives userData from the new app name. Do not silently retain
    // or migrate preferences from an unrelated, previously installed product.
    assert.doesNotMatch(main, /app\.setPath\(['"]userData['"]/u);
    assert.match(main, /title: 'Qwen Live Harness Host'/u);
    assert.match(
      read('../../native/appshot.mm'),
      /app_name == "Qwen Live Harness Host"/u,
    );
  });

  it('keeps renamed native resources synchronized across build, package and load', () => {
    const builder = read('../../../electron-builder.yml');
    const build = read('../../../scripts/build.mjs');
    const native = read('../native-appshot.ts');
    const main = read('../index.ts');
    assert.match(
      build,
      /join\(nativeDirectory, 'qwen-live-harness-appshot\.node'\)/u,
    );
    assert.match(
      builder,
      /from: 'dist\/native\/qwen-live-harness-appshot\.node'/u,
    );
    assert.match(builder, /to: 'native\/qwen-live-harness-appshot\.node'/u);
    assert.match(
      native,
      /join\(process\.resourcesPath, 'native', 'qwen-live-harness-appshot\.node'\)/u,
    );
    assert.match(
      native,
      /join\(moduleDirectory, 'native', 'qwen-live-harness-appshot\.node'\)/u,
    );
    assert.match(builder, /to: 'qwen-live-harness-host-icon\.png'/u);
    assert.match(
      main,
      /join\(process\.resourcesPath, 'qwen-live-harness-host-icon\.png'\)/u,
    );
  });

  it('uses one renamed bridge on each preload and renderer pair', () => {
    assert.match(
      read('../../preload/index.ts'),
      /exposeInMainWorld\('qwenLiveHarnessHost', api\)/u,
    );
    assert.match(
      read('../../renderer/main.ts'),
      /window\.qwenLiveHarnessHost/u,
    );
    assert.match(
      read('../../preload/subagents.ts'),
      /exposeInMainWorld\('qwenLiveHarnessSubagents', api\)/u,
    );
    assert.match(
      read('../../renderer/subagents-main.ts'),
      /window\.qwenLiveHarnessSubagents/u,
    );
  });
});
