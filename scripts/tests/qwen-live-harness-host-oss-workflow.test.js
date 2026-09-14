/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getWorkflowJob, getWorkflowStep } from './workflow-helpers.js';

const releaseWorkflow = readFileSync(
  '.github/workflows/qwen-live-harness-host-release.yml',
  'utf8',
);
const syncWorkflow = readFileSync(
  '.github/workflows/sync-qwen-live-harness-host-to-oss.yml',
  'utf8',
);

describe('Qwen Live Harness Host OSS mirror workflow', () => {
  it('keeps the renamed build, publish and mirror artifact identity aligned', () => {
    const build = getWorkflowJob(releaseWorkflow, 'build');
    const download = getWorkflowStep(
      getWorkflowJob(releaseWorkflow, 'publish'),
      'Download packaged Host',
    );
    const mirror = getWorkflowStep(
      getWorkflowJob(syncWorkflow, 'sync'),
      'Download release workflow artifact',
    );
    for (const source of [build, download, mirror]) {
      expect(source).toContain("name: 'qwen-live-harness-host-macos'");
    }
    expect(download).not.toContain('merge-multiple: true');
    expect(releaseWorkflow).toContain(
      "uses: './.github/workflows/sync-qwen-live-harness-host-to-oss.yml'",
    );
  });

  it('publishes exactly the renamed tags and downloads the same installer feed', () => {
    const installer = readFileSync(
      'packages/qwen-live-harness/src/host/qwen-live-harness-host-installer.ts',
      'utf8',
    );
    const prepare = getWorkflowStep(
      getWorkflowJob(releaseWorkflow, 'prepare'),
      'Resolve version',
    );
    expect(prepare).toContain('tag=qwen-live-harness-host-v$version');
    expect(releaseWorkflow).toContain(
      "QWEN_LIVE_HARNESS_HOST_FEED_TAG: 'qwen-live-harness-host-latest'",
    );
    expect(releaseWorkflow).toContain(
      '${{ env.QWEN_LIVE_HARNESS_HOST_FEED_TAG }}',
    );
    expect(syncWorkflow).toContain(
      'gh release view "qwen-live-harness-host-v${VERSION}"',
    );
    expect(installer).toContain(
      'https://github.com/QwenLM/Qwen-Live-Harness/releases/download/qwen-live-harness-host-latest',
    );
    expect(installer).toContain(
      'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/qwen-live-harness-host',
    );
    for (const source of [releaseWorkflow, syncWorkflow, installer]) {
      expect(source).toContain('Qwen-Live-Harness-Host-manifest.json');
      expect(source).not.toMatch(/(?:qwen-live-host|Qwen-Live-Host)/u);
    }
  });

  it.each([
    ['build', 'Verify release assets', 'release'],
    ['sync', 'Verify release assets', 'dist/qwen-live-harness-host'],
    ['sync', 'Verify versioned assets on Aliyun OSS', 'mirrored'],
  ])(
    'rejects stale manifest identities at %s / %s',
    (job, stepName, assetDir) => {
      const source = job === 'build' ? releaseWorkflow : syncWorkflow;
      const step = getWorkflowStep(getWorkflowJob(source, job), stepName);
      const script = step.match(
        /node --input-type=module -e '([\s\S]*?)\n +'/u,
      )?.[1];
      expect(script).toBeTruthy();
      const root = mkdtempSync(
        join(tmpdir(), 'qwen-live-harness-release-test-'),
      );
      const directory = join(root, assetDir);
      mkdirSync(directory, { recursive: true });
      const assets = {};
      for (const architecture of ['arm64', 'x64']) {
        const name = `Qwen-Live-Harness-Host-${architecture}.zip`;
        const bytes = Buffer.from(`synthetic ${architecture} archive`);
        writeFileSync(join(directory, name), bytes);
        assets[architecture] = {
          name,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }
      const manifest = {
        schemaVersion: 1,
        version: '0.3.0',
        protocolVersion: 9,
        bundleId: 'com.alibaba.qwen-live-harness.host',
        assets,
      };
      function verify(value) {
        writeFileSync(
          join(directory, 'Qwen-Live-Harness-Host-manifest.json'),
          JSON.stringify(value),
        );
        return spawnSync(
          process.execPath,
          ['--input-type=module', '-e', script],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              VERSION: manifest.version,
              RELEASE_VERSION: manifest.version,
              DIRECTORY: directory,
            },
          },
        );
      }
      try {
        expect(verify(manifest).status).toBe(0);
        const renamedFileOnly = verify({
          ...manifest,
          bundleId: 'other.product',
        });
        expect(renamedFileOnly.status).not.toBe(0);
        expect(renamedFileOnly.stderr).toContain(
          'matching Qwen Live Harness Host',
        );
        expect(verify({ ...manifest, protocolVersion: 7 }).status).not.toBe(0);
        expect(
          verify({
            ...manifest,
            assets: {
              ...assets,
              arm64: { ...assets.arm64, name: 'Other-Host-arm64.zip' },
            },
          }).status,
        ).not.toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('grants the reusable mirror workflow its required token permissions', () => {
    expect(releaseWorkflow).toContain(
      "permissions:\n  actions: 'read'\n  contents: 'read'",
    );
  });

  it('runs only after a stable Qwen Live Harness Host release or a manual re-run', () => {
    expect(syncWorkflow).not.toContain('pull_request:');
    expect(syncWorkflow).not.toContain('dry_run');

    const syncOss = getWorkflowJob(releaseWorkflow, 'sync-oss');
    expect(syncOss).toContain(
      "if: \"${{ github.event_name == 'workflow_dispatch' && inputs.dry_run == false && inputs.draft == false && inputs.prerelease == false && github.repository == 'QwenLM/Qwen-Live-Harness' }}\"",
    );
    expect(syncOss).toContain("- 'publish'");
    expect(syncOss).toContain("source: 'artifact'");
    expect(syncOss).not.toContain('secrets: inherit');
    expect(syncOss).toContain(
      "ALIYUN_OSS_ACCESS_KEY_ID: '${{ secrets.ALIYUN_OSS_ACCESS_KEY_ID }}'",
    );
    expect(syncOss).toContain(
      "ALIYUN_OSS_ACCESS_KEY_SECRET: '${{ secrets.ALIYUN_OSS_ACCESS_KEY_SECRET }}'",
    );
    expect(syncWorkflow).toContain(
      'ALIYUN_OSS_ACCESS_KEY_ID:\n        required: true',
    );
    expect(syncWorkflow).toContain(
      'ALIYUN_OSS_ACCESS_KEY_SECRET:\n        required: true',
    );
  });

  it('rejects a prerelease version that could update the stable feed', () => {
    const prepare = getWorkflowJob(releaseWorkflow, 'prepare');
    const resolveVersion = getWorkflowStep(prepare, 'Resolve version');
    expect(resolveVersion).toContain('if [[ "$version" == *-* ]]');
    expect(resolveVersion).toContain(
      'if [ "$version_is_prerelease" != "${{ inputs.prerelease }}" ]',
    );
    expect(resolveVersion).toContain(
      '::error::The prerelease input must match the Qwen Live Harness Host version.',
    );
  });

  it('serializes releases and rejects stable feed downgrades', () => {
    expect(releaseWorkflow).toContain(
      "github.event_name == 'workflow_dispatch' && 'qwen-live-harness-host-release'",
    );

    const updateFeed = getWorkflowStep(
      getWorkflowJob(releaseWorkflow, 'publish'),
      'Update stable Qwen Live Harness Host feed',
    );
    expect(updateFeed).toContain(
      'gh release download "$FEED_TAG" --pattern \'Qwen-Live-Harness-Host-manifest.json\'',
    );
    expect(updateFeed).toContain('sort -V | tail -n 1');
    expect(updateFeed).toContain(
      '::error::Refusing to replace Qwen Live Harness Host feed v$current_version with older v$RELEASE_VERSION.',
    );
  });

  it('uploads and verifies one release without an OSS state machine', () => {
    const sync = getWorkflowJob(syncWorkflow, 'sync');
    expect(sync).toContain("name: 'production-release'");
    expect(sync).not.toContain('check-qwen-live-harness-host-oss-state');
    expect(sync).not.toContain('allow-hidden-missing');

    const versionUpload = getWorkflowStep(
      sync,
      'Upload versioned assets to Aliyun OSS',
    );
    expect(versionUpload).toContain(
      '--prefix "qwen-live-harness-host/v${VERSION}"',
    );

    const latestUpload = getWorkflowStep(
      sync,
      'Publish latest manifest to Aliyun OSS',
    );
    expect(latestUpload).toContain("--prefix 'qwen-live-harness-host/latest'");
    expect(latestUpload).toContain('Qwen-Live-Harness-Host-manifest.json');
    expect(latestUpload).not.toContain('Qwen-Live-Harness-Host-arm64.zip');
  });

  it('serializes latest updates and checks the GitHub stable feed', () => {
    expect(syncWorkflow).toContain(
      "group: 'sync-qwen-live-harness-host-to-oss'",
    );
    expect(syncWorkflow).not.toContain(
      "group: 'sync-qwen-live-harness-host-to-oss-${{ inputs.version }}'",
    );

    const latestCheck = getWorkflowStep(
      getWorkflowJob(syncWorkflow, 'sync'),
      'Confirm latest manifest matches GitHub stable feed',
    );
    expect(latestCheck).toContain(
      "gh release download 'qwen-live-harness-host-latest'",
    );
    expect(latestCheck).toContain(
      'cmp dist/qwen-live-harness-host/Qwen-Live-Harness-Host-manifest.json',
    );
  });

  it('smoke-tests the installed ossutil binary', () => {
    const install = getWorkflowStep(
      getWorkflowJob(syncWorkflow, 'sync'),
      'Install ossutil',
    );
    expect(install).toContain('"$HOME/.local/bin/ossutil" >/dev/null');
  });
});
