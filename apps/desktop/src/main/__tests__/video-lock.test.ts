/**
 * The video lock is the only thing standing between an edit and an upload of
 * the same recording, and both sides are real callers now: the ffmpeg job pump
 * takes it for trims, the share layer takes it for uploads. These tests pin the
 * two properties the protection actually rests on. A refusal has to name what
 * is busy and what has to wait, because the sentence it throws is shown to the
 * person word for word; and a release has to be exact, because a hold that is
 * never given back leaves a recording that can be neither edited nor shared for
 * the rest of the session, while a release that fires too eagerly hands
 * video.mp4 to an editor while an upload is still reading it.
 */
import { describe, expect, it } from 'vitest';
import { releaseVideoLock, takeVideoLock, videoLockHolder } from '../video-lock';

describe('takeVideoLock', () => {
  it('holds the video until it is released', () => {
    expect(videoLockHolder('vid-hold')).toBeNull();
    takeVideoLock('vid-hold', 'upload');
    expect(videoLockHolder('vid-hold')).toBe('upload');
    releaseVideoLock('vid-hold', 'upload');
    expect(videoLockHolder('vid-hold')).toBeNull();
  });

  it('refuses a second kind while one kind holds the video', () => {
    // The exact race this module exists for: a trim asking to rewrite video.mp4
    // while the share upload is still streaming that same file.
    takeVideoLock('vid-busy', 'upload');
    expect(() => takeVideoLock('vid-busy', 'edit')).toThrow();
    // The refusal must not disturb the hold that caused it.
    expect(videoLockHolder('vid-busy')).toBe('upload');
    releaseVideoLock('vid-busy', 'upload');
  });

  it('the refusal names what is busy and what has to wait', () => {
    takeVideoLock('vid-uploading', 'upload');
    expect(() => takeVideoLock('vid-uploading', 'edit')).toThrow(/uploading[\s\S]*before editing/i);
    releaseVideoLock('vid-uploading', 'upload');

    takeVideoLock('vid-editing', 'edit');
    expect(() => takeVideoLock('vid-editing', 'upload')).toThrow(/being edited[\s\S]*before uploading/i);
    releaseVideoLock('vid-editing', 'edit');
  });

  it('a pairing with no special wording still names both sides', () => {
    // Without this the fallback could quietly degrade to a bare "video is busy",
    // which tells the person nothing about what to wait for.
    takeVideoLock('vid-recording', 'record');
    expect(() => takeVideoLock('vid-recording', 'edit')).toThrow(/still being processed[\s\S]*before editing/i);
    releaseVideoLock('vid-recording', 'record');
  });

  it('the same kind stacks and needs one release per hold', () => {
    // The share layer really does overlap holds of one kind: the video upload
    // and a thumbnail push can be in flight together, and whichever finishes
    // first must not hand the folder over to a waiting edit.
    takeVideoLock('vid-nested', 'upload');
    takeVideoLock('vid-nested', 'upload');
    releaseVideoLock('vid-nested', 'upload');
    expect(videoLockHolder('vid-nested')).toBe('upload');
    releaseVideoLock('vid-nested', 'upload');
    expect(videoLockHolder('vid-nested')).toBeNull();
  });

  it('one busy video does not block a different one', () => {
    // Uploads and edits run against separate recordings all the time, so a lock
    // that was global rather than per video would stall ordinary work.
    takeVideoLock('vid-one', 'upload');
    expect(() => takeVideoLock('vid-two', 'edit')).not.toThrow();
    expect(videoLockHolder('vid-one')).toBe('upload');
    expect(videoLockHolder('vid-two')).toBe('edit');
    releaseVideoLock('vid-one', 'upload');
    releaseVideoLock('vid-two', 'edit');
  });
});

describe('releaseVideoLock', () => {
  it('releasing a lock nobody holds is a no-op, not a crash', () => {
    // Callers release in a finally that also runs on paths where the lock was
    // never taken, so an unheld release has to be harmless.
    expect(() => releaseVideoLock('vid-free', 'upload')).not.toThrow();
    expect(videoLockHolder('vid-free')).toBeNull();
  });

  it('a release from the wrong kind cannot take the hold away', () => {
    // The upload paths release in a finally that runs even when the lock was
    // refused, so a release must ignore a kind that was never granted rather
    // than freeing the edit that is mid rewrite.
    takeVideoLock('vid-guarded', 'edit');
    releaseVideoLock('vid-guarded', 'upload');
    expect(videoLockHolder('vid-guarded')).toBe('edit');
    releaseVideoLock('vid-guarded', 'edit');
    expect(videoLockHolder('vid-guarded')).toBeNull();
  });
});
