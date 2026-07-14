/**
 * macOS system camera effects (Portrait, Studio Light, Reactions). The OS
 * applies these on the Neural Engine inside the camera pipeline - every app
 * gets the processed frames, so Open Loom inherits them for free. They are
 * user-controlled (Control Center > Video Effects); apps can only READ their
 * state and open that panel, which is what the optional native addon
 * (native/camera-effects) exposes. Everything degrades gracefully: no addon
 * (Windows/Linux, or a mac without build tools) means "unsupported" and the
 * Settings pane says so - the effects themselves still work if the user
 * flips them in Control Center.
 */
import type { CameraEffectsStatus } from '@shared/types';
import { log } from './logger';

interface CameraEffectsAddon {
  /** { supported, portrait, studioLight, reactions } snapshot. */
  status(): CameraEffectsStatus;
  /** Present the system Video Effects UI (Control Center camera controls). */
  showVideoEffectsPanel(): void;
}

let addon: CameraEffectsAddon | null = null;
let loadFailed = false;

async function loadAddon(): Promise<CameraEffectsAddon | null> {
  if (addon) return addon;
  if (loadFailed || process.platform !== 'darwin') return null;
  try {
    // ESM-importing a CJS module: depending on what cjs-module-lexer manages
    // to detect, the functions can land on the namespace, on .default, or be
    // split between them. Pick whichever object actually carries BOTH.
    const mod = (await import('openloom-camera-effects')) as unknown as Record<string, unknown> & {
      default?: Record<string, unknown>;
    };
    const candidate = [mod.default, mod].find(
      (c) => c && typeof c['status'] === 'function' && typeof c['showVideoEffectsPanel'] === 'function'
    );
    if (!candidate) throw new Error('addon loaded but exports are incomplete');
    addon = candidate as unknown as CameraEffectsAddon;
    return addon;
  } catch (err) {
    loadFailed = true;
    log.warn(`camera-effects addon unavailable; system effects still work via Control Center: ${String(err)}`);
    return null;
  }
}

const UNSUPPORTED: CameraEffectsStatus = {
  supported: false,
  portrait: false,
  studioLight: false,
  reactions: false,
};

export async function cameraEffectsStatus(): Promise<CameraEffectsStatus> {
  const a = await loadAddon();
  if (!a) return UNSUPPORTED;
  try {
    return a.status();
  } catch (err) {
    log.warn(`camera-effects status failed: ${String(err)}`);
    return UNSUPPORTED;
  }
}

export function openCameraEffectsPanel(): void {
  void loadAddon().then((a) => {
    try {
      a?.showVideoEffectsPanel();
    } catch (err) {
      log.warn(`camera-effects panel failed to open: ${String(err)}`);
    }
  });
}
