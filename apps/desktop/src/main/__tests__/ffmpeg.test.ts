/**
 * ffmpeg wrapper tests against a real generated sample video
 * (scripts/make-sample-video.sh: 5s 1080p testsrc2 + sine).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canRemux,
  gifPreview,
  probe,
  remux,
  resolveBinaries,
  thumbnail,
  transcodeH264,
  waveformPeaks,
  type FfmpegBinaries,
} from '../ffmpeg-core';

const repoRoot = path.resolve(__dirname, '../../../../..');
let bins: FfmpegBinaries;
let work: string;
let sample: string;

beforeAll(() => {
  const resolved = resolveBinaries('', path.join(os.tmpdir(), 'nonexistent-bin-dir'));
  if (!resolved) throw new Error('ffmpeg/ffprobe not found on PATH; tests require them');
  bins = resolved;
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-ffmpeg-test-'));
  sample = path.join(work, 'sample.mp4');
  execFileSync('bash', [path.join(repoRoot, 'scripts/make-sample-video.sh'), sample], {
    stdio: 'pipe',
  });
});

describe('resolveBinaries', () => {
  it('returns null when nothing is available', () => {
    const old = process.env.PATH;
    process.env.PATH = '/definitely/not/a/dir';
    try {
      expect(resolveBinaries('', path.join(os.tmpdir(), 'nope'))).toBeNull();
    } finally {
      process.env.PATH = old;
    }
  });

  it('prefers a configured path when its sibling ffprobe exists', () => {
    const configured = resolveBinaries(bins.ffmpeg, path.join(os.tmpdir(), 'nope'));
    expect(configured?.ffmpeg).toBe(bins.ffmpeg);
  });
});

describe('probe', () => {
  it('reads duration, dimensions, fps and codecs', async () => {
    const info = await probe(bins, sample);
    expect(info.durationSec).toBeGreaterThan(4.5);
    expect(info.durationSec).toBeLessThan(5.5);
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(Math.round(info.fps)).toBe(30);
    expect(info.videoCodec).toBe('h264');
    expect(info.audioCodec).toBe('aac');
    expect(info.sizeBytes).toBeGreaterThan(1000);
    expect(canRemux(info)).toBe(true);
  });
});

describe('remux', () => {
  it('stream-copies to a seekable mp4', async () => {
    const out = path.join(work, 'remuxed.mp4');
    await remux(bins, sample, out);
    const info = await probe(bins, out);
    expect(info.durationSec).toBeGreaterThan(4.5);
    expect(info.videoCodec).toBe('h264');
  });
});

describe('transcodeH264', () => {
  it('re-encodes with progress callbacks', async () => {
    const out = path.join(work, 'transcoded.mp4');
    const seen: number[] = [];
    await transcodeH264(bins, sample, out, {
      expectedDurationSec: 5,
      onProgress: (pct) => seen.push(pct),
    });
    const info = await probe(bins, out);
    expect(info.videoCodec).toBe('h264');
    expect(info.durationSec).toBeGreaterThan(4.5);
    expect(seen[seen.length - 1]).toBe(100);
  });
});

describe('thumbnail', () => {
  it('writes a jpg frame', async () => {
    const out = path.join(work, 'thumb.jpg');
    await thumbnail(bins, sample, out, 1.25);
    expect(fs.existsSync(out)).toBe(true);
    // JPEG magic bytes
    const head = fs.readFileSync(out).subarray(0, 2);
    expect(head[0]).toBe(0xff);
    expect(head[1]).toBe(0xd8);
  });
});

describe('gifPreview', () => {
  it('writes an animated gif of the first seconds', async () => {
    const out = path.join(work, 'preview.gif');
    await gifPreview(bins, sample, out);
    const buf = fs.readFileSync(out);
    expect(buf.subarray(0, 6).toString('ascii')).toMatch(/^GIF8[79]a$/);
    expect(buf.length).toBeGreaterThan(5000);
  });
});

describe('waveformPeaks', () => {
  it('computes normalised peaks and writes json', async () => {
    const out = path.join(work, 'waveform.json');
    const data = await waveformPeaks(bins, sample, out, 200);
    expect(data.peaks.length).toBe(200);
    expect(Math.max(...data.peaks)).toBeGreaterThan(0.1);
    expect(Math.max(...data.peaks)).toBeLessThanOrEqual(1);
    const onDisk = JSON.parse(fs.readFileSync(out, 'utf8')) as { peaks: number[] };
    expect(onDisk.peaks.length).toBe(200);
  });

  it('handles videos without audio', async () => {
    const silent = path.join(work, 'silent.mp4');
    execFileSync(bins.ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent,
    ]);
    const out = path.join(work, 'silent-waveform.json');
    const data = await waveformPeaks(bins, silent, out);
    expect(data.peaks).toEqual([]);
  });
});
