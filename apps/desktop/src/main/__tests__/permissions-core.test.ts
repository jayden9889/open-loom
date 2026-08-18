/**
 * Screen-probe classification tests: the probe must only claim certainty it
 * actually has. Foreign window titles prove a grant; hidden titles prove the
 * lack of one; anything else is honestly unknown.
 */
import { describe, expect, it } from 'vitest';
import { bitmapChannelSpread, classifyScreenProbe, isOwnWindowTitle } from '../permissions-core';

describe('classifyScreenProbe', () => {
  it('a foreign window title proves the grant is active', () => {
    expect(classifyScreenProbe(['Open Loom', 'Safari - GitHub'])).toBe('working');
  });

  it('windows with hidden titles prove the grant is NOT active', () => {
    // macOS strips other apps' titles from an unauthorised process.
    expect(classifyScreenProbe(['Open Loom', '', ''])).toBe('blocked');
  });

  it('own windows are never evidence of a grant', () => {
    expect(classifyScreenProbe(['Open Loom', 'openloom-hud', 'openloom-bubble'])).toBe('unknown');
    expect(classifyScreenProbe(['Open Loom Recorder'])).toBe('unknown');
  });

  it('no windows at all is unknown, not granted', () => {
    expect(classifyScreenProbe([])).toBe('unknown');
  });

  it('a readable foreign title wins over hidden ones', () => {
    // Some windows legitimately have no title even with the grant; one
    // readable foreign title is already proof.
    expect(classifyScreenProbe(['', 'Terminal', ''])).toBe('working');
  });

  it('whitespace-only titles count as hidden', () => {
    expect(classifyScreenProbe(['  ', 'Open Loom'])).toBe('blocked');
  });
});

describe('bitmapChannelSpread', () => {
  const px = (r: number, g: number, b: number) => [r, g, b, 255];

  it('a uniform buffer has zero spread (black screen or dead capture)', () => {
    expect(bitmapChannelSpread(new Uint8Array([...px(0, 0, 0), ...px(0, 0, 0)]))).toBe(0);
    expect(bitmapChannelSpread(new Uint8Array([...px(80, 80, 80), ...px(80, 80, 80)]))).toBe(0);
  });

  it('reports the largest per-channel spread', () => {
    expect(bitmapChannelSpread(new Uint8Array([...px(10, 0, 0), ...px(200, 5, 0)]))).toBe(190);
  });

  it('an empty buffer is zero rather than a throw', () => {
    expect(bitmapChannelSpread(new Uint8Array([]))).toBe(0);
  });

  it('a colourful wallpaper has spread - which is exactly why spread never proves a grant', () => {
    // Documented here so nobody reintroduces "not black means granted".
    const wallpaper = new Uint8Array([...px(20, 60, 120), ...px(240, 180, 40)]);
    expect(bitmapChannelSpread(wallpaper)).toBeGreaterThan(6);
  });
});

describe('isOwnWindowTitle', () => {
  it('catches every Open Loom window, including the launcher panel that once leaked', () => {
    for (const t of ['Open Loom', 'Open Loom Recorder', 'openloom-launcher', 'openloom-hud', 'openloom-notes', 'openloom-switcher']) {
      expect(isOwnWindowTitle(t)).toBe(true);
    }
  });

  it('leaves other apps recordable', () => {
    for (const t of ['Google Chrome', 'Loom', 'Open Loops - Notion', '']) {
      expect(isOwnWindowTitle(t)).toBe(false);
    }
  });
});
