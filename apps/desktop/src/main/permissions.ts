/**
 * Permission + tooling checks for the Setup view (SPEC R13).
 * macOS uses systemPreferences; Windows/Linux report 'granted' for OS media
 * permissions (the OS prompts at getUserMedia time or has no gate).
 */
import { desktopCapturer, shell, systemPreferences } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PermissionsSnapshot, PermissionStatus } from '@shared/types';
import { ffmpegAvailable } from './ffmpeg';
import { getSettings, saveDirProblem } from './settings';
import { bitmapChannelSpread, classifyScreenProbe } from './permissions-core';
// Click highlight availability rides this snapshot because it is the health
// check the app already re-runs at boot, on focus and from every Re-check
// button, so it needs no new IPC channel. Nothing in the resulting import ring
// (permissions, clicks, recorder-ipc, capture) runs anything at module load,
// so every binding is read long after all four have initialised.
import { clickHighlightsAvailable } from './clicks';
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

/**
 * getMediaAccessStatus('screen') wraps CGPreflightScreenCaptureAccess, which
 * macOS 15+ is known to answer 'denied' for a build whose capture actually
 * works (and the reverse after a signature change). The capture pipeline is
 * the only honest witness - read via window TITLES, not pixels: a denied app
 * is still handed a wallpaper capture, so "the thumbnail is not black" proves
 * nothing (and a genuinely black screen proves nothing the other way). What
 * macOS reliably hides from an unauthorised process is other apps' window
 * titles; classifyScreenProbe judges those and answers working / blocked /
 * unknown. Unknown falls back to the preflight answer rather than guessing.
 * Only consulted when preflight says anything but granted, so the happy path
 * costs nothing.
 *
 * The probe result is cached briefly and concurrent calls share one pass:
 * Setup polls this and the app re-checks on focus, and each miss is a real
 * capture-source enumeration across all displays.
 */
const PROBE_CACHE_MS = 10_000;
let probeCache: { at: number; status: PermissionStatus } | null = null;
let probeInFlight: Promise<PermissionStatus> | null = null;

async function probeScreenOnce(pre: PermissionStatus): Promise<PermissionStatus> {
  try {
    const wins = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
    });
    const verdict = classifyScreenProbe(wins.map((w) => w.name));
    if (verdict === 'working') {
      log.info(`screen permission: preflight says '${pre}' but capture sees other apps' windows; treating as granted`);
      return 'granted';
    }
    if (verdict === 'blocked') {
      log.info(`screen permission: capture confirms no active grant (window titles hidden); preflight says '${pre}'`);
      return pre === 'granted' ? 'denied' : pre;
    }
    // Nothing to judge by (no foreign windows open). Log the thumbnail spread
    // as a diagnostic only - spread can never prove a grant, because a denied
    // app still receives the (colourful) desktop picture.
    const screens = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 32, height: 32 },
    });
    const thumb = screens[0]?.thumbnail;
    const spread = thumb && !thumb.isEmpty() ? bitmapChannelSpread(thumb.toBitmap()) : null;
    log.info(
      `screen permission: probe inconclusive (no foreign windows to judge by, thumbnail spread ${spread ?? 'n/a'}); keeping preflight answer '${pre}'`
    );
  } catch (err) {
    log.warn(`screen capture probe failed: ${String(err)}`);
  }
  return pre;
}

async function screenStatus(force = false): Promise<PermissionStatus> {
  const pre = mediaStatus('screen');
  if (!isMac || pre === 'granted') return pre;
  if (!force && probeCache && Date.now() - probeCache.at < PROBE_CACHE_MS) return probeCache.status;
  if (!probeInFlight) {
    probeInFlight = probeScreenOnce(pre)
      .then((status) => {
        probeCache = { at: Date.now(), status };
        return status;
      })
      .finally(() => {
        probeInFlight = null;
      });
  }
  return probeInFlight;
}

/**
 * Click highlights read global mouse events through the Accessibility API.
 * Without the grant the hook "starts" fine and simply never delivers a click,
 * so this is the only place the truth is visible. No prompt is triggered
 * (prompt=false): the UI explains and opens the right pane instead.
 */
function accessibilityStatus(): PermissionStatus {
  if (!isMac) return 'granted';
  try {
    return systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied';
  } catch (err) {
    log.warn(`isTrustedAccessibilityClient failed: ${String(err)}`);
    return 'unknown';
  }
}

export async function getPermissions(force = false): Promise<PermissionsSnapshot> {
  return {
    screen: await screenStatus(force),
    camera: mediaStatus('camera'),
    mic: mediaStatus('microphone'),
    accessibility: accessibilityStatus(),
    clickHighlights: clickHighlightsAvailable(),
    ffmpeg: ffmpegAvailable(),
    whisper: whisperAvailable(),
    saveDirProblem: saveDirProblem(),
  };
}

/**
 * Boot log line without the capture probe: on a first run the probe itself is
 * what makes macOS pop its "would like to record the screen" dialog, and at
 * boot time no Open Loom window exists yet to explain it. Preflight-only here;
 * the Setup view (which has explained itself on screen) runs the real probe.
 */
export function bootPermissionsLine(): string {
  return `permissions at boot (preflight only): screen=${mediaStatus('screen')} camera=${mediaStatus('camera')} mic=${mediaStatus('microphone')} accessibility=${accessibilityStatus()} ffmpeg=${ffmpegAvailable()}`;
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
  if (kind === 'screen' || kind === 'accessibility') {
    // There is no programmatic prompt for Screen Recording or Accessibility
    // that an app should trigger cold; open the right pane instead.
    openSystemSettings(kind);
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
