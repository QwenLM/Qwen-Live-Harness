/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Optional backend compatibility suite: real CLI TUI + qwen serve + Live daemon,
 * with fake OpenAI, realtime and Host endpoints. Requires TEST_CLI_PATH and
 * Python 3, and runs only in test:backends. No real account or audio is used.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readLiveSessionRecords,
  sessionRegistryDir,
} from '../packages/qwen-live-harness/src/vendor/qwen-code-peer/index.js';
import type { SubagentsControlResult } from '../packages/qwen-live-harness/src/subagents/types.js';
import {
  contextTextOf,
  functionCallOutputOf,
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import { qwenCliPath, sleep } from './qwen-backend-harness.js';
import {
  bootLiveStack,
  deferred,
  readLiveDiscovery,
  startLiveCall,
  waitForLiveResponseAfter,
  type LiveStack,
} from './qwen-live-harness.js';

const SKIP =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
    process.env['QWEN_SANDBOX'].toLowerCase() !== 'false',
  );
const describeE2E = SKIP ? describe.skip : describe;
const exec = promisify(execFile);
const PTY_BRIDGE = fileURLToPath(
  new URL('./test-fixtures/qwen-tui-pty.py', import.meta.url),
);
const SUCCESS = 'PR2 exact terminal instruction: report the test marker only.';
const RESPONSE = 'PR2 local fake terminal response';
const TRANSCRIPT = 'PR2 unrelated spoken context must not enter terminal input';
const HELD = 'PR2 held instruction must not enter the model';
const HELD_ACCEPT = 'PR2 held instruction released by terminal user';
const REFUSED = 'PR2 refused instruction must not enter the model';
const REVOKED = 'PR2 revoked controller must not enter the model';
const MANAGED = 'PR2 managed REST regression';

interface Terminal {
  name: string;
  proc: ChildProcess;
  cwd: string;
  sessionId: string;
  ipcPath: string;
  output: string;
  error?: Error;
}

describeE2E(
  'Qwen peer instructions — real terminal controller delivery',
  () => {
    let stack: LiveStack;
    let conn: FakeDashScopeConnection;
    let qwenHome: string;
    let controllerId: string;
    let controllerToken = '';
    let controllerRemoved = false;
    let homeDir: string;
    let normal: Terminal;
    let held: Terminal;
    let refused: Terminal;
    let terminalHandle: string;
    let heldHandle: string;
    let refusedHandle: string;
    let successDelivery: string;
    let liveIpcPath: string;
    let sequence = 0;
    const terminals: Terminal[] = [];
    const modelGate = deferred();
    const evidence: Record<string, unknown> = {};

    const cliEnv = () => ({
      PATH: process.env['PATH'],
      SystemRoot: process.env['SystemRoot'],
      HOME: homeDir,
      QWEN_HOME: qwenHome,
      QWEN_NO_UPDATE_NOTIFIER: '1',
    });
    const controllers = (args: string[]) =>
      exec(
        process.execPath,
        [qwenCliPath(), 'sessions', 'controllers', ...args],
        {
          cwd: homeDir,
          env: cliEnv(),
        },
      );
    const records = () => readLiveSessionRecords(sessionRegistryDir(qwenHome));

    beforeAll(async () => {
      await exec('python3', ['--version']);
      stack = await bootLiveStack({
        peerDiscovery: true,
        preparePeerDiscovery: async (info) => {
          qwenHome = info.qwenHome;
          homeDir = info.homeDir;
          // Capture the token directly; it must never be printed in test output.
          const added = JSON.parse(
            (await controllers(['add', '--label', 'Live PR2 E2E', '--json']))
              .stdout,
          ) as { id: string; token: string };
          controllerId = added.id;
          controllerToken = added.token;
          return { controllerToken };
        },
        makeOpenAIHandler:
          () =>
          async ({ body }) => {
            const messages = JSON.stringify(body['messages'] ?? []);
            if (messages.includes(SUCCESS)) await modelGate.promise;
            return {
              content: messages.includes(MANAGED)
                ? 'PR2 managed REST response'
                : RESPONSE,
            };
          },
      });
      await writeFile(
        path.join(qwenHome, 'settings.json'),
        JSON.stringify({
          agents: { crossSessionMessaging: true },
          general: { enableAutoUpdate: false },
          security: { auth: { selectedType: 'openai' } },
          telemetry: { enabled: false },
          ui: { enableFollowupSuggestions: false, autoModeAcknowledged: true },
          $version: 4,
        }),
      );
      normal = await startTerminal('default-inbound');
      held = await startTerminal('held-inbound', 'hold');
      refused = await startTerminal('refused-inbound', 'refuse');
      evidence['terminalVersions'] = (await records())
        .filter((record) =>
          terminals.some((t) => t.sessionId === record.sessionId),
        )
        .map((record) => record.qwenVersion);
      conn = (await startLiveCall(stack)).conn;
      liveIpcPath = (await records()).find(
        (record) => record.name === 'live-qwen-code',
      )!.ipcPath!;
    });

    afterAll(async () => {
      modelGate.resolve();
      for (const terminal of terminals) {
        if (terminal.proc.exitCode === null)
          terminal.proc.stdin?.write('/quit\r');
      }
      for (
        let i = 0;
        i < 50 && terminals.some((t) => t.proc.exitCode === null);
        i++
      ) {
        await sleep(100);
      }
      for (const terminal of terminals) {
        if (terminal.proc.exitCode === null) terminal.proc.kill('SIGTERM');
      }
      if (controllerId && !controllerRemoved) {
        await controllers(['remove', controllerId]);
        controllerRemoved = true;
      }
      await stack?.live.dispose();
      if (qwenHome) {
        evidence['finalControllers'] = (
          await controllers(['list', '--json'])
        ).stdout.trim();
        evidence['finalLiveOrTerminalRecords'] = (await records()).filter(
          (record) =>
            record.name === 'live-qwen-code' ||
            terminals.some(
              (terminal) => terminal.sessionId === record.sessionId,
            ),
        ).length;
      }
      evidence['terminalExitCodes'] = terminals.map((t) => t.proc.exitCode);
      evidence['modelRequests'] = stack?.fakeOpenAI.requests.length;
      const outputDir = process.env['QWEN_LIVE_HARNESS_PR2_EVIDENCE_DIR'];
      if (outputDir) {
        await mkdir(outputDir, { recursive: true });
        await writeFile(
          path.join(outputDir, 'results.json'),
          JSON.stringify(evidence, null, 2),
        );
        for (const terminal of terminals) {
          await writeFile(
            path.join(outputDir, `${terminal.name}.log`),
            controllerToken
              ? terminal.output.replaceAll(controllerToken, '[REDACTED]')
              : terminal.output,
          );
        }
      }
      await stack?.dispose();
    }, 60_000);

    async function startTerminal(
      name: string,
      inbound?: 'hold' | 'refuse',
    ): Promise<Terminal> {
      const cwd = path.join(stack.workspaceDir, name);
      await mkdir(path.join(cwd, '.qwen'), { recursive: true });
      if (inbound) {
        await writeFile(
          path.join(cwd, '.qwen', 'settings.json'),
          JSON.stringify({ agents: { crossSessionInbound: inbound } }),
        );
      }
      const proc = spawn(
        'python3',
        [
          '-u',
          PTY_BRIDGE,
          process.execPath,
          qwenCliPath(),
          '--auth-type',
          'openai',
          '--approval-mode',
          'default',
        ],
        {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...cliEnv(),
            TERM: 'xterm-256color',
            OPENAI_API_KEY: 'fake-key',
            OPENAI_BASE_URL: stack.fakeOpenAI.baseUrl,
            OPENAI_MODEL: 'fake-model',
            QWEN_MODEL: 'fake-model',
            NO_PROXY: '127.0.0.1,localhost',
          },
        },
      );
      const terminal: Terminal = {
        name,
        proc,
        cwd,
        sessionId: '',
        ipcPath: '',
        output: '',
      };
      terminals.push(terminal);
      const capture = (chunk: Buffer) => {
        terminal.output = (terminal.output + String(chunk)).slice(-100_000);
      };
      proc.stdout!.on('data', capture);
      proc.stderr!.on('data', capture);
      proc.on('error', (error) => {
        terminal.error = error;
      });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (terminal.error) throw terminal.error;
        if (proc.exitCode !== null) {
          throw new Error(
            `TUI exited before ready: ${terminal.output.slice(-4000)}`,
          );
        }
        const record = (await records()).find(
          (candidate) => candidate.cwd === cwd && candidate.ipcPath,
        );
        terminal.sessionId = record?.sessionId ?? '';
        terminal.ipcPath = record?.ipcPath ?? '';
        if (record && terminal.output.includes('Type your message')) {
          return terminal;
        }
        await sleep(100);
      }
      throw new Error(
        `TUI did not become ready: ${terminal.output.slice(-4000)}`,
      );
    }

    async function page() {
      const discovery = await readLiveDiscovery(stack.discoveryDir);
      const response = await fetch(`${stack.live.url}/live/subagents`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${discovery.token}`,
          'x-qwen-live-harness-nonce': discovery.instanceNonce,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'list' }),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as SubagentsControlResult;
      if (result.type !== 'page') throw new Error(JSON.stringify(result));
      return result.page;
    }

    async function tool(name: string, args: Record<string, unknown> = {}) {
      const callId = `peer-instructions-${++sequence}`;
      const fromIndex = stack.fakeDash.inbox.length;
      conn.queueFunctionCall({
        name,
        argumentsJson: JSON.stringify(args),
        callId,
      });
      conn.speakTranscript(`${TRANSCRIPT}: ${name}`);
      const receipt = await stack.fakeDash.waitForMessage(
        (message) => functionCallOutputOf(message)?.callId === callId,
        { fromIndex, timeoutMs: 30_000, description: `${name} receipt` },
      );
      if (name !== 'handoff') {
        await waitForLiveResponseAfter(stack, receipt, 'tool_continuation');
      }
      const result = JSON.parse(
        functionCallOutputOf(receipt)!.output,
      ) as Record<string, unknown>;
      expect(JSON.stringify(result).includes(controllerToken)).toBe(false);
      return result;
    }

    async function waitForDelivery(
      id: string,
      status: string,
      timeout = 10_000,
    ) {
      await expect
        .poll(
          async () =>
            (await page()).instructionDeliveries?.find(
              (entry) => entry.id === id,
            )?.status,
          { timeout },
        )
        .toBe(status);
      const monitored = await tool('session_monitor', { delivery: id });
      expect(monitored).toMatchObject({
        status: 'ok',
        delivery: id,
        delivery_status: status,
        execution_state: 'unknown',
      });
      expect(monitored['job']).toBeUndefined();
      return monitored;
    }

    const hasModelInput = (text: string) =>
      stack.fakeOpenAI.requests.some((request) =>
        JSON.stringify(request.body['messages']).includes(text),
      );
    async function expectNoTasks() {
      const current = await page();
      expect(current.total).toBe(0);
      expect(current.snapshot.tasks).toEqual([]);
      expect(
        Object.values(current.snapshot.counts).every((value) => value === 0),
      ).toBe(true);
      return current;
    }

    it('delivers only the original instruction and keeps the receipt separate from completion', async () => {
      const listed = await tool('session_list');
      const rows = (
        listed['sessions'] as Array<Record<string, unknown>>
      ).filter((row) => row['source'] === 'terminal');
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row).toMatchObject({
          state: 'unknown',
          instruction_only: true,
          text_instructions: true,
        });
        expect(row['read_only']).not.toBe(true);
      }
      terminalHandle = String(
        rows.find((row) => row['cwd'] === normal.cwd)!['handle'],
      );
      heldHandle = String(
        rows.find((row) => row['cwd'] === held.cwd)!['handle'],
      );
      refusedHandle = String(
        rows.find((row) => row['cwd'] === refused.cwd)!['handle'],
      );
      expect(stack.fakeOpenAI.requests).toHaveLength(0);
      const receipt = await tool('handoff', {
        session: terminalHandle,
        task: SUCCESS,
      });
      expect(receipt['status']).toBe('sent');
      expect(receipt['job']).toBeUndefined();
      successDelivery = String(receipt['delivery']);
      expect(successDelivery).toMatch(/^delivery_\d+$/);
      await waitForDelivery(successDelivery, 'delivered');
      await expect
        .poll(() => hasModelInput(SUCCESS), { timeout: 15_000 })
        .toBe(true);
      const messages = JSON.stringify(
        stack.fakeOpenAI.requests[0].body['messages'],
      );
      expect(messages).toContain('origin=\\"controller\\"');
      expect(messages).not.toContain(TRANSCRIPT);
      expect(messages.includes(controllerToken)).toBe(false);
      expect(normal.output).not.toContain(RESPONSE);
      const current = await expectNoTasks();
      expect(current.instructionDeliveries).toEqual([
        expect.objectContaining({
          id: successDelivery,
          session: terminalHandle,
          status: 'delivered',
        }),
      ]);
      evidence['deliveredBeforeModelResponse'] = true;
      evidence['originalInstructionOnly'] = true;
      modelGate.resolve();
      await expect
        .poll(() => normal.output.includes(RESPONSE), { timeout: 10_000 })
        .toBe(true);
      await expectNoTasks();
      expect(
        stack.fakeDash.inbox.some((message) =>
          contextTextOf(message)?.startsWith('[COMPLETE '),
        ),
      ).toBe(false);
    });

    it('rejects images and stopping without sending another instruction', async () => {
      const before = (await page()).instructionDeliveries?.length;
      const images = await tool('handoff', {
        session: terminalHandle,
        task: 'This image instruction must not be delivered.',
        input_refs: ['asset-not-for-terminal'],
      });
      expect(images['status']).toBe('rejected');
      expect(images['delivery']).toBeUndefined();
      expect(
        await tool('session_stop', { session: terminalHandle }),
      ).toMatchObject({ status: 'unsupported', session: terminalHandle });
      expect(
        await tool('session_monitor', { session: terminalHandle }),
      ).toMatchObject({
        status: 'ok',
        state: 'unknown',
        instruction_only: true,
      });
      expect((await page()).instructionDeliveries).toHaveLength(before!);
      expect(stack.fakeOpenAI.requests).toHaveLength(1);
      evidence['imageAndStopRejected'] = true;
    });

    it('tracks held and then denied without granting permission or invoking the model', async () => {
      const receipt = await tool('handoff', {
        session: heldHandle,
        task: HELD,
      });
      expect(receipt['status']).toBe('sent');
      const delivery = String(receipt['delivery']);
      await waitForDelivery(delivery, 'held');
      expect(hasModelInput(HELD)).toBe(false);
      held.proc.stdin!.write('/peers\r');
      await expect
        .poll(() => held.output.includes('Release with /peers accept'), {
          timeout: 5000,
        })
        .toBe(true);
      held.proc.stdin!.write('/peers deny all\r');
      await waitForDelivery(delivery, 'denied');
      expect(hasModelInput(HELD)).toBe(false);
      expect((await expectNoTasks()).unassignedPermissions ?? []).toEqual([]);
      evidence['heldThenDenied'] = true;

      const accepted = await tool('handoff', {
        session: heldHandle,
        task: HELD_ACCEPT,
      });
      const acceptedDelivery = String(accepted['delivery']);
      await waitForDelivery(acceptedDelivery, 'held');
      expect(hasModelInput(HELD_ACCEPT)).toBe(false);
      const outputOffset = held.output.length;
      held.proc.stdin!.write('/peers\r');
      await expect
        .poll(
          () =>
            held.output
              .slice(outputOffset)
              .includes('Release with /peers accept'),
          { timeout: 5000 },
        )
        .toBe(true);
      held.proc.stdin!.write('/peers accept all\r');
      await waitForDelivery(acceptedDelivery, 'delivered');
      await expect
        .poll(() => held.output.includes(RESPONSE), { timeout: 10_000 })
        .toBe(true);
      expect(
        stack.fakeOpenAI.requests.filter((request) =>
          JSON.stringify(request.body['messages']).includes(HELD_ACCEPT),
        ),
      ).toHaveLength(1);
      await expectNoTasks();
      evidence['heldThenAcceptedOnce'] = true;
    });

    it('reports explicit receiver refusal without invoking the model', async () => {
      const receipt = await tool('handoff', {
        session: refusedHandle,
        task: REFUSED,
      });
      await waitForDelivery(String(receipt['delivery']), 'refused');
      expect(hasModelInput(REFUSED)).toBe(false);
      await expectNoTasks();
      evidence['refused'] = true;
    });

    it('keeps a revoked-token send unknown when the receiver provides no receipt', async () => {
      await controllers(['remove', controllerId]);
      controllerRemoved = true;
      expect((await controllers(['list', '--json'])).stdout.trim()).toBe('');
      const receipt = await tool('handoff', {
        session: terminalHandle,
        task: REVOKED,
      });
      expect(['sent', 'unknown']).toContain(receipt['status']);
      expect(receipt['job']).toBeUndefined();
      await waitForDelivery(String(receipt['delivery']), 'unknown', 45_000);
      expect(hasModelInput(REVOKED)).toBe(false);
      const current = await expectNoTasks();
      expect(current.instructionDeliveries).toHaveLength(5);
      expect(JSON.stringify(current).includes(controllerToken)).toBe(false);
      evidence['revokedTokenUnknown'] = true;
      evidence['terminalTaskCount'] = current.total;
    });

    it('keeps managed daemon prompts on REST with their normal job and completion', async () => {
      const created = await tool('session_create', {
        label: 'PR2 REST worker',
      });
      expect(created['status']).toBe('ok');
      const receipt = await tool('handoff', {
        session: created['handle'],
        task: MANAGED,
      });
      expect(receipt['status']).toBe('accepted');
      expect(receipt['job']).toMatch(/^job_\d+$/);
      expect(receipt['delivery']).toBeUndefined();
      const completion = await stack.fakeDash.waitForMessage(
        (message) =>
          contextTextOf(message)?.includes(
            `[COMPLETE ${String(receipt['job'])}]`,
          ) ?? false,
        { timeoutMs: 30_000, description: 'managed REST completion' },
      );
      expect(contextTextOf(completion)).toContain('PR2 managed REST response');
      expect(hasModelInput(MANAGED)).toBe(true);
      const current = await page();
      expect(current.total).toBe(1);
      expect(current.instructionDeliveries).toHaveLength(5);
      evidence['managedRestPreserved'] = true;
    });

    it('removes terminal entries after exit and cleans up the call endpoint', async () => {
      for (const terminal of terminals) terminal.proc.stdin!.write('/quit\r');
      await expect
        .poll(() => terminals.map((terminal) => terminal.proc.exitCode), {
          timeout: 10_000,
        })
        .toEqual([0, 0, 0]);
      expect((await page()).discoveredSessions).toEqual([]);
      expect(terminals.map((terminal) => existsSync(terminal.ipcPath))).toEqual(
        [false, false, false],
      );
      const stateIndex = stack.host.states.length;
      stack.host.action('stop');
      await stack.host.waitForState(
        (state) => state.status['state'] === 'idle',
        { fromIndex: stateIndex },
      );
      await expect
        .poll(
          async () =>
            (await records()).filter(
              (record) => record.name === 'live-qwen-code',
            ).length,
        )
        .toBe(0);
      const registry = await readFile(
        path.join(qwenHome, 'peer-controllers.json'),
        'utf8',
      );
      expect(registry.includes(controllerToken)).toBe(false);
      expect((await page()).discoveredSessions).toBeUndefined();
      expect(existsSync(liveIpcPath)).toBe(false);
      evidence['terminalExitAndCallCleanup'] = true;
      evidence['peerSocketsRemoved'] = true;
    });
  },
);
