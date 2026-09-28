/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  fsyncSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVoiceState, isVoiceId, voiceCatalog } from './voice-catalog.js';
import { persistVoicePreference } from './voice-preferences.js';
import { loadConfig } from './config.js';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    fsyncSync: vi.fn(fs.fsyncSync),
    renameSync: vi.fn(fs.renameSync),
  };
});

const dirs: string[] = [];
function fixture(
  raw: unknown = {
    realtimeApiKey: 'fixture-only',
    backends: [],
    voice: 'Tina',
    future: { a: [1, 'two'] },
  },
) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-settings-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'config.json'), JSON.stringify(raw));
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('voice selection', () => {
  it('distinguishes model defaults, dated presets, unsupported and unverified voices', () => {
    expect(voiceCatalog('qwen3.8-omni-flash-realtime').presets).toContain(
      'longanlingxin',
    );
    expect(voiceCatalog('qwen3.5-omni-flash-realtime').custom).toBe(
      'supported',
    );
    expect(
      voiceCatalog('qwen3-omni-flash-realtime-2025-12-01').presets,
    ).toContain('Momo');
    expect(voiceCatalog('qwen3-omni-flash-realtime').presets).not.toContain(
      'Momo',
    );
    expect(voiceCatalog('qwen3-omni-flash-realtime').defaultVoice).toBe(
      'Cherry',
    );
    expect(voiceCatalog('qwen-omni-turbo-realtime').defaultVoice).toBe(
      'Chelsie',
    );
    expect(
      getVoiceState('qwen3.8-omni-flash-realtime', 'Ethan').availability,
    ).toBe('unsupported');
    expect(
      getVoiceState('qwen3.8-omni-flash-realtime', 'account-custom')
        .availability,
    ).toBe('unverified');
    expect(
      getVoiceState('private-deployment', 'future-voice').availability,
    ).toBe('unverified');
    expect(
      getVoiceState('qwen3-omni-flash-realtime', 'account-custom').availability,
    ).toBe('unsupported');
  });
  it('preserves opaque IDs including spaces and accents while bounding control data', () => {
    for (const id of ['Liora Mira', 'Eliška', 'qwen-custom-123'])
      expect(isVoiceId(id)).toBe(true);
    for (const id of [
      '',
      ' Tina',
      'Tina ',
      'bad\nvoice',
      'x'.repeat(257),
      null,
      1,
    ])
      expect(isVoiceId(id)).toBe(false);
  });
  it('persists just voice, reloads it, and keeps environment precedence explicit', () => {
    const dir = fixture();
    const path = join(dir, 'config.json');
    persistVoicePreference(dir, 'Liora Mira');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      realtimeApiKey: 'fixture-only',
      backends: [],
      voice: 'Liora Mira',
      future: { a: [1, 'two'] },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadConfig({ QWEN_LIVE_HARNESS_DATA_DIR: dir }).realtime.voice).toBe(
      'Liora Mira',
    );
    expect(
      loadConfig({
        QWEN_LIVE_HARNESS_DATA_DIR: dir,
        QWEN_LIVE_HARNESS_VOICE: 'Ryan',
      }).realtime,
    ).toMatchObject({ voice: 'Ryan', voiceOverridden: true });
  });
  it('uses the selected model default only when no voice was explicitly configured', () => {
    const dir = fixture({
      realtimeApiKey: 'fixture-only',
      backends: [],
      realtimeModel: 'qwen3-omni-flash-realtime',
    });
    expect(loadConfig({ QWEN_LIVE_HARNESS_DATA_DIR: dir }).realtime.voice).toBe(
      'Cherry',
    );
    expect(
      loadConfig({
        QWEN_LIVE_HARNESS_DATA_DIR: dir,
        QWEN_LIVE_HARNESS_VOICE: 'unknown-manual-id',
      }).realtime.voice,
    ).toBe('unknown-manual-id');
  });
  it('does not overwrite malformed configuration, follow links, or expose secrets on failure', () => {
    const dir = fixture();
    const path = join(dir, 'config.json');
    const broken = '{fixture-secret-invalid';
    writeFileSync(path, broken);
    expect(() => persistVoicePreference(dir, 'Ryan')).toThrow(
      /voice.configInvalid/,
    );
    expect(readFileSync(path, 'utf8')).toBe(broken);
    rmSync(path);
    symlinkSync(join(dir, 'target'), path);
    writeFileSync(join(dir, 'target'), '{}');
    expect(() => persistVoicePreference(dir, 'Ryan')).toThrow(
      /voice.configInvalid/,
    );
    expect(readFileSync(join(dir, 'target'), 'utf8')).toBe('{}');
  });
  it('preserves concurrent configuration edits and removes the temporary write', () => {
    const dir = fixture();
    const path = join(dir, 'config.json');
    const edited = JSON.stringify({ voice: 'Mia', userChange: true });
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      writeFileSync(path, edited);
    });
    expect(() => persistVoicePreference(dir, 'Ryan')).toThrow(
      /voice.concurrentEdit/,
    );
    expect(readFileSync(path, 'utf8')).toBe(edited);
    expect(renameSync).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(['config.json']);
  });
  it.each(['fsync', 'rename'] as const)(
    'preserves the saved voice and removes temporary files when %s fails',
    (stage) => {
      const dir = fixture();
      const path = join(dir, 'config.json');
      const original = readFileSync(path, 'utf8');
      vi.mocked(
        stage === 'fsync' ? fsyncSync : renameSync,
      ).mockImplementationOnce(() => {
        throw new Error('fixture-secret');
      });
      expect(() => persistVoicePreference(dir, 'Ryan')).toThrow(
        /voice.saveFailed/,
      );
      expect(readFileSync(path, 'utf8')).toBe(original);
      expect(readdirSync(dir)).toEqual(['config.json']);
    },
  );
});
