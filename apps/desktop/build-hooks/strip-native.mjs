/**
 * electron-builder afterPack hook: strip every native module binary in the
 * packed app. Locally-compiled .node addons carry the build machine's absolute
 * paths in their symbol tables (debug symbols / stabs), which would ship the
 * packager's private directory layout inside a public release. Stripping
 * removes them; the addons load and run identically without symbols.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

export default function stripNative(context) {
  if (process.platform === 'win32') return; // no strip tool; prebuilds only
  const args = process.platform === 'darwin' ? ['-S', '-x'] : ['--strip-unneeded'];
  for (const file of walk(context.appOutDir)) {
    if (!file.endsWith('.node')) continue;
    try {
      execFileSync('strip', [...args, file]);
      console.log(`  • stripped ${path.relative(context.appOutDir, file)}`);
    } catch (err) {
      console.warn(`  • strip failed for ${file}: ${String(err)}`);
    }
  }
}
