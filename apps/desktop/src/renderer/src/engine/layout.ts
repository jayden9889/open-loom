/**
 * Pure geometry for the window-composite camera layouts (SPEC R6). Kept DOM-free
 * so the bubble/full/off drawing decisions are unit-testable without a real
 * canvas. engine.ts feeds these plans straight into the 2D context.
 */
import type { CameraLayout } from '@shared/types';

export interface CoverRect {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * Cover-fit a source of camW x camH into the box (x, y, w, h): the source is
 * scaled to fully cover the box and centred, so it may overflow on one axis.
 */
export function coverFit(
  camW: number,
  camH: number,
  x: number,
  y: number,
  w: number,
  h: number
): CoverRect {
  const safeCamW = camW > 0 ? camW : 1;
  const safeCamH = camH > 0 ? camH : 1;
  const s = Math.max(w / safeCamW, h / safeCamH);
  const dw = safeCamW * s;
  const dh = safeCamH * s;
  return { dx: x + (w - dw) / 2, dy: y + (h - dh) / 2, dw, dh };
}

export interface BubbleBox {
  /** Diameter in canvas pixels. */
  d: number;
  x: number;
  y: number;
}

/** Bottom-left bubble box, scaled against a 1080p reference (matches on-screen size). */
export function bubbleBox(canvasW: number, canvasH: number, bubblePx: number): BubbleBox {
  const scale = canvasH / 1080;
  const d = Math.round(bubblePx * scale);
  const margin = Math.round(24 * scale);
  return { d, x: margin, y: canvasH - d - margin };
}

export type CameraDrawPlan =
  | { drawWindow: true; camera: null }
  | { drawWindow: true; camera: { kind: 'bubble'; box: BubbleBox; rect: CoverRect } }
  | { drawWindow: false; camera: { kind: 'full'; rect: CoverRect } };

/**
 * Decide what the window-composite compositor draws for a given layout:
 * - 'off'    → window only.
 * - 'bubble' → window plus the circular camera bubble bottom-left (default).
 * - 'full'   → the camera cover-fit over the whole canvas, window hidden.
 * When the camera is not ready every layout falls back to window-only so the
 * recording never goes black.
 */
export function cameraDrawPlan(
  layout: CameraLayout,
  canvasW: number,
  canvasH: number,
  camReady: boolean,
  camW: number,
  camH: number,
  bubblePx: number
): CameraDrawPlan {
  if (layout === 'full' && camReady) {
    return { drawWindow: false, camera: { kind: 'full', rect: coverFit(camW, camH, 0, 0, canvasW, canvasH) } };
  }
  if (layout === 'bubble' && camReady) {
    const box = bubbleBox(canvasW, canvasH, bubblePx);
    return {
      drawWindow: true,
      camera: { kind: 'bubble', box, rect: coverFit(camW, camH, box.x, box.y, box.d, box.d) },
    };
  }
  return { drawWindow: true, camera: null };
}
