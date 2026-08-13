/**
 * Render an Electron accelerator string the way the OS writes shortcuts:
 * symbol modifiers with no joiners on macOS ("⌃2", "⌘⇧L"), worded with
 * plus-joiners elsewhere ("Ctrl+2"). Shared by the HUD hint strip and the
 * Settings Shortcuts pane so the same combo never reads two different ways.
 */
export function prettyAccel(accel: string): string {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const out = accel
    .replace('CommandOrControl', isMac ? '⌘' : 'Ctrl')
    .replace('Command', '⌘')
    .replace('Control', isMac ? '⌃' : 'Ctrl')
    .replace('Shift', isMac ? '⇧' : 'Shift')
    .replace('Alt', isMac ? '⌥' : 'Alt');
  return isMac ? out.replaceAll('+', '') : out;
}
