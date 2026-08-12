/**
 * The recording guards protect a live take from the failure modes that used to
 * lose it outright: a stop during the countdown resurrecting a finalised
 * session, a full disk crashing the app, a dead engine renderer counting up a
 * timer over nothing, and a mis-hit cancel deleting minutes of capture.
 */
import { describe, expect, it } from 'vitest';
import {
  CHUNK_WATCHDOG_MS,
  CRITICAL_FREE_BYTES,
  KEEP_ON_CANCEL_MIN_SEC,
  LOW_FREE_BYTES,
  MIN_START_FREE_BYTES,
  chunkWatchdogTripped,
  estimatedMBPerMin,
  freeSpaceVerdict,
  keepChunksOnCancel,
  startBlockMessage,
  stopIntent,
} from '../recording-guards';

describe('startBlockMessage', () => {
  it('allows a start with plenty of space', () => {
    expect(startBlockMessage(MIN_START_FREE_BYTES, '1080p')).toBeNull();
    expect(startBlockMessage(500 * 1024 ** 3, '4k')).toBeNull();
  });

  it('blocks a start below the floor with a human message quoting the usage', () => {
    const msg = startBlockMessage(1024 ** 3, '4k');
    expect(msg).toContain('1.0 GB');
    expect(msg).toContain(`${estimatedMBPerMin('4k')} MB per minute`);
  });

  it('estimates usage from the configured bitrates (4k is roughly 143 MB/min)', () => {
    // 20 Mbit/s = 2.5 MB/s = 150 decimal MB/min, ~143 MiB/min.
    expect(estimatedMBPerMin('4k')).toBe(143);
    expect(estimatedMBPerMin('720p')).toBeLessThan(estimatedMBPerMin('1080p'));
  });
});

describe('freeSpaceVerdict', () => {
  it('grades free space ok / low / critical', () => {
    expect(freeSpaceVerdict(10 * 1024 ** 3)).toBe('ok');
    expect(freeSpaceVerdict(LOW_FREE_BYTES - 1)).toBe('low');
    expect(freeSpaceVerdict(CRITICAL_FREE_BYTES - 1)).toBe('critical');
  });

  it('treats the boundaries as the safer side', () => {
    expect(freeSpaceVerdict(LOW_FREE_BYTES)).toBe('ok');
    expect(freeSpaceVerdict(CRITICAL_FREE_BYTES)).toBe('low');
  });
});

describe('chunkWatchdogTripped', () => {
  const now = 1_000_000;

  it('trips when a recording has been silent past the watchdog window', () => {
    expect(chunkWatchdogTripped('recording', now - CHUNK_WATCHDOG_MS - 1, now)).toBe(true);
  });

  it('stays quiet while chunks are arriving', () => {
    expect(chunkWatchdogTripped('recording', now - 1000, now)).toBe(false);
  });

  it('never trips while paused - a paused recorder emits nothing on purpose', () => {
    expect(chunkWatchdogTripped('paused', now - 60_000, now)).toBe(false);
  });

  it('never trips before the first chunk (the start timeout owns that window)', () => {
    expect(chunkWatchdogTripped('recording', 0, now)).toBe(false);
  });

  it('ignores countdown and processing states', () => {
    expect(chunkWatchdogTripped('countdown', now - 60_000, now)).toBe(false);
    expect(chunkWatchdogTripped('processing', now - 60_000, now)).toBe(false);
  });
});

describe('stopIntent', () => {
  it('routes a stop during the countdown to cancel - nothing was captured yet', () => {
    expect(stopIntent('countdown')).toBe('cancel');
  });

  it('queues behind a stop that already ran', () => {
    expect(stopIntent('processing')).toBe('queue');
  });

  it('stops a live or paused take', () => {
    expect(stopIntent('recording')).toBe('stop');
    expect(stopIntent('paused')).toBe('stop');
  });

  it('does nothing when idle', () => {
    expect(stopIntent('idle')).toBe('none');
  });
});

describe('keepChunksOnCancel', () => {
  it('deletes a take with nothing meaningful in it', () => {
    expect(keepChunksOnCancel(0)).toBe(false);
    expect(keepChunksOnCancel(KEEP_ON_CANCEL_MIN_SEC)).toBe(false);
  });

  it('keeps a take with real content recoverable', () => {
    expect(keepChunksOnCancel(KEEP_ON_CANCEL_MIN_SEC + 1)).toBe(true);
    expect(keepChunksOnCancel(12 * 60)).toBe(true);
  });
});
