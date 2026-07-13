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
