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
import { registerEngineIpc, isRecordingActive } from './recorder-ipc';
import { createMainWindow, showLauncher } from './windows';
import { getSettings } from './settings';
import { ensureFfmpeg } from './ffmpeg';
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
  let quitWithUploadsApproved = false;
  app.on('before-quit', (event) => {
    if (quitWithUploadsApproved) return;
    const count = youtubeUploadsInFlight();
    if (count === 0) return;
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
    if (choice === 1) {
      quitWithUploadsApproved = true;
      youtubeCancelAllPublishes();
      app.quit();
    }
  });

  app.on('will-quit', () => {
    unregisterAllShortcuts();
    shutdownClickHighlights();
  });
}
