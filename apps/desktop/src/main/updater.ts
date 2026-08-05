/**
 * Background update checks against the GitHub releases feed.
 *
 * Deliberately quiet: the check runs once a launch, downloads in the
 * background and installs on quit. Nothing interrupts a recording, and the app
 * never restarts itself under the user.
 *
 * This is the only outbound call Open Loom makes without being asked, so it is
 * gated on the `autoUpdate` setting and skipped entirely in development.
 */
import { app } from 'electron';
import { getSettings } from './settings';
import { log } from './logger';

/** Wait for the window and ffmpeg prefetch to settle before touching the network. */
const CHECK_DELAY_MS = 10_000;

/**
 * electron-updater errors carry an HTTP dump and a stack; at warn level that is
 * dozens of lines describing an ordinary offline launch. Keep the sentence.
 */
function firstLine(err: unknown): string {
  return String(err).split('\n')[0]?.trim() ?? 'unknown error';
}

/**
 * electron-updater can only replace an installer it understands. AppImage
 * self-updates; deb and rpm are owned by the system package manager, and
 * pretending otherwise throws on every launch for anyone who apt-installed us.
 */
function updatableInstall(): boolean {
  if (process.platform === 'linux') return Boolean(process.env['APPIMAGE']);
  return true;
}

export function installUpdater(): void {
  // A dev run has no packaged app-update.yml, and e2e must never hit GitHub.
  if (!app.isPackaged) return;
  if (!getSettings().autoUpdate) {
    log.info('update check skipped: autoUpdate is off');
    return;
  }
  if (!updatableInstall()) {
    log.info('update check skipped: this install is managed by the system package manager');
    return;
  }

  setTimeout(() => {
    void (async () => {
      try {
        // electron-updater is CommonJS. Reached through an ESM `import()` its
        // exports land under `.default`, so `mod.autoUpdater` typechecks
        // perfectly and is undefined at runtime. Accept either shape.
        const mod = await import('electron-updater');
        const autoUpdater =
          mod.autoUpdater ?? (mod as unknown as { default: typeof mod }).default.autoUpdater;
        autoUpdater.logger = null;
        // Install on quit rather than prompting. Downloading is safe mid-session;
        // swapping the binary under a live recording is not.
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;

        autoUpdater.on('update-available', (info) => log.info(`update available: ${info.version}`));
        autoUpdater.on('update-not-available', () => log.info('no update available'));
        autoUpdater.on('update-downloaded', (info) =>
          log.info(`update ${info.version} downloaded; installs on quit`)
        );
        // Being offline, or sitting on a release older than the update feed, is
        // normal operating noise rather than a fault in this run.
        autoUpdater.on('error', (err) => log.warn(`update check failed: ${firstLine(err)}`));

        // checkForUpdates rejects with the very error the 'error' handler above
        // has already reported, so awaiting it here would log everything twice.
        void autoUpdater.checkForUpdates().catch(() => undefined);
      } catch (err) {
        log.warn(`updater did not start: ${firstLine(err)}`);
      }
    })();
  }, CHECK_DELAY_MS).unref?.();
}
