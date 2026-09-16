/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Client } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { LiveLogger } from '../logger.js';
import { AcpAdaptor, type AcpConnectionLike } from './acp-adaptor.js';

interface ModeRigOptions {
  name?: string;
  modes?: Array<{ id: string; name: string }>;
  currentModeId?: string;
  sessionMode?: string;
}

function createModeRig(options: ModeRigOptions = {}) {
  let client!: Client;
  let currentModeId = options.currentModeId ?? 'agent';
  const availableModes = options.modes ?? [
    { id: 'read-only', name: 'Ask for approval' },
    { id: 'agent', name: 'Approve for me' },
    { id: 'agent-full-access', name: 'Full access' },
  ];
  const setSessionMode = vi.fn(async (params: Record<string, unknown>) => {
    const mode = availableModes.find((entry) => entry.id === params['modeId']);
    if (!mode) {
      throw Object.assign(new Error('Invalid params'), { code: -32602 });
    }
    currentModeId = mode.id;
    return {};
  });
  const connection: AcpConnectionLike = {
    initialize: async () => ({ agentCapabilities: {}, authMethods: [] }),
    authenticate: async () => ({}),
    newSession: async () => ({
      sessionId: 'codex-modes-session',
      modes: { currentModeId, availableModes },
    }),
    prompt: async () => ({ stopReason: 'end_turn' }),
    cancel: async () => {},
    extMethod: async () => ({}),
    setSessionMode,
  };
  const logger = new LiveLogger();
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  const adaptor = new AcpAdaptor({
    name: options.name ?? 'codex',
    command: 'unused-test-fixture',
    defaultCwd: '/fixture',
    logger,
    ...(options.sessionMode ? { sessionMode: options.sessionMode } : {}),
    connect: async (value) => {
      client = value;
      return connection;
    },
  });
  return {
    adaptor,
    client: () => client,
    currentModeId: () => currentModeId,
    setSessionMode,
    warn,
    info,
  };
}

describe('ACP permission mode compatibility', () => {
  it('selects the advertised Codex asking mode instead of its automated default', async () => {
    const rig = createModeRig();
    try {
      const handle = await rig.adaptor.createSession();

      expect(handle).toEqual({
        id: 'codex-modes-session',
        adaptor: 'codex',
      });
      expect(rig.setSessionMode).toHaveBeenCalledExactlyOnceWith({
        sessionId: handle.id,
        modeId: 'read-only',
      });
      expect(rig.currentModeId()).toBe('read-only');
      expect(rig.warn).not.toHaveBeenCalled();
      expect(rig.info).toHaveBeenCalledWith(
        expect.stringContaining(
          'approval mode "read-only": every action needs approval',
        ),
      );
    } finally {
      await rig.adaptor.close();
    }
  });

  it('honors a configured sessionMode instead of the asking mode', async () => {
    const rig = createModeRig({
      name: 'qwen',
      currentModeId: 'yolo',
      modes: [
        { id: 'default', name: 'Default' },
        { id: 'auto-edit', name: 'Auto Edit' },
        { id: 'yolo', name: 'YOLO' },
      ],
      sessionMode: 'yolo',
    });
    try {
      const handle = await rig.adaptor.createSession();

      expect(rig.setSessionMode).toHaveBeenCalledExactlyOnceWith({
        sessionId: handle.id,
        modeId: 'yolo',
      });
      expect(rig.currentModeId()).toBe('yolo');
      expect(rig.warn).not.toHaveBeenCalled();
      expect(rig.info).toHaveBeenCalledWith(
        expect.stringContaining('approval mode "yolo"'),
      );
    } finally {
      await rig.adaptor.close();
    }
  });

  it('falls back to the asking mode when the configured sessionMode is not advertised', async () => {
    const rig = createModeRig({
      name: 'qwen',
      currentModeId: 'default',
      modes: [
        { id: 'default', name: 'Default' },
        { id: 'auto-edit', name: 'Auto Edit' },
      ],
      sessionMode: 'yolo',
    });
    try {
      const handle = await rig.adaptor.createSession();

      expect(rig.setSessionMode).toHaveBeenCalledExactlyOnceWith({
        sessionId: handle.id,
        modeId: 'default',
      });
      expect(rig.currentModeId()).toBe('default');
      expect(rig.warn).toHaveBeenCalledWith(
        expect.stringContaining('sessionMode "yolo" is not advertised'),
      );
      expect(rig.info).toHaveBeenCalledWith(
        expect.stringContaining(
          'approval mode "default": every action needs approval',
        ),
      );
    } finally {
      await rig.adaptor.close();
    }
  });

  it('still forwards an actual file permission request and waits for its answer', async () => {
    const rig = createModeRig();
    try {
      const handle = await rig.adaptor.createSession();
      const events = rig.adaptor.events(handle)[Symbol.asyncIterator]();
      let answered = false;
      const response = rig
        .client()
        .requestPermission({
          sessionId: handle.id,
          toolCall: {
            toolCallId: 'edit-1',
            title: 'Edit fixture.txt',
            kind: 'edit',
          },
          options: [
            { optionId: 'accept', name: 'Yes', kind: 'allow_once' },
            { optionId: 'cancel', name: 'No', kind: 'reject_once' },
          ],
        })
        .then((value) => {
          answered = true;
          return value;
        });

      const event = await events.next();
      expect(event.value).toMatchObject({
        type: 'permission_request',
        requestId: 'perm-1',
        title: 'Edit fixture.txt',
      });
      expect(answered).toBe(false);
      await rig.adaptor.respondPermission(handle, 'perm-1', 'deny');
      expect(await response).toEqual({
        outcome: { outcome: 'selected', optionId: 'cancel' },
      });
    } finally {
      await rig.adaptor.close();
    }
  });
});
