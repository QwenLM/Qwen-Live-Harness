/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { liveMessage, liveText } from './i18n/messages.js';

export type LiveCliCommand = 'start' | 'init' | 'help';

export interface LiveCliArgs {
  command: LiveCliCommand;
  debug: boolean;
  daemonOnly: boolean;
}

export const LIVE_CLI_USAGE = liveText('en', 'cli.usage');

export function parseLiveCliArgs(args: readonly string[]): LiveCliArgs {
  let command: LiveCliCommand = 'start';
  let debug = false;
  let daemonOnly = false;
  for (const argument of args) {
    if (argument === '--debug' || argument === '-d') {
      debug = true;
      continue;
    }
    if (argument === '--daemon-only') {
      daemonOnly = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      command = 'help';
      continue;
    }
    if (argument === 'init' && command === 'start') {
      command = 'init';
      continue;
    }
    throw new Error(liveMessage('cli.unknownArgument', { argument }));
  }
  if (daemonOnly && command === 'init')
    throw new Error(
      liveMessage('cli.unknownArgument', { argument: '--daemon-only init' }),
    );
  return { command, debug, daemonOnly };
}
