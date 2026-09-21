import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export function assertPackageContents(packed) {
  assert(Array.isArray(packed?.files), 'npm pack did not return a file list');
  const paths = packed.files.map(({ path }) => path);
  assert(
    paths.every(
      (path) =>
        typeof path === 'string' &&
        path &&
        !path.startsWith('/') &&
        !path.includes('\\') &&
        !path.split('/').includes('..'),
    ),
    'Invalid path in npm package',
  );
  for (const required of [
    'dist/index.js',
    'dist/LICENSE',
    'dist/vendor/qwen-code-sdk-LICENSE',
    'dist/vendor/qwen-code-peer/LICENSE',
    'dist/vendor/qwen-code-peer/upstream.json',
    'dist/vendor/qwen-code-peer/README.md',
  ])
    assert(
      paths.includes(required),
      `Required file absent from tarball: ${required}`,
    );
  const unwanted = paths.filter(
    (path) =>
      /(?:\.test\.|\.spec\.|(?:^|\/)(?:__tests__|tests?|testing|test-fixtures|coverage)(?:\/|$)|^(?:src|debug|logs?)\/|^dist\/(?:debug|logs|coverage)\/)/iu.test(
        path,
      ) ||
      /(?:\.(?:map|bak|backup|old|orig|tmp|temp|log|jsonl|ndjson|tsbuildinfo|swp|swo)|~)$/iu.test(
        path,
      ),
  );
  assert.deepEqual(
    unwanted,
    [],
    'Test/source/intermediate artifacts leaked into tarball',
  );
}

/** Exact copies, not merely files with plausible names or a license header. */
export function assertInstalledNotices(installedDirectory, expectedNotices) {
  for (const [name, expected] of Object.entries(expectedNotices))
    assert.deepEqual(
      readFileSync(join(installedDirectory, name)),
      Buffer.from(expected),
      `Packaged notice differs from source: ${name}`,
    );
}

/** Stable public command surface, without pinning translated prose. */
export function assertCliHelp(output) {
  assert.equal(typeof output, 'string', 'CLI help must be text');
  assert.match(
    output,
    /^(?:Usage: |用法：)qwen-live-harness \[init \| doctor --peers\] \[(?:options|选项)\][\t ]*$/mu,
    'Incorrect CLI identity or usage contract',
  );
  for (const [name, pattern] of [
    ['init', /^[\t ]+init[\t ]{2,}\S/mu],
    ['init --peers', /^[\t ]+init --peers[\t ]+\S/mu],
    ['doctor --peers', /^[\t ]+doctor --peers[\t ]+\S/mu],
    ['--debug, -d', /^[\t ]+--debug,[\t ]+-d[\t ]+\S/mu],
    ['--daemon-only', /^[\t ]+--daemon-only[\t ]+\S/mu],
    ['--help, -h', /^[\t ]+--help,[\t ]+-h[\t ]+\S/mu],
  ])
    assert.match(
      output,
      pattern,
      `Public CLI command or option missing: ${name}`,
    );
}

function checkPackage() {
  const npmCli = process.env['npm_execpath'];
  assert(
    npmCli && existsSync(npmCli),
    'Run this check with npm run check:package',
  );
  const temporary = mkdtempSync(join(tmpdir(), 'qwen-live-harness-package-'));
  const run = (args, cwd = temporary) =>
    execFileSync(process.execPath, [npmCli, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 300_000,
      env: {
        ...process.env,
        npm_config_registry: 'https://registry.npmjs.org/',
      },
    });
  try {
    const [packed] = JSON.parse(
      run(
        ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary],
        join(root, 'packages/qwen-live-harness'),
      ),
    );
    assertPackageContents(packed);
    run([
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--omit=dev',
      join(temporary, packed.filename),
    ]);
    const installed = join(temporary, 'node_modules/qwen-live-harness');
    const pkg = JSON.parse(
      readFileSync(join(installed, 'package.json'), 'utf8'),
    );
    assert.equal(pkg.name, 'qwen-live-harness');
    assert.deepEqual(pkg.bin, { 'qwen-live-harness': 'dist/index.js' });
    assert(existsSync(join(temporary, 'node_modules/.bin/qwen-live-harness')));
    assert(!existsSync(join(temporary, 'node_modules/.bin/qwen-live')));
    assert.equal(
      pkg.repository.url,
      'git+https://github.com/QwenLM/Qwen-Live-Harness.git',
    );
    assert(
      !Object.values(pkg.dependencies).some((value) =>
        value.startsWith('file:'),
      ),
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
    const expectedNotices = {
      'dist/LICENSE': readFileSync(join(root, 'LICENSE')),
      'dist/vendor/qwen-code-sdk-LICENSE': readFileSync(
        join(
          dirname(
            require.resolve('@qwen-code/sdk/package.json', {
              paths: [join(root, 'packages/qwen-live-harness')],
            }),
          ),
          'dist/LICENSE',
        ),
      ),
    };
    for (const name of ['LICENSE', 'upstream.json', 'README.md']) {
      expectedNotices[`dist/vendor/qwen-code-peer/${name}`] = readFileSync(
        join(
          root,
          'packages/qwen-live-harness/src/vendor/qwen-code-peer',
          name,
        ),
      );
    }
    assertInstalledNotices(installed, expectedNotices);
    const cliEnv = {
      ...process.env,
      QWEN_LIVE_HARNESS_DATA_DIR: join(temporary, 'data'),
    };
    const output = execFileSync(
      process.execPath,
      [join(installed, 'dist/index.js'), '--help'],
      { encoding: 'utf8', env: cliEnv },
    );
    assertCliHelp(output);
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
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  checkPackage();
