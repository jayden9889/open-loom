/**
 * electron-builder afterPack hook, doing two things in order.
 *
 * 1. Strip every native module binary in the packed app. Locally-compiled .node
 *    addons carry the build machine's absolute paths in their symbol tables
 *    (debug symbols / stabs), which would ship the packager's private directory
 *    layout inside a public release. Stripping removes them; the addons load and
 *    run identically without symbols.
 *
 * 2. Ad-hoc sign the bundle (macOS). Without a Developer ID, electron-builder
 *    skips signing entirely and the app keeps the stock Electron binary's
 *    linker signature - identifier literally "Electron", no sealed resources.
 *    That is an INVALID signature, not merely a missing one, and it is a much
 *    worse failure: a downloaded copy carries quarantine, and quarantine plus a
 *    signature that fails verification produces the "damaged, move to Trash"
 *    refusal, which offers no way through. A valid ad-hoc signature downgrades
 *    that to the ordinary unidentified-developer prompt, which the user can
 *    clear via System Settings > Privacy & Security > Open Anyway.
 *
 *    This is not notarization and does not pretend to be. It is the floor that
 *    makes an unsigned build openable at all. Signing must come after stripping,
 *    since modifying a binary invalidates any signature over it.
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

/**
 * Replace the inherited Electron linker signature with a valid ad-hoc one over
 * the real bundle. electron-builder has already decided not to sign by this
 * point, so nothing downstream overwrites this.
 */
function adhocSign(appOutDir) {
  const app = fs.readdirSync(appOutDir).find((f) => f.endsWith('.app'));
  if (!app) {
    console.warn('  • no .app bundle found; skipping ad-hoc signing');
    return;
  }
  const appPath = path.join(appOutDir, app);
  try {
    // --deep is deprecated for distribution signing but is the correct tool for
    // ad-hoc sealing a nested Electron bundle bottom-up in one pass.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath]);
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath]);
    console.log(`  • ad-hoc signed and verified ${app}`);
  } catch (err) {
    // Shipping an artifact macOS will refuse to open is worse than failing here.
    throw new Error(
      `ad-hoc signing failed for ${app}; the build would not open on another Mac: ${String(err)}`
    );
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
  if (process.platform === 'darwin') adhocSign(context.appOutDir);
}
