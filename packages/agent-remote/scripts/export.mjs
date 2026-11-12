import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], {
  stdio: 'inherit',
  cwd: root,
});
const output = join(root, 'release/agent-remote-source');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const name of [
  'src',
  'scripts',
  'ios',
  'macos',
  'branding',
  'test-fixtures',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'vitest.config.ts',
  '.gitignore',
  '.prettierignore',
  'AGENTS.md',
  'README.md',
  'README_ZH.md',
]) {
  if (!existsSync(join(root, name))) continue;
  cpSync(join(root, name), join(output, name), {
    recursive: true,
    filter: (source) =>
      !/(?:^|[/\\])(?:node_modules|\.build|\.swiftpm|runtime-cache|build|build-device|Fixtures|[^/\\]+\.xcodeproj)(?:[/\\]|$)/u.test(
        source,
      ),
  });
}
// Generated distribution copy, never a second maintained repository license.
writeFileSync(
  join(output, 'LICENSE'),
  readFileSync(join(root, 'dist/LICENSE')),
);
const archive = join(root, 'release/agent-remote-source.tar.gz');
execFileSync('tar', [
  '-czf',
  archive,
  '-C',
  join(root, 'release'),
  'agent-remote-source',
]);
console.log(
  `Standalone source project: ${output}\nSource archive: ${archive}\nCopy or extract anywhere, then run npm ci && npm run build.`,
);
