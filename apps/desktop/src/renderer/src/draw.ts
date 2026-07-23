/**
 * Draw overlay (SPEC R10 + R11): pen strokes for talking over content, plus
 * click-highlight ripples. Ink NEVER fades while draw mode is on - it is the
 * walkthrough annotation layer. Leaving draw mode (HUD Done button, Draw
 * toggle, Esc or the shortcut) is the exit signal: the ink fades out right
 * then and the mouse returns to the page. Mouse events only reach this
 * window while drawing is enabled (main toggles setIgnoreMouseEvents); the
 * HUD floats ABOVE this surface so its controls stay clickable mid-draw.
 */
import './styles/draw.css';

interface StrokePoint {
  x: number;
  y: number;
}

interface Stroke {
  points: StrokePoint[];
  color: string;
}

interface Ripple {
  x: number;
  y: number;
  startedAt: number;
}

/** Ink fade-out when the presenter exits draw mode. */
const INK_FADE_MS = 600;
const RIPPLE_MS = 450;

/** Pen palette, keyed by the semantic names the HUD toolbar sends. */
const PEN_COLORS: Record<string, string> = {
  red: '#FF453A',
  violet: '#635BFF',
  yellow: '#FFD60A',
};
let penColor = PEN_COLORS['red']!;

const canvas = document.getElementById('draw-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

// Mode indicator: a small dot in the pen colour rides just under the cursor
// while draw mode is on, so the presenter always knows the pen is live. It
// stays hidden until the first pointer position arrives (no stale corner dot).
const dot = document.createElement('div');
dot.id = 'draw-dot';
document.body.appendChild(dot);

function placeDot(x: number, y: number): void {
  dot.style.transform = `translate(${x}px, ${y}px)`;
  dot.classList.add('placed');
}

let strokes: Stroke[] = [];
let ripples: Ripple[] = [];
let current: Stroke | null = null;
let drawEnabled = false;
let rafPending = false;
/** Set when the ink is fading out; all strokes share one alpha ramp. */
let inkFadeStart: number | null = null;

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

function inkAlpha(now: number): number {
  if (inkFadeStart === null) return 1;
  return Math.max(0, 1 - (now - inkFadeStart) / INK_FADE_MS);
}

function render(): void {
  rafPending = false;
  const now = performance.now();
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  const alpha = inkAlpha(now);
  if (inkFadeStart !== null && alpha <= 0) {
    strokes = [];
    current = null;
    inkFadeStart = null;
  }
  for (const stroke of strokes) {
    const pts = stroke.points;
    if (pts.length < 2) continue;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  ripples = ripples.filter((r) => now - r.startedAt < RIPPLE_MS);
  for (const ripple of ripples) {
    const t = (now - ripple.startedAt) / RIPPLE_MS;
    const radius = 8 + t * 34;
    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2);
    ctx.lineWidth = 3 * (1 - t) + 1;
    ctx.strokeStyle = `rgba(99, 91, 255, ${0.85 * (1 - t)})`;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, 5 * (1 - t) + 2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(99, 91, 255, ${0.6 * (1 - t)})`;
    ctx.fill();
  }

  if (ripples.length > 0 || current || inkFadeStart !== null) schedule();
}

function schedule(): void {
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(render);
  }
}

canvas.addEventListener('pointerdown', (e) => {
  if (!drawEnabled) return;
  current = { points: [{ x: e.clientX, y: e.clientY }], color: penColor };
  strokes.push(current);
  canvas.setPointerCapture(e.pointerId);
  schedule();
});

window.addEventListener('pointermove', (e) => {
  if (drawEnabled) placeDot(e.clientX, e.clientY);
  if (!current) return;
  current.points.push({ x: e.clientX, y: e.clientY });
  schedule();
});

function endStroke(): void {
  if (current) {
    current = null;
    schedule();
  }
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

function clearAll(): void {
  strokes = [];
  ripples = [];
  current = null;
  inkFadeStart = null;
  schedule();
}

window.openloomInternal.onDrawEnable((on) => {
  drawEnabled = on;
  document.body.classList.toggle('drawing', on);
  if (on) {
    // Fresh entry: the dot appears at the first cursor position, not wherever
    // it was left last time.
    dot.classList.remove('placed');
    // Re-entering draw mode rescues ink that was mid-fade.
    inkFadeStart = null;
    schedule();
  } else {
    // Exiting draw mode melts the ink - the annotation is over.
    endStroke();
    if (strokes.length > 0 && inkFadeStart === null) {
      inkFadeStart = performance.now();
      schedule();
    }
  }
});

window.openloomInternal.onDrawColor((color) => {
  penColor = PEN_COLORS[color] ?? PEN_COLORS['red']!;
  dot.style.background = penColor;
});

window.openloomInternal.onDrawClear(() => clearAll());

// Esc exits draw mode (the main process flips interactivity off and this
// window's enable handler melts the ink).
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawEnabled) window.openloom.toggleDraw(false);
});

window.openloomInternal.onDrawRipple(({ x, y }) => {
  ripples.push({ x, y, startedAt: performance.now() });
  schedule();
});
