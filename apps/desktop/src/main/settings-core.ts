/**
 * Pure settings logic: defaults, deep merge, secret-field handling.
 * No Electron imports so it is unit-testable; settings.ts binds this to
 * electron-store + safeStorage.
 */
import type { Settings } from '@shared/types';
import { DEFAULT_SHORTCUTS } from '@shared/types';

export const SECRET_MASK = '••••••••';
export const ENC_PREFIX = 'enc:v1:';

/** Dotted paths of fields that hold secrets and must be encrypted at rest. */
export const SECRET_PATHS = [
  'transcription.apiKey',
  'ai.apiKey',
  'sharing.server.apiKey',
  'sharing.s3.secretAccessKey',
  'youtube.clientSecret',
  'youtube.refreshToken',
] as const;

export function defaultSettings(saveDir: string): Settings {
  return {
    setupComplete: false,
    saveDir,
    theme: 'auto',
    countdown: true,
    clickHighlights: false,
    launchAtLogin: false,
    namePattern: 'Recording - {date}, {time}',
    ffmpegPath: '',
    autoUpdate: true,
    recording: {
      quality: '1080p',
      fps: 30,
      defaultMode: 'screen-cam',
      cameraId: '',
      micId: '',
      systemAudio: false,
      maxDurationMin: 0,
      notes: '',
      lastSourceId: '',
    },
    bubble: { size: 'M', mirror: true },
    shortcuts: { ...DEFAULT_SHORTCUTS },
    transcription: {
      engine: 'off',
      whisperPath: '',
      whisperModelPath: '',
      endpoint: '',
      model: 'whisper-1',
      apiKey: '',
      language: 'auto',
      auto: true,
    },
    ai: {
      provider: 'off',
      endpoint: '',
      model: '',
      apiKey: '',
      features: { title: true, summary: true, chapters: true, tasks: true },
    },
    sharing: {
      provider: 'none',
      autoCopyOnStop: true,
      server: { url: '', apiKey: '' },
      s3: {
        endpoint: '',
        region: 'auto',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        prefix: 'videos',
        publicBaseUrl: '',
        pathStyle: false,
      },
      defaults: {
        privacy: 'link',
        allowComments: true,
        allowReactions: true,
        allowDownload: true,
      },
    },
    youtube: {
      clientId: '',
      clientSecret: '',
      refreshToken: '',
      channelTitle: '',
      scopeVersion: 0,
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` into `base`, returning a new object. Arrays replace. */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : (patch as T)) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // Never let a patch key rewrite the prototype chain (prototype pollution).
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const existing = (base as Record<string, unknown>)[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = mergeSettings(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

export function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (!isPlainObject(next)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

export interface SecretCodec {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

/**
 * Walk a settings patch: any plaintext value written to a secret path is
 * encrypted with `codec` (prefixed so we can tell). Writing the mask string
 * is a no-op (keeps the stored value); writing '' clears the secret. A value
 * that merely STARTS with the mask is a user who clicked into the masked
 * field and typed after it - store what they typed, never the mask glyphs.
 */
export function encryptSecretsInPatch(
  patch: Record<string, unknown>,
  stored: Settings,
  codec: SecretCodec
): Record<string, unknown> {
  const out = structuredClone(patch);
  for (const path of SECRET_PATHS) {
    const raw = getPath(out, path);
    if (typeof raw !== 'string') continue;
    let incoming: string = raw;
    if (incoming !== SECRET_MASK && incoming.startsWith(SECRET_MASK)) {
      incoming = incoming.slice(SECRET_MASK.length);
    }
    if (incoming === SECRET_MASK) {
      setPath(out, path, getPath(stored, path) ?? '');
    } else if (incoming === '') {
      setPath(out, path, '');
    } else if (!incoming.startsWith(ENC_PREFIX)) {
      setPath(out, path, ENC_PREFIX + codec.encrypt(incoming));
    } else {
      setPath(out, path, incoming);
    }
  }
  return out;
}

/** Replace stored secrets with a mask for safe transport to the renderer. */
export function maskSecrets(settings: Settings): Settings {
  const out = structuredClone(settings);
  for (const path of SECRET_PATHS) {
    const value = getPath(out, path);
    if (typeof value === 'string' && value.length > 0) {
      setPath(out as unknown as Record<string, unknown>, path, SECRET_MASK);
    }
  }
  return out;
}

/**
 * True when a secret is stored, WITHOUT attempting to decrypt it.
 *
 * Decryption can fail for reasons that have nothing to do with whether the
 * user signed in - most often the OS refusing the keychain after the app was
 * re-signed by an update. Anything answering "is this account connected?" has
 * to ask this, not decryptSecret: treating a locked secret as an absent one
 * signs the user out of an account they never disconnected.
 */
export function hasStoredSecret(settings: Settings, path: string): boolean {
  const value = getPath(settings, path);
  return typeof value === 'string' && value.trim().length > 0;
}

/** Decrypt a stored secret value ('' when unset). */
export function decryptSecret(settings: Settings, path: string, codec: SecretCodec): string {
  const value = getPath(settings, path);
  if (typeof value !== 'string' || value === '') return '';
  if (value.startsWith(ENC_PREFIX)) return codec.decrypt(value.slice(ENC_PREFIX.length));
  return value;
}

// ---------------------------------------------------------------------------
// Save-folder validation
//
// The save folder can live on an external drive that is not always plugged in.
// When it is gone, the worst response is a raw errno toast over an empty
// library (reads as data loss) - or worse, quietly mkdir-ing a decoy folder on
// the boot disk that shadows the real one when the drive returns. These
// helpers turn "the folder is unusable" into one plain sentence; settings.ts
// binds them to the filesystem.
// ---------------------------------------------------------------------------

/**
 * The mount point a macOS external-drive path lives on ('/Volumes/<drive>'),
 * or null for paths on the boot disk / other platforms.
 */
export function saveDirVolumeRoot(dir: string): string | null {
  const m = /^\/Volumes\/([^/]+)/.exec(dir);
  return m ? `/Volumes/${m[1]}` : null;
}

/** What a filesystem probe of the save folder found. */
export interface SaveDirProbe {
  /** The folder itself exists. */
  exists: boolean;
  /**
   * The folder can be used: a test file wrote and removed cleanly (when it
   * exists), or the nearest existing parent is writable (when it does not -
   * the library creates a missing folder on demand, so that case is healthy).
   */
  writable: boolean;
  /** For '/Volumes/...' paths: the drive's mount point exists. */
  volumeMounted: boolean | null;
}

/**
 * One plain-English sentence describing why the save folder is unusable, or
 * null when it is fine. Written for someone who does not know what a mount
 * point is: name the folder, say what happened, say what to do.
 */
export function describeSaveDirProblem(dir: string, probe: SaveDirProbe): string | null {
  if (probe.volumeMounted === false) {
    return `Your recordings folder is on a drive that is not connected (${dir}). Reconnect the drive, or choose a new folder in Settings.`;
  }
  if (!probe.exists && !probe.writable) {
    return `Your recordings folder is missing and cannot be created (${dir}). Choose a new folder in Settings.`;
  }
  if (probe.exists && !probe.writable) {
    return `Open Loom cannot write to your recordings folder (${dir}). Check the folder's permissions, or choose a new folder in Settings.`;
  }
  return null;
}
