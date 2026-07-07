/**
 * Open Loom main process entry.
 * Boot order matters: privileged scheme before ready; handlers, windows,
 * shortcuts, tray after ready. Closing the main window keeps the app alive
 * in the tray (SPEC R12).
 */
import { app, BrowserWindow } from 'electron';
import { registerScheme, installProtocolHandler } from './protocol';
import { installDisplayMediaHandler } from './capture';
import { registerIpc } from './ipc';
import { registerEngineIpc } from './recorder-ipc';
import { createMainWindow } from './windows';
import { installShortcuts, unregisterAllShortcuts } from './shortcuts';
import { installTray } from './tray';
import { installClickHighlights, shutdownClickHighlights } from './clicks';
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
  });

  app.whenReady().then(() => {
    installProtocolHandler();
    installDisplayMediaHandler();
    registerIpc();
    registerEngineIpc();
    createMainWindow();
    installShortcuts();
    installTray();
    installClickHighlights();
    log.info(`Open Loom ready (v${app.getVersion()}, ${process.platform} ${process.getSystemVersion?.() ?? ''})`);
    void runTestHooks();
  });

  // Keep running in the tray when every window is closed, on all platforms.
  app.on('window-all-closed', () => {
    /* stay alive; Quit lives in the tray menu and app menu */
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  app.on('will-quit', () => {
    unregisterAllShortcuts();
    shutdownClickHighlights();
  });
}
