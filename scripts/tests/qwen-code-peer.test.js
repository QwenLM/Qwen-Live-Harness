import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { peerSourceDir, verifyPeerSources } from '../qwen-code-peer-source.mjs';
import { PeerEndpoint } from '../../packages/qwen-live-harness/src/vendor/qwen-code-peer/index.js';

const directories = [];
const endpoints = [];

afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporary() {
  const directory = mkdtempSync(path.join(tmpdir(), 'qlp-'));
  directories.push(directory);
  return directory;
}

describe('pinned Qwen peer SDK', () => {
  it('verifies exact upstream files offline and rejects changed source', async () => {
    const lock = await verifyPeerSources();
    expect(lock.commit).toBe('af4dece3a73a545d45e5a81948ac1374f9068ea1');
    const directory = temporary();
    cpSync(peerSourceDir, directory, { recursive: true });
    writeFileSync(path.join(directory, 'index.ts'), '// changed source\n');
    await expect(verifyPeerSources(directory)).rejects.toThrow(
      'Pinned Qwen peer source changed: index.ts',
    );
  });

  it('registers, discovers and cleans up real endpoints in an isolated Qwen home', async () => {
    const directory = temporary();
    const qwenHome = path.join(directory, 'home');
    const start = async (name, kind) => {
      const endpoint = await PeerEndpoint.start({
        name,
        kind,
        qwenHome,
        cwd: directory,
        socketPath: path.join(directory, `${name}.sock`),
        closeOnExit: false,
        keepAlive: false,
      });
      endpoints.push(endpoint);
      return endpoint;
    };
    const live = await start('live', 'live');
    const terminal = await start('terminal', 'interactive');
    const recordPath = terminal.recordPath;
    const ipcPath = terminal.ipcPath;
    expect(await live.list()).toEqual([
      expect.objectContaining({
        sessionId: terminal.sessionId,
        address: 'terminal',
        name: 'terminal',
        cwd: directory,
        kind: 'interactive',
      }),
    ]);
    // Discovery-only endpoints must not acknowledge incoming reports as handled.
    const sent = await terminal.send({ to: 'live', content: 'status report' });
    expect(sent.kind).toBe('sent');
    expect(
      await terminal.awaitReceipt(sent.msgId, { timeoutMs: 2_000 }),
    ).toEqual(expect.objectContaining({ status: 'refused' }));
    await terminal.close();
    expect(existsSync(recordPath)).toBe(false);
    expect(existsSync(ipcPath)).toBe(false);
    expect(await live.list()).toEqual([]);
  });
});
