import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env['npm_execpath'];
assert(
  npmCli && existsSync(npmCli),
  'Run this check with npm run check:package',
);
const temporary = mkdtempSync(join(tmpdir(), 'qwen-live-harness-package-'));
const require = createRequire(import.meta.url);
const run = (args, cwd = temporary) =>
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, npm_config_registry: 'https://registry.npmjs.org/' },
  });
try {
  const [packed] = JSON.parse(
    run(
      ['pack', '--json', '--pack-destination', temporary],
      join(root, 'packages/qwen-live-harness'),
    ),
  );
  assert(
    packed.files.some(({ path }) => path === 'LICENSE'),
    'license absent from tarball',
  );
  assert(
    packed.files.some(({ path }) => path === 'dist/index.js'),
    'CLI absent from tarball',
  );
  assert(
    !packed.files.some(({ path }) =>
      /(?:\.test\.|test-fixtures|tsbuildinfo|^src\/)/u.test(path),
    ),
    'test/source artifacts leaked into tarball',
  );
  run([
    'install',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--omit=dev',
    join(temporary, packed.filename),
  ]);
  const installed = join(temporary, 'node_modules/qwen-live-harness');
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'qwen-live-harness');
  assert.deepEqual(pkg.bin, { 'qwen-live-harness': 'dist/index.js' });
  assert(existsSync(join(temporary, 'node_modules/.bin/qwen-live-harness')));
  assert(!existsSync(join(temporary, 'node_modules/.bin/qwen-live')));
  assert.equal(
    pkg.repository.url,
    'git+https://github.com/QwenLM/Qwen-Live-Harness.git',
  );
  assert(
    !Object.values(pkg.dependencies).some((value) => value.startsWith('file:')),
  );
  for (const dependency of [
    'sdk',
    'qwen-code',
    'qwen-code-core',
    'acp-bridge',
  ]) {
    assert(
      !existsSync(join(temporary, 'node_modules/@qwen-code', dependency)),
      `Unexpected backend installation: ${dependency}`,
    );
  }
  assert(
    packed.files.some(
      ({ path }) => path === 'dist/vendor/qwen-code-sdk-LICENSE',
    ),
  );
  const cliEnv = {
    ...process.env,
    QWEN_LIVE_HARNESS_DATA_DIR: join(temporary, 'data'),
  };
  const output = execFileSync(
    process.execPath,
    [join(installed, 'dist/index.js'), '--help'],
    { encoding: 'utf8', env: cliEnv },
  );
  assert.match(output, /Usage: qwen-live-harness \[init\] \[--debug\]/u);
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const m = await import("qwen-live-harness"); if (!m.LiveDaemon || !m.loadConfig) throw new Error("missing public API");',
    ],
    { cwd: temporary, env: cliEnv },
  );
  execFileSync(
    process.execPath,
    [
      require.resolve('vitest/vitest.mjs'),
      'run',
      '--config',
      'integration-tests/vitest.config.ts',
    ],
    {
      cwd: root,
      env: { ...cliEnv, TEST_LIVE_PATH: join(installed, 'dist/index.js') },
      timeout: 180_000,
      stdio: 'inherit',
    },
  );
  console.log(
    `Installed ${packed.filename}; CLI help, public imports, package contents and full-process ACP/permission tests verified without a backend CLI.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
