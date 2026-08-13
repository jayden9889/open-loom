/**
 * Settings persistence via electron-store, secrets via safeStorage.
 * All reads/writes flow through this module; renderer sees masked secrets.
 */
import { app, safeStorage } from 'electron';
import Store from 'electron-store';
import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '@shared/types';
import { DEFAULT_SHORTCUTS, LEGACY_DRAW_SHORTCUT } from '@shared/types';
import {
  defaultSettings,
  mergeSettings,
  normalizeSettings,
  encryptSecretsInPatch,
  maskSecrets,
  decryptSecret,
  hasStoredSecret,
  describeSaveDirProblem,
  saveDirVolumeRoot,
  type SecretCodec,
} from './settings-core';
import { log } from './logger';

let store: Store<{ settings: Settings }> | null = null;
const listeners = new Set<(s: Settings) => void>();

const codec: SecretCodec = {
  encrypt(plain: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(plain).toString('base64');
    }
    // Never store plaintext silently: base64-tag it so it is at least explicit.
    log.warn('safeStorage unavailable; storing secret base64-obfuscated only');
    return 'b64:' + Buffer.from(plain, 'utf8').toString('base64');
  },
  decrypt(stored: string): string {
    if (stored.startsWith('b64:')) {
      return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    }
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch (err) {
      // The secret IS there, the OS just would not hand back the key - almost
      // always because macOS re-scoped the keychain after the app was updated
      // and re-signed. Never let that read as "the user has not set this up":
      // callers surface this text, and disconnecting is the user's decision.
      log.error(`could not unlock a stored secret (keychain refused this build): ${String(err)}`);
      throw new Error(
        'Your saved sign-in could not be unlocked on this machine. macOS locks saved credentials when the app is updated. Reconnect the account in Settings to store it again.'
      );
    }
  },
};

function defaultSaveDir(): string {
  const base = app.getPath('videos') || app.getPath('documents');
  return path.join(base, 'OpenLoom');
}

function getStore(): Store<{ settings: Settings }> {
  if (!store) {
    store = new Store<{ settings: Settings }>({
      name: 'openloom-settings',
      defaults: { settings: defaultSettings(defaultSaveDir()) },
    });
    // The draw shortcut default moved to Control+1; a stored copy of the old
    // default is indistinguishable from "never customised", so migrate it.
    const stored = store.get('settings');
    if (stored?.shortcuts?.draw === LEGACY_DRAW_SHORTCUT) {
      store.set('settings', {
        ...stored,
        shortcuts: { ...stored.shortcuts, draw: DEFAULT_SHORTCUTS.draw },
      });
      log.info('migrated draw shortcut to Control+1');
    }
    // A secret written to the store by hand, or by a build that predated
    // encryption, stays plaintext forever - decryptSecret passes unprefixed
    // values straight through, so nothing else would ever upgrade it.
    const current = store.get('settings');
    if (current) {
      const upgraded = encryptSecretsInPatch(
        current as unknown as Record<string, unknown>,
        current,
        codec
      ) as unknown as Settings;
      if (JSON.stringify(upgraded) !== JSON.stringify(current)) {
        store.set('settings', upgraded);
        log.info('encrypted plaintext secrets found in the settings store');
      }
    }
  }
  return store;
}

export function getSettings(): Settings {
  // Merge over defaults so new fields added in updates are always present;
  // normalize catches out-of-bounds values in a hand-edited settings file.
  return normalizeSettings(mergeSettings(defaultSettings(defaultSaveDir()), getStore().get('settings')));
}

/** Settings as sent to the renderer: secrets replaced with a mask. */
export function getSettingsMasked(): Settings {
  return maskSecrets(getSettings());
}

export function setSettings(patch: Partial<Settings>): Settings {
  const current = getSettings();
  const safePatch = encryptSecretsInPatch(
    patch as Record<string, unknown>,
    current,
    codec
  ) as Partial<Settings>;
  // Normalize BEFORE persisting, so an oversized value never reaches disk.
  const next = normalizeSettings(mergeSettings(current, safePatch));
  getStore().set('settings', next);
  if (typeof patch.launchAtLogin === 'boolean') {
    applyLaunchAtLogin(next.launchAtLogin);
  }
  for (const cb of listeners) cb(next);
  return next;
}

/** Decrypted secret for main-process consumers (transcription, AI, sharing). */
export function getSecret(dottedPath: string): string {
  return decryptSecret(getSettings(), dottedPath, codec);
}

/**
 * Whether a secret is on disk, regardless of whether this build can decrypt it.
 * Use for "is this account connected?"; getSecret is for actually using it.
 */
export function hasSecret(dottedPath: string): boolean {
  return hasStoredSecret(getSettings(), dottedPath);
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function applyLaunchAtLogin(enabled: boolean): void {
  try {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: enabled });
    }
  } catch (err) {
    log.warn(`setLoginItemSettings failed: ${String(err)}`);
  }
}

/** App-support bin dir where fetched ffmpeg/ffprobe binaries land. */
export function appBinDir(): string {
  return path.join(app.getPath('userData'), 'bin');
}

/**
 * Why the save folder (or a candidate for it) is unusable right now, as one
 * plain sentence - or null when it is fine. Deliberately never creates the
 * folder: mkdir-ing a missing '/Volumes/...' path would plant a decoy on the
 * boot disk that shadows the real library when the drive is remounted.
 */
export function saveDirProblem(dir: string = getSettings().saveDir): string | null {
  const volumeRoot = saveDirVolumeRoot(dir);
  const exists = fs.existsSync(dir);
  let writable = false;
  if (exists) {
    const testFile = path.join(dir, `.openloom-write-test-${process.pid}`);
    try {
      fs.writeFileSync(testFile, '');
      fs.rmSync(testFile);
      writable = true;
    } catch {
      writable = false;
    }
  } else {
    // A missing folder is healthy when it can be created on demand (the
    // library mkdirs it on first use): check the nearest existing parent.
    let parent = path.dirname(dir);
    while (parent !== path.dirname(parent) && !fs.existsSync(parent)) {
      parent = path.dirname(parent);
    }
    try {
      fs.accessSync(parent, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
  }
  return describeSaveDirProblem(dir, {
    exists,
    writable,
    volumeMounted: volumeRoot ? fs.existsSync(volumeRoot) : null,
  });
}
