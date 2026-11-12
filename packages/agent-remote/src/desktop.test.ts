import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyLoginRegistration,
  legacyConfig,
  loadDesktopConfig,
  saveDesktopConfig,
  serviceFile,
  validateDesktopConfig,
} from './desktop.js';
import { gatewayServiceLabel, launchAgent } from './service.js';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    );
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'remote-desktop-'));
  directories.push(path);
  return path;
}

it('imports projects, fixed port and approval policy from an existing CLI registration', () => {
  expect(
    legacyConfig([
      '/node',
      '/cli.js',
      'start',
      '--project',
      '/project with spaces',
      '--port',
      '47422',
      '--project',
      '/second',
    ]),
  ).toEqual({
    version: 1,
    projects: ['/project with spaces', '/second'],
    port: 47422,
    ask: false,
    launchAtLogin: true,
  });
  expect(
    legacyConfig(['/node', '/cli.js', '--project', '/project', '--ask'])?.ask,
  ).toBe(true);
  expect(legacyConfig(['unrelated command'])).toBeUndefined();
});
it('saves desktop settings privately without touching a paired identity', () => {
  const path = directory();
  writeFileSync(join(path, 'device-token'), 'existing token');
  const config = {
    version: 1 as const,
    projects: ['/fixture'],
    port: 47421,
    ask: false,
    launchAtLogin: true,
  };
  saveDesktopConfig(path, config);
  expect(loadDesktopConfig(path, directory())).toEqual(config);
  expect(readFileSync(join(path, 'device-token'), 'utf8')).toBe(
    'existing token',
  );
  expect(statSync(join(path, 'desktop-config.json')).mode & 0o777).toBe(0o600);
});
it('does not overwrite malformed settings or follow a configuration symlink', () => {
  const path = directory();
  writeFileSync(join(path, 'desktop-config.json'), '{not json');
  expect(() => loadDesktopConfig(path)).toThrow();
  rmSync(join(path, 'desktop-config.json'));
  writeFileSync(join(path, 'target'), 'keep');
  symlinkSync(join(path, 'target'), join(path, 'desktop-config.json'));
  expect(() =>
    saveDesktopConfig(path, {
      version: 1,
      projects: [],
      port: 47421,
      ask: false,
      launchAtLogin: true,
    }),
  ).toThrow('regular file');
  expect(readFileSync(join(path, 'target'), 'utf8')).toBe('keep');
});
it('limits launchd management to its own namespace, including isolated fixture labels', () => {
  vi.stubEnv(
    'AGENT_REMOTE_SERVICE_LABEL',
    'dev.agent-remote.gateway.fixture-123',
  );
  expect(gatewayServiceLabel()).toBe('dev.agent-remote.gateway.fixture-123');
  expect(serviceFile('/fixture')).toContain(
    'dev.agent-remote.gateway.fixture-123.plist',
  );
  expect(
    launchAgent({
      directory: '/state',
      projects: ['/project'],
      port: 47421,
      ask: false,
      reset: false,
      open: false,
    }),
  ).toContain('<string>dev.agent-remote.gateway.fixture-123</string>');
  vi.stubEnv('AGENT_REMOTE_SERVICE_LABEL', 'com.apple.unrelated');
  expect(() => gatewayServiceLabel()).toThrow('Invalid Agent Remote');
});
it('rejects invalid ports and non-absolute paths before installing a service', () => {
  expect(() =>
    validateDesktopConfig({
      version: 1,
      projects: ['relative'],
      port: 47421,
      ask: false,
      launchAtLogin: true,
    }),
  ).toThrow();
  expect(() =>
    validateDesktopConfig({
      version: 1,
      projects: ['/project'],
      port: 0,
      ask: false,
      launchAtLogin: true,
    }),
  ).toThrow();
});
it('disables only the specified login registration without deleting credentials', () => {
  const home = directory();
  const path = serviceFile(home);
  // Use saveDesktopConfig only for its private state directory; the registration
  // file itself is fixture data and never goes through the real launchctl.
  const parent = join(home, 'Library/LaunchAgents');
  saveDesktopConfig(parent, {
    version: 1,
    projects: [],
    port: 47421,
    ask: false,
    launchAtLogin: true,
  });
  writeFileSync(path, 'owned registration');
  writeFileSync(join(home, 'device-token'), 'paired');
  applyLoginRegistration(false, home);
  expect(() => readFileSync(path)).toThrow();
  expect(readFileSync(join(home, 'device-token'), 'utf8')).toBe('paired');
});
