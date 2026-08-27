/**
 * Window factory: main library window, recording HUD, webcam bubble,
 * countdown overlay, draw overlay and the hidden recorder-engine window.
 */
import { BrowserWindow, screen, shell, type Display, type Rectangle } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUBBLE_SIZES, type BubbleSize, type CameraLayout } from '@shared/types';
import { log } from './logger';

const isMac = process.platform === 'darwin';
const isDev = !!process.env['ELECTRON_RENDERER_URL'];

function preloadPath(): string {
  return path.join(import.meta.dirname, '../preload/index.cjs');
}

function pageUrl(page: string): { url?: string; file?: string } {
  if (isDev) return { url: `${process.env['ELECTRON_RENDERER_URL']}/${page}.html` };
  return { file: path.join(import.meta.dirname, `../renderer/${page}.html`) };
}

function loadPage(win: BrowserWindow, page: string): void {
  const target = pageUrl(page);
  if (target.url) void win.loadURL(target.url);
  else void win.loadFile(target.file!);
}

const basePrefs = {
  preload: preloadPath(),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
} as const;

// ---------------------------------------------------------------------------
// Navigation guards (hardening)
// ---------------------------------------------------------------------------

/** Origin the app's own renderer is served from (vite dev server, or file:// in prod). */
function appOrigin(): string | null {
  if (isDev) {
    try {
      return new URL(process.env['ELECTRON_RENDERER_URL']!).origin;
    } catch {
      return null;
    }
  }
  return 'file://';
}

/** Packaged renderer directory - the ONLY file:// location the app may navigate to. */
function rendererDir(): string {
  return path.resolve(import.meta.dirname, '../renderer');
}

/** True when a resolved filesystem path sits inside `dir` (not just shares its prefix). */
function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * True only for the app's own pages: the dev vite origin, or a packaged file://
 * page that resolves INSIDE the renderer directory. A bare `file:` check is not
 * enough - it would treat any local HTML (e.g. a file dropped on the window) as
 * a trusted app page, letting it run with the full preload bridge and no CSP.
 */
function isAppUrl(target: string): boolean {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return false;
  }
  if (isDev) {
    const origin = appOrigin();
    return origin !== null && u.origin === origin;
  }
  if (u.protocol !== 'file:') return false;
  try {
    return isInside(rendererDir(), path.resolve(fileURLToPath(u)));
  } catch {
    return false;
  }
}

/**
 * Lock a window down so the renderer can never spawn arbitrary child windows or
 * navigate away from the app's own pages. External http/https links open in the
 * user's default browser; every other target is denied. Called for every window.
 */
export function applyNavigationGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 740,
    minWidth: 920,
    minHeight: 600,
    show: false,
    title: 'Open Loom',
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          vibrancy: 'sidebar' as const,
          transparent: false,
        }
      : {}),
    backgroundColor: isMac ? undefined : '#f5f5f7',
    webPreferences: { ...basePrefs },
  });
  applyNavigationGuards(mainWindow);
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    log.info('main window ready');
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  loadPage(mainWindow, 'index');
  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

// ---------------------------------------------------------------------------
// Floating recording launcher (left edge of the screen)
// ---------------------------------------------------------------------------

let launcherWindow: BrowserWindow | null = null;

/* Height covers the talking-notes field without squeezing the source picker
   into a two-row sliver; small work areas still clamp in showLauncher. */
export const LAUNCHER_SIZE = { width: 316, height: 724 };

/**
 * Slim always-on-top panel pinned to the left edge of the primary display:
 * camera preview, mic, source picker and the Full face / Screen switch. Shown
 * on launch and whenever no recording is running; excluded from capture so it
 * never appears in a recording.
 */
export function showLauncher(opts?: { inactive?: boolean }): BrowserWindow {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    if (opts?.inactive) launcherWindow.showInactive();
    else {
      launcherWindow.show();
      launcherWindow.focus();
    }
    return launcherWindow;
  }
  const { workArea } = screen.getPrimaryDisplay();
  const height = Math.min(LAUNCHER_SIZE.height, workArea.height - 32);
  launcherWindow = new BrowserWindow({
    x: workArea.x + 16,
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width: LAUNCHER_SIZE.width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    /* The glass recipe's soft ambient shadow (DESIGN.md, Surfaces). The panel
       fills the window edge to edge, so a CSS shadow would clip; the native
       macOS shadow follows the rounded shape and costs no dead click area. */
    hasShadow: true,
    show: false,
    title: 'Open Loom Recorder',
    webPreferences: { ...basePrefs },
  });
  applyNavigationGuards(launcherWindow);
  launcherWindow.setAlwaysOnTop(true, 'floating');
  try {
    launcherWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (err) {
    log.warn(`launcher setVisibleOnAllWorkspaces failed: ${String(err)}`);
  }
  excludeFromCapture(launcherWindow);
  launcherWindow.once('ready-to-show', () => {
    if (opts?.inactive) launcherWindow?.showInactive();
    else launcherWindow?.show();
    // Transparent windows can first paint before macOS computes their shadow.
    if (isMac) launcherWindow?.invalidateShadow();
  });
  loadPage(launcherWindow, 'launcher');
  launcherWindow.on('closed', () => {
    log.info('launcher window closed');
    launcherWindow = null;
  });
  return launcherWindow;
}

/** Destroy (not hide) so the camera preview stream dies with the renderer. */
export function destroyLauncher(reason = 'unspecified'): void {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    log.info(`launcher destroyed (${reason})`);
    launcherWindow.destroy();
  }
  launcherWindow = null;
}

// ---------------------------------------------------------------------------
// Overlay + engine windows (recording session)
// ---------------------------------------------------------------------------

let hudWindow: BrowserWindow | null = null;
let bubbleWindow: BrowserWindow | null = null;
let countdownWindow: BrowserWindow | null = null;
let drawWindow: BrowserWindow | null = null;
let engineWindow: BrowserWindow | null = null;

function overlayBase(bounds: Rectangle, focusable: boolean): BrowserWindow {
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    focusable,
    webPreferences: { ...basePrefs },
  });
  applyNavigationGuards(win);
  win.setAlwaysOnTop(true, 'screen-saver');
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (err) {
    log.warn(`setVisibleOnAllWorkspaces failed: ${String(err)}`);
  }
  return win;
}

function excludeFromCapture(win: BrowserWindow): void {
  try {
    win.setContentProtection(true);
  } catch (err) {
    log.warn(`setContentProtection failed: ${String(err)}`);
  }
}

export const HUD_SIZE = { width: 68, height: 552 };
/** Extra height for the draw toolbar (pen colours + clear + done) while ink is on. */
export const HUD_DRAW_EXTRA = 155;
/** Wider footprint while the HUD shows the confirm or redo panel (readable copy). */
export const HUD_PANEL_SIZE = { width: 232, height: 248 };

/** Which face the HUD currently wears; drives the window bounds. */
type HudPanel = 'normal' | 'confirm' | 'redo';
let hudPanel: HudPanel = 'normal';
let hudDrawExpanded = false;

function applyHudBounds(): void {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  const b = hudWindow.getBounds();
  const target =
    hudPanel === 'normal'
      ? { width: HUD_SIZE.width, height: HUD_SIZE.height + (hudDrawExpanded ? HUD_DRAW_EXTRA : 0) }
      : { width: HUD_PANEL_SIZE.width, height: HUD_PANEL_SIZE.height };
  if (b.width !== target.width || b.height !== target.height) {
    hudWindow.setBounds({ x: b.x, y: b.y, ...target });
  }
}

/** Frameless control bar, left side of the recorded display (SPEC R7). */
export function showHud(display: Display): BrowserWindow {
  destroyHud();
  hudPanel = 'normal';
  hudDrawExpanded = false;
  const { workArea } = display;
  const height = Math.min(HUD_SIZE.height, workArea.height - 32);
  // Centre the bar in the space ABOVE the bubble's bottom-left home, so the
  // two never open on top of each other on a laptop screen.
  const bubbleReserve = BUBBLE_SIZES.M + 48;
  const y =
    workArea.y + Math.max(16, Math.round((workArea.height - bubbleReserve - height) / 2));
  hudWindow = overlayBase(
    {
      x: workArea.x + 16,
      y,
      width: HUD_SIZE.width,
      height,
    },
    true
  );
  hudWindow.setMovable(true);
  // One window LEVEL above every other overlay (draw surface included).
  // A same-level moveTop() is not enough: clicking the interactive draw
  // canvas re-raises it and buries the HUD, trapping the presenter in pen
  // mode. A higher level can never be clicked over - the cursor is the
  // normal pointer over the panel and the pen everywhere else.
  hudWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  excludeFromCapture(hudWindow);
  hudWindow.once('ready-to-show', () => hudWindow?.showInactive());
  loadPage(hudWindow, 'hud');
  hudWindow.on('closed', () => {
    hudWindow = null;
  });
  return hudWindow;
}

/** Swap the HUD between its control column and the wider confirm/redo panels. */
export function setHudPanel(panel: 'normal' | 'confirm' | 'redo'): void {
  hudPanel = panel;
  applyHudBounds();
}

export function destroyHud(): void {
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.destroy();
  hudWindow = null;
}

/**
 * Where the user last dragged the circular bubble, kept for the session so a
 * layout flip or a second take puts their face back where they chose - never
 * back over the content they moved it off.
 */
let bubbleCircleBounds: Rectangle | null = null;
let bubbleShape: 'circle' | 'full' = 'circle';

/** The dragged circle position when it still fits this display; null = use the default. */
function storedCircleBounds(display: Display, diameter: number): Rectangle | null {
  if (!bubbleCircleBounds) return null;
  const { workArea } = display;
  // Anchor the current diameter to the stored bottom-left corner (S/M/L may
  // have changed since the drag).
  const x = bubbleCircleBounds.x;
  const y = bubbleCircleBounds.y + bubbleCircleBounds.height - diameter;
  const fits =
    x >= workArea.x &&
    y >= workArea.y &&
    x + diameter <= workArea.x + workArea.width &&
    y + diameter <= workArea.y + workArea.height;
  return fits ? { x, y, width: diameter, height: diameter } : null;
}

/** Circular webcam bubble, bottom-left of the recorded display (SPEC R6). */
export function showBubble(display: Display, size: BubbleSize): BrowserWindow {
  const diameter = BUBBLE_SIZES[size];
  const { workArea } = display;
  const bounds = storedCircleBounds(display, diameter) ?? {
    x: workArea.x + 24,
    y: workArea.y + workArea.height - diameter - 24,
    width: diameter,
    height: diameter,
  };
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    resizeBubbleKeepAnchor(size);
    bubbleWindow.showInactive();
    return bubbleWindow;
  }
  bubbleShape = 'circle';
  bubbleWindow = overlayBase(bounds, true);
  bubbleWindow.setMovable(true);
  bubbleWindow.on('moved', () => {
    if (bubbleShape === 'circle' && bubbleWindow && !bubbleWindow.isDestroyed()) {
      bubbleCircleBounds = bubbleWindow.getBounds();
    }
  });
  bubbleWindow.once('ready-to-show', () => bubbleWindow?.showInactive());
  loadPage(bubbleWindow, 'bubble');
  bubbleWindow.on('closed', () => {
    bubbleWindow = null;
  });
  return bubbleWindow;
}

/** Resize the bubble in place, keeping its bottom-left corner anchored. */
export function resizeBubbleKeepAnchor(size: BubbleSize): void {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  const diameter = BUBBLE_SIZES[size];
  const cur = bubbleWindow.getBounds();
  const next = {
    x: cur.x,
    y: cur.y + cur.height - diameter,
    width: diameter,
    height: diameter,
  };
  bubbleWindow.setBounds(next);
  if (bubbleShape === 'circle') bubbleCircleBounds = next;
}

export function setBubbleVisible(visible: boolean): void {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  if (visible) bubbleWindow.showInactive();
  else bubbleWindow.hide();
}

/**
 * Restore the bubble window to its circular size: back to where the user last
 * dragged it, or the bottom-left default when it was never moved.
 */
export function positionBubbleCircle(display: Display, size: BubbleSize): void {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  const diameter = BUBBLE_SIZES[size];
  const { workArea } = display;
  bubbleShape = 'circle';
  bubbleWindow.setBounds(
    storedCircleBounds(display, diameter) ?? {
      x: workArea.x + 24,
      y: workArea.y + workArea.height - diameter - 24,
      width: diameter,
      height: diameter,
    }
  );
  bubbleWindow.setIgnoreMouseEvents(false);
}

/**
 * Grow the bubble window to cover the whole display so full-display capture
 * records the camera full-frame (the 'full' camera layout, SPEC R6). The
 * renderer switches to a rectangular opaque cover-fit via setBubbleLayout.
 * The cover ignores the mouse so the presenter is never trapped behind it;
 * the HUD and layout switcher live one window level above and stay clickable.
 */
export function positionBubbleFull(display: Display): void {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  bubbleShape = 'full';
  bubbleWindow.setBounds(display.bounds);
  bubbleWindow.setIgnoreMouseEvents(true);
}

/** Renderer-side fade duration for a bubble layout flip; keep in sync with bubble.css. */
const BUBBLE_FADE_MS = 220;

/**
 * Animate a circle <-> full-frame flip: fade the bubble out, swap the window
 * bounds while it is invisible, then let the set-layout message fade it back
 * in with the new shape. The OS bounds change itself cannot animate, so the
 * fade is what the recording (and the presenter) sees.
 */
export function fadeBubbleToLayout(
  display: Display,
  size: BubbleSize,
  layout: Exclude<CameraLayout, 'off'>
): void {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  bubbleWindow.webContents.send('bubble:fade-out');
  setTimeout(() => {
    if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
    if (layout === 'full') positionBubbleFull(display);
    else positionBubbleCircle(display, size);
    setBubbleLayout(layout);
  }, BUBBLE_FADE_MS);
}

/** Tell the bubble renderer to render as a circle, a full-frame cover, or hide. */
export function setBubbleLayout(layout: CameraLayout): void {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  const wc = bubbleWindow.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send('bubble:set-layout', layout));
  else wc.send('bubble:set-layout', layout);
}

export function destroyBubble(): void {
  if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.destroy();
  bubbleWindow = null;
}

export function getBubbleWindow(): BrowserWindow | null {
  return bubbleWindow && !bubbleWindow.isDestroyed() ? bubbleWindow : null;
}

// ---------------------------------------------------------------------------
// Camera layout switcher (bottom-center slider, Screen+Camera recordings)
// ---------------------------------------------------------------------------

let switcherWindow: BrowserWindow | null = null;

export const SWITCHER_SIZE = { width: 300, height: 56 };

/**
 * Slim glass slider pinned bottom-center of the recorded display while a
 * Screen+Camera recording runs: Full face <-> Face + screen. Excluded from
 * capture so it never appears in the recording, and one window level above
 * the other overlays so the full-frame camera cover can never bury it.
 */
export function showSwitcher(display: Display): BrowserWindow {
  destroySwitcher();
  const { workArea } = display;
  switcherWindow = overlayBase(
    {
      x: workArea.x + Math.round((workArea.width - SWITCHER_SIZE.width) / 2),
      y: workArea.y + workArea.height - SWITCHER_SIZE.height - 16,
      width: SWITCHER_SIZE.width,
      height: SWITCHER_SIZE.height,
    },
    true
  );
  switcherWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  excludeFromCapture(switcherWindow);
  switcherWindow.once('ready-to-show', () => switcherWindow?.showInactive());
  loadPage(switcherWindow, 'switcher');
  switcherWindow.on('closed', () => {
    switcherWindow = null;
  });
  return switcherWindow;
}

export function destroySwitcher(): void {
  if (switcherWindow && !switcherWindow.isDestroyed()) switcherWindow.destroy();
  switcherWindow = null;
}

// ---------------------------------------------------------------------------
// Talking-notes overlay (something to read while recording)
// ---------------------------------------------------------------------------

let notesWindow: BrowserWindow | null = null;

/* Tall enough to show a full 500-character note without hiding lines behind
   an invisible scroll. */
export const NOTES_SIZE = { width: 460, height: 292 };

/**
 * Where the user last dragged the notes card, kept for the session so the
 * next take does not put it back over the content they moved it off (same
 * contract as the camera bubble's position memory).
 */
let notesBounds: Rectangle | null = null;

/** The dragged position when it still fits this display; null = default. */
function storedNotesBounds(display: Display): Rectangle | null {
  if (!notesBounds) return null;
  const { workArea } = display;
  const fits =
    notesBounds.x >= workArea.x &&
    notesBounds.y >= workArea.y &&
    notesBounds.x + notesBounds.width <= workArea.x + workArea.width &&
    notesBounds.y + notesBounds.height <= workArea.y + workArea.height;
  return fits ? { ...notesBounds, width: NOTES_SIZE.width, height: NOTES_SIZE.height } : null;
}

/**
 * Glass card pinned top-centre of the recorded display - right under the
 * webcam, so reading it keeps the eyes near the lens. Shows the notes typed
 * on the launcher. Excluded from capture: the presenter reads it, the client
 * never sees it. Draggable if it covers something they need.
 */
export function showNotesOverlay(display: Display, text: string): BrowserWindow {
  destroyNotesOverlay();
  const { workArea } = display;
  notesWindow = overlayBase(
    storedNotesBounds(display) ?? {
      x: workArea.x + Math.round((workArea.width - NOTES_SIZE.width) / 2),
      y: workArea.y + 12,
      width: NOTES_SIZE.width,
      height: NOTES_SIZE.height,
    },
    true
  );
  notesWindow.setMovable(true);
  notesWindow.on('moved', () => {
    if (notesWindow && !notesWindow.isDestroyed()) notesBounds = notesWindow.getBounds();
  });
  notesWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  excludeFromCapture(notesWindow);
  notesWindow.once('ready-to-show', () => notesWindow?.showInactive());
  loadPage(notesWindow, 'notes');
  const wc = notesWindow.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send('notes:set-text', text));
  else wc.send('notes:set-text', text);
  notesWindow.on('closed', () => {
    notesWindow = null;
  });
  return notesWindow;
}

export function destroyNotesOverlay(): void {
  if (notesWindow && !notesWindow.isDestroyed()) notesWindow.destroy();
  notesWindow = null;
}

/**
 * Hide/show rather than destroy/recreate, so a toggle keeps the position the
 * user dragged the card to and costs no renderer restart.
 */
export function setNotesOverlayVisible(visible: boolean): void {
  if (!notesWindow || notesWindow.isDestroyed()) return;
  if (visible) notesWindow.showInactive();
  else notesWindow.hide();
}

/** 3-2-1 countdown overlay covering the recorded display (SPEC R5). */
export function showCountdown(display: Display): BrowserWindow {
  destroyCountdown();
  countdownWindow = overlayBase(display.bounds, true);
  excludeFromCapture(countdownWindow);
  countdownWindow.once('ready-to-show', () => countdownWindow?.show());
  loadPage(countdownWindow, 'countdown');
  countdownWindow.on('closed', () => {
    countdownWindow = null;
  });
  return countdownWindow;
}

export function destroyCountdown(): void {
  if (countdownWindow && !countdownWindow.isDestroyed()) countdownWindow.destroy();
  countdownWindow = null;
}

/**
 * Transparent draw overlay covering the recorded display (SPEC R10).
 * Mouse events pass through until drawing is enabled. Also renders click
 * ripples (SPEC R11), which never intercept the mouse.
 */
export function showDrawOverlay(display: Display): BrowserWindow {
  destroyDrawOverlay();
  drawWindow = overlayBase(display.bounds, true);
  drawWindow.setIgnoreMouseEvents(true, { forward: true });
  drawWindow.once('ready-to-show', () => drawWindow?.showInactive());
  loadPage(drawWindow, 'draw');
  drawWindow.on('closed', () => {
    drawWindow = null;
  });
  return drawWindow;
}

export function setDrawInteractive(interactive: boolean): void {
  if (!drawWindow || drawWindow.isDestroyed()) return;
  drawWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  drawWindow.webContents.send('draw:enable', interactive);
  if (interactive) drawWindow.focus();
}

/** Grow/shrink the HUD to make room for the draw toolbar. */
export function setHudExpanded(expanded: boolean): void {
  hudDrawExpanded = expanded;
  applyHudBounds();
}

export function sendDrawColor(color: string): void {
  if (!drawWindow || drawWindow.isDestroyed()) return;
  drawWindow.webContents.send('draw:color', color);
}

export function sendDrawClear(): void {
  if (!drawWindow || drawWindow.isDestroyed()) return;
  drawWindow.webContents.send('draw:clear');
}

export function getDrawWindow(): BrowserWindow | null {
  return drawWindow && !drawWindow.isDestroyed() ? drawWindow : null;
}

export function destroyDrawOverlay(): void {
  if (drawWindow && !drawWindow.isDestroyed()) drawWindow.destroy();
  drawWindow = null;
}

/** Hidden renderer window that owns getUserMedia/getDisplayMedia + MediaRecorder. */
export function getOrCreateEngineWindow(): BrowserWindow {
  if (engineWindow && !engineWindow.isDestroyed()) return engineWindow;
  engineWindow = new BrowserWindow({
    width: 480,
    height: 320,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      ...basePrefs,
      backgroundThrottling: false,
    },
  });
  applyNavigationGuards(engineWindow);
  loadPage(engineWindow, 'engine');
  engineWindow.on('closed', () => {
    engineWindow = null;
  });
  return engineWindow;
}

export function destroyEngineWindow(): void {
  if (engineWindow && !engineWindow.isDestroyed()) engineWindow.destroy();
  engineWindow = null;
}

// ---------------------------------------------------------------------------

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

export function displayForSource(displayId: string | undefined): Display {
  const displays = screen.getAllDisplays();
  if (displayId) {
    const match = displays.find((d) => String(d.id) === displayId);
    if (match) return match;
  }
  return screen.getPrimaryDisplay();
}
