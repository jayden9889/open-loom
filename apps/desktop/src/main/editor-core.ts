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

/** Thrown when an edit job is cancelled; callers surface it as info, not failure. */
export class EditCancelledError extends Error {
  constructor() {
    super('The edit was cancelled.');
    this.name = 'EditCancelledError';
  }
}

function runFfmpeg(
  bin: string,
  args: string[],
  onProgressSec?: (sec: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EditCancelledError());
      return;
    }
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    let lineBuf = '';
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
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
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Failed to run ffmpeg: ${err.message}`));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new EditCancelledError());
      else if (code === 0) resolve();
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
  onProgress?: (pct: number, note?: string) => void,
  signal?: AbortSignal
): Promise<TrimResult> {
  const info = await probe(bins, input);
  const ranges = normalizeRanges(rawRanges, info.durationSec);
  const keyframes = await keyframeTimes(bins, input).catch(() => [] as number[]);
  const { method, snapped } = planTrim(ranges, keyframes);
  const note = method === 'copy' ? 'Fast lossless cut' : 'Precise re-encode';
  onProgress?.(5, note);

  if (method === 'copy') {
    await trimByCopy(bins, input, output, snapped, (pct) => onProgress?.(pct, note), signal);
  } else {
    await trimByReencode(bins, input, output, ranges, info, (pct) => onProgress?.(pct, note), signal);
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
  onProgress: (pct: number) => void,
  signal?: AbortSignal
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
    ], undefined, signal);
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
      ], undefined, signal);
      parts.push(part);
      onProgress(5 + Math.round(((i + 1) / (ranges.length + 1)) * 85));
    }
    await concatDemux(bins, parts, output, work, signal);
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
  onProgress: (pct: number) => void,
  signal?: AbortSignal
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
  }, signal);
}

/**
 * Concat-copy `parts` into `output`. The list file goes into `listDir`, which
 * must be a temp dir owned by the caller: writing it next to the parts left a
 * stray concat.txt in the user's library folder on the stitch path.
 */
async function concatDemux(
  bins: FfmpegBinaries,
  parts: string[],
  output: string,
  listDir: string,
  signal?: AbortSignal
): Promise<void> {
  const listFile = path.join(listDir, 'concat.txt');
  // The concat demuxer is line-based, so a newline in a path (legal on macOS,
  // and saveDir is user-chosen) would inject a second directive.
  for (const p of parts) {
    if (p.includes('\n') || p.includes('\r')) {
      throw new Error('That folder name contains a line break, which ffmpeg cannot process. Rename it and try again.');
    }
  }
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
  ], undefined, signal);
}

// ---------------------------------------------------------------------------
// Stitch (E3: append another video)
// ---------------------------------------------------------------------------

/**
 * 'copy' = both clips joined losslessly. 'append-reencode' = only the appended
 * clip was re-encoded to match; the main video's bytes are untouched.
 * 'reencode' = both clips went through the normalising encode.
 */
export type StitchMethod = EditMethod | 'append-reencode';

export interface StitchResult {
  method: StitchMethod;
  durationSec: number;
}

export interface StitchOptions {
  signal?: AbortSignal;
  /** Optional in/out points applied to the appended clip before the join. */
  appendRange?: KeepRange;
}

/**
 * Lossless concat is only safe when every stream parameter matches. Codec name,
 * frame size and fps alone are not enough: a sample-rate or channel-layout
 * mismatch concat-copies into a file whose audio plays at the wrong pitch or
 * drifts, and the duration guard cannot catch that.
 */
function sameCodecFamily(a: ProbeResult, b: ProbeResult): boolean {
  return (
    a.videoCodec === 'h264' &&
    b.videoCodec === 'h264' &&
    a.width === b.width &&
    a.height === b.height &&
    Math.abs(a.fps - b.fps) < 0.5 &&
    (a.videoPixFmt === b.videoPixFmt || !a.videoPixFmt || !b.videoPixFmt) &&
    ((a.audioCodec === 'aac' &&
      b.audioCodec === 'aac' &&
      a.audioSampleRate === b.audioSampleRate &&
      a.audioChannels === b.audioChannels) ||
      (a.audioCodec === null && b.audioCodec === null))
  );
}

/**
 * Whether the appended clip alone can be normalised to the main video's
 * parameters and then concat-copied, leaving the main video's bytes untouched.
 * Needs the main video to already be H.264 with AAC-or-no audio, and an audio
 * layout the encoder can reproduce. A silent main with a voiced append falls
 * to the full re-encode instead, so the appended clip's audio is not dropped.
 */
function canNormaliseAppendOnly(main: ProbeResult, append: ProbeResult): boolean {
  if (main.videoCodec !== 'h264') return false;
  if (main.audioCodec === null) return append.audioCodec === null;
  if (main.audioCodec !== 'aac') return false;
  const channels = main.audioChannels ?? 2;
  return channels === 1 || channels === 2;
}

/** libx264 -profile:v value matching the main video's reported profile, if any. */
function x264Profile(reported: string): string | null {
  if (/baseline/i.test(reported)) return 'baseline';
  if (/^main$/i.test(reported.trim())) return 'main';
  if (/^high$/i.test(reported.trim())) return 'high';
  return null;
}

export async function stitchVideoFiles(
  bins: FfmpegBinaries,
  mainFile: string,
  appendFile: string,
  output: string,
  onProgress?: (pct: number, note?: string) => void,
  opts: StitchOptions = {}
): Promise<StitchResult> {
  const { signal } = opts;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-stitch-'));
  try {
    let appendSrc = appendFile;
    if (opts.appendRange) {
      onProgress?.(3, 'Trimming the new clip');
      appendSrc = path.join(work, 'append-trimmed.mp4');
      await trimVideoFile(bins, appendFile, appendSrc, [opts.appendRange], undefined, signal);
    }

    const mainInfo = await probe(bins, mainFile);
    const appendInfo = await probe(bins, appendSrc);
    const expected = mainInfo.durationSec + appendInfo.durationSec;

    if (sameCodecFamily(mainInfo, appendInfo)) {
      onProgress?.(10, 'Fast lossless join');
      try {
        await concatDemux(bins, [mainFile, appendSrc], output, work, signal);
        const outInfo = await probe(bins, output);
        // Guard against silent stream-parameter mismatches: fall back if the
        // joined duration is off by more than a second.
        if (Math.abs(outInfo.durationSec - expected) <= 1) {
          onProgress?.(100, 'Fast lossless join');
          return { method: 'copy', durationSec: outInfo.durationSec };
        }
      } catch (err) {
        if (err instanceof EditCancelledError) throw err;
        // fall through to the normalising paths
      }
    }

    // Formats differ: normalise only the appended clip when possible, so the
    // main video is never re-encoded (no generation loss, and appending a short
    // clip to a long recording stays fast).
    if (canNormaliseAppendOnly(mainInfo, appendInfo)) {
      onProgress?.(15, 'Matching the new clip to this video');
      try {
        const matched = path.join(work, 'append-matched.mp4');
        await normaliseAppend(bins, appendSrc, matched, mainInfo, appendInfo, (pct) =>
          onProgress?.(15 + Math.round(pct * 0.6), 'Matching the new clip to this video'), signal
        );
        await concatDemux(bins, [mainFile, matched], output, work, signal);
        const outInfo = await probe(bins, output);
        if (Math.abs(outInfo.durationSec - expected) <= 1) {
          onProgress?.(100, 'Matching the new clip to this video');
          return { method: 'append-reencode', durationSec: outInfo.durationSec };
        }
      } catch (err) {
        if (err instanceof EditCancelledError) throw err;
        // fall through to the full re-encode
      }
    }

    onProgress?.(10, 'Re-encoding to match formats');
    await stitchByReencode(bins, mainFile, appendSrc, output, mainInfo, appendInfo, (pct) =>
      onProgress?.(pct, 'Re-encoding to match formats'), signal
    );
    const outInfo = await probe(bins, output);
    onProgress?.(100, 'Re-encoding to match formats');
    return { method: 'reencode', durationSec: outInfo.durationSec };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Re-encode only the appended clip to the main video's frame size, fps, pixel
 * format, profile and audio layout, so a plain concat-copy can follow.
 */
async function normaliseAppend(
  bins: FfmpegBinaries,
  appendFile: string,
  output: string,
  mainInfo: ProbeResult,
  appendInfo: ProbeResult,
  onProgress: (pct: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const W = mainInfo.width || 1920;
  const H = mainInfo.height || 1080;
  const F = Math.round(mainInfo.fps) || 30;
  const pixFmt = mainInfo.videoPixFmt || 'yuv420p';
  const args: string[] = ['-y', '-i', appendFile];
  const filters: string[] = [
    `[0:v]fps=${F},scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=${pixFmt}[v]`,
  ];

  const mainHasAudio = mainInfo.audioCodec !== null;
  if (mainHasAudio) {
    const rate = mainInfo.audioSampleRate ?? 48000;
    const layout = (mainInfo.audioChannels ?? 2) === 1 ? 'mono' : 'stereo';
    if (appendInfo.audioCodec !== null) {
      filters.push(`[0:a]aresample=${rate},aformat=sample_fmts=fltp:channel_layouts=${layout}[a]`);
    } else {
      args.push(
        '-f', 'lavfi',
        '-t', Math.max(0.1, appendInfo.durationSec).toFixed(3),
        '-i', `anullsrc=channel_layout=${layout}:sample_rate=${rate}`
      );
      filters.push(`[1:a]anull[a]`);
    }
  }

  const profile = x264Profile(mainInfo.videoProfile);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    ...(mainHasAudio ? ['-map', '[a]'] : []),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '21',
    ...(profile ? ['-profile:v', profile] : []),
    '-pix_fmt', pixFmt,
    ...(mainHasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    output
  );

  const total = appendInfo.durationSec;
  await runFfmpeg(bins.ffmpeg, args, (sec) => {
    if (total > 0) onProgress(Math.min(100, Math.round((sec / total) * 100)));
  }, signal);
}

async function stitchByReencode(
  bins: FfmpegBinaries,
  mainFile: string,
  appendFile: string,
  output: string,
  mainInfo: ProbeResult,
  appendInfo: ProbeResult,
  onProgress: (pct: number) => void,
  signal?: AbortSignal
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
  }, signal);
}
