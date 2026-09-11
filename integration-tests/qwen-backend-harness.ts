/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DaemonClient } from '@qwen-code/sdk';

export { sleep };

export function qwenCliPath(): string {
  const cli = process.env['TEST_CLI_PATH'];
  if (!cli || !isAbsolute(cli) || !existsSync(cli)) {
    throw new Error(
      'Backend compatibility tests require TEST_CLI_PATH=/absolute/path/to/a/built/qwen/cli.js. Qwen Code source is not part of this repository.',
    );
  }
  return cli;
}

export interface SpawnedDaemon {
  client: DaemonClient;
  daemon: ChildProcess;
  port: number;
  base: string;
  workspaceCwd: string;
  token: string;
  stdoutBuf: { value: string };
  stderrBuf: { value: string };
  dispose(): Promise<void>;
}

export async function spawnDaemon(opts: {
  workspaceCwd: string;
  token: string;
  bootTimeoutMs?: number;
  env?: Record<string, string>;
}): Promise<SpawnedDaemon> {
  const daemon = spawn(
    process.execPath,
    [
      qwenCliPath(),
      'serve',
      '--port',
      '0',
      '--token',
      opts.token,
      '--hostname',
      '127.0.0.1',
      '--workspace',
      opts.workspaceCwd,
      '--initialize-timeout-ms',
      '60000',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env['PATH'],
        SystemRoot: process.env['SystemRoot'],
        ...opts.env,
      },
    },
  );
  const stdoutBuf = { value: '' };
  const stderrBuf = { value: '' };
  daemon.stdout!.on('data', (chunk: Buffer) => {
    stdoutBuf.value += chunk.toString();
  });
  daemon.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf.value += chunk.toString();
  });
  const dispose = async () => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        daemon.kill('SIGKILL');
      }, 5_000);
      daemon.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      daemon.kill('SIGTERM');
    });
  };
  let port: number;
  try {
    port = await new Promise<number>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        daemon.stdout!.off('data', onData);
        daemon.off('exit', onExit);
        daemon.off('error', onError);
      };
      const onData = () => {
        const match = stdoutBuf.value.match(
          /listening on http:\/\/127\.0\.0\.1:(\d+)/,
        );
        if (match) {
          cleanup();
          resolve(Number(match[1]));
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null) =>
        onError(new Error(`qwen serve exited (${code}): ${stderrBuf.value}`));
      const timer = setTimeout(
        () => onError(new Error(`qwen serve boot timeout: ${stderrBuf.value}`)),
        opts.bootTimeoutMs ?? 30_000,
      );
      daemon.stdout!.on('data', onData);
      daemon.once('exit', onExit);
      daemon.once('error', onError);
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  const base = `http://127.0.0.1:${port}`;
  return {
    client: new DaemonClient({ baseUrl: base, token: opts.token }),
    daemon,
    port,
    base,
    workspaceCwd: opts.workspaceCwd,
    token: opts.token,
    stdoutBuf,
    stderrBuf,
    dispose,
  };
}
