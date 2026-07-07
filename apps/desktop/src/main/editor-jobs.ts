/**
 * Editor jobs (SPEC E1-E4): non-destructive trim / delete-middle / stitch on
 * library videos. The first edit banks the untouched file as video.orig.mp4;
 * revertEdits restores it and confirmEdits deletes it. Every edit re-probes
 * the result, regenerates thumbnail + GIF preview + waveform, clamps AI
 * chapters to the new duration and updates meta.json. Progress flows through
 * the shared ffmpeg job queue into onJobProgress.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { VideoMeta } from '@shared/types';
import { VIDEO_FILES } from '@shared/types';
import * as ffmpeg from './ffmpeg';
import { trimVideoFile, stitchVideoFiles, type KeepRange } from './editor-core';
import { library } from './library';
import { log } from './logger';

function videoPath(id: string): string {
  return path.join(library().videoDir(id), VIDEO_FILES.video);
}

function originalPath(id: string): string {
  return path.join(library().videoDir(id), VIDEO_FILES.original);
}

function requireVideoFile(id: string): string {
  const p = videoPath(id);
  if (!fs.existsSync(p)) {
    throw new Error('The video file for this recording is missing, so it cannot be edited.');
  }
  return p;
}

/** Bank the pristine file before the first edit (kept until confirm/revert). */
function ensureOriginalBanked(id: string): void {
  const orig = originalPath(id);
  if (!fs.existsSync(orig)) {
    fs.copyFileSync(videoPath(id), orig);
  }
}

/** Regenerate thumb + gif + waveform and refresh meta after an edit (E4). */
async function refreshDerivedAssets(id: string, report: (pct: number, note?: string) => void): Promise<void> {
  const bins = ffmpeg.requireBinaries();
  const store = library();
  const dir = store.videoDir(id);
  const video = videoPath(id);
  const info = await ffmpeg.probe(bins, video);

  report(88, 'Updating previews');
  const meta = store.get(id);
  if (!meta.customThumb) {
    await ffmpeg.thumbnail(bins, video, path.join(dir, VIDEO_FILES.thumb), info.durationSec * 0.25);
  }
  await ffmpeg.gifPreview(bins, video, path.join(dir, VIDEO_FILES.preview));
  await ffmpeg.waveformPeaks(bins, video, path.join(dir, VIDEO_FILES.waveform));

  const patch: Partial<VideoMeta> = {
    durationSec: info.durationSec,
    width: info.width,
    height: info.height,
    fps: info.fps,
    sizeBytes: info.sizeBytes,
    edits: { trimmedFrom: VIDEO_FILES.original },
  };
  // Chapters that now point beyond the end are dropped (E4 + A1 validity).
  if (meta.ai?.chapters) {
    patch.ai = { ...meta.ai, chapters: meta.ai.chapters.filter((c) => c.t <= info.durationSec) };
  }
  store.update(id, patch);
}

/**
 * Keep-ranges trim (E1 + E2). Writes to a temp file first so a failed ffmpeg
 * run never destroys the current video.
 */
export async function trimVideo(id: string, ranges: KeepRange[]): Promise<void> {
  const store = library();
  store.get(id);
  const input = requireVideoFile(id);
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new Error('Nothing to save: the edit has no kept sections.');
  }
  const bins = ffmpeg.requireBinaries();

  await ffmpeg.enqueueJob(id, 'trim', async (report) => {
    ensureOriginalBanked(id);
    const tmpOut = path.join(store.videoDir(id), '.edit-tmp.mp4');
    try {
      const result = await trimVideoFile(bins, input, tmpOut, ranges, (pct, note) =>
        report(Math.min(85, pct), note)
      );
      fs.renameSync(tmpOut, input);
      log.info(`trim of ${id} saved via ${result.method} (${result.durationSec}s)`);
      await refreshDerivedAssets(id, report);
      report(100, result.method === 'copy' ? 'Saved with a lossless cut' : 'Saved with a precise re-encode');
    } finally {
      fs.rmSync(tmpOut, { force: true });
    }
  });
}

/** Append another library video (E3). */
export async function stitchVideos(id: string, appendId: string): Promise<void> {
  const store = library();
  store.get(id);
  store.get(appendId);
  if (id === appendId) {
    throw new Error('Pick a different video to append: a recording cannot be stitched onto itself.');
  }
  const input = requireVideoFile(id);
  const appendFile = path.join(store.videoDir(appendId), VIDEO_FILES.video);
  if (!fs.existsSync(appendFile)) {
    throw new Error('The video you picked has no playable file, so it cannot be appended.');
  }
  const bins = ffmpeg.requireBinaries();

  await ffmpeg.enqueueJob(id, 'stitch', async (report) => {
    ensureOriginalBanked(id);
    const tmpOut = path.join(store.videoDir(id), '.edit-tmp.mp4');
    try {
      const result = await stitchVideoFiles(bins, input, appendFile, tmpOut, (pct, note) =>
        report(Math.min(85, pct), note)
      );
      fs.renameSync(tmpOut, input);
      log.info(`stitch ${appendId} onto ${id} via ${result.method} (${result.durationSec}s)`);
      await refreshDerivedAssets(id, report);
      report(100, result.method === 'copy' ? 'Clip added with a lossless join' : 'Clip added with a re-encode');
    } finally {
      fs.rmSync(tmpOut, { force: true });
    }
  });
}

/** Restore video.orig.mp4 over the edited file and rebuild previews. */
export async function revertEdits(id: string): Promise<void> {
  const store = library();
  store.get(id);
  const orig = originalPath(id);
  if (!fs.existsSync(orig)) {
    throw new Error('There is no original to restore: this video has no unconfirmed edits.');
  }

  await ffmpeg.enqueueJob(id, 'revert', async (report) => {
    report(10, 'Restoring original');
    fs.copyFileSync(orig, videoPath(id));
    fs.rmSync(orig, { force: true });
    await refreshDerivedAssets(id, report);
    clearEditsMarker(id);
    report(100, 'Original restored');
  });
}

/** Accept the edit: drop the banked original and clear the marker. */
export async function confirmEdits(id: string): Promise<void> {
  const store = library();
  store.get(id);
  fs.rmSync(originalPath(id), { force: true });
  clearEditsMarker(id);
}

function clearEditsMarker(id: string): void {
  const store = library();
  const meta = store.get(id);
  if (meta.edits) {
    delete meta.edits;
    store.put(meta);
  }
}
