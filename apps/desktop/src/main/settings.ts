/**
 * Settings persistence via electron-store, secrets via safeStorage.
 * All reads/writes flow through this module; renderer sees masked secrets.
 */
import { app, safeStorage } from 'electron';
import Store from 'electron-store';
import path from 'node:path';
import type { Settings } from '@shared/types';
import {
  defaultSettings,
  mergeSettings,
  encryptSecretsInPatch,
  maskSecrets,
  decryptSecret,
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
      log.warn(`failed to decrypt stored secret: ${String(err)}`);
      return '';
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
  }
  return store;
}

export function getSettings(): Settings {
  // Merge over defaults so new fields added in updates are always present.
  return mergeSettings(defaultSettings(defaultSaveDir()), getStore().get('settings'));
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
  const next = mergeSettings(current, safePatch);
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
