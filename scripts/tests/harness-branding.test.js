import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const source = (path) => readFileSync(path, 'utf8');

describe('Qwen Live Harness package and startup identities', () => {
  it('publishes one unscoped package and command, separate from the private workspace', () => {
    const root = json('package.json');
    const daemon = json('packages/qwen-live-harness/package.json');
    const host = json('packages/qwen-live-harness-host/package.json');
    expect(root.name).toBe('qwen-live-harness-workspace');
    expect(root.private).toBe(true);
    expect(root.workspaces).toEqual(['packages/qwen-live-harness']);
    expect(daemon.name).toBe('qwen-live-harness');
    expect(daemon.bin).toEqual({ 'qwen-live-harness': 'dist/index.js' });
    expect(daemon.repository.directory).toBe('packages/qwen-live-harness');
    expect(host.name).toBe('qwen-live-harness-host');
    expect(host.private).toBe(true);
    expect(root.scripts.start).toBe(
      'node packages/qwen-live-harness/dist/index.js',
    );
    expect(root.scripts.init).toBe(
      'node packages/qwen-live-harness/dist/index.js init',
    );
    expect(root.scripts['build:host']).toBe(
      'npm run build --prefix packages/qwen-live-harness-host',
    );
  });

  it('keeps lockfiles aligned without registering the retired command or package', () => {
    const root = json('package-lock.json');
    const host = json('packages/qwen-live-harness-host/package-lock.json');
    expect(root.name).toBe('qwen-live-harness-workspace');
    expect(root.packages[''].name).toBe('qwen-live-harness-workspace');
    expect(root.packages['node_modules/qwen-live-harness']).toEqual({
      resolved: 'packages/qwen-live-harness',
      link: true,
    });
    expect(root.packages).not.toHaveProperty(
      'node_modules/@qwen-code/qwen-live',
    );
    expect(root.packages['packages/qwen-live-harness'].bin).toEqual({
      'qwen-live-harness': 'dist/index.js',
    });
    expect(host.name).toBe('qwen-live-harness-host');
    expect(host.packages[''].name).toBe('qwen-live-harness-host');
    expect(existsSync('packages/qwen-live-harness/src/index.ts')).toBe(true);
    expect(
      existsSync('packages/qwen-live-harness-host/src/main/index.ts'),
    ).toBe(true);
  });

  it('wires package checking and integration discovery to the new public contract', () => {
    const check = source('scripts/check-package.mjs');
    expect(check).toContain("'node_modules/.bin/qwen-live-harness'");
    expect(check).toContain('import("qwen-live-harness")');
    expect(check).toContain('QWEN_LIVE_HARNESS_DATA_DIR');
    const harness = source('integration-tests/qwen-live-harness.ts');
    expect(harness).toContain("path.join(discoveryDir, 'run', 'daemon.json')");
    expect(harness).toContain('qwen-live-harness listening on');
    expect(harness).toContain('com.alibaba.qwen-live-harness.host');
    expect(harness).toContain('x-qwen-live-harness-nonce');
  });

  it('does not reintroduce old product identities in production source', () => {
    const files = (directory) =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.name === '__tests__' || entry.name === 'testing') return [];
        if (entry.isDirectory()) return files(path);
        return /\.(?:ts|mm|css|html)$/u.test(path) && !/\.test\.ts$/u.test(path)
          ? [path]
          : [];
      });
    const retired =
      /qwen[ _-]?live(?![ _-]?harness)|com\.alibaba\.qwen-code\.live-host/iu;
    for (const directory of [
      'packages/qwen-live-harness/src',
      'packages/qwen-live-harness-host/src',
    ]) {
      for (const path of files(directory)) {
        expect(source(path), path).not.toMatch(retired);
      }
    }
  });
});
