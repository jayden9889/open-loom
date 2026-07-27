/**
 * A keep-ranges trim shifts everything after each cut. Leaving the transcript at
 * its original timings left it describing a video that no longer existed: lines
 * seeked to the wrong moment, library search kept matching words that had been
 * cut out, and AI regeneration read the stale copy.
 */
import { describe, expect, it } from 'vitest';
import { retimeSegments, retimeThroughRanges } from '../transcribe-core';

// Original 0-100s; the middle 30-60s was removed, so kept = [0,30] + [60,100].
const RANGES = [
  { start: 0, end: 30 },
  { start: 60, end: 100 },
];

describe('retimeThroughRanges', () => {
  it('leaves timestamps before the first cut untouched', () => {
    expect(retimeThroughRanges(0, RANGES)).toBe(0);
    expect(retimeThroughRanges(10, RANGES)).toBe(10);
    expect(retimeThroughRanges(30, RANGES)).toBe(30);
  });

  it('pulls later timestamps back by the removed duration', () => {
    expect(retimeThroughRanges(60, RANGES)).toBe(30); // 60 - 30s removed
    expect(retimeThroughRanges(70, RANGES)).toBe(40);
    expect(retimeThroughRanges(100, RANGES)).toBe(70);
  });

  it('returns null for a timestamp inside a removed section', () => {
    expect(retimeThroughRanges(45, RANGES)).toBeNull();
  });

  it('returns null past the end', () => {
    expect(retimeThroughRanges(120, RANGES)).toBeNull();
  });
});

describe('retimeSegments', () => {
  it('keeps surviving lines and shifts the ones after a cut', () => {
    const out = retimeSegments(
      [
        { start: 5, end: 10, text: 'before the cut' },
        { start: 40, end: 50, text: 'inside the cut' },
        { start: 70, end: 80, text: 'after the cut' },
      ],
      RANGES
    );
    expect(out).toEqual([
      { start: 5, end: 10, text: 'before the cut' },
      { start: 40, end: 50, text: 'after the cut' },
    ]);
  });

  it('drops a line that was entirely cut out, so search stops matching it', () => {
    const out = retimeSegments([{ start: 35, end: 55, text: 'gone entirely' }], RANGES);
    expect(out).toHaveLength(0);
  });

  it('clips a line that straddles a cut down to the part that survived', () => {
    const out = retimeSegments([{ start: 25, end: 45, text: 'straddles' }], RANGES);
    expect(out).toEqual([{ start: 25, end: 30, text: 'straddles' }]);
  });

  it('returns segments in ascending order', () => {
    const out = retimeSegments(
      [
        { start: 70, end: 80, text: 'later' },
        { start: 5, end: 10, text: 'earlier' },
      ],
      RANGES
    );
    expect(out.map((s) => s.text)).toEqual(['earlier', 'later']);
  });

  it('is a no-op when nothing was removed', () => {
    const segs = [{ start: 5, end: 10, text: 'unchanged' }];
    expect(retimeSegments(segs, [{ start: 0, end: 100 }])).toEqual(segs);
  });
});
