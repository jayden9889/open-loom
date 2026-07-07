/**
 * Editor core (SPEC E1-E3): keep-range trims (covers trim + delete-middle)
 * and stitching, implemented as pure ffmpeg operations against injected
 * binaries so they are unit-testable. Chooses stream-copy automatically when
 * every cut start sits on a keyframe (lossless + instant) and falls back to a
 * precise re-encode otherwise; callers surface which method ran in the UI.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe, type FfmpegBinaries, type ProbeResult } from './ffmpeg-core';

export interface KeepRange {
  start: number;
  end: number;
}

export type EditMethod = 'copy' | 'reencode';

/** Keyframe snap tolerance in seconds for choosing lossless stream copy. */
export const KEYFRAME_TOLERANCE_SEC = 0.15;

// ---------------------------------------------------------------------------
// Shared ffmpeg runner (progress via -progress pipe:1)
// ---------------------------------------------------------------------------

function runFfmpeg(
  bin: string,
  args: string[],
  onProgressSec?: (sec: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    let lineBuf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString('utf8');
      let idx: number;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && onProgressSec) onProgressSec(Number(m[1]) / 1_000_000);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (err) => reject(new Error(`Failed to run ffmpeg: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderrTail.trim().slice(-600)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Range validation
// ---------------------------------------------------------------------------

/** Sort, clamp to the duration, drop empty ranges and reject overlaps. */
export function normalizeRanges(ranges: KeepRange[], durationSec: number): KeepRange[] {
  const cleaned = ranges
    .map((r) => ({
      start: Math.max(0, Math.min(r.start, durationSec)),
      end: Math.max(0, Math.min(r.end, durationSec)),
    }))
    .filter((r) => r.end - r.start > 0.05)
    .sort((a, b) => a.start - b.start);
  if (cleaned.length === 0) {
    throw new Error('The edit would remove the whole video. Keep at least a fraction of a second.');
  }
  for (let i = 1; i < cleaned.length; i++) {
    if (cleaned[i]!.start < cleaned[i - 1]!.end) {
      throw new Error('Edit sections overlap. Adjust the cut points and try again.');
    }
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Keyframes + method choice
// ---------------------------------------------------------------------------

/** Video keyframe timestamps in seconds, ascending. */
export async function keyframeTimes(bins: FfmpegBinaries, file: string): Promise<number[]> {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags',
    '-of', 'csv=p=0',
    file,
  ];
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(bins.ffprobe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (err = (err + c.toString('utf8')).slice(-2000)));
    child.on('error', (e) => reject(new Error(`Failed to run ffprobe: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(`ffprobe exited with code ${code}: ${err.trim()}`));
    });
  });
  const times: number[] = [];
  for (const line of out.split('\n')) {
    const [pts, flags] = line.trim().split(',');
    if (!pts || !flags) continue;
    if (flags.includes('K')) {
      const t = Number(pts);
      if (Number.isFinite(t)) times.push(t);
    }
  }
  return times.sort((a, b) => a - b);
}

function nearestKeyframe(keyframes: number[], t: number): number | null {
  let best: number | null = null;
  for (const k of keyframes) {
    if (best === null || Math.abs(k - t) < Math.abs(best - t)) best = k;
  }
  return best;
}

/**
 * Stream copy is lossless but can only start segments on keyframes. Choose it
 * when every kept-range start is within tolerance of one (snapping starts),
 * otherwise re-encode for frame-precise cuts.
 */
export function planTrim(
  ranges: KeepRange[],
  keyframes: number[]
): { method: EditMethod; snapped: KeepRange[] } {
  if (keyframes.length === 0) return { method: 'reencode', snapped: ranges };
  const snapped: KeepRange[] = [];
  for (const r of ranges) {
    const k = nearestKeyframe(keyframes, r.start);
    if (k === null || Math.abs(k - r.start) > KEYFRAME_TOLERANCE_SEC || k >= r.end) {
      return { method: 'reencode', snapped: ranges };
    }
    snapped.push({ start: k, end: r.end });
  }
  return { method: 'copy', snapped };
}

// ---------------------------------------------------------------------------
// Trim (keep-ranges: covers E1 trim and E2 delete-middle)
// ---------------------------------------------------------------------------

export interface TrimResult {
  method: EditMethod;
  durationSec: number;
}

export async function trimVideoFile(
  bins: FfmpegBinaries,
  input: string,
  output: string,
  rawRanges: KeepRange[],
  onProgress?: (pct: number, note?: string) => void
): Promise<TrimResult> {
  const info = await probe(bins, input);
  const ranges = normalizeRanges(rawRanges, info.durationSec);
  const keyframes = await keyframeTimes(bins, input).catch(() => [] as number[]);
  const { method, snapped } = planTrim(ranges, keyframes);
  const note = method === 'copy' ? 'Fast lossless cut' : 'Precise re-encode';
  onProgress?.(5, note);

  if (method === 'copy') {
    await trimByCopy(bins, input, output, snapped, (pct) => onProgress?.(pct, note));
  } else {
    await trimByReencode(bins, input, output, ranges, info, (pct) => onProgress?.(pct, note));
  }
  const outInfo = await probe(bins, output);
  onProgress?.(100, note);
  return { method, durationSec: outInfo.durationSec };
}

async function trimByCopy(
  bins: FfmpegBinaries,
  input: string,
  output: string,
  ranges: KeepRange[],
  onProgress: (pct: number) => void
): Promise<void> {
  if (ranges.length === 1) {
    const r = ranges[0]!;
    await runFfmpeg(bins.ffmpeg, [
      '-y',
      '-ss', r.start.toFixed(3),
      '-i', input,
      '-t', (r.end - r.start).toFixed(3),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      output,
    ]);
    onProgress(95);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-edit-'));
  try {
    const parts: string[] = [];
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]!;
      const part = path.join(work, `part-${i}.mp4`);
      await runFfmpeg(bins.ffmpeg, [
        '-y',
        '-ss', r.start.toFixed(3),
        '-i', input,
        '-t', (r.end - r.start).toFixed(3),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        part,
      ]);
      parts.push(part);
      onProgress(5 + Math.round(((i + 1) / (ranges.length + 1)) * 85));
    }
    await concatDemux(bins, parts, output);
    onProgress(95);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function trimByReencode(
  bins: FfmpegBinaries,
  input: string,
  output: string,
  ranges: KeepRange[],
  info: ProbeResult,
  onProgress: (pct: number) => void
): Promise<void> {
  const hasAudio = info.audioCodec !== null;
  const parts: string[] = [];
  const labels: string[] = [];
  ranges.forEach((r, i) => {
    parts.push(`[0:v]trim=start=${r.start.toFixed(3)}:end=${r.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    labels.push(`[v${i}]`);
    if (hasAudio) {
      parts.push(`[0:a]atrim=start=${r.start.toFixed(3)}:end=${r.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
      labels[labels.length - 1] += `[a${i}]`;
    }
  });
  const concat = `${labels.join('')}concat=n=${ranges.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`;
  const filter = [...parts, concat].join(';');

  const total = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  const args = [
    '-y',
    '-i', input,
    '-filter_complex', filter,
    '-map', '[v]',
    ...(hasAudio ? ['-map', '[a]'] : []),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '21',
    '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    output,
  ];
  await runFfmpeg(bins.ffmpeg, args, (sec) => {
    if (total > 0) onProgress(5 + Math.min(90, Math.round((sec / total) * 90)));
  });
}

async function concatDemux(bins: FfmpegBinaries, parts: string[], output: string): Promise<void> {
  const listFile = path.join(path.dirname(parts[0]!), 'concat.txt');
  const escape = (p: string) => p.replace(/'/g, "'\\''");
  fs.writeFileSync(listFile, parts.map((p) => `file '${escape(p)}'`).join('\n'));
  await runFfmpeg(bins.ffmpeg, [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    '-movflags', '+faststart',
    output,
  ]);
}

// ---------------------------------------------------------------------------
// Stitch (E3: append another video)
// ---------------------------------------------------------------------------

export interface StitchResult {
  method: EditMethod;
  durationSec: number;
}

function sameCodecFamily(a: ProbeResult, b: ProbeResult): boolean {
  return (
    a.videoCodec === 'h264' &&
    b.videoCodec === 'h264' &&
    a.width === b.width &&
    a.height === b.height &&
    Math.abs(a.fps - b.fps) < 0.5 &&
    ((a.audioCodec === 'aac' && b.audioCodec === 'aac') || (a.audioCodec === null && b.audioCodec === null))
  );
}

export async function stitchVideoFiles(
  bins: FfmpegBinaries,
  mainFile: string,
  appendFile: string,
  output: string,
  onProgress?: (pct: number, note?: string) => void
): Promise<StitchResult> {
  const mainInfo = await probe(bins, mainFile);
  const appendInfo = await probe(bins, appendFile);
  const expected = mainInfo.durationSec + appendInfo.durationSec;

  if (sameCodecFamily(mainInfo, appendInfo)) {
    onProgress?.(10, 'Fast lossless join');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-stitch-'));
    try {
      await concatDemux(bins, [mainFile, appendFile], output);
      const outInfo = await probe(bins, output);
      // Guard against silent stream-parameter mismatches: fall back if the
      // joined duration is off by more than a second.
      if (Math.abs(outInfo.durationSec - expected) <= 1) {
        onProgress?.(100, 'Fast lossless join');
        return { method: 'copy', durationSec: outInfo.durationSec };
      }
    } catch {
      // fall through to re-encode
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  onProgress?.(10, 'Re-encoding to match formats');
  await stitchByReencode(bins, mainFile, appendFile, output, mainInfo, appendInfo, (pct) =>
    onProgress?.(pct, 'Re-encoding to match formats')
  );
  const outInfo = await probe(bins, output);
  onProgress?.(100, 'Re-encoding to match formats');
  return { method: 'reencode', durationSec: outInfo.durationSec };
}

async function stitchByReencode(
  bins: FfmpegBinaries,
  mainFile: string,
  appendFile: string,
  output: string,
  mainInfo: ProbeResult,
  appendInfo: ProbeResult,
  onProgress: (pct: number) => void
): Promise<void> {
  const W = mainInfo.width || 1920;
  const H = mainInfo.height || 1080;
  const F = Math.round(mainInfo.fps) || 30;
  const anyAudio = mainInfo.audioCodec !== null || appendInfo.audioCodec !== null;

  const args: string[] = ['-y', '-i', mainFile, '-i', appendFile];
  const filters: string[] = [];
  const infos = [mainInfo, appendInfo];
  let lavfiIndex = 2;
  const audioLabels: string[] = [];

  infos.forEach((info, i) => {
    filters.push(
      `[${i}:v]fps=${F},scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`
    );
    if (anyAudio) {
      if (info.audioCodec !== null) {
        filters.push(`[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      } else {
        args.push('-f', 'lavfi', '-t', Math.max(0.1, info.durationSec).toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
        filters.push(`[${lavfiIndex}:a]anull[a${i}]`);
        lavfiIndex++;
      }
      audioLabels.push(`[a${i}]`);
    }
  });

  const pairs = anyAudio ? `[v0][a0][v1][a1]` : `[v0][v1]`;
  filters.push(`${pairs}concat=n=2:v=1:a=${anyAudio ? 1 : 0}[v]${anyAudio ? '[a]' : ''}`);

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    ...(anyAudio ? ['-map', '[a]'] : []),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '21',
    '-pix_fmt', 'yuv420p',
    ...(anyAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    output
  );

  const total = mainInfo.durationSec + appendInfo.durationSec;
  await runFfmpeg(bins.ffmpeg, args, (sec) => {
    if (total > 0) onProgress(10 + Math.min(85, Math.round((sec / total) * 85)));
  });
}
