import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import {
  hostProcessBoundary,
  rendererProcessBoundary,
} from '../../../scripts/process-boundary.mjs';

const STARTUP = fileURLToPath(
  new URL('../../../../qwen-live-harness/src/startup.ts', import.meta.url),
);
const WORKFLOW = new URL(
  '../../../../../.github/workflows/qwen-live-harness-host.yml',
  import.meta.url,
);

async function temporary(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'host-process-guard-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function bundle(entryPoint: string, allowDaemonStartup = false) {
  return esbuild({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    plugins: [hostProcessBoundary({ allowDaemonStartup })],
  });
}

const UNSAFE_SOURCES = [
  "export { spawn } from 'node:child_process';",
  "export { execFile } from 'child_process';",
  "export const api = require('node:child_process');",
  "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); export const api = require('node:child_process');",
  "export const api = process.getBuiltinModule('child_process');",
];

describe('Host process module boundary', () => {
  it('bundles the actual registered daemon launcher only for main', async () => {
    const result = await bundle(STARTUP, true);
    assert.match(result.outputFiles[0]!.text, /node:child_process/);
    await assert.rejects(
      bundle(STARTUP),
      /Process module reference is not allowed/,
    );
  });

  for (const [index, source] of UNSAFE_SOURCES.entries()) {
    it(`rejects process loading outside the approved module, including a dependency (${index})`, async () => {
      await temporary(async (directory) => {
        // A lookalike basename must not inherit the real launcher's exception.
        const dependency = path.join(directory, 'startup.ts');
        const entry = path.join(directory, 'main.ts');
        await writeFile(dependency, source);
        await writeFile(entry, "export * from './startup.ts';");
        await assert.rejects(
          bundle(entry, true),
          /Process module reference is not allowed/,
        );
        await assert.rejects(
          bundle(entry),
          /Process module reference is not allowed/,
        );
      });
    });
  }

  for (const [index, source] of [
    UNSAFE_SOURCES[0]!,
    UNSAFE_SOURCES[1]!,
    UNSAFE_SOURCES[3]!,
    UNSAFE_SOURCES[4]!,
  ].entries()) {
    it(`rejects process loading in the real Vite renderer pipeline (${index})`, async () => {
      await temporary(async (directory) => {
        const entry = path.join(directory, 'renderer.js');
        await writeFile(entry, source);
        await assert.rejects(
          viteBuild({
            configFile: false,
            root: directory,
            logLevel: 'silent',
            plugins: [rendererProcessBoundary()],
            build: { write: false, rollupOptions: { input: entry } },
          }),
          /Process module references are not allowed/,
        );
      });
    });
  }

  it('still rejects process imports through a virtual entry point', async () => {
    await assert.rejects(
      esbuild({
        stdin: { contents: "export { spawn } from 'child_process';" },
        bundle: true,
        write: false,
        platform: 'node',
        logLevel: 'silent',
        plugins: [hostProcessBoundary({ allowDaemonStartup: true })],
      }),
      /Process module child_process is not allowed/,
    );
  });
});

describe('exact packaged Host content guard', () => {
  it('allows the main launcher while rejecting process APIs elsewhere and every retired feature', async () => {
    const workflow = await readFile(WORKFLOW, 'utf8');
    const start = workflow.indexOf('          test -d "$extracted_asar/dist"');
    const end = workflow.indexOf('          info_plist=', start);
    assert(
      start >= 0 && end > start,
      'The exact workflow content guard must be present',
    );
    const script = workflow.slice(start, end);
    await temporary(async (directory) => {
      const extracted = path.join(directory, 'extracted app');
      const dist = path.join(extracted, 'dist');
      await mkdir(path.join(dist, 'renderer'), { recursive: true });
      const main = path.join(dist, 'main.cjs');
      const check = () =>
        spawnSync('bash', ['-c', `set -euo pipefail\n${script}`], {
          env: { ...process.env, extracted_asar: extracted },
          encoding: 'utf8',
        });
      await writeFile(main, 'require("node:child_process");');
      assert.equal(check().status, 0);
      for (const file of [
        'preload.cjs',
        'subagents-preload.cjs',
        'renderer/main.cjs',
      ]) {
        for (const name of ['node:child_process', 'child_process']) {
          const target = path.join(dist, file);
          await writeFile(target, `require(${JSON.stringify(name)});`);
          const result = check();
          assert.equal(result.status, 1, result.stderr);
          assert.match(
            result.stdout,
            /Packaged process API outside the main bundle/,
          );
          await rm(target);
        }
      }
      for (const name of [
        'openWebShellWindow',
        'web-shell-security',
        'host.open_session',
        'inputMonitoring',
        'installUrl',
        'loadURL(',
        '@modelcontextprotocol',
      ]) {
        await writeFile(main, name);
        const result = check();
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stdout, /Packaged app contains a forbidden/);
      }
    });
  });
});
