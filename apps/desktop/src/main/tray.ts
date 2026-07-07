/**
 * Tray / menubar app (SPEC R12). Template icon so macOS tints it correctly
 * in light/dark menu bars; the same PNG works on Windows/Linux trays.
 */
import { app, Menu, nativeImage, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger';
import { createMainWindow, broadcast } from './windows';
import {
  cancelRecording,
  isPaused,
  isRecordingActive,
  pauseRecording,
  resumeRecording,
  stopRecording,
} from './recorder-ipc';
import { getSettings } from './settings';

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

function rebuildMenu(): void {
  if (!tray) return;
  const recording = isRecordingActive();
  const paused = isPaused();
  const menu = Menu.buildFromTemplate([
    {
      label: 'New recording',
      enabled: !recording,
      submenu: [
        {
          label: 'Screen + Camera',
          click: () => void startQuick('screen-cam'),
        },
        {
          label: 'Screen only',
          click: () => void startQuick('screen'),
        },
        {
          label: 'Camera only',
          click: () => {
            createMainWindow();
            broadcast('ol:navigate', { view: 'new-recording', mode: 'cam' });
          },
        },
      ],
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
      click: () => void cancelRecording().finally(() => rebuildMenu()),
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

async function startQuick(mode: 'screen-cam' | 'screen'): Promise<void> {
  const { desktopCapturer } = await import('electron');
  const settings = getSettings();
  const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const first = screens[0];
  if (!first) {
    log.error('tray start: no screen available');
    return;
  }
  const { startRecording } = await import('./recorder-ipc');
  try {
    await startRecording({
      mode,
      sourceId: first.id,
      sourceIsDisplay: true,
      cameraId: settings.recording.cameraId || undefined,
      micId: settings.recording.micId || undefined,
      cameraOn: mode === 'screen-cam',
      micOn: true,
      systemAudio: settings.recording.systemAudio,
      quality: settings.recording.quality,
      fps: settings.recording.fps,
    });
  } catch (err) {
    log.error(`tray start failed: ${String(err)}`);
    createMainWindow();
  } finally {
    rebuildMenu();
  }
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
