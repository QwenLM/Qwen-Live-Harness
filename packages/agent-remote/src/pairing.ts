import QRCode from 'qrcode';
import { X509Certificate } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';

/** A host only: the gateway port and HTTPS scheme stay under our control. */
export function normalizePublicHost(value: string): string | undefined {
  const host = value.trim().toLowerCase();
  if (!host) return undefined;
  if (
    isIP(host) !== 4 &&
    (host.length > 253 ||
      !host.includes('.') ||
      /^[\d.]+$/u.test(host) ||
      !host
        .split('.')
        .every((label) =>
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
        ))
  )
    throw new Error(
      'Use a DNS hostname or IPv4 address without a scheme, port or path',
    );
  return host;
}

export function localAddresses(): string[] {
  return [
    ...new Set(
      Object.entries(networkInterfaces())
        .filter(([name]) => /^(en|eth|wlan)/u.test(name))
        .flatMap(([, entries]) => entries ?? [])
        .filter(
          (entry) =>
            entry.family === 'IPv4' &&
            !entry.internal &&
            !entry.address.startsWith('169.254.'),
        )
        .map((entry) => entry.address),
    ),
  ];
}

export function pairingUrls(
  directory: string,
  port: number,
  publicHost?: string,
): string[] {
  const certificate = new X509Certificate(
    readFileSync(join(directory, 'server-cert.pem')),
  );
  const preferred = publicHost ? normalizePublicHost(publicHost) : undefined;
  if (
    preferred &&
    !(isIP(preferred)
      ? certificate.checkIP(preferred)
      : certificate.checkHost(preferred))
  )
    throw new Error(
      'The public host is not covered by the service certificate. Restart the service with --public-host.',
    );
  return [
    ...new Set([
      ...(preferred ? [`https://${preferred}:${port}`] : []),
      ...localAddresses()
        .filter((address) => certificate.checkIP(address))
        .map((address) => `https://${address}:${port}`),
      ...(hostname().endsWith('.local') && certificate.checkHost(hostname())
        ? [`https://${hostname()}:${port}`]
        : []),
      ...(certificate.checkIP('127.0.0.1')
        ? [`https://127.0.0.1:${port}`]
        : []),
    ]),
  ];
}

export async function pairingPage(options: {
  directory: string;
  port: number;
  pin: string;
  code: string;
  ask: boolean;
  open: boolean;
  publicHost?: string;
}): Promise<string> {
  const publicHost =
    options.publicHost === undefined
      ? undefined
      : normalizePublicHost(options.publicHost);
  const urls = pairingUrls(options.directory, options.port, publicHost);
  const escape = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('"', '&quot;');
  const sections = await Promise.all(
    urls.map(async (url, index) => {
      const link = `qwenliveharness://pair?data=${Buffer.from(JSON.stringify({ version: 1, url, pin: options.pin, code: options.code, name: hostname() })).toString('base64url')}`;
      const qr = await QRCode.toDataURL(link, {
        errorCorrectionLevel: 'M',
        width: 320,
        margin: 2,
      });
      const host = new URL(url).hostname;
      const title =
        host === publicHost
          ? 'iPhone · 公网 / Internet'
          : host === '127.0.0.1'
            ? 'iOS 模拟器 / Simulator'
            : 'iPhone · 同一局域网 / Local network';
      return `<section><h2>${title}</h2><p>${escape(url)}</p><img src="${qr}" alt="Pairing QR code" width="280"><textarea id="link${index}" readonly>${escape(link)}</textarea><p><button onclick="let t=document.getElementById('link${index}');t.select();document.execCommand('copy');this.innerText='已复制 / Copied'">复制配对信息 / Copy</button></p></section>`;
    }),
  );
  const page = join(options.directory, 'pairing.html');
  writeFileSync(
    page,
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent Remote · 配对 / Pair</title><style>body{font:17px -apple-system,system-ui,sans-serif;max-width:760px;margin:50px auto;padding:24px;color:#172522;background:#f4f6f2}section{background:white;padding:24px;border-radius:20px;margin:20px 0}img{display:block;max-width:100%}textarea{width:100%;height:100px;box-sizing:border-box;font:13px monospace}button{padding:12px 20px;border:0;border-radius:12px;background:#235d50;color:white;font-size:16px}</style><h1>连接电脑 / Connect your computer</h1><p>在 App 内扫码或粘贴链接。5G 连接请优先使用公网地址，并确保 DNS、端口转发和防火墙允许访问此端口；局域网地址仅适用于同一网络或可达的 VPN。链接十五分钟内有效，仅能使用一次。<br>Scan or paste in the app. For cellular access, prefer the public address and make sure DNS, port forwarding and the firewall allow this port. Local addresses require the same network or a reachable VPN. The code expires in 15 minutes and is single-use.</p>${sections.join('')}<p>${options.ask ? '逐次询问 / Manual approvals' : '默认免审批 / Automatic approvals'} · HTTPS</p><p>新配对码 / New pairing code: <code>agent-remote pair</code></p></html>`,
    { mode: 0o600 },
  );
  if (options.open) {
    const command =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'explorer.exe'
          : 'xdg-open';
    execFile(command, [page], () => {});
  }
  return page;
}
