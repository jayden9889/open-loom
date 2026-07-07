/**
 * Editor core tests (SPEC E1-E3) against real generated sample videos:
 * range validation, keyframe planning, lossless-copy vs precise re-encode
 * trims, delete-middle, and stitching (fast concat + normalising re-encode),
 * all verified with ffprobe durations.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe, resolveBinaries, type FfmpegBinaries } from '../ffmpeg-core';
import {
  KEYFRAME_TOLERANCE_SEC,
  keyframeTimes,
  normalizeRanges,
  planTrim,
  stitchVideoFiles,
  trimVideoFile,
} from '../editor-core';

let bins: FfmpegBinaries;
let work: string;
/** 6s 640x360@30 H.264+AAC, keyframes forced every 2s. */
let sampleA: string;
/** 4s clip with identical codec parameters to sampleA. */
let sampleB: string;
/** 3s 320x240@25, video only (no audio stream). */
let sampleOdd: string;

function makeClip(out: string, opts: { dur: number; size: string; fps: number; audio: boolean; gop: number }): void {
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  args.push('-f', 'lavfi', '-i', `testsrc2=size=${opts.size}:rate=${opts.fps}:duration=${opts.dur}`);
  if (opts.audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${opts.dur}`);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', String(opts.gop), '-keyint_min', String(opts.gop));
  if (opts.audio) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-movflags', '+faststart', out);
  execFileSync(bins.ffmpeg, args, { stdio: 'pipe' });
}

beforeAll(() => {
  const resolved = resolveBinaries('', path.join(os.tmpdir(), 'nonexistent-bin-dir'));
  if (!resolved) throw new Error('ffmpeg/ffprobe not found on PATH; tests require them');
  bins = resolved;
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-editor-test-'));
  sampleA = path.join(work, 'a.mp4');
  sampleB = path.join(work, 'b.mp4');
  sampleOdd = path.join(work, 'odd.mp4');
  makeClip(sampleA, { dur: 6, size: '640x360', fps: 30, audio: true, gop: 60 });
  makeClip(sampleB, { dur: 4, size: '640x360', fps: 30, audio: true, gop: 60 });
  makeClip(sampleOdd, { dur: 3, size: '320x240', fps: 25, audio: false, gop: 50 });
});

describe('normalizeRanges', () => {
  it('sorts, clamps and drops empty ranges', () => {
    const out = normalizeRanges(
      [
        { start: 4, end: 99 },
        { start: -2, end: 1.5 },
        { start: 2, end: 2.01 },
      ],
      6
    );
    expect(out).toEqual([
      { start: 0, end: 1.5 },
      { start: 4, end: 6 },
    ]);
  });

  it('rejects overlapping ranges', () => {
    expect(() => normalizeRanges([{ start: 0, end: 3 }, { start: 2, end: 5 }], 6)).toThrow(/overlap/i);
  });

  it('rejects an empty edit', () => {
    expect(() => normalizeRanges([{ start: 2, end: 2 }], 6)).toThrow(/whole video/);
  });
});

describe('keyframes + planning', () => {
  it('finds the forced 2s keyframe cadence', async () => {
    const kf = await keyframeTimes(bins, sampleA);
    expect(kf.length).toBeGreaterThanOrEqual(3);
    expect(kf[0]).toBeCloseTo(0, 1);
    expect(kf.some((t) => Math.abs(t - 2) < 0.1)).toBe(true);
    expect(kf.some((t) => Math.abs(t - 4) < 0.1)).toBe(true);
  });

  it('chooses copy when starts sit on keyframes, re-encode otherwise', () => {
    const kf = [0, 2, 4];
    expect(planTrim([{ start: 0.01, end: 3 }], kf).method).toBe('copy');
    expect(planTrim([{ start: 2, end: 5 }], kf).method).toBe('copy');
    expect(planTrim([{ start: 1, end: 3 }], kf).method).toBe('reencode');
    expect(planTrim([{ start: 0, end: 2 }, { start: 3, end: 5 }], kf).method).toBe('reencode');
    // Snapped starts land exactly on the keyframe.
    const plan = planTrim([{ start: 2 + KEYFRAME_TOLERANCE_SEC / 2, end: 5 }], kf);
    expect(plan.method).toBe('copy');
    expect(plan.snapped[0]!.start).toBe(2);
  });
});

describe('trimVideoFile', () => {
  it('trims on a keyframe with lossless stream copy', async () => {
    const out = path.join(work, 'trim-copy.mp4');
    const result = await trimVideoFile(bins, sampleA, out, [{ start: 2, end: 5 }]);
    expect(result.method).toBe('copy');
    const info = await probe(bins, out);
    expect(info.durationSec).toBeGreaterThan(2.6);
    expect(info.durationSec).toBeLessThan(3.4);
    expect(info.videoCodec).toBe('h264');
  });

  it('trims off-keyframe with a precise re-encode', async () => {
    const out = path.join(work, 'trim-precise.mp4');
    const notes: string[] = [];
    const result = await trimVideoFile(bins, sampleA, out, [{ start: 1.25, end: 3.25 }], (_pct, note) => {
      if (note) notes.push(note);
    });
    expect(result.method).toBe('reencode');
    expect(notes.some((n) => /re-encode/i.test(n))).toBe(true);
    const info = await probe(bins, out);
    expect(info.durationSec).toBeGreaterThan(1.85);
    expect(info.durationSec).toBeLessThan(2.15);
  });

  it('removes a middle section (two kept ranges)', async () => {
    const out = path.join(work, 'trim-middle.mp4');
    const result = await trimVideoFile(bins, sampleA, out, [
      { start: 0, end: 1.5 },
      { start: 4.5, end: 6 },
    ]);
    const info = await probe(bins, out);
    // 6s minus the removed 3s middle = ~3s.
    expect(info.durationSec).toBeGreaterThan(2.6);
    expect(info.durationSec).toBeLessThan(3.4);
    expect(['copy', 'reencode']).toContain(result.method);
  });

  it('multi-range copy path concatenates keyframe-aligned segments', async () => {
    const out = path.join(work, 'trim-copy-multi.mp4');
    const result = await trimVideoFile(bins, sampleA, out, [
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]);
    expect(result.method).toBe('copy');
    const info = await probe(bins, out);
    expect(info.durationSec).toBeGreaterThan(3.5);
    expect(info.durationSec).toBeLessThan(4.5);
  });
});

describe('stitchVideoFiles', () => {
  it('joins same-codec clips losslessly', async () => {
    const out = path.join(work, 'stitch-copy.mp4');
    const result = await stitchVideoFiles(bins, sampleA, sampleB, out);
    expect(result.method).toBe('copy');
    const info = await probe(bins, out);
    expect(info.durationSec).toBeGreaterThan(9.4);
    expect(info.durationSec).toBeLessThan(10.6);
    expect(info.width).toBe(640);
  });

  it('re-encodes mismatched clips (resolution/fps/audio-less) into one seekable file', async () => {
    const out = path.join(work, 'stitch-reencode.mp4');
    const result = await stitchVideoFiles(bins, sampleA, sampleOdd, out);
    expect(result.method).toBe('reencode');
    const info = await probe(bins, out);
    expect(info.durationSec).toBeGreaterThan(8.4);
    expect(info.durationSec).toBeLessThan(9.6);
    // Output keeps the main clip's frame size and gains a continuous audio track.
    expect(info.width).toBe(640);
    expect(info.height).toBe(360);
    expect(info.audioCodec).toBe('aac');
  });
});
