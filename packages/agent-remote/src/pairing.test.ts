import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePublicHost, pairingPage, pairingUrls } from './pairing.js';

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
      'subjectAltName=DNS:computer.local,DNS:remote.example.test,IP:203.0.113.8,IP:10.0.0.2,IP:127.0.0.1',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'server-cert.pem'),
    ],
    { stdio: 'ignore' },
  );
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
beforeEach(() => {
  network.addresses = ['10.0.0.2'];
});

it('prefers the configured public DNS name or IP over LAN and mDNS addresses', () => {
  for (const host of ['remote.example.test', '203.0.113.8']) {
    expect(pairingUrls(directory, 47421, host)).toEqual([
      `https://${host}:47421`,
      'https://10.0.0.2:47421',
      'https://computer.local:47421',
      'https://127.0.0.1:47421',
    ]);
  }
  expect(pairingUrls(directory, 47421, '10.0.0.2')).toHaveLength(3);
});

it('requires certificate coverage instead of silently advertising an unusable public host', () => {
  for (const host of ['other.example.test', '203.0.113.9']) {
    expect(() => pairingUrls(directory, 47421, host)).toThrow('not covered');
  }
});

it('puts the public endpoint first in the single-use v1 pairing page', async () => {
  const page = await pairingPage({
    directory,
    port: 47421,
    publicHost: 'remote.example.test',
    pin: 'test-pin',
    code: 'test-code',
    ask: false,
    open: false,
  });
  const html = readFileSync(page, 'utf8');
  const encoded = html.match(/qwenliveharness:\/\/pair\?data=([\w-]+)/u)![1]!;
  expect(JSON.parse(Buffer.from(encoded, 'base64url').toString())).toEqual({
    version: 1,
    url: 'https://remote.example.test:47421',
    pin: 'test-pin',
    code: 'test-code',
    name: 'computer.local',
  });
  expect(html).toContain('iPhone · 公网 / Internet');
  expect(html).toContain('iPhone · 同一局域网 / Local network');
  expect(html).toContain('iOS 模拟器 / Simulator');
});

it('accepts hostnames and IPv4 while rejecting URL, SAN and port injection', () => {
  expect(normalizePublicHost(' Remote.Example.test ')).toBe(
    'remote.example.test',
  );
  expect(normalizePublicHost('203.0.113.8')).toBe('203.0.113.8');
  expect(normalizePublicHost(' ')).toBeUndefined();
  for (const value of [
    'https://remote.example.test',
    'remote.example.test:47421',
    'remote.example.test/path',
    'user@remote.example.test',
    'remote.example.test\nDNS.9=other.test',
    '*.example.test',
    '999.1.1.1',
    '::1',
    '-bad.example.test',
    'bad..test',
  ]) {
    expect(() => normalizePublicHost(value)).toThrow('DNS hostname or IPv4');
  }
});

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
