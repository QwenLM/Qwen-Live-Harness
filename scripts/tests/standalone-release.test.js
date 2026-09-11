import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getWorkflowJob, getWorkflowStep } from './workflow-helpers.js';

const workflow = readFileSync(
  '.github/workflows/live-host-release.yml',
  'utf8',
);
const daemon = JSON.parse(
  readFileSync('packages/qwen-live/package.json', 'utf8'),
);
const host = JSON.parse(
  readFileSync('packages/live-host/package.json', 'utf8'),
);

function resolveVersion({ version = daemon.version, branch = 'main' } = {}) {
  const step = getWorkflowStep(
    getWorkflowJob(workflow, 'prepare'),
    'Resolve version',
  );
  const script = step
    .split('        run: |\n')[1]
    .split('\n')
    .map((line) => line.replace(/^ {10}/u, ''))
    .join('\n')
    .replaceAll('${{ inputs.prerelease }}', String(version.includes('-')))
    .replaceAll('${{ inputs.dry_run }}', 'false');
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INPUT_VERSION: version,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF_NAME: branch,
      GITHUB_OUTPUT: '/dev/null',
    },
  });
}

describe('standalone release ownership', () => {
  it('publishes only the committed, paired package versions from main', () => {
    expect(host.version).toBe(daemon.version);
    expect(resolveVersion().status).toBe(0);
    const mismatched = resolveVersion({ version: '999.0.0' });
    expect(mismatched.status).not.toBe(0);
    expect(mismatched.stdout).toContain('match the committed package versions');
    const wrongBranch = resolveVersion({ branch: 'unreleased-work' });
    expect(wrongBranch.status).not.toBe(0);
    expect(wrongBranch.stdout).toContain('must run from main');
  });

  it('does not publish draft or dry-run builds to npm', () => {
    const npm = getWorkflowJob(workflow, 'npm-publish');
    expect(npm).toContain('inputs.dry_run == false && inputs.draft == false');
    expect(npm).toContain("needs.publish.result == 'success'");
    expect(npm).toContain("needs.sync-oss.result == 'success'");
    expect(npm).toContain("environment: 'production-release'");
    expect(npm).toContain("NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}'");
  });

  it('rejects previously published versions instead of silently keeping old code', () => {
    const npm = getWorkflowJob(workflow, 'npm-publish');
    expect(npm).toContain('is already published and immutable.');
    expect(npm).not.toContain('skipping');
    const github = getWorkflowStep(
      getWorkflowJob(workflow, 'publish'),
      'Create GitHub release',
    );
    expect(github).toContain("--json isDraft --jq '.isDraft'");
    expect(github).toContain('Published release $RELEASE_TAG is immutable.');
  });

  it('builds only this repository and preserves independent distribution ownership', () => {
    for (const file of [
      'ci.yml',
      'live-host.yml',
      'live-host-release.yml',
      'sync-live-host-to-oss.yml',
    ]) {
      const source = readFileSync(`.github/workflows/${file}`, 'utf8');
      expect(source).not.toMatch(
        /QwenLM\/qwen-code|packages\/cli|packages\/sdk-typescript|@qwen-code\/qwen-code-core|@qwen-code\/acp-bridge/u,
      );
    }
    expect(getWorkflowJob(workflow, 'daemon')).toContain("run: 'npm ci'");
    expect(workflow).not.toMatch(/^ {2}push:/mu);
    expect(workflow).toContain(
      "github.repository == 'QwenLM/Qwen-Live-Harness'",
    );
  });
});
