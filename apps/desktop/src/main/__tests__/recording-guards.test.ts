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
  CONFIRM_DESTROY_MIN_SEC,
  MIC_SILENCE_MS,
  chunkWatchdogTripped,
  estimatedMBPerMin,
  freeSpaceVerdict,
  keepChunksOnCancel,
  mergeRedoCuts,
  micSilenceTripped,
  needsDestroyConfirm,
  redoCutAt,
  redoKeepRanges,
  startBlockMessage,
  stopIntent,
  totalRedoCutMs,
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

describe('needsDestroyConfirm', () => {
  it('lets a short false start go without friction', () => {
    expect(needsDestroyConfirm('recording', CONFIRM_DESTROY_MIN_SEC - 1)).toBe(false);
  });

  it('gates a take long enough to be worth one, recording or paused', () => {
    expect(needsDestroyConfirm('recording', CONFIRM_DESTROY_MIN_SEC)).toBe(true);
    expect(needsDestroyConfirm('paused', 5 * 60)).toBe(true);
  });

  it('never fires outside a live take', () => {
    expect(needsDestroyConfirm('countdown', 999)).toBe(false);
    expect(needsDestroyConfirm('processing', 999)).toBe(false);
    expect(needsDestroyConfirm('idle', 999)).toBe(false);
  });
});

describe('redo cuts', () => {
  it('marks the last ten seconds, clamped at the start of the take', () => {
    expect(redoCutAt(25_000)).toEqual({ fromMs: 15_000, toMs: 25_000 });
    expect(redoCutAt(4_000)).toEqual({ fromMs: 0, toMs: 4_000 });
  });

  it('merges two redos pressed in quick succession into one stretch', () => {
    const merged = mergeRedoCuts([
      { fromMs: 15_000, toMs: 25_000 },
      { fromMs: 20_000, toMs: 30_000 },
    ]);
    expect(merged).toEqual([{ fromMs: 15_000, toMs: 30_000 }]);
    expect(totalRedoCutMs(merged)).toBe(15_000);
  });

  it('converts cuts into the keep ranges the trim engine takes', () => {
    const keep = redoKeepRanges([{ fromMs: 10_000, toMs: 20_000 }], 30);
    expect(keep).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);
  });

  it('answers null when no cut lands inside the finished file', () => {
    expect(redoKeepRanges([], 30)).toBeNull();
    expect(redoKeepRanges([{ fromMs: 40_000, toMs: 50_000 }], 30)).toBeNull();
  });

  it('keeps the full take rather than cutting nearly everything (safe failure)', () => {
    expect(redoKeepRanges([{ fromMs: 0, toMs: 60_000 }], 10)).toBeNull();
  });
});

describe('micSilenceTripped', () => {
  const now = 1_000_000;

  it('warns only after a sustained flat stretch on a live, unmuted take', () => {
    expect(micSilenceTripped('recording', true, now - MIC_SILENCE_MS - 1, now)).toBe(true);
    expect(micSilenceTripped('recording', true, now - MIC_SILENCE_MS + 1000, now)).toBe(false);
  });

  it('stays quiet while paused or muted - both silences are chosen', () => {
    expect(micSilenceTripped('paused', true, now - MIC_SILENCE_MS - 1, now)).toBe(false);
    expect(micSilenceTripped('recording', false, now - MIC_SILENCE_MS - 1, now)).toBe(false);
  });

  it('needs a baseline before it can measure silence', () => {
    expect(micSilenceTripped('recording', true, 0, now)).toBe(false);
  });
});
