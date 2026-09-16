/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { liveMessage, liveText } from './i18n/messages.js';

export type LiveCliCommand = 'start' | 'init' | 'doctor' | 'help';

export interface LiveCliArgs {
  command: LiveCliCommand;
  debug: boolean;
  daemonOnly: boolean;
  peers?: true;
}

export const LIVE_CLI_USAGE = liveText('en', 'cli.usage');

export function parseLiveCliArgs(args: readonly string[]): LiveCliArgs {
  let command: LiveCliCommand = 'start';
  let debug = false;
  let daemonOnly = false;
  let peers = false;
  for (const argument of args) {
    if (argument === '--debug' || argument === '-d') {
      debug = true;
      continue;
    }
    if (argument === '--daemon-only') {
      daemonOnly = true;
      continue;
    }
    if (argument === '--peers') {
      peers = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      command = 'help';
      continue;
    }
    if ((argument === 'init' || argument === 'doctor') && command === 'start') {
      command = argument;
      continue;
    }
    throw new Error(liveMessage('cli.unknownArgument', { argument }));
  }
  if (daemonOnly && (command === 'init' || command === 'doctor'))
    throw new Error(
      liveMessage('cli.unknownArgument', {
        argument: `--daemon-only ${command}`,
      }),
    );
  if ((peers && command === 'start') || (command === 'doctor' && !peers))
    throw new Error(
      liveMessage('cli.unknownArgument', {
        argument:
          command === 'doctor'
            ? 'doctor (use doctor --peers)'
            : '--peers (use init --peers or doctor --peers)',
      }),
    );
  return {
    command,
    debug,
    daemonOnly,
    ...(peers ? { peers: true as const } : {}),
  };
}
