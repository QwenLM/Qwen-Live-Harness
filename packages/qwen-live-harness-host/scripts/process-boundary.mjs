import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PROCESS_MODULE = /^(?:node:)?child_process$/u;
const STARTUP_MODULE = realpathSync(
  fileURLToPath(
    new URL('../../qwen-live-harness/src/startup.ts', import.meta.url),
  ),
);

function isDaemonStartup(importer) {
  if (!importer) return false;
  try {
    return realpathSync(importer) === STARTUP_MODULE;
  } catch {
    return false;
  }
}

/** Process APIs belong only to the registered daemon launcher in main. */
export function hostProcessBoundary({ allowDaemonStartup = false } = {}) {
  return {
    name: 'host-process-boundary',
    setup(build) {
      // createRequire and getBuiltinModule do not pass through onResolve.
      // Inspect every file actually loaded into this bundle as well.
      build.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
        const source = await readFile(args.path, 'utf8');
        if (
          source.includes('child_process') &&
          !(allowDaemonStartup && isDaemonStartup(args.path))
        ) {
          return {
            errors: [
              {
                text: `Process module reference is not allowed in ${args.path}. Only the main-process daemon startup module may use it.`,
              },
            ],
          };
        }
      });
      build.onResolve({ filter: /^(node:)?child_process$/ }, (args) => {
        if (allowDaemonStartup && isDaemonStartup(args.importer)) return;
        return {
          errors: [
            {
              text: `Process module ${args.path} is not allowed in ${args.importer || 'this entry point'}. Only the main-process daemon startup module may import it.`,
            },
          ],
        };
      });
    },
  };
}

/** Vite must reject process imports before its browser-external shims run. */
export function rendererProcessBoundary() {
  return {
    name: 'renderer-process-boundary',
    enforce: 'pre',
    resolveId(source) {
      if (PROCESS_MODULE.test(source)) {
        this.error(
          `Process module ${source} is not allowed in a Host renderer.`,
        );
      }
      return null;
    },
    transform(source) {
      if (source.includes('child_process')) {
        this.error(
          'Process module references are not allowed in a Host renderer.',
        );
      }
      return null;
    },
  };
}
