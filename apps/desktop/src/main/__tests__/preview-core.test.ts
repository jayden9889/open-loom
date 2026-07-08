/**
 * Preview generation must be best-effort: a thumbnail / gif / waveform failure
 * (e.g. a waveform OOM on a long recording) must never throw out of the caller
 * and trigger the cleanup that deletes the already-valid video (data loss).
 */
import { describe, expect, it, vi } from 'vitest';
import { generatePreviews } from '../preview-core';

describe('generatePreviews', () => {
  it('runs every step and never throws when one step fails', async () => {
    const thumbnail = vi.fn().mockResolvedValue(undefined);
    const gif = vi.fn().mockResolvedValue(undefined);
    // A deterministic waveform failure that, before the fix, propagated and
    // caused the caller to delete the good recording.
    const waveform = vi.fn().mockRejectedValue(new Error('waveform OOM'));
    const warn = vi.fn();

    await expect(generatePreviews({ thumbnail, gif, waveform, warn })).resolves.toBeUndefined();

    // The failing step does not abort the others.
    expect(thumbnail).toHaveBeenCalledTimes(1);
    expect(gif).toHaveBeenCalledTimes(1);
    expect(waveform).toHaveBeenCalledTimes(1);
    // The failure is logged, not thrown.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('waveform');
  });

  it('isolates each step so an early failure does not skip later ones', async () => {
    const order: string[] = [];
    await generatePreviews({
      thumbnail: () => {
        order.push('thumb');
        return Promise.reject(new Error('thumb fail'));
      },
      gif: () => {
        order.push('gif');
        return Promise.resolve();
      },
      waveform: () => {
        order.push('waveform');
        return Promise.resolve();
      },
      warn: () => undefined,
    });
    expect(order).toEqual(['thumb', 'gif', 'waveform']);
  });
});
