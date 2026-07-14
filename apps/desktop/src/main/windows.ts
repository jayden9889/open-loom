/**
 * Window factory: main library window, recording HUD, webcam bubble,
 * countdown overlay, draw overlay and the hidden recorder-engine window.
 */
import { BrowserWindow, screen, shell, type Display, type Rectangle } from 'electron';
import path from 'node:path';
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

/** True only for the app's own pages: the dev vite origin, or packaged file:// pages. */
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
  return u.protocol === 'file:';
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

export const LAUNCHER_SIZE = { width: 316, height: 640 };

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
    hasShadow: false,
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

export function getLauncherWindow(): BrowserWindow | null {
  return launcherWindow && !launcherWindow.isDestroyed() ? launcherWindow : null;
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

export const HUD_SIZE = { width: 68, height: 388 };
/** Extra height for the draw toolbar (pen colours + clear + done) while ink is on. */
export const HUD_DRAW_EXTRA = 155;

/** Frameless control bar, left-center of the recorded display (SPEC R7). */
export function showHud(display: Display): BrowserWindow {
  destroyHud();
  const { workArea } = display;
  hudWindow = overlayBase(
    {
      x: workArea.x + 16,
      y: workArea.y + Math.round((workArea.height - HUD_SIZE.height) / 2),
      width: HUD_SIZE.width,
      height: HUD_SIZE.height,
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

export function destroyHud(): void {
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.destroy();
  hudWindow = null;
}

/** Circular webcam bubble, bottom-left of the recorded display (SPEC R6). */
export function showBubble(display: Display, size: BubbleSize): BrowserWindow {
  const diameter = BUBBLE_SIZES[size];
  const { workArea } = display;
  const bounds = {
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
  bubbleWindow = overlayBase(bounds, true);
  bubbleWindow.setMovable(true);
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
  bubbleWindow.setBounds({
    x: cur.x,
    y: cur.y + cur.height - diameter,
    width: diameter,
    height: diameter,
  });
}

export function setBubbleVisible(visible: boolean): void {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  if (visible) bubbleWindow.showInactive();
  else bubbleWindow.hide();
}

/**
 * Grow the bubble window to cover the whole display so full-display capture
 * records the camera full-frame (the 'full' camera layout, SPEC R6). The
 * renderer switches to a rectangular opaque cover-fit via setBubbleLayout.
 */
/** Restore the bubble window to its circular size, anchored bottom-left of the display. */
export function positionBubbleCircle(display: Display, size: BubbleSize): void {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  const diameter = BUBBLE_SIZES[size];
  const { workArea } = display;
  bubbleWindow.setBounds({
    x: workArea.x + 24,
    y: workArea.y + workArea.height - diameter - 24,
    width: diameter,
    height: diameter,
  });
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
  if (!hudWindow || hudWindow.isDestroyed()) return;
  const b = hudWindow.getBounds();
  const target = HUD_SIZE.height + (expanded ? HUD_DRAW_EXTRA : 0);
  if (b.height !== target) hudWindow.setBounds({ ...b, height: target });
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

export function getEngineWindow(): BrowserWindow | null {
  return engineWindow && !engineWindow.isDestroyed() ? engineWindow : null;
}

export function destroyEngineWindow(): void {
  if (engineWindow && !engineWindow.isDestroyed()) engineWindow.destroy();
  engineWindow = null;
}

export function getHudWindow(): BrowserWindow | null {
  return hudWindow && !hudWindow.isDestroyed() ? hudWindow : null;
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
