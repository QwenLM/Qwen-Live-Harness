/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const peerSourceDir = fileURLToPath(
  new URL(
    '../packages/qwen-live-harness/src/vendor/qwen-code-peer/',
    import.meta.url,
  ),
);

async function readLock(directory) {
  const lock = JSON.parse(
    await readFile(path.join(directory, 'upstream.json'), 'utf8'),
  );
  assert.equal(lock.repository, 'https://github.com/QwenLM/qwen-code');
  assert.match(lock.commit, /^[a-f0-9]{40}$/u);
  assert.equal(lock.license, 'Apache-2.0');
  assert(lock.files['LICENSE'] && lock.files['index.ts']);
  for (const [name, file] of Object.entries(lock.files)) {
    assert.match(name, /^(?:[a-z-]+\.ts|LICENSE)$/u);
    assert.equal(
      file.source,
      name === 'LICENSE' ? name : `packages/sdk-typescript/src/peer/${name}`,
    );
    assert.match(file.sha256, /^[a-f0-9]{64}$/u);
  }
  return lock;
}

function verifyContents(name, bytes, expected) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  assert.equal(actual, expected, `Pinned Qwen peer source changed: ${name}`);
}

/** Offline verification used by every build. */
export async function verifyPeerSources(directory = peerSourceDir) {
  const lock = await readLock(directory);
  const sources = (await readdir(directory)).filter((name) =>
    name.endsWith('.ts'),
  );
  assert.deepEqual(
    sources.sort(),
    Object.keys(lock.files)
      .filter((name) => name.endsWith('.ts'))
      .sort(),
    'The vendored peer file set must match its upstream lock',
  );
  await Promise.all(
    Object.entries(lock.files).map(async ([name, file]) => {
      const bytes = await readFile(path.join(directory, name));
      verifyContents(name, bytes, file.sha256);
    }),
  );
  return lock;
}

/** Explicit maintainer command: reproduce the locked source from GitHub. */
export async function restorePeerSources(directory = peerSourceDir) {
  const lock = await readLock(directory);
  // Fetch and validate everything before replacing any checked-in file.
  const sources = await Promise.all(
    Object.entries(lock.files).map(async ([name, file]) => {
      const url = `https://raw.githubusercontent.com/QwenLM/qwen-code/${lock.commit}/${file.source}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
      assert(response.ok, `Could not fetch ${name}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      verifyContents(name, bytes, file.sha256);
      return { name, bytes };
    }),
  );
  for (const { name, bytes } of sources) {
    await writeFile(path.join(directory, name), bytes);
  }
  return verifyPeerSources(directory);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const command = process.argv[2] ?? '--verify';
  assert(
    ['--verify', '--restore'].includes(command),
    'Use --verify or --restore',
  );
  const lock = await (command === '--restore'
    ? restorePeerSources()
    : verifyPeerSources());
  console.log(
    `Qwen peer sources verified at ${lock.commit} (${Object.keys(lock.files).length} files).`,
  );
}
