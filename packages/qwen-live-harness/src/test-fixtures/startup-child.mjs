/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// A disposable fake CLI exercises spawning without model, backend or device access.
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const dataDir = process.env['QWEN_LIVE_HARNESS_DATA_DIR'];
const discoveryPath = join(
  process.env['QWEN_LIVE_HARNESS_DISCOVERY_DIR'],
  'run',
  'daemon.json',
);
writeFileSync(
  join(dataDir, 'child-result.json'),
  JSON.stringify({
    pid: process.pid,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    path: process.env['PATH'],
    nodeOptions: process.env['NODE_OPTIONS'],
    electron: process.env['ELECTRON_RUN_AS_NODE'],
    dataDir,
  }),
  { mode: 0o600 },
);
const behavior = process.env['QWEN_STARTUP_TEST_BEHAVIOR'];
if (behavior === 'stubborn-grandchild' || behavior === 'exit-with-grandchild') {
  const grandchild = spawn(
    process.execPath,
    [
      '-e',
      `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    fs.writeFileSync(process.argv[1], JSON.stringify({pid: process.pid}), {mode:0o600});
    process.send('ready');
    setInterval(() => {}, 10000);
  `,
      join(dataDir, 'grandchild-result.json'),
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  grandchild.once('message', () => {
    if (behavior === 'exit-with-grandchild') process.exit(2);
  });
}
if (behavior === 'exit-zero') process.exit(0);
if (behavior === 'exit-error') {
  process.stderr.write('fixture startup failed\n');
  process.exit(2);
}
if (
  behavior === 'hang' ||
  behavior === 'stubborn-grandchild' ||
  behavior === 'exit-with-grandchild'
) {
  setInterval(() => {}, 10_000);
} else {
  const instanceNonce = 'fixture_nonce_0000001';
  const token = 'fixture-token';
  const server = createServer((req, res) => {
    if (
      req.url !== '/live/instance' ||
      req.headers['authorization'] !== `Bearer ${token}` ||
      req.headers['x-qwen-live-harness-nonce'] !== instanceNonce
    ) {
      res.writeHead(401).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        pid: process.pid,
        instanceNonce,
        protocolVersion: 9,
        version: '0.3.0',
      }),
    );
  });
  server.listen(0, '127.0.0.1', () => {
    writeFileSync(
      discoveryPath,
      JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}`,
        token,
        instanceNonce,
        protocolVersion: 9,
        pid: process.pid,
      }),
      { mode: 0o600 },
    );
    if (behavior === 'noisy') {
      process.stdout.write('x'.repeat(3 * 1024 * 1024), () => {
        writeFileSync(join(dataDir, 'log-complete'), 'yes');
      });
    }
  });
  process.on('SIGTERM', () => {
    try {
      if (JSON.parse(readFileSync(discoveryPath, 'utf8')).pid === process.pid)
        unlinkSync(discoveryPath);
    } catch {
      /* Already removed by the test. */
    }
    server.close(() => process.exit(0));
  });
}
