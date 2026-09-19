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
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import {
  peerSourceDir,
  verifyPeerSources,
} from '../../scripts/qwen-code-peer-source.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
await verifyPeerSources();
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
// HTTP client and the pinned, Node-only peer sources here; a Live installation
// must not install that CLI.
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
for (const [input, metadata] of Object.entries(bundled.metafile.inputs)) {
  if (/[/\\]dist[/\\]cli[/\\]/u.test(input)) {
    throw new Error(`Live build included a backend CLI: ${input}`);
  }
  // Only our owned-service launcher may spawn. Keep the SDK HTTP-only.
  if (
    metadata.imports.some((entry) =>
      /^(?:node:)?child_process$/u.test(entry.path),
    ) &&
    input.replaceAll('\\', '/') !== 'src/adaptor/managed-qwen-serve.ts'
  ) {
    throw new Error(`Unexpected process launcher in Qwen adaptor: ${input}`);
  }
}
for (const output of Object.values(bundled.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!isBuiltin(dependency.path)) {
      throw new Error(
        `Unexpected Qwen adaptor runtime dependency: ${dependency.path}`,
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
const peerNotices = path.join(notices, 'qwen-code-peer');
mkdirSync(peerNotices, { recursive: true });
for (const name of ['LICENSE', 'upstream.json', 'README.md']) {
  cpSync(path.join(peerSourceDir, name), path.join(peerNotices, name));
}

for (const required of ['index.js', 'daemon.js']) {
  const emitted = path.join(here, 'dist', required);
  if (!existsSync(emitted)) {
    throw new Error(
      `build produced no dist/${required} — tsc emitted nothing (stale tsconfig.build.tsbuildinfo?)`,
    );
  }
}

// Identify the code actually built, including uncommitted development fixes.
// Hash source contents; never include config, environment or source text itself.
const sourceHash = createHash('sha256');
const hashSources = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) hashSources(filename);
    else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      sourceHash.update(path.relative(here, filename).replaceAll('\\', '/'));
      sourceHash.update('\0');
      sourceHash.update(readFileSync(filename));
      sourceHash.update('\0');
    }
  }
};
hashSources(path.join(here, 'src'));
writeFileSync(
  path.join(here, 'dist', 'build-info.json'),
  JSON.stringify(
    {
      version: JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'))
        .version,
      builtAt: new Date().toISOString(),
      sourceSha256: sourceHash.digest('hex'),
    },
    null,
    2,
  ) + '\n',
);
