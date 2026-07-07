import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./packages/shared', import.meta.url)),
    },
  },
  test: {
    include: [
      'apps/desktop/src/**/*.test.ts',
      'packages/**/src/**/*.test.ts',
      'packages/shared/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
