/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseLiveCliArgs } from './cli-args.js';
import { displayLiveMessage } from './i18n/messages.js';

describe('parseLiveCliArgs', () => {
  it('routes incremental peer setup and read-only diagnostics without starting a daemon', () => {
    expect(parseLiveCliArgs(['init', '--peers'])).toEqual({
      command: 'init',
      peers: true,
      debug: false,
      daemonOnly: false,
    });
    expect(parseLiveCliArgs(['--peers', 'doctor'])).toEqual({
      command: 'doctor',
      peers: true,
      debug: false,
      daemonOnly: false,
    });
    expect(parseLiveCliArgs(['doctor', '--peers', '--help']).command).toBe(
      'help',
    );
    for (const args of [
      ['--peers'],
      ['doctor'],
      ['doctor', '--peers', '--daemon-only'],
      ['init', '--peers', '--daemon-only'],
      ['init', 'doctor', '--peers'],
    ]) {
      expect(() => parseLiveCliArgs(args)).toThrow();
    }
  });
  it('enables debug logging for either debug spelling', () => {
    expect(parseLiveCliArgs(['--debug'])).toEqual({
      command: 'start',
      debug: true,
      daemonOnly: false,
    });
    expect(parseLiveCliArgs(['init', '-d'])).toEqual({
      command: 'init',
      debug: true,
      daemonOnly: false,
    });
  });

  it('parses help and rejects unknown arguments', () => {
    expect(parseLiveCliArgs(['--help'])).toEqual({
      command: 'help',
      debug: false,
      daemonOnly: false,
    });
    try {
      parseLiveCliArgs(['--verbose']);
      throw new Error('Expected rejection');
    } catch (error) {
      expect(displayLiveMessage('en', (error as Error).message)).toBe(
        'Unknown qwen-live-harness argument: --verbose',
      );
    }
  });

  it('keeps the internal daemon entry separate from desktop launch and init', () => {
    expect(parseLiveCliArgs(['--daemon-only', '--debug'])).toEqual({
      command: 'start',
      debug: true,
      daemonOnly: true,
    });
    expect(() => parseLiveCliArgs(['init', '--daemon-only'])).toThrow();
  });
});
