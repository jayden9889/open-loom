/**
 * Which camera the launcher opens on.
 *
 * An iPhone parked beside the Mac registers as an Apple Continuity Camera, and
 * macOS often enumerates it FIRST. Taking cams[0] therefore meant the app could
 * quietly open the phone at the start of a client walkthrough, and wake and
 * drain the phone to do it. The phone must stay one click away, never the
 * default. Desk View is ranked last: it points down at the desk, not at a face.
 */
import { describe, it, expect } from 'vitest';
import { pickDefaultCamera, pickDefaultMic, isContinuityCamera, isDeskViewCamera, isVirtualCamera, usableCameras } from '../device-choice';

const cam = (deviceId: string, label: string) => ({ deviceId, label, groupId: `g-${deviceId}`, kind: 'videoinput' as const });

describe('isContinuityCamera', () => {
  it('recognises the labels macOS gives an iPhone or iPad camera', () => {
    for (const label of [
      "Jayden's iPhone Camera",
      "Jayden’s iPhone",
      'iPhone 15 Pro Camera',
      "Studio's iPad Camera",
      'Continuity Camera',
    ]) {
      expect(isContinuityCamera(label), label).toBe(true);
    }
  });

  it('leaves real webcams alone', () => {
    for (const label of ['FaceTime HD Camera', 'FaceTime HD Camera (Built-in)', 'Logitech BRIO', 'OBS Virtual Camera']) {
      expect(isContinuityCamera(label), label).toBe(false);
    }
  });
});

describe('isDeskViewCamera', () => {
  it('spots the downward desk feed an iPhone also publishes', () => {
    expect(isDeskViewCamera("Jayden's iPhone Desk View Camera")).toBe(true);
    expect(isDeskViewCamera('Desk View')).toBe(true);
  });

  it('does not catch the ordinary iPhone feed', () => {
    expect(isDeskViewCamera("Jayden's iPhone Camera")).toBe(false);
  });
});

describe('pickDefaultCamera', () => {
  it('opens the built-in camera even when the iPhone is listed first', () => {
    // The exact ordering macOS produces with a phone nearby, and the whole
    // reason this function exists.
    const cams = [
      cam('phone', "Jayden's iPhone Camera"),
      cam('desk', "Jayden's iPhone Desk View Camera"),
      cam('mac', 'FaceTime HD Camera'),
    ];
    expect(pickDefaultCamera(cams)).toBe('mac');
  });

  it('never defaults to Desk View, which points at the desk', () => {
    expect(pickDefaultCamera([cam('desk', 'Desk View Camera'), cam('mac', 'FaceTime HD Camera (Built-in)')])).toBe('mac');
  });

  it('prefers a plain external webcam over the phone', () => {
    const cams = [cam('phone', "Sam's iPhone Camera"), cam('brio', 'Logitech BRIO')];
    expect(pickDefaultCamera(cams)).toBe('brio');
  });

  it('still returns the phone when it is genuinely the only camera', () => {
    expect(pickDefaultCamera([cam('phone', "Sam's iPhone Camera")])).toBe('phone');
  });

  it('keeps enumeration order when nothing outranks anything', () => {
    expect(pickDefaultCamera([cam('a', 'USB Camera'), cam('b', 'Another USB Camera')])).toBe('a');
  });

  it('survives an empty list and unlabelled devices', () => {
    expect(pickDefaultCamera([])).toBe('');
    // Before the permission prompt is answered every label is blank; the app
    // must still choose something rather than throw.
    expect(pickDefaultCamera([cam('x', ''), cam('y', '')])).toBe('x');
  });

  it('survives a MISSING label, not just an empty one', () => {
    // Caught by running the real app, not by this file: devices enumerated
    // before permission is granted arrive with label undefined, and the first
    // version of cameraRank called .toLowerCase() on it and threw inside the
    // launcher's render. An empty-string fixture does not reproduce that.
    const noLabel = { deviceId: 'z', groupId: 'gz', kind: 'videoinput' as const } as unknown as Parameters<
      typeof pickDefaultCamera
    >[0][number];
    expect(() => pickDefaultCamera([noLabel])).not.toThrow();
    expect(pickDefaultCamera([noLabel])).toBe('z');
    expect(isContinuityCamera(undefined as unknown as string)).toBe(false);
    expect(isDeskViewCamera(undefined as unknown as string)).toBe(false);
  });
});

describe('pickDefaultMic', () => {
  const mic = (deviceId: string, label: string) => ({ deviceId, label, groupId: `g-${deviceId}`, kind: 'audioinput' as const });

  it('does not let an iPhone mic take the default just by enumerating first', () => {
    // A Continuity Camera publishes its microphone too. Recording a client
    // walkthrough through a phone lying face down on the desk is a wasted take.
    const mics = [mic('phonemic', "Jayden's iPhone Microphone"), mic('mac', 'MacBook Pro Microphone')];
    expect(pickDefaultMic(mics)).toBe('mac');
  });

  it('prefers a real external mic over the phone', () => {
    expect(pickDefaultMic([mic('phonemic', "Sam's iPhone Microphone"), mic('yeti', 'Blue Yeti')])).toBe('yeti');
  });

  it('still uses the phone mic when it is the only one', () => {
    expect(pickDefaultMic([mic('phonemic', "Sam's iPhone Microphone")])).toBe('phonemic');
  });

  it('handles an empty list and a missing label without throwing', () => {
    expect(pickDefaultMic([])).toBe('');
    const noLabel = { deviceId: 'q', groupId: 'gq', kind: 'audioinput' as const } as unknown as Parameters<
      typeof pickDefaultMic
    >[0][number];
    expect(() => pickDefaultMic([noLabel])).not.toThrow();
    expect(pickDefaultMic([noLabel])).toBe('q');
  });
});

describe('isVirtualCamera and the OBS case', () => {
  // Taken verbatim from a real Mac. OBS enumerates FIRST, which is how a logo
  // ended up where the user's face should have been.
  const REAL_MAC = [
    cam('obs', 'OBS Virtual Camera'),
    cam('mac', 'FaceTime HD Camera (5B00:3AA6)'),
    cam('phone', 'Jayden  Camera'),
  ];

  it('recognises the common virtual cameras', () => {
    for (const l of ['OBS Virtual Camera', 'Snap Camera', 'mmhmm camera', 'Camo', 'EpocCam', 'Ecamm Live Virtual Cam', 'NDI Video']) {
      expect(isVirtualCamera(l), l).toBe(true);
    }
  });

  it('does not mistake a real camera for a virtual one', () => {
    for (const l of ['FaceTime HD Camera', 'Logitech BRIO', "Sam's iPhone Camera"]) {
      expect(isVirtualCamera(l), l).toBe(false);
    }
  });

  it('never opens OBS by default, even though macOS lists it first', () => {
    expect(pickDefaultCamera(REAL_MAC)).toBe('mac');
  });

  it('prefers a real webcam over a virtual one', () => {
    expect(pickDefaultCamera([cam('obs', 'OBS Virtual Camera'), cam('brio', 'Logitech BRIO')])).toBe('brio');
  });

  it('ranks a virtual camera below even an iPhone', () => {
    expect(pickDefaultCamera([cam('obs', 'OBS Virtual Camera'), cam('phone', "Sam's iPhone Camera")])).toBe('phone');
  });

  it('still returns the virtual camera when it is genuinely the only one', () => {
    expect(pickDefaultCamera([cam('obs', 'OBS Virtual Camera')])).toBe('obs');
  });
});

describe('usableCameras', () => {
  it('removes OBS entirely from the real Mac list', () => {
    const real = [
      cam('obs', 'OBS Virtual Camera'),
      cam('mac', 'FaceTime HD Camera (5B00:3AA6)'),
      cam('phone', 'Jayden  Camera'),
    ];
    const out = usableCameras(real);
    expect(out.map((c) => c.deviceId)).toEqual(['mac', 'phone']);
    // and the default is still the built in one
    expect(pickDefaultCamera(out)).toBe('mac');
  });

  it('keeps a virtual camera only when it is the sole camera, rather than claiming none exists', () => {
    const only = [cam('obs', 'OBS Virtual Camera')];
    expect(usableCameras(only)).toHaveLength(1);
  });

  it('leaves an all-real list untouched and in order', () => {
    const real = [cam('mac', 'FaceTime HD Camera'), cam('brio', 'Logitech BRIO')];
    expect(usableCameras(real).map((c) => c.deviceId)).toEqual(['mac', 'brio']);
  });

  it('handles an empty list', () => {
    expect(usableCameras([])).toEqual([]);
  });
});
