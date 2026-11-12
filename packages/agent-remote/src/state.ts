import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Reuse legacy files in place; never copy or rotate a paired token. */
export function stateDirectory(explicit?: string, home = homedir()): string {
  if (explicit) return resolve(explicit);
  const legacy = join(home, '.qwen-live-harness', 'mobile');
  if (
    ['device-token', 'server-cert.pem', 'server-key.pem'].some((name) =>
      existsSync(join(legacy, name)),
    )
  )
    return legacy;
  return join(home, '.agent-remote');
}

export function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (
    lstatSync(directory).isSymbolicLink() ||
    !lstatSync(directory).isDirectory()
  )
    throw new Error('State must use a real directory');
  chmodSync(directory, 0o700);
}
