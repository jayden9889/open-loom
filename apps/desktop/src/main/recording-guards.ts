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
