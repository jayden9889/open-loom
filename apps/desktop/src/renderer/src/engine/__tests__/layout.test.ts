import { describe, expect, it } from 'vitest';
import { bubbleBox, cameraDrawPlan, coverFit } from '../layout';

describe('coverFit', () => {
  it('fills a square box from a wide source, centring the overflow', () => {
    // 1920x1080 into a 200x200 box: scale by height (200/1080)? no, cover = max.
    const r = coverFit(1920, 1080, 0, 0, 200, 200);
    expect(Math.max(r.dw, r.dh)).toBeGreaterThanOrEqual(200);
    expect(Math.min(r.dw, r.dh)).toBeCloseTo(200, 5); // the tighter axis exactly covers
    // Centred: equal overflow on the wide axis.
    expect(r.dx).toBeCloseTo((200 - r.dw) / 2, 5);
    expect(r.dy).toBeCloseTo((200 - r.dh) / 2, 5);
  });

  it('honours the box origin offset', () => {
    const r = coverFit(1280, 720, 24, 800, 240, 240);
    expect(r.dx + r.dw / 2).toBeCloseTo(24 + 120, 5); // centre lands at box centre x
    expect(r.dy + r.dh / 2).toBeCloseTo(800 + 120, 5);
  });

  it('never divides by zero when the camera has no dimensions yet', () => {
    const r = coverFit(0, 0, 0, 0, 100, 100);
    expect(Number.isFinite(r.dw)).toBe(true);
    expect(Number.isFinite(r.dh)).toBe(true);
  });
});

describe('bubbleBox', () => {
  it('places an M bubble bottom-left at 1080p reference scale', () => {
    const b = bubbleBox(1920, 1080, 240);
    expect(b.d).toBe(240);
    expect(b.x).toBe(24);
    expect(b.y).toBe(1080 - 240 - 24);
  });

  it('scales the bubble down on a smaller canvas', () => {
    const b = bubbleBox(960, 540, 240);
    expect(b.d).toBe(120); // half height -> half diameter
    expect(b.x).toBe(12);
    expect(b.y).toBe(540 - 120 - 12);
  });
});

describe('cameraDrawPlan', () => {
  it('off: draws the window only, no camera', () => {
    const p = cameraDrawPlan('off', 1920, 1080, true, 1280, 720, 240);
    expect(p.drawWindow).toBe(true);
    expect(p.camera).toBeNull();
  });

  it('bubble: draws the window plus a bottom-left camera circle', () => {
    const p = cameraDrawPlan('bubble', 1920, 1080, true, 1280, 720, 240);
    expect(p.drawWindow).toBe(true);
    expect(p.camera?.kind).toBe('bubble');
    if (p.camera?.kind === 'bubble') {
      expect(p.camera.box.d).toBe(240);
      expect(p.camera.box.x).toBe(24);
      // cover-fit rect sits inside the circle box bounds (overflow centred).
      expect(p.camera.rect.dx).toBeLessThanOrEqual(p.camera.box.x);
    }
  });

  it('full: hides the window and cover-fits the camera over the whole canvas', () => {
    const p = cameraDrawPlan('full', 1920, 1080, true, 1280, 720, 240);
    expect(p.drawWindow).toBe(false);
    expect(p.camera?.kind).toBe('full');
    if (p.camera?.kind === 'full') {
      // A 1280x720 camera cover-fitting a 1920x1080 canvas scales to fill exactly.
      expect(p.camera.rect.dw).toBeCloseTo(1920, 5);
      expect(p.camera.rect.dh).toBeCloseTo(1080, 5);
      expect(p.camera.rect.dx).toBeCloseTo(0, 5);
      expect(p.camera.rect.dy).toBeCloseTo(0, 5);
    }
  });

  it('full mirror symmetry: the cover rect stays horizontally centred', () => {
    // A tall camera into a wide canvas overflows vertically but centres in x,
    // so mirroring in the compositor keeps it centred.
    const p = cameraDrawPlan('full', 1920, 1080, true, 720, 1280, 240);
    if (p.camera?.kind === 'full') {
      expect(p.camera.rect.dx + p.camera.rect.dw / 2).toBeCloseTo(960, 5);
    } else {
      throw new Error('expected a full camera plan');
    }
  });

  it('falls back to window-only when the camera is not ready, for every layout', () => {
    for (const layout of ['bubble', 'full', 'off'] as const) {
      const p = cameraDrawPlan(layout, 1920, 1080, false, 0, 0, 240);
      expect(p.drawWindow).toBe(true);
      expect(p.camera).toBeNull();
    }
  });
});
