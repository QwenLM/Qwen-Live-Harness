import { createHash, X509Certificate } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
  realpathSync,
  statSync,
  lstatSync,
  unlinkSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { detectAgents } from '../agent-detector.js';
import { AcpAdaptor } from '../adaptor/acp-adaptor.js';
import { MobileTasks } from './tasks.js';
import { MobileServer } from './server.js';
import { ensureMobileTLS } from './tls.js';
import { privateDirectory } from '../state.js';
import { claimInstance } from '../instance.js';
import { localAddresses, pairingPage } from '../pairing.js';

export interface GatewayOptions {
  projects: string[];
  port: number;
  directory: string;
  ask: boolean;
  open: boolean;
  reset: boolean;
}

export async function startGateway(
  options: GatewayOptions,
): Promise<{ close(): Promise<void> }> {
  const projects = [
    ...new Set(options.projects.map((path) => realpathSync(path))),
  ];
  if (
    !projects.length ||
    projects.some((path) => !statSync(path).isDirectory())
  )
    throw new Error('Select at least one project directory');
  const directory = options.directory;
  privateDirectory(directory);
  const release = await claimInstance(directory, options.port);
  let shutdown: (() => Promise<void>) | undefined;
  try {
    const { key, cert, pin, renewed } = await ensureMobileTLS(
      directory,
      localAddresses(),
      [hostname()],
    );
    if (renewed)
      console.log(
        'TLS certificate created or renewed. Scan the new pairing code.',
      );
    const tokenPath = join(directory, 'device-token');
    if (
      existsSync(tokenPath) &&
      (!lstatSync(tokenPath).isFile() || lstatSync(tokenPath).isSymbolicLink())
    )
      throw new Error('Device token must be a regular file');
    if (options.reset && existsSync(tokenPath)) unlinkSync(tokenPath);
    if (existsSync(tokenPath)) {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(readFileSync(tokenPath, 'utf8').trim()))
        throw new Error(
          'Invalid device token. Use --reset-pairing to revoke it explicitly.',
        );
      chmodSync(tokenPath, 0o600);
    }
    const agents = detectAgents({
      names: ['qwen', 'codex'],
      probeVersions: false,
    });
    if (!agents.length)
      throw new Error('Install and sign in to Qwen Code or Codex CLI first.');
    const tasks = new MobileTasks(
      new Map(
        agents.map((agent) => [
          agent.name,
          new AcpAdaptor({
            name: agent.name,
            command: agent.command,
            args: agent.args,
            env: agent.env,
            defaultCwd: projects[0],
            ...(!options.ask
              ? {
                  sessionMode:
                    agent.name === 'qwen' ? 'yolo' : 'agent-full-access',
                }
              : {}),
          }),
        ]),
      ),
      projects.map((path) => ({
        id: createHash('sha256').update(path).digest('hex').slice(0, 16),
        name: basename(path),
        path,
      })),
      { permissionMode: options.ask ? 'ask' : 'allow-all' },
    );
    const server = new MobileServer(
      tasks,
      { key, cert },
      {
        ...(existsSync(tokenPath)
          ? { token: readFileSync(tokenPath, 'utf8').trim() }
          : {}),
        saveToken: (token) => writeFileSync(tokenPath, token, { mode: 0o600 }),
      },
    );
    shutdown = () => server.close();
    if (!existsSync(tokenPath))
      writeFileSync(tokenPath, server.deviceToken, { mode: 0o600 });
    const port = await server.listen(options.port);
    const runtimePath = join(directory, 'runtime.json');
    writeFileSync(
      runtimePath,
      JSON.stringify({ runId: tasks.runId, port, pid: process.pid }),
      { mode: 0o600 },
    );
    const page = await pairingPage({
      directory,
      port,
      pin,
      code: server.pairingCode,
      ask: options.ask,
      open: options.open,
    });
    console.log(
      `Agent Remote ready · Qwen YOLO / Codex Full Access: ${!options.ask}\nAgents: ${agents.map((agent) => agent.name).join(', ')}\nProjects: ${projects.join(', ')}\nPairing page: ${page}\nNew pairing code: agent-remote pair\nKeep the computer awake. Ctrl+C stops only this gateway's agents.`,
    );
    return {
      async close() {
        await server.close();
        release();
        try {
          if (
            (JSON.parse(readFileSync(runtimePath, 'utf8')) as { runId: string })
              .runId === tasks.runId
          )
            unlinkSync(runtimePath);
        } catch {
          /* Do not delete another process's metadata. */
        }
      },
    };
  } catch (error) {
    try {
      await shutdown?.();
    } catch {
      throw new Error(
        'Gateway startup failed and owned agent cleanup could not finish',
        { cause: error },
      );
    }
    release();
    throw error;
  }
}

export function certificatePin(directory: string): string {
  return createHash('sha256')
    .update(
      new X509Certificate(readFileSync(join(directory, 'server-cert.pem'))).raw,
    )
    .digest('hex');
}
