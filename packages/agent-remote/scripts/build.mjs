import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// The repository LICENSE is the only maintained source. Exported projects
// carry a generated copy; a built directory can also be moved on its own.
const licensePath = [
  join(root, 'LICENSE'),
  join(root, '../../LICENSE'),
  join(root, 'dist/LICENSE'),
].find(existsSync);
if (!licensePath)
  throw new Error(
    'Project LICENSE missing. Use npm run export before moving an unbuilt source checkout.',
  );
const license = readFileSync(licensePath);
rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/LICENSE'), license);
execFileSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '--project', 'tsconfig.build.json'],
  { cwd: root, stdio: 'inherit' },
);
chmodSync(join(root, 'dist/cli.js'), 0o755);
// Keep dependency notices available in the distributable alongside ours.
mkdirSync(join(root, 'dist/notices'), { recursive: true });
for (const [dependency, name] of [
  ['@agentclientprotocol/sdk', 'LICENSE'],
  ['qrcode', 'license'],
]) {
  const directory = dirname(require.resolve(`${dependency}/package.json`));
  cpSync(
    join(directory, name),
    join(root, 'dist/notices', dependency.replaceAll('/', '-') + '-LICENSE'),
  );
}
