/**
 * getUserMedia that survives a stale persisted device id.
 *
 * A saved camera or microphone id can stop matching a real device - a different
 * machine, a re-plugged webcam, or a new browser device-id salt. getUserMedia
 * then throws OverconstrainedError (or NotFoundError) and the camera never
 * opens. On exactly that failure we drop the pinned deviceId and retry with the
 * system default devices, so the face camera always comes up.
 */

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

export async function getUserMediaResilient(constraints: MediaStreamConstraints): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // Only a missing pinned device is recoverable here. A real denial
    // (NotAllowedError) or hardware fault must still surface to the caller.
    if (!isStaleDeviceError(err)) throw err;
    return navigator.mediaDevices.getUserMedia({
      video: withoutDeviceId(constraints.video),
      audio: withoutDeviceId(constraints.audio),
    });
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
  } = {}
): Promise<HealthyCameraSession> {
  const retries = opts.retries ?? 2;
  const settleMs = opts.settleMs ?? 300;
  const cancelled = opts.isCancelled ?? (() => false);

  let lastErr: unknown = new Error('Camera produced no live frames.');
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (cancelled()) throw new Error('cancelled');
    let stream: MediaStream | null = null;
    try {
      stream = await getUserMediaResilient({ video: videoConstraints, audio: opts.audio ?? false });
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
