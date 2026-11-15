#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGateway, certificatePin } from './mobile/index.js';
import { parseOptions } from './options.js';
import { localRequest, type GatewayState } from './client.js';
import { pairingPage, pairingUrls } from './pairing.js';
import { manageService } from './service.js';
import { PACKAGE_VERSION } from './version.js';
import { desktopCommand } from './desktop.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      `Agent Remote ${PACKAGE_VERSION}\n\nagent-remote [start] --project /path/to/project [--project /another/project]\nagent-remote pair [--no-open]\nagent-remote status\nagent-remote service install --project /path/to/project\nagent-remote service status|start|stop|uninstall\n\nDefaults: Qwen YOLO / Codex Full Access; automatic one-time approvals.\nOptions: --ask, --port 47421, --public-host remote.example.com, --data-dir /path, --reset-pairing, --no-open\nAGENT_REMOTE_PUBLIC_HOST also sets the preferred pairing DNS hostname or IPv4 address.\nPairing codes can be renewed with 'pair' without interrupting tasks.\nExisting Qwen Live iPhone credentials are retained automatically.`,
    );
    return;
  }
  if (args.includes('--version')) {
    console.log(PACKAGE_VERSION);
    return;
  }
  if (args[0] === 'desktop') {
    console.log(JSON.stringify(await desktopCommand(args.slice(1))));
    return;
  }
  const action = args[0]?.startsWith('-') || !args[0] ? 'start' : args.shift()!;
  const subcommand =
    action === 'service' ? (args.shift() ?? 'status') : undefined;
  const options = parseOptions(args);
  if (action === 'service') {
    console.log(await manageService(subcommand!, options));
    return;
  }
  if (action === 'status' || action === 'pair') {
    const state = await localRequest<GatewayState>(
      options.directory,
      '/v1/state',
    );
    if (action === 'status') {
      console.log(
        JSON.stringify(
          {
            permissionMode: state.permissionMode,
            agents: state.backends,
            tasks: state.tasks.map((task) => ({ status: task.status })),
          },
          null,
          2,
        ),
      );
      return;
    }
    const runtime = JSON.parse(
      readFileSync(join(options.directory, 'runtime.json'), 'utf8'),
    ) as { port: number; publicHost?: string };
    const publicHost = options.publicHost ?? runtime.publicHost;
    pairingUrls(options.directory, runtime.port, publicHost);
    const result = await localRequest<{ code: string }>(
      options.directory,
      '/v1/pairing',
      {},
      state.runId,
    );
    console.log(
      'Pairing page: ' +
        (await pairingPage({
          directory: options.directory,
          port: runtime.port,
          pin: certificatePin(options.directory),
          code: result.code,
          ask: state.permissionMode !== 'allow-all',
          open: options.open,
          publicHost,
        })),
    );
    return;
  }
  if (action !== 'start') throw new Error(`Unknown command: ${action}`);
  const gateway = await startGateway(options);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void gateway.close().then(
      () => process.exit(0),
      () => {
        console.error('Could not fully stop owned agents. Check the computer.');
        process.exitCode = 1;
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Agent Remote failed',
    );
    process.exitCode = 1;
  });
}
