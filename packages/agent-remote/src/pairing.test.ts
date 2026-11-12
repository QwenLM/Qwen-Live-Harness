import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairingUrls } from './pairing.js';

const network = vi.hoisted(() => ({ addresses: ['10.0.0.2'] }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  hostname: () => 'computer.local',
  networkInterfaces: () => ({
    en0: network.addresses.map((address) => ({
      address,
      family: 'IPv4',
      internal: false,
    })),
  }),
}));

let directory: string;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'remote-pairing-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=computer.local',
      '-addext',
      'subjectAltName=DNS:computer.local,IP:10.0.0.2,IP:127.0.0.1',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'server-cert.pem'),
    ],
    { stdio: 'ignore' },
  );
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it('prefers a certificate-covered IP over mDNS for desktop and CLI pairing', () => {
  expect(pairingUrls(directory, 47421)).toEqual([
    'https://10.0.0.2:47421',
    'https://computer.local:47421',
    'https://127.0.0.1:47421',
  ]);
});

it('excludes new addresses absent from the certificate and retains fallbacks', () => {
  network.addresses = ['10.0.0.3', '169.254.1.1'];
  expect(pairingUrls(directory, 47422)).toEqual([
    'https://computer.local:47422',
    'https://127.0.0.1:47422',
  ]);
});
