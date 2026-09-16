/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface ManagedQwenServeOptions {
  command: string;
  cwd?: string;
  /** Test seam; normal startup allows a cold CLI thirty seconds. */
  startupTimeoutMs?: number;
}

/** Owns only the service it launches; never discovers or kills other services. */
export class ManagedQwenServe {
  private child?: ChildProcess;
  private pending?: Promise<{ baseUrl: string; token: string }>;
  private stopping?: Promise<void>;
  private closed = false;

  constructor(private readonly options: ManagedQwenServeOptions) {}

  start(): Promise<{ baseUrl: string; token: string }> {
    if (this.closed)
      return Promise.reject(new Error('Managed Qwen Serve is closed.'));
    if (
      this.child &&
      (this.child.exitCode !== null || this.child.signalCode !== null)
    ) {
      return Promise.reject(
        new Error(
          'Managed Qwen Serve has exited. Restart Live to launch it again.',
        ),
      );
    }
    return (this.pending ??= this.launch().catch(async (error: unknown) => {
      await this.close();
      throw error;
    }));
  }

  private launch(): Promise<{ baseUrl: string; token: string }> {
    const token = randomBytes(32).toString('hex');
    const child = spawn(
      this.options.command,
      [
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        '0',
        ...(this.options.cwd ? ['--workspace', this.options.cwd] : []),
      ],
      {
        cwd: this.options.cwd,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          QWEN_SERVER_TOKEN: token,
          QWEN_CODE_NO_RELAUNCH: 'true',
        },
      },
    );
    this.child = child;
    // If the leader exits unexpectedly, promptly reap its remaining workers.
    // This also avoids retaining a process-group id for a later unrelated PID.
    child.once('exit', () => {
      void this.close().catch(() => undefined);
    });
    // Drain diagnostics without forwarding potentially sensitive provider output.
    child.stderr?.resume();
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = '';
      const finish = (error?: Error, baseUrl?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve({ baseUrl: baseUrl!, token });
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              'Managed Qwen Serve startup timed out. Check that the configured Qwen Code supports `qwen serve`.',
            ),
          ),
        this.options.startupTimeoutMs ?? 30_000,
      );
      child.on('error', () =>
        finish(
          new Error(
            'Unable to start managed Qwen Serve. Check the configured executable and workspace.',
          ),
        ),
      );
      child.on('exit', (code, signal) =>
        finish(
          new Error(
            `Managed Qwen Serve exited before becoming ready (${signal ?? code ?? 'unknown'}). Check the installed Qwen Code version and configuration.`,
          ),
        ),
      );
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (settled) return;
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          // This stdout contract is explicitly retained by qwen serve for scripts.
          const match =
            /^qwen serve listening on (http:\/\/127\.0\.0\.1:(\d+)) \(/.exec(
              line,
            );
          if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535) {
            finish(undefined, match[1]);
          }
        }
        // Never retain an unbounded or secret-containing startup transcript.
        if (buffer.length > 8192) buffer = '';
      });
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return (this.stopping ??= this.stopChild().catch((error: unknown) => {
      // A failed cleanup must remain retryable from the Host's Quit action.
      this.stopping = undefined;
      throw error;
    }));
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      // taskkill's tree flag includes workers spawned by the owned daemon.
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) =>
          execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () =>
            resolve(),
          ),
        );
      }
      return;
    }
    const signalGroup = async (
      signal: NodeJS.Signals | 0,
    ): Promise<boolean> => {
      try {
        process.kill(-child.pid!, signal);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return false;
        // Some hosts deny group signals/probes even after the group is gone.
        // EPERM alone is not evidence of exit: verify absence independently.
        if (code === 'EPERM' && !(await processGroupExists(child.pid!)))
          return false;
        throw error;
      }
    };
    if (!(await signalGroup('SIGTERM'))) return;
    // Workers can outlive the leader; check the owned group, not just exitCode.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (!(await signalGroup(0))) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    await signalGroup('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

/** Read process group identifiers only; never infer ownership from command text. */
async function processGroupExists(group: number): Promise<boolean> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-A', '-o', 'pgid='],
      {
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              'Could not verify managed Qwen Serve process cleanup. Retry Quit.',
            ),
          );
        else resolve(stdout);
      },
    );
  });
  const groups = output.trim().split(/\s+/u);
  if (!groups.length || groups.some((value) => !/^\d+$/u.test(value)))
    throw new Error(
      'Could not verify managed Qwen Serve process cleanup. Retry Quit.',
    );
  return groups.some((value) => Number(value) === group);
}
