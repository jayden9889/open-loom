import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withoutDeviceId, getUserMediaResilient } from '../media';

describe('withoutDeviceId', () => {
  it('passes booleans and undefined through unchanged', () => {
    expect(withoutDeviceId(true)).toBe(true);
    expect(withoutDeviceId(false)).toBe(false);
    expect(withoutDeviceId(undefined)).toBe(undefined);
  });

  it('strips a pinned deviceId but keeps every other constraint', () => {
    expect(withoutDeviceId({ deviceId: { exact: 'cam-1' }, width: { ideal: 1280 }, frameRate: { ideal: 30 } })).toEqual({
      width: { ideal: 1280 },
      frameRate: { ideal: 30 },
    });
  });
});

describe('getUserMediaResilient', () => {
  const gum = vi.fn();
  beforeEach(() => {
    gum.mockReset();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: gum } });
  });

  it('returns the stream on the first try when the pinned device works', async () => {
    const stream = {} as MediaStream;
    gum.mockResolvedValueOnce(stream);
    await expect(getUserMediaResilient({ video: { deviceId: { exact: 'cam-1' } } })).resolves.toBe(stream);
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it('retries with the deviceId dropped on OverconstrainedError (a stale device)', async () => {
    const stream = {} as MediaStream;
    gum.mockRejectedValueOnce(new DOMException('gone', 'OverconstrainedError')).mockResolvedValueOnce(stream);
    const res = await getUserMediaResilient({
      video: { deviceId: { exact: 'stale-cam' }, width: { ideal: 1280 } },
      audio: { deviceId: { exact: 'stale-mic' }, echoCancellation: true },
    });
    expect(res).toBe(stream);
    expect(gum).toHaveBeenCalledTimes(2);
    expect(gum).toHaveBeenNthCalledWith(2, {
      video: { width: { ideal: 1280 } },
      audio: { echoCancellation: true },
    });
  });

  it('also retries on NotFoundError', async () => {
    const stream = {} as MediaStream;
    gum.mockRejectedValueOnce(new DOMException('', 'NotFoundError')).mockResolvedValueOnce(stream);
    await expect(getUserMediaResilient({ video: { deviceId: { exact: 'x' } } })).resolves.toBe(stream);
    expect(gum).toHaveBeenCalledTimes(2);
  });

  it('rethrows a permission denial (NotAllowedError) without retrying', async () => {
    gum.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await expect(getUserMediaResilient({ video: true })).rejects.toThrow();
    expect(gum).toHaveBeenCalledTimes(1);
  });
});
