/**
 * Pure updater logic: turn electron-updater outcomes into sentences a user
 * can act on. No Electron imports so it is unit-testable; updater.ts binds
 * this to the real autoUpdater.
 */

/**
 * Where the last update check landed. 'unavailable' means checks cannot work
 * on this install at all (and `detail` says why); 'failed' means this check
 * did not complete; 'available'/'downloaded' carry the new version.
 */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloaded' | 'failed' | 'unavailable';
  /** One plain sentence for the About pane. */
  detail: string;
  /** ISO time of the last completed check, null before the first one. */
  checkedAt: string | null;
  /** New version, when one is known. */
  version?: string;
}

export const RELEASES_URL = 'https://github.com/jayden9889/open-loom/releases/latest';

/**
 * Classify an electron-updater error line. The three cases users actually
 * hit: the release feed is missing (a packaging gap, not their fault), macOS
 * refusing to swap in an unsigned build (this build cannot self-update, tell
 * them where to download), and being offline.
 */
export function describeUpdateError(line: string): { state: 'failed' | 'unavailable'; detail: string } {
  if (line.includes('Cannot find latest-')) {
    return {
      state: 'unavailable',
      detail: 'The latest release does not publish update information, so automatic updates cannot see it. Check the releases page on GitHub for new versions.',
    };
  }
  if (/code signature|code signing|not signed|codesign|could not get code signature/i.test(line)) {
    return {
      state: 'failed',
      detail: 'A new version downloaded, but this copy of Open Loom is not code-signed, so macOS will not let it update itself. Download the new version from GitHub and replace the app.',
    };
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::|ERR_INTERNET|ERR_NETWORK|ERR_CONNECTION/i.test(line)) {
    return {
      state: 'failed',
      detail: 'Could not reach GitHub to check for updates. Check your connection and try again.',
    };
  }
  return { state: 'failed', detail: `The update check failed: ${line}` };
}
