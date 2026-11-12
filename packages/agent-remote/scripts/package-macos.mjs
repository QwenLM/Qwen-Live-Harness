import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin')
  throw new Error('Package the native app on macOS.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'macos/build/Agent Remote.app');
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
if (!existsSync(app) || !process.argv.includes('--skip-build'))
  run(process.execPath, [join(root, 'scripts/build-macos.mjs')]);
const version = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
).version;
const release = join(root, 'release');
mkdirSync(release, { recursive: true });
const staging = join(root, 'macos/build/installer');
rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, 'root/Applications'), { recursive: true });
cpSync(app, join(staging, 'root/Applications/Agent Remote.app'), {
  recursive: true,
  verbatimSymlinks: true,
});
const component = join(staging, 'components.plist');
run('/usr/bin/pkgbuild', [
  '--analyze',
  '--root',
  join(staging, 'root'),
  component,
]);
run('/usr/libexec/PlistBuddy', [
  '-c',
  'Set :0:BundleIsRelocatable false',
  component,
]);
run('/usr/libexec/PlistBuddy', [
  '-c',
  'Set :0:BundleIsVersionChecked false',
  component,
]);
const pkg = join(release, `Agent-Remote-${version}-universal.pkg`);
const signing = process.env['AGENT_REMOTE_INSTALLER_IDENTITY']
  ? ['--sign', process.env['AGENT_REMOTE_INSTALLER_IDENTITY']]
  : [];
run('/usr/bin/pkgbuild', [
  '--root',
  join(staging, 'root'),
  '--component-plist',
  component,
  '--identifier',
  'dev.agent-remote.desktop.installer',
  '--version',
  version,
  '--install-location',
  '/',
  ...signing,
  pkg,
]);
const disk = join(staging, 'disk');
mkdirSync(disk);
cpSync(app, join(disk, 'Agent Remote.app'), {
  recursive: true,
  verbatimSymlinks: true,
});
symlinkSync('/Applications', join(disk, 'Applications'));
cpSync(join(root, 'dist/LICENSE'), join(disk, 'LICENSE.txt'));
writeFileSync(
  join(disk, 'Read Me.txt'),
  'Agent Remote\n\nDrag Agent Remote.app to Applications, then open it. Choose your project folders and start the service. Your existing Qwen/Codex login is reused.\n\n将 Agent Remote.app 拖入 Applications，然后打开。选择项目目录并启动服务。已有 Qwen/Codex 登录和手机配对会沿用。\n\nService: starts after login and restarts after unexpected exits. Closing the window does not stop work. Service restart does not restore old tasks.\n服务会在登录后启动，并在异常退出后重新启动；关闭界面不停止任务。服务重启不会自动恢复旧任务。\n',
);
const dmg = join(release, `Agent-Remote-${version}-universal.dmg`);
if (existsSync(dmg)) rmSync(dmg);
run('/usr/bin/hdiutil', [
  'create',
  '-volname',
  'Agent Remote',
  '-srcfolder',
  disk,
  '-format',
  'UDZO',
  '-o',
  dmg,
]);
const checksums =
  [pkg, dmg]
    .map(
      (file) =>
        createHash('sha256').update(readFileSync(file)).digest('hex') +
        '  ' +
        file.split('/').at(-1),
    )
    .join('\n') + '\n';
writeFileSync(join(release, 'Agent-Remote-macOS-SHA256.txt'), checksums);
console.log(
  `Installable packages: ${pkg}\n${dmg}\nNo background jobs or user configuration are changed by the installer; first launch performs per-user setup.`,
);
