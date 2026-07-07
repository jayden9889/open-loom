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
    recording: {
      quality: '1080p',
      fps: 30,
      defaultMode: 'screen-cam',
      cameraId: '',
      micId: '',
      systemAudio: false,
      maxDurationMin: 0,
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
 * is a no-op (keeps the stored value); writing '' clears the secret.
 */
export function encryptSecretsInPatch(
  patch: Record<string, unknown>,
  stored: Settings,
  codec: SecretCodec
): Record<string, unknown> {
  const out = structuredClone(patch);
  for (const path of SECRET_PATHS) {
    const incoming = getPath(out, path);
    if (typeof incoming !== 'string') continue;
    if (incoming === SECRET_MASK) {
      setPath(out, path, getPath(stored, path) ?? '');
    } else if (incoming === '') {
      setPath(out, path, '');
    } else if (!incoming.startsWith(ENC_PREFIX)) {
      setPath(out, path, ENC_PREFIX + codec.encrypt(incoming));
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

/** Decrypt a stored secret value ('' when unset). */
export function decryptSecret(settings: Settings, path: string, codec: SecretCodec): string {
  const value = getPath(settings, path);
  if (typeof value !== 'string' || value === '') return '';
  if (value.startsWith(ENC_PREFIX)) return codec.decrypt(value.slice(ENC_PREFIX.length));
  return value;
}
