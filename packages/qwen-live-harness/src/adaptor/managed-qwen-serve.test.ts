/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QwenCodeAdaptor } from './qwen-code-adaptor.js';
import type { DaemonClientLike } from './qwen-code-adaptor.js';
import { ManagedQwenServe } from './managed-qwen-serve.js';

const roots: string[] = [];
const services: ManagedQwenServe[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(source: string, timeout = 3000) {
  const cwd = await mkdtemp(join(tmpdir(), 'live-managed-serve-'));
  roots.push(cwd);
  const command = join(cwd, 'qwen');
  await writeFile(command, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  const service = new ManagedQwenServe({
    command,
    cwd,
    startupTimeoutMs: timeout,
  });
  services.push(service);
  return { service, cwd };
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === 'win32')(
  'managed Qwen Serve process ownership',
  () => {
    it('uses a random token, ephemeral loopback port and workspace, then stops its child', async () => {
      const { service, cwd } = await fixture(`
const fs = require('node:fs');
const server = require('node:http').createServer((req,res) => res.end('ok'));
fs.writeFileSync('observed.json', JSON.stringify({ args: process.argv.slice(2), token: process.env.QWEN_SERVER_TOKEN, pid: process.pid, noRelaunch: process.env.QWEN_CODE_NO_RELAUNCH }));
server.listen(0, '127.0.0.1', () => {
 process.stdout.write('qwen serve listening on http://127.0.0.1:');
 setTimeout(() => console.log(server.address().port + ' (mode=test, workspace=test)'), 20);
});`);
      const endpoint = await service.start();
      const observed = JSON.parse(
        await readFile(join(cwd, 'observed.json'), 'utf8'),
      );
      expect(observed.args).toEqual([
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        '0',
        '--workspace',
        cwd,
      ]);
      expect(endpoint.token).toMatch(/^[a-f0-9]{64}$/);
      expect(endpoint.token).toBe(observed.token);
      expect(observed.noRelaunch).toBe('true');
      expect(await (await fetch(endpoint.baseUrl)).text()).toBe('ok');
      expect(await service.start()).toEqual(endpoint);
      await service.close();
      expect(alive(observed.pid)).toBe(false);
      await expect(service.start()).rejects.toThrow('closed');
    });

    it('reports early exit without leaking stdout or stderr', async () => {
      const { service } = await fixture(
        `console.error('private-secret'); console.log('private-secret'); process.exit(9);`,
      );
      await expect(service.start()).rejects.toThrow(
        'exited before becoming ready (9)',
      );
    });

    it('times out and kills the owned process and workers', async () => {
      const { service, cwd } = await fixture(
        `
const fs = require('node:fs');
const worker = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {stdio:'ignore'});
fs.writeFileSync('pids.json', JSON.stringify([process.pid, worker.pid]));
process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);`,
        500,
      );
      await expect(service.start()).rejects.toThrow('startup timed out');
      const pids = JSON.parse(
        await readFile(join(cwd, 'pids.json'), 'utf8'),
      ) as number[];
      // Reaping by the OS can follow group termination asynchronously.
      for (let i = 0; i < 30 && pids.some(alive); i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(pids.map(alive)).toEqual([false, false]);
    });

    it('fails a missing executable with a safe actionable message', async () => {
      const service = new ManagedQwenServe({
        command: '/missing/private-secret/qwen',
      });
      services.push(service);
      await expect(service.start()).rejects.toThrow(
        'Check the configured executable',
      );
    });

    it('cancels startup when closed before readiness', async () => {
      const { service } = await fixture('setInterval(()=>{},1000);');
      const pending = service.start();
      const rejected = expect(pending).rejects.toThrow(
        'exited before becoming ready',
      );
      await service.close();
      await rejected;
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'managed adaptor integration',
  () => {
    it.each([true, false])(
      'authenticates its capability check and cleans up (compatible=%s)',
      async (compatible) => {
        const { cwd } = await fixture(`
const fs = require('node:fs');
fs.writeFileSync('pid', String(process.pid));
const server = require('node:http').createServer((req,res) => {
 if (req.headers.authorization !== 'Bearer ' + process.env.QWEN_SERVER_TOKEN) { res.writeHead(401); return res.end('{}'); }
 fs.writeFileSync('authenticated', 'yes');
 res.setHeader('content-type','application/json');
 res.end(JSON.stringify({features: ${JSON.stringify(compatible ? ['session_create', 'session_prompt', 'session_events', 'session_cancel', 'session_permission_vote', 'session_mid_turn_message_mutation'] : [])}}));
});
server.listen(0, '127.0.0.1', () => console.log('qwen serve listening on http://127.0.0.1:' + server.address().port + ' (mode=test)'));`);
        const adaptor = new QwenCodeAdaptor({
          baseUrl: 'http://127.0.0.1:1',
          managedServe: { command: join(cwd, 'qwen') },
          defaultCwd: cwd,
        });
        try {
          if (compatible) await adaptor.preflight();
          else
            await expect(adaptor.preflight()).rejects.toThrow(
              'missing required capabilities',
            );
          expect(await readFile(join(cwd, 'authenticated'), 'utf8')).toBe(
            'yes',
          );
          if (!compatible)
            expect(
              alive(Number(await readFile(join(cwd, 'pid'), 'utf8'))),
            ).toBe(false);
        } finally {
          await adaptor.close();
        }
        expect(alive(Number(await readFile(join(cwd, 'pid'), 'utf8')))).toBe(
          false,
        );
      },
    );

    it('does not complete preflight after close interrupts startup', async () => {
      const { cwd } = await fixture(`
require('node:fs').writeFileSync('pid', String(process.pid));
setInterval(()=>{}, 1000);`);
      const adaptor = new QwenCodeAdaptor({
        baseUrl: 'http://127.0.0.1:1',
        managedServe: { command: join(cwd, 'qwen') },
        defaultCwd: cwd,
      });
      const pending = adaptor.preflight();
      const rejected = expect(pending).rejects.toThrow('before becoming ready');
      for (let i = 0; i < 100; i++) {
        try {
          await readFile(join(cwd, 'pid'));
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      await adaptor.close();
      await rejected;
      expect(alive(Number(await readFile(join(cwd, 'pid'), 'utf8')))).toBe(
        false,
      );
      await expect(adaptor.preflight()).rejects.toThrow('closed');
    });

    it('leaves an external service running after close', async () => {
      const { createServer } = await import('node:http');
      const server = createServer((_req, res) => res.end('still running'));
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const client = {
        capabilities: async () => ({
          features: [
            'session_create',
            'session_prompt',
            'session_events',
            'session_cancel',
            'session_permission_vote',
            'session_mid_turn_message_mutation',
          ],
        }),
      } as unknown as DaemonClientLike;
      const adaptor = new QwenCodeAdaptor({ baseUrl, client });
      try {
        await adaptor.preflight();
        await adaptor.close();
        expect(await (await fetch(baseUrl)).text()).toBe('still running');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  },
);
