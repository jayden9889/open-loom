/**
 * Pure logic for the macOS screen-permission probe. No Electron imports so it
 * is unit-testable; permissions.ts binds this to desktopCapturer.
 *
 * Why a probe exists at all: getMediaAccessStatus('screen') wraps
 * CGPreflightScreenCaptureAccess, which macOS 15+ is known to answer 'denied'
 * for a build whose capture actually works (and the reverse after a signature
 * change). The capture pipeline is the only honest witness - but it has to be
 * read carefully, because a DENIED app is still handed a capture: the desktop
 * picture with no other application's windows in it. "The thumbnail is not
 * black" therefore proves nothing (a wallpaper is not black), and a genuinely
 * black screen proves nothing either. What macOS does reliably hide from an
 * unauthorised process is other apps' WINDOW TITLES, so titles are the signal.
 */

/**
 * Windows created by Open Loom itself. Their titles are always visible to us,
 * grant or no grant, so they must never count as evidence.
 * Mirrors the window set in capture.ts (main window + the openloom-* overlays).
 */
function isOwnWindowTitle(title: string): boolean {
  return title === 'Open Loom' || title === 'Open Loom Recorder' || title.startsWith('openloom-');
}

/**
 * What one probe pass concluded:
 *  - 'working'  capture demonstrably sees other apps (titles visible) - the
 *               grant is active regardless of what preflight claims.
 *  - 'blocked'  capture demonstrably cannot see other apps (windows exist but
 *               their titles are hidden) - the grant is not active.
 *  - 'unknown'  nothing to judge by (no foreign windows open at all). Callers
 *               must fall back to the preflight answer and say so.
 */
export type ScreenProbeVerdict = 'working' | 'blocked' | 'unknown';

/**
 * Classify a window-source listing. `titles` is every window title the
 * capturer returned, own windows included; empty strings are windows whose
 * titles the OS withheld.
 */
export function classifyScreenProbe(titles: string[]): ScreenProbeVerdict {
  let hiddenTitles = 0;
  for (const raw of titles) {
    const title = raw.trim();
    if (!title) {
      hiddenTitles++;
      continue;
    }
    // A foreign title is only ever visible to a process holding the grant.
    if (!isOwnWindowTitle(title)) return 'working';
  }
  // No readable foreign titles. Nameless windows are the no-permission
  // signature (macOS strips titles from unauthorised processes); with none of
  // those either, there is simply nothing on screen to judge by.
  return hiddenTitles > 0 ? 'blocked' : 'unknown';
}

/**
 * Largest per-channel spread across an RGBA bitmap. A capture handed to a
 * blocked OR a working process can both contain colourful pixels (wallpaper),
 * so spread never proves a grant - it is logged as a diagnostic only. A
 * spread of 0 means a uniform buffer: a black screen, or a capture that
 * produced nothing.
 */
export function bitmapChannelSpread(rgba: Uint8Array): number {
  if (rgba.length < 4) return 0;
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (let i = 0; i + 2 < rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = rgba[i + c]!;
      if (v < min[c]!) min[c] = v;
      if (v > max[c]!) max[c] = v;
    }
  }
  return Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
}
