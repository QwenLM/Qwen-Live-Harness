/** Local-only native fixtures. HTTPS/ACP children use no model accounts. */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpAdaptor } from '../dist/adaptor/acp-adaptor.js';
import { MobileTasks } from '../dist/mobile/tasks.js';
import { MobileServer } from '../dist/mobile/server.js';
import { ensureMobileTLS } from '../dist/mobile/tls.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(join(tmpdir(), 'agent-remote-ios-fixtures-'));
const servers = [];

async function computer(id, name, permissionMode) {
  const workspace = join(directory, id);
  mkdirSync(workspace);
  const tls = await ensureMobileTLS(workspace, ['127.0.0.1']);
  const tasks = new MobileTasks(
    new Map(
      ['qwen', 'codex'].map((name) => [
        name,
        new AcpAdaptor({
          name,
          command: process.execPath,
          args: [join(root, 'test-fixtures/fake-acp-agent.mjs')],
          env: { FAKE_ACP_MODES: 'default' },
          defaultCwd: workspace,
        }),
      ]),
    ),
    [{ id: 'ui-fixture', name: 'UI workspace ' + id, path: workspace }],
    { permissionMode },
  );
  const server = new MobileServer(tasks, tls, {
    pairingLifetimeMs: 60 * 60_000,
  });
  servers.push(server);
  const port = await server.listen(0, '127.0.0.1');
  const pairing = {
    version: 1,
    url: `https://127.0.0.1:${port}`,
    pin: tls.pin,
    code: server.pairingCode,
    name,
  };
  return {
    name,
    link: `qwenliveharness://pair?data=${Buffer.from(JSON.stringify(pairing)).toString('base64url')}`,
    url: pairing.url,
    pin: pairing.pin,
    token: server.deviceToken,
  };
}

const fixtures = join(root, 'ios/UITests/Fixtures');
try {
  const legacy = await computer('approval', 'Mac · Approval fixture', 'ask');
  const computers = [
    await computer('a', 'Test Mac A', 'allow-all'),
    await computer('b', 'Test Mac B', 'allow-all'),
  ];
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'pairing.json'), JSON.stringify(legacy), {
    mode: 0o600,
  });
  writeFileSync(join(fixtures, 'computers.json'), JSON.stringify(computers), {
    mode: 0o600,
  });
  console.log(
    'iOS HTTPS/ACP fixtures ready: one approval flow and two independent computers. Generate the Xcode project now.',
  );
} catch (error) {
  await Promise.allSettled(servers.map((server) => server.close()));
  rmSync(directory, { recursive: true, force: true });
  throw error;
}

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void Promise.all(servers.map((server) => server.close())).then(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(fixtures, { recursive: true, force: true });
    process.exit(0);
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
