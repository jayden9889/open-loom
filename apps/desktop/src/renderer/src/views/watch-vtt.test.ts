/**
 * The player's WebVTT parser, fed real buildVtt output. Guards the bug where
 * the end timestamp was split before being trimmed: WebVTT writes ' --> ', so
 * endRaw leads with a space, `''` came back from the split, `?? endRaw` did not
 * catch it (empty string is not nullish) and every cue got end: NaN. Captions
 * and transcript highlighting both compare `current <= cue.end`, which is
 * always false against NaN, so both silently did nothing.
 */
import { describe, expect, it } from 'vitest';
import { buildVtt } from '../../../main/transcribe-core';
import { parseVtt } from './Watch';

const SEGMENTS = [
  { start: 0, end: 2.5, text: 'First line spoken.' },
  { start: 2.5, end: 6.25, text: 'Second line spoken.' },
];

describe('parseVtt against real buildVtt output', () => {
  it('parses finite start and end times for every cue', () => {
    const cues = parseVtt(buildVtt(SEGMENTS));
    expect(cues).toHaveLength(2);
    for (const c of cues) {
      expect(Number.isFinite(c.start)).toBe(true);
      expect(Number.isFinite(c.end)).toBe(true);
    }
  });

  it('round-trips the exact timings', () => {
    const cues = parseVtt(buildVtt(SEGMENTS));
    expect(cues[0]).toMatchObject({ start: 0, end: 2.5, text: 'First line spoken.' });
    expect(cues[1]).toMatchObject({ start: 2.5, end: 6.25, text: 'Second line spoken.' });
  });

  it('resolves an active cue mid-playback (the check captions actually run)', () => {
    const cues = parseVtt(buildVtt(SEGMENTS));
    const activeAt = (t: number) => cues.find((c) => t >= c.start && t <= c.end) ?? null;
    expect(activeAt(1)?.text).toBe('First line spoken.');
    expect(activeAt(4)?.text).toBe('Second line spoken.');
    expect(activeAt(99)).toBeNull();
  });
});
