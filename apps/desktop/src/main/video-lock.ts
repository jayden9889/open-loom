/**
 * Per-video operation lock. One holder per video at a time, so an edit can
 * never rewrite video.mp4 while an upload is streaming it, and vice versa.
 *
 * API:
 *   takeVideoLock(videoId, kind)    - throws a plain-English Error when another
 *                                     kind already holds the video; re-entrant
 *                                     for the same kind (a counter, so nested
 *                                     holds of one kind are fine).
 *   releaseVideoLock(videoId, kind) - release one hold; no-op when not held.
 *   videoLockHolder(videoId)        - current holder kind, or null.
 *
 * Holders:
 *   'edit'   - trim / stitch / revert jobs (taken in the ffmpeg job pump).
 *   'upload' - share or YouTube uploads reading video.mp4.
 *   'record' - a recording still being processed into this video id.
 *
 * The thrown messages are user-facing; callers should surface them verbatim.
 */

export type VideoLockKind = 'edit' | 'upload' | 'record';

interface Hold {
  kind: VideoLockKind;
  count: number;
}

const holds = new Map<string, Hold>();

/** What the busy video is doing, phrased for the person who has to wait. */
const BUSY_TEXT: Record<VideoLockKind, string> = {
  edit: 'This recording is being edited.',
  upload: 'This recording is uploading.',
  record: 'This recording is still being processed.',
};

/** What the refused action was, phrased as the thing to wait before doing. */
const WANTED_TEXT: Record<VideoLockKind, string> = {
  edit: 'Wait for it to finish before editing.',
  upload: 'Wait for it to finish before uploading.',
  record: 'Wait for it to finish first.',
};

/** Sharper wording for the pairings users actually hit. */
const SPECIFIC_TEXT: Partial<Record<`${VideoLockKind}:${VideoLockKind}`, string>> = {
  'upload:edit': 'This recording is uploading. Wait for the upload to finish before editing.',
  'edit:upload': 'This recording is being edited. Wait for the edit to finish before uploading.',
};

export function takeVideoLock(videoId: string, kind: VideoLockKind): void {
  const hold = holds.get(videoId);
  if (!hold) {
    holds.set(videoId, { kind, count: 1 });
    return;
  }
  if (hold.kind === kind) {
    hold.count++;
    return;
  }
  const message =
    SPECIFIC_TEXT[`${hold.kind}:${kind}`] ?? `${BUSY_TEXT[hold.kind]} ${WANTED_TEXT[kind]}`;
  throw new Error(message);
}

export function releaseVideoLock(videoId: string, kind: VideoLockKind): void {
  const hold = holds.get(videoId);
  if (!hold || hold.kind !== kind) return;
  hold.count--;
  if (hold.count <= 0) holds.delete(videoId);
}

export function videoLockHolder(videoId: string): VideoLockKind | null {
  return holds.get(videoId)?.kind ?? null;
}
