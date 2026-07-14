import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const shared = resolve(__dirname, '../../packages/shared');

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['nanoid'] })],
    resolve: {
      alias: { '@shared': shared },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // Native modules: must load from node_modules at runtime so their
        // binary lookup works (bundling breaks __dirname-relative paths).
        // optionalDependencies are not covered by externalizeDepsPlugin.
        external: ['uiohook-napi', 'openloom-camera-effects'],
      },
    },
  },
  preload: {
    resolve: {
      alias: { '@shared': shared },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: { '@shared': shared },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          launcher: resolve(__dirname, 'src/renderer/launcher.html'),
          hud: resolve(__dirname, 'src/renderer/hud.html'),
          bubble: resolve(__dirname, 'src/renderer/bubble.html'),
          countdown: resolve(__dirname, 'src/renderer/countdown.html'),
          draw: resolve(__dirname, 'src/renderer/draw.html'),
          engine: resolve(__dirname, 'src/renderer/engine.html'),
        },
      },
    },
  },
});
