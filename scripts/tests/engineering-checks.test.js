/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { getWorkflowJob, getWorkflowStep } from './workflow-helpers.js';

const read = (file) => readFileSync(file, 'utf8');

describe('repository-wide engineering checks', () => {
  it('includes Host source and build scripts in the combined lint entry', () => {
    const { scripts } = JSON.parse(read('package.json'));
    expect(scripts['lint:all']).toBe('npm run lint && npm run lint:host');
    for (const target of [
      'packages/qwen-live-harness-host/src',
      'packages/qwen-live-harness-host/scripts',
      'packages/qwen-live-harness-host/vite.config.ts',
      'packages/qwen-live-harness-host/resources/audio-input-worklet.js',
    ])
      expect(scripts['lint:host']).toContain(target);
    expect(scripts.lint).toContain('packages/qwen-live-harness/src');
    expect(scripts.lint).toContain('packages/qwen-live-harness/build.mjs');
  });

  it.each(['ci.yml', 'qwen-live-harness-host-release.yml'])(
    'requires both-package lint and formatting in %s',
    (file) => {
      const workflow = read(`.github/workflows/${file}`);
      const daemon = getWorkflowJob(workflow, 'daemon');
      expect(daemon).toContain(
        "run: 'npm run lint:all && npm run format:check'",
      );
      expect(daemon).toContain("run: 'npm ci'");
      if (file.includes('release'))
        expect(getWorkflowJob(workflow, 'publish')).toContain("'daemon'");
    },
  );

  it('allows require only for CommonJS hooks while keeping TypeScript checks enabled', async () => {
    const eslint = new ESLint();
    const commonjs = await eslint.calculateConfigForFile(
      'packages/qwen-live-harness-host/scripts/after-pack.cjs',
    );
    const typescript = await eslint.calculateConfigForFile(
      'packages/qwen-live-harness-host/src/main/index.ts',
    );
    expect(commonjs.rules['@typescript-eslint/no-require-imports'][0]).toBe(0);
    expect(typescript.rules['@typescript-eslint/no-require-imports'][0]).toBe(
      2,
    );
    expect(typescript.rules['no-unsafe-finally'][0]).toBe(2);
  });

  it('checks actual packaged contents in Host CI and both release architectures', () => {
    const ci = getWorkflowStep(
      getWorkflowJob(
        read('.github/workflows/qwen-live-harness-host.yml'),
        'test',
      ),
      'Package unsigned Qwen Live Harness Host app',
    );
    const release = getWorkflowStep(
      getWorkflowJob(
        read('.github/workflows/qwen-live-harness-host-release.yml'),
        'build',
      ),
      'Verify release assets',
    );
    for (const step of [ci, release])
      expect(step).toContain('assertPackagedContents(process.argv[1])');
    expect(release).toContain('"$app_count" -ne 2');
    expect(release).not.toContain('inputs.dry_run');
  });
});
