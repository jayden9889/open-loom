/**
 * Shortcut capture tests: the accelerator must come from the physical key,
 * express every shipped default, and keep Command and Control distinct.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHORTCUTS } from '@shared/types';
import { accelFromKeyEvent, keyFromCode, type AccelKeyEvent } from './shortcut-accel';

const ev = (code: string, mods: Partial<AccelKeyEvent> = {}): AccelKeyEvent => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('accelFromKeyEvent', () => {
  it('uses the physical key, not the composed character (Option+Shift+P on macOS)', () => {
    // e.key would be 'Π' here; e.code stays KeyP.
    expect(accelFromKeyEvent(ev('KeyP', { altKey: true, shiftKey: true }), true)).toBe('Alt+Shift+P');
  });

  it('can express every shipped default', () => {
    expect(accelFromKeyEvent(ev('KeyL', { metaKey: true, shiftKey: true }), true)).toBe('Command+Shift+L');
    expect(accelFromKeyEvent(ev('KeyP', { altKey: true, shiftKey: true }), true)).toBe('Alt+Shift+P');
    expect(accelFromKeyEvent(ev('KeyC', { altKey: true, shiftKey: true }), true)).toBe('Alt+Shift+C');
    expect(accelFromKeyEvent(ev('KeyR', { metaKey: true, shiftKey: true }), true)).toBe('Command+Shift+R');
    // The draw default Control+1 was impossible to re-enter when Command and
    // Control collapsed into one token.
    expect(accelFromKeyEvent(ev('Digit1', { ctrlKey: true }), true)).toBe(DEFAULT_SHORTCUTS.draw);
  });

  it('keeps Command and Control distinct on macOS', () => {
    expect(accelFromKeyEvent(ev('KeyL', { ctrlKey: true }), true)).toBe('Control+L');
    expect(accelFromKeyEvent(ev('KeyL', { metaKey: true }), true)).toBe('Command+L');
    expect(accelFromKeyEvent(ev('KeyL', { metaKey: true, ctrlKey: true }), true)).toBe('Command+Control+L');
  });

  it('maps Control to the portable spelling off macOS', () => {
    expect(accelFromKeyEvent(ev('KeyL', { ctrlKey: true, shiftKey: true }), false)).toBe(
      'CommandOrControl+Shift+L'
    );
    expect(accelFromKeyEvent(ev('KeyL', { metaKey: true }), false)).toBe('Super+L');
  });

  it('waits while only modifiers are held', () => {
    expect(accelFromKeyEvent(ev('ShiftLeft', { shiftKey: true }), true)).toBeNull();
    expect(accelFromKeyEvent(ev('MetaRight', { metaKey: true }), true)).toBeNull();
    expect(accelFromKeyEvent(ev('AltLeft', { altKey: true, shiftKey: true }), true)).toBeNull();
  });

  it('rejects a press with no modifier', () => {
    expect(accelFromKeyEvent(ev('KeyA'), true)).toBeNull();
  });

  it('rejects keys Electron cannot register', () => {
    expect(accelFromKeyEvent(ev('CapsLock', { metaKey: true }), true)).toBeNull();
    expect(accelFromKeyEvent(ev('IntlBackslash', { metaKey: true }), true)).toBeNull();
  });
});

describe('keyFromCode', () => {
  it('maps letters, digits and function keys', () => {
    expect(keyFromCode('KeyA')).toBe('A');
    expect(keyFromCode('Digit9')).toBe('9');
    expect(keyFromCode('Numpad3')).toBe('num3');
    expect(keyFromCode('F5')).toBe('F5');
    expect(keyFromCode('F24')).toBe('F24');
  });

  it('maps named and punctuation keys', () => {
    expect(keyFromCode('Space')).toBe('Space');
    expect(keyFromCode('Enter')).toBe('Return');
    expect(keyFromCode('ArrowUp')).toBe('Up');
    expect(keyFromCode('Comma')).toBe(',');
    expect(keyFromCode('Backquote')).toBe('`');
  });

  it('returns null for unusable codes', () => {
    expect(keyFromCode('CapsLock')).toBeNull();
    expect(keyFromCode('MediaPlayPause')).toBeNull();
  });
});
