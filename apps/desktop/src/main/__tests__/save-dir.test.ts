/**
 * Save-folder validation tests: an unplugged external drive must surface as
 * one plain sentence, never a raw errno - and a healthy-but-not-yet-created
 * folder must not read as broken.
 */
import { describe, expect, it } from 'vitest';
import { describeSaveDirProblem, saveDirVolumeRoot } from '../settings-core';

describe('saveDirVolumeRoot', () => {
  it('finds the mount point of an external-drive path', () => {
    expect(saveDirVolumeRoot('/Volumes/MySSD/OpenLoom')).toBe('/Volumes/MySSD');
    expect(saveDirVolumeRoot('/Volumes/My Drive/deep/nested')).toBe('/Volumes/My Drive');
  });

  it('boot-disk and non-mac paths have no volume root', () => {
    expect(saveDirVolumeRoot('/Users/sam/Movies/OpenLoom')).toBeNull();
    expect(saveDirVolumeRoot('C:\\Users\\sam\\Videos')).toBeNull();
    expect(saveDirVolumeRoot('/Volumes')).toBeNull();
  });
});

describe('describeSaveDirProblem', () => {
  const dir = '/Volumes/MySSD/OpenLoom';

  it('an unmounted drive names the drive problem, not an errno', () => {
    const msg = describeSaveDirProblem(dir, { exists: false, writable: false, volumeMounted: false });
    expect(msg).toContain('drive that is not connected');
    expect(msg).toContain(dir);
  });

  it('the drive message wins even when other checks also failed', () => {
    const msg = describeSaveDirProblem(dir, { exists: true, writable: false, volumeMounted: false });
    expect(msg).toContain('drive that is not connected');
  });

  it('a missing folder that can be created on demand is fine', () => {
    expect(describeSaveDirProblem(dir, { exists: false, writable: true, volumeMounted: true })).toBeNull();
    expect(
      describeSaveDirProblem('/Users/sam/Movies/OpenLoom', { exists: false, writable: true, volumeMounted: null })
    ).toBeNull();
  });

  it('a missing folder that cannot be created is a problem', () => {
    const msg = describeSaveDirProblem(dir, { exists: false, writable: false, volumeMounted: true });
    expect(msg).toContain('cannot be created');
  });

  it('an unwritable existing folder points at permissions', () => {
    const msg = describeSaveDirProblem(dir, { exists: true, writable: false, volumeMounted: true });
    expect(msg).toContain('cannot write');
  });

  it('a healthy folder reports no problem', () => {
    expect(describeSaveDirProblem(dir, { exists: true, writable: true, volumeMounted: true })).toBeNull();
  });
});
