import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from 'node:https';
import {
  randomBytes,
  randomUUID,
  X509Certificate,
  createHash,
} from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'agent-remote-package-'));
let child;
let stopped;
let logs = '';
try {
  execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  const [pack] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', temporary], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  assert(pack.files.some((file) => file.path === 'dist/LICENSE'));
  assert(pack.files.some((file) => file.path === 'ios/project.yml'));
  assert(
    !pack.files.some((file) =>
      /(?:\.test\.|Fixtures|build-device|\.xcodeproj|device-token|server-key)/u.test(
        file.path,
      ),
    ),
  );
  const prefix = join(temporary, 'installed');
  execFileSync(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(temporary, pack.filename),
    ],
    { stdio: 'pipe' },
  );
  const installed = join(
    prefix,
    process.platform === 'win32'
      ? 'node_modules/agent-remote'
      : 'lib/node_modules/agent-remote',
  );
  const cli = join(installed, 'dist/cli.js');
  const installedRequire = createRequire(join(installed, 'package.json'));
  const sdk = pathToFileURL(
    installedRequire.resolve('@agentclientprotocol/sdk'),
  ).href;
  const fixtureDirectory = join(installed, 'test-fixtures');
  mkdirSync(fixtureDirectory);
  const fixture = join(fixtureDirectory, 'fake-acp-agent.mjs');
  writeFileSync(
    fixture,
    readFileSync(
      join(root, 'test-fixtures/fake-acp-agent.mjs'),
      'utf8',
    ).replace("'@agentclientprotocol/sdk'", JSON.stringify(sdk)),
  );
  const bin = join(temporary, 'bin');
  const home = join(temporary, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  for (const name of ['qwen', 'codex', 'npx'])
    writeFileSync(
      join(bin, name),
      `#!${process.execPath}\nprocess.env.FAKE_ACP_MODES='default';\nvoid import(${JSON.stringify(pathToFileURL(fixture).href)});\n`,
      { mode: 0o755 },
    );
  const env = {
    ...process.env,
    HOME: home,
    PATH:
      bin + ':' + dirname(process.execPath) + ':' + (process.env['PATH'] ?? ''),
  };
  delete env.AGENT_REMOTE_DATA_DIR;
  assert.equal(
    execFileSync(process.execPath, [cli, '--version'], {
      env,
      encoding: 'utf8',
    }).trim(),
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  );
  // Seed the old location with an already-paired identity. The global install
  // must use it unchanged, without needing the original repository or app.
  const directory = join(home, '.qwen-live-harness/mobile');
  const { ensureMobileTLS } = await import(
    pathToFileURL(join(installed, 'dist/mobile/tls.js')).href
  );
  const { localAddresses } = await import(
    pathToFileURL(join(installed, 'dist/pairing.js')).href
  );
  const { hostname } = await import('node:os');
  const tls = await ensureMobileTLS(directory, localAddresses(), [hostname()]);
  const token = randomBytes(32).toString('base64url');
  writeFileSync(join(directory, 'device-token'), token, { mode: 0o600 });
  child = spawn(
    process.execPath,
    [cli, '--port', '0', '--project', temporary, '--no-open'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  stopped = new Promise((resolve) => child.once('exit', resolve));
  child.stdout.on('data', (part) => {
    logs += part;
  });
  child.stderr.on('data', (part) => {
    logs += part;
  });
  for (
    let attempt = 0;
    attempt < 200 && !logs.includes('Agent Remote ready');
    attempt++
  ) {
    if (child.exitCode !== null)
      throw new Error('Packaged gateway exited: ' + logs);
    await delay(50);
  }
  assert(logs.includes('Agent Remote ready'), 'gateway startup did not finish');
  assert.equal(readFileSync(join(directory, 'device-token'), 'utf8'), token);
  assert.equal(
    new X509Certificate(readFileSync(join(directory, 'server-cert.pem')))
      .fingerprint256,
    new X509Certificate(tls.cert).fingerprint256,
  );
  const { port } = JSON.parse(
    readFileSync(join(directory, 'runtime.json'), 'utf8'),
  );
  const call = (path, body, runId) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          ca: tls.cert,
          method: body ? 'POST' : 'GET',
          headers: {
            authorization: 'Bearer ' + token,
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(runId ? { 'x-live-run-id': runId } : {}),
          },
        },
        (response) => {
          let data = '';
          response.on('data', (part) => {
            data += part;
          });
          response.on('end', () =>
            resolve({ status: response.statusCode, value: JSON.parse(data) }),
          );
        },
      );
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  const initial = await call('/v1/state');
  assert.equal(initial.status, 200);
  assert.equal(initial.value.permissionMode, 'allow-all');
  assert.deepEqual(
    initial.value.backends.map((backend) => backend.id),
    ['qwen', 'codex'],
  );
  assert.equal(initial.value.projects[0].path, realpathSync(temporary));
  const status = JSON.parse(
    execFileSync(process.execPath, [cli, 'status'], { env, encoding: 'utf8' }),
  );
  assert.equal(status.permissionMode, 'allow-all');
  // Verify the renewed QR payload remains readable by the installed app and
  // does not revoke the existing phone token or reset the running service.
  execFileSync(process.execPath, [cli, 'pair', '--no-open'], {
    env,
    stdio: 'pipe',
  });
  const html = readFileSync(join(directory, 'pairing.html'), 'utf8');
  assert(html.includes('data:image/png;base64,'));
  const link = html.match(/qwenliveharness:\/\/pair\?data=([\w-]+)/u);
  assert(link);
  const payload = JSON.parse(Buffer.from(link[1], 'base64url').toString());
  assert.equal(payload.version, 1);
  assert.equal(
    payload.pin,
    createHash('sha256')
      .update(new X509Certificate(tls.cert).raw)
      .digest('hex'),
  );
  assert.equal(
    (await call('/v1/pair', { code: payload.code })).value.token,
    token,
  );
  assert.equal((await call('/v1/pair', { code: payload.code })).status, 410);
  for (const backend of ['qwen', 'codex']) {
    const task = {
      id: randomUUID(),
      backend,
      project: initial.value.projects[0].id,
      text: 'permission: standalone package fixture',
    };
    assert.equal(
      (await call('/v1/tasks', task, initial.value.runId)).status,
      202,
    );
    assert.equal(
      (await call('/v1/tasks', task, initial.value.runId)).status,
      202,
    );
    let current;
    for (let attempt = 0; attempt < 200; attempt++) {
      current = (await call('/v1/state')).value.tasks.find(
        (entry) => entry.id === task.id,
      );
      if (current?.status === 'completed') break;
      await delay(50);
    }
    assert.equal(current.status, 'completed');
    assert.equal(current.permissions.length, 0);
    assert(current.output.includes('permission granted'));
  }
  assert.equal((await call('/v1/state')).value.tasks.length, 2);
  child.kill('SIGTERM');
  await stopped;
  child = undefined;
  assert(!existsSync(join(directory, 'runtime.json')));
  assert.equal(readFileSync(join(directory, 'device-token'), 'utf8'), token);
  console.log(
    `Independent package verified: ${pack.size} bytes packed; global install, legacy pairing, QR renewal and both agents with automatic approval passed. No model account used.`,
  );
} finally {
  if (child) {
    child.kill('SIGTERM');
    await stopped;
  }
  rmSync(temporary, { recursive: true, force: true });
}
