/**
 * ffmpeg/ffprobe wrapper core. Pure Node (no Electron imports) so it is
 * unit-testable. Binary resolution order: configured path, system PATH,
 * then the app-support bin dir populated by scripts/fetch-ffmpeg.mjs.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
}

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  videoCodec: string;
  audioCodec: string | null;
}

const exeSuffix = process.platform === 'win32' ? '.exe' : '';

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Install dirs a Finder/Dock-launched app never sees: GUI processes inherit a
 * minimal PATH (no shell profile), so a Homebrew/pipx/MacPorts ffmpeg that
 * `which ffmpeg` finds in a terminal is invisible here without this list.
 */
function wellKnownDirs(): string[] {
  if (process.platform === 'win32') return [];
  return [
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
  ];
}

function findInPath(name: string, extraDirs: string[]): string | null {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), ...extraDirs];
  for (const dir of dirs) {
    const candidate = path.join(dir, name + exeSuffix);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve ffmpeg + ffprobe. `configuredFfmpegPath` (Settings.ffmpegPath) wins;
 * its sibling ffprobe is preferred. PATH is searched next (plus `extraDirs`,
 * defaulting to the well-known install dirs), then the app bin dir. Returns
 * null when either binary is missing.
 */
export function resolveBinaries(
  configuredFfmpegPath: string,
  appBinDir: string,
  extraDirs: string[] = wellKnownDirs()
): FfmpegBinaries | null {
  const candidates: { ffmpeg: string; ffprobe: string }[] = [];

  if (configuredFfmpegPath) {
    const dir = path.dirname(configuredFfmpegPath);
    candidates.push({
      ffmpeg: configuredFfmpegPath,
      ffprobe: path.join(dir, 'ffprobe' + exeSuffix),
    });
  }

  const pathFfmpeg = findInPath('ffmpeg', extraDirs);
  const pathFfprobe = findInPath('ffprobe', extraDirs);
  if (pathFfmpeg && pathFfprobe) candidates.push({ ffmpeg: pathFfmpeg, ffprobe: pathFfprobe });

  candidates.push({
    ffmpeg: path.join(appBinDir, 'ffmpeg' + exeSuffix),
    ffprobe: path.join(appBinDir, 'ffprobe' + exeSuffix),
  });

  for (const c of candidates) {
    if (isExecutable(c.ffmpeg) && isExecutable(c.ffprobe)) return c;
  }
  return null;
}

export interface RunOptions {
  onStderrLine?: (line: string) => void;
  onProgressSec?: (sec: number) => void;
  collectStdout?: boolean;
}

function run(bin: string, args: string[], opts: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    let stderrTail = '';
    let stdoutLineBuf = '';

    child.stdout.on('data', (chunk: Buffer) => {
      if (opts.collectStdout) {
        stdoutChunks.push(chunk);
        return;
      }
      // -progress pipe:1 emits key=value lines on stdout.
      stdoutLineBuf += chunk.toString('utf8');
      let idx: number;
      while ((idx = stdoutLineBuf.indexOf('\n')) >= 0) {
        const line = stdoutLineBuf.slice(0, idx).trim();
        stdoutLineBuf = stdoutLineBuf.slice(idx + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && opts.onProgressSec) opts.onProgressSec(Number(m[1]) / 1_000_000);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-4000);
      if (opts.onStderrLine) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) opts.onStderrLine(line.trim());
        }
      }
    });

    child.on('error', (err) => reject(new Error(`Failed to run ${path.basename(bin)}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdoutChunks));
      } else {
        reject(new Error(`${path.basename(bin)} exited with code ${code}: ${stderrTail.trim()}`));
      }
    });
  });
}

function parseFps(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split('/').map(Number);
  if (!num) return 0;
  if (!den) return num;
  return Math.round((num / den) * 100) / 100;
}

export async function probe(bins: FfmpegBinaries, file: string): Promise<ProbeResult> {
  const out = await run(
    bins.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { collectStdout: true }
  );
  const data = JSON.parse(out.toString('utf8')) as {
    format?: { duration?: string; size?: string };
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      duration?: string;
    }[];
  };
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const audio = data.streams?.find((s) => s.codec_type === 'audio');
  const durationSec =
    Number(data.format?.duration) || Number(video?.duration) || 0;
  return {
    durationSec: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) / 1000 : 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: parseFps(video?.avg_frame_rate) || parseFps(video?.r_frame_rate),
    sizeBytes: Number(data.format?.size) || (fs.existsSync(file) ? fs.statSync(file).size : 0),
    videoCodec: video?.codec_name ?? '',
    audioCodec: audio?.codec_name ?? null,
  };
}

/** Lossless remux to a seekable, faststart MP4 (input must be H.264/AAC compatible). */
export async function remux(bins: FfmpegBinaries, input: string, output: string): Promise<void> {
  await run(bins.ffmpeg, ['-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', output]);
}

/** Re-encode to H.264/AAC MP4. Progress needs the expected duration (webm inputs often lack one). */
export async function transcodeH264(
  bins: FfmpegBinaries,
  input: string,
  output: string,
  opts: { expectedDurationSec?: number; onProgress?: (pct: number) => void } = {}
): Promise<void> {
  const args = [
    '-y',
    '-i', input,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '21',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    output,
  ];
  const total = opts.expectedDurationSec ?? 0;
  await run(bins.ffmpeg, args, {
    onProgressSec: (sec) => {
      if (total > 0 && opts.onProgress) {
        opts.onProgress(Math.max(0, Math.min(99, Math.round((sec / total) * 100))));
      }
    },
  });
  opts.onProgress?.(100);
}

/** Single JPEG frame, 640px wide. */
export async function thumbnail(
  bins: FfmpegBinaries,
  input: string,
  output: string,
  atSec: number
): Promise<void> {
  await run(bins.ffmpeg, [
    '-y',
    '-ss', String(Math.max(0, atSec)),
    '-i', input,
    '-frames:v', '1',
    '-vf', 'scale=640:-2',
    '-q:v', '3',
    output,
  ]);
}

/** Animated GIF preview: first 4s, 480px wide, ~12fps, palette-optimised. */
export async function gifPreview(bins: FfmpegBinaries, input: string, output: string): Promise<void> {
  await run(bins.ffmpeg, [
    '-y',
    '-t', '4',
    '-i', input,
    '-vf',
    'fps=12,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4',
    '-loop', '0',
    output,
  ]);
}

export interface WaveformData {
  peaks: number[];
  durationSec: number;
}

/**
 * Extract mono 8kHz PCM and reduce to `buckets` normalised peaks (0..1).
 * Videos without an audio stream get an empty peaks array.
 */
export async function waveformPeaks(
  bins: FfmpegBinaries,
  input: string,
  outputJson: string,
  buckets = 800
): Promise<WaveformData> {
  const info = await probe(bins, input);
  let data: WaveformData;
  if (!info.audioCodec) {
    data = { peaks: [], durationSec: info.durationSec };
  } else {
    const pcm = await run(
      bins.ffmpeg,
      ['-i', input, '-map', 'a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'],
      { collectStdout: true }
    );
    const samples = pcm.length >> 1;
    const n = Math.min(buckets, Math.max(1, samples));
    const peaks = new Array<number>(n).fill(0);
    const perBucket = Math.max(1, Math.floor(samples / n));
    for (let i = 0; i < samples; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2)) / 32768;
      const b = Math.min(n - 1, Math.floor(i / perBucket));
      if (v > peaks[b]!) peaks[b] = v;
    }
    data = {
      peaks: peaks.map((p) => Math.round(p * 1000) / 1000),
      durationSec: info.durationSec || samples / 8000,
    };
  }
  fs.mkdirSync(path.dirname(outputJson), { recursive: true });
  fs.writeFileSync(outputJson, JSON.stringify(data));
  return data;
}

/** Extract mono 16kHz PCM WAV for transcription engines (SPEC T1). */
export async function extractAudioWav(
  bins: FfmpegBinaries,
  input: string,
  outputWav: string
): Promise<void> {
  await run(bins.ffmpeg, [
    '-y',
    '-i', input,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    outputWav,
  ]);
}

/** True when the recorded stream can be stream-copied into MP4 (H.264 + AAC/none). */
export function canRemux(info: ProbeResult): boolean {
  const videoOk = info.videoCodec === 'h264';
  const audioOk = info.audioCodec === null || info.audioCodec === 'aac';
  return videoOk && audioOk;
}
