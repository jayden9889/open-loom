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
import { EditCancelledError } from './editor-core';
import { getSettings, appBinDir } from './settings';
import { log } from './logger';
import { broadcast } from './windows';
import { takeVideoLock, releaseVideoLock, videoLockHolder } from './video-lock';

export { probe, remux, transcodeH264, thumbnail, gifPreview, waveformPeaks, canRemux, extractAudioWav, detectSilences } from './ffmpeg-core';
export type { FfmpegBinaries, ProbeResult, SilenceRange } from './ffmpeg-core';

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

/**
 * Make sure ffmpeg exists, fetching it automatically when missing - the user
 * should never hit an "install ffmpeg" wall. Called in the background at app
 * launch and as an awaited backstop when a recording starts. The Setup screen
 * stays as the manual fallback (custom path / retry with visible log).
 */
export async function ensureFfmpeg(context: 'launch' | 'record' = 'record'): Promise<void> {
  if (ffmpegAvailable()) return;
  log.info(`ffmpeg missing (${context}); starting automatic download`);
  if (context === 'record') {
    broadcast('ol:toast', {
      kind: 'info',
      text: 'One-time setup: downloading the video engine. Recording starts as soon as it lands.',
    });
  }
  try {
    await fetchFfmpeg((line) => broadcast('ol:setup-log', line));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not set up the video engine automatically (${msg}). Open Setup to retry or point Settings at an existing ffmpeg.`
    );
  }
  if (!ffmpegAvailable()) {
    throw new Error(
      'The video engine downloaded but could not be found. Open Setup to retry or point Settings at an existing ffmpeg.'
    );
  }
  if (context === 'record') {
    broadcast('ol:toast', { kind: 'success', text: 'Video engine ready.' });
  }
}

// ---------------------------------------------------------------------------
// Serial job queue with progress broadcast
// ---------------------------------------------------------------------------

interface QueuedJob {
  videoId: string;
  kind: string;
  fn: (report: (pct: number, note?: string) => void, signal: AbortSignal) => Promise<void>;
  controller: AbortController;
  resolve: () => void;
  reject: (err: unknown) => void;
}

const queue: QueuedJob[] = [];
let running: QueuedJob | null = null;

/** Job kinds that rewrite video.mp4 and therefore hold the per-video edit lock. */
const EDIT_KINDS = new Set(['trim', 'stitch', 'revert']);

export function emitJobProgress(j: JobProgress): void {
  broadcast('ol:job-progress', j);
}

export function enqueueJob(
  videoId: string,
  kind: string,
  fn: (report: (pct: number, note?: string) => void, signal: AbortSignal) => Promise<void>
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    queue.push({ videoId, kind, fn, controller: new AbortController(), resolve, reject });
    void pump();
  });
}

/**
 * Abort the running or queued jobs for a video. The running ffmpeg child gets
 * SIGTERM via its AbortSignal; queued jobs reject before they start.
 */
export function cancelJob(videoId: string): void {
  for (const job of queue) {
    if (job.videoId === videoId) job.controller.abort();
  }
  if (running?.videoId === videoId) running.controller.abort();
}

/** True while any job is running or queued; the quit guard consults this. */
export function jobsActive(): boolean {
  return running !== null || queue.length > 0;
}

/** Resolved by pump() once the queue empties, so the quit path can await it. */
const idleWaiters: Array<() => void> = [];

function whenIdle(): Promise<void> {
  if (!jobsActive()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    idleWaiters.push(resolve);
  });
}

/**
 * Stop every job for a quit. Nothing used to cancel or await these, so quitting
 * mid encode orphaned the ffmpeg child: it either outlived the app or died
 * leaving a part written output where the finished one belongs.
 *
 * Aborting first is the deterministic half. Queued jobs then reject before they
 * ever spawn anything, and the running job's AbortSignal SIGTERMs its child.
 * The short wait that follows is what lets that job's own cleanup actually run,
 * because a trim only swaps its temp file onto video.mp4 after a clean finish
 * and only deletes that temp file and releases the edit lock in its finally.
 * Killing the process a tick earlier leaves .edit-tmp.mp4 and a stuck lock.
 *
 * The wait is bounded at three seconds because a SIGTERMed ffmpeg exits in well
 * under one, and the jobs that ignore their signal (remux, transcode, preview
 * work) can run for minutes. Quit is never held hostage to those; we log the
 * kind that outstayed the deadline instead.
 */
export async function cancelJobsForQuit(timeoutMs = 3000): Promise<boolean> {
  if (!jobsActive()) return true;
  const lastKind = running?.kind ?? queue[0]?.kind ?? 'unknown';
  for (const job of queue) job.controller.abort();
  running?.controller.abort();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    whenIdle(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (jobsActive()) {
    log.warn(
      `quit did not drain ffmpeg job ${running?.kind ?? lastKind}; its child may outlive the app`
    );
    return false;
  }
  return true;
}

async function pump(): Promise<void> {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = job;
  const report = (pct: number, note?: string) =>
    emitJobProgress({ videoId: job.videoId, kind: job.kind, pct, note });
  const lockKind = EDIT_KINDS.has(job.kind) ? 'edit' : null;
  try {
    if (job.controller.signal.aborted) throw new EditCancelledError();
    // Rewriting video.mp4 under an in-flight upload corrupts the hosted copy;
    // the lock turns that race into a plain-English refusal.
    if (lockKind) takeVideoLock(job.videoId, lockKind);
    report(0);
    await job.fn(report, job.controller.signal);
    report(100);
    job.resolve();
  } catch (err) {
    if (err instanceof EditCancelledError) {
      log.info(`ffmpeg job ${job.kind} for ${job.videoId} cancelled`);
      report(100, `${job.kind} cancelled`);
    } else {
      log.error(`ffmpeg job ${job.kind} for ${job.videoId} failed: ${String(err)}`);
      // A terminal event is what clears the renderer's "job running" state. Without
      // it a failed transcribe left the panel spinning forever with its retry
      // button disabled. The AI and share producers already emit one on failure.
      report(100, `${job.kind} failed`);
    }
    job.reject(err);
  } finally {
    if (lockKind && videoLockHolder(job.videoId) === lockKind) releaseVideoLock(job.videoId, lockKind);
    running = null;
    void pump();
    // pump() sets running synchronously before its first await, so by here the
    // queue state is settled and a waiting quit can be released. Signalling
    // rather than polling is what keeps the quit wait honest: it ends the tick
    // the last job's cleanup finished, not a fixed delay later.
    if (!jobsActive()) for (const waiter of idleWaiters.splice(0)) waiter();
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
  // Packaged: the script ships as an extraResource next to the asar. Dev: it
  // lives at the repo root (two levels above apps/desktop).
  const candidates = [
    path.join(process.resourcesPath ?? '', 'scripts/fetch-ffmpeg.mjs'),
    path.resolve(app.getAppPath(), '../../scripts/fetch-ffmpeg.mjs'),
    path.resolve(app.getAppPath(), 'scripts/fetch-ffmpeg.mjs'),
  ];
  const scriptPath = candidates.find((p) => p && fs.existsSync(p));
  if (!scriptPath) {
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
