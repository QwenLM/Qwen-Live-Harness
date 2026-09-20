/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  liveMessage,
  type LiveMessageKey,
  type LiveMessageParams,
} from './i18n/messages.js';

/** Keep technical diagnostics stable while providing an owned UI message. */
export class ConfigurationError extends Error {
  readonly displayMessage: string;

  constructor(
    diagnostic: unknown,
    key: LiveMessageKey,
    params: LiveMessageParams = {},
  ) {
    super(
      diagnostic instanceof Error ? diagnostic.message : String(diagnostic),
      { cause: diagnostic },
    );
    this.displayMessage = liveMessage(key, params);
  }
}

export function readConfigurationValue<T>(
  key: LiveMessageKey,
  read: () => T,
  params: LiveMessageParams = {},
): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(error, key, params);
  }
}

export function configurationErrorMessage(error: unknown): string {
  return error instanceof ConfigurationError
    ? error.displayMessage
    : liveMessage('config.invalid');
}
