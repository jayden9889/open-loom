/**
 * Click highlights (SPEC R11): global mouse-down hook via uiohook-napi,
 * forwarded to the draw overlay as ripples. uiohook-napi is an OPTIONAL
 * native dependency: if it fails to install, load, or lacks the macOS
 * accessibility permission, the app must keep working; the Settings toggle
 * then reports "unavailable".
 */
import { getSettings, onSettingsChanged } from './settings';
import { sendClickRipple } from './recorder-ipc';
import { log } from './logger';

type UiohookModule = {
  uIOhook: {
    on(event: 'mousedown', cb: (e: { x: number; y: number }) => void): void;
    start(): void;
    stop(): void;
  };
};

let mod: UiohookModule | null = null;
let loadFailed = false;
let hookRunning = false;
let listenerAttached = false;

async function loadModule(): Promise<UiohookModule | null> {
  if (mod) return mod;
  if (loadFailed) return null;
  try {
    mod = (await import('uiohook-napi')) as unknown as UiohookModule;
    return mod;
  } catch (err) {
    loadFailed = true;
    log.warn(`uiohook-napi unavailable; click highlights disabled: ${String(err)}`);
    return null;
  }
}

export function clickHighlightsAvailable(): boolean {
  return !loadFailed;
}

async function syncHookState(enabled: boolean): Promise<void> {
  const m = await loadModule();
  if (!m) return;
  try {
    if (enabled && !hookRunning) {
      if (!listenerAttached) {
        m.uIOhook.on('mousedown', (e) => sendClickRipple(e.x, e.y));
        listenerAttached = true;
      }
      m.uIOhook.start();
      hookRunning = true;
      log.info('click highlights hook started');
    } else if (!enabled && hookRunning) {
      m.uIOhook.stop();
      hookRunning = false;
      log.info('click highlights hook stopped');
    }
  } catch (err) {
    loadFailed = true;
    hookRunning = false;
    log.warn(`uiohook failed at runtime; click highlights disabled: ${String(err)}`);
  }
}

export function installClickHighlights(): void {
  void syncHookState(getSettings().clickHighlights);
  onSettingsChanged((s) => void syncHookState(s.clickHighlights));
}

export function shutdownClickHighlights(): void {
  if (hookRunning && mod) {
    try {
      mod.uIOhook.stop();
    } catch {
      /* shutting down */
    }
    hookRunning = false;
  }
}
