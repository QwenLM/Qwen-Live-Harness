import { randomUUID } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  isLiveTheme,
  isLiveThemeColor,
  type LiveTheme,
  type LiveThemeColor,
} from '../shared/theme.ts';

export function readHostTheme(path: string): LiveTheme {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      value &&
      typeof value === 'object' &&
      'theme' in value &&
      isLiveTheme(value.theme)
    )
      return value.theme;
  } catch {
    /* Missing or corrupt UI preference falls back to the system. */
  }
  return 'system';
}

export function saveHostTheme(path: string, theme: LiveTheme): void {
  if (!isLiveTheme(theme)) throw new TypeError('Invalid Host theme');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ theme }), {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Rename consumed the temporary file. */
    }
  }
}

export function readHostThemeColor(configPath?: string): LiveThemeColor {
  if (!configPath) return 'iris';
  try {
    const value: unknown = JSON.parse(
      readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''),
    );
    if (
      value &&
      typeof value === 'object' &&
      'themeColor' in value &&
      isLiveThemeColor(value.themeColor)
    )
      return value.themeColor;
  } catch {
    // A missing or invalid cosmetic preference must not prevent a call.
  }
  return 'iris';
}

const MAX_CONFIG_BYTES = 1024 * 1024;

function safeTarget(configPath: string): {
  path: string;
  parent: string;
  directory: Stats;
} {
  if (
    typeof configPath !== 'string' ||
    !isAbsolute(configPath) ||
    configPath !== resolve(configPath) ||
    basename(configPath) !== 'config.json' ||
    /\p{Cc}/u.test(configPath)
  ) {
    throw new Error('Invalid theme configuration path.');
  }
  const parentPath = dirname(configPath);
  const directory = lstatSync(parentPath);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (process.getuid && directory.uid !== process.getuid()) ||
    (directory.mode & 0o022) !== 0
  ) {
    throw new Error('Theme configuration directory is not safe.');
  }
  accessSync(parentPath, constants.W_OK | constants.X_OK);
  const parent = realpathSync(parentPath);
  return { path: join(parent, 'config.json'), parent, directory };
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink
  );
}

function readWritableConfig(path: string): { contents: Buffer; stat: Stats } {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > MAX_CONFIG_BYTES ||
    (stat.mode & 0o200) === 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error('Theme configuration is not a writable regular file.');
  }
  accessSync(path, constants.R_OK | constants.W_OK);
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!sameFile(stat, fstatSync(descriptor)))
      throw new Error('Theme configuration changed while opening.');
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        bytes,
        buffer.length - bytes,
        null,
      );
      if (!count) break;
      bytes += count;
    }
    if (bytes !== stat.size || !sameFile(stat, fstatSync(descriptor)))
      throw new Error('Theme configuration changed while reading.');
    const contents = buffer.subarray(0, bytes);
    return { contents, stat };
  } finally {
    closeSync(descriptor);
  }
}

/** Edit only a root value; preserve unrelated JSON lexemes, including large numbers. */
function replacePalette(contents: Buffer, color: LiveThemeColor): string {
  const raw = contents.toString('utf8');
  if (!Buffer.from(raw, 'utf8').equals(contents))
    throw new Error('Theme configuration is not valid UTF-8.');
  const start = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch {
    throw new Error('Theme configuration is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Theme configuration must be a JSON object.');
  const whitespace = (at: number) => {
    while (/\s/u.test(raw[at] ?? '') && at < raw.length) at++;
    return at;
  };
  const stringEnd = (at: number) => {
    at++;
    while (at < raw.length) {
      if (raw[at] === '\\') at += 2;
      else if (raw[at++] === '"') return at;
    }
    throw new Error('Invalid theme configuration string.');
  };
  let at = whitespace(start) + 1;
  let fields = 0;
  let palette: { start: number; end: number } | undefined;
  while (raw[whitespace(at)] !== '}') {
    at = whitespace(at);
    const keyEnd = stringEnd(at);
    const key = JSON.parse(raw.slice(at, keyEnd)) as string;
    at = whitespace(whitespace(keyEnd) + 1);
    const valueStart = at;
    let depth = 0;
    while (at < raw.length) {
      const character = raw[at];
      if (character === '"') {
        at = stringEnd(at);
        continue;
      }
      if (character === '{' || character === '[') depth++;
      else if (character === '}' || character === ']') {
        if (depth === 0) break;
        depth--;
      } else if (character === ',' && depth === 0) break;
      at++;
    }
    let valueEnd = at;
    while (valueEnd > valueStart && /\s/u.test(raw[valueEnd - 1]!)) valueEnd--;
    if (key === 'themeColor') {
      if (palette)
        throw new Error('Theme configuration contains duplicate palette keys.');
      palette = { start: valueStart, end: valueEnd };
    }
    fields++;
    if (raw[at] === ',') at++;
  }
  if (palette)
    return (
      raw.slice(0, palette.start) +
      JSON.stringify(color) +
      raw.slice(palette.end)
    );
  const closing = whitespace(at);
  let insertion = closing;
  while (insertion > start && /\s/u.test(raw[insertion - 1]!)) insertion--;
  const multiline = raw.includes('\n');
  const separator = fields
    ? multiline
      ? ',\n  '
      : ','
    : multiline
      ? '\n  '
      : '';
  return (
    raw.slice(0, insertion) +
    `${separator}"themeColor":${multiline ? ' ' : ''}${JSON.stringify(color)}` +
    raw.slice(insertion)
  );
}

/** Save only into an existing connected config. Never create or repair a config implicitly. */
export function saveHostThemeColor(
  configPath: string,
  color: LiveThemeColor,
  isCurrent: () => boolean = () => true,
): void {
  if (!isLiveThemeColor(color)) throw new TypeError('Invalid Host palette');
  if (!isCurrent())
    throw new Error('Theme configuration is no longer connected.');
  const target = safeTarget(configPath);
  const before = readWritableConfig(target.path);
  const next = replacePalette(before.contents, color);
  const temporary = join(
    target.parent,
    `.config.json.palette-${randomUUID()}.tmp`,
  );
  let created = false;
  try {
    const descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, next, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (!isCurrent())
      throw new Error('Theme configuration is no longer connected.');
    const currentTarget = safeTarget(configPath);
    const directory = currentTarget.directory;
    if (
      currentTarget.parent !== target.parent ||
      directory.dev !== target.directory.dev ||
      directory.ino !== target.directory.ino
    )
      throw new Error('Theme configuration directory changed.');
    const current = readWritableConfig(target.path);
    if (
      !sameFile(before.stat, current.stat) ||
      !before.contents.equals(current.contents)
    )
      throw new Error('Theme configuration changed before saving.');
    renameSync(temporary, target.path);
  } finally {
    if (created) {
      try {
        unlinkSync(temporary);
      } catch {
        /* successful rename consumed the temporary file */
      }
    }
  }
}
