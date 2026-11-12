import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
  readdirSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'darwin')
  throw new Error('Validate the native bundle on macOS.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'macos/build/Agent Remote.app');
const temporary = mkdtempSync(join(tmpdir(), 'agent-remote-macos-check-'));
const label = 'dev.agent-remote.gateway.fixture-' + randomUUID();
const target = `gui/${process.getuid()}/${label}`;
const keep = process.argv.includes('--keep-fixture');
let started = false;
let passed = false;
try {
  const app = join(temporary, 'Agent Remote.app');
  cpSync(source, app, { recursive: true, verbatimSymlinks: true });
  const inspectLinks = (path) => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry),
        stat = lstatSync(child);
      if (stat.isSymbolicLink()) {
        assert(
          !readlinkSync(child).startsWith('/'),
          'runtime links must not point into the build machine',
        );
        assert(
          realpathSync(child).startsWith(realpathSync(app) + '/'),
          'runtime link escapes the bundle',
        );
      } else if (stat.isDirectory()) inspectLinks(child);
    }
  };
  inspectLinks(app);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const resources = join(app, 'Contents/Resources');
  assert(
    readFileSync(join(resources, 'BrandMark.png')).equals(
      readFileSync(join(root, 'macos/Resources/BrandMark.png')),
    ),
    'bundle must contain the current brand mark',
  );
  assert(
    existsSync(join(resources, 'AppIcon.icns')),
    'bundle must contain the app icon',
  );
  const node = join(resources, 'runtime/bin/node');
  const cli = join(resources, 'gateway/dist/cli.js');
  const manifest = JSON.parse(
    readFileSync(join(root, 'macos/runtime-manifest.json'), 'utf8'),
  );
  assert.equal(
    execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(),
    'v' + manifest.version,
  );
  for (const binary of [node, join(app, 'Contents/MacOS/AgentRemoteMac')]) {
    const architectures = execFileSync('/usr/bin/lipo', ['-archs', binary], {
      encoding: 'utf8',
    });
    assert(architectures.includes('arm64') && architectures.includes('x86_64'));
  }
  const home = join(temporary, 'home'),
    bin = join(temporary, 'agents');
  const directory = join(home, '.qwen-live-harness/mobile'),
    project = join(temporary, 'Test Project');
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(project);
  const runtimeBin = dirname(node);
  const env = {
    HOME: home,
    PATH: runtimeBin + ':' + bin + ':/usr/bin:/bin:/usr/sbin:/sbin',
    AGENT_REMOTE_DATA_DIR: directory,
    AGENT_REMOTE_SERVICE_LABEL: label,
    AGENT_REMOTE_DISABLE_LOGIN_REGISTRATION: '1',
  };
  // Every child is either the bundled runtime or this SDK fixture. No personal
  // CLI path, account or model endpoint is used by this acceptance test.
  const require = createRequire(join(resources, 'gateway/package.json'));
  const sdk = pathToFileURL(require.resolve('@agentclientprotocol/sdk')).href;
  const fixture = join(temporary, 'fake-agent.mjs');
  writeFileSync(
    fixture,
    readFileSync(
      join(root, 'test-fixtures/fake-acp-agent.mjs'),
      'utf8',
    ).replace("'@agentclientprotocol/sdk'", JSON.stringify(sdk)),
  );
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    join(bin, 'qwen'),
    `#!/bin/sh\nFAKE_ACP_MODES=default exec ${quote(node)} ${quote(fixture)} "$@"\n`,
    { mode: 0o755 },
  );
  const run = (args) =>
    JSON.parse(
      execFileSync(node, [cli, 'desktop', ...args], {
        env,
        encoding: 'utf8',
        timeout: 45_000,
      }),
    );
  const portServer = createServer();
  await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const { ensureMobileTLS } = await import(
    pathToFileURL(join(resources, 'gateway/dist/mobile/tls.js')).href
  );
  const { hostname } = await import('node:os');
  const tls = await ensureMobileTLS(directory, ['192.0.2.1'], [hostname()]);
  const token = randomBytes(32).toString('base64url');
  writeFileSync(join(directory, 'device-token'), token, { mode: 0o600 });
  writeFileSync(
    join(directory, 'desktop-config.json'),
    JSON.stringify({
      version: 1,
      projects: [],
      port,
      ask: false,
      launchAtLogin: true,
    }),
    { mode: 0o600 },
  );
  const certHash = createHash('sha256')
    .update(readFileSync(join(directory, 'server-cert.pem')))
    .digest('hex');
  const initial = run(['snapshot']);
  assert.equal(initial.online, false);
  assert.equal(
    initial.agents.find((agent) => agent.id === 'qwen').installed,
    true,
  );
  run(['configure', '--project', project]);
  assert.equal(run(['snapshot']).config.projects[0], realpathSync(project));
  run(['start']);
  started = true;
  let online;
  for (let i = 0; i < 100; i++) {
    online = run(['snapshot']);
    if (online.online) break;
    await delay(100);
  }
  assert.equal(online.online, true);
  assert.equal(online.permissionMode, 'allow-all');
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
        (res) => {
          let data = '';
          res.on('data', (part) => {
            data += part;
          });
          res.on('end', () =>
            resolve({ status: res.statusCode, value: JSON.parse(data) }),
          );
        },
      );
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  const pairing = run(['pair']);
  const payload = JSON.parse(
    Buffer.from(
      new URL(pairing.link).searchParams.get('data'),
      'base64url',
    ).toString(),
  );
  assert.equal(
    (await call('/v1/pair', { code: payload.code })).value.token,
    token,
  );
  const state = (await call('/v1/state')).value;
  const input = {
    id: randomUUID(),
    backend: 'qwen',
    project: state.projects[0].id,
    text: 'permission: native bundle acceptance fixture',
  };
  assert.equal((await call('/v1/tasks', input, state.runId)).status, 202);
  let task;
  for (let i = 0; i < 100; i++) {
    task = (await call('/v1/state')).value.tasks[0];
    if (task?.status === 'completed') break;
    await delay(50);
  }
  assert.equal(
    task.status,
    'completed',
    JSON.stringify({ status: task.status, activity: task.activity }),
  );
  assert(task.output.includes('permission granted'));
  const secondProject = join(temporary, 'Second Project');
  mkdirSync(secondProject);
  run(['configure', '--project', secondProject]);
  for (let i = 0; i < 100; i++) {
    if (run(['snapshot']).online) break;
    await delay(100);
  }
  assert.equal(
    run(['snapshot']).config.projects[0],
    realpathSync(secondProject),
  );
  const previous = run(['snapshot']);
  assert.equal(
    previous.totalTasks,
    0,
    'changing project folders starts a new service without replaying tasks',
  );
  const command = execFileSync(
    '/bin/ps',
    ['-p', String(previous.pid), '-o', 'command='],
    { encoding: 'utf8' },
  );
  assert(command.includes(cli) && command.includes(directory));
  process.kill(previous.pid, 'SIGKILL');
  let recovered;
  for (let i = 0; i < 100; i++) {
    recovered = run(['snapshot']);
    if (recovered.online && recovered.runId !== previous.runId) break;
    await delay(200);
  }
  assert.equal(recovered.online, true);
  assert.notEqual(recovered.runId, previous.runId);
  assert.notEqual(recovered.pid, previous.pid);
  assert.equal(
    recovered.totalTasks,
    0,
    'a restarted service must not fabricate recovered tasks',
  );
  assert.equal(
    (await call('/v1/tasks', input, previous.runId)).status,
    409,
    'old mutations must not replay after restart',
  );
  assert.equal(readFileSync(join(directory, 'device-token'), 'utf8'), token);
  assert.equal(
    createHash('sha256')
      .update(readFileSync(join(directory, 'server-cert.pem')))
      .digest('hex'),
    certHash,
  );
  run(['login', 'off']);
  assert.equal(
    existsSync(join(home, 'Library/LaunchAgents', label + '.plist')),
    false,
  );
  assert.equal(
    run(['snapshot']).online,
    true,
    'disabling next-login startup must not stop current work',
  );
  run(['login', 'on']);
  assert.equal(
    existsSync(join(home, 'Library/LaunchAgents', label + '.plist')),
    true,
  );
  assert.equal(
    run(['snapshot']).pid,
    recovered.pid,
    'login preference must not restart the service',
  );
  console.log(
    'macOS bundle acceptance passed: universal app/Node, no external Node/npm, independent installation, existing pairing, automatic approval, login registration and real launchd crash recovery. No model account used.',
  );
  passed = true;
  if (keep) {
    writeFileSync(
      join(temporary, 'fixture.json'),
      JSON.stringify({ app, directory, home, project, label, env }),
      { mode: 0o600 },
    );
    writeFileSync('/tmp/agent-remote-macos-fixture-location', temporary, {
      mode: 0o600,
    });
    console.log('Retained isolated GUI fixture: ' + temporary);
  }
} finally {
  if (!keep || !started || !passed) {
    if (started)
      spawnSync('/bin/launchctl', ['bootout', target], { stdio: 'ignore' });
    rmSync(temporary, { recursive: true, force: true });
  }
}
