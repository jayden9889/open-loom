/**
 * Settings core tests: defaults, deep merge, secret encryption/masking
 * round-trips.
 */
import { describe, expect, it } from 'vitest';
import type { Settings } from '@shared/types';
import {
  ENC_PREFIX,
  SECRET_MASK,
  decryptSecret,
  defaultSettings,
  encryptSecretsInPatch,
  maskSecrets,
  mergeSettings,
  type SecretCodec,
} from '../settings-core';

const codec: SecretCodec = {
  encrypt: (p) => Buffer.from(p, 'utf8').toString('base64'),
  decrypt: (s) => Buffer.from(s, 'base64').toString('utf8'),
};

describe('defaults + merge', () => {
  it('produces complete defaults', () => {
    const d = defaultSettings('/videos/OpenLoom');
    expect(d.saveDir).toBe('/videos/OpenLoom');
    expect(d.recording.quality).toBe('1080p');
    expect(d.shortcuts.startStop).toBe('CommandOrControl+Shift+L');
    expect(d.sharing.provider).toBe('none');
  });

  it('deep-merges patches without dropping siblings', () => {
    const base = defaultSettings('/x');
    const next = mergeSettings(base, { recording: { fps: 60 } });
    expect(next.recording.fps).toBe(60);
    expect(next.recording.quality).toBe('1080p');
    expect(next.theme).toBe('auto');
  });

  it('fills newly added fields from defaults (settings migration)', () => {
    const stored = { theme: 'dark', recording: { quality: '4k' } };
    const next = mergeSettings(defaultSettings('/x'), stored);
    expect(next.theme).toBe('dark');
    expect(next.recording.quality).toBe('4k');
    expect(next.bubble.size).toBe('M'); // not in stored, from defaults
  });

  it('ignores undefined values in patches', () => {
    const base = defaultSettings('/x');
    const next = mergeSettings(base, { theme: undefined });
    expect(next.theme).toBe('auto');
  });
});

describe('secrets', () => {
  function withStoredKey(): Settings {
    const s = defaultSettings('/x');
    s.ai.apiKey = ENC_PREFIX + codec.encrypt('real-key');
    return s;
  }

  it('encrypts plaintext secrets in a patch', () => {
    const patch = encryptSecretsInPatch({ ai: { apiKey: 'my-secret' } }, defaultSettings('/x'), codec);
    const value = (patch as { ai: { apiKey: string } }).ai.apiKey;
    expect(value.startsWith(ENC_PREFIX)).toBe(true);
    expect(value).not.toContain('my-secret');
  });

  it('writing the mask keeps the stored secret', () => {
    const stored = withStoredKey();
    const patch = encryptSecretsInPatch({ ai: { apiKey: SECRET_MASK } }, stored, codec);
    expect((patch as { ai: { apiKey: string } }).ai.apiKey).toBe(stored.ai.apiKey);
  });

  it('writing an empty string clears the secret', () => {
    const patch = encryptSecretsInPatch({ ai: { apiKey: '' } }, withStoredKey(), codec);
    expect((patch as { ai: { apiKey: string } }).ai.apiKey).toBe('');
  });

  it('masks stored secrets for the renderer', () => {
    const masked = maskSecrets(withStoredKey());
    expect(masked.ai.apiKey).toBe(SECRET_MASK);
    expect(masked.transcription.apiKey).toBe(''); // unset stays empty
  });

  it('round-trips decryption', () => {
    expect(decryptSecret(withStoredKey(), 'ai.apiKey', codec)).toBe('real-key');
    expect(decryptSecret(defaultSettings('/x'), 'ai.apiKey', codec)).toBe('');
  });
});
