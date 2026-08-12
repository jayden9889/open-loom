/**
 * The waveform is what a user reads to find their words, so it has to follow
 * speech rather than transients. These pin the three properties that make that
 * true: energy not peaks, a perceptual scale, and resolution that survives a
 * long recording.
 */
import { describe, expect, it } from 'vitest';
import {
  amplitudeToDisplay,
  smoothEnvelope,
  waveformBucketCount,
  WAVEFORM_VERSION,
} from '../ffmpeg-core';

describe('amplitudeToDisplay', () => {
  it('puts silence at the floor and full scale at the top', () => {
    expect(amplitudeToDisplay(0)).toBe(0);
    expect(amplitudeToDisplay(1)).toBeCloseTo(1, 5);
  });

  it('never returns a negative height for sub-floor audio', () => {
    // -60 dBFS is the floor; anything quieter must clamp, not go negative.
    expect(amplitudeToDisplay(0.0001)).toBe(0);
  });

  it('gives ordinary speech most of the range, which linear amplitude does not', () => {
    // Conversational speech sits around -20 dBFS (0.1 linear). On a raw linear
    // scale that is 10% of the height, which is why the old bar looked flat.
    const speech = amplitudeToDisplay(0.1);
    expect(speech).toBeGreaterThan(0.6);
    expect(speech).toBeLessThan(0.75);
  });

  it('rises monotonically with amplitude', () => {
    const steps = [0.01, 0.05, 0.1, 0.3, 0.6, 1].map(amplitudeToDisplay);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!).toBeGreaterThan(steps[i - 1]!);
    }
  });
});

describe('smoothEnvelope', () => {
  it('flattens a lone transient instead of letting it define the shape', () => {
    // One spike in an otherwise quiet passage: a chair creak, a plosive, a click.
    const spiky = [0, 0, 1, 0, 0];
    const smooth = smoothEnvelope(spiky);
    expect(smooth[2]!).toBeLessThan(1);
    // Its energy spreads to the neighbours rather than vanishing.
    expect(smooth[1]!).toBeGreaterThan(0);
    expect(smooth[3]!).toBeGreaterThan(0);
  });

  it('leaves a steady passage alone', () => {
    expect(smoothEnvelope([0.5, 0.5, 0.5, 0.5])).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('handles the empty and single-bucket cases', () => {
    expect(smoothEnvelope([])).toEqual([]);
    expect(smoothEnvelope([0.4])).toEqual([0.4]);
  });
});

describe('waveformBucketCount', () => {
  it('scales with duration so a long take does not go blocky', () => {
    expect(waveformBucketCount(600)).toBeGreaterThan(waveformBucketCount(60));
  });

  it('clamps at both ends', () => {
    // A very short clip still gets enough buckets to look like a waveform.
    expect(waveformBucketCount(1)).toBe(240);
    // A very long one stays bounded so the payload cannot run away.
    expect(waveformBucketCount(100_000)).toBe(6000);
  });

  it('survives a zero or missing duration', () => {
    expect(waveformBucketCount(0)).toBe(240);
  });
});

describe('WAVEFORM_VERSION', () => {
  it('is ahead of the unversioned peak-max format so old files regenerate', () => {
    expect(WAVEFORM_VERSION).toBeGreaterThan(1);
  });
});
