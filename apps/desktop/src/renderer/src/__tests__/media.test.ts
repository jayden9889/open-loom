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

describe('getUserMediaResilient on an OBS-first Mac', () => {
  // OBS Virtual Camera enumerates FIRST on a Mac that has it installed, so
  // any unpinned video request used to open the OBS logo card. Every open
  // must resolve to a ranked real camera instead.
  const gum = vi.fn();
  const enumerate = vi.fn();
  const dev = (deviceId: string, label: string) => ({
    deviceId,
    label,
    groupId: `g-${deviceId}`,
    kind: 'videoinput' as const,
  });
  beforeEach(() => {
    gum.mockReset();
    enumerate.mockReset();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: gum, enumerateDevices: enumerate },
    });
  });

  it('pins the ranked real camera when nothing is pinned, never Chromium\'s first pick', async () => {
    enumerate.mockResolvedValue([dev('obs', 'OBS Virtual Camera'), dev('mac', 'FaceTime HD Camera')]);
    const stream = {} as MediaStream;
    gum.mockResolvedValueOnce(stream);
    await expect(getUserMediaResilient({ video: { width: { ideal: 1280 } } })).resolves.toBe(stream);
    expect(gum).toHaveBeenCalledTimes(1);
    expect(gum).toHaveBeenCalledWith({
      video: { width: { ideal: 1280 }, deviceId: { exact: 'mac' } },
    });
  });

  it('opens a throwaway probe to unlock blank labels before choosing', async () => {
    // Before this renderer has opened any device the labels are blank, and a
    // virtual camera cannot be recognised without its label.
    const probe = { getTracks: () => [] } as unknown as MediaStream;
    const real = {} as MediaStream;
    enumerate
      .mockResolvedValueOnce([dev('obs', ''), dev('mac', '')])
      .mockResolvedValueOnce([dev('obs', 'OBS Virtual Camera'), dev('mac', 'FaceTime HD Camera')]);
    gum.mockResolvedValueOnce(probe).mockResolvedValueOnce(real);
    await expect(getUserMediaResilient({ video: true })).resolves.toBe(real);
    expect(gum).toHaveBeenNthCalledWith(1, { video: true });
    expect(gum).toHaveBeenNthCalledWith(2, { video: { deviceId: { exact: 'mac' } } });
  });

  it('replaces a stale camera pin with the ranked default, not the system pick', async () => {
    enumerate.mockResolvedValue([dev('obs', 'OBS Virtual Camera'), dev('mac', 'FaceTime HD Camera')]);
    const stream = {} as MediaStream;
    gum
      .mockRejectedValueOnce(new DOMException('gone', 'OverconstrainedError'))
      .mockResolvedValueOnce(stream);
    await expect(
      getUserMediaResilient({ video: { deviceId: { exact: 'unplugged' }, width: { ideal: 1280 } } })
    ).resolves.toBe(stream);
    expect(gum).toHaveBeenNthCalledWith(2, {
      video: { width: { ideal: 1280 }, deviceId: { exact: 'mac' } },
      audio: undefined,
    });
  });

  it('keeps a still-valid camera pin when only the mic went stale', async () => {
    enumerate.mockResolvedValue([dev('obs', 'OBS Virtual Camera'), dev('brio', 'Logitech BRIO')]);
    const stream = {} as MediaStream;
    gum
      .mockRejectedValueOnce(new DOMException('gone', 'OverconstrainedError'))
      .mockResolvedValueOnce(stream);
    await getUserMediaResilient({
      video: { deviceId: { exact: 'brio' } },
      audio: { deviceId: { exact: 'gone-mic' } },
    });
    expect(gum).toHaveBeenNthCalledWith(2, {
      video: { deviceId: { exact: 'brio' } },
      audio: {},
    });
  });
});
