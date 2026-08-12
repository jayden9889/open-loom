/**
 * Turn a keyboard event into an Electron accelerator string. Pure, so it is
 * unit-testable; the Settings ShortcutField feeds real events in.
 *
 * Two traps this exists to avoid:
 *  - `e.key` is the composed character. On macOS, Option composes: pressing
 *    Option+Shift+P yields key 'Π', and 'Alt+Shift+Π' registers nothing. The
 *    physical `e.code` ('KeyP') is layout- and modifier-independent, so the
 *    key part always comes from `code`.
 *  - Collapsing Command and Control into 'CommandOrControl' makes shortcuts
 *    like the draw default 'Control+1' impossible to enter on a Mac. The two
 *    modifiers stay distinct on macOS; elsewhere Control maps to the portable
 *    'CommandOrControl' spelling that the shipped defaults use.
 */

export interface AccelKeyEvent {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** `e.code` values that name a key Electron accepts by (almost) the same name. */
const NAMED_CODES: Record<string, string> = {
  Space: 'Space',
  Enter: 'Return',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
};

/** The accelerator key part for a physical key code, or null when unusable. */
export function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad) return `num${numpad[1]}`;
  const fn = /^(F([1-9]|1[0-9]|2[0-4]))$/.exec(code);
  if (fn) return fn[1]!;
  return NAMED_CODES[code] ?? null;
}

/**
 * Accelerator for a captured key event, or null while the press is not yet a
 * usable global shortcut (modifier still held alone, no modifier at all, or a
 * key Electron cannot register).
 */
export function accelFromKeyEvent(e: AccelKeyEvent, isMac: boolean): string | null {
  // A modifier on its own is not a shortcut yet - wait for the real key.
  if (/^(Shift|Control|Alt|Meta)(Left|Right)?$/.test(e.code)) return null;
  const mods: string[] = [];
  if (e.metaKey) mods.push(isMac ? 'Command' : 'Super');
  if (e.ctrlKey) mods.push(isMac ? 'Control' : 'CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (mods.length === 0) return null; // global shortcuts need a modifier
  const key = keyFromCode(e.code);
  if (!key) return null;
  return [...mods, key].join('+');
}
