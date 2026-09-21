const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const { extractFile, listPackage } = require('@electron/asar');

const UNUSED_PERMISSION_KEYS = [
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
];

/** Read-only validation of the actual app, reusable by CI after packaging. */
function assertPackagedContents(
  appPath,
  licensePath = path.resolve(__dirname, '..', '..', '..', 'LICENSE'),
) {
  const resources = path.join(appPath, 'Contents', 'Resources');
  const archive = path.join(resources, 'app.asar');
  const entries = listPackage(archive).map((name) => name.replace(/^\//u, ''));
  const unwanted = entries.filter(
    (name) =>
      /(?:\.(?:map|bak|backup|old|orig|tmp|temp|log|tsbuildinfo|swp|swo)|~)$/iu.test(
        name,
      ) ||
      /(?:\.test\.|\.spec\.|(?:^|\/)(?:__tests__|tests?|testing|test-fixtures|coverage)(?:\/|$)|^(?:src|scripts|debug|logs?)\/)/iu.test(
        name,
      ) ||
      /^dist\/renderer\/(?:icon\.[^/]+|localizations(?:\/|$))/iu.test(name),
  );
  assert.deepEqual(unwanted, [], 'Unwanted files in the packaged Host');
  const license = extractFile(archive, 'dist/LICENSE');
  assert.deepEqual(
    license,
    readFileSync(licensePath),
    'Packaged Host license must exactly match the root LICENSE',
  );
  const worklet = extractFile(archive, 'dist/renderer/audio-input-worklet.js');
  assert.deepEqual(
    worklet,
    readFileSync(
      path.resolve(__dirname, '../resources/audio-input-worklet.js'),
    ),
    'Packaged audio worklet is missing or differs from its source',
  );
  const native = path.join(
    resources,
    'native',
    'qwen-live-harness-appshot.node',
  );
  assert(
    statSync(native).isFile() && statSync(native).size > 0,
    'Packaged Appshot native module is missing',
  );
  for (const locale of ['en', 'zh-Hans']) {
    const relative = `${locale}.lproj/InfoPlist.strings`;
    assert.deepEqual(
      readFileSync(path.join(resources, relative)),
      readFileSync(
        path.resolve(__dirname, '../resources/localizations', relative),
      ),
      `Packaged ${locale} permission localization differs from source`,
    );
  }
  return {
    entries: entries.length,
    licenseBytes: license.length,
    workletBytes: worklet.length,
  };
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productName}.app`;
  assertPackagedContents(path.join(context.appOutDir, appName));
  const infoPlist = path.join(
    context.appOutDir,
    appName,
    'Contents',
    'Info.plist',
  );

  for (const key of UNUSED_PERMISSION_KEYS) {
    const result = spawnSync('/usr/libexec/PlistBuddy', [
      '-c',
      `Delete :${key}`,
      infoPlist,
    ]);
    if (
      result.status !== 0 &&
      !result.stderr.toString().includes('Does Not Exist')
    ) {
      throw new Error(`Failed to remove unused permission declaration ${key}`);
    }
  }
};

module.exports.assertPackagedContents = assertPackagedContents;
