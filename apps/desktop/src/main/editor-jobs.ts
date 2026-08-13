/**
 * Editor jobs (SPEC E1-E4): non-destructive trim / delete-middle / stitch on
 * library videos. The first edit banks the untouched file as video.orig.mp4;
 * revertEdits restores it and confirmEdits moves it to the system Trash. Every
 * edit re-probes the result and commits duration/size and the recovery marker
 * to meta.json the moment the file changes; thumbnail + GIF preview + waveform
 * are regenerated afterwards with each step isolated, so a preview failure can
 * never leave the metadata stale. Progress flows through the shared ffmpeg job
 * queue into onJobProgress. Also holds the "continue from here" intent: the
 * editor arms it, the recording that lands next is claimed as the continuation
 * take and offered for stitching onto its base video.
 */
import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import type { Settings, VideoMeta } from '@shared/types';
import { VIDEO_FILES } from '@shared/types';
import * as ffmpeg from './ffmpeg';
import { trimVideoFile, stitchVideoFiles, type KeepRange } from './editor-core';
import { generatePreviews } from './preview-core';
import { library } from './library';
import { getSettings, setSettings } from './settings';
import { markShareStale } from './share';
import { buildVtt, retimeSegments, retimeThroughRanges } from './transcribe-core';
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

/**
 * Commit the recovery marker the moment video.mp4 has been replaced. This is
 * the handle the Revert button hangs off, so it must be durable before any
 * derived-asset work runs. The first edit also records what the banked
 * original measures, so the UI can name what Keep/Revert will do without a
 * disk walk, and every edit appends to the history so "Revert" can say how
 * many edits it undoes.
 */
function recordEdit(id: string, kind: 'trim' | 'stitch'): void {
  const store = library();
  const meta = store.get(id);
  const prev = meta.edits;
  const orig = originalPath(id);
  store.update(id, {
    edits: {
      trimmedFrom: VIDEO_FILES.original,
      // On the first edit meta.durationSec still describes the pre-edit file.
      originalDurationSec: prev?.originalDurationSec ?? meta.durationSec,
      originalSizeBytes:
        prev?.originalSizeBytes ?? (fs.existsSync(orig) ? fs.statSync(orig).size : undefined),
      history: [...(prev?.history ?? []), { kind, at: new Date().toISOString() }],
    },
  });
}

/**
 * Re-time transcript.json, transcript.vtt and the AI chapters onto the trimmed
 * timeline. Only a keep-ranges trim shifts timestamps; stitch appends at the end
 * and revert restores the original, so both leave existing times valid.
 */
function retimeTranscriptAndChapters(
  id: string,
  ranges: { start: number; end: number }[],
  patch: Partial<VideoMeta>
): void {
  const store = library();
  const dir = store.videoDir(id);
  const jsonPath = path.join(dir, VIDEO_FILES.transcriptJson);
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as {
        segments?: { start: number; end: number; text: string }[];
      };
      const retimed = retimeSegments(data.segments ?? [], ranges);
      fs.writeFileSync(jsonPath, JSON.stringify({ ...data, segments: retimed }, null, 2));
      fs.writeFileSync(path.join(dir, VIDEO_FILES.captions), buildVtt(retimed));
      log.info(`re-timed ${retimed.length} transcript segments for ${id} after trim`);
    } catch (err) {
      // A transcript we cannot re-time is worse than none: it would point at the
      // wrong moments and keep matching cut words in search.
      log.warn(`could not re-time the transcript for ${id}, dropping it: ${String(err)}`);
      fs.rmSync(jsonPath, { force: true });
      fs.rmSync(path.join(dir, VIDEO_FILES.captions), { force: true });
      patch.transcript = undefined;
    }
  }

  const meta = store.get(id);
  if (meta.ai?.chapters) {
    const chapters = meta.ai.chapters
      .map((c) => ({ ...c, t: retimeThroughRanges(c.t, ranges) }))
      .filter((c): c is typeof c & { t: number } => c.t !== null);
    patch.ai = { ...meta.ai, chapters };
  }
}

/**
 * Refresh meta after an edit, then regenerate thumb + gif + waveform (E4).
 * The metadata patch is committed FIRST: video.mp4 has already been replaced
 * by the caller, and a preview failure (full disk, OOM on a long waveform
 * pass) must never leave the library reporting the old duration. The preview
 * steps run through the same isolation the recording path uses.
 */
async function refreshDerivedAssets(
  id: string,
  report: (pct: number, note?: string) => void,
  keptRanges?: { start: number; end: number }[]
): Promise<void> {
  const bins = ffmpeg.requireBinaries();
  const store = library();
  const dir = store.videoDir(id);
  const video = videoPath(id);
  const info = await ffmpeg.probe(bins, video);

  const meta = store.get(id);
  const patch: Partial<VideoMeta> = {
    durationSec: info.durationSec,
    width: info.width,
    height: info.height,
    fps: info.fps,
    sizeBytes: info.sizeBytes,
  };
  if (keptRanges && keptRanges.length > 0) {
    retimeTranscriptAndChapters(id, keptRanges, patch);
  } else if (meta.ai?.chapters) {
    // No range map (stitch/revert): timestamps still line up, so only drop the
    // chapters that now point past the end.
    patch.ai = { ...meta.ai, chapters: meta.ai.chapters.filter((c) => c.t <= info.durationSec) };
  }
  store.update(id, patch);

  report(88, 'Updating previews');
  await generatePreviews({
    thumbnail: async () => {
      if (!store.get(id).customThumb) {
        await ffmpeg.thumbnail(bins, video, path.join(dir, VIDEO_FILES.thumb), info.durationSec * 0.25);
      }
    },
    gif: () => ffmpeg.gifPreview(bins, video, path.join(dir, VIDEO_FILES.preview)),
    waveform: async () => {
      await ffmpeg.waveformPeaks(bins, video, path.join(dir, VIDEO_FILES.waveform));
    },
    warn: (msg) => log.warn(`preview refresh after edit of ${id}: ${msg}`),
  });
}

/**
 * Quiet stretches in the current (possibly already edited) file, for the
 * editor's cut-quiet-parts action. Read-only, so it skips the job queue.
 */
export async function detectSilences(id: string): Promise<{ start: number; end: number }[]> {
  library().get(id);
  const input = requireVideoFile(id);
  const bins = ffmpeg.requireBinaries();
  return ffmpeg.detectSilences(bins, input);
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

  await ffmpeg.enqueueJob(id, 'trim', async (report, signal) => {
    ensureOriginalBanked(id);
    const tmpOut = path.join(store.videoDir(id), '.edit-tmp.mp4');
    try {
      const result = await trimVideoFile(bins, input, tmpOut, ranges, (pct, note) =>
        report(Math.min(85, pct), note), signal
      );
      fs.renameSync(tmpOut, input);
      recordEdit(id, 'trim');
      // The local file no longer matches the hosted copy; Watch shows the
      // "your edits are not on the shared link yet" state off this.
      markShareStale(id);
      log.info(`trim of ${id} saved via ${result.method} (${result.durationSec}s)`);
      await refreshDerivedAssets(id, report, ranges);
      report(100, result.method === 'copy' ? 'Saved with a lossless cut' : 'Saved with a precise re-encode');
    } finally {
      fs.rmSync(tmpOut, { force: true });
    }
  });
}

/** Append another library video (E3), optionally only a range of it. */
export async function stitchVideos(id: string, appendId: string, appendRange?: KeepRange): Promise<void> {
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
  if (appendRange && !(Number.isFinite(appendRange.start) && Number.isFinite(appendRange.end) && appendRange.end > appendRange.start)) {
    throw new Error('The clip range to append is invalid. Adjust the in and out points and try again.');
  }
  const bins = ffmpeg.requireBinaries();

  await ffmpeg.enqueueJob(id, 'stitch', async (report, signal) => {
    ensureOriginalBanked(id);
    const tmpOut = path.join(store.videoDir(id), '.edit-tmp.mp4');
    try {
      const result = await stitchVideoFiles(bins, input, appendFile, tmpOut, (pct, note) =>
        report(Math.min(85, pct), note), { signal, appendRange }
      );
      fs.renameSync(tmpOut, input);
      recordEdit(id, 'stitch');
      markShareStale(id);
      log.info(`stitch ${appendId} onto ${id} via ${result.method} (${result.durationSec}s)`);
      // The clip is now part of the base video, so a pending continuation
      // offer for it is fulfilled.
      if (store.get(id).continuation?.takeId === appendId) {
        store.update(id, { continuation: undefined });
      }
      await refreshDerivedAssets(id, report);
      report(
        100,
        result.method === 'copy'
          ? 'Clip added with a lossless join'
          : result.method === 'append-reencode'
            ? 'Clip added, only the new clip was re-encoded'
            : 'Clip added with a re-encode'
      );
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
    clearEditsMarker(id);
    // The restored original also differs from an already-shared edited copy.
    markShareStale(id);
    await refreshDerivedAssets(id, report);
    report(100, 'Original restored');
  });
}

/**
 * Accept the edit: move the banked original to the system Trash and clear the
 * marker. Trash, not a hard unlink - the original is the only copy of the
 * footage the edit removed, so it must stay recoverable outside the app.
 */
export async function confirmEdits(id: string): Promise<void> {
  const store = library();
  store.get(id);
  const orig = originalPath(id);
  if (fs.existsSync(orig)) {
    await shell.trashItem(orig);
  }
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

// ---------------------------------------------------------------------------
// Continue from here: arm a continuation, claim the take that lands next
// ---------------------------------------------------------------------------

/** Armed intents older than this are stale (the user wandered off). */
const CONTINUATION_TTL_MS = 2 * 60 * 60 * 1000;

let continuationIntent: { baseId: string; armedAt: number } | null = null;

/**
 * Arm the continuation: the next recording that lands is offered as an append
 * onto `baseId`. Also flips the launcher's default mode to the base video's
 * mode; devices, layout and bubble size already persist in settings from the
 * last recording, so the new take matches the original one.
 */
export function beginContinuation(baseId: string): void {
  const meta = library().get(baseId);
  requireVideoFile(baseId);
  continuationIntent = { baseId, armedAt: Date.now() };
  if (getSettings().recording.defaultMode !== meta.mode) {
    setSettings({ recording: { defaultMode: meta.mode } } as Partial<Settings>);
  }
  log.info(`continuation armed for ${baseId}`);
}

/** Disarm without touching anything (the user backed out). */
export function cancelContinuation(): void {
  continuationIntent = null;
}

/** The armed continuation, if any and not stale. */
export function pendingContinuation(): { baseId: string } | null {
  if (!continuationIntent) return null;
  if (Date.now() - continuationIntent.armedAt > CONTINUATION_TTL_MS) {
    continuationIntent = null;
    return null;
  }
  return { baseId: continuationIntent.baseId };
}

/**
 * Claim a recording that just landed as the armed continuation's take. Tags
 * the take onto the base video's meta (so the offer survives a restart) and
 * answers the base id so the caller can route straight back into its editor.
 * Null when no continuation is armed, so ordinary recordings are untouched.
 */
export function claimContinuationTake(takeId: string): { baseId: string } | null {
  const pending = pendingContinuation();
  if (!pending || pending.baseId === takeId) return null;
  continuationIntent = null;
  const store = library();
  try {
    store.get(takeId);
    const base = store.get(pending.baseId);
    store.update(base.id, { continuation: { takeId, recordedAt: new Date().toISOString() } });
    log.info(`continuation take ${takeId} claimed for ${base.id}`);
    return { baseId: base.id };
  } catch (err) {
    log.warn(`could not claim continuation take ${takeId}: ${String(err)}`);
    return null;
  }
}

/** Clear a base video's pending continuation offer (the user kept the take separate). */
export function dismissContinuation(baseId: string): void {
  const store = library();
  const meta = store.get(baseId);
  if (meta.continuation) store.update(baseId, { continuation: undefined });
}
