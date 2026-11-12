import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  chmodSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin')
  throw new Error('Build the native application on macOS.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const native = join(root, 'macos');
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
run('/usr/bin/swift', [join(root, 'scripts/prepare-brand-assets.swift')]);
const manifest = JSON.parse(
  readFileSync(join(native, 'runtime-manifest.json'), 'utf8'),
);
const cache = join(native, 'runtime-cache');
mkdirSync(cache, { recursive: true });
for (const architecture of ['arm64', 'x64']) {
  const filename = `node-v${manifest.version}-darwin-${architecture}.tar.gz`;
  const archive = join(cache, filename);
  const valid = () =>
    existsSync(archive) &&
    createHash('sha256').update(readFileSync(archive)).digest('hex') ===
      manifest.sha256[architecture];
  if (!valid()) {
    run('/usr/bin/curl', [
      '--fail',
      '--location',
      '--silent',
      '--show-error',
      '--retry',
      '2',
      '--max-time',
      '180',
      '--output',
      archive + '.download',
      manifest.source + filename,
    ]);
    if (
      createHash('sha256')
        .update(readFileSync(archive + '.download'))
        .digest('hex') !== manifest.sha256[architecture]
    )
      throw new Error('Node runtime checksum mismatch: ' + architecture);
    run('/bin/mv', [archive + '.download', archive]);
  }
  const unpacked = join(
    cache,
    `node-v${manifest.version}-darwin-${architecture}`,
  );
  if (!existsSync(unpacked))
    run('/usr/bin/tar', ['-xzf', archive, '-C', cache]);
}
run(process.execPath, [join(root, 'scripts/build.mjs')]);
run('/usr/bin/swift', [
  'build',
  '--package-path',
  native,
  '--configuration',
  'release',
  '--arch',
  'arm64',
  '--arch',
  'x86_64',
]);
const bin = run(
  '/usr/bin/swift',
  [
    'build',
    '--package-path',
    native,
    '--configuration',
    'release',
    '--arch',
    'arm64',
    '--arch',
    'x86_64',
    '--show-bin-path',
  ],
  { encoding: 'utf8', stdio: 'pipe' },
).trim();
const build = join(native, 'build');
mkdirSync(build, { recursive: true });
const app = join(build, 'Agent Remote.app');
rmSync(app, { recursive: true, force: true });
const contents = join(app, 'Contents'),
  resources = join(contents, 'Resources');
mkdirSync(join(contents, 'MacOS'), { recursive: true });
mkdirSync(resources, { recursive: true });
cpSync(join(bin, 'AgentRemoteMac'), join(contents, 'MacOS/AgentRemoteMac'));
cpSync(join(native, 'Info.plist'), join(contents, 'Info.plist'));
cpSync(
  join(native, 'Resources/BrandMark.png'),
  join(resources, 'BrandMark.png'),
);
for (const language of ['en', 'zh-Hans'])
  cpSync(
    join(native, language + '.lproj'),
    join(resources, language + '.lproj'),
    { recursive: true },
  );
const gateway = join(resources, 'gateway');
mkdirSync(gateway);
cpSync(join(root, 'dist'), join(gateway, 'dist'), {
  recursive: true,
  verbatimSymlinks: true,
  filter: (path) => !/\.test\./u.test(path),
});
const packageJSON = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
);
cpSync(join(root, 'package.json'), join(gateway, 'package.json'));
cpSync(join(root, 'package-lock.json'), join(gateway, 'package-lock.json'));
run('npm', [
  'ci',
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--prefix',
  gateway,
]);
writeFileSync(
  join(gateway, 'package.json'),
  JSON.stringify(
    {
      name: packageJSON.name,
      version: packageJSON.version,
      type: 'module',
      license: packageJSON.license,
      dependencies: packageJSON.dependencies,
    },
    null,
    2,
  ),
);
const runtime = join(resources, 'runtime');
mkdirSync(join(runtime, 'bin'), { recursive: true });
mkdirSync(join(runtime, 'lib/node_modules'), { recursive: true });
writeFileSync(
  join(runtime, 'package.json'),
  JSON.stringify({ private: true, type: 'commonjs' }),
);
const distributions = ['arm64', 'x64'].map((architecture) =>
  join(cache, `node-v${manifest.version}-darwin-${architecture}`),
);
run('/usr/bin/lipo', [
  '-create',
  ...distributions.map((path) => join(path, 'bin/node')),
  '-output',
  join(runtime, 'bin/node'),
]);
cpSync(
  join(distributions[0], 'lib/node_modules/npm'),
  join(runtime, 'lib/node_modules/npm'),
  { recursive: true, verbatimSymlinks: true },
);
for (const [command, script] of [
  ['npm', 'npm-cli.js'],
  ['npx', 'npx-cli.js'],
]) {
  // Use a tiny JS launcher rather than absolute links into the build machine.
  const path = join(runtime, 'bin', command);
  writeFileSync(
    path,
    `#!/usr/bin/env node\nrequire('../lib/node_modules/npm/bin/${script}');\n`,
  );
  chmodSync(path, 0o755);
}
cpSync(join(distributions[0], 'LICENSE'), join(runtime, 'LICENSE'));
cpSync(join(root, 'dist/LICENSE'), join(resources, 'LICENSE'));
const iconset = join(build, 'AppIcon.iconset');
mkdirSync(iconset, { recursive: true });
const sourceIcon = join(native, 'Resources/AppIcon.png');
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2])
    run(
      '/usr/bin/sips',
      [
        '-z',
        String(size * scale),
        String(size * scale),
        sourceIcon,
        '--out',
        join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
      ],
      { stdio: 'ignore' },
    );
}
run('/usr/bin/iconutil', [
  '-c',
  'icns',
  iconset,
  '-o',
  join(resources, 'AppIcon.icns'),
]);
const identity = process.env['AGENT_REMOTE_SIGN_IDENTITY'] ?? '-';
const signing = [
  '--force',
  '--sign',
  identity,
  ...(identity === '-' ? [] : ['--options', 'runtime', '--timestamp']),
];
run('/usr/bin/codesign', [
  ...signing,
  '--identifier',
  'dev.agent-remote.node',
  '--entitlements',
  join(native, 'node.entitlements'),
  join(runtime, 'bin/node'),
]);
run('/usr/bin/codesign', [...signing, app]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
run(join(runtime, 'bin/node'), ['--version']);
run(join(runtime, 'bin/npm'), ['--version'], {
  env: { ...process.env, PATH: join(runtime, 'bin') + ':/usr/bin:/bin' },
});
writeFileSync(
  join(build, 'build-info.json'),
  JSON.stringify(
    {
      version: packageJSON.version,
      node: manifest.version,
      architectures: ['arm64', 'x86_64'],
      signed: identity !== '-',
      notarized: false,
      app,
    },
    null,
    2,
  ),
);
console.log('Native universal app built: ' + app);
