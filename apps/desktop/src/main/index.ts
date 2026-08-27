/**
 * Open Loom main process entry.
 * Boot order matters: privileged scheme before ready; handlers, windows,
 * shortcuts, tray after ready. Closing the main window keeps the app alive
 * in the tray (SPEC R12).
 */
import { app, BrowserWindow, dialog } from 'electron';
import { registerScheme, installProtocolHandler } from './protocol';
import { installDisplayMediaHandler, installPermissionHandlers } from './capture';
import { registerIpc } from './ipc';
import { registerEngineIpc, isRecordingActive, installQuitGuard } from './recorder-ipc';
import { createMainWindow, showLauncher } from './windows';
import { getSettings } from './settings';
import { ensureFfmpeg, jobsActive, cancelJobsForQuit } from './ffmpeg';
import { installShortcuts, unregisterAllShortcuts } from './shortcuts';
import { installTray } from './tray';
import { installClickHighlights, shutdownClickHighlights } from './clicks';
import { installUpdater } from './updater';
import {
  recoverPendingYouTubeUploads,
  youtubeCancelAllPublishes,
  youtubeUploadsInFlight,
} from './youtube';
import { getPermissions } from './permissions';
import { log } from './logger';
import { runTestHooks } from './test-hooks';

// Test isolation: point userData at a scratch dir (e2e + boot checks).
if (process.env['OPENLOOM_USER_DATA']) {
  app.setPath('userData', process.env['OPENLOOM_USER_DATA']);
}

registerScheme();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    createMainWindow();
    if (getSettings().setupComplete && !isRecordingActive()) showLauncher();
  });

  app.whenReady().then(() => {
    installProtocolHandler();
    installPermissionHandlers();
    installDisplayMediaHandler();
    registerIpc();
    registerEngineIpc();
    // Written for exactly this and then never called, so quitting mid-take
    // went through silently and the capture survived only as a crash
    // recoverable, minus whatever the write stream still had buffered.
    installQuitGuard();
    createMainWindow();
    // Open straight into the recording launcher (left edge of the screen);
    // first run stays on the Setup view, which opens the launcher when done.
    if (getSettings().setupComplete) showLauncher();
    installShortcuts();
    installTray();
    installClickHighlights();
    // Silent onboarding: fetch ffmpeg in the background when it is missing so
    // the first recording never hits an install wall.
    void ensureFfmpeg('launch').catch((err) => log.warn(`ffmpeg prefetch failed: ${String(err)}`));
    installUpdater();
    // Pick up YouTube uploads that were mid-flight when the app last quit:
    // finished ones get their video id recovered, unfinished ones keep their
    // session so the Watch view can offer "Resume upload".
    void recoverPendingYouTubeUploads().catch((err) =>
      log.warn(`youtube upload recovery failed: ${String(err)}`)
    );
    log.info(`Open Loom ready (v${app.getVersion()}, ${process.platform} ${process.getSystemVersion?.() ?? ''})`);
    // One line of TCC truth per launch: "the tick is on but the app says no"
    // is invisible in the UI and has cost real debugging time. See #resetScreenPermission.
    void getPermissions().then((p) =>
      log.info(`permissions at boot: screen=${p.screen} camera=${p.camera} mic=${p.mic} ffmpeg=${p.ffmpeg}`)
    );
    void runTestHooks();
  });

  // Keep running in the tray when every window is closed, on all platforms.
  app.on('window-all-closed', () => {
    /* stay alive; Quit lives in the tray menu and app menu */
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      if (getSettings().setupComplete && !isRecordingActive()) showLauncher();
    }
  });

  // Quitting mid-upload silently threw the upload away. Ask first; a confirmed
  // quit aborts the uploads cleanly (which also releases Google's sessions).
  let quitApproved = false;

  /**
   * Called by the handler below once it has vetoed the current quit, so the
   * app is still alive while the encoders stop. Quitting from a promise rather
   * than from inside the handler also stops Electron re entering 'before-quit'
   * while a modal dialog from that same handler is still on screen, which is
   * how one quit could raise the same question twice.
   */
  const finishQuit = (): void => {
    void cancelJobsForQuit()
      .catch((err) => log.warn(`cancelling ffmpeg jobs on quit failed: ${String(err)}`))
      .finally(() => {
        quitApproved = true;
        app.quit();
      });
  };

  app.on('before-quit', (event) => {
    if (quitApproved) return;
    // Electron runs every 'before-quit' listener, and this one is registered at
    // module load while installQuitGuard's recording listener is registered on
    // ready, so this one runs first. Cancelling uploads here therefore fired
    // before the user had answered the recording question, and answering "Keep
    // recording" then vetoed the quit with the uploads already dead and the app
    // still running. Standing aside settles the recording first: both of its
    // quitting answers call app.quit() again, and this handler does its work on
    // that pass, by which point no recording is active.
    if (isRecordingActive()) return;
    const count = youtubeUploadsInFlight();
    if (count > 0) {
      event.preventDefault();
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        buttons: ['Keep uploading', 'Quit and cancel upload'],
        defaultId: 0,
        cancelId: 0,
        message:
          count === 1
            ? 'A YouTube upload is still running.'
            : `${count} YouTube uploads are still running.`,
        detail: 'Quitting now cancels it, and the video will not appear on your channel.',
      });
      if (choice !== 1) return;
      youtubeCancelAllPublishes();
      finishQuit();
      return;
    }
    // No upload question to ask, but an encode still needs stopping: quitting
    // under a running ffmpeg job orphaned the child process and left a part
    // written file where a finished one was expected.
    if (jobsActive()) {
      event.preventDefault();
      finishQuit();
    }
  });

  app.on('will-quit', () => {
    unregisterAllShortcuts();
    shutdownClickHighlights();
  });
}
