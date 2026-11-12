import { afterEach, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchAgent, manageService } from './service.js';
import type { GatewayOptions } from './mobile/index.js';

const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    ),
);
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'remote-service-'));
  directories.push(home);
  const options: GatewayOptions = {
    directory: join(home, 'state'),
    projects: [home],
    port: 47421,
    ask: false,
    open: false,
    reset: false,
  };
  return {
    home,
    options,
    plist: join(home, 'Library/LaunchAgents/dev.agent-remote.gateway.plist'),
  };
}

it('uses explicit executable arguments and escaped project paths, without serializing account secrets', () => {
  const { options } = setup();
  options.projects = ['/a folder/<project>&"'];
  const plist = launchAgent(
    options,
    '/installed/cli.js',
    '/node path/node',
    '/usr/local/bin',
  );
  expect(plist).toContain('<string>/node path/node</string>');
  expect(plist).toContain('/a folder/&lt;project&gt;&amp;&quot;');
  expect(plist).toContain('<key>KeepAlive</key><true/>');
  expect(plist).not.toContain('--reset-pairing');
  expect(plist).not.toContain('--ask');
  expect(() => launchAgent({ ...options, reset: true })).toThrow(
    'must not reset pairing',
  );
});

it('installs and uninstalls only its own user LaunchAgent, retaining paired credentials', async () => {
  const { home, options, plist } = setup();
  mkdirSync(options.directory);
  writeFileSync(join(options.directory, 'device-token'), 'paired');
  let loaded = false;
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'print')
      return { status: loaded ? 0 : 1, stdout: '', stderr: '' };
    loaded = args[0] === 'bootstrap';
    return { status: 0, stdout: '', stderr: '' };
  };
  const dependencies = {
    platform: 'darwin',
    home,
    uid: 501,
    run,
    state: async () => undefined,
  };
  await manageService('install', options, dependencies);
  expect(existsSync(plist)).toBe(true);
  expect(calls).toContainEqual(['bootstrap', 'gui/501', plist]);
  await manageService('uninstall', options, dependencies);
  expect(calls).toContainEqual(['bootout', 'gui/501/dev.agent-remote.gateway']);
  expect(existsSync(plist)).toBe(false);
  expect(readFileSync(join(options.directory, 'device-token'), 'utf8')).toBe(
    'paired',
  );
});

it('does not replace a running task or a foreground server and rolls back failed registration', async () => {
  const { home, options, plist } = setup();
  const dependencies = {
    platform: 'darwin',
    home,
    uid: 501,
    run: (args: string[]) => ({
      status: args[0] === 'print' ? 1 : 5,
      stdout: '',
      stderr: 'fixture failure',
    }),
  };
  await expect(
    manageService('install', options, {
      ...dependencies,
      state: async () => ({
        runId: 'run',
        permissionMode: 'allow-all',
        backends: [],
        tasks: [{ status: 'running' }],
      }),
    }),
  ).rejects.toThrow('Tasks are still running');
  await expect(
    manageService('install', options, {
      ...dependencies,
      state: async () => ({
        runId: 'run',
        permissionMode: 'allow-all',
        backends: [],
        tasks: [],
      }),
    }),
  ).rejects.toThrow('foreground gateway');
  await expect(
    manageService('install', options, {
      ...dependencies,
      state: async () => undefined,
    }),
  ).rejects.toThrow('fixture failure');
  expect(existsSync(plist)).toBe(false);
  await expect(
    manageService('install', options, { platform: 'linux' }),
  ).rejects.toThrow('currently supports macOS');
});

it('waits for a previously loaded job to disappear before bootstrapping its replacement', async () => {
  const { home, options } = setup();
  let phase = 'loaded';
  let pendingPrints = 2;
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'print')
      return {
        status:
          phase === 'loaded' || (phase === 'stopping' && pendingPrints-- > 0)
            ? 0
            : 1,
        stdout: '',
        stderr: '',
      };
    if (args[0] === 'bootout') phase = 'stopping';
    if (args[0] === 'bootstrap') {
      expect(pendingPrints).toBeLessThan(0);
      phase = 'loaded';
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  await manageService('install', options, {
    platform: 'darwin',
    home,
    uid: 501,
    run,
    state: async () => undefined,
  });
  expect(calls.filter((args) => args[0] === 'bootstrap')).toHaveLength(1);
});
