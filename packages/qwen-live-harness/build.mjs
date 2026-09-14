/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Build script for qwen-live-harness.
 *
 * Cleans dist plus the incremental build info together (removing dist alone
 * leaves tsc's buildinfo claiming everything is up to date, so `tsc --build`
 * would emit nothing), compiles TypeScript, and sanity-checks the emit.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
cpSync(path.join(here, '../../LICENSE'), path.join(here, 'LICENSE'));

rmSync(path.join(here, 'dist'), { recursive: true, force: true });
rmSync(path.join(here, 'tsconfig.build.tsbuildinfo'), { force: true });

// Resolve tsc through node rather than `npx` so this also works on Windows,
// where execFileSync cannot resolve `npx.cmd` without a shell.
execFileSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '--build', 'tsconfig.build.json'],
  { cwd: here, stdio: 'inherit' },
);

// The SDK npm package bundles a CLI for its query() API. Only embed its
// HTTP client here; a Live installation must not install that CLI.
const bundled = await build({
  absWorkingDir: here,
  entryPoints: ['src/adaptor/qwen-code-adaptor.ts'],
  outfile: 'dist/adaptor/qwen-code-adaptor.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  metafile: true,
  legalComments: 'eof',
});
for (const input of Object.keys(bundled.metafile.inputs)) {
  if (/[/\\]dist[/\\]cli[/\\]/u.test(input)) {
    throw new Error(`Live build included a backend CLI: ${input}`);
  }
}
for (const output of Object.values(bundled.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!isBuiltin(dependency.path) || /child_process/u.test(dependency.path)) {
      throw new Error(
        `Unexpected HTTP adaptor runtime dependency: ${dependency.path}`,
      );
    }
  }
}
const notices = path.join(here, 'dist/vendor');
mkdirSync(notices, { recursive: true });
cpSync(
  path.join(
    path.dirname(require.resolve('@qwen-code/sdk/package.json')),
    'dist/LICENSE',
  ),
  path.join(notices, 'qwen-code-sdk-LICENSE'),
);

for (const required of ['index.js', 'daemon.js']) {
  const emitted = path.join(here, 'dist', required);
  if (!existsSync(emitted)) {
    throw new Error(
      `build produced no dist/${required} — tsc emitted nothing (stale tsconfig.build.tsbuildinfo?)`,
    );
  }
}
