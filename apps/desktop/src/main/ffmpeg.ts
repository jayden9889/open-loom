/**
 * Electron binding for the ffmpeg core: binary resolution against settings,
 * a serial job queue with progress events broadcast to all windows, and the
 * guided static-build download (spawns scripts/fetch-ffmpeg.mjs).
 */
import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { JobProgress } from '@shared/types';
import * as core from './ffmpeg-core';
import { getSettings, appBinDir } from './settings';
import { log } from './logger';
import { broadcast } from './windows';

export { probe, remux, transcodeH264, thumbnail, gifPreview, waveformPeaks, canRemux, extractAudioWav } from './ffmpeg-core';
export type { FfmpegBinaries, ProbeResult } from './ffmpeg-core';

export function binaries(): core.FfmpegBinaries | null {
  return core.resolveBinaries(getSettings().ffmpegPath, appBinDir());
}

export function requireBinaries(): core.FfmpegBinaries {
  const bins = binaries();
  if (!bins) {
    throw new Error(
      'ffmpeg was not found. Install it from Setup (Fix next to ffmpeg) or set a path in Settings.'
    );
  }
  return bins;
}

export function ffmpegAvailable(): boolean {
  return binaries() !== null;
}

// ---------------------------------------------------------------------------
// Serial job queue with progress broadcast
// ---------------------------------------------------------------------------

interface QueuedJob {
  videoId: string;
  kind: string;
  fn: (report: (pct: number, note?: string) => void) => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

const queue: QueuedJob[] = [];
let running = false;

export function emitJobProgress(j: JobProgress): void {
  broadcast('ol:job-progress', j);
}

export function enqueueJob(
  videoId: string,
  kind: string,
  fn: (report: (pct: number, note?: string) => void) => Promise<void>
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    queue.push({ videoId, kind, fn, resolve, reject });
    void pump();
  });
}

async function pump(): Promise<void> {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  const report = (pct: number, note?: string) =>
    emitJobProgress({ videoId: job.videoId, kind: job.kind, pct, note });
  try {
    report(0);
    await job.fn(report);
    report(100);
    job.resolve();
  } catch (err) {
    log.error(`ffmpeg job ${job.kind} for ${job.videoId} failed: ${String(err)}`);
    job.reject(err);
  } finally {
    running = false;
    void pump();
  }
}

// ---------------------------------------------------------------------------
// Guided ffmpeg download (Setup "Fix" button). Runs scripts/fetch-ffmpeg.mjs
// under Electron-as-Node and streams its output as setup log lines.
// ---------------------------------------------------------------------------

let fetching: Promise<void> | null = null;

export function fetchFfmpeg(onLine: (line: string) => void): Promise<void> {
  if (fetching) {
    onLine('A download is already running.');
    return fetching;
  }
  const script = path.resolve(app.getAppPath(), '../../scripts/fetch-ffmpeg.mjs');
  const fallback = path.resolve(app.getAppPath(), 'scripts/fetch-ffmpeg.mjs');
  const scriptPath = fs.existsSync(script) ? script : fallback;
  if (!fs.existsSync(scriptPath)) {
    return Promise.reject(
      new Error(
        'The ffmpeg download script is missing from this install. Install ffmpeg manually and add it to your PATH, or set its path in Settings.'
      )
    );
  }
  const dest = appBinDir();
  fs.mkdirSync(dest, { recursive: true });
  fetching = new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, '--dest', dest], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const feed = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) onLine(line.trim());
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (err) => {
      fetching = null;
      reject(err);
    });
    child.on('close', (code) => {
      fetching = null;
      if (code === 0) {
        onLine('ffmpeg installed.');
        resolve();
      } else {
        reject(new Error(`ffmpeg download failed (exit code ${code}). Check your connection and try again.`));
      }
    });
  });
  return fetching;
}
