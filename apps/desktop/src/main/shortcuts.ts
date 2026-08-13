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
  isPaused,
  isRecordingActive,
  pauseRecording,
  requestCancelRecording,
  requestRestartRecording,
  resumeRecording,
  startRecording,
  stopRecording,
  toggleDraw,
  toggleNotes,
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
  // Through the same confirm gate as the HUD buttons: a hotkey one mis-press
  // away from pause must not silently destroy a long take.
  cancel: () => requestCancelRecording(),
  restart: () => requestRestartRecording(),
  draw: () => toggleDraw(!currentState().drawOn),
  notes: () => toggleNotes(),
};

/** Row labels for validation errors - internal keys like "startStop" must never reach a toast. */
const SHORTCUT_LABELS: Record<keyof ShortcutSettings, string> = {
  startStop: 'Start / stop recording',
  pauseResume: 'Pause / resume',
  cancel: 'Cancel recording',
  restart: 'Restart recording',
  draw: 'Toggle drawing',
  notes: 'Show / hide talking notes',
};

function shortcutLabel(name: string): string {
  return SHORTCUT_LABELS[name as keyof ShortcutSettings] ?? name;
}

/** Validate a shortcut map: no empties, no duplicates. Returns error text or null. */
export function validateShortcuts(shortcuts: ShortcutSettings): string | null {
  const seen = new Map<string, string>();
  for (const [name, accel] of Object.entries(shortcuts)) {
    if (!accel.trim()) return `The ${shortcutLabel(name)} shortcut is empty.`;
    const key = accel.toLowerCase().replace(/\s+/g, '');
    const clash = seen.get(key);
    if (clash) {
      return `${shortcutLabel(name)} uses the same keys as ${shortcutLabel(clash)}. Try another combination.`;
    }
    seen.set(key, name);
  }
  return null;
}

/**
 * Shortcuts the OS refused on the last apply (already owned by another app,
 * or an accelerator it would not parse). The Settings pane reads this so a
 * dead Stop Recording key is a visible warning, not a green toast: during a
 * full-screen recording that hotkey is the primary way to end the take.
 */
let registrationFailures: Partial<Record<keyof ShortcutSettings, string>> = {};

export function getShortcutFailures(): Partial<Record<keyof ShortcutSettings, string>> {
  return { ...registrationFailures };
}

export function applyShortcuts(): void {
  globalShortcut.unregisterAll();
  registrationFailures = {};
  const shortcuts = getSettings().shortcuts;
  for (const [name, accel] of Object.entries(shortcuts) as [keyof ShortcutSettings, string][]) {
    if (!accel) continue;
    try {
      const ok = globalShortcut.register(accel, ACTIONS[name]);
      if (!ok) {
        registrationFailures[name] = accel;
        log.warn(`shortcut ${name} (${accel}) is taken by another app`);
      }
    } catch (err) {
      registrationFailures[name] = accel;
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
