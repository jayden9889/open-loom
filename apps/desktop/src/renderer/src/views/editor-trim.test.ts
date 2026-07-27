/**
 * Trim handles must move both ways. Cutting straight from the current segments
 * made every drag additive: an already-removed head was only ever split, never
 * shrunk, so dragging a handle back to widen the keep-range - or nudging it with
 * an arrow key - did nothing. These cover the restore-then-cut behaviour and
 * prove interior cuts from split/remove survive a handle drag.
 */
import { describe, expect, it } from 'vitest';
import { mergeAdjacent, restoreEdgeRun } from './Editor';

interface Seg {
  start: number;
  end: number;
  kept: boolean;
}

const keptStart = (segs: Seg[]): number => segs.find((s) => s.kept)?.start ?? 0;
const keptEnd = (segs: Seg[]): number => [...segs].reverse().find((s) => s.kept)?.end ?? 0;

describe('restoreEdgeRun', () => {
  it('restores a trimmed head so the in-handle can be dragged back out', () => {
    const trimmedTo20: Seg[] = [
      { start: 0, end: 20, kept: false },
      { start: 20, end: 100, kept: true },
    ];
    expect(keptStart(trimmedTo20)).toBe(20);
    expect(keptStart(restoreEdgeRun(trimmedTo20, 'in'))).toBe(0);
  });

  it('restores a trimmed tail for the out-handle', () => {
    const trimmedTo60: Seg[] = [
      { start: 0, end: 60, kept: true },
      { start: 60, end: 100, kept: false },
    ];
    expect(keptEnd(trimmedTo60)).toBe(60);
    expect(keptEnd(restoreEdgeRun(trimmedTo60, 'out'))).toBe(100);
  });

  it('leaves an interior removed section alone', () => {
    const middleCut: Seg[] = [
      { start: 0, end: 10, kept: false },
      { start: 10, end: 40, kept: true },
      { start: 40, end: 50, kept: false }, // removed by split/remove, not the handle
      { start: 50, end: 100, kept: true },
    ];
    const restored = restoreEdgeRun(middleCut, 'in');
    expect(restored[0]!.kept).toBe(true);
    expect(restored[2]!.kept).toBe(false);
  });

  it('does not walk past the first kept segment from either edge', () => {
    const both: Seg[] = [
      { start: 0, end: 10, kept: false },
      { start: 10, end: 90, kept: true },
      { start: 90, end: 100, kept: false },
    ];
    expect(restoreEdgeRun(both, 'in')[2]!.kept).toBe(false);
    expect(restoreEdgeRun(both, 'out')[0]!.kept).toBe(false);
  });
});

describe('mergeAdjacent', () => {
  it('collapses touching segments with the same kept state', () => {
    const fragmented: Seg[] = [
      { start: 0, end: 5, kept: false },
      { start: 5, end: 20, kept: false },
      { start: 20, end: 100, kept: true },
    ];
    expect(mergeAdjacent(fragmented)).toEqual([
      { start: 0, end: 20, kept: false },
      { start: 20, end: 100, kept: true },
    ]);
  });

  it('keeps a boundary where the kept state changes', () => {
    const alternating: Seg[] = [
      { start: 0, end: 10, kept: true },
      { start: 10, end: 20, kept: false },
      { start: 20, end: 30, kept: true },
    ];
    expect(mergeAdjacent(alternating)).toHaveLength(3);
  });
});
