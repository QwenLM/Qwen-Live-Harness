import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { detectAgents } from './agent-detector.js';
import { localRequest, type GatewayState } from './client.js';
import { certificatePin, type GatewayOptions } from './mobile/index.js';
import { gatewayServiceLabel, manageService } from './service.js';
import { privateDirectory, stateDirectory } from './state.js';
import { pairingUrls } from './pairing.js';

export interface DesktopConfig {
  version: 1;
  projects: string[];
  port: number;
  ask: boolean;
  launchAtLogin: boolean;
}
interface DesktopState extends GatewayState {
  projects: Array<{ id: string; name: string; path: string }>;
}
export function serviceFile(home = homedir()): string {
  return join(home, 'Library/LaunchAgents', gatewayServiceLabel() + '.plist');
}

export function validateDesktopConfig(config: DesktopConfig): void {
  if (
    config.version !== 1 ||
    !Array.isArray(config.projects) ||
    !config.projects.every(
      (path) => typeof path === 'string' && path.startsWith('/'),
    ) ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    typeof config.ask !== 'boolean' ||
    typeof config.launchAtLogin !== 'boolean'
  )
    throw new Error('Invalid desktop configuration');
}

export function legacyConfig(arguments_: unknown): DesktopConfig | undefined {
  if (
    !Array.isArray(arguments_) ||
    !arguments_.every((entry) => typeof entry === 'string')
  )
    return undefined;
  const projects: string[] = [];
  let port = 47421;
  for (let i = 0; i < arguments_.length; i++) {
    if (arguments_[i] === '--project' && arguments_[i + 1])
      projects.push(arguments_[++i]);
    else if (arguments_[i] === '--port' && arguments_[i + 1])
      port = Number(arguments_[++i]);
  }
  if (!projects.length) return undefined;
  const config: DesktopConfig = {
    version: 1,
    projects,
    port,
    ask: arguments_.includes('--ask'),
    launchAtLogin: true,
  };
  validateDesktopConfig(config);
  return config;
}

export function loadDesktopConfig(
  directory: string,
  home = homedir(),
): DesktopConfig {
  const path = join(directory, 'desktop-config.json');
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error('Desktop configuration must be a regular file');
    const config = JSON.parse(readFileSync(path, 'utf8')) as DesktopConfig;
    validateDesktopConfig(config);
    return config;
  }
  const plist = serviceFile(home);
  if (existsSync(plist)) {
    if (!lstatSync(plist).isFile() || lstatSync(plist).isSymbolicLink())
      throw new Error('LaunchAgent must be a regular file');
    const value = JSON.parse(
      execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], {
        encoding: 'utf8',
      }),
    ) as { ProgramArguments?: unknown };
    const legacy = legacyConfig(value.ProgramArguments);
    if (legacy) return legacy;
  }
  return {
    version: 1,
    projects: [],
    port: 47421,
    ask: false,
    launchAtLogin: true,
  };
}

export function saveDesktopConfig(
  directory: string,
  config: DesktopConfig,
): void {
  validateDesktopConfig(config);
  privateDirectory(directory);
  const path = join(directory, 'desktop-config.json');
  if (
    existsSync(path) &&
    (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
  )
    throw new Error('Desktop configuration must be a regular file');
  const temporary = path + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  try {
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function gatewayOptions(
  config: DesktopConfig,
  directory: string,
): GatewayOptions {
  return {
    projects: config.projects,
    port: config.port,
    directory,
    ask: config.ask,
    open: false,
    reset: false,
  };
}

function loaded(): boolean {
  return (
    spawnSync(
      '/bin/launchctl',
      ['print', `gui/${process.getuid!()}/${gatewayServiceLabel()}`],
      { stdio: 'ignore', timeout: 10_000 },
    ).status === 0
  );
}
const active = (state?: DesktopState) =>
  state?.tasks.filter(
    (task) =>
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(
        task.status,
      ),
  ).length ?? 0;

/** A disabled login flag removes only the on-disk registration. launchd keeps
 * supervising the already loaded service for the rest of this login session. */
export function applyLoginRegistration(
  enabled: boolean,
  home = homedir(),
): void {
  const path = serviceFile(home);
  if (!enabled && existsSync(path)) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error('LaunchAgent must be a regular file');
    unlinkSync(path);
  }
}

export async function desktopCommand(args: string[]): Promise<unknown> {
  if (process.platform !== 'darwin')
    throw new Error('The desktop controller supports macOS');
  const action = args.shift() ?? 'snapshot';
  const directory = stateDirectory(process.env['AGENT_REMOTE_DATA_DIR']);
  let config = loadDesktopConfig(directory);
  const current = await localRequest<DesktopState>(
    directory,
    '/v1/state',
  ).catch(() => undefined);
  if (!config.projects.length && current?.projects.length)
    config = {
      ...config,
      projects: current.projects.map((project) => project.path),
      ask: current.permissionMode !== 'allow-all',
    };
  if (action === 'snapshot') {
    const agents = detectAgents({
      names: ['qwen', 'codex'],
      probeVersions: false,
    });
    const runtimeFile = join(directory, 'runtime.json');
    const runtime = existsSync(runtimeFile)
      ? (JSON.parse(readFileSync(runtimeFile, 'utf8')) as {
          pid?: number;
          port?: number;
        })
      : undefined;
    const urls = Object.entries(networkInterfaces())
      .filter(([name]) => /^(en|eth|wlan)/u.test(name))
      .flatMap(([, values]) => values ?? [])
      .filter(
        (entry) =>
          entry.family === 'IPv4' &&
          !entry.internal &&
          !entry.address.startsWith('169.254.'),
      )
      .map(
        (entry) => `https://${entry.address}:${runtime?.port ?? config.port}`,
      );
    return {
      version: 1,
      name: hostname(),
      config,
      directory,
      loaded: loaded(),
      online: !!current,
      runId: current?.runId,
      pid: current ? runtime?.pid : undefined,
      permissionMode:
        current?.permissionMode ?? (config.ask ? 'ask' : 'allow-all'),
      activeTasks: active(current),
      totalTasks: current?.tasks.length ?? 0,
      addresses: urls,
      agents: ['qwen', 'codex'].map((id) => ({
        id,
        name: id === 'qwen' ? 'Qwen Code' : 'Codex',
        installed: agents.some((agent) => agent.name === id),
        executable:
          agents.find((agent) => agent.name === id)?.env?.['CODEX_PATH'] ??
          agents.find((agent) => agent.name === id)?.command,
        status:
          current?.backends.find((backend) => backend.id === id)?.status ??
          'available',
      })),
    };
  }
  if (action === 'pair') {
    if (!current) throw new Error('Start the service before pairing');
    const { code } = await localRequest<{ code: string }>(
      directory,
      '/v1/pairing',
      {},
      current.runId,
    );
    const runtime = JSON.parse(
      readFileSync(join(directory, 'runtime.json'), 'utf8'),
    ) as { port: number };
    const pin = certificatePin(directory);
    const url = pairingUrls(directory, runtime.port)[0];
    if (!url)
      throw new Error(
        'No network address matches the service certificate. Restart the service.',
      );
    const link = `qwenliveharness://pair?data=${Buffer.from(JSON.stringify({ version: 1, url, pin, code, name: hostname() })).toString('base64url')}`;
    return {
      link,
      url,
      expiresAt: Date.now() + 15 * 60_000,
      runId: current.runId,
    };
  }
  if (action === 'configure') {
    const projects: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '--project' || !args[i + 1])
        throw new Error('Use --project /absolute/path');
      const path = realpathSync(args[++i]!);
      if (!statSync(path).isDirectory())
        throw new Error('Choose a project folder');
      projects.push(path);
    }
    if (!projects.length) throw new Error('Choose at least one project folder');
    const next: DesktopConfig = { ...config, projects: [...new Set(projects)] };
    if (JSON.stringify(next.projects) === JSON.stringify(config.projects)) {
      saveDesktopConfig(directory, next);
      return { ok: true };
    }
    if (loaded() && !current)
      throw new Error(
        'The service is loaded but its task state cannot be verified. Check logs or explicitly stop it before changing projects.',
      );
    if (active(current))
      throw new Error(
        'Tasks are running. Change project folders after they finish.',
      );
    // install performs its own fresh active-task check before replacing a job.
    if (current || loaded()) {
      await manageService('install', gatewayOptions(next, directory));
      applyLoginRegistration(next.launchAtLogin);
    }
    saveDesktopConfig(directory, next);
    return { ok: true };
  }
  if (action === 'start') {
    if (!config.projects.length)
      throw new Error('Choose a project folder first');
    if (loaded() && !current)
      throw new Error(
        'The service is recovering or unreachable. Check its status and logs before restarting.',
      );
    if (active(current))
      throw new Error(
        'Tasks are running. Switch the service after they finish.',
      );
    await manageService('install', gatewayOptions(config, directory));
    applyLoginRegistration(config.launchAtLogin);
    saveDesktopConfig(directory, config);
    return { ok: true };
  }
  if (action === 'stop') {
    if (active(current) && !args.includes('--confirm-active'))
      throw new Error('Stopping will end running tasks. Confirm in the app.');
    await manageService('stop', gatewayOptions(config, directory));
    return { ok: true };
  }
  if (action === 'login') {
    const enabled = args[0] === 'on';
    if (!['on', 'off'].includes(args[0] ?? ''))
      throw new Error('Use login on or off');
    if (enabled && !config.projects.length)
      throw new Error('Choose a project folder first');
    if (enabled && !existsSync(serviceFile())) {
      // Write the same known job without booting out a running service.
      const { launchAgent } = await import('./service.js');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
      writeFileSync(
        serviceFile(),
        launchAgent(gatewayOptions(config, directory)),
        { mode: 0o600 },
      );
    }
    applyLoginRegistration(enabled);
    saveDesktopConfig(directory, { ...config, launchAtLogin: enabled });
    return { ok: true };
  }
  if (action === 'identity') {
    return {
      fingerprint: createHash('sha256')
        .update(readFileSync(join(directory, 'server-cert.pem')))
        .digest('hex'),
    };
  }
  throw new Error('Unknown desktop command');
}
