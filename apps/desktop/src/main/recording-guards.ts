/**
 * Pure decision logic for the recording state machine: disk-space guardrails,
 * the chunk watchdog, stop-intent routing and cancel retention. Extracted from
 * recorder-ipc.ts so the rules that protect a live take are unit-testable
 * without Electron.
 */
import { QUALITY_BITRATES, type QualityPreset, type RecordingStatus } from '@shared/types';

/** Refuse to start a recording with less free space than this. */
export const MIN_START_FREE_BYTES = 2 * 1024 ** 3;
/** Warn the user mid-recording below this. */
export const LOW_FREE_BYTES = 1024 ** 3;
/** Auto-stop and save below this rather than crashing on a full disk. */
export const CRITICAL_FREE_BYTES = 400 * 1024 ** 2;
/** The engine emits a chunk every second; this much silence means it is dead or wedged. */
export const CHUNK_WATCHDOG_MS = 5000;
/** A cancelled take longer than this is kept recoverable instead of deleted. */
export const KEEP_ON_CANCEL_MIN_SEC = 5;

/** Rough disk usage for a quality preset, for human-readable messages. */
export function estimatedMBPerMin(quality: QualityPreset): number {
  return Math.round((QUALITY_BITRATES[quality] / 8 / (1024 * 1024)) * 60);
}

/** null = enough room to start; otherwise the message to show instead of recording. */
export function startBlockMessage(freeBytes: number, quality: QualityPreset): string | null {
  if (freeBytes >= MIN_START_FREE_BYTES) return null;
  const freeGb = (freeBytes / 1024 ** 3).toFixed(1);
  return `Not enough free disk space to record safely: ${freeGb} GB left, and a ${quality} recording uses about ${estimatedMBPerMin(quality)} MB per minute. Free up some space and try again.`;
}

export type FreeSpaceVerdict = 'ok' | 'low' | 'critical';

export function freeSpaceVerdict(freeBytes: number): FreeSpaceVerdict {
  if (freeBytes < CRITICAL_FREE_BYTES) return 'critical';
  if (freeBytes < LOW_FREE_BYTES) return 'low';
  return 'ok';
}

/**
 * True when a supposedly live recording has produced no chunks for too long -
 * a crashed or wedged engine renderer. Paused takes emit nothing on purpose,
 * and a take that has not produced its first chunk yet is covered by the
 * engine start timeout instead.
 */
export function chunkWatchdogTripped(status: RecordingStatus, lastChunkAt: number, now: number): boolean {
  if (status !== 'recording') return false;
  if (lastChunkAt <= 0) return false;
  return now - lastChunkAt > CHUNK_WATCHDOG_MS;
}

/**
 * What a "stop" request actually means for the current status. During the
 * countdown nothing has been captured, so stop is semantically a cancel -
 * routing it into the stop path could resurrect a finalised session.
 */
export type StopIntent = 'cancel' | 'queue' | 'stop' | 'none';

export function stopIntent(status: RecordingStatus): StopIntent {
  switch (status) {
    case 'countdown':
      return 'cancel';
    case 'processing':
      return 'queue';
    case 'recording':
    case 'paused':
      return 'stop';
    default:
      return 'none';
  }
}

/** A cancelled take with real content is kept recoverable instead of deleted. */
export function keepChunksOnCancel(elapsedSec: number): boolean {
  return elapsedSec > KEEP_ON_CANCEL_MIN_SEC;
}

// ---------------------------------------------------------------------------
// Destructive-action confirm (delete / restart mid-take)
// ---------------------------------------------------------------------------

/** A take longer than this gets one chance to say no before delete/restart. */
export const CONFIRM_DESTROY_MIN_SEC = 10;
/** An unanswered confirm goes back to plain recording after this long. */
export const CONFIRM_EXPIRY_MS = 12_000;

/**
 * True when discarding this much footage deserves a confirm. Short scraps go
 * straight through - a confirm on a five-second false start is just friction.
 */
export function needsDestroyConfirm(status: RecordingStatus, elapsedSec: number): boolean {
  if (status !== 'recording' && status !== 'paused') return false;
  return elapsedSec >= CONFIRM_DESTROY_MIN_SEC;
}

// ---------------------------------------------------------------------------
// Re-say the last bit (redo cuts)
// ---------------------------------------------------------------------------

/** How far back "re-say the last bit" rewinds. */
export const REDO_BACK_MS = 10_000;

/** A stretch of the raw take (pauses excluded) marked for removal at finalise. */
export interface RedoCut {
  fromMs: number;
  toMs: number;
}

/** The cut a redo pressed at `recordedMs` marks: the last `backMs`, clamped to the start. */
export function redoCutAt(recordedMs: number, backMs: number = REDO_BACK_MS): RedoCut {
  return { fromMs: Math.max(0, recordedMs - backMs), toMs: recordedMs };
}

/** Merge overlapping/touching cuts (two redos in quick succession overlap). */
export function mergeRedoCuts(cuts: RedoCut[]): RedoCut[] {
  const sorted = cuts
    .filter((c) => c.toMs > c.fromMs)
    .map((c) => ({ fromMs: Math.max(0, c.fromMs), toMs: c.toMs }))
    .sort((a, b) => a.fromMs - b.fromMs);
  const merged: RedoCut[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, c.toMs);
    else merged.push({ ...c });
  }
  return merged;
}

/** Total milliseconds the merged cuts remove, for the HUD's jumped-back timer. */
export function totalRedoCutMs(cuts: RedoCut[]): number {
  return mergeRedoCuts(cuts).reduce((sum, c) => sum + (c.toMs - c.fromMs), 0);
}

/**
 * Convert redo cuts into the keep ranges the trim engine takes, against the
 * finished file's real duration. Null means "leave the video alone": no cuts
 * land inside the file, or so little would survive that cutting is more
 * likely a bug than an intent - keeping the full take is always the safe
 * failure.
 */
export function redoKeepRanges(
  cuts: RedoCut[],
  durationSec: number
): { start: number; end: number }[] | null {
  const merged = mergeRedoCuts(cuts)
    .map((c) => ({ start: c.fromMs / 1000, end: Math.min(c.toMs / 1000, durationSec) }))
    .filter((c) => c.end - c.start > 0.05 && c.start < durationSec);
  if (merged.length === 0) return null;
  const keep: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const c of merged) {
    if (c.start - cursor > 0.05) keep.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (durationSec - cursor > 0.05) keep.push({ start: cursor, end: durationSec });
  const keptSec = keep.reduce((sum, r) => sum + (r.end - r.start), 0);
  if (keptSec < 0.5) return null;
  return keep;
}

// ---------------------------------------------------------------------------
// Mic silence watchdog (the audio twin of the camera-loss handler)
// ---------------------------------------------------------------------------

/** No audible mic signal for this long during a take = tell the user once. */
export const MIC_SILENCE_MS = 15_000;
/** RMS below this is digital silence (a dead/muted device), not a quiet room. */
export const MIC_SILENCE_RMS = 0.0005;

/**
 * True when the mic has been flat for long enough to warn. Only a live,
 * unmuted take counts: pause emits nothing on purpose, and a muted mic is the
 * user's own choice.
 */
export function micSilenceTripped(
  status: RecordingStatus,
  micOn: boolean,
  lastAudibleAt: number,
  now: number
): boolean {
  if (status !== 'recording' || !micOn) return false;
  if (lastAudibleAt <= 0) return false;
  return now - lastAudibleAt > MIC_SILENCE_MS;
}
