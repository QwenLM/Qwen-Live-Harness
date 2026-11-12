import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateDirectory } from './state.js';

const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    ),
);

it('uses a new independent directory on fresh installs and honors explicit isolation', () => {
  const home = mkdtempSync(join(tmpdir(), 'remote-home-'));
  directories.push(home);
  expect(stateDirectory(undefined, home)).toBe(join(home, '.agent-remote'));
  expect(stateDirectory(join(home, 'custom'), home)).toBe(join(home, 'custom'));
});

it('keeps existing paired devices on their original files without copying or resetting them', () => {
  const home = mkdtempSync(join(tmpdir(), 'remote-home-'));
  directories.push(home);
  const legacy = join(home, '.qwen-live-harness/mobile');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'device-token'), 'existing phone credential');
  expect(stateDirectory(undefined, home)).toBe(legacy);
  expect(readFileSync(join(legacy, 'device-token'), 'utf8')).toBe(
    'existing phone credential',
  );
  expect(stateDirectory(join(home, 'custom'), home)).toBe(join(home, 'custom'));
});
