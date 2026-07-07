/**
 * Draw overlay (SPEC R10 + R11): red 4px pen strokes that fade 3s after
 * being drawn, plus click-highlight ripples. Mouse events only reach this
 * window while drawing is enabled (main toggles setIgnoreMouseEvents).
 */
import './styles/draw.css';

interface StrokePoint {
  x: number;
  y: number;
}

interface Stroke {
  points: StrokePoint[];
  /** Time the stroke was completed (fade timer starts here). */
  doneAt: number | null;
}

interface Ripple {
  x: number;
  y: number;
  startedAt: number;
}

const FADE_DELAY_MS = 3000;
const FADE_MS = 500;
const RIPPLE_MS = 450;

const canvas = document.getElementById('draw-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

let strokes: Stroke[] = [];
let ripples: Ripple[] = [];
let current: Stroke | null = null;
let drawEnabled = false;
let rafPending = false;

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

function strokeAlpha(stroke: Stroke, now: number): number {
  if (stroke.doneAt === null) return 1;
  const age = now - stroke.doneAt;
  if (age < FADE_DELAY_MS) return 1;
  return Math.max(0, 1 - (age - FADE_DELAY_MS) / FADE_MS);
}

function render(): void {
  rafPending = false;
  const now = performance.now();
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  strokes = strokes.filter((s) => strokeAlpha(s, now) > 0);
  for (const stroke of strokes) {
    const pts = stroke.points;
    if (pts.length < 2) continue;
    ctx.globalAlpha = strokeAlpha(stroke, now);
    ctx.strokeStyle = '#FF453A';
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

  if (strokes.length > 0 || ripples.length > 0 || current) schedule();
}

function schedule(): void {
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(render);
  }
}

canvas.addEventListener('pointerdown', (e) => {
  if (!drawEnabled) return;
  current = { points: [{ x: e.clientX, y: e.clientY }], doneAt: null };
  strokes.push(current);
  canvas.setPointerCapture(e.pointerId);
  schedule();
});

canvas.addEventListener('pointermove', (e) => {
  if (!current) return;
  current.points.push({ x: e.clientX, y: e.clientY });
  schedule();
});

function endStroke(): void {
  if (current) {
    current.doneAt = performance.now();
    current = null;
    schedule();
  }
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

window.openloomInternal.onDrawEnable((on) => {
  drawEnabled = on;
  document.body.classList.toggle('drawing', on);
  if (!on) endStroke();
});

window.openloomInternal.onDrawRipple(({ x, y }) => {
  ripples.push({ x, y, startedAt: performance.now() });
  schedule();
});
