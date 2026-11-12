/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** A pinned certificate must still be a valid TLS server certificate on iOS. */
export async function ensureMobileTLS(
  directory: string,
  addresses: readonly string[],
  hostnames: readonly string[] = ['localhost'],
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (
    lstatSync(directory).isSymbolicLink() ||
    !lstatSync(directory).isDirectory()
  )
    throw new Error('TLS directory must be a real directory');
  chmodSync(directory, 0o700);
  const ips = [...new Set(['127.0.0.1', ...addresses])];
  if (ips.some((address) => isIP(address) !== 4))
    throw new Error('Invalid mobile TLS address');
  const names = [...new Set(['localhost', ...hostnames])].filter((name) =>
    /^[a-z0-9][a-z0-9.-]*$/iu.test(name),
  );
  const keyPath = join(directory, 'server-key.pem'),
    certPath = join(directory, 'server-cert.pem');
  for (const path of [keyPath, certPath]) {
    if (existsSync(path)) {
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
        throw new Error('TLS files must be regular files');
      chmodSync(path, 0o600);
    }
  }
  let current = false;
  if (existsSync(keyPath) && existsSync(certPath)) {
    try {
      const certificate = new X509Certificate(readFileSync(certPath));
      current =
        certificate.ca === false &&
        certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.1') === true &&
        Date.parse(certificate.validTo) > Date.now() + 86_400_000 &&
        certificate.checkIP('127.0.0.1') !== undefined &&
        // Stable DNS names survive Wi-Fi address changes without revoking a
        // phone's pinned certificate. IP-only installations still renew.
        (names.some((name) => name !== 'localhost') ||
          ips.every((ip) => certificate.checkIP(ip) !== undefined)) &&
        names.every((name) => certificate.checkHost(name) !== undefined);
    } catch {
      /* Preserve invalid/legacy material before replacing it. */
    }
  }
  if (!current) {
    const temporary = mkdtempSync(join(directory, '.tls-'));
    try {
      const config = join(temporary, 'openssl.cnf');
      writeFileSync(
        config,
        `[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = server\n[dn]\nCN = Qwen Live Harness Mobile\n[server]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectAltName = @names\n[names]\n${ips.map((ip, index) => `IP.${index + 1} = ${ip}`).join('\n')}\n${names.map((name, index) => `DNS.${index + 1} = ${name}`).join('\n')}\n`,
        { mode: 0o600 },
      );
      await promisify(execFile)(
        process.platform === 'darwin' ? '/usr/bin/openssl' : 'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-sha256',
          '-nodes',
          '-days',
          '365',
          '-config',
          config,
          '-keyout',
          join(temporary, 'key.pem'),
          '-out',
          join(temporary, 'cert.pem'),
        ],
        { timeout: 15_000 },
      );
      const suffix = `.previous-${Date.now()}`;
      for (const path of [keyPath, certPath]) {
        if (existsSync(path)) {
          copyFileSync(path, path + suffix);
          chmodSync(path + suffix, 0o600);
        }
      }
      chmodSync(join(temporary, 'key.pem'), 0o600);
      chmodSync(join(temporary, 'cert.pem'), 0o600);
      renameSync(join(temporary, 'key.pem'), keyPath);
      renameSync(join(temporary, 'cert.pem'), certPath);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const key = readFileSync(keyPath),
    cert = readFileSync(certPath);
  return {
    key,
    cert,
    pin: createHash('sha256')
      .update(new X509Certificate(cert).raw)
      .digest('hex'),
    renewed: !current,
  };
}
