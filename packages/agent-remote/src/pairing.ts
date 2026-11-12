import QRCode from 'qrcode';
import { X509Certificate } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

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

export function pairingUrls(directory: string, port: number): string[] {
  const certificate = new X509Certificate(
    readFileSync(join(directory, 'server-cert.pem')),
  );
  return [
    ...localAddresses()
      .filter((address) => certificate.checkIP(address))
      .map((address) => `https://${address}:${port}`),
    ...(hostname().endsWith('.local') && certificate.checkHost(hostname())
      ? [`https://${hostname()}:${port}`]
      : []),
    ...(certificate.checkIP('127.0.0.1') ? [`https://127.0.0.1:${port}`] : []),
  ];
}

export async function pairingPage(options: {
  directory: string;
  port: number;
  pin: string;
  code: string;
  ask: boolean;
  open: boolean;
}): Promise<string> {
  const urls = pairingUrls(options.directory, options.port);
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
      return `<section><h2>${url.includes('127.0.0.1') ? 'iOS 模拟器 / Simulator' : 'iPhone · 同一局域网 / Local network'}</h2><p>${escape(url)}</p><img src="${qr}" alt="Pairing QR code" width="280"><textarea id="link${index}" readonly>${escape(link)}</textarea><p><button onclick="let t=document.getElementById('link${index}');t.select();document.execCommand('copy');this.innerText='已复制 / Copied'">复制配对信息 / Copy</button></p></section>`;
    }),
  );
  const page = join(options.directory, 'pairing.html');
  writeFileSync(
    page,
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent Remote · 配对 / Pair</title><style>body{font:17px -apple-system,system-ui,sans-serif;max-width:760px;margin:50px auto;padding:24px;color:#172522;background:#f4f6f2}section{background:white;padding:24px;border-radius:20px;margin:20px 0}img{display:block;max-width:100%}textarea{width:100%;height:100px;box-sizing:border-box;font:13px monospace}button{padding:12px 20px;border:0;border-radius:12px;background:#235d50;color:white;font-size:16px}</style><h1>连接电脑 / Connect your computer</h1><p>手机与电脑连接同一局域网，在 App 内扫码或粘贴链接。链接十五分钟内有效，仅能使用一次。<br>Use the same local network. Scan or paste in the app. The code expires in 15 minutes and is single-use.</p>${sections.join('')}<p>${options.ask ? '逐次询问 / Manual approvals' : '默认免审批 / Automatic approvals'} · HTTPS</p><p>新配对码 / New pairing code: <code>agent-remote pair</code></p></html>`,
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
