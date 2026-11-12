import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

/** Protect pairing files before TLS creation or an explicit token reset. */
export async function claimInstance(
  directory: string,
  port: number,
): Promise<() => void> {
  const filename = join(directory, 'gateway.lock');
  if (existsSync(filename)) {
    if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink())
      throw new Error('Gateway lock must be a regular file');
    const previous = JSON.parse(readFileSync(filename, 'utf8')) as {
      pid: number;
    };
    if (!Number.isInteger(previous.pid) || previous.pid <= 0)
      throw new Error('Invalid gateway lock; inspect it before removing it');
    let alive = true;
    try {
      process.kill(previous.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    }
    if (alive) throw new Error('A gateway already owns this state directory');
    unlinkSync(filename);
  }
  const identity = randomUUID();
  const descriptor = openSync(filename, 'wx', 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, identity }));
  } finally {
    closeSync(descriptor);
  }
  const release = () => {
    try {
      if (
        (JSON.parse(readFileSync(filename, 'utf8')) as { identity: string })
          .identity === identity
      )
        unlinkSync(filename);
    } catch {
      /* Never remove another process's lock. */
    }
  };
  try {
    if (port)
      await new Promise<void>((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(port, '0.0.0.0', () =>
          probe.close((error) => (error ? reject(error) : resolve())),
        );
      });
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
