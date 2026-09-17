#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Scripted ACP agent child for adaptor lifecycle tests — the same shape
// as integration-tests/fixtures/mock-acp-child/agent.mjs but free of any
// @qwen-code dependency (qwen-live-harness must not depend on acp-bridge). Uses
// the real AgentSideConnection so the NDJSON framing, handshake, and
// error shapes match production.
//
// Modes (env FAKE_ACP_MODE, default "echo"):
//   echo              chunked reply then end_turn; prompts containing
//                     "permission:" raise session/request_permission first
//   crash-after-init  process.exit(42) inside initialize
//
// Mid-turn steering (env FAKE_ACP_DRAINS, default "0"): the maximum number
// of times a turn pulls the client's `craft/drainMidTurnQueue`, the way
// qwen-code does between tool batches. Anything above 0 makes the harness
// report native steering instead of degrading to queue-until-idle, which is
// the only way CI can exercise that tier — a real agent CLI is not available
// there. Drained text is echoed back so a test can assert the instruction
// reached the running turn, and the turn settles as soon as something
// arrives, so the budget can be generous without making tests slow. A pull
// also runs right after session/new, so the harness reports native steering
// from the first turn instead of only after one has completed.
// FAKE_ACP_DRAIN_DELAY_MS spaces the pulls out.

import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { Writable, Readable } from 'node:stream';
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';

// Protect the stdout NDJSON pipe.
/* eslint-disable no-undef */
console.log = console.error;
console.info = console.error;
console.debug = console.error;
console.dir = console.error;
/* eslint-enable no-undef */

const mode = process.env['FAKE_ACP_MODE'] ?? 'echo';
// Optional approval modes for session-mode tests (env FAKE_ACP_MODES, e.g.
// "default,yolo"): when set the agent advertises them, honors
// session/set_mode, and only raises session/request_permission while the
// current mode is the first (asking) one — the shape a real agent has, so a
// configured backend `sessionMode` is observable from the outside.
const advertisedModes = (process.env['FAKE_ACP_MODES'] ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
// How many mid-turn drains one prompt performs before settling.
const drainsPerTurn = Number.parseInt(
  process.env['FAKE_ACP_DRAINS'] ?? '0',
  10,
);
const drainDelayMs = Number.parseInt(
  process.env['FAKE_ACP_DRAIN_DELAY_MS'] ?? '10',
  10,
);
const askingModeId = advertisedModes[0];
let currentModeId = askingModeId;
let sessionCounter = 0;

/** No advertised modes (legacy fixture) always asks. */
function asksForApproval() {
  return advertisedModes.length === 0 || currentModeId === askingModeId;
}

new AgentSideConnection(
  (connection) => ({
    async initialize() {
      if (mode === 'crash-after-init') {
        process.exit(42);
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fake-acp-agent', version: '0.0.1' },
        authMethods: [{ id: 'openai', name: 'Use OpenAI API key' }],
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {
            image: true,
            audio: false,
            embeddedContext: false,
          },
        },
      };
    },

    async authenticate() {
      return {};
    },

    async newSession() {
      const sessionId = `fake-${++sessionCounter}`;
      // Flip the client's mid-turn latch before any prompt. Fire-and-forget:
      // this must not hold up the session/new reply.
      if (drainsPerTurn > 0) {
        void Promise.resolve().then(async () => {
          try {
            await connection.extMethod('craft/drainMidTurnQueue', {
              sessionId,
            });
          } catch {
            /* a client without the ext method simply has no steering */
          }
        });
      }
      if (advertisedModes.length === 0) return { sessionId };
      return {
        sessionId,
        modes: {
          currentModeId,
          availableModes: advertisedModes.map((id) => ({ id, name: id })),
        },
      };
    },

    async setSessionMode(params) {
      if (!advertisedModes.includes(params.modeId)) {
        throw RequestError.invalidParams(
          undefined,
          `unknown mode ${String(params.modeId)}`,
        );
      }
      currentModeId = params.modeId;
      return {};
    },

    async prompt(params) {
      const { sessionId } = params;
      const text = params.prompt
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(' ');

      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `echo: ${text}` },
        },
      });

      if (text.includes('permission:') && asksForApproval()) {
        const response = await connection.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: `${sessionId}-write`,
            kind: 'edit',
            name: 'write_file',
            title: text.slice(0, 80),
          },
          options: [
            {
              optionId: 'proceed_once',
              name: 'Allow once',
              kind: 'allow_once',
            },
            { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
          ],
        });
        const allowed =
          response.outcome?.outcome === 'selected' &&
          response.outcome.optionId === 'proceed_once';
        if (allowed) {
          await connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '\npermission granted' },
            },
          });
        }
        return allowed
          ? { stopReason: 'end_turn' }
          : { stopReason: 'cancelled' };
      }

      // Pull mid-turn steering the way qwen-code does between tool
      // batches, and echo whatever arrives so the harness side can assert
      // the instruction actually reached THIS turn.
      for (let pull = 0; pull < drainsPerTurn; pull += 1) {
        await setTimeout(drainDelayMs);
        let drained;
        try {
          drained = await connection.extMethod('craft/drainMidTurnQueue', {
            sessionId,
          });
        } catch {
          // A client without the ext method disables steering for good; the
          // fixture just stops pulling, exactly as a real agent would.
          break;
        }
        const messages = Array.isArray(drained?.messages)
          ? drained.messages
          : [];
        for (const message of messages) {
          await connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `\nsteered: ${message}` },
            },
          });
        }
        // Settle once steering has landed, so a generous pull budget costs
        // nothing on the path a test actually exercises.
        if (messages.length > 0) break;
      }

      await setTimeout(50);
      return { stopReason: 'end_turn' };
    },

    async cancel() {},

    async extMethod(method) {
      if (method === 'craft/drainMidTurnQueue') {
        return { messages: [], hasQueuedPrompt: false };
      }
      throw RequestError.methodNotFound(method);
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);

process.stdin.on('end', () => process.exit(0));
