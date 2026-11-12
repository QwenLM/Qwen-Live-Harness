import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localRequest, type GatewayState } from './client.js';
import { privateDirectory } from './state.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { GatewayOptions } from './mobile/index.js';

export function gatewayServiceLabel(): string {
  const label =
    process.env['AGENT_REMOTE_SERVICE_LABEL'] ?? 'dev.agent-remote.gateway';
  if (!/^dev\.agent-remote\.gateway(?:\.[A-Za-z0-9-]+)?$/u.test(label))
    throw new Error('Invalid Agent Remote service label');
  return label;
}
const escape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

export function launchAgent(
  options: GatewayOptions,
  cli = fileURLToPath(new URL('./cli.js', import.meta.url)),
  node = process.execPath,
  path = process.env['PATH'] ?? '',
): string {
  const LABEL = gatewayServiceLabel();
  if (!options.port || options.reset)
    throw new Error(
      'A background service requires a fixed port and must not reset pairing on each login',
    );
  const args = [
    node,
    cli,
    'start',
    '--no-open',
    '--port',
    String(options.port),
    '--data-dir',
    options.directory,
    ...(options.ask ? ['--ask'] : []),
    ...options.projects.flatMap((project) => ['--project', project]),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${escape(arg)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${escape(options.projects[0]!)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(path)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${escape(join(options.directory, 'service.log'))}</string><key>StandardErrorPath</key><string>${escape(join(options.directory, 'service-error.log'))}</string></dict></plist>`;
}

export interface ServiceCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
type Runner = (args: string[]) => ServiceCommandResult;
const run: Runner = (args) =>
  spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 15_000 });

export async function manageService(
  action: string,
  options: GatewayOptions,
  dependencies: {
    platform?: string;
    home?: string;
    uid?: number;
    run?: Runner;
    state?: () => Promise<GatewayState | undefined>;
  } = {},
): Promise<string> {
  const LABEL = gatewayServiceLabel();
  if ((dependencies.platform ?? process.platform) !== 'darwin')
    throw new Error(
      'Background installation currently supports macOS. Use agent-remote start under your own service manager on other systems.',
    );
  const runner = dependencies.run ?? run;
  const domain = `gui/${dependencies.uid ?? process.getuid!()}`;
  const filename = join(
    dependencies.home ?? homedir(),
    'Library/LaunchAgents',
    LABEL + '.plist',
  );
  if (
    existsSync(filename) &&
    (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink())
  )
    throw new Error('LaunchAgent must be a regular file');
  const loaded = runner(['print', `${domain}/${LABEL}`]).status === 0;
  const checked = (args: string[]) => {
    const result = runner(args);
    if (result.status !== 0)
      throw new Error(
        `launchctl ${args[0]} failed: ${result.stderr.replace('Try re-running the command as root for richer errors.', '').trim() || 'check the logged-in desktop session'}`,
      );
  };
  if (action === 'status')
    return loaded
      ? 'Agent Remote background service is loaded.'
      : 'Agent Remote background service is not loaded.';
  if (action === 'stop' || action === 'uninstall') {
    if (loaded) checked(['bootout', `${domain}/${LABEL}`]);
    if (action === 'uninstall' && existsSync(filename)) unlinkSync(filename);
    return `${action === 'uninstall' ? 'Uninstalled' : 'Stopped'} the background service. Pairing credentials are retained.`;
  }
  if (action === 'start') {
    if (!existsSync(filename))
      throw new Error(
        'Install the service first: agent-remote service install --project /path/to/project',
      );
    if (!loaded) checked(['bootstrap', domain, filename]);
    return 'Agent Remote background service started.';
  }
  if (action !== 'install')
    throw new Error('Use service install, status, start, stop or uninstall');
  const state = await (dependencies.state?.() ??
    localRequest<GatewayState>(options.directory, '/v1/state').catch(
      () => undefined,
    ));
  if (
    state?.tasks.some(
      (task) =>
        !['completed', 'failed', 'cancelled', 'interrupted'].includes(
          task.status,
        ),
    )
  )
    throw new Error(
      'Tasks are still running. Finish them before replacing the service.',
    );
  if (state && !loaded)
    throw new Error(
      'A foreground gateway is running. Stop it with Ctrl+C before installing the background service.',
    );
  const plist = launchAgent(options);
  privateDirectory(options.directory);
  for (const name of ['service.log', 'service-error.log']) {
    const path = join(options.directory, name);
    if (
      existsSync(path) &&
      (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    )
      throw new Error('Service logs must be regular files');
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  mkdirSync(resolve(filename, '..'), { recursive: true });
  const previous = existsSync(filename) ? readFileSync(filename) : undefined;
  if (loaded) {
    checked(['bootout', `${domain}/${LABEL}`]);
    // bootout can return before launchd finishes removing the old job. A
    // bootstrap in that interval fails with EIO even for a valid registration.
    for (let attempt = 0; ; attempt++) {
      if (runner(['print', `${domain}/${LABEL}`]).status !== 0) break;
      if (attempt >= 100)
        throw new Error(
          'The previous service is still stopping. Retry after it exits.',
        );
      await delay(50);
    }
  }
  writeFileSync(filename, plist, { mode: 0o600 });
  chmodSync(filename, 0o600);
  try {
    checked(['bootstrap', domain, filename]);
  } catch (error) {
    if (previous) writeFileSync(filename, previous, { mode: 0o600 });
    else unlinkSync(filename);
    if (loaded && previous) runner(['bootstrap', domain, filename]);
    throw error;
  }
  return 'Installed Agent Remote for this user. It starts now and at login. Run agent-remote pair to connect your iPhone.';
}
