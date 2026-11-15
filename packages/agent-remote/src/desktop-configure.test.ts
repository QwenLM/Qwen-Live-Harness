import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  desktopCommand,
  loadDesktopConfig,
  saveDesktopConfig,
} from './desktop.js';
import { localRequest } from './client.js';
import { manageService } from './service.js';

vi.mock('./client.js', () => ({ localRequest: vi.fn() }));
vi.mock('./service.js', async (original) => ({
  ...(await original<typeof import('./service.js')>()),
  manageService: vi.fn(),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

let directory: string;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('process', { ...process, platform: 'darwin' });
  directory = mkdtempSync(join(tmpdir(), 'remote-configure-'));
  vi.stubEnv('AGENT_REMOTE_DATA_DIR', directory);
  saveDesktopConfig(directory, {
    version: 1,
    projects: [directory],
    port: 47421,
    ask: false,
    launchAtLogin: true,
  });
  vi.mocked(localRequest).mockResolvedValue({
    runId: 'owned-run',
    projects: [{ path: directory }],
    permissionMode: 'allow-all',
    tasks: [],
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

it('persists and clears the public host through a guarded idle-service restart', async () => {
  await desktopCommand(['configure', '--public-host', ' Remote.Example.test ']);
  expect(loadDesktopConfig(directory).publicHost).toBe('remote.example.test');
  expect(vi.mocked(manageService)).toHaveBeenCalledWith(
    'install',
    expect.objectContaining({
      publicHost: 'remote.example.test',
      projects: [directory],
      reset: false,
      ask: false,
    }),
  );
  await desktopCommand(['configure', '--public-host', '']);
  expect(loadDesktopConfig(directory).publicHost).toBeUndefined();
  expect(vi.mocked(manageService)).toHaveBeenLastCalledWith(
    'install',
    expect.objectContaining({ publicHost: undefined, reset: false }),
  );
});

it.each(['running', 'cancelling'])(
  'keeps configuration and the service intact while a task is %s',
  async (status) => {
    vi.mocked(localRequest).mockResolvedValue({ tasks: [{ status }] });
    const original = readFileSync(
      join(directory, 'desktop-config.json'),
      'utf8',
    );
    await expect(
      desktopCommand(['configure', '--public-host', 'remote.example.test']),
    ).rejects.toThrow('Tasks are running');
    expect(readFileSync(join(directory, 'desktop-config.json'), 'utf8')).toBe(
      original,
    );
    expect(manageService).not.toHaveBeenCalled();
  },
);

it('does not replace a loaded service whose task state cannot be verified', async () => {
  vi.mocked(localRequest).mockRejectedValue(new Error('unreachable'));
  await expect(
    desktopCommand(['configure', '--public-host', 'remote.example.test']),
  ).rejects.toThrow('task state cannot be verified');
  expect(loadDesktopConfig(directory).publicHost).toBeUndefined();
  expect(manageService).not.toHaveBeenCalled();
});

it('keeps the saved host when registration fails and rejects malformed hosts before mutation', async () => {
  vi.mocked(manageService).mockRejectedValueOnce(
    new Error('registration failed'),
  );
  await expect(
    desktopCommand(['configure', '--public-host', 'remote.example.test']),
  ).rejects.toThrow('registration failed');
  expect(loadDesktopConfig(directory).publicHost).toBeUndefined();
  vi.mocked(manageService).mockClear();
  await expect(
    desktopCommand(['configure', '--public-host', 'remote.example.test:47421']),
  ).rejects.toThrow('DNS hostname or IPv4');
  expect(manageService).not.toHaveBeenCalled();
});
