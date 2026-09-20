/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** Public CLI coverage; TEST_LIVE_PATH also runs this against an installed tarball. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { liveText } from '../packages/qwen-live-harness/src/i18n/messages.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli =
  process.env['TEST_LIVE_PATH'] ??
  join(root, 'packages/qwen-live-harness/dist/index.js');
const FEATURES = [
  'session_create',
  'session_prompt',
  'session_events',
  'session_cancel',
  'session_permission_vote',
  'session_mid_turn_message_mutation',
];
const ENV_NAME = 'QWEN_LIVE_HARNESS_SETUP_TEST_CONTROLLER';
const controllerToken = `qpc_${randomBytes(32).toString('hex')}`;
const serveToken = `synthetic-serve-${randomBytes(8).toString('hex')}`;
const auditPath = process.env['QWEN_LIVE_HARNESS_PEER_ACCEPTANCE_FILE'];

interface PromptStep {
  question: string;
  input: string;
  beforeInput?: () => Promise<void>;
}

describe('peer setup and diagnostics through the public CLI', () => {
  let temporary: string;
  let home: string;
  let data: string;
  let qwenHome: string;
  let configPath: string;
  let server: Server;
  let baseUrl: string;
  let requests: Array<{ method: string; url: string; authorized: boolean }>;
  const observations: unknown[] = [];

  afterAll(async () => {
    if (!auditPath) return;
    await mkdir(dirname(auditPath), { recursive: true });
    await writeFile(auditPath, JSON.stringify(observations, null, 2) + '\n');
  });

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'qwen-live-harness-peer-setup-'));
    home = join(temporary, 'home');
    data = join(temporary, 'data');
    qwenHome = join(home, '.qwen');
    configPath = join(data, 'config.json');
    await mkdir(data);
    await mkdir(qwenHome, { recursive: true });
    requests = [];
    server = createServer((request, response) => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorized: request.headers.authorization === `Bearer ${serveToken}`,
      });
      if (request.url === '/capabilities') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ features: FEATURES }));
      } else if (request.url === '/redirect/capabilities') {
        response.writeHead(302, { location: `${baseUrl}/must-not-follow` });
        response.end();
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
      server?.closeAllConnections();
    });
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  function acp() {
    return {
      name: 'existing-acp',
      kind: 'acp',
      command: process.execPath,
      args: [
        join(
          root,
          'packages/qwen-live-harness/test-fixtures/fake-acp-agent.mjs',
        ),
      ],
      default: true,
      cwd: temporary,
      env: { USER_OWNED_OPTION: 'preserved' },
    };
  }

  function daemon(peerDiscovery?: Record<string, unknown>) {
    return {
      name: 'existing-daemon',
      kind: 'qwen-code',
      baseUrl,
      token: serveToken,
      ...(peerDiscovery ? { peerDiscovery } : {}),
    };
  }

  async function seed(backends: unknown[]) {
    const original = {
      language: 'en',
      realtimeApiKey: 'synthetic-realtime-key',
      realtimeEndpoint: `${baseUrl}/must-not-use-model`,
      realtimeModel: 'synthetic-model',
      voice: 'Tina',
      memory: { enabled: false },
      proactive: { enabled: false },
      userOwnedField: { retain: ['this', 'value'] },
      backends,
    };
    await writeFile(configPath, JSON.stringify(original, null, 2) + '\n', {
      mode: 0o600,
    });
    return original;
  }

  async function snapshot(directory: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    async function visit(current: string) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const file = join(current, entry.name);
        if (entry.isDirectory()) await visit(file);
        else
          result[file.slice(directory.length + 1)] = await readFile(
            file,
            'utf8',
          );
      }
    }
    await visit(directory);
    return result;
  }

  async function run(
    args: string[],
    steps: PromptStep[] = [],
    extraEnv: Record<string, string> = {},
  ) {
    const before = auditPath ? await snapshot(temporary) : undefined;
    const proc = spawn(process.execPath, [cli, ...args], {
      cwd: temporary,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: dirname(process.execPath),
        SystemRoot: process.env['SystemRoot'],
        HOME: home,
        QWEN_HOME: qwenHome,
        TERM: 'dumb',
        NO_COLOR: '1',
        QWEN_LIVE_HARNESS_DATA_DIR: data,
        QWEN_LIVE_HARNESS_DISCOVERY_DIR: join(temporary, 'discovery'),
        ...extraEnv,
      },
    });
    let output = '';
    let cursor = 0;
    let ended = false;
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
    };
    proc.stdout!.on('data', capture);
    proc.stderr!.on('data', capture);
    const exited = new Promise<number | null>((resolve, reject) => {
      proc.on('error', reject);
      proc.on('exit', (code) => {
        ended = true;
        resolve(code);
      });
    });
    const deadline = Date.now() + 20_000;
    const timer = setTimeout(() => proc.kill('SIGTERM'), 20_000);
    try {
      for (const step of steps) {
        while (!output.slice(cursor).includes(step.question)) {
          if (ended || Date.now() > deadline)
            throw new Error(`CLI did not reach prompt: ${step.question}`);
          await delay(10);
        }
        cursor = output.length;
        await step.beforeInput?.();
        proc.stdin!.write(step.input);
      }
      // Unlike an interactive terminal, this fixture owns the input pipe.
      // Release it after the final answer so readline can finish naturally.
      proc.stdin!.end();
      const code = await exited;
      if (before) {
        const manifest = (files: Record<string, string>) =>
          Object.fromEntries(
            Object.entries(files).map(([path, content]) => [
              path,
              createHash('sha256').update(content).digest('hex'),
            ]),
          );
        observations.push({
          test: expect.getState().currentTestName,
          command: args.join(' '),
          exitCode: code,
          before: manifest(before),
          after: manifest(await snapshot(temporary)),
          requests: [...requests],
          credentialsAbsentFromOutput:
            !output.includes(controllerToken) && !output.includes(serveToken),
        });
      }
      return { code, output };
    } finally {
      clearTimeout(timer);
      if (!ended) {
        proc.kill('SIGTERM');
        await exited;
      }
    }
  }

  it('exposes peer setup and diagnosis from the shipped entry without starting a daemon', async () => {
    await seed([acp()]);
    const before = await snapshot(temporary);
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.output).toContain('init --peers');
    expect(result.output).toContain('doctor --peers');
    expect(await snapshot(temporary)).toEqual(before);
    expect(requests).toEqual([]);
  });

  it('adds an independent peer backend, keeps the default ACP, and stores only the granted token environment name', async () => {
    const original = await seed([acp()]);
    const beforeHome = await snapshot(home);
    const result = await run(
      ['init', '--peers'],
      [
        { question: liveText('en', 'peerSetup.backend'), input: '\r' },
        { question: liveText('en', 'peerSetup.enabled'), input: 'y' },
        { question: liveText('en', 'peerSetup.name'), input: '\r' },
        { question: liveText('en', 'peerSetup.url'), input: `${baseUrl}\r` },
        {
          question: liveText('en', 'peerSetup.serveToken'),
          input: `${serveToken}\r`,
        },
        { question: liveText('en', 'peerSetup.home'), input: `${qwenHome}\r` },
        { question: liveText('en', 'peerSetup.reports'), input: 'y' },
        {
          question: liveText('en', 'peerSetup.controller'),
          input: '\x1b[B\r',
        },
        {
          question: liveText('en', 'peerSetup.tokenEnv'),
          input: `${ENV_NAME}\r`,
        },
      ],
      { [ENV_NAME]: controllerToken },
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain(liveText('en', 'peerSetup.saved'));
    expect(result.output).not.toContain(controllerToken);
    expect(result.output).not.toContain(serveToken);
    const configured = {
      ...original,
      backends: [
        ...original.backends,
        {
          name: 'qwen-peers',
          kind: 'qwen-code',
          baseUrl,
          token: serveToken,
          peerDiscovery: {
            qwenHome,
            reports: true,
            controllerTokenEnv: ENV_NAME,
          },
        },
      ],
    };
    const bytes = await readFile(configPath, 'utf8');
    expect(JSON.parse(bytes)).toEqual(configured);
    expect(bytes).not.toContain(controllerToken);
    expect(await snapshot(home)).toEqual(beforeHome);
    expect(await readdir(data)).toEqual(['config.json']);
    expect(requests).toEqual([]);

    const unchanged = await run(
      ['init', '--peers'],
      [
        { question: liveText('en', 'peerSetup.backend'), input: '\r' },
        { question: liveText('en', 'peerSetup.enabled'), input: '\r' },
        { question: liveText('en', 'peerSetup.home'), input: '\r' },
        { question: liveText('en', 'peerSetup.reports'), input: '\r' },
        { question: liveText('en', 'peerSetup.controller'), input: '\r' },
      ],
      { [ENV_NAME]: controllerToken },
    );
    expect(unchanged.code).toBe(0);
    expect(unchanged.output).toContain(liveText('en', 'peerSetup.unchanged'));
    expect(await readFile(configPath, 'utf8')).toBe(bytes);

    const disabled = await run(
      ['init', '--peers'],
      [
        { question: liveText('en', 'peerSetup.backend'), input: '\r' },
        { question: liveText('en', 'peerSetup.enabled'), input: 'n' },
      ],
    );
    expect(disabled.code).toBe(0);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      ...original,
      backends: [
        ...original.backends,
        { name: 'qwen-peers', kind: 'qwen-code', baseUrl, token: serveToken },
      ],
    });
    expect(await snapshot(home)).toEqual(beforeHome);
    expect(requests).toEqual([]);
  });

  it('leaves an ACP-only setup untouched when adding peers is declined', async () => {
    await seed([acp()]);
    const before = await snapshot(temporary);
    const result = await run(
      ['init', '--peers'],
      [
        { question: liveText('en', 'peerSetup.backend'), input: '\r' },
        { question: liveText('en', 'peerSetup.enabled'), input: 'n' },
      ],
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain(liveText('en', 'peerSetup.unchanged'));
    expect(await snapshot(temporary)).toEqual(before);
    expect(requests).toEqual([]);
  });

  it('cancels late setup without partially changing a managed daemon or creating grants', async () => {
    await seed([acp(), daemon()]);
    const before = await snapshot(temporary);
    const result = await run(
      ['init', '--peers'],
      [
        { question: liveText('en', 'peerSetup.backend'), input: '\r' },
        { question: liveText('en', 'peerSetup.enabled'), input: 'y' },
        { question: liveText('en', 'peerSetup.home'), input: `${qwenHome}\r` },
        { question: liveText('en', 'peerSetup.reports'), input: 'y' },
        { question: liveText('en', 'peerSetup.controller'), input: '\x03' },
      ],
    );
    expect(result.code).toBe(0);
    expect(await snapshot(temporary)).toEqual(before);
    expect(requests).toEqual([]);
  });

  it('preserves a concurrent edit instead of saving stale peer choices over it', async () => {
    const original = await seed([acp(), daemon()]);
    const external =
      JSON.stringify({ ...original, externalEdit: 'keep this edit' }) + '\n';
    const result = await run(
      ['init', '--peers'],
      [
        { question: liveText('en', 'peerSetup.backend'), input: '\r' },
        { question: liveText('en', 'peerSetup.enabled'), input: 'y' },
        { question: liveText('en', 'peerSetup.home'), input: `${qwenHome}\r` },
        { question: liveText('en', 'peerSetup.reports'), input: 'y' },
        {
          question: liveText('en', 'peerSetup.controller'),
          input: '\r',
          beforeInput: () => writeFile(configPath, external),
        },
      ],
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain(liveText('en', 'peerSetup.concurrentEdit'));
    expect(await readFile(configPath, 'utf8')).toBe(external);
    expect(await readdir(data)).toEqual(['config.json']);
    expect(await snapshot(home)).toEqual({});
    expect(requests).toEqual([]);
  });

  it('diagnoses configured peers without executing models, printing credentials or changing either home', async () => {
    await seed([
      acp(),
      daemon({ qwenHome, reports: true, controllerTokenEnv: ENV_NAME }),
    ]);
    await writeFile(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ agents: { crossSessionMessaging: true } }),
    );
    // Diagnosis must not mint, revoke, repair or infer validity from a grant file.
    await writeFile(
      join(qwenHome, 'peer-controllers.json'),
      'user-owned grant file, intentionally opaque to doctor\n',
    );
    const before = await snapshot(temporary);
    const result = await run(['doctor', '--peers'], [], {
      [ENV_NAME]: controllerToken,
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain('existing-daemon');
    expect(result.output).toContain(
      liveText('en', 'peers.doctor.state.configured-unverified'),
    );
    expect(result.output).not.toContain(controllerToken);
    expect(result.output).not.toContain(serveToken);
    for (const argument of ['doctor', '--peers']) {
      expect(result.output).not.toContain(
        liveText('en', 'cli.unknownArgument', { argument }),
      );
    }
    expect(requests).toEqual([
      { method: 'GET', url: '/capabilities', authorized: true },
    ]);
    expect(await snapshot(temporary)).toEqual(before);
  });

  it('does not follow a serve redirect while diagnosing an unavailable Qwen home', async () => {
    await seed([
      acp(),
      {
        ...daemon({ qwenHome: join(home, 'missing-qwen-home'), reports: true }),
        baseUrl: `${baseUrl}/redirect`,
      },
    ]);
    const before = await snapshot(temporary);
    const result = await run(['doctor', '--peers']);
    expect(result.code).toBe(1);
    expect(result.output).toContain('existing-daemon');
    expect(requests).toEqual([
      { method: 'GET', url: '/redirect/capabilities', authorized: true },
    ]);
    expect(await snapshot(temporary)).toEqual(before);
  });
});
