import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';

export interface GatewayState {
  runId: string;
  permissionMode: string;
  backends: Array<{ id: string; status: string }>;
  tasks: Array<{ status: string }>;
}

export async function localRequest<T>(
  directory: string,
  path: string,
  body?: Record<string, string>,
  runId?: string,
): Promise<T> {
  const runtimePath = join(directory, 'runtime.json');
  const runtime = existsSync(runtimePath)
    ? (JSON.parse(readFileSync(runtimePath, 'utf8')) as { port: number })
    : { port: 47421 };
  const cert = readFileSync(join(directory, 'server-cert.pem'));
  const token = readFileSync(join(directory, 'device-token'), 'utf8').trim();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: runtime.port,
        path,
        ca: cert,
        method: body ? 'POST' : 'GET',
        timeout: 10_000,
        headers: {
          authorization: `Bearer ${token}`,
          ...(runId ? { 'x-live-run-id': runId } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString()) as T & {
              error?: string;
            };
            if (response.statusCode !== 200)
              throw new Error(
                `Gateway request failed (${response.statusCode}): ${result.error ?? 'unknown'}`,
              );
            resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Gateway did not respond')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
