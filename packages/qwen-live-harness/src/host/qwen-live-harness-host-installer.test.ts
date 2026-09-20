/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_HOST_PROTOCOL_VERSION } from './types.js';
import { PACKAGE_VERSION } from '../version.js';
import {
  displayLiveError,
  displayLiveMessage,
  liveMessage,
  liveText,
} from '../i18n/messages.js';
import {
  downloadLiveHostRelease,
  isExpectedLiveHostSignature,
  LiveHostInstaller,
  LIVE_HOST_APP_PATH,
  LIVE_HOST_BUNDLE_ID,
  LIVE_HOST_DOWNLOAD_TIMEOUT_MS,
  LIVE_HOST_MANIFEST_FETCH_TIMEOUT_MS,
  LIVE_HOST_OSS_BASE_URL,
  LIVE_HOST_RELEASE_BASE_URL,
  parseLiveHostReleaseManifest,
  resolveLiveHostAssetUrls,
  resolveLiveHostManifestUrls,
} from './qwen-live-harness-host-installer.js';

const executeFile = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: string[],
      options: { signal?: AbortSignal },
    ) => Promise<{ stdout: string; stderr: string }>
  >(),
);

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return {
    execFile: Object.assign(vi.fn(), { [promisify.custom]: executeFile }),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const sha = 'a'.repeat(64);

beforeEach(() => executeFile.mockReset());
afterEach(() => vi.restoreAllMocks());

function mockVerifiedApp() {
  vi.spyOn(fsp, 'lstat').mockResolvedValue({
    isDirectory: () => true,
    isSymbolicLink: () => false,
  } as Awaited<ReturnType<typeof fsp.lstat>>);
  executeFile.mockImplementation(async (file, args) => {
    let stdout = '';
    let stderr = '';
    if (file === '/usr/bin/plutil') {
      stdout =
        {
          CFBundleIdentifier: LIVE_HOST_BUNDLE_ID,
          CFBundleShortVersionString: PACKAGE_VERSION,
          QwenLiveHarnessProtocolVersion: String(LIVE_HOST_PROTOCOL_VERSION),
        }[args[1]] ?? '';
    } else if (file === '/usr/bin/codesign' && args[0] === '-dv') {
      stderr =
        'Authority=Developer ID Application: Qwen\nTeamIdentifier=NF4574S59H';
    }
    return { stdout, stderr };
  });
}

function manifest() {
  return {
    schemaVersion: 1,
    version: PACKAGE_VERSION,
    protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    bundleId: 'com.alibaba.qwen-live-harness.host',
    assets: {
      arm64: {
        name: 'Qwen-Live-Harness-Host-arm64.zip',
        size: 123,
        sha256: sha,
      },
      x64: {
        name: 'Qwen-Live-Harness-Host-x64.zip',
        size: 456,
        sha256: sha,
      },
    },
  };
}

function manifestForBytes(version: string, bytes: Buffer) {
  const checksum = createHash('sha256').update(bytes).digest('hex');
  return {
    ...manifest(),
    version,
    assets: {
      arm64: {
        name: 'Qwen-Live-Harness-Host-arm64.zip',
        size: bytes.byteLength,
        sha256: checksum,
      },
      x64: {
        name: 'Qwen-Live-Harness-Host-x64.zip',
        size: bytes.byteLength,
        sha256: checksum,
      },
    },
  };
}

describe('LiveHostInstaller', () => {
  it('targets the new application identity without an old installation alias', () => {
    expect(LIVE_HOST_APP_PATH).toBe('/Applications/Qwen Live Harness Host.app');
    expect(LIVE_HOST_BUNDLE_ID).toBe('com.alibaba.qwen-live-harness.host');
  });

  it('prefers the OSS mirror and retains the independent GitHub fallback', () => {
    expect(LIVE_HOST_OSS_BASE_URL).toBe(
      'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/qwen-live-harness-host',
    );
    expect(LIVE_HOST_RELEASE_BASE_URL).toBe(
      'https://github.com/QwenLM/Qwen-Live-Harness/releases/download/qwen-live-harness-host-latest',
    );
    expect(resolveLiveHostManifestUrls()).toEqual([
      `${LIVE_HOST_OSS_BASE_URL}/latest/Qwen-Live-Harness-Host-manifest.json`,
      `${LIVE_HOST_RELEASE_BASE_URL}/Qwen-Live-Harness-Host-manifest.json`,
    ]);
    expect(
      resolveLiveHostAssetUrls('0.1.0', 'Qwen-Live-Harness-Host-arm64.zip'),
    ).toEqual([
      `${LIVE_HOST_OSS_BASE_URL}/v0.1.0/Qwen-Live-Harness-Host-arm64.zip`,
      `${LIVE_HOST_RELEASE_BASE_URL}/Qwen-Live-Harness-Host-arm64.zip`,
    ]);
  });

  it('falls back with a matching GitHub manifest and asset pair', async () => {
    const ossBytes = Buffer.from('oss-archive');
    const githubBytes = Buffer.from('github-archive');
    const ossManifest = manifestForBytes(PACKAGE_VERSION, ossBytes);
    const githubManifest = manifestForBytes(PACKAGE_VERSION, githubBytes);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(ossManifest))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(githubManifest))
      .mockResolvedValueOnce(
        new Response(githubBytes, {
          headers: { 'content-length': String(githubBytes.byteLength) },
        }),
      );
    const directory = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-live-harness-host-download-test-'),
    );
    const destination = path.join(directory, 'host.zip');

    try {
      const release = await downloadLiveHostRelease(
        'arm64',
        destination,
        () => {},
        fetchImpl,
      );
      expect(release.manifest).toEqual(githubManifest);
      await expect(fsp.readFile(destination)).resolves.toEqual(githubBytes);
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
        resolveLiveHostManifestUrls()[0],
        resolveLiveHostAssetUrls(
          ossManifest.version,
          ossManifest.assets.arm64.name,
        )[0],
        resolveLiveHostManifestUrls()[1],
        resolveLiveHostAssetUrls(
          githubManifest.version,
          githubManifest.assets.arm64.name,
        )[1],
      ]);
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  });

  it('removes a checksum-invalid OSS archive before falling back', async () => {
    const expectedOssBytes = Buffer.from('expected-oss-archive');
    const corruptOssBytes = Buffer.alloc(expectedOssBytes.byteLength, 0x78);
    const githubBytes = Buffer.from('github-archive');
    const ossManifest = manifestForBytes(PACKAGE_VERSION, expectedOssBytes);
    const githubManifest = manifestForBytes(PACKAGE_VERSION, githubBytes);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(ossManifest))
      .mockResolvedValueOnce(
        new Response(corruptOssBytes, {
          headers: { 'content-length': String(corruptOssBytes.byteLength) },
        }),
      )
      .mockResolvedValueOnce(Response.json(githubManifest))
      .mockResolvedValueOnce(
        new Response(githubBytes, {
          headers: { 'content-length': String(githubBytes.byteLength) },
        }),
      );
    const directory = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-live-harness-host-download-test-'),
    );
    const destination = path.join(directory, 'host.zip');

    try {
      const release = await downloadLiveHostRelease(
        'arm64',
        destination,
        () => {},
        fetchImpl,
      );
      expect(release.manifest).toEqual(githubManifest);
      await expect(fsp.readFile(destination)).resolves.toEqual(githubBytes);
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  });

  it('reports both source failures and removes the destination', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const directory = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-live-harness-host-download-test-'),
    );
    const destination = path.join(directory, 'host.zip');

    try {
      await expect(
        downloadLiveHostRelease('arm64', destination, () => {}, fetchImpl),
      ).rejects.toMatchObject({
        message:
          'Qwen Live Harness Host download failed. OSS: Qwen Live Harness Host manifest download failed (503). GitHub: Qwen Live Harness Host manifest download failed (503).',
        errors: [
          {
            message:
              'OSS: Qwen Live Harness Host manifest download failed (503).',
          },
          {
            message:
              'GitHub: Qwen Live Harness Host manifest download failed (503).',
          },
        ],
      });
      await expect(fsp.stat(destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  });

  it('passes separate bounded signals to manifest and archive requests', async () => {
    const bytes = Buffer.from('signed-qwen-live-harness-host-archive');
    const expected = manifestForBytes(PACKAGE_VERSION, bytes);
    const manifestSignal = AbortSignal.abort('manifest');
    const downloadSignal = AbortSignal.abort('download');
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(manifestSignal)
      .mockReturnValueOnce(downloadSignal);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(expected))
      .mockResolvedValueOnce(new Response(bytes));
    const directory = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-live-harness-host-download-test-'),
    );
    const destination = path.join(directory, 'host.zip');

    try {
      await downloadLiveHostRelease('arm64', destination, () => {}, fetchImpl);
      expect(LIVE_HOST_MANIFEST_FETCH_TIMEOUT_MS).toBe(5 * 60 * 1000);
      expect(LIVE_HOST_DOWNLOAD_TIMEOUT_MS).toBe(60 * 60 * 1000);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(manifestSignal);
      expect(fetchImpl.mock.calls[1]?.[1]?.signal).toBe(downloadSignal);
    } finally {
      timeout.mockRestore();
      await fsp.rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts only the Qwen Developer ID team', () => {
    expect(
      isExpectedLiveHostSignature(
        [
          'Authority=Developer ID Application: Alibaba Cloud (Singapore) Private Limited (NF4574S59H)',
          'TeamIdentifier=NF4574S59H',
        ].join('\n'),
      ),
    ).toBe(true);
    expect(
      isExpectedLiveHostSignature(
        'Authority=Developer ID Application: Other\nTeamIdentifier=OTHER12345',
      ),
    ).toBe(false);
    expect(
      isExpectedLiveHostSignature('Signature=adhoc\nTeamIdentifier=NF4574S59H'),
    ).toBe(false);
  });

  it('accepts only the fixed compatible release manifest', () => {
    expect(parseLiveHostReleaseManifest(manifest())).toEqual(manifest());
    expect(() =>
      parseLiveHostReleaseManifest({
        ...manifest(),
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION + 1,
      }),
    ).toThrow(liveText('en', 'installer.manifestIncompatible'));
    expect(() =>
      parseLiveHostReleaseManifest({
        ...manifest(),
        assets: {
          ...manifest().assets,
          arm64: { ...manifest().assets.arm64, name: 'other.zip' },
        },
      }),
    ).toThrow(liveText('en', 'installer.assetInvalid'));
  });

  it.each(['0.3.0', '999.0.0'])(
    'rejects a downloaded Host version that does not match the CLI (%s)',
    (version) => {
      expect(() =>
        parseLiveHostReleaseManifest({ ...manifest(), version }),
      ).toThrow(
        liveText('en', 'installer.versionMismatch', {
          installed: version,
          required: PACKAGE_VERSION,
        }),
      );
    },
  );

  it('rejects retired bundle identities and archive names', () => {
    expect(() =>
      parseLiveHostReleaseManifest({
        ...manifest(),
        bundleId: 'com.alibaba.qwen-code.live-host',
      }),
    ).toThrow(liveText('en', 'installer.manifestIncompatible'));
    for (const architecture of ['arm64', 'x64'] as const) {
      expect(() =>
        parseLiveHostReleaseManifest({
          ...manifest(),
          assets: {
            ...manifest().assets,
            [architecture]: {
              ...manifest().assets[architecture],
              name: `Qwen-Live-Host-${architecture}.zip`,
            },
          },
        }),
      ).toThrow(liveText('en', 'installer.assetInvalid'));
    }
  });

  it('does not fetch archives or old feeds when both new feeds return retired manifests', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        ...manifest(),
        bundleId: 'com.alibaba.qwen-code.live-host',
      }),
    );
    const directory = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-live-harness-host-old-feed-test-'),
    );
    const destination = path.join(directory, 'host.zip');
    try {
      await expect(
        downloadLiveHostRelease('arm64', destination, () => {}, fetchImpl),
      ).rejects.toThrow(liveText('en', 'installer.manifestIncompatible'));
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
        resolveLiveHostManifestUrls(),
      );
      await expect(fsp.stat(destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  });

  it('launches an existing verified installation without downloading', async () => {
    const inspectInstalled = vi.fn(async () => ({
      version: PACKAGE_VERSION,
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    }));
    const installLatest = vi.fn();
    const launch = vi.fn(async () => {});
    const installer = new LiveHostInstaller({
      platform: 'darwin',
      architecture: 'arm64',
      inspectInstalled,
      installLatest,
      launch,
    });

    await expect(installer.ensureInstalled()).resolves.toEqual({
      state: 'installed',
      version: PACKAGE_VERSION,
    });
    expect(installLatest).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    'prepares a Host installation without launching during init (already installed: %s)',
    async (alreadyInstalled) => {
      const ready = {
        version: PACKAGE_VERSION,
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      };
      const installLatest = vi.fn(async () => ready);
      const launch = vi.fn(async () => {});
      const installer = new LiveHostInstaller({
        platform: 'darwin',
        architecture: 'arm64',
        inspectInstalled: async () => (alreadyInstalled ? ready : undefined),
        installLatest,
        launch,
      });

      await expect(
        installer.ensureInstalled(false, { launch: false }),
      ).resolves.toEqual({
        state: 'installed',
        version: PACKAGE_VERSION,
      });
      expect(installLatest).toHaveBeenCalledTimes(alreadyInstalled ? 0 : 1);
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it('passes CLI discovery, debug and connection-only settings when opening a verified Host', async () => {
    const launch = vi.fn(async () => {});
    const installer = new LiveHostInstaller({
      platform: 'darwin',
      architecture: 'arm64',
      inspectInstalled: async () => ({
        version: PACKAGE_VERSION,
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      }),
      launch,
    });
    const options = {
      debug: true,
      discoveryPath: '/tmp/custom-harness-discovery/run/daemon.json',
      connectOnly: true,
    };

    await expect(installer.launch(options)).resolves.toEqual({
      state: 'installed',
      version: PACKAGE_VERSION,
    });

    expect(launch).toHaveBeenCalledExactlyOnceWith(options);
  });

  it('does no inspection or opening when launch is already cancelled', async () => {
    const inspectInstalled = vi.fn();
    const launch = vi.fn();
    const onStage = vi.fn();
    const installer = new LiveHostInstaller({
      platform: 'darwin',
      inspectInstalled,
      launch,
    });
    const reason = new Error('cancelled before launch');
    await expect(
      installer.launch({ signal: AbortSignal.abort(reason), onStage }),
    ).rejects.toBe(reason);
    expect(inspectInstalled).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(onStage).not.toHaveBeenCalled();
  });

  it('cancels a slow inspection immediately and never opens after it finishes', async () => {
    let finish: (value: {
      version: string;
      protocolVersion: number;
    }) => void = () => {};
    const inspectInstalled = vi.fn(
      () =>
        new Promise<{ version: string; protocolVersion: number }>((resolve) => {
          finish = resolve;
        }),
    );
    const launch = vi.fn();
    const onStage = vi.fn();
    const installer = new LiveHostInstaller({
      platform: 'darwin',
      inspectInstalled,
      launch,
    });
    const controller = new AbortController();
    const operation = installer.launch({ signal: controller.signal, onStage });
    const reason = new Error('cancelled during inspection');
    const assertion = expect(operation).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
    finish({
      version: PACKAGE_VERSION,
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    });
    await Promise.resolve();
    expect(inspectInstalled).toHaveBeenCalledExactlyOnceWith(controller.signal);
    expect(launch).not.toHaveBeenCalled();
    expect(onStage.mock.calls).toEqual([['checking']]);
    expect(installer.getStatus().state).not.toBe('installed');
  });

  it('checks cancellation after the opening-stage callback', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before opening');
    const launch = vi.fn();
    const installer = new LiveHostInstaller({
      platform: 'darwin',
      inspectInstalled: async () => ({
        version: PACKAGE_VERSION,
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      }),
      launch,
    });
    await expect(
      installer.launch({
        signal: controller.signal,
        onStage: (stage) => {
          if (stage === 'opening') controller.abort(reason);
        },
      }),
    ).rejects.toBe(reason);
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not report success when cancellation wins during opening', async () => {
    let finish: () => void = () => {};
    const launch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const installer = new LiveHostInstaller({
      platform: 'darwin',
      inspectInstalled: async () => ({
        version: PACKAGE_VERSION,
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      }),
      launch,
    });
    const controller = new AbortController();
    const reason = new Error('cancelled while opening');
    const operation = installer.launch({ signal: controller.signal });
    const assertion = expect(operation).rejects.toBe(reason);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    controller.abort(reason);
    await assertion;
    finish();
    await Promise.resolve();
    expect(installer.getStatus().state).not.toBe('installed');
  });

  it('passes the same cancellation signal through every validation command and open, with its CLI owner', async () => {
    mockVerifiedApp();
    const controller = new AbortController();
    const onStage = vi.fn();
    const installer = new LiveHostInstaller({ platform: 'darwin' });
    await expect(
      installer.launch({
        signal: controller.signal,
        owner: { pid: 4321, instanceNonce: 'abcdefghijklmnop' },
        discoveryPath: '/tmp/harness-launch/run/daemon.json',
        debug: true,
        connectOnly: true,
        onStage,
      }),
    ).resolves.toEqual({ state: 'installed', version: PACKAGE_VERSION });
    expect(executeFile.mock.calls.map(([file]) => file)).toEqual([
      '/usr/bin/plutil',
      '/usr/bin/plutil',
      '/usr/bin/plutil',
      '/usr/bin/codesign',
      '/usr/bin/codesign',
      '/usr/sbin/spctl',
      '/usr/bin/open',
    ]);
    expect(
      executeFile.mock.calls.map(([, , options]) => options.signal),
    ).toEqual(Array(7).fill(controller.signal));
    expect(executeFile).toHaveBeenLastCalledWith(
      '/usr/bin/open',
      [
        LIVE_HOST_APP_PATH,
        '--args',
        '--live-harness-debug',
        '--qwen-live-harness-connect-only',
        '--qwen-live-harness-discovery-file=/tmp/harness-launch/run/daemon.json',
        '--qwen-live-harness-owner=4321:abcdefghijklmnop',
      ],
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(onStage.mock.calls).toEqual([['checking'], ['opening']]);
  });

  it.each([
    ['protocol', '/usr/bin/plutil', 'QwenLiveHarnessProtocolVersion'],
    ['signature verification', '/usr/bin/codesign', '--verify'],
    ['signature identity', '/usr/bin/codesign', '-dv'],
    ['Gatekeeper', '/usr/sbin/spctl', '-a'],
  ])(
    'does not continue after cancellation during %s',
    async (_name, file, arg) => {
      mockVerifiedApp();
      const inspect = executeFile.getMockImplementation()!;
      const controller = new AbortController();
      const reason = new Error('cancelled while verifying Host');
      executeFile.mockImplementation(async (command, args, options) => {
        if (command === file && args.includes(arg)) {
          controller.abort(reason);
          throw reason;
        }
        return inspect(command, args, options);
      });
      const installer = new LiveHostInstaller({ platform: 'darwin' });
      await expect(
        installer.launch({ signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(executeFile.mock.calls.at(-1)?.[0]).toBe(file);
      expect(
        executeFile.mock.calls.some(([command]) => command === '/usr/bin/open'),
      ).toBe(false);
    },
  );

  it('retains a retryable inspection error without opening the application', async () => {
    const launch = vi.fn();
    const installer = new LiveHostInstaller({
      platform: 'darwin',
      inspectInstalled: async () => {
        throw new Error('signature verification failed');
      },
      launch,
    });
    await expect(installer.launch()).resolves.toEqual({
      state: 'error',
      message: liveMessage('installer.setupFailed'),
      retryable: true,
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it('replaces an installed Host with an incompatible protocol', async () => {
    const installLatest = vi.fn(async () => ({
      version: PACKAGE_VERSION,
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    }));
    const installer = new LiveHostInstaller({
      platform: 'darwin',
      architecture: 'arm64',
      inspectInstalled: async () => ({
        version: PACKAGE_VERSION,
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION - 1,
      }),
      installLatest,
      launch: async () => {},
    });

    await expect(installer.ensureInstalled()).resolves.toEqual({
      state: 'installed',
      version: PACKAGE_VERSION,
    });
    expect(installLatest).toHaveBeenCalledOnce();
  });

  it.each(['0.3.0', '999.0.0'])(
    'offers replacement and refuses to launch an unpaired installed Host (%s)',
    async (version) => {
      const installLatest = vi.fn(async () => ({
        version: PACKAGE_VERSION,
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      }));
      const launch = vi.fn(async () => {});
      const installer = new LiveHostInstaller({
        platform: 'darwin',
        architecture: 'arm64',
        inspectInstalled: async () => ({
          version,
          protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
        }),
        installLatest,
        launch,
      });

      await expect(installer.refresh()).resolves.toEqual({ state: 'missing' });
      const rejectedLaunch = await installer.launch();
      expect(rejectedLaunch).toMatchObject({ state: 'error', retryable: true });
      expect(displayLiveMessage('en', rejectedLaunch.message!)).toContain(
        liveText('en', 'installer.versionMismatch', {
          installed: version,
          required: PACKAGE_VERSION,
        }),
      );
      expect(launch).not.toHaveBeenCalled();

      await expect(
        installer.ensureInstalled(false, { launch: false }),
      ).resolves.toEqual({
        state: 'installed',
        version: PACKAGE_VERSION,
      });
      expect(installLatest).toHaveBeenCalledOnce();
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it('coalesces concurrent installs and exposes progress', async () => {
    let finish:
      | ((value: { version: string; protocolVersion: number }) => void)
      | undefined;
    const installLatest = vi.fn(
      async (
        _architecture: 'arm64' | 'x64',
        onStatus: (status: { state: 'downloading'; progress: number }) => void,
      ) => {
        onStatus({ state: 'downloading', progress: 0.5 });
        return await new Promise<{
          version: string;
          protocolVersion: number;
        }>((resolve) => {
          finish = resolve;
        });
      },
    );
    const installer = new LiveHostInstaller({
      platform: 'darwin',
      architecture: 'x64',
      inspectInstalled: async () => undefined,
      installLatest,
      launch: async () => {},
    });

    const first = installer.ensureInstalled();
    const second = installer.ensureInstalled();
    await vi.waitFor(() => {
      expect(installer.getStatus()).toEqual({
        state: 'downloading',
        progress: 0.5,
      });
    });
    finish?.({
      version: PACKAGE_VERSION,
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    });
    await expect(first).resolves.toMatchObject({ state: 'installed' });
    await expect(second).resolves.toMatchObject({ state: 'installed' });
    expect(installLatest).toHaveBeenCalledOnce();
  });

  it('fails closed on unsupported platforms and architectures', async () => {
    const installLatest = vi.fn();
    const linux = new LiveHostInstaller({
      platform: 'linux',
      architecture: 'x64',
      installLatest,
    });
    await expect(linux.ensureInstalled()).resolves.toMatchObject({
      state: 'error',
      retryable: false,
    });
    expect(displayLiveMessage('zh-CN', linux.getStatus().message ?? '')).toBe(
      'Qwen Live Harness Host 仅支持 macOS。',
    );

    const unsupported = new LiveHostInstaller({
      platform: 'darwin',
      architecture: 'ia32',
      inspectInstalled: async () => undefined,
      installLatest,
    });
    await expect(unsupported.ensureInstalled()).resolves.toMatchObject({
      state: 'error',
      retryable: true,
    });
    expect(
      displayLiveMessage('en', unsupported.getStatus().message ?? ''),
    ).toContain('architecture ia32');
    expect(
      displayLiveMessage('zh-CN', unsupported.getStatus().message ?? ''),
    ).toContain('不支持 ia32 架构');
    expect(installLatest).not.toHaveBeenCalled();
  });

  it('keeps an installation failure retryable', async () => {
    const installer = new LiveHostInstaller({
      platform: 'darwin',
      architecture: 'arm64',
      inspectInstalled: async () => undefined,
      installLatest: async () => {
        throw new Error('checksum verification failed');
      },
      launch: async () => {},
    });

    await expect(installer.ensureInstalled()).resolves.toEqual({
      state: 'error',
      message: liveMessage('installer.setupFailed'),
      retryable: true,
    });
  });

  it.each(['en', 'zh-CN'] as const)(
    'uses a safe localized fallback for unknown exceptions in %s',
    async (language) => {
      const raw = 'PRIVATE_INSTALL_DETAIL /Users/private/key sk-secret';
      for (const failure of [
        new Error(raw),
        raw,
        { message: raw },
        undefined,
      ]) {
        const installer = new LiveHostInstaller({
          platform: 'darwin',
          inspectInstalled: async () => {
            throw failure;
          },
        });
        const result = await installer.refresh();
        expect(result).toEqual({
          state: 'error',
          message: liveMessage('installer.setupFailed'),
          retryable: true,
        });
        const displayed = displayLiveError(
          language,
          result.message,
          'init.unknownError',
        );
        expect(displayed).toBe(liveText(language, 'installer.setupFailed'));
        expect(displayed).not.toMatch(
          /PRIVATE_INSTALL_DETAIL|\/Users\/private|sk-secret/,
        );
      }
    },
  );

  it.each(['en', 'zh-CN'] as const)(
    'localizes nested source errors without exposing unknown causes in %s',
    async (language) => {
      const raw = 'PRIVATE_SOURCE_DETAIL /Users/private/key sk-secret';
      const unknown = new Error(raw);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(unknown)
        .mockResolvedValueOnce(new Response(null, { status: 503 }));
      const directory = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-live-harness-installer-errors-'),
      );
      let diagnostic: unknown;
      const installer = new LiveHostInstaller({
        platform: 'darwin',
        architecture: 'arm64',
        inspectInstalled: async () => undefined,
        installLatest: async (arch) => {
          try {
            const { manifest } = await downloadLiveHostRelease(
              arch,
              path.join(directory, 'host.zip'),
              () => {},
              fetchImpl,
            );
            return {
              version: manifest.version,
              protocolVersion: manifest.protocolVersion,
            };
          } catch (error) {
            diagnostic = error;
            throw error;
          }
        },
      });
      try {
        const result = await installer.ensureInstalled(false, {
          launch: false,
        });
        const displayed = displayLiveError(
          language,
          result.message,
          'init.unknownError',
        );
        expect(result).toMatchObject({ state: 'error', retryable: true });
        expect(displayed).toBe(
          liveText(language, 'installer.sourcesFailed', {
            oss: liveText(language, 'installer.setupFailed'),
            github: liveText(language, 'installer.manifestDownload', {
              status: 503,
            }),
          }),
        );
        expect(displayed).not.toMatch(
          /PRIVATE_SOURCE_DETAIL|\/Users\/private|sk-secret|qwen-live-harness-ui:/,
        );
        expect(diagnostic).toBeInstanceOf(AggregateError);
        expect((diagnostic as AggregateError).errors[0].cause).toBe(unknown);
        expect((diagnostic as AggregateError).message).toContain(raw);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        await fsp.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(['en', 'zh-CN'] as const)(
    'retains a known installer error through multiple diagnostic wrappers in %s',
    async (language) => {
      let known: unknown;
      try {
        parseLiveHostReleaseManifest({});
      } catch (error) {
        known = error;
      }
      const diagnostic = new Error('PRIVATE_OUTER_DETAIL', {
        cause: new Error('PRIVATE_INNER_DETAIL', { cause: known }),
      });
      const installer = new LiveHostInstaller({
        platform: 'darwin',
        inspectInstalled: async () => {
          throw diagnostic;
        },
      });
      const result = await installer.refresh();
      expect(result.message).toBe(liveMessage('installer.manifestInvalid'));
      expect(
        displayLiveError(language, result.message, 'init.unknownError'),
      ).toBe(liveText(language, 'installer.manifestInvalid'));
      expect(diagnostic.cause).toMatchObject({ cause: known });
    },
  );

  it('falls back safely for a cyclic diagnostic cause', async () => {
    const error = new Error('PRIVATE_CYCLE_DETAIL');
    error.cause = error;
    const installer = new LiveHostInstaller({
      platform: 'darwin',
      inspectInstalled: async () => {
        throw error;
      },
    });
    const result = await installer.refresh();
    expect(result.message).toBe(liveMessage('installer.setupFailed'));
    expect(error.cause).toBe(error);
  });
});
