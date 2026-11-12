import { afterEach, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import {
  mkdtemp,
  rm,
  readdir,
  readFile,
  writeFile,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureMobileTLS } from './tls.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'mobile-tls-test-'));
  directories.push(path);
  return path;
}

it('issues iOS-compatible server certificates and preserves the paired identity on subsequent starts', async () => {
  const path = await directory();
  const first = await ensureMobileTLS(path, ['192.168.1.2'], ['fixture.local']);
  const certificate = new X509Certificate(first.cert);
  expect(certificate.ca).toBe(false);
  expect(certificate.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
  expect(certificate.checkIP('192.168.1.2')).toBe('192.168.1.2');
  expect(certificate.checkIP('127.0.0.1')).toBe('127.0.0.1');
  expect(certificate.checkHost('fixture.local')).toBe('fixture.local');
  expect((await stat(join(path, 'server-key.pem'))).mode & 0o777).toBe(0o600);
  const second = await ensureMobileTLS(
    path,
    ['192.168.1.2'],
    ['fixture.local'],
  );
  expect(second.renewed).toBe(false);
  expect(second.pin).toBe(first.pin);
});

it('keeps the pinned identity across Wi-Fi changes when the stable DNS name remains valid', async () => {
  const path = await directory();
  const first = await ensureMobileTLS(path, ['192.0.2.1'], ['fixture.local']);
  const changed = await ensureMobileTLS(path, ['192.0.2.2'], ['fixture.local']);
  expect(changed.renewed).toBe(false);
  expect(changed.pin).toBe(first.pin);
  expect(
    new X509Certificate(changed.cert).checkIP('192.0.2.2'),
  ).toBeUndefined();
  const renamed = await ensureMobileTLS(path, ['192.0.2.2'], ['renamed.local']);
  expect(renamed.renewed).toBe(true);
  expect(renamed.pin).not.toBe(first.pin);
});

it('renews IP-only certificates when their address changes', async () => {
  const path = await directory();
  const first = await ensureMobileTLS(path, ['192.0.2.1']);
  const changed = await ensureMobileTLS(path, ['192.0.2.2']);
  expect(changed.renewed).toBe(true);
  expect(changed.pin).not.toBe(first.pin);
});

it('preserves obsolete TLS material before replacing it and refuses malformed SAN inputs', async () => {
  const path = await directory();
  await writeFile(join(path, 'server-key.pem'), 'previous key');
  await writeFile(join(path, 'server-cert.pem'), 'previous certificate');
  const result = await ensureMobileTLS(path, ['127.0.0.1']);
  expect(result.renewed).toBe(true);
  const backup = (await readdir(path)).find((name) =>
    name.startsWith('server-key.pem.previous-'),
  )!;
  expect(await readFile(join(path, backup), 'utf8')).toBe('previous key');
  await expect(
    ensureMobileTLS(path, ['127.0.0.1\nDNS.9 = attacker.invalid']),
  ).rejects.toThrow('Invalid mobile TLS address');
});
