/**
 * Cut quiet parts must be safe by construction: silences are padded so words
 * are not clipped, stretches too short after padding are skipped, existing
 * cuts survive, and an edit that would gut the video is refused as a no-op.
 */
import { describe, expect, it } from 'vitest';
import { MIN_SILENCE_CUT, SILENCE_PAD, cutQuietParts } from './Editor';

interface Seg {
  start: number;
  end: number;
  kept: boolean;
}

const whole = (end: number): Seg[] => [{ start: 0, end, kept: true }];

describe('cutQuietParts', () => {
  it('marks a padded silence as removed inside a kept segment', () => {
    const { segs, cutCount, removedSec } = cutQuietParts(whole(60), [{ start: 10, end: 14 }]);
    expect(cutCount).toBe(1);
    expect(segs).toEqual([
      { start: 0, end: 10 + SILENCE_PAD, kept: true },
      { start: 10 + SILENCE_PAD, end: 14 - SILENCE_PAD, kept: false },
      { start: 14 - SILENCE_PAD, end: 60, kept: true },
    ]);
    expect(removedSec).toBeCloseTo(4 - 2 * SILENCE_PAD, 5);
  });

  it('skips stretches too short to matter after padding', () => {
    const shortest = MIN_SILENCE_CUT + 2 * SILENCE_PAD;
    const result = cutQuietParts(whole(60), [{ start: 20, end: 20 + shortest - 0.05 }]);
    expect(result.cutCount).toBe(0);
    expect(result.segs).toEqual(whole(60));
  });

  it('applies several silences and leaves existing cuts alone', () => {
    const existing: Seg[] = [
      { start: 0, end: 30, kept: true },
      { start: 30, end: 40, kept: false }, // user's own cut
      { start: 40, end: 60, kept: true },
    ];
    const { segs, cutCount } = cutQuietParts(existing, [
      { start: 5, end: 8 },
      { start: 32, end: 36 }, // inside the user's cut: nothing new to remove
      { start: 45, end: 50 },
    ]);
    expect(cutCount).toBe(2);
    expect(segs.filter((s) => !s.kept).length).toBe(3);
    // The user's cut is untouched.
    expect(segs.some((s) => !s.kept && s.start === 30 && s.end === 40)).toBe(true);
  });

  it('refuses an edit that would leave less than a second of video', () => {
    const result = cutQuietParts(whole(5), [{ start: 0, end: 5 }]);
    expect(result.cutCount).toBe(0);
    expect(result.segs).toEqual(whole(5));
  });

  it('clips a silence that spans a kept/removed boundary to the kept part only', () => {
    const existing: Seg[] = [
      { start: 0, end: 20, kept: true },
      { start: 20, end: 30, kept: false },
    ];
    const { segs, cutCount } = cutQuietParts(existing, [{ start: 15, end: 25 }]);
    expect(cutCount).toBe(1);
    expect(segs).toEqual([
      { start: 0, end: 15 + SILENCE_PAD, kept: true },
      // New cut merges with the existing removed tail.
      { start: 15 + SILENCE_PAD, end: 30, kept: false },
    ]);
  });
});
