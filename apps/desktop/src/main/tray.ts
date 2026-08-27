/**
 * Tray / menubar app (SPEC R12). Template icon so macOS tints it correctly
 * in light/dark menu bars; the same PNG works on Windows/Linux trays.
 */
import { app, dialog, Menu, nativeImage, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger';
import { createMainWindow, broadcast, showLauncher } from './windows';
import {
  cancelRecording,
  currentState,
  isPaused,
  isRecordingActive,
  pauseRecording,
  resumeRecording,
  stopRecording,
} from './recorder-ipc';
import { needsDestroyConfirm } from './recording-guards';

let tray: Tray | null = null;

function trayIcon(): Electron.NativeImage {
  const candidates = [
    // Packaged: electron-builder copies assets/ to Contents/Resources/assets.
    path.resolve(process.resourcesPath, 'assets/tray/trayTemplate.png'),
    path.resolve(app.getAppPath(), '../../assets/tray/trayTemplate.png'),
    path.resolve(app.getAppPath(), 'assets/tray/trayTemplate.png'),
    path.resolve(import.meta.dirname, '../../assets/tray/trayTemplate.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      img.setTemplateImage(true);
      return img;
    }
  }
  log.warn('tray template icon missing; using empty icon');
  return nativeImage.createEmpty();
}

/**
 * Ask before the tray throws a take away, and return true only when the cancel
 * should go ahead.
 *
 * The in-app cancel has always run through needsDestroyConfirm, but this menu
 * item called cancelRecording straight out, so the same footage was protected
 * by the HUD and destroyed one menu click later from the menu bar. Sharing the
 * guard means there is one rule about when a take is worth protecting, not two.
 *
 * It reuses the constant rather than copying the number, so a two second false
 * start still cancels instantly. A confirm on footage nobody minds losing is
 * pure friction and teaches people to click through the ones that matter.
 *
 * This is the main process, so the HUD's confirm panel is not reachable and the
 * answer has to arrive before the click handler returns. That makes it
 * Electron's own dialog, written in the style of the quit guard in index.ts:
 * the safe choice sits at index 0 with defaultId and cancelId both on it, so
 * Enter and Escape and closing the box all keep the recording.
 */
function confirmTrayCancel(): boolean {
  const { status, elapsedSec } = currentState();
  if (!needsDestroyConfirm(status, elapsedSec)) return true;
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;
  const spent = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: ['Keep recording', 'Delete this take'],
    defaultId: 0,
    cancelId: 0,
    message: 'Delete this take?',
    // The same words the HUD confirm uses, and deliberately no claim that the
    // footage is gone for good. Any take long enough to reach this dialog is
    // also past the keep threshold, so cancelRecording parks it as recoverable
    // rather than deleting it, and telling the user otherwise would be untrue.
    detail: `${spent} of footage will be discarded. Recording carries on until you choose.`,
  });
  return choice === 1;
}

function rebuildMenu(): void {
  if (!tray) return;
  const recording = isRecordingActive();
  const paused = isPaused();
  const menu = Menu.buildFromTemplate([
    {
      label: 'New recording',
      enabled: !recording,
      click: () => showLauncher(),
    },
    { type: 'separator' },
    {
      label: paused ? 'Resume recording' : 'Pause recording',
      enabled: recording,
      click: () => void (paused ? resumeRecording() : pauseRecording()).then(() => rebuildMenu()),
    },
    {
      label: 'Stop and save',
      enabled: recording,
      click: () =>
        void stopRecording()
          .catch((err) => log.error(`tray stop failed: ${String(err)}`))
          .finally(() => rebuildMenu()),
    },
    {
      label: 'Cancel recording',
      enabled: recording,
      click: () => {
        if (!confirmTrayCancel()) return;
        void cancelRecording().finally(() => rebuildMenu());
      },
    },
    { type: 'separator' },
    { label: 'Open Library', click: () => createMainWindow() },
    {
      label: 'Settings',
      click: () => {
        createMainWindow();
        broadcast('ol:navigate', { view: 'settings' });
      },
    },
    { type: 'separator' },
    { label: 'Quit Open Loom', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

export function installTray(): void {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('Open Loom');
    rebuildMenu();
    // Keep menu enable/disable state fresh without thrashing an open menu.
    let last = '';
    setInterval(() => {
      const key = `${isRecordingActive()}:${isPaused()}`;
      if (key !== last) {
        last = key;
        rebuildMenu();
      }
    }, 1000);
  } catch (err) {
    log.error(`tray init failed: ${String(err)}`);
  }
}
