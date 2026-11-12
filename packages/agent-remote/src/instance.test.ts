import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimInstance } from './instance.js';
import { startGateway } from './mobile/index.js';

const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    ),
);
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'remote-instance-'));
  directories.push(path);
  return path;
}

it('prevents a second gateway from sharing live credentials and releases only its own lock', async () => {
  const path = directory();
  const release = await claimInstance(path, 0);
  await expect(claimInstance(path, 0)).rejects.toThrow('already owns');
  release();
  const next = await claimInstance(path, 0);
  release();
  await expect(claimInstance(path, 0)).rejects.toThrow('already owns');
  next();
});

it('does not reset a phone token or renew certificates if the old service still occupies the port', async () => {
  const path = directory();
  writeFileSync(join(path, 'device-token'), 'existing phone');
  writeFileSync(join(path, 'server-cert.pem'), 'existing certificate');
  const old = createServer();
  await new Promise<void>((resolve) => old.listen(0, '0.0.0.0', resolve));
  const address = old.address();
  if (!address || typeof address === 'string')
    throw new Error('test listener missing');
  try {
    await expect(
      startGateway({
        projects: [path],
        directory: path,
        port: address.port,
        reset: true,
        ask: false,
        open: false,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(readFileSync(join(path, 'device-token'), 'utf8')).toBe(
      'existing phone',
    );
    expect(readFileSync(join(path, 'server-cert.pem'), 'utf8')).toBe(
      'existing certificate',
    );
  } finally {
    await new Promise<void>((resolve) => old.close(() => resolve()));
  }
});
