/**
 * Global shortcuts (SPEC R9): configurable, registered app-wide, re-applied
 * whenever the shortcut settings change.
 */
import { globalShortcut } from 'electron';
import { desktopCapturer } from 'electron';
import type { ShortcutSettings } from '@shared/types';
import { getSettings, onSettingsChanged } from './settings';
import { log } from './logger';
import {
  cancelRecording,
  isPaused,
  isRecordingActive,
  pauseRecording,
  restartRecording,
  resumeRecording,
  startRecording,
  stopRecording,
  toggleDraw,
  currentState,
} from './recorder-ipc';
import { broadcast, createMainWindow } from './windows';

/** Quick-start with defaults: primary display, persisted devices (tray + hotkey path). */
export async function quickStartRecording(): Promise<void> {
  const settings = getSettings();
  const screens = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const first = screens[0];
  if (!first) throw new Error('No screen available to record.');
  await startRecording({
    // The hotkey always records the screen with the face bubble on; the
    // camera is never optional (full-face-only lives in the launcher).
    mode: 'screen-cam',
    sourceId: first.id,
    sourceIsDisplay: true,
    cameraId: settings.recording.cameraId || undefined,
    micId: settings.recording.micId || undefined,
    cameraOn: true,
    micOn: true,
    systemAudio: settings.recording.systemAudio,
    quality: settings.recording.quality,
    fps: settings.recording.fps,
  });
}

function onStartStop(): void {
  if (isRecordingActive()) {
    void stopRecording().catch((err) => log.error(`hotkey stop failed: ${String(err)}`));
  } else if (currentState().status === 'idle') {
    void quickStartRecording().catch((err) => {
      log.error(`hotkey start failed: ${String(err)}`);
      createMainWindow();
      broadcast('ol:recording-state', { ...currentState(), error: err instanceof Error ? err.message : String(err) });
    });
  }
}

function onPauseResume(): void {
  if (isPaused()) void resumeRecording();
  else void pauseRecording();
}

const ACTIONS: Record<keyof ShortcutSettings, () => void> = {
  startStop: onStartStop,
  pauseResume: onPauseResume,
  cancel: () => void cancelRecording(),
  restart: () => void restartRecording().catch((err) => log.error(`restart failed: ${String(err)}`)),
  draw: () => toggleDraw(!currentState().drawOn),
};

/** Validate a shortcut map: no empties, no duplicates. Returns error text or null. */
export function validateShortcuts(shortcuts: ShortcutSettings): string | null {
  const seen = new Map<string, string>();
  for (const [name, accel] of Object.entries(shortcuts)) {
    if (!accel.trim()) return `The ${name} shortcut is empty.`;
    const key = accel.toLowerCase().replace(/\s+/g, '');
    const clash = seen.get(key);
    if (clash) return `${name} uses the same keys as ${clash}.`;
    seen.set(key, name);
  }
  return null;
}

export function applyShortcuts(): void {
  globalShortcut.unregisterAll();
  const shortcuts = getSettings().shortcuts;
  for (const [name, accel] of Object.entries(shortcuts) as [keyof ShortcutSettings, string][]) {
    if (!accel) continue;
    try {
      const ok = globalShortcut.register(accel, ACTIONS[name]);
      if (!ok) log.warn(`shortcut ${name} (${accel}) is taken by another app`);
    } catch (err) {
      log.warn(`shortcut ${name} (${accel}) failed to register: ${String(err)}`);
    }
  }
}

export function installShortcuts(): void {
  applyShortcuts();
  onSettingsChanged(() => applyShortcuts());
}

export function unregisterAllShortcuts(): void {
  globalShortcut.unregisterAll();
}
