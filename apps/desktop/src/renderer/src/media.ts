/**
 * getUserMedia that survives a stale persisted device id.
 *
 * A saved camera or microphone id can stop matching a real device - a different
 * machine, a re-plugged webcam, or a new browser device-id salt. getUserMedia
 * then throws OverconstrainedError (or NotFoundError) and the camera never
 * opens. On exactly that failure we drop the pinned deviceId and retry with the
 * system default devices, so the face camera always comes up.
 *
 * That retry is not free: it hands the choice of device to the operating system.
 * Callers can pass `onDeviceFallback` to find out that it happened and which
 * device actually opened, so the interface can say so instead of quietly
 * recording through whatever the system felt like picking.
 */

import { pickDefaultCamera, usableCameras } from './device-choice';

/** Strip a pinned deviceId from a track constraint, leaving everything else. */
export function withoutDeviceId(
  c: boolean | MediaTrackConstraints | undefined
): boolean | MediaTrackConstraints | undefined {
  if (!c || typeof c === 'boolean') return c;
  const { deviceId: _drop, ...rest } = c;
  return rest;
}

/** True for the errors that mean "the pinned device is gone", not "denied". */
function isStaleDeviceError(err: unknown): boolean {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  return name === 'OverconstrainedError' || name === 'NotFoundError';
}

/**
 * What the fallback actually did, so the caller can say it out loud.
 *
 * Dropping the pinned deviceId hands the choice to the operating system, and on
 * macOS with Continuity Camera that regularly means an iPhone opens instead of
 * the webcam the user picked. Recording silently through the wrong camera is
 * worse than a slow start, so the swap has to be reportable.
 */
export interface DeviceFallbackInfo {
  /** Which track lost its pinned device. */
  kind: 'video' | 'audio';
  /** The device id that was asked for and no longer resolves. */
  requestedDeviceId: string;
  /** The device id the system opened instead, when the track reports one. */
  actualDeviceId?: string;
  /** Readable name of the device that opened, when permission exposes labels. */
  actualLabel?: string;
}

export interface ResilientMediaOptions {
  /**
   * Called once per track that lost its pinned device, after the retry has
   * succeeded. Optional on purpose: adding a required argument would break the
   * existing call sites in the launcher, the engine and the settings preview,
   * and every one of them still wants the retry whether or not it reports it.
   */
  onDeviceFallback?: (info: DeviceFallbackInfo) => void;
}

/** Read the pinned device id out of a track constraint, if one is pinned. */
function pinnedDeviceId(c: boolean | MediaTrackConstraints | undefined): string | undefined {
  if (!c || typeof c === 'boolean') return undefined;
  const d = c.deviceId;
  if (typeof d === 'string') return d || undefined;
  if (Array.isArray(d)) return d[0];
  if (d && typeof d === 'object') {
    const v = d.exact ?? d.ideal;
    if (typeof v === 'string') return v || undefined;
    if (Array.isArray(v)) return v[0];
  }
  return undefined;
}

/** Describe the track the system actually opened for a kind. */
function describeOpenedTrack(
  stream: MediaStream,
  kind: 'video' | 'audio',
  requestedDeviceId: string
): DeviceFallbackInfo {
  // Guarded rather than called straight, because a test double and a stream
  // whose track has already ended both fail to answer these, and a crash here
  // would throw away a camera that is already open and working.
  const tracks = kind === 'video' ? stream.getVideoTracks?.() : stream.getAudioTracks?.();
  const track = tracks && tracks.length > 0 ? tracks[0] : undefined;
  const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : undefined;
  return {
    kind,
    requestedDeviceId,
    actualDeviceId: settings?.deviceId,
    actualLabel: track?.label || undefined,
  };
}

/** Pin a concrete camera id onto a video constraint, replacing a bare `true`. */
function withPinnedVideo(
  c: boolean | MediaTrackConstraints | undefined,
  deviceId: string
): MediaTrackConstraints {
  const base = c && typeof c === 'object' ? c : {};
  return { ...base, deviceId: { exact: deviceId } };
}

/**
 * The camera to open when nothing is pinned. Chromium's own unpinned choice is
 * the FIRST device in the enumeration list, and OBS Virtual Camera registers
 * itself first on any Mac that has OBS installed - which put the OBS logo
 * where the face should be in every window that opened a camera without a
 * saved id. Rank the real cameras instead, with the same rules the launcher's
 * picker uses.
 *
 * Labels can be blank before this renderer has opened any device, and a
 * virtual camera cannot be recognised without its label. In that case a
 * throwaway probe stream is opened and closed purely to unlock the labels; it
 * is never attached to any element, so nothing from it is ever shown.
 */
async function defaultRealCameraId(): Promise<string | undefined> {
  const md = navigator.mediaDevices;
  if (typeof md?.enumerateDevices !== 'function') return undefined;
  try {
    let cams = (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    if (cams.length === 0) return undefined;
    if (cams.every((c) => !c.label)) {
      try {
        const probe = await md.getUserMedia({ video: true });
        for (const t of probe.getTracks()) t.stop();
        cams = (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      } catch {
        /* permission not granted yet - rank the unlabelled list as it is */
      }
    }
    return pickDefaultCamera(usableCameras(cams)) || undefined;
  } catch {
    return undefined;
  }
}

/** Is this camera id still present in the live device list? */
async function cameraStillExists(deviceId: string): Promise<boolean> {
  const md = navigator.mediaDevices;
  if (typeof md?.enumerateDevices !== 'function') return false;
  try {
    const devices = await md.enumerateDevices();
    return devices.some((d) => d.kind === 'videoinput' && d.deviceId === deviceId);
  } catch {
    return false;
  }
}

export async function getUserMediaResilient(
  constraints: MediaStreamConstraints,
  opts: ResilientMediaOptions = {}
): Promise<MediaStream> {
  // Never hand Chromium a free choice of camera. An unpinned video request
  // opens the first enumerated device - OBS on a Mac that has it - so an empty
  // saved camera id (fresh install, hotkey recording, settings preview) used
  // to open the OBS logo card in every window that shows a face.
  let video = constraints.video;
  if (video && !pinnedDeviceId(video)) {
    const id = await defaultRealCameraId();
    if (id) video = withPinnedVideo(video, id);
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ ...constraints, video });
  } catch (err) {
    // Only a missing pinned device is recoverable here. A real denial
    // (NotAllowedError) or hardware fault must still surface to the caller.
    if (!isStaleDeviceError(err)) throw err;
    // The retry drops the stale pin, but never all the way back to "let the
    // system pick" - that is the OBS-first slot again. A camera pin that is
    // still valid survives (the stale id may have been the mic's), a dead one
    // is replaced by the ranked default real camera when one can be found.
    const retryVideo = await (async () => {
      if (!constraints.video) return undefined;
      const vidPin = pinnedDeviceId(constraints.video);
      if (vidPin && (await cameraStillExists(vidPin))) return constraints.video;
      const fallbackId = await defaultRealCameraId();
      const stripped = withoutDeviceId(constraints.video);
      return fallbackId ? withPinnedVideo(stripped, fallbackId) : stripped;
    })();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: retryVideo,
        audio: withoutDeviceId(constraints.audio),
      });
    } catch (err2) {
      // The re-pinned default can itself vanish between enumeration and open
      // (a camera unplugged mid-fallback). Last resort: fully unpinned.
      if (!isStaleDeviceError(err2)) throw err2;
      stream = await navigator.mediaDevices.getUserMedia({
        video: withoutDeviceId(constraints.video),
        audio: withoutDeviceId(constraints.audio),
      });
    }
    // Report only the kinds that genuinely had a device pinned. Where nothing
    // was pinned, stripping the id changed nothing and there is no swap to tell
    // anyone about, so a notice would be noise that trains people to ignore it.
    const notify = opts.onDeviceFallback;
    if (notify) {
      const wanted: ['video' | 'audio', string | undefined][] = [
        ['video', pinnedDeviceId(constraints.video)],
        ['audio', pinnedDeviceId(constraints.audio)],
      ];
      for (const [kind, requested] of wanted) {
        if (!requested) continue;
        try {
          notify(describeOpenedTrack(stream, kind, requested));
        } catch {
          // A failing notification must never turn a recovered camera into a
          // failed one. The stream is open, which is the part that matters.
        }
      }
    }
    return stream;
  }
}

// ---------------------------------------------------------------------------
// Frame health: macOS capture can come up delivering solid green (YUV zero)
// frames after a release/re-acquire race or when another process fights over
// the device. loadeddata still fires and videoWidth is set, so readiness
// events cannot catch it - only looking at actual pixels can.
// ---------------------------------------------------------------------------

/**
 * True when the frame currently on `video` looks like real camera content.
 * A broken capture paints a uniform buffer (solid green/black); any real
 * scene - even a dark room - has sensor noise and gradients. Samples a tiny
 * downscale and checks per-channel spread.
 */
export function frameLooksReal(video: HTMLVideoElement): boolean {
  if (video.videoWidth === 0) return false;
  const w = 32;
  const h = 18;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return true; // cannot judge - do not block
  try {
    ctx.drawImage(video, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const min = [255, 255, 255];
    const max = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = data[i + c]!;
        if (v < min[c]!) min[c] = v;
        if (v > max[c]!) max[c] = v;
      }
    }
    const spread = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
    return spread > 6;
  } catch {
    return true; // tainted/unsupported - do not block
  }
}

export interface HealthyCameraSession {
  stream: MediaStream;
  stop(): void;
}

/**
 * Open the camera, attach it to `video`, and only resolve once frames are
 * provably real. A uniform (green/black) feed is torn down and re-acquired,
 * up to `retries` times, with a settle delay so macOS finishes releasing the
 * device between attempts. Throws when every attempt stays broken.
 */
export async function attachHealthyCameraStream(
  video: HTMLVideoElement,
  videoConstraints: MediaTrackConstraints,
  opts: {
    retries?: number;
    settleMs?: number;
    isCancelled?: () => boolean;
    /** Also capture audio in the same stream (engine cam-mode). */
    audio?: boolean | MediaTrackConstraints;
    /**
     * Told when a pinned device was dropped and the system chose instead. Fires
     * at most once per track kind for the whole call: the constraints keep the
     * stale id, so every re-acquire attempt falls back again, and repeating the
     * same notice up to three times would read as three separate problems.
     */
    onDeviceFallback?: (info: DeviceFallbackInfo) => void;
  } = {}
): Promise<HealthyCameraSession> {
  const retries = opts.retries ?? 2;
  const settleMs = opts.settleMs ?? 300;
  const cancelled = opts.isCancelled ?? (() => false);
  const fallbacksReported = new Set<string>();
  const onDeviceFallback = (info: DeviceFallbackInfo) => {
    if (fallbacksReported.has(info.kind)) return;
    fallbacksReported.add(info.kind);
    opts.onDeviceFallback?.(info);
  };

  let lastErr: unknown = new Error('Camera produced no live frames.');
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (cancelled()) throw new Error('cancelled');
    let stream: MediaStream | null = null;
    try {
      stream = await getUserMediaResilient(
        { video: videoConstraints, audio: opts.audio ?? false },
        { onDeviceFallback }
      );
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      // Wait for decodable frames.
      if (video.readyState < 2) {
        await new Promise<void>((res) => {
          const done = () => res();
          video.addEventListener('loadeddata', done, { once: true });
          setTimeout(done, 4000);
        });
      }
      // Judge pixels twice across a short window: a feed that is still
      // warming up gets a second chance before being called broken.
      let healthy = frameLooksReal(video);
      if (!healthy) {
        await new Promise((r) => setTimeout(r, 450));
        healthy = frameLooksReal(video);
      }
      if (cancelled()) {
        for (const t of stream.getTracks()) t.stop();
        throw new Error('cancelled');
      }
      if (healthy) {
        const s = stream;
        return {
          stream: s,
          stop: () => {
            for (const t of s.getTracks()) t.stop();
          },
        };
      }
      console.warn(`[camera] uniform frames on attempt ${attempt + 1} - re-acquiring`);
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
      lastErr = new Error('Camera produced only blank frames.');
      await new Promise((r) => setTimeout(r, settleMs));
    } catch (err) {
      if (stream) for (const t of stream.getTracks()) t.stop();
      if (err instanceof Error && err.message === 'cancelled') throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, settleMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
