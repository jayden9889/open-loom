/**
 * Update checks against the GitHub releases feed.
 *
 * Quiet in the background but never silent about the outcome: every check
 * lands in an UpdateStatus the About pane shows (last checked, what happened,
 * what to do), alongside a Check now button. Nothing interrupts a recording,
 * and the app never restarts itself under the user.
 *
 * This is the only outbound call Open Loom makes without being asked, so the
 * launch check is gated on the `autoUpdate` setting and skipped entirely in
 * development. The manual Check now works regardless of the toggle - the user
 * asked.
 */
import { app } from 'electron';
import { getSettings } from './settings';
import { describeUpdateError, type UpdateStatus } from './updater-core';
import { log } from './logger';

/** Wait for the window and ffmpeg prefetch to settle before touching the network. */
const CHECK_DELAY_MS = 10_000;

let status: UpdateStatus = { state: 'idle', detail: 'Not checked yet this launch.', checkedAt: null };

export function getUpdateStatus(): UpdateStatus {
  return { ...status };
}

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

/** Why update checks cannot run on this install at all, or null when they can. */
function unavailableReason(): string | null {
  if (!app.isPackaged) return 'Update checks only run in the installed app, not a development build.';
  if (!updatableInstall()) {
    return 'This install is managed by your system package manager, which also handles its updates.';
  }
  return null;
}

type AutoUpdaterModule = typeof import('electron-updater')['autoUpdater'];
let updaterPromise: Promise<AutoUpdaterModule> | null = null;

async function loadAutoUpdater(): Promise<AutoUpdaterModule> {
  if (!updaterPromise) {
    updaterPromise = (async () => {
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

      autoUpdater.on('update-available', (info) => {
        status = {
          state: 'available',
          detail: `Version ${info.version} is available and downloading in the background.`,
          checkedAt: new Date().toISOString(),
          version: info.version,
        };
        log.info(`update available: ${info.version}`);
      });
      autoUpdater.on('update-not-available', () => {
        status = {
          state: 'up-to-date',
          detail: `You are on the latest version (${app.getVersion()}).`,
          checkedAt: new Date().toISOString(),
        };
        log.info('no update available');
      });
      autoUpdater.on('update-downloaded', (info) => {
        status = {
          state: 'downloaded',
          detail: `Version ${info.version} is downloaded and will install when you quit Open Loom.`,
          checkedAt: new Date().toISOString(),
          version: info.version,
        };
        log.info(`update ${info.version} downloaded; installs on quit`);
      });
      // Being offline, or sitting on a release older than the update feed, is
      // normal operating noise rather than a fault in this run - but the user
      // still gets told what happened rather than a log line with no door.
      autoUpdater.on('error', (err) => {
        const line = firstLine(err);
        const described = describeUpdateError(line);
        status = { ...described, checkedAt: new Date().toISOString() };
        if (described.state === 'unavailable') log.info(`update check: ${described.detail}`);
        else log.warn(`update check failed: ${line}`);
      });
      return autoUpdater;
    })();
  }
  return updaterPromise;
}

/**
 * Run one update check now and resolve with the outcome. Used by the launch
 * check and by the About pane's Check now button.
 */
export async function checkForUpdatesNow(): Promise<UpdateStatus> {
  const reason = unavailableReason();
  if (reason) {
    status = { state: 'unavailable', detail: reason, checkedAt: new Date().toISOString() };
    return getUpdateStatus();
  }
  try {
    const autoUpdater = await loadAutoUpdater();
    status = { state: 'checking', detail: 'Checking GitHub for a new release…', checkedAt: status.checkedAt };
    // checkForUpdates rejects with the very error the 'error' handler above
    // has already turned into a status - except configuration failures (a
    // bundle packaged without app-update.yml), which reject without ever
    // firing 'error' and used to disappear without a trace.
    await autoUpdater.checkForUpdates();
  } catch (err) {
    if (status.state === 'checking') {
      const described = describeUpdateError(firstLine(err));
      status = { ...described, checkedAt: new Date().toISOString() };
      log.info(`update check did not run: ${firstLine(err)}`);
    }
  }
  // The events above may still be in flight for download completion, but the
  // check itself has landed by now; whatever state they wrote is the answer.
  if (status.state === 'checking') {
    status = { state: 'failed', detail: 'The update check returned no answer.', checkedAt: new Date().toISOString() };
  }
  return getUpdateStatus();
}

export function installUpdater(): void {
  if (unavailableReason()) return;
  if (!getSettings().autoUpdate) {
    status = {
      state: 'idle',
      detail: 'Automatic update checks are switched off in Settings. Use Check now to check once.',
      checkedAt: null,
    };
    log.info('update check skipped: autoUpdate is off');
    return;
  }
  setTimeout(() => {
    void checkForUpdatesNow().catch((err) => log.warn(`updater did not start: ${firstLine(err)}`));
  }, CHECK_DELAY_MS).unref?.();
}
