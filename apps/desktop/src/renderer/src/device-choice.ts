/**
 * Which camera and microphone to open when nobody has chosen one.
 *
 * These rules used to live inside the launcher, which left every other camera
 * consumer (the bubble, the recording engine, the settings preview, and the
 * fallback path in media.ts) taking Chromium's unpinned default - the FIRST
 * device in the enumeration list. On a Mac with OBS installed that first
 * device is OBS Virtual Camera, which renders the OBS logo on a blue card
 * whenever OBS itself is not running. Shared here so one ranking governs
 * every window that opens a camera.
 */
import type { MediaDeviceInfoLite } from '@shared/types';

/**
 * Is this an iPhone or iPad acting as the camera (Apple Continuity Camera)?
 * Used to label the option and to keep it OUT of the default slot.
 */
export function isContinuityCamera(label: string | undefined): boolean {
  // A device enumerated before the permission prompt is answered can carry no
  // label at all, and it arrives as undefined rather than an empty string.
  const l = (label ?? '').toLowerCase();
  return l.includes('iphone') || l.includes('ipad') || l.includes('continuity');
}

/** Desk View is the downward wide-angle feed. Never a face cam. */
export function isDeskViewCamera(label: string | undefined): boolean {
  return (label ?? '').toLowerCase().includes('desk view');
}

/**
 * A software camera that other apps publish: OBS, Snap, mmhmm, Camo and the
 * like. These are never a face by default. OBS in particular enumerates FIRST
 * on a Mac that has it installed and shows the OBS logo on a blue card when OBS
 * itself is not running, so taking the first camera in the list put a logo
 * where the user's face should be. That is what this rank exists to stop.
 */
export function isVirtualCamera(label: string | undefined): boolean {
  const l = (label ?? '').toLowerCase();
  return (
    l.includes('obs') ||
    l.includes('virtual') ||
    l.includes('snap camera') ||
    l.includes('mmhmm') ||
    l.includes('camo') ||
    l.includes('ecamm') ||
    l.includes('epoccam') ||
    l.includes('ndi')
  );
}

/**
 * Drop the software cameras other apps publish.
 *
 * Open Loom already records the screen, so routing a face through OBS or a
 * similar virtual camera is never the intent here: OBS is a separate tool for a
 * separate job. Left in the list it was actively harmful, because it enumerates
 * FIRST on a Mac that has it installed and renders the OBS logo on a blue card
 * whenever OBS itself is not running, so the app opened with a logo where the
 * user's face should be.
 *
 * The one exception is a machine where a virtual camera is the ONLY camera.
 * Filtering there would report "no camera found" while a camera plainly exists,
 * which is a worse lie than offering it, so in that single case it is kept.
 */
export function usableCameras(cams: MediaDeviceInfoLite[]): MediaDeviceInfoLite[] {
  const real = cams.filter((c) => !isVirtualCamera(c.label));
  return real.length > 0 ? real : cams;
}

/**
 * Lower sorts earlier: built-in, then any real webcam, then an iPhone or iPad,
 * then Desk View, and a virtual camera dead last for the rare case where one
 * survives the filter above by being the only camera present.
 */
function cameraRank(label: string | undefined): number {
  if (isVirtualCamera(label)) return 4;
  if (isDeskViewCamera(label)) return 3;
  if (isContinuityCamera(label)) return 2;
  const l = (label ?? '').toLowerCase();
  if (l.includes('built-in') || l.includes('facetime')) return 0;
  return 1;
}

/**
 * Which camera to open when there is no saved choice.
 *
 * An iPhone sitting next to the Mac registers as a Continuity Camera and macOS
 * frequently enumerates it FIRST, so taking cams[0] meant the app could quietly
 * open the phone instead of the built-in camera: a surprise on the first frame
 * of a client walkthrough, and it wakes and drains the phone. The phone stays
 * one click away in the picker, it just never becomes the default on its own.
 * Ties keep enumeration order, so a single built-in camera is unaffected.
 */
export function pickDefaultCamera(cams: MediaDeviceInfoLite[]): string {
  if (cams.length === 0) return '';
  let best = cams[0]!;
  for (const c of cams) {
    if (cameraRank(c.label) < cameraRank(best.label)) best = c;
  }
  return best.deviceId;
}

/**
 * Same rule as the camera, for the microphone. An iPhone acting as a
 * Continuity Camera also publishes its microphone, and it can enumerate
 * first. Recording a client walkthrough through a phone mic lying face down
 * on the desk, without having chosen it, is a wasted take. Built-in wins by
 * default; the phone mic stays selectable.
 */
export function pickDefaultMic(mics: MediaDeviceInfoLite[]): string {
  if (mics.length === 0) return '';
  let best = mics[0]!;
  const rank = (label: string | undefined): number => {
    const l = (label ?? '').toLowerCase();
    if (l.includes('iphone') || l.includes('ipad') || l.includes('continuity')) return 2;
    if (l.includes('built-in') || l.includes('macbook')) return 0;
    return 1;
  };
  for (const m of mics) {
    if (rank(m.label) < rank(best.label)) best = m;
  }
  return best.deviceId;
}
