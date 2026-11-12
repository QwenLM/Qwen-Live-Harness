import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'release'), { recursive: true });
execFileSync('npm', ['pack', '--pack-destination', join(root, 'release')], {
  cwd: root,
  stdio: 'inherit',
});
