/**
 * Permission + tooling checks for the Setup view (SPEC R13).
 * macOS uses systemPreferences; Windows/Linux report 'granted' for OS media
 * permissions (the OS prompts at getUserMedia time or has no gate).
 */
import { shell, systemPreferences } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PermissionsSnapshot, PermissionStatus } from '@shared/types';
import { ffmpegAvailable } from './ffmpeg';
import { getSettings } from './settings';
import { log } from './logger';

const isMac = process.platform === 'darwin';

function mediaStatus(kind: 'camera' | 'microphone' | 'screen'): PermissionStatus {
  if (!isMac) return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus(kind) as PermissionStatus;
  } catch (err) {
    log.warn(`getMediaAccessStatus(${kind}) failed: ${String(err)}`);
    return 'unknown';
  }
}

function whisperAvailable(): boolean {
  const configured = getSettings().transcription.whisperPath;
  if (configured && fs.existsSync(configured)) return true;
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return true;
  }
  return false;
}

export function getPermissions(): PermissionsSnapshot {
  return {
    screen: mediaStatus('screen'),
    camera: mediaStatus('camera'),
    mic: mediaStatus('microphone'),
    ffmpeg: ffmpegAvailable(),
    whisper: whisperAvailable(),
  };
}

export async function requestPermission(kind: string): Promise<void> {
  if (!isMac) return;
  if (kind === 'camera' || kind === 'mic') {
    const media = kind === 'mic' ? 'microphone' : 'camera';
    try {
      await systemPreferences.askForMediaAccess(media);
    } catch (err) {
      log.warn(`askForMediaAccess(${media}) failed: ${String(err)}`);
    }
    return;
  }
  if (kind === 'screen') {
    // There is no programmatic prompt for Screen Recording; open the pane.
    openSystemSettings('screen');
  }
}

/**
 * macOS pins a Screen Recording grant to the exact code signature it approved.
 * An unsigned build presents a new signature after every update (and macOS
 * updates can invalidate the stored one too), so System Settings keeps showing
 * the switch ON while TCC refuses this binary underneath. The only way out is
 * to clear the stale entry so the user can grant it fresh. tccutil operates on
 * the calling user's own database and needs no elevation.
 */
export async function resetScreenPermission(): Promise<boolean> {
  if (!isMac) return false;
  // Matches electron-builder appId. Dev runs are com.github.Electron; resetting
  // an id with no entry is a harmless no-op, so no isPackaged branch.
  const bundleId = 'org.openloom.app';
  const ok = await new Promise<boolean>((resolve) => {
    execFile('/usr/bin/tccutil', ['reset', 'ScreenCapture', bundleId], (err) => {
      if (err) log.warn(`tccutil reset ScreenCapture ${bundleId} failed: ${String(err)}`);
      else log.info(`cleared stale Screen Recording entry for ${bundleId}`);
      resolve(!err);
    });
  });
  openSystemSettings('screen');
  return ok;
}

const MAC_PANES: Record<string, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  mic: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

export function openSystemSettings(pane: string): void {
  if (isMac) {
    const url = MAC_PANES[pane] ?? 'x-apple.systempreferences:com.apple.preference.security';
    void shell.openExternal(url);
    return;
  }
  if (process.platform === 'win32') {
    const winPanes: Record<string, string> = {
      camera: 'ms-settings:privacy-webcam',
      mic: 'ms-settings:privacy-microphone',
      screen: 'ms-settings:privacy',
    };
    void shell.openExternal(winPanes[pane] ?? 'ms-settings:privacy');
    return;
  }
  log.info(`openSystemSettings(${pane}) is a no-op on this platform`);
}

/**
 * System-audio loopback support: Electron >= 39 uses Core Audio taps on
 * macOS 14.2+; Windows loopback works via WASAPI; Linux is not wired in v1.
 */
export function systemAudioSupported(): boolean {
  if (process.platform === 'win32') return true;
  if (process.platform !== 'darwin') return false;
  const [major, minor] = (process.getSystemVersion?.() ?? '0.0').split('.').map(Number);
  if (!major) return false;
  return major > 14 || (major === 14 && (minor ?? 0) >= 2);
}
