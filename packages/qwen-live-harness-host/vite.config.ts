import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  // Native icons/localizations belong in mac.extraResources, not in renderer.
  // build.mjs copies only the audio worklet that the renderer actually loads.
  publicDir: false,
  resolve: {
    alias: {
      'qwen-live-harness/subagents': resolve(
        __dirname,
        '../qwen-live-harness/src/subagents/types.ts',
      ),
      'qwen-live-harness/i18n': resolve(
        __dirname,
        '../qwen-live-harness/src/i18n/messages.ts',
      ),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/renderer/index.html'),
        subagents: resolve(__dirname, 'src/renderer/subagents.html'),
      },
    },
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
