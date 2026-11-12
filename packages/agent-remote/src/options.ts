import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { stateDirectory } from './state.js';
import type { GatewayOptions } from './mobile/index.js';

export function parseOptions(args: string[]): GatewayOptions {
  const projects: string[] = [];
  let port = 47421,
    ask = false,
    open = true,
    reset = false;
  let directory = process.env['AGENT_REMOTE_DATA_DIR'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project' && args[i + 1])
      projects.push(realpathSync(resolve(args[++i]!)));
    else if (arg === '--port' && args[i + 1]) port = Number(args[++i]);
    else if (arg === '--data-dir' && args[i + 1])
      directory = resolve(args[++i]!);
    else if (arg === '--ask') ask = true;
    else if (arg === '--no-open') open = false;
    else if (arg === '--reset-pairing') reset = true;
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid port');
  if (!projects.length) projects.push(realpathSync(process.cwd()));
  if (projects.some((path) => !statSync(path).isDirectory()))
    throw new Error('Projects must be directories');
  return {
    projects: [...new Set(projects)],
    port,
    directory: stateDirectory(directory),
    ask,
    open,
    reset,
  };
}
