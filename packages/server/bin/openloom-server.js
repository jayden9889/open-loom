#!/usr/bin/env node
/**
 * Launcher for openloom-server. Published packages ship dist/ prebuilt;
 * inside the repo run `npm run build -w packages/server` once first.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/index.js', import.meta.url));
if (!existsSync(dist)) {
  console.error('openloom-server: dist/ is missing. Run "npm run build -w packages/server" first.');
  process.exit(1);
}
await import(dist);
